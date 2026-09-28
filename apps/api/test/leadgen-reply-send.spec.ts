import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@crm/db";
import {
	type ReplyMail,
	ReplySendService,
	type ReplyTransport,
	type SendReplyInput,
} from "../src/leadgen/reply-send.service";
import {
	buildReferences,
	extractAddress,
	isApprover,
	normalizeBody,
	readSendPolicy,
	replySubject,
	type SendCheckInput,
	sendBlockers,
} from "../src/leadgen/reply-send-rules";

const clean: SendCheckInput = {
	draftStatus: "PENDING",
	reviewedBy: "danio@wifielite.com",
	leadDoNotContact: false,
	leadHasStopOrHardBounce: false,
	inboundAnsweredVia: null,
	sentCheckProblem: null,
	inboundClassification: "INTERESTED",
	to: "fiona@bartique.com",
	ownAddresses: ["danio@elitesystemsdesign.com"],
	subject: "Re: Your website",
	body: "Hi Fiona,\n\nHappy to talk. Call me any time.\n",
};

describe("send policy fails closed", () => {
	test("nothing configured: off, no approvers, default cap", () => {
		expect(readSendPolicy({})).toEqual({
			enabled: false,
			approvers: [],
			maxPerDay: 20,
		});
	});
	test("only the exact word yes turns sending on", () => {
		for (const v of ["true", "1", "YES", "on", "", " yes"]) {
			expect(readSendPolicy({ LEADGEN_REPLY_SEND_ENABLED: v }).enabled).toBe(
				false,
			);
		}
		expect(readSendPolicy({ LEADGEN_REPLY_SEND_ENABLED: "yes" }).enabled).toBe(
			true,
		);
	});
	test("approvers are trimmed and lower-cased; a bad cap falls back to the default", () => {
		const p = readSendPolicy({
			LEADGEN_REPLY_APPROVERS: " Danio@WifiElite.com , b@c.co ",
			LEADGEN_REPLY_SEND_MAX_PER_DAY: "abc",
		});
		expect(p.approvers).toEqual(["danio@wifielite.com", "b@c.co"]);
		expect(p.maxPerDay).toBe(20);
		expect(isApprover("DANIO@wifielite.com", p)).toBe(true);
		expect(isApprover("someone@else.com", p)).toBe(false);
		expect(isApprover(null, p)).toBe(false);
	});
});

describe("recipient parsing", () => {
	test("accepts one plain or display-name address", () => {
		expect(extractAddress("Fiona <Fiona@Bartique.com>")).toBe(
			"fiona@bartique.com",
		);
		expect(extractAddress("a@b.co")).toBe("a@b.co");
	});
	test("refuses lists, garbage and header injection", () => {
		expect(extractAddress("a@b.co, c@d.co")).toBeNull();
		expect(extractAddress("a@b.co; c@d.co")).toBeNull();
		expect(extractAddress("nobody")).toBeNull();
		expect(extractAddress("a@b.co\r\nBcc: x@y.zz")).toBeNull();
		expect(extractAddress("")).toBeNull();
		expect(extractAddress(null)).toBeNull();
	});
});

describe("threading headers", () => {
	test("references are oldest-first, de-duplicated, well-formed", () => {
		expect(
			buildReferences([
				"orig@elitesystemsdesign.com",
				"<orig@elitesystemsdesign.com>",
				"in1@bartique.com",
				"not an id",
				null,
				undefined,
			]),
		).toBe("<orig@elitesystemsdesign.com> <in1@bartique.com>");
	});
	test("subject gets exactly one Re:", () => {
		expect(replySubject("Your website")).toBe("Re: Your website");
		expect(replySubject("re: Your website")).toBe("re: Your website");
		expect(replySubject("  RE: x ")).toBe("RE: x");
	});
	test("plain-text body goes out with CRLF and no trailing blank lines", () => {
		expect(normalizeBody("a\n\nb\n\n\n")).toBe("a\r\n\r\nb\r\n");
		expect(normalizeBody("a\r\nb")).toBe("a\r\nb\r\n");
	});
});

