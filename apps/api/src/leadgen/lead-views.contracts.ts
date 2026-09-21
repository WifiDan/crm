import { z } from "zod";
import { listInput } from "../trpc/list-input";

const iso = z.string().nullable();

export const TRIAGE_DECISIONS = [
	"undecided",
	"Approved",
	"Rejected",
	"all",
] as const;

export const REVIEW_VIEWS = [
	"pending",
	"approved",
	"rejected",
	"placeholder",
	"all",
] as const;

export const NO_MARKET = "none";

const pool = z.enum(["isp", "gym"]);

export const triageListInput = listInput.extend({
	decision: z.enum(TRIAGE_DECISIONS).default("undecided"),
	table: pool.optional(),
	campaignId: z.string().optional(),
	marketId: z.string().optional(),
});

export const reviewListInput = listInput.extend({
	view: z.enum(REVIEW_VIEWS).default("pending"),
	table: pool.optional(),
	campaignId: z.string().optional(),
});

export const leadDetailInput = z.object({ id: z.string().min(1) });

const leadIdentity = {
	id: z.string(),
	table: pool.nullable(),
	nocodbRowId: z.number().nullable(),
	businessName: z.string(),
	address: z.string().nullable(),
	phone: z.string().nullable(),
	oldSite: z.string().nullable(),
	score: z.number().nullable(),
	decision: z.string().nullable(),
	source: z.string().nullable(),
	service: z.string().nullable(),
	contact: z.string().nullable(),
	campaign: z.string().nullable(),
	market: z.string().nullable(),
};

export const triageRowOutput = z.object({
	...leadIdentity,
	notes: z.string(),
	notesTruncated: z.boolean(),
	updatedAt: z.string(),
});

export const facetCountsOutput = z.record(
	z.string(),
	z.record(z.string(), z.number()),
);

export const triageListOutput = z.object({
	rows: z.array(triageRowOutput),
	total: z.number(),
	facetCounts: facetCountsOutput,
});

export const qaOutput = z.object({
	status: z.enum(["PASS", "FAIL", "NONE"]),
	failures: z.array(z.string()),
});

export const reviewRowOutput = z.object({
	...leadIdentity,
	demoUrl: z.string().nullable(),
	slug: z.string().nullable(),
	sendApproved: z.boolean(),
	qa: qaOutput,
	placeholder: z.boolean(),
	hasDraft: z.boolean(),
	reworkRequested: z.boolean(),
	build: z.enum(["v2", "v1", "unknown"]),
	updatedAt: z.string(),
});

export const reviewListOutput = z.object({
	rows: z.array(reviewRowOutput),
	total: z.number(),
	facetCounts: facetCountsOutput,
});

export const leadDetailOutput = z
	.object({
		...leadIdentity,
		email: z.string().nullable(),
		demoUrl: z.string().nullable(),
		notes: z.string(),
		notesTruncated: z.boolean(),
		draftSubject: z.string().nullable(),
		draftBody: z.string().nullable(),
		qa: qaOutput,
		placeholder: z.boolean(),
		sendApproved: z.boolean(),
		doNotContact: z.boolean(),
		dncReason: z.string().nullable(),
		hotLead: z.boolean(),
		sentAt: iso,
		repliedAt: iso,
		reworkNotes: z.string().nullable(),
		reworkRequestedAt: z.string().nullable(),
		updatedAt: z.string(),
	})
	.nullable();

export const campaignListOutput = z.array(
	z.object({ id: z.string(), name: z.string(), status: z.string() }),
);
