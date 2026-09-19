import { type Db, type Prisma as PrismaNamespace } from "@crm/db";
import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { paginate } from "../trpc/list-input";
import { LgJobSchedulerService } from "./job-scheduler.service";
import type {
	alertListOutput,
	jobListOutput,
	jobRunsOutput,
	leadsListInput,
	leadsListOutput,
	marketListOutput,
	mirrorStatusOutput,
} from "./leadgen.contracts";
import { MIRROR_TABLES } from "./mirror-map";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const asRecord = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;

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
					lastCounters: asRecord(last?.counters),
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
			counters: asRecord(r.counters),
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
		const tableId = input.table
			? MIRROR_TABLES.find((t) => t.key === input.table)?.tableId
			: undefined;
		const where: PrismaNamespace.LgLeadWhereInput = {
			mirrorMissingAt: null,
			...(input.marketId ? { marketId: input.marketId } : {}),
			...(input.stage ? { stage: input.stage as never } : {}),
			...(tableId ? { nocodbTable: tableId } : {}),
			...(input.doNotContact !== undefined
				? { doNotContact: input.doNotContact }
				: {}),
			...(input.q
				? {
						OR: [
							{ businessName: { contains: input.q, mode: "insensitive" } },
							{ email: { contains: input.q, mode: "insensitive" } },
							{ address: { contains: input.q, mode: "insensitive" } },
						],
					}
				: {}),
		};
		const sortable: Record<
			string,
			PrismaNamespace.LgLeadOrderByWithRelationInput
		> = {
			businessName: { businessName: input.dir },
			stage: { stage: input.dir },
			sentAt: { sentAt: input.dir },
			updatedAt: { updatedAt: input.dir },
		};
		const orderBy = sortable[input.sort] ?? { businessName: "asc" };
		const [rows, total, stageGroups] = await Promise.all([
			this.db.lgLead.findMany({
				where,
				orderBy,
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
		const counters = asRecord(lastRun?.counters);
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
				const src = counters?.[`${t.key}.source`];
				const lastRunSource = typeof src === "number" ? src : null;
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
