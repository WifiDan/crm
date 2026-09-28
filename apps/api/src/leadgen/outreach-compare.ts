import {
	type Candidate,
	DEFAULT_CAP,
	FU1_DELAY_DAYS,
	FU2_DELAY_DAYS,
	type Hold,
	type PlannedSend,
	planBatch,
} from "./outreach-plan";

/**
 * Phase 4 SHADOW comparison: did the CRM's plan equal what Python actually sent?
 *
 * The clock is the one legitimate source of disagreement. Python evaluates "7 days since the first
 * email" at its own start time, while each lead's Sent At was stamped when its individual email went
 * out, seconds into the previous run. A follow-up therefore lands at day 7 or day 8 depending on a few
 * seconds of jitter, and nothing on the CRM side can know Python's exact start. So:
 *
 *   MATCH             the plan at the scheduled start equals Python's batch exactly (same rows,
 *                     same tiers, same order)
 *   MATCH_WITH_TIMING some clock value between the scheduled start and Python's first send
 *                     reproduces its batch exactly (a follow-up was on the day boundary)
 *   MISMATCH          no such clock value exists: the port differs from Python
 *
 * Nothing fuzzy: the alternative clock must reproduce the WHOLE ordered batch, not part of it.
 */

export type ActualSend = { id: number; tier: PlannedSend["tier"]; at: Date };

export type CompareStatus = "MATCH" | "MATCH_WITH_TIMING" | "MISMATCH";

export type CompareResult = {
	status: CompareStatus;
	planned: PlannedSend[];
	actual: PlannedSend[];
	matchedAsOf: string | null;
	shadowOnly: PlannedSend[];
	pythonOnly: PlannedSend[];
	note: string;
};

const WINDOW_WHEN_PYTHON_SENT_NOTHING_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const same = (a: readonly PlannedSend[], b: readonly PlannedSend[]) =>
	a.length === b.length &&
	a.every((x, i) => x.id === b[i]?.id && x.tier === b[i]?.tier);

const label = (x: PlannedSend) => `${x.tier}:${x.id}`;

/** Every instant in (start, end] at which some lead crosses its day-7 or day-28 line. */
export function breakpoints(
	cands: readonly Candidate[],
	start: Date,
	end: Date,
): Date[] {
	const out = new Set<number>();
	for (const c of cands) {
		if (!c.sentAt) continue;
		const sent = new Date(c.sentAt).getTime();
		for (const days of [FU1_DELAY_DAYS, FU2_DELAY_DAYS]) {
			const t = sent + days * DAY_MS;
			if (t > start.getTime() && t <= end.getTime()) out.add(t);
		}
	}
	return [...out].sort((a, b) => a - b).map((t) => new Date(t));
}

export function compareRun(input: {
	cands: readonly Candidate[];
	hold: Hold | null;
	asOfStart: Date;
	cap?: number;
	actual: readonly ActualSend[];
}): CompareResult {
	const cap = input.cap ?? DEFAULT_CAP;
	const actual: PlannedSend[] = input.actual.map((a) => ({
		id: a.id,
		tier: a.tier,
	}));
	const planned = input.hold
		? []
		: planBatch(input.cands, input.asOfStart, cap);

	const diff = (want: PlannedSend[]) => ({
		shadowOnly: want.filter((w) => !actual.some((a) => label(a) === label(w))),
		pythonOnly: actual.filter((a) => !want.some((w) => label(w) === label(a))),
	});

	if (same(planned, actual)) {
		return {
			status: "MATCH",
			planned,
			actual,
			matchedAsOf: input.asOfStart.toISOString(),
			shadowOnly: [],
			pythonOnly: [],
			note: input.hold
				? `both held or empty (${input.hold.kind})`
				: `${actual.length} send(s) identical`,
		};
	}

	if (!input.hold) {
		const firstSend = input.actual.reduce<Date | null>(
			(min, a) => (min === null || a.at < min ? a.at : min),
			null,
		);
		const end =
			firstSend ??
			new Date(input.asOfStart.getTime() + WINDOW_WHEN_PYTHON_SENT_NOTHING_MS);
		for (const t of breakpoints(input.cands, input.asOfStart, end)) {
			if (same(planBatch(input.cands, t, cap), actual)) {
				return {
					status: "MATCH_WITH_TIMING",
					planned,
					actual,
					matchedAsOf: t.toISOString(),
					...diff(planned),
					note: "a follow-up sat on the day-7/28 boundary; Python's exact batch is reproduced at a clock inside its start window",
				};
			}
		}
	}

	return {
		status: "MISMATCH",
		planned,
		actual,
		matchedAsOf: null,
		...diff(planned),
		note: input.hold
			? `CRM held (${input.hold.detail}) but Python sent ${actual.length}`
			: "no clock value in Python's start window reproduces its batch",
	};
}

/** Consecutive most-recent runs that matched (either kind), newest first. */
export function matchStreak(
	statuses: ReadonlyArray<CompareStatus | null>,
): number {
	let n = 0;
	for (const st of statuses) {
		if (st === "MATCH" || st === "MATCH_WITH_TIMING") n++;
		else break;
	}
	return n;
}
