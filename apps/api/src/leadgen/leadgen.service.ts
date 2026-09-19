import { type Db, type Prisma as PrismaNamespace } from "@crm/db";
import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { paginate, type SortDirection } from "../trpc/list-input";
import { LgJobSchedulerService } from "./job-scheduler.service";
import {
	type alertListOutput,
	countersOutput,
	type jobListOutput,
	type jobRunsOutput,
	type leadsListInput,
	type leadsListOutput,
	type marketListOutput,
	type mirrorStatusOutput,
} from "./leadgen.contracts";
import { MIRROR_TABLES } from "./mirror-map";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function parseCounters(
	value: PrismaNamespace.JsonValue | undefined,
): z.infer<typeof countersOutput> | null {
	const parsed = countersOutput.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function leadOrderBy(
	sort: string,
	dir: SortDirection,
): PrismaNamespace.LgLeadOrderByWithRelationInput {
	switch (sort) {
		case "stage":
			return { stage: dir };
		case "sentAt":
			return { sentAt: dir };
		case "updatedAt":
			return { updatedAt: dir };
		default:
			return { businessName: sort === "businessName" ? dir : "asc" };
	}
}

@Injectable()
export class LeadgenService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly scheduler: LgJobSchedulerService,
	) {}

	async listJobs(): Promise<z.infer<typeof jobListOutput>> {
		const defs = await this.db.lgJobDefinition.findMany({
			orderBy: { name: "asc" },
		});
		const handlers = new Set(this.scheduler.registeredHandlers());
		const jobs = await Promise.all(
			defs.map(async (d) => {
				const last = await this.db.lgJobRun.findFirst({
					where: { jobId: d.id },
					orderBy: { startedAt: "desc" },
				});
				return {
					name: d.name,
					description: d.description,
					scheduleKind: d.scheduleKind,
					intervalSeconds: d.intervalSeconds,
					dailyAt: d.dailyAt,
					timezone: d.timezone,
					enabled: d.enabled,
					hasHandler: handlers.has(d.name),
					nextRunAt: iso(d.nextRunAt),
					lastRunAt: iso(d.lastRunAt),
					lastStatus: last?.status ?? null,
					lastFinishedAt: iso(last?.finishedAt),
					lastError: last?.error ?? null,
					lastCounters: parseCounters(last?.counters),
				};
			}),
		);
		return {
			schedulerEnabled: process.env.LEADGEN_SCHEDULER_ENABLED === "true",
			jobs,
		};
	}

	async listRuns(
		name: string | undefined,
		limit: number,
	): Promise<z.infer<typeof jobRunsOutput>> {
		const runs = await this.db.lgJobRun.findMany({
			where: name ? { job: { name } } : undefined,
			orderBy: { startedAt: "desc" },
			take: limit,
			include: { job: { select: { name: true } } },
		});
		return runs.map((r) => ({
			id: r.id,
			job: r.job.name,
			status: r.status,
			trigger: r.trigger,
			startedAt: r.startedAt.toISOString(),
			finishedAt: iso(r.finishedAt),
			error: r.error,
			counters: parseCounters(r.counters),
		}));
	}

	async setEnabled(name: string, enabled: boolean): Promise<boolean> {
		const res = await this.db.lgJobDefinition.updateMany({
			where: { name },
			data: { enabled },
		});
		return res.count > 0;
	}

	async listAlerts(): Promise<z.infer<typeof alertListOutput>> {
		const alerts = await this.db.lgAlert.findMany({
			where: { resolvedAt: null },
			orderBy: { createdAt: "desc" },
			take: 100,
		});
		return alerts.map((a) => ({
			id: a.id,
			tier: a.tier,
			key: a.key,
			message: a.message,
			createdAt: a.createdAt.toISOString(),
		}));
	}

	async listMarkets(): Promise<z.infer<typeof marketListOutput>> {
		const markets = await this.db.lgMarket.findMany({
			orderBy: { name: "asc" },
			include: { _count: { select: { leads: true } } },
		});
		return markets.map((m) => ({
			id: m.id,
			name: m.name,
			kind: m.kind,
			status: m.status,
			leadCount: m._count.leads,
			dailyProspectCap: m.dailyProspectCap,
		}));
	}

	async listLeads(
		input: z.infer<typeof leadsListInput>,
	): Promise<z.infer<typeof leadsListOutput>> {
		const where: PrismaNamespace.LgLeadWhereInput = { mirrorMissingAt: null };
		if (input.marketId) where.marketId = input.marketId;
		if (input.stage) where.stage = input.stage;
		if (input.table) {
			where.nocodbTable = MIRROR_TABLES.find(
				(t) => t.key === input.table,
			)?.tableId;
		}
		if (input.doNotContact !== undefined) {
			where.doNotContact = input.doNotContact;
		}
		if (input.q) {
			where.OR = [
				{ businessName: { contains: input.q, mode: "insensitive" } },
				{ email: { contains: input.q, mode: "insensitive" } },
				{ address: { contains: input.q, mode: "insensitive" } },
			];
		}
		const [rows, total, stageGroups] = await Promise.all([
			this.db.lgLead.findMany({
				where,
				orderBy: leadOrderBy(input.sort, input.dir),
				...paginate(input),
				include: { market: { select: { name: true } } },
			}),
			this.db.lgLead.count({ where }),
			this.db.lgLead.groupBy({
				by: ["stage"],
				where,
				_count: { _all: true },
			}),
		]);
		const tableKey = (id: string | null) =>
			MIRROR_TABLES.find((t) => t.tableId === id)?.key ?? null;
		return {
			rows: rows.map((r) => ({
				id: r.id,
				table: tableKey(r.nocodbTable),
				nocodbRowId: r.nocodbRowId,
				businessName: r.businessName,
				email: r.email,
				phone: r.phone,
				websiteUrl: r.websiteUrl,
				demoUrl: r.demoUrl,
				stage: r.stage,
				approvalDecision: r.approvalDecision,
				sendApproved: r.sendApproved,
				doNotContact: r.doNotContact,
				sentAt: iso(r.sentAt),
				market: r.market?.name ?? null,
			})),
			total,
			facetCounts: {
				stage: Object.fromEntries(
					stageGroups.map((g) => [g.stage, g._count._all]),
				),
			},
		};
	}

	async mirrorStatus(): Promise<z.infer<typeof mirrorStatusOutput>> {
		const def = await this.db.lgJobDefinition.findUnique({
			where: { name: "nocodb.mirror" },
		});
		const lastRun = def
			? await this.db.lgJobRun.findFirst({
					where: { jobId: def.id, status: { in: ["OK", "FAILED"] } },
					orderBy: { startedAt: "desc" },
				})
			: null;
		const counters = parseCounters(lastRun?.counters);
		const tables = await Promise.all(
			MIRROR_TABLES.map(async (t) => {
				const [active, missing] = await Promise.all([
					this.db.lgLead.count({
						where: { nocodbTable: t.tableId, mirrorMissingAt: null },
					}),
					this.db.lgLead.count({
						where: { nocodbTable: t.tableId, mirrorMissingAt: { not: null } },
					}),
				]);
				const src = Number(counters?.[`${t.key}.source`]);
				const lastRunSource = Number.isFinite(src) ? src : null;
				return {
					table: t.key,
					mirroredActive: active,
					missingFromSource: missing,
					lastRunSource,
					inSync: lastRunSource === null ? null : lastRunSource === active,
				};
			}),
		);
		return {
			tables,
			lastRunAt: iso(lastRun?.finishedAt),
			lastRunStatus: lastRun?.status ?? null,
		};
	}
}
