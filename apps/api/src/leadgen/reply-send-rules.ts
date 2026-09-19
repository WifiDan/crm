/**
 * Pure rules for the authenticated reply-send path (Phase 3c). No I/O and no mail API here: the
 * only module allowed to touch one is reply-send.service.ts (see leadgen-no-send.spec.ts).
 *
 * Everything in this file only ever makes sending HARDER. A blocker returned here cannot be
 * overridden by the caller; the service refuses to send while any exist.
 */

export const MAX_SUBJECT = 200;
export const MAX_BODY = 5000;
export const DEFAULT_MAX_PER_DAY = 20;

/** The drafter writes [CHECK: ...] where Danio must supply a fact. It must never go out verbatim. */
const PLACEHOLDER = /\[\s*CHECK\b/i;

/** Inbound classes that must never be answered: opt-outs, bounces and robots. */
const NEVER_ANSWER = new Set([
	"STOP",
	"BOUNCE_HARD",
	"BOUNCE_SOFT",
	"AUTO_REPLY",
]);

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export type SendPolicy = {
	enabled: boolean;
	approvers: string[];
	maxPerDay: number;
};

/** Fails closed: sending is off and nobody may approve unless the environment says otherwise. */
export function readSendPolicy(
	env: Record<string, string | undefined>,
): SendPolicy {
	const approvers = (env.LEADGEN_REPLY_APPROVERS ?? "")
		.split(",")
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean);
	const cap = Number(env.LEADGEN_REPLY_SEND_MAX_PER_DAY);
	return {
		enabled: env.LEADGEN_REPLY_SEND_ENABLED === "yes",
		approvers,
		maxPerDay: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_PER_DAY,
	};
}

export function isApprover(
	email: string | null | undefined,
	policy: SendPolicy,
): boolean {
	if (!email) return false;
	return policy.approvers.includes(email.trim().toLowerCase());
}

/** "Name <a@b.co>" or "a@b.co" -> "a@b.co" (lower-cased), or null when it is not one address. */
export function extractAddress(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const inner = /<([^<>]+)>/.exec(raw)?.[1] ?? raw;
	const addr = inner.trim().toLowerCase();
	return ADDRESS.test(addr) ? addr : null;
}

export function hasHeaderBreak(value: string): boolean {
	return /[\r\n\x85\u2028\u2029]/.test(value);
}

/** Reply subject: keep the thread's subject, add a single "Re: " if it is missing. */
export function replySubject(subject: string): string {
	const s = subject.trim();
	return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function normalizeMessageId(
	id: string | null | undefined,
): string | null {
	const t = (id ?? "").trim().replace(/^<|>$/g, "");
	if (!t || /[\s<>]/.test(t) || !t.includes("@")) return null;
	return `<${t}>`;
}

/** Oldest first, no duplicates, only well-formed ids. */
export function buildReferences(
	ids: ReadonlyArray<string | null | undefined>,
): string {
	const out: string[] = [];
	for (const raw of ids) {
		const id = normalizeMessageId(raw);
		if (id && !out.includes(id)) out.push(id);
	}
	return out.join(" ");
}

export type SendCheckInput = {
	draftStatus: string;
	reviewedBy: string | null;
	leadDoNotContact: boolean;
	leadHasStopOrHardBounce: boolean;
	inboundClassification: string | null;
	to: string | null;
	ownAddresses: readonly string[];
	subject: string;
	body: string;
};

/** Every reason this draft must not go out right now. Empty means it may. */
export function sendBlockers(i: SendCheckInput): string[] {
	const out: string[] = [];
	if (i.draftStatus !== "PENDING")
		out.push(`draft is ${i.draftStatus}, not PENDING`);
	if (!i.reviewedBy) out.push("no authenticated reviewer");
	if (i.leadDoNotContact) out.push("lead is on the do-not-contact list");
	if (i.leadHasStopOrHardBounce)
		out.push("an opt-out or hard bounce is recorded for this lead");
	if (i.inboundClassification && NEVER_ANSWER.has(i.inboundClassification))
		out.push(`inbound message is ${i.inboundClassification} - never answered`);
	if (!i.to) {
		out.push("no single valid recipient address");
	} else if (i.ownAddresses.map((a) => a.toLowerCase()).includes(i.to)) {
		out.push("recipient is our own mailbox");
	}
	const subject = i.subject.trim();
	if (!subject) out.push("subject is empty");
	if (subject.length > MAX_SUBJECT)
		out.push(`subject is over ${MAX_SUBJECT} characters`);
	if (hasHeaderBreak(i.subject)) out.push("subject contains a line break");
	if (PLACEHOLDER.test(subject) || PLACEHOLDER.test(i.body))
		out.push("draft still contains a [CHECK: ...] placeholder to fill in");
	if (!i.body.trim()) out.push("body is empty");
	if (i.body.length > MAX_BODY) out.push(`body is over ${MAX_BODY} characters`);
	return out;
}

/** Plain-text bodies go out with CRLF line endings and no trailing blank lines. */
export function normalizeBody(body: string): string {
	return `${body.replace(/\r\n?/g, "\n").trimEnd().replace(/\n/g, "\r\n")}\r\n`;
}