describe("sendBlockers", () => {
	test("a clean draft has none", () => {
		expect(sendBlockers(clean)).toEqual([]);
	});
	const blocked: Array<[string, Partial<SendCheckInput>, RegExp]> = [
		["not pending", { draftStatus: "SENT" }, /not PENDING/],
		["no reviewer", { reviewedBy: null }, /no authenticated reviewer/],
		["do-not-contact", { leadDoNotContact: true }, /do-not-contact/],
		[
			"opt-out on file",
			{ leadHasStopOrHardBounce: true },
			/opt-out or hard bounce/,
		],
		[
			"already answered from the mail app",
			{ inboundAnsweredVia: "sent-folder-thread" },
			/already answered/,
		],
		[
			"Sent folder not confirmed",
			{ sentCheckProblem: "the Sent folder was last checked 90 minutes ago" },
			/cannot confirm it is unanswered/,
		],
		["inbound is a STOP", { inboundClassification: "STOP" }, /STOP/],
		[
			"inbound is a bounce",
			{ inboundClassification: "BOUNCE_HARD" },
			/BOUNCE_HARD/,
		],
		[
			"inbound is an auto-reply",
			{ inboundClassification: "AUTO_REPLY" },
			/AUTO_REPLY/,
		],
		["no recipient", { to: null }, /recipient/],
		["own mailbox", { to: "danio@elitesystemsdesign.com" }, /own mailbox/],
		["empty subject", { subject: "  " }, /subject is empty/],
		["line break in subject", { subject: "Hi\r\nBcc: x@y.zz" }, /line break/],
		["placeholder in body", { body: "Cost is [CHECK: price]" }, /placeholder/],
		["placeholder in subject", { subject: "Re: [check: x]" }, /placeholder/],
		["empty body", { body: " \n " }, /body is empty/],
		["huge body", { body: "x".repeat(5001) }, /body is over/],
	];
	for (const [name, patch, re] of blocked) {
		test(`blocks: ${name}`, () => {
			const out = sendBlockers({ ...clean, ...patch });
			expect(out.some((m) => re.test(m))).toBe(true);
		});
	}
});

// ---- the service, against an in-memory database and a recording transport -------------------

type Row = Record<string, unknown> & { id: string };

