import { describe, expect, test } from "bun:test";
import {
	BASE_DELAYS_MS,
	failureCounters,
	isTransientImapError,
	JITTER,
	MAX_ATTEMPTS,
	RETRY_WINDOW_MS,
	retryDelaysMs,
	withImapRetry,
} from "../src/leadgen/imap-retry";

function err(message: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), extra);
}
const noSleep = async () => {};

describe("isTransientImapError", () => {
	test("the measured failures are transient", () => {
		expect(
			isTransientImapError(
				err("Connection not available", { code: "NoConnection" }),
			),
		).toBe(true);
		expect(isTransientImapError(err("Connection not available"))).toBe(true);
		expect(isTransientImapError(err("getaddrinfo ETIMEOUT"))).toBe(true);
	});
	test("the other named network faults are transient", () => {
		expect(isTransientImapError(err("read", { code: "ECONNRESET" }))).toBe(
			true,
		);
		expect(isTransientImapError(err("x", { code: "EAI_AGAIN" }))).toBe(true);
		expect(isTransientImapError(err("getaddrinfo EAI_AGAIN host"))).toBe(true);
		expect(isTransientImapError(err("socket hang up"))).toBe(true);
		expect(isTransientImapError(err("x", { code: "ETIMEOUT" }))).toBe(true);
	});
	test("authentication failures are never transient, even beside a network word", () => {
		expect(
			isTransientImapError(
				err("Command failed", { authenticationFailed: true }),
			),
		).toBe(false);
		expect(
			isTransientImapError(
				err("Connection not available", { authenticationFailed: true }),
			),
		).toBe(false);
		expect(
			isTransientImapError(
				err("x", { serverResponseCode: "AUTHENTICATIONFAILED" }),
			),
		).toBe(false);
		expect(isTransientImapError(err("Invalid credentials (Failure)"))).toBe(
			false,
		);
		expect(
			isTransientImapError(err("ECONNRESET during authentication failed")),
		).toBe(false);
	});
	test("unknown, abort and non-error values are permanent", () => {
		expect(isTransientImapError(err("Command failed"))).toBe(false);
		expect(isTransientImapError(err("aborted"))).toBe(false);
		expect(isTransientImapError(err("something odd", { code: "EACCES" }))).toBe(
			false,
		);
		expect(isTransientImapError(null)).toBe(false);
		expect(isTransientImapError("Connection not available")).toBe(false);
	});
});

describe("retry policy bounds", () => {
	test("at most three attempts, two waits", () => {
		expect(MAX_ATTEMPTS).toBe(3);
		expect(BASE_DELAYS_MS).toEqual([2000, 5000]);
	});
	test("jitter stays within +/-25% of 2s and 5s", () => {
		expect(retryDelaysMs(() => 0)).toEqual([1500, 3750]);
		expect(retryDelaysMs(() => 0.5)).toEqual([2000, 5000]);
		expect(retryDelaysMs(() => 1)).toEqual([2500, 6250]);
		expect(JITTER).toBe(0.25);
	});
	test("worst-case added wait is far under the 300s job timeout", () => {
		const worst = retryDelaysMs(() => 1).reduce((a, b) => a + b, 0);
		expect(worst).toBeLessThan(10_000);
		expect(RETRY_WINDOW_MS).toBeLessThanOrEqual(60_000);
	});
});

describe("withImapRetry", () => {
	test("fails twice then succeeds: three attempts, value returned", async () => {
		let calls = 0;
		const waits: number[] = [];
		const r = await withImapRetry(
			async (n) => {
				calls++;
				if (n < 3) throw err("Connection not available");
				return "ok";
			},
			{
				delaysMs: [2000, 5000],
				sleep: async (ms) => {
					waits.push(ms);
				},
			},
		);
		expect(r).toEqual({ value: "ok", attempts: 3 });
		expect(calls).toBe(3);
		expect(waits).toEqual([2000, 5000]);
	});
	test("succeeds first time: one attempt, no wait", async () => {
		const waits: number[] = [];
		const r = await withImapRetry(async () => 7, {
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(r).toEqual({ value: 7, attempts: 1 });
		expect(waits).toEqual([]);
	});
	test("a permanent error is not retried", async () => {
		let calls = 0;
		await expect(
			withImapRetry(
				async () => {
					calls++;
					throw err("Command failed", { authenticationFailed: true });
				},
				{ sleep: noSleep },
			),
		).rejects.toThrow("Command failed");
		expect(calls).toBe(1);
	});
	test("exhaustion rethrows the LAST error object with the attempt count", async () => {
		const errors: Error[] = [];
		let caught: unknown;
		try {
			await withImapRetry(
				async (n) => {
					const e = err(
						n === 3 ? "getaddrinfo ETIMEOUT" : "Connection not available",
					);
					errors.push(e);
					throw e;
				},
				{ sleep: noSleep },
			);
		} catch (e) {
			caught = e;
		}
		expect(errors.length).toBe(3);
		expect(caught).toBe(errors[2]);
		expect((caught as Error).message).toBe("getaddrinfo ETIMEOUT");
		expect(failureCounters(caught)).toEqual({ imapAttempts: 3 });
	});
	test("endless transient errors stop at the attempt cap", async () => {
		let calls = 0;
		await expect(
			withImapRetry(
				async () => {
					calls++;
					throw err("socket hang up");
				},
				{ sleep: noSleep },
			),
		).rejects.toThrow("socket hang up");
		expect(calls).toBe(3);
	});
	test("no new attempt starts once the window is spent", async () => {
		let clock = 0;
		let calls = 0;
		await expect(
			withImapRetry(
				async () => {
					calls++;
					clock += 59_000;
					throw err("Connection not available");
				},
				{
					delaysMs: [2000, 5000],
					windowMs: 60_000,
					now: () => clock,
					sleep: async (ms) => {
						clock += ms;
					},
				},
			),
		).rejects.toThrow("Connection not available");
		expect(calls).toBe(1);
	});
	test("a job aborted during the attempt does not even wait, and does not retry", async () => {
		const ac = new AbortController();
		let calls = 0;
		let sleeps = 0;
		let caught: unknown;
		try {
			await withImapRetry(
				async () => {
					calls++;
					ac.abort();
					throw err("Connection not available");
				},
				{
					signal: ac.signal,
					sleep: async () => {
						sleeps++;
					},
				},
			);
		} catch (e) {
			caught = e;
		}
		expect(calls).toBe(1);
		expect(sleeps).toBe(0);
		expect((caught as Error).message).toBe("Connection not available");
	});
	test("a job aborted during the wait does not start another attempt", async () => {
		const ac = new AbortController();
		let calls = 0;
		await expect(
			withImapRetry(
				async () => {
					calls++;
					throw err("Connection not available");
				},
				{
					signal: ac.signal,
					sleep: async () => {
						ac.abort();
					},
				},
			),
		).rejects.toThrow("Connection not available");
		expect(calls).toBe(1);
	});
});

describe("failureCounters", () => {
	test("null for plain errors and non-errors, numbers only otherwise", () => {
		expect(failureCounters(new Error("x"))).toBeNull();
		expect(failureCounters(null)).toBeNull();
		expect(
			failureCounters(err("x", { lgCounters: { imapAttempts: 2 } })),
		).toEqual({
			imapAttempts: 2,
		});
		expect(
			failureCounters(err("x", { lgCounters: { a: 1, b: { c: 1 }, d: "s" } })),
		).toEqual({ a: 1, d: "s" });
	});
});
