/**
 * Deterministic inbound-mail rules for the lead-gen reply pipeline.
 *
 * Ported from the live Python scanners (scan_stop_replies.py, scan_replies_notify.py) so the
 * CRM's shadow classifier agrees with them by construction. Pure functions only: no I/O, so
 * they are cheap to test against real message shapes.
 */

export type LgInboundClassName =
	| "STOP"
	| "BOUNCE_HARD"
	| "BOUNCE_SOFT"
	| "AUTO_REPLY";

/** Our own footer text. Any line containing one of these is dropped before a keyword scan,
 *  otherwise every reply that quotes the footer would "contain" the word STOP. */
export const KNOWN_FOOTER_FRAGMENTS = [
	"reply stop to this message",
	"don't want future emails from us",
	"elite integration, 3045 aerotech parkway",
	"honor it within 10 business days",
];

const QUOTE_CUTOFF_PATTERNS = [
	/^-{2,}\s*original message\s*-{2,}/im,
	/^on .{5,100} wrote:\s*$/im,
	/^from:\s*.+$/im,
	/^_{5,}$/m,
	/^>/m,
];

const KEYWORD_PATTERNS: { re: RegExp; label: string; specific: boolean }[] = [
	{ re: /\bunsubscribe\b/i, label: "unsubscribe", specific: true },
	{ re: /\bremove\s+me\b/i, label: "remove me", specific: true },
	{ re: /\bopt[\s-]?out\b/i, label: "opt out", specific: true },
	{ re: /\bstop\b/i, label: "stop", specific: false },
];

const HIGH_CONFIDENCE_WORD_LIMIT = 40;

export function extractTopText(body: string): {
	top: string;
	quoteStripped: boolean;
} {
	let cutoff = body.length;
	let found = false;
	for (const re of QUOTE_CUTOFF_PATTERNS) {
		const m = re.exec(body);
		if (m && m.index < cutoff) {
			cutoff = m.index;
			found = true;
		}
	}
	const kept = body
		.slice(0, cutoff)
		.split(/\r?\n/)
		.filter((line) => {
			const low = line.toLowerCase();
			return !KNOWN_FOOTER_FRAGMENTS.some((frag) => low.includes(frag));
		});
	return { top: kept.join("\n").trim(), quoteStripped: found };
}

export type StopSignal = {
	matched: boolean;
	confidence: "high" | "low" | null;
	terms: string[];
	wordCount: number;
};

export function classifyStopSignal(top: string): StopSignal {
	const terms: string[] = [];
	let hasSpecific = false;
	for (const { re, label, specific } of KEYWORD_PATTERNS) {
		if (re.test(top)) {
			terms.push(label);
			if (specific) hasSpecific = true;
		}
	}
	const wordCount = top.split(/\s+/).filter(Boolean).length;
	if (terms.length === 0) {
		return { matched: false, confidence: null, terms, wordCount };
	}
	const confidence =
		hasSpecific || wordCount <= HIGH_CONFIDENCE_WORD_LIMIT ? "high" : "low";
	return { matched: true, confidence, terms, wordCount };
}

const BOUNCE_SENDER_PREFIXES = [
	"mailer-daemon",
	"postmaster",
	"bounce",
	"bounces",
];
const NOREPLY_SENDER_PREFIXES = [
	"no-reply",
	"noreply",
	"donotreply",
	"do-not-reply",
];

const AUTO_REPLY_SUBJECT =
	/^\s*(?:re\s*:\s*)*(?:automatic reply|auto(?:matic)?[- ]?response|out of (?:the )?office|away from (?:my |the )?(?:office|desk)|autoreply)\b/i;

function localPart(addr: string): string {
	return addr.trim().toLowerCase().split("@")[0] ?? "";
}

export function looksLikeBounceSender(addr: string): boolean {
	const local = localPart(addr);
	return BOUNCE_SENDER_PREFIXES.some((p) => local.startsWith(p));
}

export function looksLikeNoReplySender(addr: string): boolean {
	const local = localPart(addr);
	return NOREPLY_SENDER_PREFIXES.some((p) => local.startsWith(p));
}

export function normalizeApostrophes(s: string): string {
	return s.replace(/[‘’ʼ]/g, "'");
}

