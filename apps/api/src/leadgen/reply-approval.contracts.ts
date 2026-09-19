import { z } from "zod";

const iso = z.string().nullable();

export const REPLY_VIEWS = ["OPEN", "DONE"] as const;

export const replyListInput = z.object({
	view: z.enum(REPLY_VIEWS).default("OPEN"),
});

export const replyItemOutput = z.object({
	id: z.string(),
	status: z.string(),
	createdAt: z.string(),
	draftSubject: z.string(),
	draftBody: z.string(),
	rationale: z.string().nullable(),
	checks: z.array(z.string()),
	to: z.string().nullable(),
	blockers: z.array(z.string()),
	sendError: z.string().nullable(),
	reviewedBy: z.string().nullable(),
	reviewedAt: iso,
	sentSubject: z.string().nullable(),
	sentBody: z.string().nullable(),
	lead: z.object({
		id: z.string(),
		businessName: z.string(),
		demoUrl: z.string().nullable(),
		doNotContact: z.boolean(),
	}),
	inbound: z.object({
		id: z.string(),
		fromAddr: z.string(),
		subject: z.string().nullable(),
		bodyText: z.string().nullable(),
		receivedAt: iso,
		classification: z.string().nullable(),
		answeredAt: iso,
		answeredVia: z.string().nullable(),
	}),
});

export const replyListOutput = z.object({
	items: z.array(replyItemOutput),
});

export const replyStatusOutput = z.object({
	sendEnabled: z.boolean(),
	youAreApprover: z.boolean(),
	maxPerDay: z.number(),
	sentLast24h: z.number(),
	from: z.string(),
	/** why the Sent folder cannot be trusted right now; null when it was read recently */
	sentCheck: z.string().nullable(),
});

/** reviewedBy is deliberately NOT an input: it is taken from the authenticated session. */
export const replySendInput = z.object({
	id: z.string().min(1),
	subject: z.string().min(1).max(400),
	body: z.string().min(1).max(20_000),
	expectedTo: z.string().min(3).max(320),
});

export const replySendOutput = z.object({
	sendId: z.string(),
	messageId: z.string(),
	to: z.string(),
	edited: z.boolean(),
});

export const replyDiscardInput = z.object({
	id: z.string().min(1),
});

export const replyDiscardOutput = z.object({ ok: z.boolean() });
