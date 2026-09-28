import { describe, expect, it } from "bun:test";
import {
	backoffMsForTrip,
	classifyQuotaError,
	currentPauseState,
	EMPTY_QUOTA_PAUSE_STATE,
	isPaused,
	pauseForQuota,
	type QuotaPauseState,
	type QuotaPauseStore,
	resumeManually,
} from "./quota-pause";

function memoryStore(
	initial: QuotaPauseState = EMPTY_QUOTA_PAUSE_STATE,
): QuotaPauseStore {
	let state = initial;
	return {
		async read() {
			return state;
		},
		async write(next) {
			state = next;
		},
	};
}

function clockAt(iso: string) {
	return { now: () => new Date(iso) };
}

describe("classifyQuotaError", () => {
	it("recognizes a bare HTTP 429", () => {
		expect(classifyQuotaError({ statusCode: 429 })).toBe(true);
	});

	it("recognizes Anthropic's insufficient-credit-balance message", () => {
		expect(
			classifyQuotaError({
				code: "invalid_request_error",
				message:
					"Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.",
			}),
		).toBe(true);
	});

	it("recognizes a rate_limit code even without a matching message", () => {
		expect(classifyQuotaError({ code: "rate_limit_exceeded" })).toBe(true);
	});

	it("recognizes insufficient_quota and quota_exceeded messages", () => {
		expect(classifyQuotaError({ message: "insufficient_quota" })).toBe(true);
		expect(classifyQuotaError({ message: "monthly quota exceeded" })).toBe(
			true,
		);
	});

	it("does not fire on an unrelated tool error", () => {
		expect(
			classifyQuotaError({
				code: "tool_error",
				message: "The record this names is gone.",
				statusCode: 404,
			}),
		).toBe(false);
	});

	it("does not fire on a transient provider overload (5xx, not a quota signal)", () => {
		expect(
			classifyQuotaError({
				code: "overloaded_error",
				message: "The model is currently overloaded. Please try again.",
				statusCode: 529,
			}),
		).toBe(false);
	});
});

describe("backoffMsForTrip", () => {
	it("escalates with each consecutive trip and caps at 6h", () => {
		expect(backoffMsForTrip(1)).toBe(5 * 60_000);
		expect(backoffMsForTrip(2)).toBe(15 * 60_000);
		expect(backoffMsForTrip(3)).toBe(60 * 60_000);
		expect(backoffMsForTrip(4)).toBe(4 * 60 * 60_000);
		expect(backoffMsForTrip(5)).toBe(6 * 60 * 60_000);
		expect(backoffMsForTrip(99)).toBe(6 * 60 * 60_000);
	});
});

describe("quota pause lifecycle (simulated 429)", () => {
	it("trips the breaker on a simulated 429 and stays paused before backoff elapses", async () => {
		const store = memoryStore();
		const clock = clockAt("2026-09-27T06:00:00.000Z");

		const state = await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: "429 Too Many Requests" },
			clock,
		);

		expect(state.paused).toBe(true);
		expect(state.consecutiveTrips).toBe(1);
		expect(state.resumeAt).toBe("2026-09-27T06:05:00.000Z");

		const stillPaused = await isPaused(
			store,
			clockAt("2026-09-27T06:04:59.000Z"),
		);
		expect(stillPaused).toBe(true);
	});

	it("auto-resumes once the backoff window has elapsed", async () => {
		const store = memoryStore();
		await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: "429" },
			clockAt("2026-09-27T06:00:00.000Z"),
		);

		const resumed = await currentPauseState(
			store,
			clockAt("2026-09-27T06:05:00.000Z"),
		);
		expect(resumed.paused).toBe(false);

		const stillClear = await isPaused(
			store,
			clockAt("2026-09-27T06:05:01.000Z"),
		);
		expect(stillClear).toBe(false);
	});

	it("escalates backoff across repeated trips instead of resetting", async () => {
		const store = memoryStore();
		await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: "429" },
			clockAt("2026-09-27T06:00:00.000Z"),
		);

		// A second failure arrives while still paused -> counts as trip 2.
		const second = await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: "429 again" },
			clockAt("2026-09-27T06:01:00.000Z"),
		);

		expect(second.consecutiveTrips).toBe(2);
		expect(second.resumeAt).toBe("2026-09-27T06:16:00.000Z");
	});

	it("resumeManually clears the breaker immediately regardless of backoff", async () => {
		const store = memoryStore();
		await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: "429" },
			clockAt("2026-09-27T06:00:00.000Z"),
		);

		await resumeManually(store);

		const state = await store.read();
		expect(state.paused).toBe(false);
		expect(state.consecutiveTrips).toBe(0);
	});

	it("truncates an overlong message rather than storing it unbounded", async () => {
		const store = memoryStore();
		const longMessage = "x".repeat(2000);

		const state = await pauseForQuota(
			store,
			{ code: "rate_limit_exceeded", message: longMessage },
			clockAt("2026-09-27T06:00:00.000Z"),
		);

		expect(state.message?.length).toBe(500);
	});
});
