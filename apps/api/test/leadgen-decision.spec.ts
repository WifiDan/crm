import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@crm/db";
import {
	BadGatewayException,
	BadRequestException,
	ConflictException,
	ForbiddenException,
	InternalServerErrorException,
	ServiceUnavailableException,
} from "@nestjs/common";
import {
	DECISIONS,
	type LeadPatch,
	type LiveRow,
	POOLS,
	STAGES,
} from "../src/leadgen/lead-decision.rules";
import {
	type DecideInput,
	LeadDecisionService,
	type ReworkInput,
} from "../src/leadgen/lead-decision.service";
import {
	type ColumnState,
	type LeadRowStore,
	NocoWriteError,
	type WriteConfig,
} from "../src/leadgen/lead-decision.store";

const ISP = POOLS.isp.tableId;
const GYM = POOLS.gym.tableId;
const NOW = new Date("2026-09-20T15:04:05.678Z");
const START = "2026-09-20 14:31:07+00:00";
const DANIO = { id: "user-1", email: "danio@wifielite.com" };

type Row = Record<string, unknown>;

const eligibleRow = (over: Row = {}): LiveRow => ({
	Id: 42,
	UpdatedAt: START,
	"Approval Decision": null,
	"Decision Date": null,
	Email: "owner@biz.com",
	"Draft Email Subject": "Hello",
	"Draft Email Body": "Body text",
	"Sent At": null,
	"Do Not Contact": 0,
	"Send Approved": 0,
	...over,
});

const seenOf = (row: LiveRow) => ({
	updatedAt: String(row.UpdatedAt),
	decision: (row["Approval Decision"] as string | null) ?? null,
	decisionDate: (row["Decision Date"] as string | null) ?? null,
});

type WorldOptions = {
	table?: string;
	row?: LiveRow | null;
	column?: ColumnState;
	config?: WriteConfig;
	mailed?: Row[];
	replied?: number[];
	dropFields?: string[];
	patchError?: Error;
	readBackFails?: boolean;
	seedAudit?: Row[];
	auditCreateFails?: boolean;
};

