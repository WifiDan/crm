import { createHash, randomUUID } from "node:crypto";
import { type Db } from "@crm/db";
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Inject,
	Injectable,
	InternalServerErrorException,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import nodemailer from "nodemailer";
import { InjectDatabase } from "../database/database.constants";
import { LG_REPLY_IDENTITY, type ReplyIdentity } from "./reply-identity";
import {
	buildReferences,
	extractAddress,
	isApprover,
	normalizeBody,
	readSendPolicy,
	replySubject,
	type SendPolicy,
	sendBlockers,
} from "./reply-send-rules";

/**
 * THE ONLY FILE IN THE LEADGEN MODULE THAT CAN SEND MAIL.
 *
 * A reply draft becomes an email through exactly one route: an authenticated, session-only
 * (never an API key) action by an approver, calling sendReply() below. leadgen-no-send.spec.ts
 * allows this one file to reference a mail API and asserts that nothing else may, and that
 * nothing but the router imports this file - so no job, handler or scheduler can reach it.
 *
 * Guarantees, each covered by a test:
 *  - fails closed: off unless LEADGEN_REPLY_SEND_ENABLED=yes; only LEADGEN_REPLY_APPROVERS may send
 *  - reviewedBy comes from the session, never from the caller
 *  - at most once: the draft is claimed atomically, and the ledger row (unique dedupeKey) is
 *    written BEFORE the SMTP call, so an ambiguous outcome is never retried automatically
 *  - never sends to a do-not-contact lead, an opt-out or bounce, or a body with a [CHECK:] left in
 *  - proper threading: In-Reply-To the inbound message, References = original send + inbound
 */

export type ReplyMail = {
	from: string;
	to: string;
	subject: string;
	text: string;
	messageId: string;
	inReplyTo: string | null;
	references: string;
};

export interface ReplyTransport {
	send(mail: ReplyMail): Promise<{ response: string }>;
}

export const LG_REPLY_TRANSPORT = Symbol("LG_REPLY_TRANSPORT");
/** The one place a ReplyMail becomes message headers. Shared with the live test so it checks the real mapping. */
export function toMailOptions(mail: ReplyMail) {
	return {
		from: mail.from,
		to: mail.to,
		subject: mail.subject,
		text: mail.text,
		messageId: mail.messageId,
		inReplyTo: mail.inReplyTo ?? undefined,
		references: mail.references || undefined,
	};
}

/** SMTP over TLS with the same mailbox the Python sender uses. Built lazily so a missing password only fails a real send. */
export function smtpTransportFromEnv(
	env: Record<string, string | undefined>,
): ReplyTransport {
	return {
		async send(mail) {
			const user = env.ZOHO_SMTP_USER ?? env.ZOHO_IMAP_USER;
			const pass = env.ZOHO_SMTP_PASSWORD ?? env.ZOHO_IMAP_PASSWORD;
			if (!user || !pass)
				throw new Error("SMTP credentials are not configured");
			const smtp = nodemailer.createTransport({
				host: env.ZOHO_SMTP_HOST ?? "smtp.zoho.com",
				port: Number(env.ZOHO_SMTP_PORT ?? "465"),
				secure: true,
				auth: { user, pass },
				connectionTimeout: 15_000,
				socketTimeout: 30_000,
			});
			try {
				const info = await smtp.sendMail(toMailOptions(mail));
				return { response: String(info.response ?? "").slice(0, 200) };
			} finally {
				smtp.close();
			}
		},
	};
}

export type SendReplyInput = {
	draftId: string;
	subject: string;
	body: string;
	/** The address the UI showed the reviewer. Must equal the one the server derives. */
	expectedTo: string;
	reviewer: { id: string; email: string | null };
};

export type SendReplyResult = {
	sendId: string;
	messageId: string;
	to: string;
	edited: boolean;
};

/** Errors that prove the message was NOT accepted, so releasing the draft for a retry is safe. */
const DEFINITE_FAILURE_CODES = new Set([
	"EAUTH",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EDNS",
	"ECONNECTION",
]);

export function isDefiniteFailure(err: unknown): boolean {
	const e = err as { code?: string; responseCode?: number };
	if (typeof e.responseCode === "number") return true;
	return typeof e.code === "string" && DEFINITE_FAILURE_CODES.has(e.code);
}

const SENT_STEP = "REPLY" as const;

@Injectable()
export class ReplySendService {
	private readonly logger = new Logger(ReplySendService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Inject(LG_REPLY_TRANSPORT) private readonly transport: ReplyTransport,
		@Inject(LG_REPLY_IDENTITY) private readonly identity: ReplyIdentity,
	) {}

	policy(): SendPolicy {
		return readSendPolicy(process.env);
	}

