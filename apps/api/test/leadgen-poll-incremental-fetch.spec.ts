import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { Db } from "@crm/db";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { LgJobContext } from "../src/leadgen/job-handler";
import { headerValue } from "../src/leadgen/mail-headers";
import { RepliesPollHandler } from "../src/leadgen/replies-poll.handler";
import { norm } from "../src/leadgen/reply-match";
import {
	chooseFetchMode,
	incrementalRange,
	mailFromStructure,
	nextCursorUid,
	pickTextPart,
	resolveLastUid,
} from "../src/leadgen/reply-poll-fetch";
import {
	classifyInbound,
	referencedMessageIds,
} from "../src/leadgen/reply-rules";

// Card #506: fetch only new mail, text parts only. Pure-function unit tests first, then an
// end-to-end fake-mailbox suite for the fetch-mode decision. See
// intent/leadgen-poll-incremental-fetch/ for the full design.

describe("headerValue", () => {
	test("case-insensitive, unfolds a continuation line", () => {
		const headers = Buffer.from(
			"References: <a@x>\r\n <b@x>\r\nSubject: hi\r\n",
		);
		expect(headerValue(headers, "references")).toBe("<a@x> <b@x>");
		expect(headerValue(headers, "REFERENCES")).toBe("<a@x> <b@x>");
	});

	test("undefined when the header or the whole block is absent", () => {
		expect(headerValue(undefined, "references")).toBeUndefined();
		expect(
			headerValue(Buffer.from("Subject: hi\r\n"), "references"),
		).toBeUndefined();
	});
});

describe("pickTextPart", () => {
	test("single-part text/plain message: part '1' (imapflow's download() resolves this to TEXT)", () => {
		expect(pickTextPart({ type: "text/plain" })).toEqual({
			part: "1",
			kind: "plain",
		});
	});

	test("multipart/alternative prefers text/plain over text/html", () => {
		const root = {
			type: "multipart/alternative",
			childNodes: [
				{ type: "text/plain", part: "1" },
				{ type: "text/html", part: "2" },
			],
		};
		expect(pickTextPart(root)).toEqual({ part: "1", kind: "plain" });
	});

	test("html-only falls back to text/html", () => {
		const root = {
			type: "multipart/mixed",
			childNodes: [{ type: "text/html", part: "1" }],
		};
		expect(pickTextPart(root)).toEqual({ part: "1", kind: "html" });
	});

	test("attachment-only (no text node anywhere) returns null", () => {
		const root = {
			type: "multipart/mixed",
			childNodes: [{ type: "application/pdf", part: "1" }],
		};
		expect(pickTextPart(root)).toBeNull();
	});

	test("nested multipart/related (inline image ahead of the text) still finds the text part", () => {
		const root = {
			type: "multipart/mixed",
			childNodes: [
				{
					type: "multipart/related",
					childNodes: [
						{ type: "image/png", part: "1.1" },
						{
							type: "multipart/alternative",
							childNodes: [
								{ type: "text/plain", part: "1.2.1" },
								{ type: "text/html", part: "1.2.2" },
							],
						},
					],
				},
				{ type: "application/pdf", part: "2" },
			],
		};
		expect(pickTextPart(root)).toEqual({ part: "1.2.1", kind: "plain" });
	});

	test("no bodyStructure at all returns null", () => {
		expect(pickTextPart(undefined)).toBeNull();
	});
});

