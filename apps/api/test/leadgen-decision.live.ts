import { db } from "@crm/db";
import {
	armingBlockers,
	buildDecisionPatch,
	type LeadPatch,
	type LiveRow,
	POOLS,
	SEND_APPROVED_FIELD,
	statusBlockers,
	verifyPatch,
} from "../src/leadgen/lead-decision.rules";
import { LeadDecisionService } from "../src/leadgen/lead-decision.service";
import {
	type FetchLike,
	type LeadRowStore,
	nocodbLeadStore,
} from "../src/leadgen/lead-decision.store";
import { buildCandidates } from "../src/leadgen/outreach-plan";
import { loadPythonSendState } from "../src/leadgen/python-state";

const dbName = /\/([a-z_]+)(\?|$)/.exec(process.env.DATABASE_URL ?? "")?.[1];
if (dbName !== "crm_dev") {
	console.error(
		`refusing to run: DATABASE_URL points at "${dbName}", not crm_dev`,
	);
	process.exit(2);
}
const current = await db.$queryRaw<
	Array<{ name: string }>
>`SELECT current_database() AS name`;
if (current[0]?.name !== "crm_dev") {
	console.error(`refusing to run: connected database is "${current[0]?.name}"`);
	process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}

const PREFIX = "ZZ-decision-";
const ROW_ID = 9_200_042;
const START = "2026-09-20 14:31:07+00:00";
const ACTOR = { id: "live-user", email: "live@example.com" };
process.env.LEADGEN_DECISION_APPROVERS = "live@example.com";

async function cleanup() {
	const leads = await db.lgLead.findMany({
		where: { businessName: { startsWith: PREFIX } },
		select: { id: true },
	});
	const ids = leads.map((l) => l.id);
	await db.lgLeadDecision.deleteMany({ where: { leadId: { in: ids } } });
	await db.lgLead.deleteMany({ where: { id: { in: ids } } });
}

