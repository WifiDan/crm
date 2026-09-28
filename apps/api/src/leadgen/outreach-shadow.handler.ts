import { type Db, type Prisma } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import { MIRROR_TABLES } from "./mirror-map";
import { NocodbMirrorHandler } from "./nocodb-mirror.handler";
import {
	buildCandidates,
	checkInterlocks,
	DEFAULT_CAP,
	type NocoRow,
	planBatch,
	poolsAt,
} from "./outreach-plan";
import { loadPythonSendState } from "./python-state";
import { nextDailyRun } from "./schedule";

export const ISP_TABLE_ID = MIRROR_TABLES.find((t) => t.key === "isp")
	?.tableId as string;
const TZ = "America/Denver";

/** The Denver calendar date of an instant, as YYYY-MM-DD. */
export function denverDate(d: Date): string {
	return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * Phase 4, SHADOW. Every morning shortly before the Python sender fires, computes exactly which
 * rows the CRM WOULD email (same eligibility, holds, ordering and cap as send_daily_batch.py) and
 * stores the plan. outreach.shadow.compare later checks it against what Python actually sent.
 *
 * It cannot send: there is no mail code here (leadgen-no-send.spec.ts) and it writes nothing
 * outside lg_send_shadow_run. The mirror it runs first only READS NocoDB.
 */
@Injectable()
export class OutreachShadowHandler implements LgJobHandler {
	readonly name = "outreach.shadow";
	private readonly logger = new Logger(OutreachShadowHandler.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly mirror: NocodbMirrorHandler,
	) {}

	async run(ctx: LgJobContext): Promise<LgJobResult> {
		// a fresh read of NocoDB so the plan is made from data seconds old, not up to 15 minutes old
		await this.mirror.run(ctx);

		const now = new Date();
		const cap = Number(process.env.LEADGEN_SEND_CAP ?? DEFAULT_CAP);
		const sendTime = process.env.LEADGEN_SEND_TIME ?? "08:30";
		// the first send time not more than 30 minutes ago: a slightly late run still plans TODAY's send
		const asOf = nextDailyRun(
			new Date(now.getTime() - 30 * 60_000),
			sendTime,
			TZ,
		);
		const late = now.getTime() > asOf.getTime();
		const runDate = denverDate(asOf);

		const prior = await this.db.lgSendShadowRun.findUnique({
			where: { runDate },
			select: { comparedAt: true },
		});
		if (prior?.comparedAt) {
			return { counters: { runDate, skipped: "already compared" } };
		}

		const leads = await this.db.lgLead.findMany({
			where: { nocodbTable: ISP_TABLE_ID, mirrorMissingAt: null },
			select: { nocodbRowId: true, raw: true },
		});
		const rows: NocoRow[] = leads.flatMap((l) =>
			l.nocodbRowId !== null && l.raw && typeof l.raw === "object"
				? [{ ...(l.raw as Record<string, unknown>), Id: l.nocodbRowId }]
				: [],
		);

		const state = await loadPythonSendState(now);
		const hold = checkInterlocks(state);
		const candidates = hold ? [] : buildCandidates(rows, state);
		const planned = hold ? [] : planBatch(candidates, asOf, cap);
		const pools = poolsAt(candidates, asOf);

		// an uncompared run for this date is simply recomputed: delete and recreate, so a stale hold cannot linger
		await this.db.lgSendShadowRun.deleteMany({
			where: { runDate, comparedAt: null },
		});
		await this.db.lgSendShadowRun.create({
			data: {
				runDate,
				asOf,
				late,
				cap,
				hold: (hold ?? undefined) as Prisma.InputJsonValue | undefined,
				candidates: candidates as unknown as Prisma.InputJsonValue,
				planned: planned as unknown as Prisma.InputJsonValue,
				computedAt: now,
			},
		});

		const counters = {
			runDate,
			asOf: asOf.toISOString(),
			late: late ? 1 : 0,
			mirroredRows: rows.length,
			held: hold ? 1 : 0,
			candidates: candidates.length,
			initialPool: pools.initial.length,
			fu1Pool: pools.fu1.length,
			fu2Pool: pools.fu2.length,
			plannedSends: planned.length,
			cap,
		};
		this.logger.log(`outreach.shadow ${JSON.stringify(counters)}`);
		return { counters };
	}
}
