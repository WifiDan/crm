import { z } from "zod";

const leadId = z.string().min(1).max(64);

export const shotStatusInput = z.object({ id: leadId });

export const shotCaptureInput = z.object({
	id: leadId,
	force: z.boolean().default(false),
});

export const shotStatusOutput = z.object({
	available: z.boolean(),
	unavailableReason: z.string().nullable(),
	cached: z.boolean(),
	capturedAt: z.string().nullable(),
	stale: z.boolean(),
	url: z.string().nullable(),
});

export const shotCaptureOutput = z.object({
	capturedAt: z.string(),
	fromCache: z.boolean(),
	stale: z.boolean(),
	url: z.string(),
	finalUrl: z.string().nullable(),
	httpStatus: z.number().nullable(),
	bytes: z.number(),
	note: z.string().nullable(),
});
