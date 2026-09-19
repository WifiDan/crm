import { describe, expect, test } from "bun:test";
import {
	type ActualSend,
	breakpoints,
	compareRun,
	matchStreak,
} from "../src/leadgen/outreach-compare";
import {
	buildCandidates,
	checkInterlocks,
	type NocoRow,
	planBatch,
	poolsAt,
	pyTruthy,
} from "../src/leadgen/outreach-plan";
import {
	parseOpenStops,
	parseRepliedHolds,
	stopScanAgeHours,
} from "../src/leadgen/python-state";

const NOW = new Date("2026-09-20T14:30:00Z");
const daysAgo = (d: number, extraMs = 0) =>
	new Date(NOW.getTime() - d * 86_400_000 - extraMs).toISOString();

const noHolds = {
	replied: parseRepliedHolds({ leads: {} }),
	openStops: parseOpenStops({}),
};

/** an approved, drafted, never-mailed row */
const initialRow = (id: number, over: NocoRow = {}): NocoRow => ({
	Id: id,
	"Business Name": `Biz ${id}`,
	Email: `owner${id}@biz${id}.com`,
	"Send Approved": true,
	"Approval Decision": "Approved",
	"Draft Email Subject": "Hello",
	"Draft Email Body": "Body",
	...over,
});

/** a row that was mailed `sentDays` ago and has follow-up drafts ready */
const followRow = (
	id: number,
	sentDays: number,
	over: NocoRow = {},
): NocoRow => ({
	Id: id,
	"Business Name": `Biz ${id}`,
	Email: `owner${id}@biz${id}.com`,
	"Sent At": daysAgo(sentDays),
	"Follow Up 1 Subject": "fu1",
	"Follow Up 1 Body": "fu1 body",
	"Follow Up 2 Subject": "fu2",
	"Follow Up 2 Body": "fu2 body",
	...over,
});

const plan = (rows: NocoRow[], holds = noHolds, cap?: number) =>
	planBatch(buildCandidates(rows, holds), NOW, cap);

describe("python truthiness", () => {
	test("matches Python for the values NocoDB returns", () => {
		for (const v of [false, 0, "", null, undefined, []])
			expect(pyTruthy(v)).toBe(false);
		for (const v of [true, 1, "x", "false", "0", [1]])
			expect(pyTruthy(v)).toBe(true);
	});
});

describe("state files: ported including where Python fails open", () => {
	test("replied holds: a missing or malformed file holds everything (ok=false)", () => {
		expect(parseRepliedHolds(null).ok).toBe(false);
		expect(parseRepliedHolds({}).ok).toBe(false);
		expect(parseRepliedHolds({ leads: [] }).ok).toBe(false);
		expect(parseRepliedHolds("x").ok).toBe(false);
	});
	test("replied holds: an empty but valid file is ok with no holds", () => {
		const h = parseRepliedHolds({ leads: {} });
		expect(h.ok).toBe(true);
		expect(h.ids.size + h.addrs.size).toBe(0);
	});
	test("replied holds: released entries are skipped; ids and every address are collected", () => {
		const h = parseRepliedHolds({
			leads: {
				"7": {
					reply_from: "Owner@Biz.com",
					reply_addresses: ["alt@biz.com"],
					mailed_address: "Mailed@Biz.com ",
				},
				"8": { released_at: "2026-09-10T00:00:00Z", reply_from: "x@y.com" },
				junk: { reply_from: "z@z.com" },
			},
		});
		expect([...h.ids]).toEqual([7]);
		expect([...h.addrs].sort()).toEqual([
			"alt@biz.com",
			"mailed@biz.com",
			"owner@biz.com",
			"z@z.com",
		]);
	});
	test("open STOP reviews: a freemail sender holds the address only; a company sender holds its domain", () => {
		const h = parseOpenStops({
			a: { from_email: "Person@Gmail.com" },
			b: { from_email: "boss@Acme.com" },
			c: {},
		});
		expect([...h.addrs].sort()).toEqual(["boss@acme.com", "person@gmail.com"]);
		expect([...h.domains]).toEqual(["acme.com"]);
	});
	test("open STOP reviews: unreadable input holds nothing (Python swallows the error)", () => {
		expect(parseOpenStops(null).addrs.size).toBe(0);
		expect(parseOpenStops([1, 2]).addrs.size).toBe(0);
	});
	test("STOP scan age", () => {
		expect(
			stopScanAgeHours({ last_run: "2026-09-20T04:30:00+00:00" }, NOW),
		).toBe(10);
		expect(stopScanAgeHours({}, NOW)).toBeNull();
		expect(stopScanAgeHours(null, NOW)).toBeNull();
		expect(stopScanAgeHours({ last_run: "nonsense" }, NOW)).toBeNull();
	});
});

