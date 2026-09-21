import { z } from "zod";
import { DEMO_LIMITS } from "./demo-files";

const leadId = z.string().min(1).max(64);

export const demoInfoInput = z.object({ id: leadId });

export const previewInput = z.object({
	id: leadId,
	edit: z.boolean().default(false),
});

export const saveInput = z.object({
	id: leadId,
	requestId: z.uuid(),
	html: z.string().max(DEMO_LIMITS.maxBytes),
	baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const lastEditOutput = z.object({
	at: z.string(),
	by: z.string().nullable(),
	bytes: z.number(),
	backupName: z.string(),
	status: z.enum(["PENDING", "APPLIED", "FAILED", "UNKNOWN"]),
});

export const demoInfoOutput = z.object({
	hasLocal: z.boolean(),
	slug: z.string().nullable(),
	reason: z.string().nullable(),
	bytes: z.number().nullable(),
	sha256: z.string().nullable(),
	modifiedAt: z.string().nullable(),
	canEdit: z.boolean(),
	editProblem: z.string().nullable(),
	keepBackups: z.number(),
	lastEdit: lastEditOutput.nullable(),
	deployHint: z.string().nullable(),
});

export const previewOutput = z.object({
	path: z.string(),
	mode: z.enum(["view", "edit"]),
	expiresAt: z.string(),
	sha256: z.string(),
});

export const saveOutput = z.object({
	auditId: z.string(),
	replay: z.boolean(),
	slug: z.string(),
	bytes: z.number(),
	sha256: z.string(),
	backupName: z.string(),
	savedAt: z.string(),
	live: z.literal(false),
});
