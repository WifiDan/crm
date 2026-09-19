// Live parity check for the Phase 4 send SHADOW, against the scratch DB (never prod) and the real
// NocoDB (read-only). It runs the Python sender in --dry-run (which skips SMTP, the send and the CRM
// drain, and only prints what it would send), then makes the CRM plan at Python's own printed clock
// value and compares pools and the ordered batch. Sends nothing.
//   DATABASE_URL=<crm_dev url> bun run test/leadgen-outreach-shadow.live.ts
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { db } from "@crm/db";
import { NocodbMirrorHandler } from "../src/leadgen/nocodb-mirror.handler";
import { type ActualSend, compareRun } from "../src/leadgen/outreach-compare";
import { OutreachCompareHandler } from "../src/leadgen/outreach-compare.handler";
import {
	buildCandidates,
	type Candidate,
	checkInterlocks,
	type NocoRow,
	planBatch,
	poolsAt,
	type Tier,
} from "../src/leadgen/outreach-plan";
import {
	ISP_TABLE_ID,
	OutreachShadowHandler,
} from "../src/leadgen/outreach-shadow.handler";
import { loadPythonSendState } from "../src/leadgen/python-state";
import { SendlogSyncHandler } from "../src/leadgen/sendlog-sync.handler";

const dbName = /\/([a-z_]+)(\?|$)/.exec(process.env.DATABASE_URL ?? "")?.[1];
if (dbName !== "crm_dev") {
	console.error(
		`refusing to run: DATABASE_URL points at "${dbName}", not crm_dev`,
	);
	process.exit(2);
}
const secrets = Object.fromEntries(
	readFileSync("/data/leadgen/.secrets.env", "utf8")
		.split("\n")
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
process.env.NOCODB_URL = "http://joshua.tail261548.ts.net:8080";
process.env.NOCODB_LEADS_TOKEN = secrets.NOCODB_LOCAL_LEADS_TOKEN;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
};
const ctx = (jobName: string) => ({
	runId: "live-check",
	jobName,
	signal: new AbortController().signal,
});
const TIER: Record<string, Tier> = {
	initial: "initial",
	fu1: "fu1",
	fu2: "fu2",
};

// ---- 1. what Python says it would send right now ------------------------------------------
const run = promisify(execFile);
let pyOut = "";
let pyErr = "";
try {
	const r = await run(
		"python3",
		["/data/leadgen/scripts/send_daily_batch.py", "--dry-run"],
		{
			cwd: "/data/leadgen/scripts",
			timeout: 240_000,
			maxBuffer: 4_000_000,
		},
	);
	pyOut = r.stdout;
	pyErr = r.stderr;
} catch (e) {
	console.error("python dry-run failed:", String(e).slice(0, 300));
	process.exit(1);
}
const elig =
	/^(\S+) eligible: initial=(\d+) fu1=(\d+) fu2=(\d+) cap=(\d+) dry=True/m.exec(
		pyOut,
	);
const pyHeld = /HOLD:/.test(pyErr);
const pyBatch = [...pyOut.matchAll(/^\s+DRY \[(\w+)\] Id (\d+) /gm)].map(
	(m) => ({
		id: Number(m[2]),
		tier: TIER[m[1] as string] as Tier,
	}),
);
console.log(
	`python: ${pyHeld ? "HELD" : elig ? `pools initial=${elig[2]} fu1=${elig[3]} fu2=${elig[4]} cap=${elig[5]}` : "no eligible line"}, batch=${pyBatch.length}`,
);

// ---- 2. the CRM's view, from a fresh mirror ------------------------------------------------
await new NocodbMirrorHandler(db).run(ctx("nocodb.mirror"));
const leads = await db.lgLead.findMany({
	where: { nocodbTable: ISP_TABLE_ID, mirrorMissingAt: null },
	select: { nocodbRowId: true, raw: true },
});
const rows: NocoRow[] = leads.flatMap((l) =>
	l.nocodbRowId !== null && l.raw && typeof l.raw === "object"
		? [{ ...(l.raw as Record<string, unknown>), Id: l.nocodbRowId }]
		: [],
);
const state = await loadPythonSendState(new Date());
const hold = checkInterlocks(state);
check(
	"CRM and Python agree on whether the interlocks hold",
	(hold !== null) === pyHeld,
	`crm ${hold?.kind ?? "clear"}, python ${pyHeld ? "held" : "clear"}`,
);

