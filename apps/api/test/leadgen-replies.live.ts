// Live integration check for replies.poll, run by hand against the scratch DB (never prod):
//   DATABASE_URL=<crm_dev url> bun run test/leadgen-replies.live.ts
// Reads the REAL mailbox (read-only over IMAP); writes only to crm_dev.
import { readFileSync } from "node:fs";
import { db } from "@crm/db";
import { NocodbMirrorHandler } from "../src/leadgen/nocodb-mirror.handler";
import { RepliesPollHandler } from "../src/leadgen/replies-poll.handler";
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
process.env.ZOHO_IMAP_USER = "danio@elitesystemsdesign.com";
process.env.ZOHO_IMAP_PASSWORD = secrets.ZOHO_SMTP_PASSWORD;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}
const ctx = (jobName: string) => ({
	runId: "live-check",
	jobName,
	signal: new AbortController().signal,
});

// Fresh leads + send ledger so matching has real data to work with.
await new NocodbMirrorHandler(db).run(ctx("nocodb.mirror"));
await new SendlogSyncHandler(db).run(ctx("sendlog.sync"));
const leadCount = await db.lgLead.count();
const sendCount = await db.lgOutreachSend.count();
check(
	"scratch DB has leads and sends to match against",
	leadCount > 900 && sendCount > 200,
	`${leadCount} leads, ${sendCount} sends`,
);

const handler = new RepliesPollHandler(db);
const before = await db.lgInboundMessage.count();
const first = await handler.run(ctx("replies.poll"));
const c = first.counters as Record<string, number> & {
	fetched: number;
	skippedSelf: number;
	noMessageId: number;
	stored: number;
};
console.log("counters:", JSON.stringify(c));

check(
	"read the real mailbox (fetched > 0)",
	c.fetched > 0,
	`${c.fetched} messages`,
);
check(
	"every parsed, non-self message was stored",
	c.stored === c.fetched - c.skippedSelf - c.noMessageId,
	`${c.stored} stored`,
);
const total = await db.lgInboundMessage.count();
check(
	"rows written == stored",
	total - before === c.stored,
	`+${total - before}`,
);
check(
	"every stored row is flagged shadow",
	(await db.lgInboundMessage.count({ where: { shadow: false } })) === 0,
);

const second = await handler.run(ctx("replies.poll"));
const total2 = await db.lgInboundMessage.count();
check(
	"second run is idempotent (no new rows)",
	total2 === total,
	`${total} -> ${total2}`,
);
check(
	"second run sees the same mailbox",
	((second.counters as { fetched?: number }).fetched ?? 0) >= c.fetched,
);

const stops = await db.lgInboundMessage.findMany({
	where: { classification: "STOP" },
	select: { fromAddr: true, matchMethod: true },
});
console.log(`STOP-classified messages: ${stops.length}`);
const bounceNoLeadStop = await db.lgInboundMessage.count({
	where: { classification: "STOP", fromAddr: { startsWith: "mailer-daemon" } },
});
check("no bounce was ever classified as STOP", bounceNoLeadStop === 0);
const humanNoRuleMatched = await db.lgInboundMessage.count({
	where: { classification: null, matchedLeadId: { not: null } },
});
console.log(`matched human replies awaiting judgement: ${humanNoRuleMatched}`);

// Failure path: a wrong password must FAIL LOUDLY, never return an empty clean result.
const goodPass = process.env.ZOHO_IMAP_PASSWORD;
process.env.ZOHO_IMAP_PASSWORD = "definitely-wrong";
let threw = false;
try {
	await handler.run(ctx("replies.poll"));
} catch {
	threw = true;
}
process.env.ZOHO_IMAP_PASSWORD = goodPass;
check("bad IMAP password throws (failure path is real)", threw);

console.log(
	failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
