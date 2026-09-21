import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
	armingBlockers,
	armsSending,
	buildDecisionPatch,
	buildReworkPatch,
	DECISIONS,
	flagOf,
	isDecisionApprover,
	type LeadPatch,
	POOLS,
	type Pool,
	poolOfTable,
	readDecisionPolicy,
	STAGES,
	staleFields,
	statusBlockers,
	verifyPatch,
} from "../src/leadgen/lead-decision.rules";
import { MIRROR_TABLES } from "../src/leadgen/mirror-map";

const NOW = new Date("2026-09-20T15:04:05.678Z");
const emptyState = {
	replied: { ok: true, ids: new Set<number>(), addrs: new Set<string>() },
	openStops: { addrs: new Set<string>(), domains: new Set<string>() },
};

const stageOf = (s: string | undefined) =>
	s === "review" ? "review" : "triage";

describe("Send Approved matrix (frozen from the old apiDecision)", () => {
	const expected = (
		pool: Pool,
		stage: string | undefined,
		decision: string,
	) => {
		const base: LeadPatch = {
			Id: 42,
			"Approval Decision": decision,
			"Decision Date": "2026-09-20",
		};
		if (pool === "gym") return base;
		return {
			...base,
			"Send Approved": stage === "review" && decision === "Approved",
		};
	};
	for (const pool of ["isp", "gym"] as const) {
		for (const stage of ["review", "triage"] as const) {
			for (const decision of DECISIONS) {
				test(`${pool} ${stage} ${decision}`, () => {
					expect(
						buildDecisionPatch({
							rowId: 42,
							pool: POOLS[pool],
							stage,
							decision,
							now: NOW,
						}),
					).toEqual(expected(pool, stage, decision));
				});
			}
		}
	}

	test("only review + Approved on the ISP pool arms sending", () => {
		const arming: string[] = [];
		for (const pool of ["isp", "gym"] as const)
			for (const stage of STAGES)
				for (const decision of DECISIONS)
					if (armsSending(POOLS[pool], stage, decision))
						arming.push(`${pool}/${stage}/${decision}`);
		expect(arming).toEqual(["isp/review/Approved"]);
	});

	test("the gym patch never carries a Send Approved key", () => {
		for (const stage of STAGES)
			for (const decision of DECISIONS)
				expect(
					"Send Approved" in
						buildDecisionPatch({
							rowId: 1,
							pool: POOLS.gym,
							stage,
							decision,
							now: NOW,
						}),
				).toBe(false);
	});
});

describe("pools", () => {
	test("table ids come from the mirror config", () => {
		for (const t of MIRROR_TABLES) {
			expect(POOLS[t.key].tableId).toBe(t.tableId);
			expect(poolOfTable(t.tableId)?.pool).toBe(t.key);
		}
		expect(poolOfTable("nope")).toBeNull();
		expect(poolOfTable(null)).toBeNull();
	});
});

describe("rework patch", () => {
	test("sets the request, clears the decision and the send flag", () => {
		const out = buildReworkPatch({
			rowId: 7,
			pool: POOLS.isp,
			notes: "  fix the hero  ",
			now: NOW,
		});
		expect(out).toEqual({
			ok: true,
			patch: {
				Id: 7,
				"Rework Requested": "2026-09-20T15:04:05.678Z",
				"Rework Notes": "fix the hero",
				"Approval Decision": null,
				"Send Approved": false,
			},
		});
	});
	test("notes are required and the gym pool has no rework", () => {
		for (const notes of ["", "   ", "\n\t"])
			expect(
				buildReworkPatch({ rowId: 7, pool: POOLS.isp, notes, now: NOW }).ok,
			).toBe(false);
		expect(
			buildReworkPatch({ rowId: 7, pool: POOLS.gym, notes: "x", now: NOW }).ok,
		).toBe(false);
	});
});

describe("decision policy", () => {
	test("unset, empty and separators-only refuse everyone", () => {
		for (const v of [undefined, "", "  ", ",", " , ,"]) {
			const policy = readDecisionPolicy({ LEADGEN_DECISION_APPROVERS: v });
			expect(policy.approvers).toEqual([]);
			expect(isDecisionApprover("danio@wifielite.com", policy)).toBe(false);
		}
	});
	test("does not fall back to the reply approvers", () => {
		const policy = readDecisionPolicy({
			LEADGEN_REPLY_APPROVERS: "danio@wifielite.com",
		});
		expect(isDecisionApprover("danio@wifielite.com", policy)).toBe(false);
	});
	test("matches case-insensitively and trims", () => {
		const policy = readDecisionPolicy({
			LEADGEN_DECISION_APPROVERS: " Danio@WifiElite.com , b@c.co ",
		});
		expect(isDecisionApprover("DANIO@wifielite.com", policy)).toBe(true);
		expect(isDecisionApprover("x@y.co", policy)).toBe(false);
		expect(isDecisionApprover(null, policy)).toBe(false);
	});
});

