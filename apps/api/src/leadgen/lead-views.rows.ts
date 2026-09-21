import { z } from "zod";
import {
	excerpt,
	isPlaceholderNotes,
	parseQaNotes,
	poolKey,
	safeDemoUrl,
	safeHttpUrl,
	slugFromDemoUrl,
} from "./lead-view";
import { LEAD_VIEWS } from "./lead-views.config";
import { MIRROR_TABLES } from "./mirror-map";

const text = z.string().nullable();

const identityRow = {
	id: z.string(),
	nocodbTable: text,
	nocodbRowId: z.number().nullable(),
	businessName: z.string(),
	address: text,
	phone: text,
	websiteUrl: text,
	qualityScore: z.number().nullable(),
	approvalDecision: text,
	updatedAt: z.date(),
	source: text,
	service: text,
	contact: text,
	campaign: text,
	market: text,
	notes: text,
};

export const triageSqlRow = z.object(identityRow);

export const reviewSqlRow = z.object({
	...identityRow,
	demoUrl: text,
	sendApproved: z.boolean(),
	hasDraft: z.boolean(),
	reworkRequested: z.boolean(),
});

export const detailSqlRow = z.object({
	...identityRow,
	demoUrl: text,
	email: text,
	sendApproved: z.boolean(),
	doNotContact: z.boolean(),
	dncReason: text,
	hotLead: z.boolean(),
	sentAt: z.date().nullable(),
	repliedAt: z.date().nullable(),
	draftSubject: text,
	draftBody: text,
	reworkNotes: text,
	reworkRequestedAt: text,
});

export const countRow = z.object({ n: z.number() });

export const keyCountRow = z.object({ k: z.string(), n: z.number() });

type IdentityRow = z.infer<z.ZodObject<typeof identityRow>>;

export function toIdentity(row: IdentityRow) {
	return {
		id: row.id,
		table: poolKey(row.nocodbTable, MIRROR_TABLES),
		nocodbRowId: row.nocodbRowId,
		businessName: row.businessName,
		address: row.address,
		phone: row.phone,
		oldSite: safeHttpUrl(row.websiteUrl),
		score: row.qualityScore,
		decision: row.approvalDecision,
		source: row.source,
		service: row.service,
		contact: row.contact,
		campaign: row.campaign,
		market: row.market,
	};
}

export function toTriageRow(row: z.infer<typeof triageSqlRow>) {
	const notes = excerpt(row.notes, LEAD_VIEWS.text.listNotesChars);
	return {
		...toIdentity(row),
		notes: notes.text,
		notesTruncated: notes.truncated,
		updatedAt: row.updatedAt.toISOString(),
	};
}

export type BuildKind = "v2" | "v1" | "unknown";

export function toReviewRow(
	row: z.infer<typeof reviewSqlRow>,
	build: BuildKind,
) {
	return {
		...toIdentity(row),
		demoUrl: safeDemoUrl(row.demoUrl),
		slug: slugFromDemoUrl(row.demoUrl),
		sendApproved: row.sendApproved,
		qa: parseQaNotes(row.notes),
		placeholder: isPlaceholderNotes(row.notes),
		hasDraft: row.hasDraft,
		reworkRequested: row.reworkRequested,
		build,
		updatedAt: row.updatedAt.toISOString(),
	};
}

export function toDetail(row: z.infer<typeof detailSqlRow>) {
	const notes = excerpt(row.notes, LEAD_VIEWS.text.detailNotesChars);
	return {
		...toIdentity(row),
		email: row.email,
		demoUrl: safeDemoUrl(row.demoUrl),
		notes: notes.text,
		notesTruncated: notes.truncated,
		draftSubject: row.draftSubject,
		draftBody: row.draftBody,
		qa: parseQaNotes(row.notes),
		placeholder: isPlaceholderNotes(row.notes),
		sendApproved: row.sendApproved,
		doNotContact: row.doNotContact,
		dncReason: row.dncReason,
		hotLead: row.hotLead,
		sentAt: row.sentAt ? row.sentAt.toISOString() : null,
		repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
		reworkNotes: row.reworkNotes,
		reworkRequestedAt: row.reworkRequestedAt,
		updatedAt: row.updatedAt.toISOString(),
	};
}