function makeWorld(
	over: {
		doNotContact?: boolean;
		extraStop?: boolean;
		answered?: boolean;
		poll?: { minutesAgo: number; counters: unknown } | null;
	} = {},
) {
	const lead: Row = { id: "l1", doNotContact: over.doNotContact ?? false };
	const inbound: Row = {
		id: "m1",
		fromAddr: "fiona@bartique.com",
		messageId: "in1@bartique.com",
		inReplyTo: "<orig1@elitesystemsdesign.com>",
		classification: "INTERESTED",
		matchedLeadId: "l1",
		matchedSendId: "s0",
		handled: false,
		answeredAt: over.answered ? new Date() : null,
		answeredVia: over.answered ? "sent-folder-thread" : null,
	};
	const poll =
		over.poll === undefined
			? { minutesAgo: 5, counters: { sentFolderChecked: 1 } }
			: over.poll;
	const draft: Row = {
		id: "d1",
		inboundMessageId: "m1",
		leadId: "l1",
		draftSubject: "Re: Your website",
		draftBody: "Hi Fiona,\n\nHappy to talk.\n",
		status: "PENDING",
		reviewedBy: null,
		sendError: null,
	};
	const sends: Row[] = [
		{
			id: "s0",
			messageId: "<orig1@elitesystemsdesign.com>",
			step: "INITIAL",
			createdAt: new Date(0),
		},
	];
	const inbounds: Row[] = [inbound];
	if (over.extraStop)
		inbounds.push({ id: "m2", matchedLeadId: "l1", classification: "STOP" });
	let failLedgerUpdate = false;
	let nextId = 1;

	const match = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, v]) => {
			if (v && typeof v === "object" && "in" in (v as object))
				return (v as { in: unknown[] }).in.includes(row[k]);
			if (v && typeof v === "object" && "gte" in (v as object))
				return (row[k] as Date) >= (v as { gte: Date }).gte;
			return row[k] === v;
		});

	const db = {
		lgReplyDraft: {
			findUnique: async ({ where }: { where: { id: string } }) =>
				where.id === draft.id
					? { ...draft, inboundMessage: inbound, lead }
					: null,
			updateMany: async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Row;
			}) => {
				if (!match(draft, where)) return { count: 0 };
				Object.assign(draft, data);
				return { count: 1 };
			},
			update: async ({ data }: { data: Row }) => Object.assign(draft, data),
		},
		lgInboundMessage: {
			count: async ({ where }: { where: Record<string, unknown> }) =>
				inbounds.filter((r) => match(r, where)).length,
			update: async ({ data }: { data: Row }) => Object.assign(inbound, data),
		},
		lgJobRun: {
			findFirst: async () =>
				poll
					? {
							startedAt: new Date(Date.now() - poll.minutesAgo * 60_000),
							counters: poll.counters,
						}
					: null,
		},
		lgOutreachSend: {
			count: async ({ where }: { where: Record<string, unknown> }) =>
				sends.filter((r) => match(r, where)).length,
			findUnique: async ({ where }: { where: { id: string } }) =>
				sends.find((s) => s.id === where.id) ?? null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				if (data.dedupeKey && sends.some((s) => s.dedupeKey === data.dedupeKey))
					throw Object.assign(new Error("unique"), { code: "P2002" });
				const row = {
					id: `s${nextId++}`,
					createdAt: new Date(),
					sentAt: null,
					...data,
				} as Row;
				sends.push(row);
				return row;
			},
			update: async ({ where, data }: { where: { id: string }; data: Row }) => {
				if (failLedgerUpdate && "sentAt" in data) throw new Error("db down");
				const row = sends.find((s) => s.id === where.id);
				if (!row) throw new Error("no row");
				return Object.assign(row, data);
			},
		},
	} as unknown as Db;

	return {
		db,
		draft,
		inbound,
		sends,
		breakLedger: () => {
			failLedgerUpdate = true;
		},
	};
}

function recorder(
	behaviour: (
		n: number,
	) => Promise<{ response: string }> | { response: string } = () => ({
		response: "250 OK",
	}),
) {
	const sent: ReplyMail[] = [];
	const transport: ReplyTransport = {
		async send(mail) {
			sent.push(mail);
			return behaviour(sent.length);
		},
	};
	return { transport, sent };
}

const identity = {
	address: "danio@elitesystemsdesign.com",
	fromName: "Danio - Elite Integration",
};
const reviewer = { id: "u1", email: "danio@wifielite.com" };
const base: SendReplyInput = {
	draftId: "d1",
	subject: "Your website",
	body: "Hi Fiona,\n\nHappy to talk.\n",
	expectedTo: "fiona@bartique.com",
	reviewer,
};