describe("version check", () => {
	const live = {
		UpdatedAt: "2026-09-20 14:31:07+00:00",
		"Approval Decision": "Approved",
		"Decision Date": "2026-09-07",
	};
	const seen = {
		updatedAt: "2026-09-20 14:31:07+00:00",
		decision: "Approved",
		decisionDate: "2026-09-07",
	};
	test("identical is fresh", () => {
		expect(staleFields(seen, live)).toEqual([]);
	});
	test("each field is checked alone", () => {
		expect(
			staleFields({ ...seen, updatedAt: "2026-09-20 14:31:08+00:00" }, live),
		).toEqual(["last change time"]);
		expect(staleFields({ ...seen, decision: null }, live)).toEqual([
			"decision",
		]);
		expect(staleFields({ ...seen, decisionDate: null }, live)).toEqual([
			"decision date",
		]);
	});
	test("an empty seen version is never fresh", () => {
		expect(staleFields({ ...seen, updatedAt: "" }, live)).toContain(
			"last change time",
		);
		expect(
			staleFields({ ...seen, updatedAt: "  " }, { ...live, UpdatedAt: "" }),
		).toContain("last change time");
	});
});

describe("status blockers", () => {
	test("Do Not Contact blocks every decision", () => {
		for (const decision of [...DECISIONS, null])
			expect(
				statusBlockers({ decision, live: { "Do Not Contact": 1 } }),
			).toHaveLength(1);
	});
	test("Sent At blocks only an Approve", () => {
		const live = { "Sent At": "2026-09-01 14:30:00+00:00" };
		expect(statusBlockers({ decision: "Approved", live })).toHaveLength(1);
		expect(statusBlockers({ decision: "Rejected", live })).toEqual([]);
		expect(statusBlockers({ decision: "Needs Changes", live })).toEqual([]);
		expect(statusBlockers({ decision: null, live })).toEqual([]);
	});
});

describe("arming blockers reuse the sender's own rules", () => {
	const ok = {
		Id: 42,
		Email: "owner@biz.com",
		"Draft Email Subject": "Hi",
		"Draft Email Body": "Body",
	};
	test("a complete lead passes", () => {
		expect(armingBlockers(ok, { mailed: [], state: emptyState })).toEqual([]);
	});
	const cases: Array<[string, Record<string, unknown>, RegExp]> = [
		["no email", { Email: "" }, /no email/],
		["no draft subject", { "Draft Email Subject": "" }, /empty/],
		["no draft body", { "Draft Email Body": null }, /empty/],
		["placeholder", { "Draft Email Body": "Hi {{name}}" }, /placeholder/],
		[
			"sent already",
			{ "Sent At": "2026-09-01 14:30:00+00:00" },
			/would not send/,
		],
		["do not contact", { "Do Not Contact": 1 }, /would not send/],
	];
	for (const [name, patch, re] of cases) {
		test(`blocks: ${name}`, () => {
			const out = armingBlockers(
				{ ...ok, ...patch },
				{ mailed: [], state: emptyState },
			);
			expect(out.length).toBeGreaterThan(0);
			expect(out.join(" ")).toMatch(re);
		});
	}
	test("blocks a lead whose address was already mailed", () => {
		const out = armingBlockers(ok, {
			mailed: [
				{
					Id: 9,
					Email: "OWNER@biz.com",
					"Sent At": "2026-09-01 14:30:00+00:00",
				},
			],
			state: emptyState,
		});
		expect(out.join(" ")).toMatch(/already mailed/);
	});
	test("blocks a replied lead by id and by address", () => {
		const byId = {
			...emptyState,
			replied: { ok: true, ids: new Set([42]), addrs: new Set<string>() },
		};
		const byAddr = {
			...emptyState,
			replied: {
				ok: true,
				ids: new Set<number>(),
				addrs: new Set(["owner@biz.com"]),
			},
		};
		expect(armingBlockers(ok, { mailed: [], state: byId })).not.toEqual([]);
		expect(armingBlockers(ok, { mailed: [], state: byAddr })).not.toEqual([]);
	});
	test("blocks an open STOP hold by address and by company domain", () => {
		const addr = {
			...emptyState,
			openStops: {
				addrs: new Set(["owner@biz.com"]),
				domains: new Set<string>(),
			},
		};
		const dom = {
			...emptyState,
			openStops: { addrs: new Set<string>(), domains: new Set(["biz.com"]) },
		};
		expect(armingBlockers(ok, { mailed: [], state: addr })).not.toEqual([]);
		expect(armingBlockers(ok, { mailed: [], state: dom })).not.toEqual([]);
	});
});

