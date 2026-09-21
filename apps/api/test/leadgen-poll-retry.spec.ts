import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@crm/db";
import type { ImapFlow } from "imapflow";
import { failureCounters } from "../src/leadgen/imap-retry";
import type { LgJobContext } from "../src/leadgen/job-handler";
import { LgJobSchedulerService } from "../src/leadgen/job-scheduler.service";
import { RepliesPollHandler } from "../src/leadgen/replies-poll.handler";

// Fakes only: no network, no database. The fake Db records EVERY call so a test can prove that a
// failed attempt touched nothing.

type Script = {
	connectError?: Error;
	lockError?: Error;
	/** Throw this from the INBOX fetch after yielding `dropAfter` messages. */
	dropError?: Error;
	dropAfter?: number;
	/** Sent folder reads fail with this. */
	sentError?: Error;
};

const netErr = () =>
	Object.assign(new Error("Connection not available"), {
		code: "NoConnection",
	});
const authErr = () =>
	Object.assign(new Error("Command failed"), { authenticationFailed: true });

function rfc822(id: string): Buffer {
	return Buffer.from(
		[
			"From: Fiona <fiona@bartique.example>",
			"To: danio@elitesystemsdesign.com",
			`Subject: Re: your website ${id}`,
			`Message-ID: <${id}@bartique.example>`,
			"Date: Mon, 21 Sep 2026 10:00:00 +0000",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Sounds good, call me.",
			"",
		].join("\r\n"),
	);
}
const INBOX = ["m1", "m2", "m3"];

class FakeClient {
	closed = false;
	loggedOut = false;
	private mailbox = "";
	constructor(
		private readonly script: Script,
		readonly index: number,
	) {}
	on() {}
	async connect() {
		if (this.script.connectError) throw this.script.connectError;
	}
	async getMailboxLock(path: string) {
		if (this.script.lockError && path === "INBOX") throw this.script.lockError;
		this.mailbox = path;
		return { release() {} };
	}
	async list() {
		return [{ path: "Sent", specialUse: "\\Sent" }];
	}
	async *fetch() {
		if (this.mailbox === "INBOX") {
			let n = 0;
			for (const id of INBOX) {
				if (this.script.dropError && n === (this.script.dropAfter ?? 0)) {
					throw this.script.dropError;
				}
				yield { uid: 100 + n, source: rfc822(id) };
				n++;
			}
			return;
		}
		if (this.script.sentError) throw this.script.sentError;
		yield {
			uid: 1,
			envelope: {
				messageId: "<sent1@elite>",
				inReplyTo: "<m1@bartique.example>",
				date: new Date("2026-09-21T11:00:00Z"),
				to: [{ address: "fiona@bartique.example" }],
			},
			headers: Buffer.from("References: <m1@bartique.example>\r\n"),
		};
	}
	async logout() {
		this.loggedOut = true;
	}
	close() {
		this.closed = true;
	}
}

type Calls = { reads: string[]; writes: string[]; upserts: unknown[] };
function fakeDb(prior: { classificationEvidence: string } | null = null): {
	db: Db;
	calls: Calls;
} {
	const calls: Calls = { reads: [], writes: [], upserts: [] };
	const read = (name: string, value: unknown) => async () => {
		calls.reads.push(name);
		return value;
	};
	const write = (name: string, value: unknown) => async () => {
		calls.writes.push(name);
		return value;
	};
	const db = {
		lgOutreachSend: { findMany: read("lgOutreachSend.findMany", []) },
		lgLead: { findMany: read("lgLead.findMany", []) },
		lgLeadContact: { findMany: read("lgLeadContact.findMany", []) },
		lgInboundMessage: {
			findUnique: read("lgInboundMessage.findUnique", prior),
			findMany: read("lgInboundMessage.findMany", []),
			upsert: async (args: unknown) => {
				calls.writes.push("lgInboundMessage.upsert");
				calls.upserts.push(args);
				return {};
			},
			updateMany: write("lgInboundMessage.updateMany", { count: 1 }),
		},
	};
	return { db: db as unknown as Db, calls };
}

