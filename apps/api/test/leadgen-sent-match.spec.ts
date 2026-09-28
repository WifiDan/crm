import { describe, expect, test } from "bun:test";
import {
	type AnswerCandidate,
	bracketed,
	matchAnswers,
	referencesFromHeaders,
	type SentItem,
	sentCheckBlocker,
	toSentItem,
} from "../src/leadgen/sent-match";

const T = (iso: string) => new Date(iso);

const inbound = (over: Partial<AnswerCandidate> = {}): AnswerCandidate => ({
	id: "m1",
	messageId: "<in1@bartique.com>",
	fromAddr: "fiona@bartique.com",
	receivedAt: T("2026-09-18T10:00:00Z"),
	answeredAt: null,
	...over,
});

const sent = (over: Partial<SentItem> = {}): SentItem => ({
	messageId: "<mine1@elitesystemsdesign.com>",
	to: ["fiona@bartique.com"],
	refs: [],
	date: T("2026-09-18T12:00:00Z"),
	...over,
});

const none = new Set<string>();

describe("thread evidence (strict)", () => {
	test("a sent reply naming the inbound message answers it", () => {
		const r = matchAnswers(
			[inbound()],
			[sent({ refs: ["<in1@bartique.com>"] })],
			none,
		);
		expect(r).toEqual([
			{
				inboundId: "m1",
				sentMessageId: "<mine1@elitesystemsdesign.com>",
				sentAt: T("2026-09-18T12:00:00Z"),
				via: "sent-folder-thread",
			},
		]);
	});

	test("it works whether the stored id has angle brackets or not", () => {
		const r = matchAnswers(
			[inbound({ messageId: "IN1@Bartique.com" })],
			[sent({ refs: ["<in1@bartique.com>"] })],
			none,
		);
		expect(r[0]?.via).toBe("sent-folder-thread");
	});

	test("thread evidence wins over address evidence and the earliest reply is reported", () => {
		const r = matchAnswers(
			[inbound()],
			[
				sent({
					messageId: "<late@x.co>",
					date: T("2026-09-19T09:00:00Z"),
					refs: ["<in1@bartique.com>"],
				}),
				sent({
					messageId: "<early@x.co>",
					date: T("2026-09-18T11:00:00Z"),
					refs: ["<in1@bartique.com>"],
				}),
				sent({ messageId: "<addr@x.co>", date: T("2026-09-18T10:30:00Z") }),
			],
			none,
		);
		expect(r).toHaveLength(1);
		expect(r[0]?.sentMessageId).toBe("<early@x.co>");
		expect(r[0]?.via).toBe("sent-folder-thread");
	});

	test("a thread hit counts even if we sent it (a CRM reply is an answer)", () => {
		const r = matchAnswers(
			[inbound()],
			[sent({ refs: ["<in1@bartique.com>"] })],
			new Set(["<mine1@elitesystemsdesign.com>"]),
		);
		expect(r[0]?.via).toBe("sent-folder-thread");
	});
});

describe("address evidence (weaker, still blocking)", () => {
	test("an unthreaded message to the same address after their reply answers it", () => {
		const r = matchAnswers([inbound()], [sent()], none);
		expect(r[0]?.via).toBe("sent-folder-address");
	});

	test("cc and bcc recipients count", () => {
		const s = toSentItem({
			messageId: "<a@x.co>",
			date: T("2026-09-18T12:00:00Z"),
			to: [{ address: "someone@else.com" }],
			cc: [{ address: "Fiona@Bartique.com" }],
		});
		expect(matchAnswers([inbound()], [s], none)[0]?.via).toBe(
			"sent-folder-address",
		);
	});

	test("a message sent BEFORE their reply is not an answer", () => {
		const r = matchAnswers(
			[inbound()],
			[sent({ date: T("2026-09-18T09:00:00Z") })],
			none,
		);
		expect(r).toEqual([]);
	});

	test("a message to a different address is not an answer", () => {
		expect(
			matchAnswers([inbound()], [sent({ to: ["other@x.co"] })], none),
		).toEqual([]);
	});

	test("our own outreach (initial / follow-ups) is never taken for a hand-written answer", () => {
		const r = matchAnswers(
			[inbound()],
			[sent()],
			new Set(["<mine1@elitesystemsdesign.com>"]),
		);
		expect(r).toEqual([]);
	});

	test("a sent message with no date cannot answer by address", () => {
		expect(matchAnswers([inbound()], [sent({ date: null })], none)).toEqual([]);
	});

	test("an inbound with no message id can still be caught by address", () => {
		const r = matchAnswers([inbound({ messageId: null })], [sent()], none);
		expect(r[0]?.via).toBe("sent-folder-address");
	});
});

