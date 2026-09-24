import { z } from "zod";
import { DECISIONS, STAGES } from "./lead-decision.rules";

export const seenInput = z.object({
	updatedAt: z.string().min(1).max(64),
	decision: z.string().max(64).nullable(),
	decisionDate: z.string().max(32).nullable(),
});

export const decideInput = z.object({
	id: z.string().min(1).max(64),
	requestId: z.uuid(),
	stage: z.enum(STAGES),
	decision: z.enum(DECISIONS),
	seen: seenInput,
	confirmArm: z.boolean().default(false),
});

export const reworkInput = z.object({
	id: z.string().min(1).max(64),
	requestId: z.uuid(),
	notes: z.string().trim().min(1).max(5000),
	seen: seenInput,
});

export const decisionResultOutput = z.object({
	auditId: z.string(),
	replay: z.boolean(),
	leadId: z.string(),
	action: z.enum(["DECISION", "REWORK"]),
	decision: z.string().nullable(),
	sendApproved: z.boolean().nullable(),
	decisionDate: z.string().nullable(),
	version: z.string().nullable(),
	reworkRequested: z.boolean(),
	appliedAt: z.string(),
});

export const decisionStatusOutput = z.object({
	youAreApprover: z.boolean(),
	approversConfigured: z.boolean(),
	writeConfigured: z.boolean(),
	writeProblem: z.string().nullable(),
	tokenSource: z.enum(["dedicated", "shared-with-mirror"]).nullable(),
});