class TestHandler extends RepliesPollHandler {
	readonly clients: FakeClient[] = [];
	constructor(
		db: Db,
		private readonly scripts: Script[],
	) {
		super(db);
	}
	protected override createClient(): ImapFlow {
		const script =
			this.scripts[this.clients.length] ?? this.scripts.at(-1) ?? {};
		const c = new FakeClient(script, this.clients.length);
		this.clients.push(c);
		return c as unknown as ImapFlow;
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

describe("replies.poll retry (fake mailbox, fake db)", () => {
	test("a drop mid INBOX fetch, then success: ingested exactly once, attempts recorded", async () => {
		const { db, calls } = fakeDb();
		const h = new TestHandler(db, [{ dropError: netErr(), dropAfter: 1 }, {}]);
		const res = await h.run(ctx());
		expect(h.clients.length).toBe(2);
		expect(h.clients[0]?.closed).toBe(true);
		expect(res.counters.imapAttempts).toBe(2);
		expect(res.counters.fetched).toBe(INBOX.length);
		expect(res.counters.stored).toBe(INBOX.length);
		// each message stored once: the partial first attempt (1 message) left no trace
		expect(
			calls.writes.filter((w) => w === "lgInboundMessage.upsert").length,
		).toBe(INBOX.length);
	});

	test("a failure at connect, then success, is retried too", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ connectError: netErr() }, {}]);
		const res = await h.run(ctx());
		expect(h.clients.length).toBe(2);
		expect(res.counters.imapAttempts).toBe(2);
	});

	test("a failure opening INBOX, then success, is retried too", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ lockError: netErr() }, {}]);
		const res = await h.run(ctx());
		expect(res.counters.imapAttempts).toBe(2);
	});

	test("no retry needed: one attempt", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{}]);
		const res = await h.run(ctx());
		expect(h.clients.length).toBe(1);
		expect(res.counters.imapAttempts).toBe(1);
	});

	test("an authentication failure is not retried and writes nothing", async () => {
		const { db, calls } = fakeDb();
		const h = new TestHandler(db, [{ connectError: authErr() }, {}]);
		let caught: unknown;
		try {
			await h.run(ctx());
		} catch (e) {
			caught = e;
		}
		expect((caught as Error).message).toBe("Command failed");
		expect(h.clients.length).toBe(1);
		expect(calls.reads).toEqual([]);
		expect(calls.writes).toEqual([]);
		expect(failureCounters(caught)).toEqual({ imapAttempts: 1 });
	});

	test("exhausted retries fail with the last error, three tries, nothing touched", async () => {
		const { db, calls } = fakeDb();
		const last = Object.assign(new Error("getaddrinfo ETIMEOUT"), {
			code: "ETIMEOUT",
		});
		const h = new TestHandler(db, [
			{ dropError: netErr(), dropAfter: 2 },
			{ connectError: netErr() },
			{ connectError: last },
		]);
		let caught: unknown;
		try {
			await h.run(ctx());
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(last);
		expect((caught as Error).message).toBe("getaddrinfo ETIMEOUT");
		expect(h.clients.length).toBe(3);
		expect(h.clients.every((c) => c.closed)).toBe(true);
		expect(calls.reads).toEqual([]);
		expect(calls.writes).toEqual([]);
		expect(failureCounters(caught)).toEqual({ imapAttempts: 3 });
	});

	test("Sent tracking is the same with and without a retry", async () => {
		const clean = await new TestHandler(fakeDb().db, [{}]).run(ctx());
		const retried = await new TestHandler(fakeDb().db, [
			{ dropError: netErr(), dropAfter: 1 },
			{},
		]).run(ctx());
		for (const k of ["sentFolderChecked", "sentFetched"] as const) {
			expect(retried.counters[k]).toBe(clean.counters[k]);
		}
		expect(clean.counters.sentFolderChecked).toBe(1);
		expect(clean.counters.sentFetched).toBe(1);
	});

	test("a Sent failure is still swallowed to 'not checked' and is NOT retried", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ sentError: netErr() }, {}]);
		const res = await h.run(ctx());
		expect(h.clients.length).toBe(1);
		expect(res.counters.imapAttempts).toBe(1);
		expect(res.counters.sentFolderChecked).toBe(0);
		expect(res.counters.fetched).toBe(INBOX.length);
		expect(h.clients[0]?.loggedOut).toBe(true);
	});

	test("the winning connection is logged out; a failed one is only closed", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ connectError: netErr() }, {}]);
		await h.run(ctx());
		expect(h.clients[0]?.loggedOut).toBe(false);
		expect(h.clients[0]?.closed).toBe(true);
		expect(h.clients[1]?.loggedOut).toBe(true);
	});

	test("a retried poll still keeps a judgement the drafter already recorded", async () => {
		const { db, calls } = fakeDb({ classificationEvidence: "llm: interested" });
		const h = new TestHandler(db, [{ dropError: netErr(), dropAfter: 1 }, {}]);
		await h.run(ctx());
		expect(calls.upserts.length).toBe(INBOX.length);
		for (const u of calls.upserts as { update: Record<string, unknown> }[]) {
			expect("classification" in u.update).toBe(false);
			expect("classificationEvidence" in u.update).toBe(false);
		}
	});
});

describe("scheduler keeps the attempt count on a failed run", () => {
	async function runOnce(handler: RepliesPollHandler) {
		const finalized: Record<string, unknown>[] = [];
		const alerts: Record<string, unknown>[] = [];
		const db = {
			lgJobDefinition: {
				findUnique: async () => ({
					id: "job1",
					name: "replies.poll",
					timeoutSeconds: 300,
				}),
			},
			lgJobRun: {
				findFirst: async () => null,
				create: async () => ({ id: "run1" }),
				updateMany: async (a: { data: Record<string, unknown> }) => {
					finalized.push(a.data);
					return { count: 1 };
				},
			},
			lgAlert: {
				findFirst: async () => null,
				create: async (a: { data: Record<string, unknown> }) => {
					alerts.push(a.data);
					return {};
				},
				updateMany: async () => ({ count: 0 }),
			},
		};
		const svc = new LgJobSchedulerService(db as unknown as Db, [handler]);
		await svc.runNow("replies.poll");
		for (let i = 0; i < 200 && finalized.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 20));
		return { finalized, alerts };
	}

	test("exhausted retries: FAILED row with the last error, imapAttempts 3, PAGE alert as before", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ connectError: netErr() }]);
		const { finalized, alerts } = await runOnce(h);
		expect(finalized.length).toBe(1);
		expect(finalized[0]?.status).toBe("FAILED");
		expect(finalized[0]?.error).toBe("Connection not available");
		expect(finalized[0]?.counters).toEqual({ imapAttempts: 3 });
		expect(alerts.length).toBe(1);
		expect(alerts[0]?.tier).toBe("PAGE");
		expect(alerts[0]?.message).toBe(
			"replies.poll failed: Connection not available",
		);
	});

	test("a retry that recovers: OK row with imapAttempts 2 and no alert", async () => {
		const { db } = fakeDb();
		const h = new TestHandler(db, [{ connectError: netErr() }, {}]);
		const { finalized, alerts } = await runOnce(h);
		expect(finalized[0]?.status).toBe("OK");
		expect(
			(finalized[0]?.counters as Record<string, number> | undefined)
				?.imapAttempts,
		).toBe(2);
		expect(alerts.length).toBe(0);
	});
});