describe("chooseFetchMode", () => {
	const now = new Date("2026-09-22T00:00:00Z");

	test("no prior cursor -> full", () => {
		expect(
			chooseFetchMode(
				{ uidValidity: null, lastUid: null, lastFullAt: null },
				{ uidValidity: 111n, now },
			),
		).toBe("full");
	});

	test("UIDVALIDITY changed (mailbox recreated) -> full", () => {
		expect(
			chooseFetchMode(
				{ uidValidity: "111", lastUid: 5, lastFullAt: now },
				{ uidValidity: 222n, now },
			),
		).toBe("full");
	});

	test("no full run has ever completed -> full (bootstraps the reconciliation clock)", () => {
		expect(
			chooseFetchMode(
				{ uidValidity: "111", lastUid: 5, lastFullAt: null },
				{ uidValidity: 111n, now },
			),
		).toBe("full");
	});

	test("reconciliation overdue (>20h since the last full run) -> full", () => {
		const lastFullAt = new Date(now.getTime() - 21 * 60 * 60 * 1000);
		expect(
			chooseFetchMode(
				{ uidValidity: "111", lastUid: 5, lastFullAt },
				{ uidValidity: 111n, now },
			),
		).toBe("full");
	});

	test("matching cursor, recent reconciliation -> incremental", () => {
		const lastFullAt = new Date(now.getTime() - 60 * 60 * 1000);
		expect(
			chooseFetchMode(
				{ uidValidity: "111", lastUid: 5, lastFullAt },
				{ uidValidity: 111n, now },
			),
		).toBe("incremental");
	});
});

describe("incrementalRange", () => {
	test("nothing new when lastUid + 1 >= uidNext", () => {
		expect(incrementalRange(10, 11)).toEqual({
			hasNew: false,
			rangeUid: "11:*",
		});
	});
	test("something new", () => {
		expect(incrementalRange(10, 13)).toEqual({
			hasNew: true,
			rangeUid: "11:*",
		});
	});
});

const RAW_STOP_MESSAGE = [
	"From: Fiona <fiona@bartique.example>",
	"To: danio@elitesystemsdesign.com",
	"Subject: Re: your website",
	"Message-ID: <stop1@bartique.example>",
	"Date: Mon, 21 Sep 2026 10:00:00 +0000",
	"In-Reply-To: <out1@elite>",
	"References: <out1@elite>",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Please stop emailing me, unsubscribe.",
	"",
].join("\r\n");

const STOP_STRUCTURE_ENTRY = {
	uid: 1,
	envelope: {
		messageId: "<stop1@bartique.example>",
		from: [{ address: "fiona@bartique.example" }],
		subject: "Re: your website",
		date: new Date("2026-09-21T10:00:00Z"),
	},
	bodyStructure: { type: "text/plain" },
	headers: Buffer.from(
		"In-Reply-To: <out1@elite>\r\nReferences: <out1@elite>\r\n",
	),
};
// Matches what `simpleParser` (and a real IMAP text-part download) actually produces for this
// fixture: the text after the header/body blank line, trailing newline included.
const STOP_BODY = "Please stop emailing me, unsubscribe.\n";

/**
 * The one behavior-risk point of this build (spec.md §2): `parseMail()` used raw-source +
 * `simpleParser`; the new path builds the same shape from envelope + bodyStructure + a
 * separately-downloaded text part. These two tests prove the two extraction paths agree on a
 * STOP-classified fixture - the compliance-critical case named in the card's MUST NOT BREAK list.
 */
describe("mailFromStructure vs the old raw-source parse (parity)", () => {
	test("same messageId, fromAddr, subject, body and refs for an equivalent message", async () => {
		const old = await simpleParser(RAW_STOP_MESSAGE);
		const oldShape = {
			messageId: norm(old.messageId ?? ""),
			fromAddr: norm(old.from?.value[0]?.address ?? ""),
			subject: old.subject ?? "",
			body: old.text?.trim() ? old.text : "",
			refs: referencedMessageIds(old.inReplyTo ?? null, old.references ?? null),
		};
		const fresh = mailFromStructure(STOP_STRUCTURE_ENTRY, STOP_BODY);
		expect(fresh?.messageId).toBe(oldShape.messageId);
		expect(fresh?.fromAddr).toBe(oldShape.fromAddr);
		expect(fresh?.subject).toBe(oldShape.subject);
		expect(fresh?.body).toBe(oldShape.body);
		expect(fresh?.refs).toEqual(oldShape.refs);
	});

	test("both paths classify the same fixture as STOP", async () => {
		const old = await simpleParser(RAW_STOP_MESSAGE);
		const oldCls = classifyInbound({
			fromAddr: norm(old.from?.value[0]?.address ?? ""),
			subject: old.subject ?? "",
			body: old.text ?? "",
			headers: {},
		});
		const fresh = mailFromStructure(STOP_STRUCTURE_ENTRY, STOP_BODY);
		expect(fresh).not.toBeNull();
		const freshCls = classifyInbound({
			fromAddr: fresh?.fromAddr ?? "",
			subject: fresh?.subject ?? "",
			body: fresh?.body ?? "",
			headers: fresh?.headers ?? {},
		});
		expect(freshCls.classification).toBe("STOP");
		expect(freshCls.classification).toBe(oldCls.classification);
	});
});