describe("interlocks fail closed", () => {
	const okReplied = parseRepliedHolds({ leads: {} });
	test("fresh scan and readable replies proceed", () => {
		expect(
			checkInterlocks({ stopAgeHours: 10, replied: okReplied }),
		).toBeNull();
		expect(
			checkInterlocks({ stopAgeHours: 36, replied: okReplied }),
		).toBeNull();
	});
	test("a scan that never ran, or is over 36h old, holds", () => {
		expect(
			checkInterlocks({ stopAgeHours: null, replied: okReplied })?.kind,
		).toBe("STOP_SCAN_STALE");
		expect(
			checkInterlocks({ stopAgeHours: 36.1, replied: okReplied })?.kind,
		).toBe("STOP_SCAN_STALE");
	});
	test("an unreadable replied file holds", () => {
		expect(
			checkInterlocks({ stopAgeHours: 1, replied: parseRepliedHolds(null) })
				?.kind,
		).toBe("REPLIED_STATE_MISSING");
	});
});

describe("initial eligibility", () => {
	test("an approved, drafted, never-mailed row is planned", () => {
		expect(plan([initialRow(1)])).toEqual([{ id: 1, tier: "initial" }]);
	});
	const blocked: Array<[string, NocoRow]> = [
		["not Send Approved", { "Send Approved": false }],
		["Send Approved unset", { "Send Approved": undefined }],
		["decision is not Approved", { "Approval Decision": "Pending" }],
		["no email", { Email: "" }],
		["already sent", { "Sent At": daysAgo(1) }],
		["do not contact", { "Do Not Contact": true }],
		["no subject", { "Draft Email Subject": "" }],
		["no body", { "Draft Email Body": null }],
		["placeholder in subject", { "Draft Email Subject": "Hi {{name}}" }],
		["placeholder in body", { "Draft Email Body": "Dear {{name}}" }],
	];
	for (const [name, patch] of blocked) {
		test(`not planned: ${name}`, () => {
			expect(plan([initialRow(1, patch)])).toEqual([]);
		});
	}
	test("the same address is never mailed twice: a second row for a mailed address is skipped", () => {
		const rows = [
			followRow(1, 2, { Email: "same@x.com" }),
			initialRow(2, { Email: "SAME@x.com " }),
		];
		expect(plan(rows).some((p) => p.id === 2)).toBe(false);
	});
	test("the address dedupe looks at every row, even one a reply hold removes", () => {
		const held = parseRepliedHolds({
			leads: { "1": { reply_from: "someone@else.com" } },
		});
		const rows = [
			followRow(1, 2, { Email: "same@x.com" }),
			initialRow(2, { Email: "same@x.com" }),
		];
		expect(plan(rows, { ...noHolds, replied: held })).toEqual([]);
	});
});

describe("follow-up eligibility and the day boundary", () => {
	test("exactly 7 days is eligible for follow-up 1; a minute short is not", () => {
		expect(plan([followRow(1, 7)]).map((p) => p.tier)).toEqual(["fu1"]);
		expect(plan([followRow(1, 7, { "Sent At": daysAgo(7, -60_000) })])).toEqual(
			[],
		);
	});
	test("follow-up 2 needs 28 days and a follow-up 2 draft", () => {
		expect(plan([followRow(1, 27)]).map((p) => p.tier)).toEqual(["fu1"]);
		expect(plan([followRow(1, 28)]).map((p) => p.tier)).toEqual(["fu1", "fu2"]);
		expect(
			plan([followRow(1, 28, { "Follow Up 2 Body": "" })]).map((p) => p.tier),
		).toEqual(["fu1"]);
	});
	test("a lead can sit in both follow-up pools on the same day (Python does this)", () => {
		const pools = poolsAt(buildCandidates([followRow(1, 30)], noHolds), NOW);
		expect(pools.fu1).toEqual([1]);
		expect(pools.fu2).toEqual([1]);
	});
	test("a follow-up already sent, a placeholder, or do-not-contact excludes that tier", () => {
		expect(
			plan([followRow(1, 8, { "Follow Up 1 Sent At": daysAgo(1) })]),
		).toEqual([]);
		expect(plan([followRow(1, 8, { "Follow Up 1 Body": "Hi {{x}}" })])).toEqual(
			[],
		);
		expect(plan([followRow(1, 8, { "Do Not Contact": true })])).toEqual([]);
	});
	test("follow-ups do not require Send Approved", () => {
		expect(
			plan([followRow(1, 8, { "Send Approved": false })]).map((p) => p.tier),
		).toEqual(["fu1"]);
	});
});

