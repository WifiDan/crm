// Live check for replies.draft against the scratch DB (never prod). Makes REAL, small Claude calls.
//   DATABASE_URL=<crm_dev url> LEADGEN_DRAFTS_PER_RUN=2 bun run test/leadgen-drafts.live.ts
import { readFileSync } from "node:fs";
import { db } from "@crm/db";
import { RepliesDraftHandler } from "../src/leadgen/replies-draft.handler";

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
process.env.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_OAUTH_TOKEN_RAW;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
};
const ctx = {
	runId: "live",
	jobName: "replies.draft",
	signal: new AbortController().signal,
};

const before = await db.lgReplyDraft.count();
const h = new RepliesDraftHandler(db);
const r = await h.run(ctx);
console.log("counters:", JSON.stringify(r.counters));
const c = r.counters as {
	candidates?: number;
	drafted?: number;
	classifiedOnly?: number;
	failed?: number;
};
check("found candidates", (c.candidates ?? 0) > 0, `${c.candidates}`);
check("none failed", (c.failed ?? 1) === 0);

const drafts = await db.lgReplyDraft.findMany({
	where: { createdAt: { gte: new Date(Date.now() - 600_000) } },
	include: {
		inboundMessage: { select: { classification: true, bodyText: true } },
		lead: { select: { businessName: true } },
	},
});
check(
	"every draft is PENDING (nothing approved or sent)",
	drafts.every((d) => d.status === "PENDING" && d.sentSendId === null),
);
const afterCount = await db.lgReplyDraft.count();
check(
	"drafts created this run match the counter",
	afterCount - before === (c.drafted ?? -1),
	`${afterCount - before}`,
);
check(
	"drafts only for INTERESTED/QUESTION",
	drafts.every((d) =>
		["INTERESTED", "QUESTION"].includes(d.inboundMessage.classification ?? ""),
	),
);
for (const d of drafts) {
	console.log(
		`\n--- DRAFT for ${d.lead.businessName} [${d.inboundMessage.classification}] ---`,
	);
	console.log(
		`THEIR REPLY: ${(d.inboundMessage.bodyText ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
	);
	console.log(
		`SUBJECT: ${d.draftSubject}\n${d.draftBody}\nNOTES: ${d.rationale}`,
	);
}
await h.run(ctx);
const dup = await db.lgReplyDraft.groupBy({
	by: ["inboundMessageId"],
	_count: { _all: true },
	having: { inboundMessageId: { _count: { gt: 1 } } },
});
check("no reply ever gets two drafts across runs", dup.length === 0);
const reclassified = await db.lgInboundMessage.count({
	where: {
		id: { in: drafts.map((d) => d.inboundMessageId) },
		classification: null,
	},
});
check("already-drafted replies stay classified", reclassified === 0);

process.env.LEADGEN_CLAUDE_BIN = "/nonexistent/claude";
let threw = false;
try {
	await new RepliesDraftHandler(db).run(ctx);
} catch {
	threw = true;
}
check(
	"a broken model binary fails loudly, not silently",
	threw ||
		(await db.lgInboundMessage.count({
			where: { classification: null, matchedLeadId: { not: null } },
		})) === 0,
);
console.log(
	failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