const KEYS = [
	"LEADGEN_REPLY_SEND_ENABLED",
	"LEADGEN_REPLY_APPROVERS",
	"LEADGEN_REPLY_SEND_MAX_PER_DAY",
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	process.env.LEADGEN_REPLY_SEND_ENABLED = "yes";
	process.env.LEADGEN_REPLY_APPROVERS = "danio@wifielite.com";
	process.env.LEADGEN_REPLY_SEND_MAX_PER_DAY = "20";
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const svc = (w: ReturnType<typeof makeWorld>, t: ReplyTransport) =>
	new ReplySendService(w.db, t, identity);

describe("ReplySendService: the happy path", () => {
	test("sends once, threads correctly, and records who approved what", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder();
		const r = await svc(w, transport).sendReply(base);

		expect(sent).toHaveLength(1);
		const m = sent[0] as ReplyMail;
		expect(m.to).toBe("fiona@bartique.com");
		expect(m.from).toBe(
			"Danio - Elite Integration <danio@elitesystemsdesign.com>",
		);
		expect(m.subject).toBe("Re: Your website");
		expect(m.inReplyTo).toBe("<in1@bartique.com>");
		expect(m.references).toBe(
			"<orig1@elitesystemsdesign.com> <in1@bartique.com>",
		);
		expect(m.messageId).toMatch(/^<[0-9a-f-]{36}@elitesystemsdesign\.com>$/);
		expect(m.text).toBe("Hi Fiona,\r\n\r\nHappy to talk.\r\n");

		expect(w.draft.status).toBe("SENT");
		expect(w.draft.reviewedBy).toBe("danio@wifielite.com");
		expect(w.draft.sentSubject).toBe("Re: Your website");
		expect(w.draft.sentSendId).toBe(r.sendId);
		expect(w.inbound.handled).toBe(true);
		expect(w.inbound.answeredVia).toBe("crm-reply");
		expect(w.inbound.answeredMessageId).toBe(m.messageId);
		expect(w.inbound.answeredAt).toBeInstanceOf(Date);
		const row = w.sends.find((s) => s.id === r.sendId) as Row;
		expect(row.step).toBe("REPLY");
		expect(row.dedupeKey).toBe("reply:d1");
		expect(row.messageId).toBe(m.messageId);
		expect(row.sentBy).toBe("danio@wifielite.com");
		expect(row.source).toBe("crm-reply");
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.smtpResponse).toBe("250 OK");
		expect(r.edited).toBe(false);
	});

	test("an edited body is flagged as edited and the edited text is what goes out", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder();
		const r = await svc(w, transport).sendReply({
			...base,
			body: "Hi Fiona, different words.",
		});
		expect(r.edited).toBe(true);
		expect((sent[0] as ReplyMail).text).toBe("Hi Fiona, different words.\r\n");
		expect(w.draft.sentBody).toBe("Hi Fiona, different words.\r\n");
	});
});

describe("ReplySendService: refuses, and sends nothing", () => {
	const refuse = async (
		w: ReturnType<typeof makeWorld>,
		input: SendReplyInput,
		pattern: RegExp,
	) => {
		const before = w.sends.filter((s) => s.step === "REPLY").length;
		const { transport, sent } = recorder();
		await expect(svc(w, transport).sendReply(input)).rejects.toThrow(pattern);
		expect(sent).toHaveLength(0);
		expect(w.draft.status).toBe("PENDING");
		expect(w.sends.filter((s) => s.step === "REPLY")).toHaveLength(before);
	};

	test("when the switch is off", async () => {
		delete process.env.LEADGEN_REPLY_SEND_ENABLED;
		await refuse(makeWorld(), base, /switched off/);
	});
	test("when nobody is configured as an approver", async () => {
		delete process.env.LEADGEN_REPLY_APPROVERS;
		await refuse(makeWorld(), base, /not an approved sender/);
	});
	test("for a signed-in user who is not an approver", async () => {
		await refuse(
			makeWorld(),
			{ ...base, reviewer: { id: "u2", email: "other@x.com" } },
			/not an approved sender/,
		);
	});
	test("for a user with no email", async () => {
		await refuse(
			makeWorld(),
			{ ...base, reviewer: { id: "u2", email: null } },
			/not an approved sender/,
		);
	});
	test("when the recipient differs from what the reviewer was shown", async () => {
		await refuse(
			makeWorld(),
			{ ...base, expectedTo: "someone@else.com" },
			/no longer matches/,
		);
	});
	test("to a do-not-contact lead", async () => {
		await refuse(makeWorld({ doNotContact: true }), base, /do-not-contact/);
	});
	test("when an opt-out is on file for the lead", async () => {
		await refuse(makeWorld({ extraStop: true }), base, /opt-out/);
	});
	test("when the thread was already answered from the mail app", async () => {
		await refuse(makeWorld({ answered: true }), base, /already answered/);
	});
	test("when the Sent folder was never checked", async () => {
		await refuse(makeWorld({ poll: null }), base, /never been checked/);
	});
	test("when the last mailbox check did not read the Sent folder", async () => {
		await refuse(
			makeWorld({
				poll: { minutesAgo: 3, counters: { sentFolderChecked: 0 } },
			}),
			base,
			/did not read the Sent folder/,
		);
	});
	test("when the Sent-folder check is stale", async () => {
		await refuse(
			makeWorld({
				poll: { minutesAgo: 120, counters: { sentFolderChecked: 1 } },
			}),
			base,
			/120 minutes ago/,
		);
	});
	test("when a [CHECK: ...] placeholder is still in the body", async () => {
		await refuse(
			makeWorld(),
			{ ...base, body: "Cost is [CHECK: price]" },
			/placeholder/,
		);
	});
	test("when the daily cap is reached", async () => {
		process.env.LEADGEN_REPLY_SEND_MAX_PER_DAY = "1";
		const w = makeWorld();
		w.sends.push({ id: "sx", step: "REPLY", createdAt: new Date() });
		await refuse(w, base, /cap reached/);
	});
	test("for an unknown draft", async () => {
		await refuse(makeWorld(), { ...base, draftId: "nope" }, /not found/i);
	});
});

