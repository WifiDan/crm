import { type Db, Prisma } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { paginate } from "../trpc/list-input";
import { slugFromDemoUrl } from "./lead-view";
import {
	type campaignListOutput,
	type leadDetailOutput,
	type reviewListInput,
	type reviewListOutput,
	type triageListInput,
	type triageListOutput,
} from "./lead-views.contracts";
import {
	countRow,
	detailSqlRow,
	keyCountRow,
	reviewSqlRow,
	toDetail,
	toReviewRow,
	toTriageRow,
	triageSqlRow,
} from "./lead-views.rows";
import {
	reviewOrder,
	reviewWhere,
	triageOrder,
	triageWhere,
	VIEW_FILTERS,
} from "./lead-views.sql";
import { MIRROR_TABLES } from "./mirror-map";
import { SiteBuilds } from "./site-builds";

const LEAD_COLUMNS = Prisma.sql`
	l.id, l."nocodbTable", l."nocodbRowId", l."businessName", l.address, l.phone,
	l."websiteUrl", l."qualityScore", l."approvalDecision", l."updatedAt",
	NULLIF(BTRIM(l.raw->>'Source'), '') AS source,
	NULLIF(BTRIM(l.raw->>'Service Type'), '') AS service,
	NULLIF(BTRIM(l.raw->>'Contact Name'), '') AS contact,
	l.raw->>'Quality Notes' AS notes,
	NULLIF(BTRIM(l.raw->>'UpdatedAt'), '') AS version,
	NULLIF(BTRIM(l.raw->>'Decision Date'), '') AS "decisionDate",
	c.name AS campaign, m.name AS market`;

const LEAD_JOINS = Prisma.sql`
	FROM lg_lead l
	LEFT JOIN lg_campaign c ON c.id = l."campaignId"
	LEFT JOIN lg_market m ON m.id = l."marketId"`;

const viewFacetRow = z.object({
	pending: z.number(),
	approved: z.number(),
	rejected: z.number(),
	placeholder: z.number(),
	all: z.number(),
	everything: z.number(),
});

const poolOfTable = (tableId: string) =>
	MIRROR_TABLES.find((t) => t.tableId === tableId)?.key ?? "other";

@Injectable()
export class LeadgenViewsService {
	private readonly builds = new SiteBuilds();

	constructor(@InjectDatabase() private readonly db: Db) {}

	async triageList(
		input: z.infer<typeof triageListInput>,
	): Promise<z.infer<typeof triageListOutput>> {
		const where = triageWhere(input);
		const page = paginate(input);
		const [rows, total, decisions, pools] = await Promise.all([
			this.db.$queryRaw(
				Prisma.sql`SELECT ${LEAD_COLUMNS} ${LEAD_JOINS} WHERE ${where} ORDER BY ${triageOrder(input)} LIMIT ${page.take} OFFSET ${page.skip}`,
			),
			this.count(where),
			this.groupCounts(
				Prisma.sql`COALESCE(l."approvalDecision", 'undecided')`,
				triageWhere(input, "decision"),
			),
			this.groupCounts(
				Prisma.sql`COALESCE(l."nocodbTable", '')`,
				triageWhere(input, "table"),
			),
		]);
		return {
			rows: triageSqlRow.array().parse(rows).map(toTriageRow),
			total,
			facetCounts: {
				decision: { ...decisions, all: sumOf(decisions) },
				table: poolCounts(pools),
			},
		};
	}

