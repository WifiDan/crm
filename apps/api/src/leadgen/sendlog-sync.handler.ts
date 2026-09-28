import { readFile } from "node:fs/promises";
import { type Db, type Prisma as PrismaNamespace } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import { MIRROR_TABLES } from "./mirror-map";

const SEND_LOG_PATH =
	process.env.LEADGEN_SEND_LOG ?? "/data/leadgen/scripts/send-log.jsonl";

const sendLogLine = z.object({
	id: z.number(),
	name: z.string(),
	email: z.string(),
	subject: z.string(),
	sent_at: z.string(),
	tier: z.enum(["initial", "follow-up-1", "follow-up-2"]).optional(),
	message_id: z.string().optional(),
});

export type SendLogLine = z.infer<typeof sendLogLine>;

const STEP_BY_TIER = {
	initial: "INITIAL",
	"follow-up-1": "FU1",
	"follow-up-2": "FU2",
} as const;

export function parseSendLog(text: string) {
	const lines: SendLogLine[] = [];
	let bad = 0;
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		try {
			const parsed = sendLogLine.safeParse(JSON.parse(raw));
			if (parsed.success) lines.push(parsed.data);
			else bad++;
		} catch {
			bad++;
		}
	}
	return { lines, bad };
}

/**
 * A stable identity for a send, so re-reading the whole append-only log every
 * run never duplicates. Sends made after 2026-09-06 carry our own Message-ID;
 * older ones are keyed by (lead, tier, timestamp), which the log guarantees is
 * unique per send.
 */
export function sendDedupeKey(line: SendLogLine): string {
	if (line.message_id) return line.message_id;
	return `legacy:${line.id}:${line.tier ?? "initial"}:${line.sent_at}`;
}

/**
 * Phase 2 backfill + Phase 3/4 dependency: keeps lg_outreach_send equal to what
 * the live Python sender has actually sent. Read-only against the log file.
 */
@Injectable()
export class SendlogSyncHandler implements LgJobHandler {
	readonly name = "sendlog.sync";

	constructor(@InjectDatabase() private readonly db: Db) {}

	async run(_ctx: LgJobContext): Promise<LgJobResult> {
		const text = await readFile(SEND_LOG_PATH, "utf8");
		const { lines, bad } = parseSendLog(text);
		if (bad > 0) {
			throw new Error(
				`${bad} unparseable line(s) in ${SEND_LOG_PATH}; refusing to sync a log I cannot fully read`,
			);
		}

		const ispTable = MIRROR_TABLES.find((t) => t.key === "isp");
		const leads = await this.db.lgLead.findMany({
			where: {
				nocodbTable: ispTable?.tableId,
				nocodbRowId: { in: [...new Set(lines.map((l) => l.id))] },
			},
			select: { id: true, nocodbRowId: true },
		});
		const leadByRowId = new Map(leads.map((l) => [l.nocodbRowId, l.id]));

		const matched = lines.filter((l) => leadByRowId.has(l.id));
		const unmatched = lines.length - matched.length;

		const keys = matched.map(sendDedupeKey);
		const existing = await this.db.lgOutreachSend.findMany({
			where: { dedupeKey: { in: keys } },
			select: { dedupeKey: true },
		});
		const have = new Set(existing.map((e) => e.dedupeKey));

		const fresh: PrismaNamespace.LgOutreachSendCreateManyInput[] = [];
		for (const line of matched) {
			const key = sendDedupeKey(line);
			const leadId = leadByRowId.get(line.id);
			if (have.has(key) || !leadId) continue;
			fresh.push({
				leadId,
				step: STEP_BY_TIER[line.tier ?? "initial"],
				toAddr: line.email.trim().toLowerCase(),
				subject: line.subject,
				messageId: line.message_id,
				dedupeKey: key,
				sentAt: new Date(line.sent_at),
			});
		}
		if (fresh.length > 0) {
			await this.db.lgOutreachSend.createMany({
				data: fresh,
				skipDuplicates: true,
			});
		}

		const inLedger = await this.db.lgOutreachSend.count({
			where: { dedupeKey: { in: keys } },
		});
		if (inLedger !== matched.length) {
			throw new Error(
				`LEDGER MISMATCH: ${matched.length} sends in the log, ${inLedger} in lg_outreach_send`,
			);
		}
		return {
			counters: {
				logLines: lines.length,
				matchedToLead: matched.length,
				unmatchedLead: unmatched,
				created: fresh.length,
				alreadyInLedger: matched.length - fresh.length,
				inLedger,
			},
		};
	}
}