// ---------------------------------------------------------------------------------------------
// End-to-end: RepliesPollHandler against a fake mailbox whose UIDVALIDITY/uidNext and message set
// are test-controlled, and a fake Db whose last-poll state is test-controlled. Proves the wiring
// in run()/readInbox() - chooseFetchMode() and incrementalRange() are already unit-tested above.

type FakeMessage = {
	uid: number;
	envelope: {
		messageId: string;
		from: { address: string }[];
		subject: string;
		date: Date;
	};
	bodyStructure: unknown;
	headers: Buffer;
	size: number;
	parts: Record<string, string>;
};

function textMessage(uid: number, id: string): FakeMessage {
	const body = `hi ${id}`;
	return {
		uid,
		envelope: {
			messageId: `<${id}@bartique.example>`,
			from: [{ address: "fiona@bartique.example" }],
			subject: `Re: ${id}`,
			date: new Date("2026-09-21T10:00:00Z"),
		},
		bodyStructure: { type: "text/plain" },
		headers: Buffer.from(""),
		size: body.length,
		parts: { "1": body },
	};
}

function attachmentMessage(
	uid: number,
	text: string,
	attachment: string,
): FakeMessage {
	return {
		uid,
		envelope: {
			messageId: `<att${uid}@bartique.example>`,
			from: [{ address: "fiona@bartique.example" }],
			subject: "with attachment",
			date: new Date("2026-09-21T10:00:00Z"),
		},
		bodyStructure: {
			type: "multipart/mixed",
			childNodes: [
				{ type: "text/plain", part: "1" },
				{ type: "application/octet-stream", part: "2" },
			],
		},
		headers: Buffer.from(""),
		size: text.length + attachment.length,
		parts: { "1": text, "2": attachment },
	};
}

function selfMessage(uid: number, id: string): FakeMessage {
	const m = textMessage(uid, id);
	m.envelope.from = [{ address: "danio@elitesystemsdesign.com" }];
	return m;
}

class FakeClient {
	closed = false;
	fetchCalls: unknown[] = [];
	loggedOut = false;
	private selected = "";
	constructor(
		private readonly messages: FakeMessage[],
		public uidValidity: bigint,
	) {}
	on() {}
	async connect() {}
	get mailbox() {
		if (!this.selected) return false as const;
		const maxUid = this.messages.length
			? Math.max(...this.messages.map((m) => m.uid))
			: 99;
		return { uidValidity: this.uidValidity, uidNext: maxUid + 1 };
	}
	async getMailboxLock(path: string) {
		this.selected = path;
		return { release() {} };
	}
	async list() {
		return [{ path: "Sent", specialUse: "\\Sent" }];
	}
	async *fetch(range: unknown) {
		if (this.selected !== "INBOX") return;
		this.fetchCalls.push(range);
		let msgs = this.messages;
		if (range && typeof range === "object" && "uid" in range) {
			const from = Number(String((range as { uid: string }).uid).split(":")[0]);
			msgs = this.messages.filter((m) => m.uid >= from);
		}
		for (const m of msgs) {
			yield {
				uid: m.uid,
				envelope: m.envelope,
				bodyStructure: m.bodyStructure,
				headers: m.headers,
				size: m.size,
			};
		}
	}
	async download(uid: number, part: string) {
		const m = this.messages.find((x) => x.uid === uid);
		const text = m?.parts[part] ?? "";
		return {
			meta: { expectedSize: text.length },
			content: Readable.from([Buffer.from(text)]),
		};
	}
	async logout() {
		this.loggedOut = true;
	}
	close() {
		this.closed = true;
	}
}

