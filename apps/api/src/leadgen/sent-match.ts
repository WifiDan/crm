import { headerValue } from "./mail-headers";
import { norm } from "./reply-match";
import { referencedMessageIds } from "./reply-rules";

/**
 * Sent-folder awareness. A thread Danio already answered from his mail app must stop getting
 * drafts and must not be answerable from the CRM (a second reply to a live conversation is worse
 * than a missing draft). Pure functions only; replies.poll does the IMAP I/O.
 *
 * Two evidence levels, kept distinct so the UI can say which one it saw:
 *  - sent-folder-thread:  a sent message whose In-Reply-To/References names the inbound message.
 *                         Strict; this is what every mail app produces when you press Reply.
 *  - sent-folder-address: no header link, but a message we did not send as outreach went to the
 *                         same address AFTER their reply. Weaker, and deliberately still blocking:
 *                         the cost of a false block is one draft Danio can discard, the cost of a
 *                         false non-block is a duplicate reply to a live conversation.
 */

export type SentItem = {
	messageId: string | null;
	/** to + cc + bcc addresses, normalised */
	to: string[];
	/** In-Reply-To + References, normalised `<id>` tokens */
	refs: string[];
	date: Date | null;
};

export type AnswerCandidate = {
	id: string;
	messageId: string | null;
	fromAddr: string;
	receivedAt: Date | null;
	answeredAt: Date | null;
};

export type Answer = {
	inboundId: string;
	sentMessageId: string | null;
	sentAt: Date | null;
	via: "sent-folder-thread" | "sent-folder-address";
};

/** Stored ids may or may not carry angle brackets; compare on one form. */
export function bracketed(id: string | null | undefined): string | null {
	const t = norm(id ?? "").replace(/^<|>$/g, "");
	return t ? `<${t}>` : null;
}

function earliest<T extends { date: Date | null }>(items: T[]): T | undefined {
	return [...items].sort(
		(a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity),
	)[0];
}

export function matchAnswers(
	inbounds: readonly AnswerCandidate[],
	sent: readonly SentItem[],
	/** Message-IDs of mail WE sent as outreach: never evidence that Danio answered by hand. */
	outreachIds: ReadonlySet<string>,
): Answer[] {
	const out: Answer[] = [];
	for (const inbound of inbounds) {
		if (inbound.answeredAt) continue;
		const key = bracketed(inbound.messageId);
		const thread = key ? sent.filter((s) => s.refs.includes(key)) : [];
		const hit = earliest(thread);
		if (hit) {
			out.push({
				inboundId: inbound.id,
				sentMessageId: hit.messageId,
				sentAt: hit.date,
				via: "sent-folder-thread",
			});
			continue;
		}
		const from = norm(inbound.fromAddr);
		const received = inbound.receivedAt?.getTime();
		if (!from || received === undefined) continue;
		const byAddress = sent.filter(
			(s) =>
				s.to.includes(from) &&
				s.date !== null &&
				s.date.getTime() > received &&
				!(s.messageId && outreachIds.has(bracketed(s.messageId) ?? "")),
		);
		const late = earliest(byAddress);
		if (late) {
			out.push({
				inboundId: inbound.id,
				sentMessageId: late.messageId,
				sentAt: late.date,
				via: "sent-folder-address",
			});
		}
	}
	return out;
}

type Addr = { address?: string | null };

export type RawSent = {
	messageId?: string | null;
	inReplyTo?: string | null;
	date?: Date | null;
	to?: Addr[] | null;
	cc?: Addr[] | null;
	bcc?: Addr[] | null;
	/** raw header block containing at least the References header */
	headers?: string | Buffer | null;
};

/** The References header, unfolded, from a raw header block. */
export function referencesFromHeaders(
	headers: string | Buffer | null | undefined,
): string {
	return headerValue(headers, "references") ?? "";
}

export function toSentItem(raw: RawSent): SentItem {
	const addrs = [...(raw.to ?? []), ...(raw.cc ?? []), ...(raw.bcc ?? [])]
		.map((a) => norm(a.address ?? ""))
		.filter(Boolean);
	return {
		messageId: raw.messageId ? (bracketed(raw.messageId) ?? null) : null,
		to: [...new Set(addrs)],
		refs: referencedMessageIds(
			raw.inReplyTo ?? null,
			referencesFromHeaders(raw.headers),
		),
		date: raw.date ?? null,
	};
}

const STALE_AFTER_MIN = 45;

/**
 * Whether the Sent folder was successfully read recently. Sent-awareness only protects us if it
 * actually ran, so the send path refuses to send on stale or missing evidence.
 */
export function sentCheckBlocker(
	lastOkRun: { startedAt: Date; counters: unknown } | null,
	now: Date,
	maxAgeMin = STALE_AFTER_MIN,
): string | null {
	if (!lastOkRun) return "the Sent folder has never been checked";
	const c = lastOkRun.counters as { sentFolderChecked?: number } | null;
	if (c?.sentFolderChecked !== 1)
		return "the last mailbox check did not read the Sent folder";
	const ageMin = (now.getTime() - lastOkRun.startedAt.getTime()) / 60_000;
	if (ageMin > maxAgeMin)
		return `the Sent folder was last checked ${Math.round(ageMin)} minutes ago`;
	return null;
}
