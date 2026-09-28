import { type Db, type Prisma } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import {
	type ActualSend,
	type CompareResult,
	type CompareStatus,
	compareRun,
	matchStreak,
} from "./outreach-compare";
import type { Candidate, Hold, Tier } from "./outreach-plan";
import { ISP_TABLE_ID } from "./outreach-shadow.handler";
import { SendlogSyncHandler } from "./sendlog-sync.handler";

const TIER_BY_STEP: Record<string, Tier | undefined> = {
	INITIAL: "initial",
	FU1: "fu1",
	FU2: "fu2",
};
const MIN_AGE_MS = 15 * 60_000;
const SEND_WINDOW_BEFORE_MS = 2 * 60_000;
const SEND_WINDOW_AFTER_MS = 45 * 60_000;

/**
 * Phase 4, SHADOW, second half. After the Python sender has run, reads what it actually sent (from
 * its send log, via the ledger) and compares it with the plan outreach.shadow stored. Records the
 * result and, on a mismatch, raises a DIGEST alert. The cutover gate is a run of consecutive matches.
 *
 * Read-only apart from lg_send_shadow_run and lg_alert. It cannot send.
 */
@Injectable()
export class OutreachCompareHandler implements LgJobHandler {
	readonly name = "outreach.shadow.compare";
	private readonly logger = new Logger(OutreachCompareHandler.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly sendlog: SendlogSyncHandler,
	) {}

	async run(ctx: LgJobContext): Promise<LgJobResult> {
		// pull Python's send-log into the ledger first, so "what it sent" is current
		await this.sendlog.run(ctx);

		const runs = await this.db.lgSendShadowRun.findMany({
			where: {
				comparedAt: null,
				late: false,
				asOf: { lt: new Date(Date.now() - MIN_AGE_MS) },
			},
			orderBy: { asOf: "asc" },
			take: 7,
		});
		const c = { compared: 0, match: 0, matchWithTiming: 0, mismatch: 0 };
		for (const r of runs) {
			const result = compareRun({
				cands: r.candidates as unknown as Candidate[],
				hold: (r.hold as unknown as Hold | null) ?? null,
				asOfStart: r.asOf,
				cap: r.cap,
				actual: await this.pythonSends(r.asOf),
			});
			await this.db.lgSendShadowRun.update({
				where: { id: r.id },
				data: {
					compare: result as unknown as Prisma.InputJsonValue,
					comparedAt: new Date(),
				},
			});
			c.compared++;
			if (result.status === "MATCH") c.match++;
			else if (result.status === "MATCH_WITH_TIMING") c.matchWithTiming++;
			else {
				c.mismatch++;
				await this.alert(r.runDate, result);
			}
		}

		const recent = await this.db.lgSendShadowRun.findMany({
			where: { late: false },
			orderBy: { runDate: "desc" },
			take: 14,
			select: { compare: true },
		});
		const streak = matchStreak(
			recent.map(
				(x) => (x.compare as { status?: CompareStatus } | null)?.status ?? null,
			),
		);
		this.logger.log(
			`outreach.shadow.compare ${JSON.stringify({ ...c, streak })}`,
		);
		return { counters: { ...c, matchStreak: streak } };
	}

	/** Python's sends for one morning, in the order it sent them. */
	private async pythonSends(asOf: Date): Promise<ActualSend[]> {
		const rows = await this.db.lgOutreachSend.findMany({
			where: {
				source: "python-send-log",
				sentAt: {
					gte: new Date(asOf.getTime() - SEND_WINDOW_BEFORE_MS),
					lt: new Date(asOf.getTime() + SEND_WINDOW_AFTER_MS),
				},
				lead: { nocodbTable: ISP_TABLE_ID },
			},
			orderBy: { sentAt: "asc" },
			select: {
				step: true,
				sentAt: true,
				lead: { select: { nocodbRowId: true } },
			},
		});
		return rows.flatMap((x) => {
			const tier = TIER_BY_STEP[x.step];
			const id = x.lead.nocodbRowId;
			return tier && id !== null && x.sentAt
				? [{ id, tier, at: x.sentAt }]
				: [];
		});
	}

	private async alert(runDate: string, r: CompareResult): Promise<void> {
		const key = `outreach.shadow.mismatch:${runDate}`;
		const open = await this.db.lgAlert.findFirst({
			where: { key, resolvedAt: null },
		});
		if (open) return;
		const list = (xs: { id: number; tier: string }[]) =>
			xs.map((x) => `${x.tier}:${x.id}`).join(", ") || "none";
		await this.db.lgAlert.create({
			data: {
				tier: "DIGEST",
				key,
				message: `Send shadow ${runDate}: the CRM plan differs from what Python sent. Python only: ${list(r.pythonOnly)}. CRM only: ${list(r.shadowOnly)}. ${r.note}`,
			},
		});
	}
}