describe("ReplySendService: at most once", () => {
	test("two simultaneous clicks send exactly one email", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder(async () => {
			await new Promise((r) => setTimeout(r, 5));
			return { response: "250 OK" };
		});
		const s = svc(w, transport);
		const results = await Promise.allSettled([
			s.sendReply(base),
			s.sendReply(base),
		]);
		expect(sent).toHaveLength(1);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(w.sends.filter((r) => r.step === "REPLY")).toHaveLength(1);
	});

	test("a second attempt after success is refused", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder();
		const s = svc(w, transport);
		await s.sendReply(base);
		await expect(s.sendReply(base)).rejects.toThrow();
		expect(sent).toHaveLength(1);
	});

	test("a definite refusal (auth failure) releases the draft, keeps the audit row, and a retry can succeed", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder((n) => {
			if (n === 1)
				throw Object.assign(new Error("bad login"), { code: "EAUTH" });
			return { response: "250 OK" };
		});
		const s = svc(w, transport);
		await expect(s.sendReply(base)).rejects.toThrow(/refused/);
		expect(w.draft.status).toBe("PENDING");
		expect(String(w.draft.sendError)).toContain("EAUTH");
		const failed = w.sends.find((r) => r.step === "REPLY") as Row;
		expect(failed.sentAt).toBeNull();
		expect(String(failed.smtpResponse)).toMatch(/^FAILED/);
		expect(String(failed.dedupeKey)).toContain(":failed:");

		await s.sendReply(base);
		expect(sent).toHaveLength(2);
		expect(w.draft.status).toBe("SENT");
		expect(w.sends.filter((r) => r.step === "REPLY" && r.sentAt)).toHaveLength(
			1,
		);
	});

	test("an ambiguous failure (timeout) is NOT retried: the draft stays claimed and a retry is refused", async () => {
		const w = makeWorld();
		const { transport, sent } = recorder(() => {
			throw Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
		});
		const s = svc(w, transport);
		await expect(s.sendReply(base)).rejects.toThrow(/outcome is unknown/);
		expect(w.draft.status).toBe("APPROVED");
		expect(String(w.draft.sendError)).toContain("Sent folder");
		await expect(s.sendReply(base)).rejects.toThrow(
			/not PENDING|already handled/,
		);
		expect(sent).toHaveLength(1);
	});

	test("if the email went out but the ledger update fails, it is never sent again", async () => {
		const w = makeWorld();
		w.breakLedger();
		const { transport, sent } = recorder();
		const s = svc(w, transport);
		await expect(s.sendReply(base)).rejects.toThrow(/Do NOT send it again/);
		expect(w.draft.status).toBe("APPROVED");
		await expect(s.sendReply(base)).rejects.toThrow(
			/not PENDING|already handled/,
		);
		expect(sent).toHaveLength(1);
	});
});