describe("ordering and the shared cap", () => {
	test("initials first, then follow-up 1, then follow-up 2, each by Id", () => {
		const rows = [
			followRow(50, 30),
			followRow(5, 8),
			initialRow(20),
			initialRow(3),
			followRow(9, 8),
		];
		expect(plan(rows)).toEqual([
			{ id: 3, tier: "initial" },
			{ id: 20, tier: "initial" },
			{ id: 5, tier: "fu1" },
			{ id: 9, tier: "fu1" },
			{ id: 50, tier: "fu1" },
			{ id: 50, tier: "fu2" },
		]);
	});
	test("the cap is shared across tiers and initials win it", () => {
		const rows = [
			...Array.from({ length: 8 }, (_, i) => initialRow(100 + i)),
			...Array.from({ length: 6 }, (_, i) => followRow(i + 1, 10)),
		];
		const p = plan(rows);
		expect(p).toHaveLength(10);
		expect(p.filter((x) => x.tier === "initial")).toHaveLength(8);
		expect(p.filter((x) => x.tier === "fu1").map((x) => x.id)).toEqual([1, 2]);
	});
	test("a custom cap is honoured", () => {
		expect(
			plan([initialRow(1), initialRow(2), initialRow(3)], noHolds, 2),
		).toHaveLength(2);
	});
});

describe("suppression holds remove the row entirely", () => {
	test("a replied lead is held by Id, and by address for duplicate rows", () => {
		const held = parseRepliedHolds({
			leads: { "1": { reply_from: "dup@x.com" } },
		});
		const rows = [
			initialRow(1),
			initialRow(2, { Email: "dup@x.com" }),
			initialRow(3),
		];
		expect(plan(rows, { ...noHolds, replied: held })).toEqual([
			{ id: 3, tier: "initial" },
		]);
	});
	test("an unattributed STOP holds the exact address and, for a company domain, every address on it", () => {
		const open = parseOpenStops({
			a: { from_email: "quit@gmail.com" },
			b: { from_email: "boss@acme.com" },
		});
		const rows = [
			initialRow(1, { Email: "quit@gmail.com" }),
			initialRow(2, { Email: "other@gmail.com" }),
			initialRow(3, { Email: "sales@acme.com" }),
			initialRow(4, { Email: "x@fine.com" }),
		];
		expect(
			plan(rows, { ...noHolds, openStops: open }).map((p) => p.id),
		).toEqual([2, 4]);
	});
});

// ---- the comparison -------------------------------------------------------------------------

const at = (extraMs = 0) => new Date(NOW.getTime() + extraMs);
const sends = (
	items: Array<[number, "initial" | "fu1" | "fu2"]>,
): ActualSend[] =>
	items.map(([id, tier], i) => ({ id, tier, at: at(5_000 + i * 2_000) }));

