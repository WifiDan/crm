import { type Db } from "@crm/db";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import type {
	replyItemOutput,
	replyListOutput,
	replyStatusOutput,
} from "./reply-approval.contracts";
import { LG_REPLY_IDENTITY, type ReplyIdentity } from "./reply-identity";
import {
	extractAddress,
	isApprover,
	readSendPolicy,
	sendBlockers,
} from "./reply-send-rules";
import { sentCheckBlocker } from "./sent-match";

const BODY_CAP = 6000;

type Item = z.infer<typeof replyItemOutput>;

/** "...\nCHECK: a | b" is how the drafter appends its open questions to the rationale. */
export function splitRationale(raw: string | null): {
	rationale: string | null;
	checks: string[];
} {
	if (!raw) return { rationale: null, checks: [] };
	const at = raw.indexOf("\nCHECK: ");
	if (at < 0) return { rationale: raw, checks: [] };
	return {
		rationale: raw.slice(0, at),
		checks: raw
			.slice(at + "\nCHECK: ".length)
			.split(" | ")
			.map((c) => c.trim())
			.filter(Boolean),
	};
}

/**
 * Read side of the approval UI, plus Discard. Nothing here sends mail: sending lives only in
 * reply-send.service.ts, which this file must never import (leadgen-no-send.spec.ts).
 */
@Injectable()
export class ReplyApprovalService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		@Inject(LG_REPLY_IDENTITY) private readonly identity: ReplyIdentity,
	) {}

	private async sentCheckProblem(): Promise<string | null> {
		const lastPoll = await this.db.lgJobRun.findFirst({
			where: { status: "OK", job: { name: "replies.poll" } },
			orderBy: { startedAt: "desc" },
			select: { startedAt: true, counters: true },
		});
		return sentCheckBlocker(lastPoll, new Date());
	}

	async status(
		email: string | null,
	): Promise<z.infer<typeof replyStatusOutput>> {
		const policy = readSendPolicy(process.env);
		const sentLast24h = await this.db.lgOutreachSend.count({
			where: {
				step: "REPLY",
				createdAt: { gte: new Date(Date.now() - 86_400_000) },
			},
		});
		return {
			sendEnabled: policy.enabled,
			youAreApprover: isApprover(email, policy),
			maxPerDay: policy.maxPerDay,
			sentLast24h,
			from: this.identity.address,
			sentCheck: await this.sentCheckProblem(),
		};
	}

	async list(view: "OPEN" | "DONE"): Promise<z.infer<typeof replyListOutput>> {
		const rows = await this.db.lgReplyDraft.findMany({
			where: {
				status: {
					in: view === "OPEN" ? ["PENDING", "APPROVED"] : ["SENT", "DISCARDED"],
				},
			},
			orderBy: { createdAt: view === "OPEN" ? "asc" : "desc" },
			take: view === "OPEN" ? 100 : 30,
			include: { inboundMessage: true, lead: true },
		});
		const stopLeads = new Set(
			(
				await this.db.lgInboundMessage.findMany({
					where: {
						matchedLeadId: { in: rows.map((r) => r.leadId) },
						classification: { in: ["STOP", "BOUNCE_HARD"] },
					},
					select: { matchedLeadId: true },
				})
			).map((m) => m.matchedLeadId),
		);
		const sentProblem = await this.sentCheckProblem();
		const items: Item[] = rows.map((r) => {
			const to = extractAddress(r.inboundMessage.fromAddr);
			const { rationale, checks } = splitRationale(r.rationale);
			return {
				id: r.id,
				status: r.status,
				createdAt: r.createdAt.toISOString(),
				draftSubject: r.draftSubject,
				draftBody: r.draftBody,
				rationale,
				checks,
				to,
				blockers:
					r.status === "PENDING"
						? sendBlockers({
								draftStatus: r.status,
								reviewedBy: "reviewer",
								leadDoNotContact: r.lead.doNotContact,
								leadHasStopOrHardBounce: stopLeads.has(r.leadId),
								inboundAnsweredVia: r.inboundMessage.answeredAt
									? (r.inboundMessage.answeredVia ?? "already answered")
									: null,
								sentCheckProblem: sentProblem,
								inboundClassification: r.inboundMessage.classification,
								to,
								ownAddresses: [this.identity.address],
								subject: r.draftSubject || "x",
								// placeholders are reported per-edit in the UI, not as a blocker on the raw draft
								body: r.draftBody.replace(/\[\s*CHECK\b/gi, "[filled") || "x",
							})
						: [],
				sendError: r.sendError,
				reviewedBy: r.reviewedBy,
				reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
				sentSubject: r.sentSubject,
				sentBody: r.sentBody,
				lead: {
					id: r.lead.id,
					businessName: r.lead.businessName,
					demoUrl: r.lead.demoUrl,
					doNotContact: r.lead.doNotContact,
				},
				inbound: {
					id: r.inboundMessage.id,
					fromAddr: r.inboundMessage.fromAddr,
					subject: r.inboundMessage.subject,
					bodyText: r.inboundMessage.bodyText
						? r.inboundMessage.bodyText.slice(0, BODY_CAP)
						: null,
					receivedAt: r.inboundMessage.receivedAt
						? r.inboundMessage.receivedAt.toISOString()
						: null,
					classification: r.inboundMessage.classification,
					answeredAt: r.inboundMessage.answeredAt
						? r.inboundMessage.answeredAt.toISOString()
						: null,
					answeredVia: r.inboundMessage.answeredVia,
				},
			};
		});
		return { items };
	}

	async discard(id: string, reviewedBy: string): Promise<{ ok: boolean }> {
		const res = await this.db.lgReplyDraft.updateMany({
			where: { id, status: "PENDING" },
			data: { status: "DISCARDED", reviewedBy, reviewedAt: new Date() },
		});
		if (res.count !== 1)
			throw new ConflictException("This draft was already handled.");
		return { ok: true };
	}
}
