import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { type Db, Prisma } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { paginate } from "../trpc/list-input";
import { escapeLike, poolKey } from "./lead-view";
import { LEAD_VIEWS } from "./lead-views.config";
import { countRow, keyCountRow } from "./lead-views.rows";
import { MIRROR_TABLES } from "./mirror-map";
import {
	type opsCallListInput,
	type opsCallListOutput,
	type opsHealthOutput,
	type opsOverviewOutput,
	type opsRecentSendsInput,
	type opsRecentSendsOutput,
} from "./ops.contracts";
import {
	ACTIVE_LEAD,
	BY_DECISION,
	BY_SOURCE,
	CALL_TEXT,
	DAILY_SENDS,
	POOL_COUNTS,
	PROSPECTOR_YIELD,
	REWORK_COUNT,
	reworkRows,
} from "./ops.sql";
import {
	countCompanyMap,
	countQueueLines,
	type HealthCheck,
	parseHealthState,
	parseStandingTasks,
	parseSystemctlShow,
	parseUnitNames,
	type StandingItem,
	type UnitStatus,
} from "./ops-health";

const run = promisify(execFile);

const poolRow = z.object({
	k: z.string(),
	total: z.number(),
	pendingTriage: z.number(),
	sideBySideBuilt: z.number(),
	sent: z.number(),
	replied: z.number(),
	awaitingReview: z.number(),
	readyToSend: z.number(),
	callText: z.number(),
	doNotContact: z.number(),
});

const reworkRow = z.object({
	id: z.string(),
	businessName: z.string(),
	notes: z.string().nullable(),
	since: z.string().nullable(),
});

const callRow = z.object({
	id: z.string(),
	nocodbTable: z.string().nullable(),
	businessName: z.string(),
	phone: z.string().nullable(),
	contact: z.string().nullable(),
});

type Counts = Omit<z.infer<typeof poolRow>, "k">;

const COUNT_KEYS = [
	"total",
	"pendingTriage",
	"sideBySideBuilt",
	"sent",
	"replied",
	"awaitingReview",
	"readyToSend",
	"callText",
	"doNotContact",
] as const;

function sumCounts(rows: Counts[]): Counts {
	const totals: Counts = {
		total: 0,
		pendingTriage: 0,
		sideBySideBuilt: 0,
		sent: 0,
		replied: 0,
		awaitingReview: 0,
		readyToSend: 0,
		callText: 0,
		doNotContact: 0,
	};
	for (const row of rows) {
		for (const key of COUNT_KEYS) totals[key] += row[key];
	}
	return totals;
}

const asRecord = (rows: z.infer<typeof keyCountRow>[]) =>
	Object.fromEntries(rows.map((r) => [r.k, r.n]));

const asSeries = (rows: z.infer<typeof keyCountRow>[]) =>
	rows.map((r) => ({ date: r.k, count: r.n }));

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