describe("read-back verification", () => {
	const patch: LeadPatch = {
		Id: 1,
		"Approval Decision": "Approved",
		"Decision Date": "2026-09-20",
		"Send Approved": true,
	};
	test("accepts NocoDB's number flag", () => {
		expect(
			verifyPatch(patch, {
				"Approval Decision": "Approved",
				"Decision Date": "2026-09-20",
				"Send Approved": 1,
			}),
		).toEqual([]);
	});
	test("names every field NocoDB did not keep", () => {
		expect(
			verifyPatch(patch, {
				"Approval Decision": "Approved",
				"Decision Date": "2026-09-19",
				"Send Approved": 0,
			}),
		).toEqual(["Decision Date", "Send Approved"]);
	});
	test("a missing column reads back as absent, so a true flag fails", () => {
		expect(verifyPatch({ Id: 1, "Send Approved": true }, { Id: 1 })).toEqual([
			"Send Approved",
		]);
	});
	test("null clears, rework time tolerates NocoDB's format", () => {
		const rework: LeadPatch = {
			Id: 1,
			"Rework Requested": "2026-09-20T15:04:05.678Z",
			"Approval Decision": null,
			"Send Approved": false,
		};
		expect(
			verifyPatch(rework, {
				"Rework Requested": "2026-09-20 15:04:05+00:00",
				"Approval Decision": null,
				"Send Approved": 0,
			}),
		).toEqual([]);
		expect(
			verifyPatch(rework, {
				"Rework Requested": "2026-09-20 15:04:05+00:00",
				"Approval Decision": "Approved",
				"Send Approved": 0,
			}),
		).toEqual(["Approval Decision"]);
	});
	test("flag reader", () => {
		expect([true, 1, "1", "true"].every(flagOf)).toBe(true);
		expect([false, 0, "0", null, undefined, "false", ""].some(flagOf)).toBe(
			false,
		);
	});
});

const OLD =
	process.env.LEADGEN_OLD_REVIEW_SERVER ??
	"/data/leadgen/approval-queue/review-server.js";

type Outcome = {
	status: number;
	body: unknown;
	patch: LeadPatch | null;
	patches: number;
};

function loadOld(hasColumn: boolean) {
	const src = readFileSync(OLD, "utf8");
	const sourcesFrom = src.indexOf("const SOURCES = {");
	const sourcesTo = src.indexOf("const TYPES =");
	const logicFrom = src.indexOf("const sendColCache");
	const logicTo = src.indexOf("http.createServer(");
	if ([sourcesFrom, sourcesTo, logicFrom, logicTo].some((i) => i < 0))
		throw new Error("could not locate the old apiDecision source");
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	const fakeFetch = async (
		url: string,
		opts?: { method?: string; body?: string },
	) => {
		const method = opts?.method ?? "GET";
		calls.push({ url, method, body: opts?.body ?? null });
		if (method === "GET")
			return {
				ok: true,
				json: async () => ({
					columns: hasColumn ? [{ title: "Send Approved" }] : [{ title: "Id" }],
				}),
			};
		return { ok: true, status: 200, text: async () => "" };
	};
	class FixedDate extends Date {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(NOW.getTime());
			else super(...(args as [string]));
		}
	}
	let resolveDone: (o: { code: number; obj: unknown }) => void = () => {};
	const done = () =>
		new Promise<{ code: number; obj: unknown }>((r) => {
			resolveDone = r;
		});
	const sandbox: Record<string, unknown> = {
		fetch: fakeFetch,
		getHeaders: () => ({}),
		json: (_res: unknown, code: number, obj: unknown) =>
			resolveDone({ code, obj }),
		JSON,
		Date: FixedDate,
		console,
	};
	runInNewContext(
		`${src.slice(sourcesFrom, sourcesTo)}\n${src.slice(logicFrom, logicTo)}\nthis.apiDecision = apiDecision; this.apiRework = apiRework;`,
		sandbox,
	);
	const call = async (
		fn: "apiDecision" | "apiRework",
		payload: unknown,
	): Promise<Outcome> => {
		calls.length = 0;
		const finished = done();
		const handlers: Record<string, (chunk?: string) => void> = {};
		const req = {
			on: (evt: string, cb: (chunk?: string) => void) => {
				handlers[evt] = cb;
			},
		};
		(sandbox[fn] as (req: unknown, res: unknown) => unknown)(req, {});
		handlers.data?.(
			typeof payload === "string" ? payload : JSON.stringify(payload),
		);
		handlers.end?.();
		const out = await finished;
		const patchCall = calls.find((c) => c.method === "PATCH");
		return {
			status: out.code,
			body: out.obj,
			patch: patchCall?.body ? (JSON.parse(patchCall.body) as LeadPatch) : null,
			patches: calls.filter((c) => c.method === "PATCH").length,
		};
	};
	return { call, sandbox };
}

