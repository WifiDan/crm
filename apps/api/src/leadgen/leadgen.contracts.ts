import { z } from "zod";
import { listInput } from "../trpc/list-input";

const iso = z.string().nullable();

export const counterValue = z.union([z.number(), z.string()]);
export const countersOutput = z.record(z.string(), counterValue);

export const LEAD_STAGES = [
	"NEW",
	"SCREENED",
	"APPROVED",
	"REJECTED",
	"BUILDING",
	"BUILT",
	"IN_REVIEW",
	"REWORK",
	"READY",
	"SENT",
	"REPLIED",
	"CONVERTED",
	"DEAD",
] as const;

export const jobSummaryOutput = z.object({
	name: z.string(),
	description: z.string().nullable(),
	scheduleKind: z.string(),
	intervalSeconds: z.number().nullable(),
	dailyAt: z.string().nullable(),
	timezone: z.string(),
	enabled: z.boolean(),
	hasHandler: z.boolean(),
	nextRunAt: iso,
	lastRunAt: iso,
	lastStatus: z.string().nullable(),
	lastFinishedAt: iso,
	lastError: z.string().nullable(),
	lastCounters: countersOutput.nullable(),
});

export const jobListOutput = z.object({
	schedulerEnabled: z.boolean(),
	jobs: z.array(jobSummaryOutput),
});

export const jobRunsInput = z.object({
	name: z.string().optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export const jobRunOutput = z.object({
	id: z.string(),
	job: z.string(),
	status: z.string(),
	trigger: z.string(),
	startedAt: z.string(),
	finishedAt: iso,
	error: z.string().nullable(),
	counters: countersOutput.nullable(),
});

export const jobRunsOutput = z.array(jobRunOutput);

export const jobNameInput = z.object({ name: z.string().min(1) });

export const jobRunNowOutput = z.object({
	started: z.boolean(),
	runId: z.string().optional(),
	reason: z.string().optional(),
});

export const jobSetEnabledInput = z.object({
	name: z.string().min(1),
	enabled: z.boolean(),
});

export const okOutput = z.object({ ok: z.boolean() });

export const alertOutput = z.object({
	id: z.string(),
	tier: z.string(),
	key: z.string(),
	message: z.string(),
	createdAt: z.string(),
});

export const alertListOutput = z.array(alertOutput);

export const marketOutput = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.string(),
	status: z.string(),
	leadCount: z.number(),
	dailyProspectCap: z.number(),
});

export const marketListOutput = z.array(marketOutput);

export const leadsListInput = listInput.extend({
	marketId: z.string().optional(),
	stage: z.enum(LEAD_STAGES).optional(),
	table: z.enum(["isp", "gym"]).optional(),
	doNotContact: z.boolean().optional(),
	/** Leave DEAD rows out unless a stage is picked. */
	hideDead: z.boolean().optional(),
});

export const leadRowOutput = z.object({
	id: z.string(),
	table: z.string().nullable(),
	nocodbRowId: z.number().nullable(),
	businessName: z.string(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
	websiteUrl: z.string().nullable(),
	demoUrl: z.string().nullable(),
	stage: z.string(),
	approvalDecision: z.string().nullable(),
	sendApproved: z.boolean(),
	doNotContact: z.boolean(),
	sentAt: iso,
	market: z.string().nullable(),
});

export const leadsListOutput = z.object({
	rows: z.array(leadRowOutput),
	total: z.number(),
	facetCounts: z.record(z.string(), z.record(z.string(), z.number())),
});

export const mirrorStatusOutput = z.object({
	tables: z.array(
		z.object({
			table: z.string(),
			mirroredActive: z.number(),
			missingFromSource: z.number(),
			lastRunSource: z.number().nullable(),
			inSync: z.boolean().nullable(),
		}),
	),
	lastRunAt: iso,
	lastRunStatus: z.string().nullable(),
});
