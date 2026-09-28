import { describe, expect, test } from "bun:test";
import { nextDailyRun, nextRunAfter } from "../src/leadgen/schedule";

describe("nextDailyRun", () => {
	test("01:00 Denver from the evening before lands at 07:00Z (MDT)", () => {
		const from = new Date("2026-09-19T04:00:00Z"); // 22:00 MDT on the 18th
		expect(nextDailyRun(from, "01:00", "America/Denver").toISOString()).toBe(
			"2026-09-19T07:00:00.000Z",
		);
	});

	test("rolls to tomorrow when today's slot already passed", () => {
		const from = new Date("2026-09-19T08:00:00Z"); // 02:00 MDT, past 01:00
		expect(nextDailyRun(from, "01:00", "America/Denver").toISOString()).toBe(
			"2026-09-20T07:00:00.000Z",
		);
	});

	test("winter offset (MST, UTC-7) is honoured", () => {
		const from = new Date("2026-12-10T00:00:00Z");
		expect(nextDailyRun(from, "08:30", "America/Denver").toISOString()).toBe(
			"2026-12-10T15:30:00.000Z",
		);
	});

	test("spring-forward day still returns a single valid instant", () => {
		const from = new Date("2027-03-14T00:00:00Z");
		const next = nextDailyRun(from, "08:00", "America/Denver");
		expect(next.getTime()).toBeGreaterThan(from.getTime());
		expect(next.toISOString()).toBe("2027-03-14T14:00:00.000Z");
	});

	test("rejects a malformed time", () => {
		expect(() => nextDailyRun(new Date(), "8am", "America/Denver")).toThrow();
	});
});

describe("nextRunAfter", () => {
	test("interval adds seconds", () => {
		const from = new Date("2026-09-19T00:00:00Z");
		expect(
			nextRunAfter(
				{
					scheduleKind: "INTERVAL",
					intervalSeconds: 900,
					dailyAt: null,
					timezone: "America/Denver",
				},
				from,
			).toISOString(),
		).toBe("2026-09-19T00:15:00.000Z");
	});

	test("interval below 10s is refused", () => {
		expect(() =>
			nextRunAfter(
				{
					scheduleKind: "INTERVAL",
					intervalSeconds: 5,
					dailyAt: null,
					timezone: "UTC",
				},
				new Date(),
			),
		).toThrow();
	});
});