/** Header names are matched case-insensitively; callers pass whatever the parser gave them. */
export function isAutoReply(
	headers: Record<string, string | undefined>,
	subject: string,
): boolean {
	const h = new Map(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v ?? ""]),
	);
	const autoSubmitted = (h.get("auto-submitted") ?? "").trim().toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return true;
	for (const name of [
		"x-autoreply",
		"x-autorespond",
		"x-auto-response-suppress",
		"x-vacation-message",
	]) {
		if (h.get(name)) return true;
	}
	const precedence = (h.get("precedence") ?? "").trim().toLowerCase();
	if (["auto_reply", "bulk", "junk", "list"].includes(precedence)) return true;
	return AUTO_REPLY_SUBJECT.test(normalizeApostrophes(subject));
}

export function referencedMessageIds(
	inReplyTo?: string | null,
	references?: string | string[] | null,
): string[] {
	const raw = [inReplyTo ?? "", ...[references ?? []].flat()].join(" ");
	const ids = raw.match(/<[^<>@\s]+@[^<>\s]+>/g) ?? [];
	return [...new Set(ids.map((i) => i.trim().toLowerCase()))];
}

/** Permanent (5.x.x / 55x) versus temporary (4.x.x / 4xx) failure, from a delivery status report. */
export function classifyDsn(body: string): "HARD" | "SOFT" {
	const enhanced = /\b([245])\.\d{1,3}\.\d{1,3}\b/.exec(body);
	if (enhanced?.[1] === "5") return "HARD";
	if (enhanced?.[1] === "4") return "SOFT";
	const smtp = /\bsmtp;?\s*(5\d\d|4\d\d)\b/i.exec(body);
	if (smtp?.[1]?.startsWith("5")) return "HARD";
	if (
		/\b(user unknown|no such user|mailbox (?:unavailable|not found)|address rejected|does not exist)\b/i.test(
			body,
		)
	) {
		return "HARD";
	}
	return "SOFT"; // unknown shape: never escalate to a permanent suppression on a guess
}

export type InboundClassification = {
	classification: LgInboundClassName | null;
	evidence: string;
};

/**
 * Order matters and mirrors the Python scanners: a bounce or robot must be recognised BEFORE the
 * STOP scan, because a bounce quotes our footer and would otherwise read as an opt-out.
 * `null` means "a real human reply that needs judgement" (interested / question / not-now),
 * which is the LLM step in a later phase, never a rule.
 */
export function classifyInbound(input: {
	fromAddr: string;
	subject: string;
	body: string;
	headers: Record<string, string | undefined>;
}): InboundClassification {
	const { fromAddr, subject, body, headers } = input;
	if (looksLikeBounceSender(fromAddr)) {
		const kind = classifyDsn(body);
		return {
			classification: kind === "HARD" ? "BOUNCE_HARD" : "BOUNCE_SOFT",
			evidence: `bounce sender ${localPart(fromAddr)}@ ; delivery status ${kind.toLowerCase()}`,
		};
	}
	if (isAutoReply(headers, subject) || looksLikeNoReplySender(fromAddr)) {
		return {
			classification: "AUTO_REPLY",
			evidence: "auto-reply headers, subject or no-reply sender",
		};
	}
	const { top } = extractTopText(body);
	const stop = classifyStopSignal(top);
	if (stop.matched && stop.confidence === "high") {
		return {
			classification: "STOP",
			evidence: `opt-out wording (${stop.terms.join(", ")}) in ${stop.wordCount} words of new text`,
		};
	}
	if (stop.matched) {
		return {
			classification: null,
			evidence: `low-confidence opt-out wording (${stop.terms.join(", ")}) in ${stop.wordCount} words - needs a human`,
		};
	}
	return { classification: null, evidence: "human reply - needs judgement" };
}

/** Some mail is HTML-only. Strip it to readable text so the rules and the model see what the person wrote. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

/** True when there is actual new text to judge; false means a human must look (attachment-only, etc.). */
export function hasNewText(top: string): boolean {
	return top.replace(/\s+/g, "").length >= 3;
}

/**
 * The poller re-runs every 15 minutes over the same mail. A rule verdict may (re)classify a message,
 * but "no rule matched" must never erase a judgement the model or a human already recorded, or its
 * retry counters - otherwise the next poll silently undoes the last drafting run.
 */
export function shouldKeepExistingJudgement(
	existingEvidence: string | null | undefined,
	ruleClassification: string | null,
): boolean {
	return ruleClassification === null && /^llm/i.test(existingEvidence ?? "");
}