function makeWorld(opts: WorldOptions = {}) {
	const table = opts.table ?? ISP;
	let live: LiveRow | null = opts.row === undefined ? eligibleRow() : opts.row;
	const audit: Row[] = [...(opts.seedAudit ?? [])];
	const patches: Array<{ tableId: string; patch: LeadPatch }> = [];
	const auditAtPatch: Row[][] = [];
	const reads: string[] = [];
	const columnChecks: string[] = [];
	const writes: string[] = [];
	let counter = 0;
	let readsAfterPatch = 0;
	let patched = false;

	const store: LeadRowStore = {
		writeConfig: () =>
			opts.config ?? { ok: true, source: "shared-with-mirror" },
		getRow: async (tableId, rowId) => {
			reads.push(`${tableId}/${rowId}`);
			if (patched) {
				readsAfterPatch++;
				if (opts.readBackFails) throw new Error("boom");
			}
			return live ? { ...live } : null;
		},
		columnState: async (tableId) => {
			columnChecks.push(tableId);
			return opts.column ?? "present";
		},
		patchRow: async (tableId, patch) => {
			auditAtPatch.push(audit.map((a) => ({ ...a })));
			patches.push({ tableId, patch });
			if (opts.patchError) throw opts.patchError;
			patched = true;
			if (live) {
				const next: LiveRow = { ...live };
				for (const [k, v] of Object.entries(patch)) {
					if (k === "Id" || opts.dropFields?.includes(k)) continue;
					next[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
				}
				next.UpdatedAt = "2026-09-20 15:04:06+00:00";
				live = next;
			}
		},
	};

	const guarded = (name: string) =>
		new Proxy(
			{},
			{
				get: (_t, method: string) => {
					if (
						/^(update|updateMany|create|createMany|upsert|delete|deleteMany)$/.test(
							method,
						)
					)
						return async () => {
							writes.push(`${name}.${method}`);
							throw new Error(`${name}.${method} must not be called`);
						};
					if (method === "findFirst")
						return async () => ({
							id: "lead-1",
							nocodbTable: table,
							nocodbRowId: 42,
						});
					if (method === "findMany")
						return async () => (opts.mailed ?? []).map((raw) => ({ raw }));
					return undefined;
				},
			},
		);

	const db = {
		lgLead: guarded("lgLead"),
		lgLeadDecision: {
			findUnique: async ({ where }: { where: { requestId: string } }) =>
				audit.find((a) => a.requestId === where.requestId) ?? null,
			findFirst: async ({
				where,
			}: {
				where: { leadId: string; status: string; createdAt: { gte: Date } };
			}) =>
				audit.find(
					(a) =>
						a.leadId === where.leadId &&
						a.status === where.status &&
						(a.createdAt as Date) >= where.createdAt.gte,
				) ?? null,
			create: async ({ data }: { data: Row }) => {
				if (opts.auditCreateFails) throw new Error("db down");
				if (audit.some((a) => a.requestId === data.requestId))
					throw Object.assign(new Error("unique"), { code: "P2002" });
				const row = { id: `a${++counter}`, createdAt: NOW, ...data };
				audit.push(row);
				return row;
			},
			update: async ({ where, data }: { where: { id: string }; data: Row }) => {
				const row = audit.find((a) => a.id === where.id);
				if (!row) throw new Error("no audit row");
				for (const [k, v] of Object.entries(data))
					if (v !== undefined) row[k] = v;
				return row;
			},
		},
	} as unknown as Db;

	const service = new LeadDecisionService(
		db,
		store,
		async () => ({
			replied: {
				ok: true,
				ids: new Set(opts.replied ?? []),
				addrs: new Set<string>(),
			},
			openStops: { addrs: new Set<string>(), domains: new Set<string>() },
		}),
		() => NOW,
	);
	return {
		service,
		audit,
		patches,
		auditAtPatch,
		reads,
		columnChecks,
		writes,
		get live() {
			return live;
		},
		get readsAfterPatch() {
			return readsAfterPatch;
		},
	};
}

let counter = 0;
const rid = () =>
	`00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const decide = (
	world: ReturnType<typeof makeWorld>,
	over: Partial<DecideInput> = {},
): Promise<unknown> =>
	world.service.decide({
		leadId: "lead-1",
		requestId: rid(),
		stage: "review",
		decision: "Approved",
		seen: seenOf(eligibleRow()),
		confirmArm: true,
		actor: DANIO,
		...over,
	});

const rework = (
	world: ReturnType<typeof makeWorld>,
	over: Partial<ReworkInput> = {},
): Promise<unknown> =>
	world.service.rework({
		leadId: "lead-1",
		requestId: rid(),
		notes: "hero is too dark",
		seen: seenOf(eligibleRow()),
		actor: DANIO,
		...over,
	});

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	saved.a = process.env.LEADGEN_DECISION_APPROVERS;
	process.env.LEADGEN_DECISION_APPROVERS = "danio@wifielite.com";
});
afterEach(() => {
	if (saved.a === undefined) delete process.env.LEADGEN_DECISION_APPROVERS;
	else process.env.LEADGEN_DECISION_APPROVERS = saved.a;
});

const untouched = (w: ReturnType<typeof makeWorld>) => {
	expect(w.patches).toHaveLength(0);
	expect(w.audit).toHaveLength(0);
	expect(w.writes).toEqual([]);
};

describe("Send Approved through the service (stage x decision x pool)", () => {
	for (const pool of ["isp", "gym"] as const) {
		for (const stage of STAGES) {
			for (const decision of DECISIONS) {
				test(`${pool} ${stage} ${decision}`, async () => {
					const w = makeWorld({ table: POOLS[pool].tableId });
					await decide(w, { stage, decision });
					expect(w.patches).toHaveLength(1);
					const sent = w.patches[0]?.patch ?? {};
					if (pool === "gym") expect("Send Approved" in sent).toBe(false);
					else
						expect(sent["Send Approved"]).toBe(
							stage === "review" && decision === "Approved",
						);
					expect(w.patches[0]?.tableId).toBe(POOLS[pool].tableId);
				});
			}
		}
	}

	test("the result comes from the NocoDB read-back", async () => {
		const w = makeWorld();
		const out = (await decide(w)) as Record<string, unknown>;
		expect(out).toMatchObject({
			replay: false,
			leadId: "lead-1",
			action: "DECISION",
			decision: "Approved",
			sendApproved: true,
			decisionDate: "2026-09-20",
			version: "2026-09-20 15:04:06+00:00",
			reworkRequested: false,
		});
		expect(w.readsAfterPatch).toBe(1);
	});

	test("the gym result carries no send flag", async () => {
		const w = makeWorld({ table: GYM });
		const out = (await decide(w)) as Record<string, unknown>;
		expect(out.sendApproved).toBeNull();
		expect(w.columnChecks).toEqual([]);
	});

	test("the lg_lead mirror is never written", async () => {
		const w = makeWorld();
		await decide(w);
		await rework(w, { seen: seenOf(w.live ?? {}) });
		expect(w.writes).toEqual([]);
	});
});

describe("confirmation for the arming approval", () => {
	test("review Approve on ISP without confirmArm is refused before anything is read", async () => {
		const w = makeWorld();
		await expect(decide(w, { confirmArm: false })).rejects.toBeInstanceOf(
			BadRequestException,
		);
		untouched(w);
		expect(w.reads).toEqual([]);
	});
	test("the other decisions do not need it", async () => {
		for (const [stage, decision] of [
			["review", "Rejected"],
			["review", "Needs Changes"],
			["triage", "Approved"],
		] as const) {
			const w = makeWorld();
			await decide(w, { stage, decision, confirmArm: false });
			expect(w.patches).toHaveLength(1);
		}
	});
	test("gym review Approve arms nothing, so it needs no confirmation", async () => {
		const w = makeWorld({ table: GYM });
		await decide(w, { confirmArm: false });
		expect(w.patches).toHaveLength(1);
	});
});

describe("fails closed when the Send Approved column is not confirmed", () => {
	for (const state of ["absent", "unknown"] as const) {
		test(`column ${state}: 503, no PATCH, no audit row`, async () => {
			const w = makeWorld({ column: state });
			await expect(decide(w)).rejects.toBeInstanceOf(
				ServiceUnavailableException,
			);
			untouched(w);
		});
		test(`column ${state}: even a Reject is refused, since a stale true could not be cleared`, async () => {
			const w = makeWorld({ column: state });
			await expect(decide(w, { decision: "Rejected" })).rejects.toBeInstanceOf(
				ServiceUnavailableException,
			);
			untouched(w);
		});
		test(`column ${state}: rework is refused`, async () => {
			const w = makeWorld({ column: state });
			await expect(rework(w)).rejects.toBeInstanceOf(
				ServiceUnavailableException,
			);
			untouched(w);
		});
	}
	test("the missing-column message names the column", async () => {
		const w = makeWorld({ column: "absent" });
		await expect(decide(w)).rejects.toThrow(/Send Approved/);
	});
});

describe("stale page", () => {
	const cases: Array<[string, Row]> = [
		["changed time", { updatedAt: "2026-09-20 14:31:00+00:00" }],
		["someone decided since", { decision: "Rejected" }],
		["decision date moved", { decisionDate: "2026-09-19" }],
		["empty version", { updatedAt: "" }],
	];
	for (const [name, over] of cases) {
		test(`409, no PATCH, no audit: ${name}`, async () => {
			const w = makeWorld();
			await expect(
				decide(w, {
					seen: { ...seenOf(eligibleRow()), ...over } as DecideInput["seen"],
				}),
			).rejects.toBeInstanceOf(ConflictException);
			untouched(w);
		});
	}
	test("rework is version checked too", async () => {
		const w = makeWorld();
		await expect(
			rework(w, { seen: { ...seenOf(eligibleRow()), updatedAt: "old" } }),
		).rejects.toBeInstanceOf(ConflictException);
		untouched(w);
	});
	test("a lead that vanished from NocoDB is a 409", async () => {
		const w = makeWorld({ row: null });
		await expect(decide(w)).rejects.toBeInstanceOf(ConflictException);
		untouched(w);
	});
});

describe("blocked leads", () => {
	test("Do Not Contact: every decision and rework is refused", async () => {
		const row = eligibleRow({ "Do Not Contact": 1 });
		for (const decision of DECISIONS)
			for (const stage of STAGES) {
				const w = makeWorld({ row });
				await expect(
					decide(w, { stage, decision, seen: seenOf(row) }),
				).rejects.toBeInstanceOf(ConflictException);
				untouched(w);
			}
		const w = makeWorld({ row });
		await expect(rework(w, { seen: seenOf(row) })).rejects.toBeInstanceOf(
			ConflictException,
		);
		untouched(w);
	});
	test("already sent: Approve refused at both stages, Reject still allowed", async () => {
		const row = eligibleRow({ "Sent At": "2026-09-09 14:30:00+00:00" });
		for (const stage of STAGES) {
			const w = makeWorld({ row });
			await expect(
				decide(w, { stage, seen: seenOf(row) }),
			).rejects.toBeInstanceOf(ConflictException);
			untouched(w);
		}
		const w = makeWorld({ row });
		await decide(w, { decision: "Rejected", seen: seenOf(row) });
		expect(w.patches).toHaveLength(1);
	});
});

describe("review Approve must pass the sender's eligibility rules", () => {
	const blockedRows: Array<[string, Row]> = [
		["no email", { Email: "" }],
		["no draft subject", { "Draft Email Subject": "" }],
		["no draft body", { "Draft Email Body": "" }],
		["placeholder in draft", { "Draft Email Body": "Hi {{first_name}}" }],
	];
	for (const [name, over] of blockedRows) {
		test(`refused: ${name}`, async () => {
			const row = eligibleRow(over);
			const w = makeWorld({ row });
			await expect(decide(w, { seen: seenOf(row) })).rejects.toBeInstanceOf(
				ConflictException,
			);
			untouched(w);
		});
	}
	test("refused: the address was already mailed under another lead", async () => {
		const w = makeWorld({
			mailed: [
				{
					Id: 9,
					Email: "Owner@Biz.com",
					"Sent At": "2026-09-01 14:30:00+00:00",
				},
			],
		});
		await expect(decide(w)).rejects.toThrow(/already mailed/);
		untouched(w);
	});
	test("refused: the lead replied", async () => {
		const w = makeWorld({ replied: [42] });
		await expect(decide(w)).rejects.toBeInstanceOf(ConflictException);
		untouched(w);
	});
	test("control: a complete lead is approved", async () => {
		const w = makeWorld();
		await decide(w);
		expect(w.patches).toHaveLength(1);
	});
	test("a triage Approve does not arm sending, so a lead without a draft may be approved", async () => {
		const row = eligibleRow({ Email: "", "Draft Email Body": "" });
		const w = makeWorld({ row });
		await decide(w, { stage: "triage", seen: seenOf(row) });
		expect(w.patches[0]?.patch["Send Approved"]).toBe(false);
	});
});

describe("who may decide", () => {
	test("a non-approver is refused before NocoDB or the database is touched", async () => {
		const w = makeWorld();
		await expect(
			decide(w, { actor: { id: "u2", email: "intruder@example.com" } }),
		).rejects.toBeInstanceOf(ForbiddenException);
		untouched(w);
		expect(w.reads).toEqual([]);
	});
	test("an actor without an email is refused", async () => {
		const w = makeWorld();
		await expect(
			decide(w, { actor: { id: "u2", email: null } }),
		).rejects.toBeInstanceOf(ForbiddenException);
		untouched(w);
	});
	for (const value of [undefined, "", "  ", ","]) {
		test(`allowlist ${JSON.stringify(value)} refuses everything, including the usual approver`, async () => {
			if (value === undefined) delete process.env.LEADGEN_DECISION_APPROVERS;
			else process.env.LEADGEN_DECISION_APPROVERS = value;
			const w = makeWorld();
			await expect(decide(w)).rejects.toBeInstanceOf(ForbiddenException);
			await expect(decide(w)).rejects.toThrow(/switched off/);
			await expect(rework(w)).rejects.toBeInstanceOf(ForbiddenException);
			untouched(w);
		});
	}
	test("the reply approvers variable does not grant decisions", async () => {
		delete process.env.LEADGEN_DECISION_APPROVERS;
		const before = process.env.LEADGEN_REPLY_APPROVERS;
		process.env.LEADGEN_REPLY_APPROVERS = "danio@wifielite.com";
		try {
			const w = makeWorld();
			await expect(decide(w)).rejects.toBeInstanceOf(ForbiddenException);
		} finally {
			if (before === undefined) delete process.env.LEADGEN_REPLY_APPROVERS;
			else process.env.LEADGEN_REPLY_APPROVERS = before;
		}
	});
	test("no NocoDB write credential: 503, nothing touched", async () => {
		const w = makeWorld({
			config: { ok: false, reason: "no NocoDB token is set" },
		});
		await expect(decide(w)).rejects.toBeInstanceOf(ServiceUnavailableException);
		untouched(w);
	});
	test("status tells the page what it may do and never carries a secret", () => {
		const w = makeWorld();
		expect(w.service.status("danio@wifielite.com")).toEqual({
			youAreApprover: true,
			approversConfigured: true,
			writeConfigured: true,
			writeProblem: null,
			tokenSource: "shared-with-mirror",
		});
		expect(w.service.status("other@x.co").youAreApprover).toBe(false);
		delete process.env.LEADGEN_DECISION_APPROVERS;
		expect(w.service.status("danio@wifielite.com")).toMatchObject({
			youAreApprover: false,
			approversConfigured: false,
		});
	});
	test("the reviewer is the session actor, recorded in the audit row", async () => {
		const w = makeWorld();
		await decide(w);
		expect(w.audit[0]).toMatchObject({
			actorId: "user-1",
			actorEmail: "danio@wifielite.com",
		});
	});
});

describe("audit trail", () => {
	test("the audit row exists, PENDING, before the NocoDB call", async () => {
		const w = makeWorld();
		await decide(w);
		expect(w.auditAtPatch[0]).toHaveLength(1);
		expect(w.auditAtPatch[0]?.[0]).toMatchObject({
			status: "PENDING",
			leadId: "lead-1",
			nocodbTable: ISP,
			nocodbRowId: 42,
			stage: "review",
			decision: "Approved",
			prevDecision: null,
			prevSendApproved: false,
			prevVersion: START,
			actorId: "user-1",
		});
		expect(w.auditAtPatch[0]?.[0]?.patch).toEqual(w.patches[0]?.patch);
	});
	test("the outcome is recorded after: APPLIED with the result", async () => {
		const w = makeWorld();
		await decide(w);
		expect(w.audit[0]).toMatchObject({
			status: "APPLIED",
			outcome: "applied and verified",
		});
		expect((w.audit[0]?.result as Row | undefined)?.sendApproved).toBe(true);
		expect(w.audit[0]?.completedAt).toEqual(NOW);
	});
	test("previous values come from the live row, not the page", async () => {
		const row = eligibleRow({
			"Approval Decision": "Rejected",
			"Decision Date": "2026-09-01",
			"Send Approved": 1,
		});
		const w = makeWorld({ row });
		await decide(w, { seen: seenOf(row), decision: "Needs Changes" });
		expect(w.audit[0]).toMatchObject({
			prevDecision: "Rejected",
			prevSendApproved: true,
		});
	});
	test("a refusal writes no audit row and no PATCH", async () => {
		const w = makeWorld({ replied: [42] });
		await expect(decide(w)).rejects.toBeInstanceOf(ConflictException);
		untouched(w);
	});
	test("a rework is audited with its notes", async () => {
		const w = makeWorld();
		await rework(w, { notes: "  darker hero  " });
		expect(w.audit[0]).toMatchObject({
			action: "REWORK",
			notes: "darker hero",
			status: "APPLIED",
			stage: null,
			decision: null,
		});
	});
});

describe("ambiguous and failed writes", () => {
	test("timeout: UNKNOWN, one PATCH, never retried, and the same request stays blocked", async () => {
		const w = makeWorld({
			patchError: new NocoWriteError(
				"unknown",
				null,
				"NocoDB did not answer (TimeoutError)",
			),
		});
		const requestId = rid();
		await expect(decide(w, { requestId })).rejects.toBeInstanceOf(
			InternalServerErrorException,
		);
		expect(w.patches).toHaveLength(1);
		expect(w.audit[0]).toMatchObject({ status: "UNKNOWN" });
		await expect(decide(w, { requestId })).rejects.toBeInstanceOf(
			ConflictException,
		);
		expect(w.patches).toHaveLength(1);
	});
	test("a 5xx is unknown as well", async () => {
		const w = makeWorld({
			patchError: new NocoWriteError("unknown", 502, "NocoDB answered 502"),
		});
		await expect(decide(w)).rejects.toBeInstanceOf(
			InternalServerErrorException,
		);
		expect(w.audit[0]).toMatchObject({ status: "UNKNOWN" });
	});
	test("a definite refusal (4xx): FAILED and reported as a bad gateway", async () => {
		const w = makeWorld({
			patchError: new NocoWriteError("rejected", 400, "NocoDB answered 400"),
		});
		await expect(decide(w)).rejects.toBeInstanceOf(BadGatewayException);
		expect(w.audit[0]).toMatchObject({ status: "FAILED" });
		expect(w.patches).toHaveLength(1);
	});
	test("a FAILED request id cannot be replayed as a success", async () => {
		const w = makeWorld({
			patchError: new NocoWriteError("rejected", 400, "x"),
		});
		const requestId = rid();
		await expect(decide(w, { requestId })).rejects.toBeInstanceOf(
			BadGatewayException,
		);
		await expect(decide(w, { requestId })).rejects.toBeInstanceOf(
			ConflictException,
		);
		expect(w.patches).toHaveLength(1);
	});
	test("NocoDB silently discarding the flag is caught by the read-back", async () => {
		const w = makeWorld({ dropFields: ["Send Approved"] });
		await expect(decide(w)).rejects.toThrow(/Send Approved/);
		expect(w.audit[0]).toMatchObject({ status: "UNKNOWN" });
		expect(String(w.audit[0]?.outcome)).toMatch(/read-back mismatch/);
	});
	test("a failed read-back is UNKNOWN, not success", async () => {
		const w = makeWorld({ readBackFails: true });
		await expect(decide(w)).rejects.toBeInstanceOf(
			InternalServerErrorException,
		);
		expect(w.audit[0]).toMatchObject({ status: "UNKNOWN" });
	});
	test("if the audit row cannot be written, nothing is sent to NocoDB", async () => {
		const w = makeWorld({ auditCreateFails: true });
		await expect(decide(w)).rejects.toBeInstanceOf(
			InternalServerErrorException,
		);
		expect(w.patches).toHaveLength(0);
	});
});

describe("double click", () => {
	test("the same request id twice writes once and replays the first result", async () => {
		const w = makeWorld();
		const requestId = rid();
		const first = (await decide(w, { requestId })) as Record<string, unknown>;
		const second = (await decide(w, { requestId })) as Record<string, unknown>;
		expect(w.patches).toHaveLength(1);
		expect(first.replay).toBe(false);
		expect(second).toEqual({ ...first, replay: true });
		expect(w.audit).toHaveLength(1);
	});
	test("two simultaneous clicks: one write, the other refused", async () => {
		const w = makeWorld();
		const requestId = rid();
		const results = await Promise.allSettled([
			decide(w, { requestId }),
			decide(w, { requestId }),
		]);
		expect(w.patches).toHaveLength(1);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
	});
	test("two simultaneous clicks with different request ids: still one write", async () => {
		const w = makeWorld();
		const results = await Promise.allSettled([decide(w), decide(w)]);
		expect(w.patches).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
	});
	test("a second click with a new id after the write is a stale-page 409, not a second write", async () => {
		const w = makeWorld();
		await decide(w);
		await expect(decide(w)).rejects.toBeInstanceOf(ConflictException);
		expect(w.patches).toHaveLength(1);
	});
	test("another user cannot replay someone else's request id", async () => {
		const w = makeWorld();
		const requestId = rid();
		await decide(w, { requestId });
		process.env.LEADGEN_DECISION_APPROVERS =
			"danio@wifielite.com,second@wifielite.com";
		await expect(
			decide(w, {
				requestId,
				actor: { id: "user-2", email: "second@wifielite.com" },
			}),
		).rejects.toBeInstanceOf(ConflictException);
	});
	test("a fresh PENDING audit row for the lead blocks a new change", async () => {
		const w = makeWorld({
			seedAudit: [
				{
					id: "p1",
					requestId: "other",
					leadId: "lead-1",
					status: "PENDING",
					createdAt: NOW,
					actorId: "user-1",
				},
			],
		});
		await expect(decide(w)).rejects.toBeInstanceOf(ConflictException);
		expect(w.patches).toHaveLength(0);
	});
});

describe("rework", () => {
	test("writes the request, clears decision and send flag, and reports it", async () => {
		const row = eligibleRow({
			"Approval Decision": "Approved",
			"Send Approved": 1,
		});
		const w = makeWorld({ row });
		const out = (await rework(w, { seen: seenOf(row) })) as Record<
			string,
			unknown
		>;
		expect(w.patches[0]?.patch).toEqual({
			Id: 42,
			"Rework Requested": NOW.toISOString(),
			"Rework Notes": "hero is too dark",
			"Approval Decision": null,
			"Send Approved": false,
		});
		expect(out).toMatchObject({
			action: "REWORK",
			decision: null,
			sendApproved: false,
			reworkRequested: true,
		});
	});
	test("empty notes: 400 before NocoDB is read", async () => {
		const w = makeWorld();
		await expect(rework(w, { notes: "   " })).rejects.toBeInstanceOf(
			BadRequestException,
		);
		untouched(w);
		expect(w.reads).toEqual([]);
	});
	test("gym leads have no rework", async () => {
		const w = makeWorld({ table: GYM });
		await expect(rework(w)).rejects.toBeInstanceOf(BadRequestException);
		untouched(w);
	});
});