const haveOld = existsSync(OLD);

describe.skipIf(!haveOld)(
	"equivalence with the real old review-server.js",
	() => {
		test("the old functions were extracted (the harness can fail)", () => {
			const { sandbox } = loadOld(true);
			expect(typeof sandbox.apiDecision).toBe("function");
			expect(typeof sandbox.apiRework).toBe("function");
		});

		test("the harness sees a PATCH: an ISP review approval sends Send Approved true", async () => {
			const { call } = loadOld(true);
			const out = await call("apiDecision", {
				id: 42,
				decision: "Approved",
				stage: "review",
				table: "isp",
			});
			expect(out.status).toBe(200);
			expect(out.patch).toEqual({
				Id: 42,
				"Approval Decision": "Approved",
				"Decision Date": "2026-09-20",
				"Send Approved": true,
			});
		});

		for (const pool of ["isp", "gym"] as const) {
			for (const stage of ["review", "triage", undefined] as const) {
				for (const decision of DECISIONS) {
					test(`decision patch: ${pool} ${stage ?? "no stage"} ${decision}`, async () => {
						const { call } = loadOld(true);
						const old = await call("apiDecision", {
							id: 42,
							decision,
							stage,
							table: pool,
						});
						expect(old.status).toBe(200);
						expect(old.patches).toBe(1);
						const mine = buildDecisionPatch({
							rowId: 42,
							pool: POOLS[pool],
							stage: stageOf(stage),
							decision,
							now: NOW,
						});
						const oldPatch = old.patch ?? {};
						if (pool === "isp" && stage !== "review") {
							expect(mine).toEqual({ ...oldPatch, "Send Approved": false });
							expect("Send Approved" in oldPatch).toBe(false);
						} else {
							expect(mine).toEqual(oldPatch);
						}
					});
				}
			}
		}

		test("old code refuses an ISP review decision when the column is missing (503) and writes nothing", async () => {
			const { call } = loadOld(false);
			const out = await call("apiDecision", {
				id: 42,
				decision: "Approved",
				stage: "review",
				table: "isp",
			});
			expect(out.status).toBe(503);
			expect(out.patches).toBe(0);
		});

		test("old gym review approval writes no Send Approved key and needs no column", async () => {
			const { call } = loadOld(false);
			const out = await call("apiDecision", {
				id: 5,
				decision: "Approved",
				stage: "review",
				table: "gym",
			});
			expect(out.status).toBe(200);
			expect(out.patch).toEqual({
				Id: 5,
				"Approval Decision": "Approved",
				"Decision Date": "2026-09-20",
			});
		});

		for (const notes of ["  fix the hero  ", "plain"]) {
			test(`rework patch: isp notes ${JSON.stringify(notes)}`, async () => {
				const { call } = loadOld(true);
				const old = await call("apiRework", { id: 7, notes, table: "isp" });
				expect(old.status).toBe(200);
				const built = buildReworkPatch({
					rowId: 7,
					pool: POOLS.isp,
					notes,
					now: NOW,
				});
				expect(built.ok).toBe(true);
				expect(built.ok && built.patch).toEqual(old.patch ?? {});
			});
		}

		test("rework refusals match: gym, empty notes, whitespace notes", async () => {
			const { call } = loadOld(true);
			for (const [table, notes] of [
				["gym", "x"],
				["isp", ""],
				["isp", "   "],
			] as const) {
				const old = await call("apiRework", { id: 7, notes, table });
				expect(old.status).toBe(400);
				expect(old.patches).toBe(0);
				expect(
					buildReworkPatch({ rowId: 7, pool: POOLS[table], notes, now: NOW })
						.ok,
				).toBe(false);
			}
		});
	},
);