async function readOptional(path: string) {
	try {
		const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		return { raw, updatedAt: info.mtime.toISOString() };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function systemctlEnv(): NodeJS.ProcessEnv {
	const uid = process.getuid?.();
	return {
		...process.env,
		XDG_RUNTIME_DIR:
			process.env.XDG_RUNTIME_DIR ??
			(uid === undefined ? undefined : `/run/user/${uid}`),
	};
}

async function systemctl(args: string[]): Promise<string> {
	const { stdout } = await run(
		"systemctl",
		["--user", "--timestamp=unix", ...args],
		{
			env: systemctlEnv(),
			timeout: LEAD_VIEWS.systemd.timeoutMs,
			maxBuffer: LEAD_VIEWS.systemd.maxBufferBytes,
		},
	);
	return stdout;
}

@Injectable()
export class LeadgenOpsService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async overview(): Promise<z.infer<typeof opsOverviewOutput>> {
		const [pools, sources, decisions, sends, yields, reworkTotal, rework] =
			await Promise.all([
				this.db.$queryRaw(POOL_COUNTS),
				this.db.$queryRaw(BY_SOURCE),
				this.db.$queryRaw(BY_DECISION),
				this.db.$queryRaw(DAILY_SENDS),
				this.db.$queryRaw(PROSPECTOR_YIELD),
				this.db.$queryRaw(REWORK_COUNT),
				this.db.$queryRaw(reworkRows(LEAD_VIEWS.reworkLimit)),
			]);
		const poolList = poolRow.array().parse(pools);
		const kv = keyCountRow.array();
		return {
			generatedAt: new Date().toISOString(),
			totals: sumCounts(poolList),
			pools: poolList.map(({ k, ...counts }) => ({
				table: poolKey(k, MIRROR_TABLES) ?? "other",
				...counts,
			})),
			dailySends: asSeries(kv.parse(sends)),
			prospectorYield: asSeries(kv.parse(yields)),
			bySource: asRecord(kv.parse(sources)),
			byDecision: asRecord(kv.parse(decisions)),
			rework: {
				total: countRow.array().parse(reworkTotal)[0]?.n ?? 0,
				rows: reworkRow.array().parse(rework),
			},
			standing: await this.standingTasks(),
		};
	}

	async callList(
		input: z.infer<typeof opsCallListInput>,
	): Promise<z.infer<typeof opsCallListOutput>> {
		const like = `%${escapeLike(input.q.trim())}%`;
		const search =
			input.q.trim() === ""
				? Prisma.sql`TRUE`
				: Prisma.sql`l."businessName" ILIKE ${like} OR l.phone ILIKE ${like}`;
		const where = Prisma.sql`${ACTIVE_LEAD} AND (${CALL_TEXT}) AND (${search})`;
		const page = paginate(input);
		const [rows, total] = await Promise.all([
			this.db.$queryRaw(
				Prisma.sql`SELECT l.id, l."nocodbTable", l."businessName", l.phone,
					NULLIF(BTRIM(l.raw->>'Contact Name'), '') AS contact
					FROM lg_lead l WHERE ${where}
					ORDER BY l."businessName" ASC, l.id ASC LIMIT ${page.take} OFFSET ${page.skip}`,
			),
			this.db.$queryRaw(
				Prisma.sql`SELECT count(*)::int AS n FROM lg_lead l WHERE ${where}`,
			),
		]);
		return {
			rows: callRow
				.array()
				.parse(rows)
				.map((r) => ({
					id: r.id,
					table: poolKey(r.nocodbTable, MIRROR_TABLES),
					businessName: r.businessName,
					phone: r.phone,
					contact: r.contact,
				})),
			total: countRow.array().parse(total)[0]?.n ?? 0,
			facetCounts: {},
		};
	}

	async recentSends(
		input: z.infer<typeof opsRecentSendsInput>,
	): Promise<z.infer<typeof opsRecentSendsOutput>> {
		const q = input.q.trim();
		const where: Prisma.LgOutreachSendWhereInput = {
			sentAt: { not: null },
			...(q
				? {
						OR: [
							{ toAddr: { contains: q, mode: "insensitive" } },
							{ subject: { contains: q, mode: "insensitive" } },
							{
								lead: { businessName: { contains: q, mode: "insensitive" } },
							},
						],
					}
				: {}),
		};
		const [rows, total] = await Promise.all([
			this.db.lgOutreachSend.findMany({
				where,
				orderBy: [{ sentAt: "desc" }, { id: "asc" }],
				...paginate(input),
				include: { lead: { select: { businessName: true, repliedAt: true } } },
			}),
			this.db.lgOutreachSend.count({ where }),
		]);
		return {
			rows: rows.map((r) => ({
				id: r.id,
				leadId: r.leadId,
				businessName: r.lead.businessName,
				toAddr: r.toAddr,
				subject: r.subject,
				step: r.step,
				sentAt: r.sentAt ? r.sentAt.toISOString() : null,
				replied: r.lead.repliedAt !== null,
				source: r.source,
			})),
			total,
			facetCounts: {},
		};
	}

	async health(): Promise<z.infer<typeof opsHealthOutput>> {
		const [systemd, checks, crmSync] = await Promise.all([
			this.systemdUnits(),
			this.healthChecks(),
			this.crmSync(),
		]);
		return { generatedAt: new Date().toISOString(), systemd, checks, crmSync };
	}

	private async standingTasks(): Promise<{
		available: boolean;
		error: string | null;
		items: StandingItem[];
	}> {
		try {
			const file = await readOptional(LEAD_VIEWS.files.standingTasks);
			if (!file) return { available: false, error: null, items: [] };
			return {
				available: true,
				error: null,
				items: parseStandingTasks(file.raw),
			};
		} catch (error) {
			return { available: false, error: message(error), items: [] };
		}
	}

	private async systemdUnits(): Promise<{
		available: boolean;
		error: string | null;
		units: UnitStatus[];
	}> {
		try {
			const listing = await systemctl([
				"list-units",
				"--all",
				"--plain",
				"--no-legend",
				`--type=${LEAD_VIEWS.systemd.unitTypes}`,
				...LEAD_VIEWS.systemd.unitPatterns,
			]);
			const names = parseUnitNames(listing);
			if (names.length === 0) {
				return { available: true, error: null, units: [] };
			}
			const shown = await systemctl([
				"show",
				...names,
				...LEAD_VIEWS.systemd.properties.flatMap((p) => ["-p", p]),
			]);
			return { available: true, error: null, units: parseSystemctlShow(shown) };
		} catch (error) {
			return { available: false, error: message(error), units: [] };
		}
	}

	private async healthChecks(): Promise<{
		available: boolean;
		error: string | null;
		items: HealthCheck[];
	}> {
		try {
			const file = await readOptional(LEAD_VIEWS.files.healthState);
			if (!file) return { available: false, error: null, items: [] };
			return {
				available: true,
				error: null,
				items: parseHealthState(file.raw),
			};
		} catch (error) {
			return { available: false, error: message(error), items: [] };
		}
	}

	private async crmSync(): Promise<z.infer<typeof opsHealthOutput>["crmSync"]> {
		try {
			const [map, queue] = await Promise.all([
				readOptional(LEAD_VIEWS.files.companyMap),
				readOptional(LEAD_VIEWS.files.dealQueue),
			]);
			return {
				companyMap: map
					? { entries: countCompanyMap(map.raw), updatedAt: map.updatedAt }
					: null,
				dealQueue: queue
					? { pending: countQueueLines(queue.raw), updatedAt: queue.updatedAt }
					: null,
				error: null,
			};
		} catch (error) {
			return { companyMap: null, dealQueue: null, error: message(error) };
		}
	}
}