if (!pyHeld && elig) {
	const asOf = new Date(elig[1] as string);
	const cands = buildCandidates(rows, state);
	const pools = poolsAt(cands, asOf);
	check(
		"initial pool size equals Python's",
		pools.initial.length === Number(elig[2]),
		`${pools.initial.length} vs ${elig[2]}`,
	);
	check(
		"follow-up 1 pool size equals Python's",
		pools.fu1.length === Number(elig[3]),
		`${pools.fu1.length} vs ${elig[3]}`,
	);
	check(
		"follow-up 2 pool size equals Python's",
		pools.fu2.length === Number(elig[4]),
		`${pools.fu2.length} vs ${elig[4]}`,
	);
	const planned = planBatch(cands, asOf, Number(elig[5]));
	check(
		"the planned batch equals Python's, same rows, tiers and order",
		JSON.stringify(planned) === JSON.stringify(pyBatch),
		`${planned.length} vs ${pyBatch.length}`,
	);
	const asActual: ActualSend[] = pyBatch.map((b, i) => ({
		...b,
		at: new Date(asOf.getTime() + 1000 + i * 1000),
	}));
	check(
		"compareRun reports MATCH on Python's own batch",
		compareRun({
			cands,
			hold,
			asOfStart: asOf,
			cap: Number(elig[5]),
			actual: asActual,
		}).status === "MATCH",
	);

	// ---- controls: the comparison must be able to FAIL ----
	const nonTrivial =
		pyBatch.length + Number(elig[2]) + Number(elig[3]) + Number(elig[4]) > 0;
	check(
		"the comparison is non-trivial (Python has something in its pools)",
		nonTrivial,
		`${pyBatch.length} in batch`,
	);
	if (pyBatch.length >= 2) {
		const swapped = [...asActual];
		[swapped[0], swapped[1]] = [
			swapped[1] as ActualSend,
			swapped[0] as ActualSend,
		];
		check(
			"CONTROL: a swapped order is reported as MISMATCH",
			compareRun({
				cands,
				hold,
				asOfStart: asOf,
				cap: Number(elig[5]),
				actual: swapped,
			}).status === "MISMATCH",
		);
	}
	if (pyBatch.length >= 1) {
		check(
			"CONTROL: a batch one row short is reported as MISMATCH",
			compareRun({
				cands,
				hold,
				asOfStart: asOf,
				cap: Number(elig[5]),
				actual: asActual.slice(1),
			}).status === "MISMATCH",
		);
		check(
			"CONTROL: a smaller cap changes the plan",
			planBatch(cands, asOf, pyBatch.length - 1).length !== pyBatch.length,
		);
	}
}

// ---- 3. the two handlers, end to end on the scratch DB -------------------------------------
const mirror = new NocodbMirrorHandler(db);
const sendlog = new SendlogSyncHandler(db);
const shadow = new OutreachShadowHandler(db, mirror);
const compare = new OutreachCompareHandler(db, sendlog);

const before = await db.lgSendShadowRun.count();
const out = await shadow.run(ctx("outreach.shadow"));
const sc = out.counters as Record<string, number | string>;
console.log("shadow counters:", JSON.stringify(sc));
const stored = await db.lgSendShadowRun.findUnique({
	where: { runDate: String(sc.runDate) },
});
check(
	"the shadow stored a run for the next send date",
	!!stored && (await db.lgSendShadowRun.count()) === before + 1,
	`${before} -> ${before + 1}`,
);
const storedPlan = stored?.planned;
check(
	"the stored plan has the size the counters report",
	Array.isArray(storedPlan) && storedPlan.length === sc.plannedSends,
);
check(
	"a run computed before the send time is not marked late",
	stored?.late === false,
);

// re-running for the same date recomputes rather than duplicating
await shadow.run(ctx("outreach.shadow"));
check(
	"a re-run replaces the uncompared run instead of duplicating it",
	(await db.lgSendShadowRun.count({
		where: { runDate: String(sc.runDate) },
	})) === 1,
);

