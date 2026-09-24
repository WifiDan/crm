import { Prisma } from "@crm/db";
import type { z } from "zod";
import { resolveOrderBy, type SortDirection } from "../trpc/list-input";
import { escapeLike } from "./lead-view";
import { LEAD_VIEWS } from "./lead-views.config";
import {
	NO_MARKET,
	type reviewListInput,
	type triageListInput,
} from "./lead-views.contracts";
import { MIRROR_TABLES } from "./mirror-map";

type TriageFilters = z.infer<typeof triageListInput>;
type ReviewFilters = z.infer<typeof reviewListInput>;
type ReviewView = ReviewFilters["view"];

const tableId = (key: "isp" | "gym") =>
	MIRROR_TABLES.find((t) => t.key === key)?.tableId ?? "";

const ACTIVE = Prisma.sql`l."mirrorMissingAt" IS NULL`;

export const PROSPECT = Prisma.sql`l."demoUrl" IS NULL AND l."websiteUrl" IS NOT NULL AND NOT l."doNotContact"`;

export const PAGES_DEMO = Prisma.sql`(l."demoUrl" ~* ${LEAD_VIEWS.pages.legacyPattern} OR l."demoUrl" ~* ${LEAD_VIEWS.pages.sharedPattern})`;

const NOTES = Prisma.sql`COALESCE(l.raw->>'Quality Notes', '')`;

export const PLACEHOLDER = Prisma.sql`strpos(${NOTES}, ${LEAD_VIEWS.placeholderMarker}) > 0`;

const IS_GYM = Prisma.sql`l."nocodbTable" = ${tableId("gym")}`;

const DECISION = Prisma.sql`COALESCE(l."approvalDecision", '')`;

const allOf = (conditions: Prisma.Sql[]) =>
	Prisma.join(
		conditions.map((c) => Prisma.sql`(${c})`),
		" AND ",
	);

function searchCondition(q: string): Prisma.Sql {
	const like = `%${escapeLike(q.trim())}%`;
	return Prisma.sql`l."businessName" ILIKE ${like} OR l.address ILIKE ${like} OR l.email ILIKE ${like}`;
}

function decisionCondition(decision: TriageFilters["decision"]) {
	if (decision === "all") return [];
	if (decision === "undecided")
		return [Prisma.sql`l."approvalDecision" IS NULL`];
	return [Prisma.sql`l."approvalDecision" = ${decision}`];
}

function marketCondition(marketId: string): Prisma.Sql {
	return marketId === NO_MARKET
		? Prisma.sql`l."marketId" IS NULL`
		: Prisma.sql`l."marketId" = ${marketId}`;
}

export function triageWhere(
	filters: TriageFilters,
	omit?: "decision" | "table",
): Prisma.Sql {
	const conditions = [ACTIVE, PROSPECT];
	if (filters.q.trim()) conditions.push(searchCondition(filters.q));
	if (omit !== "decision")
		conditions.push(...decisionCondition(filters.decision));
	if (omit !== "table" && filters.table) {
		conditions.push(Prisma.sql`l."nocodbTable" = ${tableId(filters.table)}`);
	}
	if (filters.campaignId) {
		conditions.push(Prisma.sql`l."campaignId" = ${filters.campaignId}`);
	}
	if (filters.marketId) conditions.push(marketCondition(filters.marketId));
	return allOf(conditions);
}

export function viewCondition(view: ReviewView): Prisma.Sql {
	switch (view) {
		case "pending":
			return Prisma.sql`NOT (${PLACEHOLDER}) AND ((${IS_GYM} AND ${DECISION} NOT IN ('Approved', 'Rejected')) OR (NOT (${IS_GYM}) AND NOT l."sendApproved" AND ${DECISION} <> 'Rejected'))`;
		case "approved":
			return Prisma.sql`NOT (${PLACEHOLDER}) AND ((${IS_GYM} AND ${DECISION} = 'Approved') OR (NOT (${IS_GYM}) AND l."sendApproved"))`;
		case "rejected":
			return Prisma.sql`NOT (${PLACEHOLDER}) AND ${DECISION} = 'Rejected'`;
		case "placeholder":
			return PLACEHOLDER;
		default:
			return Prisma.sql`NOT (${PLACEHOLDER})`;
	}
}

export function reviewWhere(
	filters: ReviewFilters,
	omit?: "view" | "table",
): Prisma.Sql {
	const conditions = [ACTIVE, PAGES_DEMO];
	if (filters.q.trim()) conditions.push(searchCondition(filters.q));
	if (omit !== "view") conditions.push(viewCondition(filters.view));
	if (omit !== "table" && filters.table) {
		conditions.push(Prisma.sql`l."nocodbTable" = ${tableId(filters.table)}`);
	}
	if (filters.campaignId) {
		conditions.push(Prisma.sql`l."campaignId" = ${filters.campaignId}`);
	}
	return allOf(conditions);
}

const direction = (dir: SortDirection) =>
	dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;

const TIE = Prisma.sql`l."businessName" ASC, l.id ASC`;

type OrderInput = { sort: string; dir: SortDirection };

type OrderColumns = Record<string, (dir: SortDirection) => Prisma.Sql>;

function pickOrder(
	input: OrderInput,
	columns: OrderColumns,
	fallback: Prisma.Sql,
): Prisma.Sql {
	if (!Object.hasOwn(columns, input.sort)) return fallback;
	return resolveOrderBy(input, columns, fallback);
}

export function triageOrder(input: OrderInput): Prisma.Sql {
	return pickOrder(
		input,
		{
			score: (dir) =>
				Prisma.sql`l."qualityScore" ${direction(dir)} NULLS LAST, ${TIE}`,
			businessName: (dir) =>
				Prisma.sql`l."businessName" ${direction(dir)}, l.id ASC`,
			updatedAt: (dir) => Prisma.sql`l."updatedAt" ${direction(dir)}, ${TIE}`,
		},
		Prisma.sql`l."qualityScore" ASC NULLS LAST, ${TIE}`,
	);
}

export function reviewOrder(input: OrderInput): Prisma.Sql {
	return pickOrder(
		input,
		{
			businessName: (dir) =>
				Prisma.sql`l."businessName" ${direction(dir)}, l.id ASC`,
			updatedAt: (dir) => Prisma.sql`l."updatedAt" ${direction(dir)}, ${TIE}`,
			score: (dir) =>
				Prisma.sql`l."qualityScore" ${direction(dir)} NULLS LAST, ${TIE}`,
		},
		Prisma.sql`l."businessName" ASC, l.id ASC`,
	);
}

export const VIEW_FILTERS: Record<ReviewView, Prisma.Sql> = {
	pending: viewCondition("pending"),
	approved: viewCondition("approved"),
	rejected: viewCondition("rejected"),
	placeholder: viewCondition("placeholder"),
	all: viewCondition("all"),
};
