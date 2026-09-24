import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { type Db } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ImapFlow } from "imapflow";
import { InjectDatabase } from "../database/database.constants";
import { MAX_ATTEMPTS, withImapRetry } from "./imap-retry";
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
	bodyFromDownload,
	chooseFetchMode,
	envelopeDate,
	type FetchMode,
	incrementalRange,
	type LastPollState,
	mailFromStructure,
	type ParsedMail,
	pickTextPart,
	type StructureEntry,
} from "./reply-poll-fetch";
import {
	classifyInbound,
	type InboundClassification,
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
/** Caps a single text part's download; only guards a pathological message - store() already
 *  truncates bodyText to 20,000 chars, so this never changes stored output for a real reply. */
const BODY_MAX_BYTES = 2_000_000;

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
	/** How many connections the INBOX read took (1 = no retry). */
	imapAttempts: number;
	/** "incremental" = only UIDs newer than the last stored cursor; "full" = the whole window. */
	fetchMode: FetchMode;
	/** The IMAP UIDVALIDITY seen this run, so the next run can tell if the mailbox was recreated. */
	imapUidValidity: string;
	/** Actual bytes pulled off the wire for message bodies this run (the acceptance-criteria number). */
	bytesDownloaded: number;
	/** Informational: what a full-window fetch of this run's candidate messages would have cost. */
	bytesWouldFetchFull: number;
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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
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
 *
 * Only new mail is fetched (cursor = MAX(imapUid) already stored + the IMAP UIDVALIDITY from the
 * last successful run), and only text/plain or text/html body parts are downloaded - never
 * attachments. A full 14-day window re-fetch still runs at least once a day, and any time the
 * cursor can't be trusted (first run, mailbox recreated), so a missed message is always caught
 * within a day. See intent/leadgen-poll-incremental-fetch/ for why and the full design.
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
		const lastState = await this.loadLastPollState();
		const mailbox = await this.fetchMailbox({
			host: process.env.ZOHO_IMAP_HOST ?? "imappro.zoho.com",
			user,
			pass,
			since,
			lastState,
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
			imapAttempts: mailbox.attempts,
			fetchMode: mailbox.fetchMode,
			imapUidValidity: mailbox.uidValidity,
			bytesDownloaded: mailbox.bytesDownloaded,
			bytesWouldFetchFull: mailbox.bytesWouldFetchFull,
		};
		const seen = new Set<string>();
		const crmReplies = new Set<string>();

		for (const m of raw) {
			if (ctx.signal.aborted) throw new Error("aborted");
			const mail = mailFromStructure(m.entry, m.body);
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

	/** No new state table (spec.md §1): the cursor is derived from data already stored. */
	private async loadLastPollState(): Promise<LastPollState> {
		const [lastOk, lastFull, maxUid] = await Promise.all([
			this.db.lgJobRun.findFirst({
				where: { status: "OK", job: { name: "replies.poll" } },
				orderBy: { startedAt: "desc" },
				select: { counters: true },
			}),
			this.db.lgJobRun.findFirst({
				where: {
					status: "OK",
					job: { name: "replies.poll" },
					counters: { path: ["fetchMode"], equals: "full" },
				},
				orderBy: { startedAt: "desc" },
				select: { startedAt: true },
			}),
			this.db.lgInboundMessage.aggregate({ _max: { imapUid: true } }),
		]);
		const counters = lastOk?.counters as { imapUidValidity?: string } | null;
		return {
			uidValidity: counters?.imapUidValidity ?? null,
			lastUid: maxUid._max.imapUid ?? null,
			lastFullAt: lastFull?.startedAt ?? null,
		};
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

	/** Test seam: the one place a real IMAP client is built. */
	protected createClient(opts: {
		host: string;
		user: string;
		pass: string;
	}): ImapFlow {
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
		return client;
	}

	/** Test seam: retry timing. Production uses the defaults in imap-retry.ts. */
	protected retryOptions(
		signal: AbortSignal,
	): Parameters<typeof withImapRetry>[1] {
		return {
			signal,
			onRetry: ({ attempt, delayMs }) =>
				this.logger.warn(
					`replies.poll retrying in ${delayMs}ms after attempt ${attempt}/${MAX_ATTEMPTS}`,
				),
		};
	}

	/**
	 * One try at the front half: a fresh connection, INBOX opened, cursor decided, and only the
	 * new-or-in-window messages' text bodies read into memory. It has no side effect outside its
	 * own socket (every database write in run() happens after fetchMailbox returns), so a failed
	 * try is simply discarded and can be repeated from scratch.
	 */
	private async attemptInbox(
		opts: {
			host: string;
			user: string;
			pass: string;
			since: Date;
			lastState: LastPollState;
			ctx: LgJobContext;
		},
		attempt: number,
	): Promise<{
		client: ImapFlow;
		inbox: { entry: StructureEntry; body: string }[];
		fetchMode: FetchMode;
		uidValidity: string;
		bytesDownloaded: number;
		bytesWouldFetchFull: number;
	}> {
		const client = this.createClient(opts);
		let phase = "connect";
		try {
			await client.connect();
			phase = "inbox";
			const result = await this.readInbox(client, opts);
			return { client, ...result };
		} catch (e) {
			this.logger.warn(
				`replies.poll attempt ${attempt}/${MAX_ATTEMPTS} failed at ${phase}: ${String(e).slice(0, 140)}`,
			);
			try {
				client.close();
			} catch {
				// already closed
			}
			throw e;
		}
	}

	private async fetchMailbox(opts: {
		host: string;
		user: string;
		pass: string;
		since: Date;
		lastState: LastPollState;
		ctx: LgJobContext;
	}): Promise<{
		inbox: { entry: StructureEntry; body: string }[];
		sent: SentItem[] | null;
		attempts: number;
		fetchMode: FetchMode;
		uidValidity: string;
		bytesDownloaded: number;
		bytesWouldFetchFull: number;
	}> {
		const {
			value: {
				client,
				inbox,
				fetchMode,
				uidValidity,
				bytesDownloaded,
				bytesWouldFetchFull,
			},
			attempts,
		} = await withImapRetry(
			(n) => this.attemptInbox(opts, n),
			this.retryOptions(opts.ctx.signal),
		);
		try {
			// A Sent-folder failure must not lose the INBOX ingest, but it is recorded as "not checked".
			// It is NOT retried: it runs once, on the connection that already read the INBOX.
			const sent = await this.readSent(client, opts).catch((e: unknown) => {
				this.logger.warn(`sent folder unreadable: ${String(e).slice(0, 140)}`);
				return null;
			});
			return {
				inbox,
				sent,
				attempts,
				fetchMode,
				uidValidity,
				bytesDownloaded,
				bytesWouldFetchFull,
			};
		} finally {
			// Cleanup is best-effort: the server may already have dropped us after a complete fetch.
			try {
				await client.logout();
			} catch {
				client.close();
			}
		}
	}

	/**
	 * Opens INBOX, decides incremental vs full from the UIDVALIDITY/cursor this connection sees,
	 * fetches envelope+bodyStructure+headers for the candidate range (cheap, no bodies), then
	 * downloads only the text/plain or text/html part of each candidate (never attachments).
	 */
	private async readInbox(
		client: ImapFlow,
		opts: { since: Date; lastState: LastPollState; ctx: LgJobContext },
	): Promise<{
		inbox: { entry: StructureEntry; body: string }[];
		fetchMode: FetchMode;
		uidValidity: string;
		bytesDownloaded: number;
		bytesWouldFetchFull: number;
	}> {
		const lock = await client.getMailboxLock("INBOX");
		try {
			const mailbox = client.mailbox;
			if (!mailbox || typeof mailbox === "boolean") {
				throw new Error("INBOX did not select");
			}
			const uidValidity = mailbox.uidValidity.toString();
			const mode = chooseFetchMode(opts.lastState, {
				uidValidity: mailbox.uidValidity,
				now: new Date(),
			});
			let structures: StructureEntry[];
			if (mode === "full") {
				structures = await this.readInboxStructures(
					client,
					{ since: opts.since },
					opts.ctx,
				);
			} else {
				const { hasNew, rangeUid } = incrementalRange(
					opts.lastState.lastUid as number,
					mailbox.uidNext,
				);
				structures = hasNew
					? await this.readInboxStructures(client, { uid: rangeUid }, opts.ctx)
					: [];
			}
			const bytesWouldFetchFull = structures.reduce(
				(sum, s) => sum + (s.size ?? 0),
				0,
			);
			const downloaded = await this.downloadTextParts(
				client,
				structures,
				opts.ctx,
			);
			const bytesDownloaded = downloaded.reduce((sum, d) => sum + d.bytes, 0);
			return {
				inbox: downloaded.map((d) => ({ entry: d.entry, body: d.body })),
				fetchMode: mode,
				uidValidity,
				bytesDownloaded,
				bytesWouldFetchFull,
			};
		} finally {
			try {
				lock.release();
			} catch {
				// connection already gone
			}
		}
	}

	private async readInboxStructures(
		client: ImapFlow,
		range: { since: Date } | { uid: string },
		ctx: LgJobContext,
	): Promise<StructureEntry[]> {
		const out: StructureEntry[] = [];
		for await (const msg of client.fetch(range, {
			uid: true,
			envelope: true,
			bodyStructure: true,
			size: true,
			headers: [
				"auto-submitted",
				"x-autoreply",
				"x-autorespond",
				"x-auto-response-suppress",
				"x-vacation-message",
				"precedence",
				"references",
				"in-reply-to",
			],
		})) {
			if (ctx.signal.aborted) throw new Error("aborted");
			out.push({
				uid: msg.uid,
				envelope: msg.envelope,
				bodyStructure: msg.bodyStructure,
				headers: msg.headers,
				size: msg.size,
			});
			if (out.length >= MAX_MESSAGES) break;
		}
		return out;
	}

	private async downloadTextParts(
		client: ImapFlow,
		structures: StructureEntry[],
		ctx: LgJobContext,
	): Promise<{ entry: StructureEntry; body: string; bytes: number }[]> {
		const out: { entry: StructureEntry; body: string; bytes: number }[] = [];
		for (const entry of structures) {
			if (ctx.signal.aborted) throw new Error("aborted");
			const choice = pickTextPart(entry.bodyStructure);
			if (!choice) {
				out.push({ entry, body: "", bytes: 0 });
				continue;
			}
			const { meta, content } = await client.download(entry.uid, choice.part, {
				uid: true,
				maxBytes: BODY_MAX_BYTES,
			});
			const buf = content ? await streamToBuffer(content) : Buffer.alloc(0);
			const text = buf.toString("utf8");
			out.push({
				entry,
				body: bodyFromDownload(text, choice.kind),
				bytes: meta?.expectedSize ?? buf.length,
			});
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
