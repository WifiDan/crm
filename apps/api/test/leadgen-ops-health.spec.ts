import { describe, expect, test } from "bun:test";
import {
	countCompanyMap,
	countQueueLines,
	parseHealthState,
	parseStandingTasks,
	parseSystemctlShow,
	parseUnitNames,
	parseUnixStamp,
} from "../src/leadgen/ops-health";

const LIST = `leadgen-daily-send.service       loaded inactive dead    EI Local Lead Gen - daily outreach sender
leadgen-review-server.service    loaded active   running EI Local Lead Gen - review dashboard server
leadgen-daily-send.timer         loaded active   waiting Run daily sender at 08:30
crm-api.service                  loaded active   running Comp AI CRM - API
garbage line without a unit
`;

const SHOW = `Id=leadgen-daily-send.service
Description=EI Local Lead Gen - daily outreach sender
ActiveState=inactive
SubState=dead
Result=success
ExecMainStatus=0
ExecMainExitTimestamp=@1789914670
LastTriggerUSec=
NextElapseUSecRealtime=

Id=leadgen-daily-send.timer
Description=Run daily sender at 08:30
ActiveState=active
SubState=waiting
Result=success
ExecMainStatus=0
ExecMainExitTimestamp=
LastTriggerUSec=@1789914652
NextElapseUSecRealtime=@1790001000

Id=leadgen-review-server.service
Description=review
ActiveState=failed
SubState=failed
Result=exit-code
ExecMainStatus=1
ExecMainExitTimestamp=@1789914000
LastTriggerUSec=
NextElapseUSecRealtime=
`;

describe("systemd parsing", () => {
	test("unit names come from the first column and are de-duplicated and sorted", () => {
		expect(parseUnitNames(`${LIST}${LIST}`)).toEqual([
			"crm-api.service",
			"leadgen-daily-send.service",
			"leadgen-daily-send.timer",
			"leadgen-review-server.service",
		]);
	});

	test("unix stamps parse and empty or zero stamps are null", () => {
		expect(parseUnixStamp("@1789914670")).toBe("2026-09-20T14:31:10.000Z");
		expect(parseUnixStamp("")).toBeNull();
		expect(parseUnixStamp("@0")).toBeNull();
		expect(parseUnixStamp("n/a")).toBeNull();
		expect(parseUnixStamp(undefined)).toBeNull();
	});

	test("show blocks become units with the right kind and times", () => {
		const units = parseSystemctlShow(SHOW);
		expect(units.map((u) => u.name)).toEqual([
			"leadgen-daily-send.service",
			"leadgen-daily-send.timer",
			"leadgen-review-server.service",
		]);
		expect(units[0]).toMatchObject({
			kind: "service",
			activeState: "inactive",
			result: "success",
			exitStatus: 0,
			lastExitAt: "2026-09-20T14:31:10.000Z",
			nextRunAt: null,
		});
		expect(units[1]).toMatchObject({
			kind: "timer",
			nextRunAt: "2026-09-21T14:30:00.000Z",
			lastTriggerAt: "2026-09-20T14:30:52.000Z",
		});
		expect(units[2]).toMatchObject({ activeState: "failed", exitStatus: 1 });
	});

	test("junk and empty output give no units and do not throw", () => {
		expect(parseSystemctlShow("")).toEqual([]);
		expect(parseSystemctlShow("not key value\n\nalso not")).toEqual([]);
	});
});

describe("health-state.json", () => {
	const raw = JSON.stringify({
		"daily send ran": {
			ok: true,
			detail: "last run 11h ago",
			since: 1789791963.25,
			paged: 0,
		},
		"NocoDB token": { ok: false, detail: "rejected", since: 1789945639.3 },
		disk: { ok: true },
	});

	test("failing checks sort first and times are ISO", () => {
		const items = parseHealthState(raw);
		expect(items[0]?.name).toBe("NocoDB token");
		expect(items[0]?.ok).toBe(false);
		expect(items.find((i) => i.name === "disk")?.since).toBeNull();
		expect(items.find((i) => i.name === "disk")?.detail).toBe("");
	});

	test("a file of the wrong shape is an error, not an empty list", () => {
		expect(() => parseHealthState("[]")).toThrow();
		expect(() =>
			parseHealthState(JSON.stringify({ a: { detail: "x" } })),
		).toThrow();
		expect(() => parseHealthState("not json")).toThrow();
	});
});

describe("standing tasks and CRM sync files", () => {
	test("standing tasks parse and keep the order", () => {
		const raw = JSON.stringify({
			_comment: "ignored",
			items: [
				{ id: "a", text: "First", since: "2026-07-18" },
				{ id: "b", text: "Second" },
			],
		});
		expect(parseStandingTasks(raw)).toEqual([
			{ id: "a", text: "First", since: "2026-07-18" },
			{ id: "b", text: "Second", since: null },
		]);
	});

	test("a standing tasks file without items is an error", () => {
		expect(() => parseStandingTasks("{}")).toThrow();
	});

	test("company map counts its keys and refuses an array", () => {
		expect(countCompanyMap(JSON.stringify({ a: 1, b: 2, c: 3 }))).toBe(3);
		expect(() => countCompanyMap("[1,2]")).toThrow();
	});

	test("deal queue counts non-empty lines", () => {
		expect(countQueueLines("")).toBe(0);
		expect(countQueueLines('{"a":1}\n\n{"b":2}\n')).toBe(2);
	});
});