	async sendReply(input: SendReplyInput): Promise<SendReplyResult> {
		const policy = this.policy();
		if (!policy.enabled)
			throw new ForbiddenException(
				"Reply sending is switched off (LEADGEN_REPLY_SEND_ENABLED).",
			);
		if (!isApprover(input.reviewer.email, policy))
			throw new ForbiddenException("This account is not an approved sender.");

		const draft = await this.db.lgReplyDraft.findUnique({
			where: { id: input.draftId },
			include: { inboundMessage: true, lead: true },
		});
		if (!draft) throw new NotFoundException("Draft not found.");

		const to = extractAddress(draft.inboundMessage.fromAddr);
		if (!to || to !== input.expectedTo.trim().toLowerCase())
			throw new ConflictException(
				"The recipient no longer matches what was shown. Reload and review again.",
			);

		const stopCount = await this.db.lgInboundMessage.count({
			where: {
				matchedLeadId: draft.leadId,
				classification: { in: ["STOP", "BOUNCE_HARD"] },
			},
		});
		const subject = replySubject(input.subject);
		const blockers = sendBlockers({
			draftStatus: draft.status,
			reviewedBy: input.reviewer.email ?? input.reviewer.id,
			leadDoNotContact: draft.lead.doNotContact,
			leadHasStopOrHardBounce: stopCount > 0,
			inboundClassification: draft.inboundMessage.classification,
			to,
			ownAddresses: [this.identity.address],
			subject,
			body: input.body,
		});
		if (blockers.length)
			throw new BadRequestException(`Not sent: ${blockers.join("; ")}.`);

		const since = new Date(Date.now() - 86_400_000);
		const sentToday = await this.db.lgOutreachSend.count({
			where: { step: SENT_STEP, createdAt: { gte: since } },
		});
		if (sentToday >= policy.maxPerDay)
			throw new HttpException(
				`Daily reply-send cap reached (${policy.maxPerDay}).`,
				429,
			);

		const reviewedBy = input.reviewer.email ?? input.reviewer.id;
		const body = normalizeBody(input.body);
		const claim = await this.db.lgReplyDraft.updateMany({
			where: { id: draft.id, status: "PENDING" },
			data: {
				status: "APPROVED",
				reviewedBy,
				reviewedAt: new Date(),
				sentSubject: subject,
				sentBody: body,
				sendError: null,
			},
		});
		if (claim.count !== 1)
			throw new ConflictException("This draft was already handled.");

		const original = draft.inboundMessage.matchedSendId
			? await this.db.lgOutreachSend.findUnique({
					where: { id: draft.inboundMessage.matchedSendId },
					select: { messageId: true },
				})
			: null;
		const references = buildReferences([
			original?.messageId,
			draft.inboundMessage.inReplyTo,
			draft.inboundMessage.messageId,
		]);
		const inReplyTo = buildReferences([draft.inboundMessage.messageId]) || null;
		const messageId = `<${randomUUID()}@${this.identity.address.split("@")[1]}>`;

		let sendId: string;
		try {
			const row = await this.db.lgOutreachSend.create({
				data: {
					leadId: draft.leadId,
					step: SENT_STEP,
					toAddr: to,
					subject,
					messageId,
					dedupeKey: `reply:${draft.id}`,
					mimeSha256: createHash("sha256").update(body).digest("hex"),
					inReplyTo,
					referencesHeader: references || null,
					sentBy: reviewedBy,
					source: "crm-reply",
				},
			});
			sendId = row.id;
		} catch (e) {
			await this.release(draft.id, "could not reserve the send record");
			this.logger.error(`reserve failed for ${draft.id}: ${String(e)}`);
			throw new ConflictException(
				"A send record for this draft already exists. Nothing was sent.",
			);
		}

		let accepted: { response: string };
		try {
			accepted = await this.transport.send({
				from: `${this.identity.fromName} <${this.identity.address}>`,
				to,
				subject,
				text: body,
				messageId,
				inReplyTo,
				references,
			});
		} catch (e) {
			return this.failed(e, draft.id, sendId);
		}
		// Outside the try: a ledger failure after a successful send must not be mistaken for a send failure.
		await this.confirm(
			draft.id,
			draft.inboundMessage.id,
			sendId,
			accepted.response,
		);
		return {
			sendId,
			messageId,
			to,
			edited: body !== normalizeBody(draft.draftBody),
		};
	}

	private async confirm(
		draftId: string,
		inboundId: string,
		sendId: string,
		response: string,
	): Promise<void> {
		try {
			await this.db.lgOutreachSend.update({
				where: { id: sendId },
				data: { sentAt: new Date(), smtpResponse: response },
			});
			await this.db.lgReplyDraft.update({
				where: { id: draftId },
				data: { status: "SENT", sentSendId: sendId },
			});
			await this.db.lgInboundMessage.update({
				where: { id: inboundId },
				data: { handled: true },
			});
		} catch (e) {
			// The email is out. Leave the draft APPROVED (claimed) so it can never be sent twice.
			this.logger.error(
				`SENT but ledger update failed for draft ${draftId} send ${sendId}: ${String(e)}`,
			);
			throw new InternalServerErrorException(
				"The email was sent but the record could not be updated. Do NOT send it again.",
			);
		}
	}

	private async failed(
		e: unknown,
		draftId: string,
		sendId: string,
	): Promise<never> {
		const tag = (e as { code?: string; responseCode?: number }) ?? {};
		const why =
			`${tag.code ?? tag.responseCode ?? "error"}: ${String(e)}`.slice(0, 180);
		if (isDefiniteFailure(e)) {
			// Rejected before acceptance: keep the audit row, free its key, return the draft to PENDING.
			await this.db.lgOutreachSend.update({
				where: { id: sendId },
				data: {
					dedupeKey: `reply:${draftId}:failed:${sendId}`,
					smtpResponse: `FAILED: ${why}`,
				},
			});
			await this.release(draftId, why);
			throw new BadRequestException(
				`Not sent: the mail server refused it (${why}).`,
			);
		}
		// Ambiguous (timeout mid-send). It may have gone out, so it is NOT retried automatically.
		await this.db.lgReplyDraft.update({
			where: { id: draftId },
			data: {
				sendError: `outcome unknown - check the Sent folder before retrying: ${why}`,
			},
		});
		this.logger.error(`ambiguous send outcome for draft ${draftId}: ${why}`);
		throw new InternalServerErrorException(
			"The send outcome is unknown. Check the Sent folder; do not retry blindly.",
		);
	}

	private async release(draftId: string, why: string): Promise<void> {
		await this.db.lgReplyDraft.updateMany({
			where: { id: draftId, status: "APPROVED" },
			data: { status: "PENDING", sendError: why.slice(0, 200) },
		});
	}
}