describe("nothing else is touched", () => {
	test("an inbound that is already answered is skipped, so the first answer is kept", () => {
		const r = matchAnswers(
			[inbound({ answeredAt: T("2026-09-18T11:00:00Z") })],
			[sent({ refs: ["<in1@bartique.com>"] })],
			none,
		);
		expect(r).toEqual([]);
	});

	test("an unrelated thread is not matched", () => {
		const r = matchAnswers(
			[inbound()],
			[sent({ to: ["z@z.co"], refs: ["<someone-else@x.co>"] })],
			none,
		);
		expect(r).toEqual([]);
	});

	test("each inbound gets its own answer", () => {
		const r = matchAnswers(
			[
				inbound({ id: "a", messageId: "<a@x.co>", fromAddr: "a@x.co" }),
				inbound({ id: "b", messageId: "<b@y.co>", fromAddr: "b@y.co" }),
			],
			[
				sent({
					to: ["b@y.co"],
					refs: ["<b@y.co>"],
					messageId: "<ans-b@me.co>",
				}),
			],
			none,
		);
		expect(r.map((x) => x.inboundId)).toEqual(["b"]);
	});
});

describe("parsing a sent message", () => {
	test("References is unfolded across continuation lines", () => {
		const h =
			"Subject: x\r\nReferences: <a@x.co>\r\n <b@x.co>\r\n\t<c@x.co>\r\nX-Other: 1\r\n";
		expect(referencesFromHeaders(h)).toBe("<a@x.co> <b@x.co> <c@x.co>");
		expect(referencesFromHeaders(Buffer.from(h))).toBe(
			"<a@x.co> <b@x.co> <c@x.co>",
		);
		expect(referencesFromHeaders(null)).toBe("");
	});

	test("In-Reply-To and References both feed the thread evidence", () => {
		const s = toSentItem({
			messageId: "mine@x.co",
			inReplyTo: "<in1@bartique.com>",
			headers: "References: <orig@x.co> <in1@bartique.com>\r\n",
			to: [{ address: "Fiona@Bartique.com" }],
			date: T("2026-09-18T12:00:00Z"),
		});
		expect(s.refs).toEqual(["<in1@bartique.com>", "<orig@x.co>"]);
		expect(s.to).toEqual(["fiona@bartique.com"]);
		expect(s.messageId).toBe("<mine@x.co>");
	});

	test("bracketed handles empty and mixed-case input", () => {
		expect(bracketed(null)).toBeNull();
		expect(bracketed("  ")).toBeNull();
		expect(bracketed("A@B.co")).toBe("<a@b.co>");
		expect(bracketed("<A@B.co>")).toBe("<a@b.co>");
	});
});

describe("Sent-folder freshness gate", () => {
	const now = T("2026-09-19T12:00:00Z");
	const run = (minAgo: number, counters: unknown) => ({
		startedAt: new Date(now.getTime() - minAgo * 60_000),
		counters,
	});

	test("a recent run that read the Sent folder passes", () => {
		expect(sentCheckBlocker(run(10, { sentFolderChecked: 1 }), now)).toBeNull();
	});
	test("no run at all blocks", () => {
		expect(sentCheckBlocker(null, now)).toMatch(/never been checked/);
	});
	test("a run from before this feature (no counter) blocks", () => {
		expect(sentCheckBlocker(run(5, { fetched: 27 }), now)).toMatch(
			/did not read the Sent folder/,
		);
		expect(sentCheckBlocker(run(5, null), now)).toMatch(
			/did not read the Sent folder/,
		);
	});
	test("a run where the Sent folder failed blocks", () => {
		expect(sentCheckBlocker(run(5, { sentFolderChecked: 0 }), now)).toMatch(
			/did not read/,
		);
	});
	test("a stale check blocks and says how old", () => {
		expect(sentCheckBlocker(run(90, { sentFolderChecked: 1 }), now)).toMatch(
			/90 minutes ago/,
		);
	});
});
