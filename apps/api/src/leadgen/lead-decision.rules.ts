import { MIRROR_TABLES } from "./mirror-map";
import { buildCandidates, type NocoRow, pyTruthy } from "./outreach-plan";
import type { PythonSendState } from "./python-state";

export const DECISIONS = ["Approved", "Rejected", "Needs Changes"] as const;
export type Decision = (typeof DECISIONS)[number];

export const STAGES = ["triage", "review"] as const;
export type Stage = (typeof STAGES)[number];

export const SEND_APPROVED_FIELD = "Send Approved";

export type Pool = "isp" | "gym";

export type PoolConfig = {
	pool: Pool;
	tableId: string;
	label: string;
	supportsRework: boolean;
	supportsSendApproved: boolean;
};

const tableIdOf = (pool: Pool) =>
	MIRROR_TABLES.find((t) => t.key === pool)?.tableId ?? "";

export const POOLS: Record<Pool, PoolConfig> = {
	isp: {
		pool: "isp",
		tableId: tableIdOf("isp"),
		label: "ISP",
		supportsRework: true,
		supportsSendApproved: true,
	},
	gym: {
		pool: "gym",
		tableId: tableIdOf("gym"),
		label: "Gym Campaign",
		supportsRework: false,
		supportsSendApproved: false,
	},
};

export function poolOfTable(tableId: string | null): PoolConfig | null {
	if (!tableId) return null;
	return Object.values(POOLS).find((p) => p.tableId === tableId) ?? null;
}

export type LeadPatch = Record<string, string | number | boolean | null>;
export type LiveRow = Record<string, unknown>;

export const armsSending = (
	pool: PoolConfig,
	stage: Stage,
	decision: Decision,
): boolean =>
	pool.supportsSendApproved && stage === "review" && decision === "Approved";

export const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

export function buildDecisionPatch(input: {
	rowId: number;
	pool: PoolConfig;
	stage: Stage;
	decision: Decision;
	now: Date;
}): LeadPatch {
	const patch: LeadPatch = {
		Id: input.rowId,
		"Approval Decision": input.decision,
		"Decision Date": todayUtc(input.now),
	};
	if (input.pool.supportsSendApproved) {
		patch[SEND_APPROVED_FIELD] = armsSending(
			input.pool,
			input.stage,
			input.decision,
		);
	}
	return patch;
}

export type ReworkPatchResult =
	| { ok: true; patch: LeadPatch }
	| { ok: false; reason: string };

export function buildReworkPatch(input: {
	rowId: number;
	pool: PoolConfig;
	notes: string;
	now: Date;
}): ReworkPatchResult {
	if (!input.pool.supportsRework) {
		return {
			ok: false,
			reason: `Rework is not available for ${input.pool.label} leads. Reject and re-source instead.`,
		};
	}
	const notes = input.notes.trim();
	if (notes === "") {
		return { ok: false, reason: "Rework notes are required." };
	}
	return {
		ok: true,
		patch: {
			Id: input.rowId,
			"Rework Requested": input.now.toISOString(),
			"Rework Notes": notes,
			"Approval Decision": null,
			[SEND_APPROVED_FIELD]: false,
		},
	};
}

export type DecisionPolicy = { approvers: string[] };

export function readDecisionPolicy(
	env: Record<string, string | undefined>,
): DecisionPolicy {
	return {
		approvers: (env.LEADGEN_DECISION_APPROVERS ?? "")
			.split(",")
			.map((a) => a.trim().toLowerCase())
			.filter(Boolean),
	};
}

export function isDecisionApprover(
	email: string | null | undefined,
	policy: DecisionPolicy,
): boolean {
	if (!email) return false;
	return policy.approvers.includes(email.trim().toLowerCase());
}

export type Seen = {
	updatedAt: string;
	decision: string | null;
	decisionDate: string | null;
};

const text = (v: unknown): string | null => {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
};

export const versionOf = (row: LiveRow): Seen => ({
	updatedAt: text(row.UpdatedAt) ?? text(row.CreatedAt) ?? "",
	decision: text(row["Approval Decision"]),
	decisionDate: text(row["Decision Date"]),
});

export function staleFields(seen: Seen, live: LiveRow): string[] {
	const now = versionOf(live);
	const out: string[] = [];
	if (seen.updatedAt.trim() === "" || seen.updatedAt.trim() !== now.updatedAt)
		out.push("last change time");
	if (text(seen.decision) !== now.decision) out.push("decision");
	if (text(seen.decisionDate) !== now.decisionDate) out.push("decision date");
	return out;
}

export const flagOf = (v: unknown): boolean =>
	v === true || v === 1 || v === "1" || v === "true";

export function statusBlockers(input: {
	decision: Decision | null;
	live: LiveRow;
}): string[] {
	const out: string[] = [];
	if (pyTruthy(input.live["Do Not Contact"]))
		out.push("the lead is marked Do Not Contact");
	if (input.decision === "Approved" && pyTruthy(input.live["Sent At"]))
		out.push("an email was already sent to this lead");
	return out;
}

const PLACEHOLDER = "{{";

function explainIneligible(live: LiveRow): string[] {
	const out: string[] = [];
	if (!pyTruthy(live.Email)) out.push("the lead has no email address");
	const subject = live["Draft Email Subject"];
	const body = live["Draft Email Body"];
	if (!pyTruthy(subject) || !pyTruthy(body))
		out.push("the draft email subject or body is empty");
	else if (`${String(subject)}${String(body)}`.includes(PLACEHOLDER))
		out.push("the draft email still holds a {{ placeholder");
	return out;
}

export function armingBlockers(
	live: LiveRow,
	context: {
		mailed: readonly NocoRow[];
		state: Pick<PythonSendState, "replied" | "openStops">;
	},
): string[] {
	const asApproved: NocoRow = {
		...live,
		[SEND_APPROVED_FIELD]: true,
		"Approval Decision": "Approved",
	};
	const id = Number(live.Id);
	const others = context.mailed.filter((r) => Number(r.Id) !== id);
	const candidate = buildCandidates(
		[asApproved, ...others],
		context.state,
	).find((c) => c.id === id);
	if (candidate?.initialOk) return [];
	const reasons = explainIneligible(live);
	if (reasons.length > 0) return reasons;
	return [
		"the sender would not send this lead (it replied, has an open STOP hold, or its address was already mailed)",
	];
}

const sameTime = (a: unknown, b: unknown) => {
	const x = new Date(String(a).replace(" ", "T")).getTime();
	const y = new Date(String(b).replace(" ", "T")).getTime();
	return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1000;
};

export function verifyPatch(patch: LeadPatch, live: LiveRow): string[] {
	const wrong: string[] = [];
	for (const [key, want] of Object.entries(patch)) {
		if (key === "Id") continue;
		const got = live[key];
		let ok: boolean;
		if (typeof want === "boolean") ok = flagOf(got) === want;
		else if (want === null) ok = text(got) === null;
		else if (key === "Rework Requested") ok = sameTime(want, got);
		else ok = text(got) === String(want).trim();
		if (!ok) wrong.push(key);
	}
	return wrong;
}