function fakeDb(opts: {
	lastOkCounters?: { imapUidValidity?: string; lastSeenUid?: number } | null;
	lastFullStartedAt?: Date | null;
	lastFullCounters?: { bytesWouldFetchFull?: number } | null;
	maxUid?: number | null;
}): Db {
	const db = {
		lgOutreachSend: { findMany: async () => [] },
		lgLead: { findMany: async () => [] },
		lgLeadContact: { findMany: async () => [] },
		lgJobRun: {
			// Two different findFirst calls happen per run: one for the last OK run's counters
			// (no `counters` where-key), one for the last FULL-mode run (`counters.path` filter).
			findFirst: async (args: { where?: { counters?: unknown } }) => {
				if (args?.where?.counters) {
					return opts.lastFullStartedAt
						? {
								startedAt: opts.lastFullStartedAt,
								counters: opts.lastFullCounters ?? null,
							}
						: null;
				}
				return opts.lastOkCounters ? { counters: opts.lastOkCounters } : null;
			},
		},
		lgInboundMessage: {
			findUnique: async () => null,
			findMany: async () => [],
			aggregate: async () => ({ _max: { imapUid: opts.maxUid ?? null } }),
			upsert: async () => ({}),
			updateMany: async () => ({ count: 1 }),
		},
	};
	return db as unknown as Db;
}

class TestHandler extends RepliesPollHandler {
	client?: FakeClient;
	constructor(
		db: Db,
		private readonly factory: () => FakeClient,
	) {
		super(db);
	}
	protected override createClient(): ImapFlow {
		this.client = this.factory();
		return this.client as unknown as ImapFlow;
	}
	protected override retryOptions() {
		return { delaysMs: [0, 0], sleep: async () => {} };
	}
}

const ctx = (): LgJobContext => ({
	runId: "t",
	jobName: "replies.poll",
	signal: new AbortController().signal,
});

const saved = { ...process.env };
beforeEach(() => {
	process.env.ZOHO_IMAP_USER = "danio@elitesystemsdesign.com";
	process.env.ZOHO_IMAP_PASSWORD = "fake-password-for-tests";
});
afterEach(() => {
	process.env = { ...saved };
});