function stubStore(auditSnapshots: string[]) {
	let live: LiveRow = {
		Id: ROW_ID,
		UpdatedAt: START,
		"Approval Decision": null,
		"Decision Date": null,
		Email: "owner@zz-decision.example.com",
		"Draft Email Subject": "Hello",
		"Draft Email Body": "Body",
		"Sent At": null,
		"Do Not Contact": 0,
		"Send Approved": 0,
	};
	const patches: LeadPatch[] = [];
	const store: LeadRowStore = {
		writeConfig: () => ({ ok: true, source: "shared-with-mirror" }),
		getRow: async () => ({ ...live }),
		columnState: async () => "present",
		patchRow: async (_t, patch) => {
			const rows = await db.lgLeadDecision.findMany({
				where: { nocodbRowId: ROW_ID },
				select: { status: true },
			});
			auditSnapshots.push(rows.map((r) => r.status).join(","));
			patches.push(patch);
			const next: LiveRow = { ...live };
			for (const [k, v] of Object.entries(patch)) {
				if (k === "Id") continue;
				next[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
			}
			next.UpdatedAt = "2026-09-20 15:04:06+00:00";
			live = next;
		},
	};
	return {
		store,
		patches,
		get live() {
			return live;
		},
	};
}

try {
	await cleanup();
	const lead = await db.lgLead.create({
		data: {
			businessName: `${PREFIX}1`,
			nocodbTable: POOLS.isp.tableId,
			nocodbRowId: ROW_ID,
			email: "owner@zz-decision.example.com",
			raw: { Id: ROW_ID, UpdatedAt: START },
			mirroredAt: new Date(),
		},
	});
	const beforeMirror = JSON.stringify(
		await db.lgLead.findUnique({ where: { id: lead.id } }),
	);
	const snapshots: string[] = [];
	const world = stubStore(snapshots);
	const service = new LeadDecisionService(
		db,
		world.store,
		async () => loadPythonSendState(new Date()),
		() => new Date(),
	);
	const requestId = "00000000-0000-4000-8000-00000000d0d0";
	const input = {
		leadId: lead.id,
		requestId,
		stage: "review" as const,
		decision: "Approved" as const,
		seen: { updatedAt: START, decision: null, decisionDate: null },
		confirmArm: true,
		actor: ACTOR,
	};
	const first = await service.decide(input);
	check(
		"first approval applied against real Postgres",
		first.replay === false && first.sendApproved === true,
	);
	check(
		"the audit row was in the database, PENDING, when the PATCH ran",
		snapshots[0] === "PENDING",
		snapshots[0],
	);
	const rows = await db.lgLeadDecision.findMany({ where: { leadId: lead.id } });
	check(
		"one audit row, APPLIED, with the actor and previous values",
		rows.length === 1 &&
			rows[0]?.status === "APPLIED" &&
			rows[0]?.actorEmail === ACTOR.email &&
			rows[0]?.prevDecision === null &&
			rows[0]?.prevSendApproved === false &&
			rows[0]?.prevVersion === START,
	);
	check(
		"the completed timestamp and result are stored",
		rows[0]?.completedAt !== null &&
			(rows[0]?.result as { sendApproved?: boolean } | null)?.sendApproved ===
				true,
	);

	const second = await service.decide(input);
	check(
		"double click: same request id replays and writes nothing more",
		second.replay === true && world.patches.length === 1,
	);
	check(
		"the unique request id is enforced by the database",
		await db.lgLeadDecision
			.create({
				data: {
					requestId,
					action: "DECISION",
					actorId: "x",
					leadId: lead.id,
					nocodbTable: POOLS.isp.tableId,
					nocodbRowId: ROW_ID,
					patch: {},
				},
			})
			.then(
				() => false,
				(e: { code?: string }) => e.code === "P2002",
			),
	);

	let staleRefused = false;
	try {
		await service.decide({
			...input,
			requestId: "00000000-0000-4000-8000-00000000d0d1",
		});
	} catch (e) {
		staleRefused = /changed since the page loaded/.test((e as Error).message);
	}
	check(
		"a second click with a new id is a stale-page refusal",
		staleRefused && world.patches.length === 1,
	);

	const rework = await service.rework({
		leadId: lead.id,
		requestId: "00000000-0000-4000-8000-00000000d0d2",
		notes: "darker hero",
		seen: {
			updatedAt: first.version ?? "",
			decision: first.decision,
			decisionDate: first.decisionDate,
		},
		actor: ACTOR,
	});
	check(
		"rework applied and cleared the send flag",
		rework.sendApproved === false &&
			rework.reworkRequested === true &&
			rework.decision === null,
	);
	const all = await db.lgLeadDecision.findMany({
		where: { leadId: lead.id },
		orderBy: { createdAt: "asc" },
	});
	check(
		"two audit rows now: DECISION then REWORK, both APPLIED",
		all.map((r) => `${r.action}:${r.status}`).join(",") ===
			"DECISION:APPLIED,REWORK:APPLIED",
	);

	const afterMirror = JSON.stringify(
		await db.lgLead.findUnique({ where: { id: lead.id } }),
	);
	check(
		"the lg_lead row is byte-identical after all of it",
		beforeMirror === afterMirror,
	);
} finally {
	await cleanup();
	const left = await db.lgLead.count({
		where: { businessName: { startsWith: PREFIX } },
	});
	const leftAudit = await db.lgLeadDecision.count({
		where: { nocodbRowId: ROW_ID },
	});
	check(
		"fixtures removed",
		left === 0 && leftAudit === 0,
		`${left}/${leftAudit}`,
	);
}

const nocoUrl = process.env.NOCODB_URL;
const nocoToken = process.env.NOCODB_LEADS_TOKEN;
if (!nocoUrl || !nocoToken) {
	console.log(
		"SKIP  read-only NocoDB probe (NOCODB_URL / NOCODB_LEADS_TOKEN not set)",
	);
} else {
	let refusedWrites = 0;
	const readOnlyFetch: FetchLike = async (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		if (method !== "GET") {
			refusedWrites++;
			throw new Error(`probe refuses ${method}`);
		}
		return fetch(input, init);
	};
	const real = nocodbLeadStore(process.env, readOnlyFetch);
	await real.patchRow(POOLS.isp.tableId, { Id: 1 }).catch(() => undefined);
	check(
		"control: the probe's own guard refuses a PATCH before it leaves the process",
		refusedWrites === 1,
	);

	check(
		"real NocoDB: ISP table has the Send Approved column",
		(await real.columnState(POOLS.isp.tableId, SEND_APPROVED_FIELD)) ===
			"present",
	);
	check(
		"real NocoDB: gym table has no Send Approved column",
		(await real.columnState(POOLS.gym.tableId, SEND_APPROVED_FIELD)) ===
			"absent",
	);
	check(
		"real NocoDB: ISP has the rework columns",
		(await real.columnState(POOLS.isp.tableId, "Rework Notes")) === "present" &&
			(await real.columnState(POOLS.isp.tableId, "Rework Requested")) ===
				"present",
	);
	check(
		"real NocoDB: gym has no rework columns",
		(await real.columnState(POOLS.gym.tableId, "Rework Notes")) === "absent",
	);
	check(
		"control: a column that cannot exist reads as absent",
		(await real.columnState(POOLS.isp.tableId, "No Such Column ZZ")) ===
			"absent",
	);

	const listed = await readOnlyFetch(
		`${nocoUrl}/api/v2/tables/${POOLS.isp.tableId}/records?limit=1&fields=Id&where=${encodeURIComponent("(Send Approved,eq,1)~and(Sent At,notblank)")}`,
		{ headers: { "xc-token": nocoToken } },
	);
	const listedBody = (await listed.json()) as { list?: Array<{ Id?: number }> };
	const rowId = listedBody.list?.[0]?.Id;
	const allRows: LiveRow[] = [];
	for (let offset = 0; offset < 5000; offset += 200) {
		const page = await readOnlyFetch(
			`${nocoUrl}/api/v2/tables/${POOLS.isp.tableId}/records?limit=200&offset=${offset}`,
			{ headers: { "xc-token": nocoToken } },
		);
		const body = (await page.json()) as {
			list?: LiveRow[];
			pageInfo?: { isLastPage?: boolean };
		};
		allRows.push(...(body.list ?? []));
		if (body.pageInfo?.isLastPage !== false) break;
	}
	const readyState = await loadPythonSendState(new Date());
	const everythingApproved = allRows.map((r) => ({
		...r,
		"Send Approved": true,
		"Approval Decision": "Approved",
	}));
	const wouldSend = new Set(
		buildCandidates(everythingApproved, readyState)
			.filter((c) => c.initialOk)
			.map((c) => c.id),
	);
	const mailedFor = (row: LiveRow) => {
		const email = String(row.Email ?? "")
			.trim()
			.toLowerCase();
		return allRows.filter(
			(r) =>
				Number(r.Id) !== Number(row.Id) &&
				r["Sent At"] &&
				String(r.Email ?? "")
					.trim()
					.toLowerCase() === email,
		);
	};
	const disagreeing = allRows.filter((row) => {
		const passes =
			armingBlockers(row, { mailed: mailedFor(row), state: readyState })
				.length === 0;
		return passes !== wouldSend.has(Number(row.Id));
	});
	check(
		"per-row approval rules agree with the sender's whole-table rules on every real row",
		allRows.length > 500 &&
			wouldSend.size > 0 &&
			wouldSend.size < allRows.length &&
			disagreeing.length === 0,
		`${wouldSend.size} pass, ${allRows.length - wouldSend.size} refused, ${disagreeing.length} disagree`,
	);
	const refused = allRows.filter((r) => !r.Email);
	check(
		"control: real rows with no email are all refused",
		refused.length > 0 &&
			refused.every(
				(r) => armingBlockers(r, { mailed: [], state: readyState }).length > 0,
			),
		`${refused.length} rows`,
	);
	if (rowId === undefined) {
		console.log("SKIP  no approved and sent row found in NocoDB to sample");
	} else {
		const liveRow = await real.getRow(POOLS.isp.tableId, rowId);
		check(
			"real NocoDB: a row reads back by id",
			liveRow !== null && Number(liveRow?.Id) === rowId,
		);
		if (liveRow) {
			const own = buildDecisionPatch({
				rowId,
				pool: POOLS.isp,
				stage: "review",
				decision: "Approved",
				now: new Date(),
			});
			own["Decision Date"] = String(liveRow["Decision Date"]);
			check(
				"read-back comparator accepts NocoDB's real representation of an approved row",
				verifyPatch(own, liveRow).length === 0,
				JSON.stringify(verifyPatch(own, liveRow)),
			);
			const wrong = { ...own, "Send Approved": false };
			check(
				"control: the same comparator rejects the wrong flag",
				verifyPatch(wrong, liveRow).includes("Send Approved"),
			);
			check(
				"a real already-sent row is refused for Approve",
				statusBlockers({ decision: "Approved", live: liveRow }).some((m) =>
					/already sent/.test(m),
				),
			);
			const state = await loadPythonSendState(new Date());
			const blockers = armingBlockers(liveRow, { mailed: [], state });
			check(
				"a real already-sent row does not pass the sender's eligibility",
				blockers.length > 0,
				blockers[0] ?? "",
			);
		}
	}
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
