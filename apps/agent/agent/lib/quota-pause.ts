/**
 * Quota / credit-exhaustion circuit breaker for the research-agent dispatch
 * loop.
 *
 * Card #589: when the model provider runs out of tokens/credit, the agent
 * must PAUSE dispatch rather than let failed calls pile up. Every failed
 * call used to leave a workflow run "active" in `.eve/.workflow-data`, and
 * every process restart re-enqueued the entire backlog at once, blowing
 * past the world-local queue's concurrency limit and OOM-killing Joshua.
 *
 * This module is the single source of truth for "are we paused, and why."
 * It is deliberately storage-agnostic (see `QuotaPauseStore`) so it can be
 * unit tested without touching the real filesystem, and file-backed by
 * default so the pause survives a process restart (the whole point: a
 * crash-looping unit must not forget it is out of quota).
 */

export interface QuotaPauseState {
	readonly paused: boolean;
	readonly code: string | null;
	readonly message: string | null;
	readonly pausedAt: string | null;
	readonly resumeAt: string | null;
	readonly consecutiveTrips: number;
}

export const EMPTY_QUOTA_PAUSE_STATE: QuotaPauseState = {
	paused: false,
	code: null,
	message: null,
	pausedAt: null,
	resumeAt: null,
	consecutiveTrips: 0,
};

export interface QuotaPauseStore {
	read(): Promise<QuotaPauseState>;
	write(state: QuotaPauseState): Promise<void>;
}

/**
 * Exponential backoff schedule for auto-resume, keyed by consecutive trip
 * number (1-indexed). Caps at 6h so a still-broke provider doesn't get
 * hammered, but a topped-up one is never stuck waiting more than 6h for a
 * human to notice.
 */
const BACKOFF_STEPS_MS = [
	5 * 60_000, // 1st trip: 5m
	15 * 60_000, // 2nd trip: 15m
	60 * 60_000, // 3rd trip: 1h
	4 * 60 * 60_000, // 4th trip: 4h
	6 * 60 * 60_000, // 5th+ trip: 6h cap
] as const;

const MAX_BACKOFF_MS: number =
	BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1] ?? 6 * 60 * 60_000;

export function backoffMsForTrip(trip: number): number {
	const index = Math.min(Math.max(trip, 1), BACKOFF_STEPS_MS.length) - 1;
	return BACKOFF_STEPS_MS[index] ?? MAX_BACKOFF_MS;
}

/**
 * Error signals that mean "the provider says we are out of money or over a
 * rate limit," as opposed to a transient/overloaded/unrelated failure.
 * Deliberately narrow — this must not fire on ordinary tool errors, bad
 * input, or provider 5xx overload, only on quota/credit/429 exhaustion.
 */
const QUOTA_PATTERNS: readonly RegExp[] = [
	/insufficient[_ -]?quota/i,
	/insufficient[_ -]?balance/i,
	/credit balance is too low/i,
	/rate[_ -]?limit/i,
	/quota[_ -]?exceeded/i,
	/\btoo many requests\b/i,
];

export interface QuotaErrorSignal {
	readonly code?: string | null;
	readonly message?: string | null;
	readonly statusCode?: number | null;
}

export function classifyQuotaError(signal: QuotaErrorSignal): boolean {
	if (signal.statusCode === 429) return true;

	const haystack = `${signal.code ?? ""} ${signal.message ?? ""}`;
	return QUOTA_PATTERNS.some((pattern) => pattern.test(haystack));
}

export interface QuotaPauseClock {
	now(): Date;
}

export const SYSTEM_CLOCK: QuotaPauseClock = { now: () => new Date() };

/**
 * Records a quota-exhaustion trip: marks the breaker paused, bumps the
 * consecutive-trip counter (reset once a manual/backoff resume happens),
 * and schedules the next auto-resume attempt.
 */
export async function pauseForQuota(
	store: QuotaPauseStore,
	reason: { code?: string | null; message: string },
	clock: QuotaPauseClock = SYSTEM_CLOCK,
): Promise<QuotaPauseState> {
	const prior = await store.read();
	const trip = prior.paused ? prior.consecutiveTrips + 1 : 1;
	const now = clock.now();
	const resumeAt = new Date(now.getTime() + backoffMsForTrip(trip));

	const next: QuotaPauseState = {
		paused: true,
		code: reason.code?.slice(0, 100) ?? "quota_exhausted",
		message: reason.message.slice(0, 500),
		pausedAt: now.toISOString(),
		resumeAt: resumeAt.toISOString(),
		consecutiveTrips: trip,
	};

	await store.write(next);
	return next;
}

/**
 * Reads state and, if the backoff window has elapsed, auto-resumes. This is
 * the *only* place auto-resume happens, so callers just need to call this
 * (via `isPaused`) before doing dispatch work.
 */
export async function currentPauseState(
	store: QuotaPauseStore,
	clock: QuotaPauseClock = SYSTEM_CLOCK,
): Promise<QuotaPauseState> {
	const state = await store.read();
	if (!state.paused) return state;

	if (state.resumeAt && Date.parse(state.resumeAt) <= clock.now().getTime()) {
		const resumed: QuotaPauseState = { ...state, paused: false };
		await store.write(resumed);
		return resumed;
	}

	return state;
}

export async function isPaused(
	store: QuotaPauseStore,
	clock: QuotaPauseClock = SYSTEM_CLOCK,
): Promise<boolean> {
	const state = await currentPauseState(store, clock);
	return state.paused;
}

/** Manual override: clears the breaker regardless of backoff or trip count. */
export async function resumeManually(store: QuotaPauseStore): Promise<void> {
	await store.write({ ...EMPTY_QUOTA_PAUSE_STATE });
}

// ---------------------------------------------------------------------------
// Default, file-backed store
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.EVE_QUOTA_PAUSE_DIR ?? ".eve";
const STATE_FILE = path.join(STATE_DIR, "quota-pause.json");

function parseState(raw: string): QuotaPauseState {
	const parsed = JSON.parse(raw) as Partial<QuotaPauseState>;
	return { ...EMPTY_QUOTA_PAUSE_STATE, ...parsed };
}

export const fileQuotaPauseStore: QuotaPauseStore = {
	async read() {
		try {
			const raw = await fs.readFile(STATE_FILE, "utf8");
			return parseState(raw);
		} catch {
			return { ...EMPTY_QUOTA_PAUSE_STATE };
		}
	},

	async write(state) {
		await fs.mkdir(STATE_DIR, { recursive: true });
		await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
	},
};

// ---------------------------------------------------------------------------
// Convenience wrappers over the default store, for call sites that don't
// need to inject a store (production dispatch code, hooks).
// ---------------------------------------------------------------------------

export async function pauseDispatchForQuota(reason: {
	code?: string | null;
	message: string;
}): Promise<QuotaPauseState> {
	const next = await pauseForQuota(fileQuotaPauseStore, reason);
	console.error(
		`[agent] quota-guard: dispatch PAUSED (${next.code}) — ${next.message} — auto-resume at ${next.resumeAt}, or delete ${STATE_FILE} / call resumeDispatchManually() to clear now.`,
	);
	return next;
}

export async function isDispatchPaused(): Promise<boolean> {
	return isPaused(fileQuotaPauseStore);
}

export async function dispatchPauseState(): Promise<QuotaPauseState> {
	return currentPauseState(fileQuotaPauseStore);
}

export async function resumeDispatchManually(): Promise<void> {
	await resumeManually(fileQuotaPauseStore);
	console.error(`[agent] quota-guard: dispatch resumed manually`);
}
