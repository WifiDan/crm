// Live integration check, run by hand against the scratch DB (never prod):
//   DATABASE_URL=<crm_dev url> bun run test/leadgen-mirror.live.ts
import { readFileSync } from "node:fs";
import { db } from "@crm/db";
import { LgJobSchedulerService } from "../src/leadgen/job-scheduler.service";
import { LeadgenSeedService } from "../src/leadgen/leadgen.seed";
import { NocodbMirrorHandler } from "../src/leadgen/nocodb-mirror.handler";
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

type Counts = Record<
	| "isp.source"
	| "isp.mirrored"
	| "isp.created"
	| "isp.updated"
	| "gym.source"
	| "gym.mirrored"
	| "gym.created"
	| "gym.updated",
	number
>;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}

async function runAndWait(scheduler: LgJobSchedulerService) {
	const started = await scheduler.runNow("nocodb.mirror");
	if (!started.started || !started.runId)
		throw new Error(`not started: ${started.reason}`);
	for (let i = 0; i < 240; i++) {
		const run = await db.lgJobRun.findUniqueOrThrow({
			where: { id: started.runId },
		});
		if (run.status !== "RUNNING") return run;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("mirror run did not finish in 120s");
}

const seed = new LeadgenSeedService(db as never);
await seed.seed();
await seed.seed(); // idempotent
check("seed: 3 markets", (await db.lgMarket.count()) === 3);
check("seed: 2 campaigns", (await db.lgCampaign.count()) === 2);
check("seed: 2 jobs", (await db.lgJobDefinition.count()) === 2);

const scheduler = new LgJobSchedulerService(db as never, [
	new NocodbMirrorHandler(db as never),
	new SendlogSyncHandler(db as never),
]);

await db.lgOutreachSend.deleteMany({});
await db.lgLead.deleteMany({});
const run1 = await runAndWait(scheduler);
const c1 = run1.counters as unknown as Counts;
console.log("run1", run1.status, JSON.stringify(c1), run1.error ?? "");
check("run1 OK", run1.status === "OK");
check(
	"isp mirrored == source",
	c1["isp.mirrored"] === c1["isp.source"],
	`${c1["isp.mirrored"]}/${c1["isp.source"]}`,
);
check(
	"gym mirrored == source",
	c1["gym.mirrored"] === c1["gym.source"],
	`${c1["gym.mirrored"]}/${c1["gym.source"]}`,
);
check(
	"total rows mirrored",
	(await db.lgLead.count()) === c1["isp.source"] + c1["gym.source"],
);

const run2 = await runAndWait(scheduler);
const c2 = run2.counters as unknown as Counts;
check(
	"run2 idempotent: created=0 updated=0",
	c2["isp.created"] === 0 &&
		c2["gym.created"] === 0 &&
		c2["isp.updated"] === 0 &&
		c2["gym.updated"] === 0,
	JSON.stringify(c2),
);

const victim = await db.lgLead.findFirstOrThrow({
	where: { doNotContact: false },
});
await db.lgLead.delete({ where: { id: victim.id } });
await db.lgLead.update({
	where: {
		id: (
			await db.lgLead.findFirstOrThrow({ where: { NOT: { id: victim.id } } })
		).id,
	},
	data: { rawHash: "tampered" },
});
const run3 = await runAndWait(scheduler);
const c3 = run3.counters as unknown as Counts;
check(
	"run3 repairs a deleted row and a tampered hash",
	c3["isp.created"] + c3["gym.created"] === 1 &&
		c3["isp.updated"] + c3["gym.updated"] === 1,
	JSON.stringify(c3),
);
check(
	"run3 counts back in sync",
	(await db.lgLead.count()) === c1["isp.source"] + c1["gym.source"],
);

await db.lgOutreachSend.deleteMany({});
async function runJob(name: string) {
	const started = await scheduler.runNow(name);
	if (!started.started || !started.runId)
		throw new Error(`not started: ${started.reason}`);
	for (let i = 0; i < 120; i++) {
		const run = await db.lgJobRun.findUniqueOrThrow({
			where: { id: started.runId },
		});
		if (run.status !== "RUNNING") return run;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("job did not finish");
}
const sl1 = await runJob("sendlog.sync");
const s1 = sl1.counters as unknown as Record<string, number>;
console.log("sendlog run1", sl1.status, JSON.stringify(s1), sl1.error ?? "");
check("sendlog run1 OK", sl1.status === "OK");
check(
	"ledger == matched log lines",
	(await db.lgOutreachSend.count()) === s1.matchedToLead,
	`${await db.lgOutreachSend.count()}/${s1.matchedToLead}`,
);
const sl2 = await runJob("sendlog.sync");
const s2 = sl2.counters as unknown as Record<string, number>;
check(
	"sendlog run2 idempotent (created=0)",
	sl2.status === "OK" && s2.created === 0,
	JSON.stringify(s2),
);
check(
	"no send lost to an unmatched lead",
	s1.unmatchedLead === 0,
	`unmatched=${s1.unmatchedLead}`,
);

const dnc = await db.lgLead.count({ where: { doNotContact: true } });
console.log("DNC rows mirrored:", dnc);
check("DNC rows mirrored (>0)", dnc > 0);

const stale = await db.lgJobRun.create({
	data: {
		jobId: (await db.lgJobDefinition.findFirstOrThrow()).id,
		status: "RUNNING",
		leaseExpiresAt: new Date(Date.now() - 60_000),
	},
});
await scheduler.tick();
const swept = await db.lgJobRun.findUniqueOrThrow({ where: { id: stale.id } });
check("expired lease swept to TIMED_OUT", swept.status === "TIMED_OUT");
check(
	"PAGE alert raised for the dead run",
	(await db.lgAlert.count({
		where: { key: "job-failed:nocodb.mirror", resolvedAt: null },
	})) === 1,
);

await db.lgJobDefinition.updateMany({
	data: { nextRunAt: new Date(Date.now() - 1000) },
});
const before = await db.lgJobRun.count();
const due = await db.lgJobDefinition.count();
await scheduler.tick();
await new Promise((r) => setTimeout(r, 4000));
check(
	"all due jobs claimed by tick()",
	(await db.lgJobRun.count()) === before + due,
);
const next = (await db.lgJobDefinition.findFirstOrThrow()).nextRunAt;
check(
	"nextRunAt advanced ~15 min",
	!!next && next.getTime() > Date.now() + 10 * 60_000,
);

console.log(
	failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
