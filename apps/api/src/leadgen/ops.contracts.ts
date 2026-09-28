import { z } from "zod";
import { listInput } from "../trpc/list-input";

const iso = z.string().nullable();

const pool = z.enum(["isp", "gym"]).nullable();

const counts = z.object({
	total: z.number(),
	pendingTriage: z.number(),
	sideBySideBuilt: z.number(),
	sent: z.number(),
	replied: z.number(),
	awaitingReview: z.number(),
	readyToSend: z.number(),
	callText: z.number(),
	doNotContact: z.number(),
	awaitingBuild: z.number(),
	needsSendApproval: z.number(),
	sendApprovedUnsent: z.number(),
	newNoWebsite: z.number(),
});

const dayCount = z.object({ date: z.string(), count: z.number() });

const standingItem = z.object({
	id: z.string(),
	text: z.string(),
	since: iso,
});

export const opsOverviewOutput = z.object({
	generatedAt: z.string(),
	totals: counts,
	pools: z.array(counts.extend({ table: z.string() })),
	dailySends: z.array(dayCount),
	prospectorYield: z.array(dayCount),
	bySource: z.record(z.string(), z.number()),
	byDecision: z.record(z.string(), z.number()),
	rework: z.object({
		total: z.number(),
		rows: z.array(
			z.object({
				id: z.string(),
				businessName: z.string(),
				notes: z.string().nullable(),
				since: iso,
			}),
		),
	}),
	standing: z.object({
		available: z.boolean(),
		error: z.string().nullable(),
		items: z.array(standingItem),
	}),
});

export const opsHealthOutput = z.object({
	generatedAt: z.string(),
	systemd: z.object({
		available: z.boolean(),
		error: z.string().nullable(),
		units: z.array(
			z.object({
				name: z.string(),
				kind: z.enum(["service", "timer"]),
				description: z.string(),
				activeState: z.string(),
				subState: z.string(),
				result: z.string(),
				exitStatus: z.number().nullable(),
				lastExitAt: iso,
				lastTriggerAt: iso,
				nextRunAt: iso,
			}),
		),
	}),
	checks: z.object({
		available: z.boolean(),
		error: z.string().nullable(),
		items: z.array(
			z.object({
				name: z.string(),
				ok: z.boolean(),
				detail: z.string(),
				since: iso,
			}),
		),
	}),
	crmSync: z.object({
		companyMap: z
			.object({ entries: z.number(), updatedAt: z.string() })
			.nullable(),
		dealQueue: z
			.object({ pending: z.number(), updatedAt: z.string() })
			.nullable(),
		error: z.string().nullable(),
	}),
});

export const opsCallListInput = listInput;

export const opsCallListOutput = z.object({
	rows: z.array(
		z.object({
			id: z.string(),
			table: pool,
			businessName: z.string(),
			phone: z.string().nullable(),
			contact: z.string().nullable(),
		}),
	),
	total: z.number(),
	facetCounts: z.record(z.string(), z.record(z.string(), z.number())),
});

export const opsRecentSendsInput = listInput;

export const opsRecentSendsOutput = z.object({
	rows: z.array(
		z.object({
			id: z.string(),
			leadId: z.string(),
			businessName: z.string(),
			toAddr: z.string(),
			subject: z.string().nullable(),
			step: z.string(),
			sentAt: iso,
			replied: z.boolean(),
			source: z.string(),
		}),
	),
	total: z.number(),
	facetCounts: z.record(z.string(), z.record(z.string(), z.number())),
});