// plant Python "sent" ledger rows that match the plan exactly, then compare
const cap = stored?.cap ?? 10;
const asOf = stored?.asOf as Date;
const STEP = { initial: "INITIAL", fu1: "FU1", fu2: "FU2" } as const;
const tag = `zz-livetest-${Date.now()}`;
const planted: string[] = [];
async function plant(items: Array<{ id: number; tier: Tier }>, base: Date) {
	let i = 0;
	for (const it of items) {
		const lead = await db.lgLead.findFirstOrThrow({
			where: { nocodbTable: ISP_TABLE_ID, nocodbRowId: it.id },
		});
		const row = await db.lgOutreachSend.create({
			data: {
				leadId: lead.id,
				step: STEP[it.tier],
				toAddr: `${tag}@example.invalid`,
				sentAt: new Date(base.getTime() + 5_000 + i++ * 2_000),
				dedupeKey: `${tag}:${it.id}:${it.tier}`,
				source: "python-send-log",
			},
		});
		planted.push(row.id);
	}
}
async function cleanup() {
	await db.lgOutreachSend.deleteMany({ where: { id: { in: planted } } });
	planted.length = 0;
}
async function resetRun(when: Date) {
	await db.lgSendShadowRun.update({
		where: { runDate: String(sc.runDate) },
		data: { comparedAt: null, compare: undefined, asOf: when },
	});
}
try {
	// shift the run into the past so the compare job will look at it; the plan is what the CRM computes at that clock
	const past = new Date(Date.now() - 2 * 3_600_000);
	const planned = planBatch(
		(stored?.candidates ?? []) as unknown as Candidate[],
		past,
		cap,
	);
	if (planned.length > 0) {
		await resetRun(past);
		await plant(planned, past);
		const res = await compare.run(ctx("outreach.shadow.compare"));
		const cc = res.counters as Record<string, number>;
		console.log("compare counters:", JSON.stringify(cc));
		const done = await db.lgSendShadowRun.findUniqueOrThrow({
			where: { runDate: String(sc.runDate) },
		});
		check(
			"compare marks a matching morning MATCH",
			(done.compare as { status?: string } | null)?.status === "MATCH",
		);
		check(
			"compare raises no alert for a match",
			(await db.lgAlert.count({
				where: { key: `outreach.shadow.mismatch:${sc.runDate}` },
			})) === 0,
		);

		// now the failure path: Python "sent" one extra row the plan did not want
		await cleanup();
		await resetRun(past);
		const extra = await db.lgLead.findFirstOrThrow({
			where: {
				nocodbTable: ISP_TABLE_ID,
				nocodbRowId: { notIn: planned.map((p) => p.id) },
			},
		});
		await plant(
			[...planned, { id: extra.nocodbRowId as number, tier: "initial" }],
			past,
		);
		const bad = await compare.run(ctx("outreach.shadow.compare"));
		const done2 = await db.lgSendShadowRun.findUniqueOrThrow({
			where: { runDate: String(sc.runDate) },
		});
		check(
			"CONTROL: an extra Python send is reported as MISMATCH",
			(done2.compare as { status?: string } | null)?.status === "MISMATCH",
		);
		check(
			"CONTROL: a mismatch raises a DIGEST alert",
			(await db.lgAlert.count({
				where: {
					key: `outreach.shadow.mismatch:${sc.runDate}`,
					tier: "DIGEST",
				},
			})) === 1,
		);
		check(
			"CONTROL: the match streak drops to 0 after a mismatch",
			(bad.counters as { matchStreak?: number }).matchStreak === 0,
		);
	} else {
		console.log(
			"plan is empty today: skipping the planted-send compare (unit tests cover it)",
		);
	}
} finally {
	await cleanup();
	await db.lgAlert.deleteMany({
		where: { key: { startsWith: "outreach.shadow.mismatch:" } },
	});
	await db.lgSendShadowRun.deleteMany({
		where: { runDate: String(sc.runDate) },
	});
	await db.lgOutreachSend.deleteMany({
		where: { dedupeKey: { startsWith: tag } },
	});
}
check(
	"cleanup left no test rows",
	(await db.lgOutreachSend.count({
		where: { dedupeKey: { startsWith: tag } },
	})) === 0,
);
void asOf;

console.log(
	failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