describe("comparing the plan with what Python sent", () => {
	const rows = [initialRow(3), initialRow(20), followRow(5, 8)];
	const cands = buildCandidates(rows, noHolds);

	test("identical batches match", () => {
		const r = compareRun({
			cands,
			hold: null,
			asOfStart: NOW,
			actual: sends([
				[3, "initial"],
				[20, "initial"],
				[5, "fu1"],
			]),
		});
		expect(r.status).toBe("MATCH");
	});
	test("order matters", () => {
		const r = compareRun({
			cands,
			hold: null,
			asOfStart: NOW,
			actual: sends([
				[20, "initial"],
				[3, "initial"],
				[5, "fu1"],
			]),
		});
		expect(r.status).toBe("MISMATCH");
	});
	test("a row Python sent that the plan did not want is reported as pythonOnly", () => {
		const r = compareRun({
			cands,
			hold: null,
			asOfStart: NOW,
			actual: sends([
				[3, "initial"],
				[20, "initial"],
				[5, "fu1"],
				[99, "initial"],
			]),
		});
		expect(r.status).toBe("MISMATCH");
		expect(r.pythonOnly).toEqual([{ id: 99, tier: "initial" }]);
		expect(r.shadowOnly).toEqual([]);
	});
	test("a row the plan wanted that Python did not send is reported as shadowOnly", () => {
		const r = compareRun({
			cands,
			hold: null,
			asOfStart: NOW,
			actual: sends([
				[3, "initial"],
				[20, "initial"],
			]),
		});
		expect(r.status).toBe("MISMATCH");
		expect(r.shadowOnly).toEqual([{ id: 5, tier: "fu1" }]);
	});
	test("the wrong tier for the right lead is a mismatch", () => {
		const r = compareRun({
			cands,
			hold: null,
			asOfStart: NOW,
			actual: sends([
				[3, "initial"],
				[20, "initial"],
				[5, "fu2"],
			]),
		});
		expect(r.status).toBe("MISMATCH");
	});

	describe("the day-7 boundary", () => {
		// lead 7 crosses the 7-day line 20 seconds AFTER the scheduled start
		const boundary = followRow(7, 7, { "Sent At": daysAgo(7, -20_000) });
		const c = buildCandidates([initialRow(3), boundary], noHolds);
		test("planned without it at the scheduled start", () => {
			expect(planBatch(c, NOW)).toEqual([{ id: 3, tier: "initial" }]);
		});
		test("Python started 30s late and included it: MATCH_WITH_TIMING, not a mismatch", () => {
			const r = compareRun({
				cands: c,
				hold: null,
				asOfStart: NOW,
				actual: [
					{ id: 3, tier: "initial", at: at(30_000) },
					{ id: 7, tier: "fu1", at: at(32_000) },
				],
			});
			expect(r.status).toBe("MATCH_WITH_TIMING");
			expect(r.matchedAsOf).toBe(
				new Date(NOW.getTime() + 20_000).toISOString(),
			);
		});
		test("a lead that crosses the line long after Python started can NOT explain a send", () => {
			const late = buildCandidates(
				[initialRow(3), followRow(7, 7, { "Sent At": daysAgo(7, -3_600_000) })],
				noHolds,
			);
			const r = compareRun({
				cands: late,
				hold: null,
				asOfStart: NOW,
				actual: [
					{ id: 3, tier: "initial", at: at(5_000) },
					{ id: 7, tier: "fu1", at: at(7_000) },
				],
			});
			expect(r.status).toBe("MISMATCH");
		});
		test("the alternative clock must reproduce the WHOLE batch, not part of it", () => {
			const r = compareRun({
				cands: c,
				hold: null,
				asOfStart: NOW,
				actual: [
					{ id: 3, tier: "initial", at: at(30_000) },
					{ id: 7, tier: "fu1", at: at(32_000) },
					{ id: 8, tier: "fu1", at: at(34_000) },
				],
			});
			expect(r.status).toBe("MISMATCH");
		});
		test("breakpoints lists each crossing inside the window only", () => {
			expect(breakpoints(c, NOW, at(60_000))).toHaveLength(1);
			expect(breakpoints(c, NOW, at(10_000))).toHaveLength(0);
		});
	});

	describe("when the CRM holds (fail-closed interlock)", () => {
		const hold = { kind: "STOP_SCAN_STALE" as const, detail: "stale" };
		test("both held: match", () => {
			expect(
				compareRun({ cands: [], hold, asOfStart: NOW, actual: [] }).status,
			).toBe("MATCH");
		});
		test("CRM held but Python sent: mismatch, with the reason", () => {
			const r = compareRun({
				cands,
				hold,
				asOfStart: NOW,
				actual: sends([[3, "initial"]]),
			});
			expect(r.status).toBe("MISMATCH");
			expect(r.note).toContain("CRM held");
			expect(r.pythonOnly).toHaveLength(1);
		});
	});

	test("nothing planned and nothing sent is a match", () => {
		expect(
			compareRun({ cands: [], hold: null, asOfStart: NOW, actual: [] }).status,
		).toBe("MATCH");
	});
});

describe("match streak", () => {
	test("counts consecutive recent matches, newest first, and stops at the first miss", () => {
		expect(
			matchStreak(["MATCH", "MATCH_WITH_TIMING", "MISMATCH", "MATCH"]),
		).toBe(2);
		expect(matchStreak(["MISMATCH", "MATCH"])).toBe(0);
		expect(matchStreak([null, "MATCH"])).toBe(0);
		expect(matchStreak([])).toBe(0);
	});
});
