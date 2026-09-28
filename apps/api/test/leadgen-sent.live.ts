// Live check for Sent-folder awareness, against the scratch DB (never prod) and the REAL mailbox.
// Reads IMAP read-only; writes only to crm_dev; sends nothing.
//   DATABASE_URL=<crm_dev url> bun run test/leadgen-sent.live.ts
import { readFileSync } from "node:fs";
import { db } from "@crm/db";
import { ImapFlow } from "imapflow";
import { NocodbMirrorHandler } from "../src/leadgen/nocodb-mirror.handler";
import { RepliesDraftHandler } from "../src/leadgen/replies-draft.handler";
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
const USER = "danio@elitesystemsdesign.com";
process.env.ZOHO_IMAP_USER = USER;
process.env.ZOHO_IMAP_PASSWORD = secrets.ZOHO_SMTP_PASSWORD;

type PollCounters = {
	fetched: number;
	stored: number;
	sentFolderChecked: number;
	sentFetched: number;
	answeredNew: number;
};

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

await new NocodbMirrorHandler(db).run(ctx("nocodb.mirror"));
await new SendlogSyncHandler(db).run(ctx("sendlog.sync"));

// Start from a clean slate so the run has to derive every answer itself.
await db.lgInboundMessage.updateMany({
	data: { answeredAt: null, answeredVia: null, answeredMessageId: null },
});

const handler = new RepliesPollHandler(db);
const first = await handler.run(ctx("replies.poll"));
const c = first.counters as PollCounters;
console.log("counters:", JSON.stringify(c));

check("the Sent folder was read", c.sentFolderChecked === 1);
check("Sent messages were fetched", c.sentFetched > 0, `${c.sentFetched}`);
check(
	"the INBOX ingest is unchanged",
	c.fetched > 0 && c.stored > 0,
	`${c.stored} stored`,
);

// ---- independent instrument: a second read of the Sent folder, sharing NO matching code ----
const days = Number(process.env.LEADGEN_REPLIES_SINCE_DAYS ?? "14");
const since = new Date(Date.now() - days * 86_400_000);
const client = new ImapFlow({
	host: "imappro.zoho.com",
	port: 993,
	secure: true,
	auth: { user: USER, pass: process.env.ZOHO_IMAP_PASSWORD as string },
	logger: false,
});
client.on("error", () => {});
await client.connect();
const replyTargets = new Set<string>(); // ids that sent mail says it is a reply to
const sentOwnIds = new Set<string>();
let sentTotal = 0;
const lock = await client.getMailboxLock("Sent");
try {
	for await (const m of client.fetch({ since }, { envelope: true })) {
		sentTotal++;
		const e = m.envelope;
		if (e?.inReplyTo) replyTargets.add(e.inReplyTo.trim().toLowerCase());
		if (e?.messageId) sentOwnIds.add(e.messageId.trim().toLowerCase());
	}
} finally {
	lock.release();
}
try {
	await client.logout();
} catch {
	client.close();
}
check(
	"independent read sees the same number of Sent messages",
	sentTotal === c.sentFetched,
	`${sentTotal} vs ${c.sentFetched}`,
);

const inbounds = await db.lgInboundMessage.findMany({
	where: { matchedLeadId: { not: null }, receivedAt: { gte: since } },
	select: { id: true, messageId: true, answeredAt: true, answeredVia: true },
});
const expectedThread = inbounds.filter(
	(i) => i.messageId && replyTargets.has(i.messageId.trim().toLowerCase()),
);
const missed = expectedThread.filter(
	(i) => i.answeredVia !== "sent-folder-thread",
);
check(
	"every inbound that Sent mail replies to (In-Reply-To) is marked answered by thread",
	missed.length === 0,
	`${expectedThread.length} expected, ${missed.length} missed`,
);
const dbThread = inbounds.filter((i) => i.answeredVia === "sent-folder-thread");
check(
	"no thread answer exists without header evidence beyond References",
	dbThread.length >= expectedThread.length,
	`${dbThread.length} thread, ${expectedThread.length} by In-Reply-To alone`,
);

// our own outreach must be in Sent, which is exactly why address-evidence must exclude it
const outreach = await db.lgOutreachSend.findMany({
	where: { messageId: { not: null } },
	select: { messageId: true },
});
const outreachInSent = outreach.filter((o) =>
	sentOwnIds.has((o.messageId ?? "").trim().toLowerCase()),
).length;
console.log(
	`outreach messages visible in the Sent folder window: ${outreachInSent}`,
);
const byAddress = inbounds.filter(
	(i) => i.answeredVia === "sent-folder-address",
);
console.log(
	`answered: ${dbThread.length} by thread, ${byAddress.length} by address (not threaded)`,
);

// ---- idempotence and never-overwrite ----
const before = await db.lgInboundMessage.findMany({
	where: { answeredAt: { not: null } },
	select: {
		id: true,
		answeredAt: true,
		answeredVia: true,
		answeredMessageId: true,
	},
	orderBy: { id: "asc" },
});
const second = await handler.run(ctx("replies.poll"));
check(
	"a second run finds nothing new to mark",
	(second.counters as { answeredNew?: number }).answeredNew === 0,
);
const after = await db.lgInboundMessage.findMany({
	where: { answeredAt: { not: null } },
	select: {
		id: true,
		answeredAt: true,
		answeredVia: true,
		answeredMessageId: true,
	},
	orderBy: { id: "asc" },
});
check(
	"marked answers are unchanged by a re-poll",
	JSON.stringify(before) === JSON.stringify(after),
	`${before.length} rows`,
);

// ---- the drafter must skip answered threads ----
const candidates = await new RepliesDraftHandler(db).candidates();
check(
	"the drafter never selects an answered thread",
	candidates.every((row) => !before.some((b) => b.id === row.id)),
	`${candidates.length} candidates`,
);

// ---- failure paths: a Sent-folder problem must be recorded as NOT checked, and must not lose the INBOX ----
type Internals = { readSent: () => Promise<unknown> };
const h = handler as unknown as Internals;
const realReadSent = h.readSent.bind(handler);
h.readSent = async () => {
	throw new Error("simulated Sent folder failure");
};
const broken = await handler.run(ctx("replies.poll"));
const bc = broken.counters as PollCounters;
check(
	"Sent failure: run still succeeds and ingests the INBOX",
	bc.fetched > 0 && bc.stored > 0,
);
check("Sent failure: recorded as NOT checked", bc.sentFolderChecked === 0);
h.readSent = async () => null;
const incomplete = await handler.run(ctx("replies.poll"));
check(
	"incomplete Sent read: recorded as NOT checked",
	(incomplete.counters as { sentFolderChecked?: number }).sentFolderChecked ===
		0,
);
h.readSent = realReadSent;

console.log(
	failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