	async reviewList(
		input: z.infer<typeof reviewListInput>,
	): Promise<z.infer<typeof reviewListOutput>> {
		const where = reviewWhere(input);
		const page = paginate(input);
		const [rows, total, views, pools] = await Promise.all([
			this.db.$queryRaw(
				Prisma.sql`SELECT ${LEAD_COLUMNS},
					l."demoUrl", l."sendApproved",
					(COALESCE(l.raw->>'Draft Email Subject', '') <> '' AND COALESCE(l.raw->>'Draft Email Body', '') <> '') AS "hasDraft",
					(COALESCE(l.raw->>'Rework Requested', '') <> '') AS "reworkRequested"
					${LEAD_JOINS} WHERE ${where} ORDER BY ${reviewOrder(input)} LIMIT ${page.take} OFFSET ${page.skip}`,
			),
			this.count(where),
			this.viewCounts(reviewWhere(input, "view")),
			this.groupCounts(
				Prisma.sql`COALESCE(l."nocodbTable", '')`,
				reviewWhere(input, "table"),
			),
		]);
		const parsed = reviewSqlRow.array().parse(rows);
		const built = await Promise.all(
			parsed.map((r) => this.builds.kindOf(slugFromDemoUrl(r.demoUrl))),
		);
		return {
			rows: parsed.map((r, i) => toReviewRow(r, built[i] ?? "unknown")),
			total,
			facetCounts: { view: views, table: poolCounts(pools) },
		};
	}

	async leadDetail(id: string): Promise<z.infer<typeof leadDetailOutput>> {
		const rows = await this.db.$queryRaw(
			Prisma.sql`SELECT ${LEAD_COLUMNS},
				l."demoUrl", l.email, l."sendApproved", l."doNotContact", l."dncReason",
				l."hotLead", l."sentAt", l."repliedAt",
				NULLIF(BTRIM(l.raw->>'Draft Email Subject'), '') AS "draftSubject",
				NULLIF(l.raw->>'Draft Email Body', '') AS "draftBody",
				NULLIF(l.raw->>'Rework Notes', '') AS "reworkNotes",
				NULLIF(l.raw->>'Rework Requested', '') AS "reworkRequestedAt"
				${LEAD_JOINS} WHERE l.id = ${id} AND l."mirrorMissingAt" IS NULL`,
		);
		const first = detailSqlRow.array().parse(rows)[0];
		return first ? toDetail(first) : null;
	}

	async campaigns(): Promise<z.infer<typeof campaignListOutput>> {
		return this.db.lgCampaign.findMany({
			orderBy: { name: "asc" },
			select: { id: true, name: true, status: true },
		});
	}

	private async count(where: Prisma.Sql): Promise<number> {
		const rows = await this.db.$queryRaw(
			Prisma.sql`SELECT count(*)::int AS n FROM lg_lead l WHERE ${where}`,
		);
		return countRow.array().parse(rows)[0]?.n ?? 0;
	}

	private async groupCounts(
		key: Prisma.Sql,
		where: Prisma.Sql,
	): Promise<Record<string, number>> {
		const rows = await this.db.$queryRaw(
			Prisma.sql`SELECT ${key} AS k, count(*)::int AS n FROM lg_lead l WHERE ${where} GROUP BY 1`,
		);
		return Object.fromEntries(
			keyCountRow
				.array()
				.parse(rows)
				.map((r) => [r.k, r.n]),
		);
	}

	private async viewCounts(where: Prisma.Sql) {
		const rows = await this.db.$queryRaw(
			Prisma.sql`SELECT
				count(*) FILTER (WHERE ${VIEW_FILTERS.pending})::int AS pending,
				count(*) FILTER (WHERE ${VIEW_FILTERS.approved})::int AS approved,
				count(*) FILTER (WHERE ${VIEW_FILTERS.rejected})::int AS rejected,
				count(*) FILTER (WHERE ${VIEW_FILTERS.placeholder})::int AS placeholder,
				count(*) FILTER (WHERE ${VIEW_FILTERS.all})::int AS "all",
				count(*)::int AS everything
				FROM lg_lead l WHERE ${where}`,
		);
		return viewFacetRow.array().parse(rows)[0] ?? emptyViews;
	}
}

const emptyViews = {
	pending: 0,
	approved: 0,
	rejected: 0,
	placeholder: 0,
	all: 0,
	everything: 0,
};

function sumOf(counts: Record<string, number>): number {
	return Object.values(counts).reduce((a, b) => a + b, 0);
}

function poolCounts(byTableId: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [tableId, n] of Object.entries(byTableId)) {
		const key = poolOfTable(tableId);
		out[key] = (out[key] ?? 0) + n;
	}
	return out;
}
