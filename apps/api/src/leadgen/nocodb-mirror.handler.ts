import { type Db, type Prisma as PrismaNamespace } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import {
	hashRow,
	MIRROR_TABLES,
	type MirrorTable,
	type NocoRow,
	nocoRowSchema,
	type RawRow,
	rawRowSchema,
	toLeadFields,
} from "./mirror-map";

const PAGE_SIZE = 200;
const CREATE_CHUNK = 200;
const UPDATE_CHUNK = 25;

const SOURCE_MARKETS = new Map([
	["PV-UISP", "Plateau Valley"],
	["Montrose-Azotel", "Montrose"],
]);

const pageSchema = z.object({
	list: z.array(rawRowSchema).default([]),
	pageInfo: z.object({
		totalRows: z.number(),
		isLastPage: z.boolean().optional(),
	}),
});

type SourceRow = { raw: RawRow; row: NocoRow };

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

/**
 * Phase 2: one-way, READ-ONLY mirror of the two NocoDB lead tables into
 * lg_lead. NocoDB stays the writer; nothing here writes back. After every
 * table the job asserts live row count == NocoDB's own reported total, so the
 * "dashboard silently truncated 992 rows to 200" class of bug fails the run
 * loudly instead of drifting.
 */
@Injectable()
export class NocodbMirrorHandler implements LgJobHandler {
	readonly name = "nocodb.mirror";

	constructor(@InjectDatabase() private readonly db: Db) {}

	async run(ctx: LgJobContext): Promise<LgJobResult> {
		const base = process.env.NOCODB_URL;
		const token = process.env.NOCODB_LEADS_TOKEN;
		if (!base || !token) {
			throw new Error(
				"NOCODB_URL and NOCODB_LEADS_TOKEN must be set for nocodb.mirror",
			);
		}

		const [gymsMarket, plateau, montrose, ispCampaign, gymCampaign] =
			await Promise.all([
				this.db.lgMarket.findFirst({ where: { name: "Gyms (nationwide)" } }),
				this.db.lgMarket.findFirst({ where: { name: "Plateau Valley" } }),
				this.db.lgMarket.findFirst({ where: { name: "Montrose" } }),
				this.db.lgCampaign.findUnique({ where: { name: "ISP facelift" } }),
				this.db.lgCampaign.findUnique({ where: { name: "Gym bundle" } }),
			]);
		const marketByName = new Map([
			["Plateau Valley", plateau?.id],
			["Montrose", montrose?.id],
		]);

		const counters: Record<string, number | string> = {};
		const now = new Date();

		for (const table of MIRROR_TABLES) {
			const { rows, totalRows } = await this.fetchAll(
				base,
				token,
				table,
				ctx.signal,
			);
			if (rows.length !== totalRows) {
				throw new Error(
					`${table.key}: fetched ${rows.length} rows but NocoDB reports ${totalRows} (pagination bug?)`,
				);
			}
			const ids = new Set(rows.map((r) => r.row.Id));
			if (ids.size !== rows.length) {
				throw new Error(`${table.key}: duplicate Id values in NocoDB response`);
			}

			const existing = await this.db.lgLead.findMany({
				where: { nocodbTable: table.tableId },
				select: {
					id: true,
					nocodbRowId: true,
					rawHash: true,
					mirrorMissingAt: true,
				},
			});
			const byRowId = new Map(existing.map((e) => [e.nocodbRowId, e]));

			const toCreate: PrismaNamespace.LgLeadCreateManyInput[] = [];
			const toUpdate: {
				id: string;
				data: PrismaNamespace.LgLeadUpdateInput;
			}[] = [];
			let unchanged = 0;

			for (const { raw, row } of rows) {
				const hash = hashRow(raw);
				const fields = toLeadFields(row, table);
				const marketId =
					table.key === "gym"
						? gymsMarket?.id
						: marketByName.get(SOURCE_MARKETS.get(row.Source ?? "") ?? "");
				const campaignId =
					table.key === "gym" ? gymCampaign?.id : ispCampaign?.id;
				const current = byRowId.get(row.Id);
				if (!current) {
					toCreate.push({
						...fields,
						marketId,
						campaignId,
						nocodbTable: table.tableId,
						nocodbRowId: row.Id,
						raw,
						rawHash: hash,
						mirroredAt: now,
					});
				} else if (current.rawHash !== hash || current.mirrorMissingAt) {
					const data: PrismaNamespace.LgLeadUpdateInput = {
						...fields,
						raw,
						rawHash: hash,
						mirroredAt: now,
						mirrorMissingAt: null,
					};
					if (marketId) data.market = { connect: { id: marketId } };
					if (campaignId) data.campaign = { connect: { id: campaignId } };
					toUpdate.push({ id: current.id, data });
				} else {
					unchanged++;
				}
			}

			for (const batch of chunks(toCreate, CREATE_CHUNK)) {
				await this.db.lgLead.createMany({ data: batch });
			}
			for (const batch of chunks(toUpdate, UPDATE_CHUNK)) {
				await Promise.all(
					batch.map((u) =>
						this.db.lgLead.update({ where: { id: u.id }, data: u.data }),
					),
				);
			}

			const missingIds = existing
				.filter((e) => !ids.has(Number(e.nocodbRowId)) && !e.mirrorMissingAt)
				.map((e) => e.id);
			if (missingIds.length > 0) {
				await this.db.lgLead.updateMany({
					where: { id: { in: missingIds } },
					data: { mirrorMissingAt: now },
				});
			}

			const active = await this.db.lgLead.count({
				where: { nocodbTable: table.tableId, mirrorMissingAt: null },
			});
			counters[`${table.key}.source`] = totalRows;
			counters[`${table.key}.mirrored`] = active;
			counters[`${table.key}.created`] = toCreate.length;
			counters[`${table.key}.updated`] = toUpdate.length;
			counters[`${table.key}.unchanged`] = unchanged;
			counters[`${table.key}.missing`] = missingIds.length;
			if (active !== totalRows) {
				throw new Error(
					`${table.key}: COUNT MISMATCH — mirror has ${active} active rows, NocoDB has ${totalRows}`,
				);
			}
		}
		return { counters };
	}

	private async fetchAll(
		base: string,
		token: string,
		table: MirrorTable,
		signal: AbortSignal,
	): Promise<{ rows: SourceRow[]; totalRows: number }> {
		const rows: SourceRow[] = [];
		let totalRows = 0;
		let offset = 0;
		for (;;) {
			const url = `${base.replace(/\/$/, "")}/api/v2/tables/${table.tableId}/records?limit=${PAGE_SIZE}&offset=${offset}`;
			const res = await fetch(url, { headers: { "xc-token": token }, signal });
			if (!res.ok) {
				throw new Error(
					`NocoDB ${table.key} page at offset ${offset} returned HTTP ${res.status}`,
				);
			}
			const page = pageSchema.parse(await res.json());
			totalRows = page.pageInfo.totalRows;
			for (const raw of page.list) {
				const parsed = nocoRowSchema.safeParse(raw);
				if (!parsed.success) {
					throw new Error(
						`${table.key}: row failed the mirror contract: ${parsed.error.message.slice(0, 300)}`,
					);
				}
				rows.push({ raw, row: parsed.data });
			}
			if (page.list.length === 0 || page.pageInfo.isLastPage) break;
			offset += PAGE_SIZE;
		}
		return { rows, totalRows };
	}
}
