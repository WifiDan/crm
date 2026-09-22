import { headerValue } from "./mail-headers";
import { norm } from "./reply-match";
import { htmlToText, referencedMessageIds } from "./reply-rules";

/** Header names replies.poll needs off every inbound message, beyond envelope fields. */
export const AUTO_HEADERS = [
	"auto-submitted",
	"x-autoreply",
	"x-autorespond",
	"x-auto-response-suppress",
	"x-vacation-message",
	"precedence",
] as const;

/** imapflow gives a Date or a string; anything unparseable is treated as unknown, never guessed. */
export function envelopeDate(v: Date | string | undefined): Date | null {
	if (!v) return null;
	const d = v instanceof Date ? v : new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

export type ParsedMail = {
	uid: number;
	messageId: string;
	fromAddr: string;
	subject: string;
	body: string;
	date: Date | null;
	refs: string[];
	headers: Record<string, string | undefined>;
};

/** The shape of a structure-pass FETCH result this module needs (envelope + bodyStructure + raw headers, no body). */
export type StructureEntry = {
	uid: number;
	envelope?: {
		messageId?: string | undefined;
		from?: { address?: string | undefined }[] | undefined;
		subject?: string | undefined;
		date?: Date | string | undefined;
	};
	bodyStructure?: StructureNode;
	headers?: Buffer;
	size?: number;
};

export type StructureNode = {
	part?: string;
	type: string;
	childNodes?: StructureNode[];
};

export type TextPartChoice = { part: string; kind: "plain" | "html" };

/**
 * Depth-first search for the first text/plain node anywhere in the structure; falls back to the
 * first text/html node if there is no text/plain anywhere. Mirrors this handler's own existing
 * preference (`p.text?.trim() ? p.text : htmlToText(...)`) rather than a MIME-part-order guess.
 *
 * A non-multipart message has no `childNodes` and its own `part` id is meaningless to the server
 * (there is nothing to number) - imapflow's own `download()` special-cases `part === "1"` for
 * exactly this case (falls back internally to fetching `TEXT`), so this returns "1" for that
 * shape rather than inventing a different sentinel.
 */
export function pickTextPart(
	root: StructureNode | undefined,
): TextPartChoice | null {
	if (!root) return null;
	const isLeaf = (n: StructureNode, want: string) =>
		n.type?.toLowerCase() === want &&
		(!n.childNodes || n.childNodes.length === 0);
	const dfs = (n: StructureNode, want: string): StructureNode | null => {
		if (isLeaf(n, want)) return n;
		for (const child of n.childNodes ?? []) {
			const found = dfs(child, want);
			if (found) return found;
		}
		return null;
	};
	for (const [want, kind] of [
		["text/plain", "plain"],
		["text/html", "html"],
	] as const) {
		const node = dfs(root, want);
		if (!node) continue;
		const part = node.part ?? (node === root ? "1" : undefined);
		if (part) return { part, kind };
	}
	return null;
}

/**
 * Builds the same `ParsedMail` shape `parseMail()` (raw-source + simpleParser) used to produce,
 * from a structure-pass entry plus a separately-downloaded text body. `null` iff there is no
 * Message-ID, matching `parseMail()`'s own "no Message-ID, can't dedupe" refusal.
 */
export function mailFromStructure(
	entry: StructureEntry,
	body: string,
): ParsedMail | null {
	const mid = entry.envelope?.messageId;
	if (!mid) return null;
	const headers: Record<string, string | undefined> = {};
	for (const name of AUTO_HEADERS)
		headers[name] = headerValue(entry.headers, name);
	return {
		uid: entry.uid,
		messageId: norm(mid),
		fromAddr: norm(entry.envelope?.from?.[0]?.address ?? ""),
		subject: entry.envelope?.subject ?? "",
		body,
		date: envelopeDate(entry.envelope?.date),
		refs: referencedMessageIds(
			headerValue(entry.headers, "in-reply-to") ?? null,
			headerValue(entry.headers, "references") ?? null,
		),
		headers,
	};
}

/** `text/html` bodies go through the same stripper every other HTML-only reply already used. */
export function bodyFromDownload(text: string, kind: "plain" | "html"): string {
	return kind === "html" ? htmlToText(text) : text;
}

export type FetchMode = "incremental" | "full";

export type LastPollState = {
	/** IMAP UIDVALIDITY the last successful poll saw, as a decimal string (matches the JSON counters column). */
	uidValidity: string | null;
	/** Highest UID already stored, if any. */
	lastUid: number | null;
	/** startedAt of the most recent successful FULL-mode run, if any. */
	lastFullAt: Date | null;
};

/** No new state table (spec.md §1): the cursor is `MAX(imapUid)` plus the last-OK-run's counters. */
const RECONCILE_AFTER_MS = 20 * 60 * 60 * 1000;

/**
 * incremental only when: a prior cursor exists, the mailbox hasn't been recreated (UIDVALIDITY
 * unchanged), and a full reconciliation isn't overdue. Any doubt resolves to `full` - the
 * existing 14-day window fetch is the safety net this never removes.
 */
export function chooseFetchMode(
	state: LastPollState,
	current: { uidValidity: bigint; now: Date },
): FetchMode {
	if (state.uidValidity === null || state.lastUid === null) return "full";
	if (state.uidValidity !== current.uidValidity.toString()) return "full";
	if (!state.lastFullAt) return "full";
	if (current.now.getTime() - state.lastFullAt.getTime() > RECONCILE_AFTER_MS)
		return "full";
	return "incremental";
}

/** Whether an incremental run actually has anything to fetch, and the UID range to ask for. */
export function incrementalRange(
	lastUid: number,
	uidNext: number,
): { hasNew: boolean; rangeUid: string } {
	return { hasNew: lastUid + 1 < uidNext, rangeUid: `${lastUid + 1}:*` };
}
