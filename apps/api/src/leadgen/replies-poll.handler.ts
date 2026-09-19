import { readFile } from "node:fs/promises";
import { type Db } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import {
	buildMatchIndexes,
	describeMatch,
	type LeadMatch,
	type MatchIndexes,
	matchLeads,
	norm,
} from "./reply-match";
import {
	classifyInbound,
	htmlToText,
	type InboundClassification,
	referencedMessageIds,
	shouldKeepExistingJudgement,
} from "./reply-rules";
import {
	bracketed,
	matchAnswers,
	type SentItem,
	toSentItem,
} from "./sent-match";

const REPLIED_LEADS_PATH =
	process.env.LEADGEN_REPLIED_LEADS ??
	"/data/leadgen/scripts/replied_leads.json";
const STOP_STATE_PATH =
	process.env.LEADGEN_STOP_STATE ??
	"/data/leadgen/scripts/stop_reply_state.json";
const MAX_MESSAGES = 600;
const MAX_SENT = 2000;

/** imapflow gives a Date or a string; anything unparseable is treated as unknown, never guessed. */
function envelopeDate(v: Date | string | undefined): Date | null {
	if (!v) return null;
	const d = v instanceof Date ? v : new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

type PythonReplied = { leads?: Record<string, { message_ids?: string[] }> };
type PythonStopState = { processed_message_ids?: string[] };

type Counters = {
	fetched: number;
	skippedSelf: number;
	noMessageId: number;
	stored: number;
	matchedToLead: number;
	classifiedStop: number;
	classifiedBounce: number;
	classifiedAutoReply: number;
	needsJudgement: number;
	notInPythonState: number;
	replyBothAgree: number;
	replyCrmOnly: number;
	replyPythonOnly: number;
	stopWithDnc: number;
	stopWithoutDnc: number;
	sentFolderChecked: number;
	sentFetched: number;
	answeredNew: number;
	answeredThread: number;
	answeredAddress: number;
};

type ParsedMail = {
	uid: number;
	messageId: string;
	fromAddr: string;
	subject: string;
	body: string;
	date: Date | null;
	refs: string[];
	headers: Record<string, string | undefined>;
};

type PythonView = { processed: Set<string>; repliedMids: Set<string> };

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

async function loadPythonView(): Promise<PythonView> {
	const [replied, stop] = await Promise.all([
		readJson<PythonReplied>(REPLIED_LEADS_PATH),
		readJson<PythonStopState>(STOP_STATE_PATH),
	]);
	const repliedMids = new Set<string>();
	for (const entry of Object.values(replied?.leads ?? {})) {
		for (const mid of entry.message_ids ?? []) repliedMids.add(norm(mid));
	}
	return {
		processed: new Set((stop?.processed_message_ids ?? []).map(norm)),
		repliedMids,
	};
}

const AUTO_HEADERS = [
	"auto-submitted",
	"x-autoreply",
	"x-autorespond",
	"x-auto-response-suppress",
	"x-vacation-message",
	"precedence",
] as const;

async function parseMail(
	uid: number,
	source: Buffer,
): Promise<ParsedMail | null> {
	const p = await simpleParser(source);
	if (!p.messageId) return null;
	const headers: Record<string, string | undefined> = {};
	for (const name of AUTO_HEADERS) {
		const v = p.headers.get(name);
		headers[name] = v === undefined ? undefined : String(v);
	}
	return {
		uid,
		messageId: norm(p.messageId),
		fromAddr: norm(p.from?.value[0]?.address ?? ""),
		subject: p.subject ?? "",
		body: p.text?.trim()
			? p.text
			: htmlToText(typeof p.html === "string" ? p.html : ""),
		date: p.date ?? null,
		refs: referencedMessageIds(p.inReplyTo ?? null, p.references ?? null),
		headers,
	};
}

/**
 * Phase 3, SHADOW MODE. Ingests the outreach mailbox, attributes each message to a lead the
 * strict way (see reply-match.ts), classifies it with the same rules as the live Python scanners
 * (see reply-rules.ts), and stores it in lg_inbound_message flagged `shadow`.
 *
 * It takes NO external action: no NocoDB write, no Do-Not-Contact, no notification, nothing sent.
 * It also reads the Sent folder and records, on lg_inbound_message only, which threads Danio already
 * answered from his mail app. The Python scanners stay authoritative. What this job adds is a per-run comparison against their
 * state files, which is the evidence the cutover gate is judged on.
 */
@Injectable()
export class RepliesPollHandler implements LgJobHandler {
	readonly name = "replies.poll";
	private readonly logger = new Logger(RepliesPollHandler.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async run(ctx: LgJobContext): Promise<LgJobResult> {
		const user = process.env.ZOHO_IMAP_USER;
		const pass = process.env.ZOHO_IMAP_PASSWORD;
		if (!user || !pass) {
			throw new Error(
				"ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD must be set for replies.poll",
			);
		}
		const days = Number(process.env.LEADGEN_REPLIES_SINCE_DAYS ?? "14");
		const since = new Date(Date.now() - days * 86_400_000);
		const mailbox = await this.fetchMailbox({
			host: process.env.ZOHO_IMAP_HOST ?? "imappro.zoho.com",
			user,
			pass,
			since,
			ctx,
		});
		const raw = mailbox.inbox;
		const idx = await this.loadIndexes();
		const py = await loadPythonView();

		const c: Counters = {
			fetched: raw.length,
			skippedSelf: 0,
			noMessageId: 0,
			stored: 0,
			matchedToLead: 0,
			classifiedStop: 0,
			classifiedBounce: 0,
			classifiedAutoReply: 0,
			needsJudgement: 0,
			notInPythonState: 0,
			replyBothAgree: 0,
			replyCrmOnly: 0,
			replyPythonOnly: 0,
			stopWithDnc: 0,
			stopWithoutDnc: 0,
			sentFolderChecked: 0,
			sentFetched: 0,
			answeredNew: 0,
			answeredThread: 0,
			answeredAddress: 0,
		};
		const seen = new Set<string>();
		const crmReplies = new Set<string>();

		for (const m of raw) {
			if (ctx.signal.aborted) throw new Error("aborted");
			const mail = await parseMail(m.uid, m.source);
			if (!mail) {
				c.noMessageId++;
				continue;
			}
			seen.add(mail.messageId);
			if (mail.fromAddr === norm(user)) {
				c.skippedSelf++;
				continue;
			}
			const cls = classifyInbound({
				fromAddr: mail.fromAddr,
				subject: mail.subject,
				body: mail.body,
				headers: mail.headers,
			});
			const match = matchLeads(idx, mail);
			await this.store(mail, cls, match);
			c.stored++;
			this.tally(c, mail, cls, match, idx, py, crmReplies);
		}
		for (const mid of py.repliedMids) {
			if (seen.has(mid) && !crmReplies.has(mid)) c.replyPythonOnly++;
		}
		if (mailbox.sent) await this.applyAnswers(mailbox.sent, since, c);
		this.logger.log(`replies.poll ${JSON.stringify(c)}`);
		return { counters: c };
	}

	private async loadIndexes(): Promise<MatchIndexes> {
		const [sends, leads, contacts] = await Promise.all([
			this.db.lgOutreachSend.findMany({
				select: { id: true, leadId: true, messageId: true, toAddr: true },
			}),
			this.db.lgLead.findMany({
				select: {
					id: true,
					email: true,
					nocodbRowId: true,
					doNotContact: true,
				},
			}),
			this.db.lgLeadContact.findMany({
				select: { leadId: true, value: true },
			}),
		]);
		return buildMatchIndexes(sends, leads, contacts);
	}

	private async store(
		mail: ParsedMail,
		cls: InboundClassification,
		match: LeadMatch,
	): Promise<void> {
		const shared = {
			matchedLeadId: match.leadIds[0] ?? null,
			matchedSendId: match.matchedSendId,
			matchMethod: describeMatch(match),
			classification: cls.classification,
			classificationEvidence: cls.evidence,
		};
		const prior = await this.db.lgInboundMessage.findUnique({
			where: { messageId: mail.messageId },
			select: { classificationEvidence: true },
		});
		const keep = shouldKeepExistingJudgement(
			prior?.classificationEvidence,
			cls.classification,
		);
		await this.db.lgInboundMessage.upsert({
			where: { messageId: mail.messageId },
			create: {
				...shared,
				imapUid: mail.uid,
				messageId: mail.messageId,
				inReplyTo: mail.refs[0] ?? null,
				fromAddr: mail.fromAddr,
				subject: mail.subject,
				bodyText: mail.body.slice(0, 20_000),
				receivedAt: mail.date,
				shadow: true,
			},
			update: {
				matchedLeadId: shared.matchedLeadId,
				matchedSendId: shared.matchedSendId,
				matchMethod: shared.matchMethod,
				bodyText: mail.body.slice(0, 20_000),
				...(keep
					? {}
					: {
							classification: shared.classification,
							classificationEvidence: shared.classificationEvidence,
						}),
			},
		});
	}

	private tally(
		c: Counters,
		mail: ParsedMail,
		cls: InboundClassification,
		match: LeadMatch,
		idx: MatchIndexes,
		py: PythonView,
		crmReplies: Set<string>,
	): void {
		const kind = cls.classification;
		const isBounce = kind === "BOUNCE_HARD" || kind === "BOUNCE_SOFT";
		const matched = match.leadIds.length > 0;
		if (matched) c.matchedToLead++;
		if (kind === "STOP") c.classifiedStop++;
		else if (isBounce) c.classifiedBounce++;
		else if (kind === "AUTO_REPLY") c.classifiedAutoReply++;
		else if (matched) c.needsJudgement++;
		if (!py.processed.has(mail.messageId)) c.notInPythonState++;

		if (matched && !isBounce) {
			crmReplies.add(mail.messageId);
			if (py.repliedMids.has(mail.messageId)) c.replyBothAgree++;
			else c.replyCrmOnly++;
		}
		if (kind === "STOP") {
			const allDnc =
				matched &&
				match.leadIds.every((id) => idx.leadById.get(id)?.doNotContact);
			if (allDnc) c.stopWithDnc++;
			else c.stopWithoutDnc++;
		}
	}

	/**
	 * Sent-folder awareness: a thread Danio already answered from his mail app must stop getting
	 * drafts and must not be answerable from the CRM. Records evidence on lg_inbound_message only;
	 * it changes nothing outside the CRM database.
	 */
	private async applyAnswers(
		sent: SentItem[],
		since: Date,
		c: Counters,
	): Promise<void> {
		c.sentFolderChecked = 1;
		c.sentFetched = sent.length;
		const [candidates, sends] = await Promise.all([
			this.db.lgInboundMessage.findMany({
				where: {
					answeredAt: null,
					matchedLeadId: { not: null },
					receivedAt: { gte: since },
				},
				select: {
					id: true,
					messageId: true,
					fromAddr: true,
					receivedAt: true,
					answeredAt: true,
				},
			}),
			this.db.lgOutreachSend.findMany({
				where: { messageId: { not: null } },
				select: { messageId: true },
			}),
		]);
		const outreachIds = new Set(
			sends.map((x) => bracketed(x.messageId)).filter((x): x is string => !!x),
		);
		for (const a of matchAnswers(candidates, sent, outreachIds)) {
			const res = await this.db.lgInboundMessage.updateMany({
				where: { id: a.inboundId, answeredAt: null },
				data: {
					answeredAt: a.sentAt ?? new Date(),
					answeredMessageId: a.sentMessageId,
					answeredVia: a.via,
				},
			});
			if (res.count === 1) {
				c.answeredNew++;
				if (a.via === "sent-folder-thread") c.answeredThread++;
				else c.answeredAddress++;
			}
		}
	}

	private async fetchMailbox(opts: {
		host: string;
		user: string;
		pass: string;
		since: Date;
		ctx: LgJobContext;
	}): Promise<{
		inbox: { uid: number; source: Buffer }[];
		sent: SentItem[] | null;
	}> {
		const client = new ImapFlow({
			host: opts.host,
			port: 993,
			secure: true,
			auth: { user: opts.user, pass: opts.pass },
			logger: false,
		});
		client.on("error", (err: unknown) => {
			this.logger.warn(`imap connection error: ${String(err).slice(0, 140)}`);
		});
		await client.connect();
		try {
			const inbox = await this.readInbox(client, opts);
			// A Sent-folder failure must not lose the INBOX ingest, but it is recorded as "not checked".
			const sent = await this.readSent(client, opts).catch((e: unknown) => {
				this.logger.warn(`sent folder unreadable: ${String(e).slice(0, 140)}`);
				return null;
			});
			return { inbox, sent };
		} finally {
			// Cleanup is best-effort: the server may already have dropped us after a complete fetch.
			try {
				await client.logout();
			} catch {
				client.close();
			}
		}
	}

	private async readInbox(
		client: ImapFlow,
		opts: { since: Date; ctx: LgJobContext },
	): Promise<{ uid: number; source: Buffer }[]> {
		const out: { uid: number; source: Buffer }[] = [];
		const lock = await client.getMailboxLock("INBOX");
		try {
			for await (const msg of client.fetch(
				{ since: opts.since },
				{ uid: true, source: true },
			)) {
				if (opts.ctx.signal.aborted) throw new Error("aborted");
				if (msg.source) out.push({ uid: msg.uid, source: msg.source });
				if (out.length >= MAX_MESSAGES) break;
			}
		} finally {
			try {
				lock.release();
			} catch {
				// connection already gone
			}
		}
		return out;
	}

	/** Envelope + References only (no bodies). Null unless the WHOLE window was read. */
	private async readSent(
		client: ImapFlow,
		opts: { since: Date; ctx: LgJobContext },
	): Promise<SentItem[] | null> {
		const boxes = await client.list();
		const box =
			boxes.find((b) => b.specialUse === "\\Sent") ??
			boxes.find((b) => /^sent/i.test(b.path));
		if (!box) return null;
		const items: SentItem[] = [];
		let complete = true;
		const lock = await client.getMailboxLock(box.path);
		try {
			for await (const msg of client.fetch(
				{ since: opts.since },
				{ uid: true, envelope: true, headers: ["references"] },
			)) {
				if (opts.ctx.signal.aborted) throw new Error("aborted");
				const env = msg.envelope;
				if (!env) continue;
				if (items.length >= MAX_SENT) {
					complete = false;
					break;
				}
				items.push(
					toSentItem({
						messageId: env.messageId,
						inReplyTo: env.inReplyTo,
						date: envelopeDate(env.date),
						to: env.to,
						cc: env.cc,
						bcc: env.bcc,
						headers: msg.headers,
					}),
				);
			}
		} finally {
			try {
				lock.release();
			} catch {
				// connection already gone
			}
		}
		return complete ? items : null;
	}
}
