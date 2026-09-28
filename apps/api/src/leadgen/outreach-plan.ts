import {
	type OpenStopHolds,
	type PythonSendState,
	STOP_SCAN_MAX_AGE_HOURS,
} from "./python-state";

/**
 * Phase 4 SHADOW planner: a faithful port of send_daily_batch.py's eligibility, ordering and cap.
 * Pure functions. It cannot send: it returns which rows WOULD go out. See outreach-compare.ts for
 * how that is checked against what Python actually sent.
 */

export const FU1_DELAY_DAYS = 7;
export const FU2_DELAY_DAYS = 28;
export const DEFAULT_CAP = 10;
const DAY_MS = 86_400_000;

export type Tier = "initial" | "fu1" | "fu2";
export type PlannedSend = { id: number; tier: Tier };
export type NocoRow = Record<string, unknown>;

/** Python truthiness for a NocoDB field value. */
export function pyTruthy(v: unknown): boolean {
	if (v === null || v === undefined || v === false || v === 0 || v === "")
		return false;
	if (Array.isArray(v)) return v.length > 0;
	return true;
}

const s = (v: unknown) => (typeof v === "string" ? v : "");
const key = (v: unknown) => s(v).trim().toLowerCase();
const PLACEHOLDER = "{{";

/** Everything about a row that does not depend on the clock, so the clock can be varied later. */
export type Candidate = {
	id: number;
	business: string;
	email: string;
	/** Sent At, when set and parseable (tiers 2 and 3 need it) */
	sentAt: string | null;
	initialOk: boolean;
	fu1Ok: boolean;
	fu2Ok: boolean;
};

export type Hold = {
	kind: "STOP_SCAN_STALE" | "REPLIED_STATE_MISSING";
	detail: string;
};

/** The two fail-closed interlocks. null means Python would proceed. */
export function checkInterlocks(
	state: Pick<PythonSendState, "stopAgeHours" | "replied">,
): Hold | null {
	const age = state.stopAgeHours;
	if (age === null || age > STOP_SCAN_MAX_AGE_HOURS) {
		return {
			kind: "STOP_SCAN_STALE",
			detail:
				age === null
					? "the STOP scan has never completed"
					: `the STOP scan last completed ${age.toFixed(1)}h ago (limit ${STOP_SCAN_MAX_AGE_HOURS}h)`,
		};
	}
	if (!state.replied.ok) {
		return {
			kind: "REPLIED_STATE_MISSING",
			detail: "replied_leads.json is missing or unreadable",
		};
	}
	return null;
}

function parseSent(v: unknown): Date | null {
	if (!pyTruthy(v) || typeof v !== "string") return null;
	const d = new Date(v.replace(" ", "T"));
	return Number.isNaN(d.getTime()) ? null : d;
}

const draftOk = (subject: unknown, body: unknown) =>
	pyTruthy(subject) &&
	pyTruthy(body) &&
	!(s(subject) + s(body)).includes(PLACEHOLDER);

function heldByOpenStop(email: string, open: OpenStopHolds): boolean {
	if (!email) return false;
	return (
		open.addrs.has(email) ||
		open.domains.has(email.slice(email.lastIndexOf("@") + 1))
	);
}

/**
 * Applies the three suppression paths, then records each row's clock-independent eligibility.
 * `alreadyMailed` is computed over ALL rows before any hold is applied, as Python does.
 */
export function buildCandidates(
	rows: readonly NocoRow[],
	state: Pick<PythonSendState, "replied" | "openStops">,
): Candidate[] {
	const alreadyMailed = new Set<string>();
	for (const r of rows) {
		if (pyTruthy(r["Sent At"]) && pyTruthy(r.Email))
			alreadyMailed.add(key(r.Email));
	}
	alreadyMailed.delete("");

	const out: Candidate[] = [];
	for (const r of rows) {
		const id = Number(r.Id);
		const email = key(r.Email);
		if (heldByOpenStop(email, state.openStops)) continue;
		if (state.replied.ids.has(id) || (email && state.replied.addrs.has(email)))
			continue;

		const dnc = pyTruthy(r["Do Not Contact"]);
		const hasEmail = pyTruthy(r.Email);
		const sent = parseSent(r["Sent At"]);

		const initialOk =
			!alreadyMailed.has(email) &&
			pyTruthy(r["Send Approved"]) &&
			r["Approval Decision"] === "Approved" &&
			hasEmail &&
			!pyTruthy(r["Sent At"]) &&
			!dnc &&
			draftOk(r["Draft Email Subject"], r["Draft Email Body"]);
		const fu1Ok =
			!dnc &&
			hasEmail &&
			sent !== null &&
			!pyTruthy(r["Follow Up 1 Sent At"]) &&
			draftOk(r["Follow Up 1 Subject"], r["Follow Up 1 Body"]);
		const fu2Ok =
			!dnc &&
			hasEmail &&
			sent !== null &&
			!pyTruthy(r["Follow Up 2 Sent At"]) &&
			draftOk(r["Follow Up 2 Subject"], r["Follow Up 2 Body"]);

		if (!initialOk && !fu1Ok && !fu2Ok) continue;
		out.push({
			id,
			business: s(r["Business Name"]),
			email,
			sentAt: sent ? sent.toISOString() : null,
			initialOk,
			fu1Ok,
			fu2Ok,
		});
	}
	return out;
}

/** timedelta.days: whole days, rounded toward negative infinity. */
const ageDays = (asOf: Date, sentAt: string) =>
	Math.floor((asOf.getTime() - new Date(sentAt).getTime()) / DAY_MS);

export type Pools = { initial: number[]; fu1: number[]; fu2: number[] };

export function poolsAt(cands: readonly Candidate[], asOf: Date): Pools {
	const byId = (a: number, b: number) => a - b;
	return {
		initial: cands
			.filter((c) => c.initialOk)
			.map((c) => c.id)
			.sort(byId),
		fu1: cands
			.filter(
				(c) => c.fu1Ok && c.sentAt && ageDays(asOf, c.sentAt) >= FU1_DELAY_DAYS,
			)
			.map((c) => c.id)
			.sort(byId),
		fu2: cands
			.filter(
				(c) => c.fu2Ok && c.sentAt && ageDays(asOf, c.sentAt) >= FU2_DELAY_DAYS,
			)
			.map((c) => c.id)
			.sort(byId),
	};
}

/** Initial emails first, then follow-up 1, then follow-up 2, each by Id; the cap is shared. */
export function planBatch(
	cands: readonly Candidate[],
	asOf: Date,
	cap: number = DEFAULT_CAP,
): PlannedSend[] {
	const p = poolsAt(cands, asOf);
	return [
		...p.initial.map((id): PlannedSend => ({ id, tier: "initial" })),
		...p.fu1.map((id): PlannedSend => ({ id, tier: "fu1" })),
		...p.fu2.map((id): PlannedSend => ({ id, tier: "fu2" })),
	].slice(0, cap);
}