describe("incremental fetch, end-to-end (fake mailbox, fake db)", () => {
	test("no prior cursor -> full mode, fetches everything in the mailbox", async () => {
		const messages = [textMessage(101, "a"), textMessage(102, "b")];
		const h = new TestHandler(fakeDb({}), () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("full");
		expect(res.counters.fetched).toBe(2);
	});

	test("matching cursor, nothing new -> incremental mode, zero messages, zero bytes", async () => {
		const messages = [textMessage(101, "a")]; // uidNext = 102; lastUid = 101 -> nothing new
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111" },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("incremental");
		expect(res.counters.fetched).toBe(0);
		expect(res.counters.bytesDownloaded).toBe(0);
	});

	test("matching cursor, one new message -> incremental mode fetches only the new UID", async () => {
		const messages = [textMessage(101, "old"), textMessage(102, "new")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111" },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("incremental");
		expect(res.counters.fetched).toBe(1);
	});

	test("UIDVALIDITY changed (mailbox recreated) -> falls back to full mode", async () => {
		const messages = [textMessage(101, "a"), textMessage(102, "b")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "999" },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("full");
		expect(res.counters.fetched).toBe(2);
	});

	test("reconciliation overdue -> falls back to full mode even with a valid cursor", async () => {
		const messages = [textMessage(101, "a")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111" },
			lastFullStartedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("full");
	});

	test("bytesDownloaded stays tiny next to bytesWouldFetchFull when a message carries an attachment", async () => {
		const attachment = "x".repeat(500_000);
		const messages = [attachmentMessage(101, "hello there", attachment)];
		const h = new TestHandler(fakeDb({}), () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.bytesDownloaded).toBeLessThan(1_000);
		expect(res.counters.bytesWouldFetchFull).toBeGreaterThan(400_000);
	});

	test("every run stamps imapUidValidity and fetchMode for the next run's cursor decision", async () => {
		const messages = [textMessage(101, "a")];
		const h = new TestHandler(fakeDb({}), () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.imapUidValidity).toBe("111");
		expect(res.counters.fetchMode).toBe("full");
	});
});

describe("cursor survives skipped-self messages (Card #506 follow-up)", () => {
	test("resolveLastUid never falls behind either source", () => {
		expect(resolveLastUid(undefined, 101)).toBe(101);
		expect(resolveLastUid(105, 101)).toBe(105);
		expect(resolveLastUid(100, 101)).toBe(101);
		expect(resolveLastUid(null, null)).toBeNull();
		expect(resolveLastUid(7, null)).toBe(7);
	});

	test("nextCursorUid: uidNext-1 normally, only what was read when truncated", () => {
		expect(nextCursorUid([], 103, false)).toBe(102);
		expect(nextCursorUid([101, 102], 103, false)).toBe(102);
		expect(nextCursorUid([101, 102], 900, true)).toBe(102);
	});

	test("a self-sent message at the top advances the cursor; the next idle poll issues zero FETCH", async () => {
		const messages = [textMessage(101, "a"), selfMessage(102, "mine")];
		// Run 1: stored max is 101, cursor before = 101, so 102 (self) is fetched and skipped.
		const db1 = fakeDb({
			lastOkCounters: { imapUidValidity: "111" },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h1 = new TestHandler(db1, () => new FakeClient(messages, 111n));
		const r1 = await h1.run(ctx());
		expect(r1.counters.fetchMode).toBe("incremental");
		expect(r1.counters.fetched).toBe(1);
		expect(r1.counters.skippedSelf).toBe(1);
		expect(r1.counters.lastSeenUid).toBe(102);

		// Run 2: stored max is STILL 101 (self is never stored) but the persisted cursor is 102.
		const db2 = fakeDb({
			lastOkCounters: { imapUidValidity: "111", lastSeenUid: 102 },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h2 = new TestHandler(db2, () => new FakeClient(messages, 111n));
		const r2 = await h2.run(ctx());
		expect(r2.counters.fetchMode).toBe("incremental");
		expect(r2.counters.fetched).toBe(0);
		expect(r2.counters.skippedSelf).toBe(0);
		expect(r2.counters.lastSeenUid).toBe(102);
		// Zero FETCH of the INBOX at all (Sent-folder read is a separate mailbox).
		expect(h2.client?.fetchCalls.length).toBe(0);
	});

	test("without the persisted cursor the old behaviour re-fetches the self message (control)", async () => {
		const messages = [textMessage(101, "a"), selfMessage(102, "mine")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111" },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.skippedSelf).toBe(1);
		expect(h.client?.fetchCalls.length).toBe(1);
	});

	test("UIDVALIDITY change still forces a full fetch even with a high persisted cursor", async () => {
		const messages = [textMessage(101, "a"), selfMessage(102, "mine")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "999", lastSeenUid: 102 },
			lastFullStartedAt: new Date(),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("full");
		expect(res.counters.fetched).toBe(2);
	});

	test("daily reconciliation still runs full even with a persisted cursor at the top", async () => {
		const messages = [textMessage(101, "a"), selfMessage(102, "mine")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111", lastSeenUid: 102 },
			lastFullStartedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("full");
		expect(res.counters.fetched).toBe(2);
		expect(res.counters.lastSeenUid).toBe(102);
	});

	test("bytesWouldFetchFull in incremental mode is the last full run's figure, labelled", async () => {
		const messages = [textMessage(101, "a")];
		const db = fakeDb({
			lastOkCounters: { imapUidValidity: "111", lastSeenUid: 101 },
			lastFullStartedAt: new Date(),
			lastFullCounters: { bytesWouldFetchFull: 123_456 },
			maxUid: 101,
		});
		const h = new TestHandler(db, () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.fetchMode).toBe("incremental");
		expect(res.counters.bytesWouldFetchFull).toBe(123_456);
		expect(res.counters.bytesWouldFetchFullBasis).toBe("lastFull");
	});

	test("full mode reports its own measured figure", async () => {
		const messages = [textMessage(101, "a")];
		const h = new TestHandler(fakeDb({}), () => new FakeClient(messages, 111n));
		const res = await h.run(ctx());
		expect(res.counters.bytesWouldFetchFullBasis).toBe("measured");
	});
});
