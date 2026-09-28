/**
 * Bounded retry for the read-only front half of `replies.poll` (connect, open INBOX, read INBOX).
 *
 * Why it exists: the mailbox server sometimes drops the socket mid-transfer and imapflow rejects the
 * pending command with `Connection not available` (measured: ~5% of polls). Nothing has been written
 * at that point, so trying again on a fresh connection is safe. This module only decides WHETHER and
 * WHEN to try again; it knows nothing about mail and never touches a database.
 *
 * Rules that must not be loosened without a new plan:
 *  - authentication failures are never retried (a bad password must not be hammered);
 *  - anything not recognised as transient is permanent;
 *  - at most MAX_ATTEMPTS attempts and never past RETRY_WINDOW_MS after the first started;
 *  - the last error is rethrown unchanged, so the alert text is exactly what it was before.
 */
export const MAX_ATTEMPTS = 3;
/** Nominal waits before attempt 2 and attempt 3. */
export const BASE_DELAYS_MS: readonly number[] = [2000, 5000];
/** Each wait is base * (1 +/- JITTER). */
export const JITTER = 0.25;
/** No new attempt starts once this much time has passed since the first began (job timeout is 300 s). */
export const RETRY_WINDOW_MS = 60_000;

const AUTH_MESSAGE =
	/authenticationfailed|authentication failed|invalid credentials|login failed|auth(?:entication)? (?:error|required)/i;
const TRANSIENT_CODES = new Set([
	"NOCONNECTION",
	"ETIMEOUT",
	"ETIMEDOUT",
	"ECONNRESET",
	"EAI_AGAIN",
]);
const TRANSIENT_MESSAGE =
	/connection not available|getaddrinfo (?:ETIMEOUT|EAI_AGAIN)|\bETIMEOUT\b|\bECONNRESET\b|\bEAI_AGAIN\b|socket hang up/i;

type ErrLike = {
	message?: unknown;
	code?: unknown;
	authenticationFailed?: unknown;
	serverResponseCode?: unknown;
};

/** True only for errors known to be a passing network fault. Auth errors are ruled out first. */
export function isTransientImapError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as ErrLike;
	const message = typeof e.message === "string" ? e.message : "";
	const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
	const server =
		typeof e.serverResponseCode === "string"
			? e.serverResponseCode.toUpperCase()
			: "";
	if (e.authenticationFailed === true) return false;
	if (server === "AUTHENTICATIONFAILED" || code === "AUTHENTICATIONFAILED") {
		return false;
	}
	if (AUTH_MESSAGE.test(message)) return false;
	if (message === "aborted") return false;
	return TRANSIENT_CODES.has(code) || TRANSIENT_MESSAGE.test(message);
}

/** Jittered waits before each retry. `random` is injectable so tests are exact. */
export function retryDelaysMs(random: () => number = Math.random): number[] {
	return BASE_DELAYS_MS.map((base) =>
		Math.round(base * (1 - JITTER + 2 * JITTER * random())),
	);
}

export type RetryOptions = {
	maxAttempts?: number;
	delaysMs?: readonly number[];
	windowMs?: number;
	signal?: AbortSignal;
	/** Injectable for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	/** Called before each wait; purely for logging. */
	onRetry?: (info: {
		attempt: number;
		delayMs: number;
		error: unknown;
	}) => void;
};

/** What the handler adds to a failed run's counters. */
export type FailureCounters = { imapAttempts: number };

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done);
	});
}

/** Rethrow-friendly: the ORIGINAL error object, with the attempt count attached. */
function withAttempts(err: unknown, attempts: number): unknown {
	if (err && typeof err === "object") {
		(err as { lgCounters?: FailureCounters }).lgCounters = {
			imapAttempts: attempts,
		};
	}
	return err;
}

/**
 * Runs `attempt(n)` (n starts at 1) until it succeeds, fails permanently, or the budget is spent.
 * The attempt must be free of side effects outside its own connection: it is re-run from scratch.
 */
export async function withImapRetry<T>(
	attempt: (n: number) => Promise<T>,
	opts: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
	const max = opts.maxAttempts ?? MAX_ATTEMPTS;
	const delays = opts.delaysMs ?? retryDelaysMs();
	const windowMs = opts.windowMs ?? RETRY_WINDOW_MS;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const started = now();
	for (let n = 1; ; n++) {
		try {
			return { value: await attempt(n), attempts: n };
		} catch (err) {
			if (n >= max || !isTransientImapError(err)) throw withAttempts(err, n);
			const delay = delays[Math.min(n - 1, delays.length - 1)] ?? 0;
			if (opts.signal?.aborted || now() - started + delay > windowMs) {
				throw withAttempts(err, n);
			}
			opts.onRetry?.({ attempt: n, delayMs: delay, error: err });
			await sleep(delay, opts.signal);
			if (opts.signal?.aborted) throw withAttempts(err, n);
		}
	}
}

/** Counters a failed run should keep, if the error carries any. Timed-out runs never do. */
export function failureCounters(
	err: unknown,
): Record<string, number | string> | null {
	const c = (err as { lgCounters?: unknown } | null)?.lgCounters;
	if (!c || typeof c !== "object") return null;
	const out: Record<string, number | string> = {};
	for (const [k, v] of Object.entries(c)) {
		if (typeof v === "number" || typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : null;
}
