// Live check for the reply-send path against the scratch DB (never prod). Sends NO email:
// the transport is nodemailer's stream transport, which builds the real MIME in memory.
//   DATABASE_URL=<crm_dev url> bun run test/leadgen-reply-send.live.ts
import { db } from "@crm/db";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import {
	ReplySendService,
	toMailOptions,
} from "../src/leadgen/reply-send.service";

const dbName = /\/([a-z_]+)(\?|$)/.exec(process.env.DATABASE_URL ?? "")?.[1];
if (dbName !== "crm_dev") {
	console.error(
		`refusing to run: DATABASE_URL points at "${dbName}", not crm_dev`,
	);
	process.exit(2);
}
process.env.LEADGEN_REPLY_SEND_ENABLED = "yes";
process.env.LEADGEN_REPLY_APPROVERS = "danio@wifielite.com";
process.env.LEADGEN_REPLY_SEND_MAX_PER_DAY = "50";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
};

const identity = {
	address: "danio@elitesystemsdesign.com",
	fromName: "Danio - Elite Integration",
};
const reviewer = { id: "live-user", email: "danio@wifielite.com" };
const tag = `zz-livetest-${Date.now()}`;

const stream = nodemailer.createTransport({
	streamTransport: true,
	buffer: true,
	newline: "windows",
});
const raws: Buffer[] = [];
const service = new ReplySendService(
	db,
	{
		async send(mail) {
			const info = await stream.sendMail(toMailOptions(mail));
			raws.push(info.message as Buffer);
			return { response: "250 stream-transport (nothing was sent)" };
		},
	},
	identity,
);

async function fixture(name: string, over: { doNotContact?: boolean } = {}) {
	const lead = await db.lgLead.create({
		data: {
			businessName: `${tag} ${name}`,
			email: `${name}@example.invalid`,
			doNotContact: over.doNotContact ?? false,
		},
	});
	const orig = await db.lgOutreachSend.create({
		data: {
			leadId: lead.id,
			step: "INITIAL",
			toAddr: `${name}@example.invalid`,
			subject: "A demo site for you",
			messageId: `<orig-${tag}-${name}@elitesystemsdesign.com>`,
			sentAt: new Date(),
		},
	});
	const inbound = await db.lgInboundMessage.create({
		data: {
			fromAddr: `${name}@example.invalid`,
			messageId: `in-${tag}-${name}@example.invalid`,
			inReplyTo: orig.messageId,
			subject: "Re: A demo site for you",
			bodyText: "Yes please, how much?",
			receivedAt: new Date(),
			matchedLeadId: lead.id,
			matchedSendId: orig.id,
			classification: "QUESTION",
		},
	});
	const draft = await db.lgReplyDraft.create({
		data: {
			inboundMessageId: inbound.id,
			leadId: lead.id,
			draftSubject: "Re: A demo site for you",
			draftBody: "Hi there,\n\nHappy to talk it through.\n",
		},
	});
	return { lead, orig, inbound, draft };
}

const input = (draftId: string, name: string) => ({
	draftId,
	subject: "Re: A demo site for you",
	body: "Hi there,\n\nHappy to talk it through.\n",
	expectedTo: `${name}@example.invalid`,
	reviewer,
});

async function main() {
	const created: string[] = [];
	// the scratch DB is not seeded by a running API, so create the job definition if it is missing
	let pollDef = await db.lgJobDefinition.findUnique({
		where: { name: "replies.poll" },
	});
	const createdDef = !pollDef;
	if (!pollDef) {
		pollDef = await db.lgJobDefinition.create({
			data: {
				name: "replies.poll",
				scheduleKind: "INTERVAL",
				intervalSeconds: 900,
				enabled: false,
			},
		});
	}
	// the send path refuses unless the Sent folder was read recently; simulate a fresh good poll
	const freshPoll = await db.lgJobRun.create({
		data: {
			jobId: pollDef.id,
			status: "OK",
			trigger: tag,
			leaseExpiresAt: new Date(),
			counters: { sentFolderChecked: 1 },
		},
	});
	try {
		// 1. happy path against real Postgres, real enum, real MIME
		const a = await fixture("alpha");
		created.push(a.lead.id);
		const r = await service.sendReply(input(a.draft.id, "alpha"));
		check("send returns ids", !!r.sendId && !!r.messageId);
		const draft = await db.lgReplyDraft.findUniqueOrThrow({
			where: { id: a.draft.id },
		});
		check("draft is SENT", draft.status === "SENT", draft.status);
		check(
			"reviewedBy recorded from the session",
			draft.reviewedBy === reviewer.email,
		);
		check("draft points at its send row", draft.sentSendId === r.sendId);
		const row = await db.lgOutreachSend.findUniqueOrThrow({
			where: { id: r.sendId },
		});
		check("send row step is REPLY (real enum)", row.step === "REPLY");
		check("send row is stamped sent", row.sentAt instanceof Date);
		check(
			"send row source crm-reply, sentBy recorded",
			row.source === "crm-reply" && row.sentBy === reviewer.email,
		);
		check("dedupeKey reply:<draft>", row.dedupeKey === `reply:${a.draft.id}`);
		const inbound = await db.lgInboundMessage.findUniqueOrThrow({
			where: { id: a.inbound.id },
		});
		check("inbound marked handled", inbound.handled === true);
		check(
			"inbound marked answered by the CRM reply",
			inbound.answeredVia === "crm-reply" && inbound.answeredAt instanceof Date,
		);

		const mime = await simpleParser(raws[0] as Buffer);
		check(
			"MIME To",
			mime.to && !Array.isArray(mime.to)
				? mime.to.text === "alpha@example.invalid"
				: false,
		);
		check(
			"MIME From",
			mime.from?.text.includes("danio@elitesystemsdesign.com") ?? false,
			mime.from?.text,
		);
		check("MIME Subject", mime.subject === "Re: A demo site for you");
		check(
			"MIME Message-ID is ours",
			mime.messageId === r.messageId,
			mime.messageId,
		);
		check(
			"MIME In-Reply-To is the inbound id",
			mime.inReplyTo === `<in-${tag}-alpha@example.invalid>`,
			String(mime.inReplyTo),
		);
		const refs = Array.isArray(mime.references)
			? mime.references
			: [String(mime.references)];
		check(
			"MIME References = original send then inbound",
			refs.join(" ") ===
				`<orig-${tag}-alpha@elitesystemsdesign.com> <in-${tag}-alpha@example.invalid>`,
			refs.join(" "),
		);
		check(
			"MIME body is the approved text",
			(mime.text ?? "").trim() === "Hi there,\n\nHappy to talk it through.",
		);
		check(
			"row stores the same headers",
			row.inReplyTo === `<in-${tag}-alpha@example.invalid>` &&
				row.referencesHeader === refs.join(" "),
		);

		// 2. a second attempt on the same draft sends nothing
		const before = raws.length;
		let second = "";
		await service.sendReply(input(a.draft.id, "alpha")).catch((e: unknown) => {
			second = String(e);
		});
		check("second send refused", second !== "", second.slice(0, 80));
		check("second send produced no mail", raws.length === before);

		// 3. do-not-contact lead
		const d = await fixture("dnc", { doNotContact: true });
		created.push(d.lead.id);
		let dnc = "";
		await service.sendReply(input(d.draft.id, "dnc")).catch((e: unknown) => {
			dnc = String(e);
		});
		check("DNC lead refused", /do-not-contact/.test(dnc), dnc.slice(0, 80));
		check("DNC produced no mail", raws.length === before);
		const dDraft = await db.lgReplyDraft.findUniqueOrThrow({
			where: { id: d.draft.id },
		});
		check("DNC draft still PENDING", dDraft.status === "PENDING");

		// 4. two simultaneous clicks on real Postgres
		const c = await fixture("race");
		created.push(c.lead.id);
		const res = await Promise.allSettled([
			service.sendReply(input(c.draft.id, "race")),
			service.sendReply(input(c.draft.id, "race")),
		]);
		check(
			"race: exactly one fulfilled",
			res.filter((x) => x.status === "fulfilled").length === 1,
		);
		check(
			"race: exactly one mail built",
			raws.length === before + 1,
			`${raws.length - before}`,
		);
		const rows = await db.lgOutreachSend.count({
			where: { leadId: c.lead.id, step: "REPLY" },
		});
		check("race: exactly one REPLY ledger row", rows === 1, String(rows));

		// 6. already answered from the mail app (Sent-folder evidence on the inbound)
		const ans = await fixture("answered");
		created.push(ans.lead.id);
		await db.lgInboundMessage.update({
			where: { id: ans.inbound.id },
			data: { answeredAt: new Date(), answeredVia: "sent-folder-thread" },
		});
		const mailsBefore = raws.length;
		let answered = "";
		await service
			.sendReply(input(ans.draft.id, "answered"))
			.catch((e: unknown) => {
				answered = String(e);
			});
		check(
			"already-answered thread refused",
			/already answered/.test(answered),
			answered.slice(0, 90),
		);
		check("already-answered produced no mail", raws.length === mailsBefore);

		// 7. stale Sent-folder evidence
		await db.lgJobRun.update({
			where: { id: freshPoll.id },
			data: { startedAt: new Date(Date.now() - 3 * 3_600_000) },
		});
		const st = await fixture("stale");
		created.push(st.lead.id);
		let stale = "";
		await service.sendReply(input(st.draft.id, "stale")).catch((e: unknown) => {
			stale = String(e);
		});
		check(
			"stale Sent-folder check refused",
			/cannot confirm it is unanswered/.test(stale),
			stale.slice(0, 90),
		);
		check("stale check produced no mail", raws.length === mailsBefore);

		// 5. placeholder still in the body
		await db.lgJobRun.update({
			where: { id: freshPoll.id },
			data: { startedAt: new Date() },
		});
		const p = await fixture("placeholder");
		created.push(p.lead.id);
		let ph = "";
		await service
			.sendReply({
				...input(p.draft.id, "placeholder"),
				body: "The price is [CHECK: price] ok?",
			})
			.catch((e: unknown) => {
				ph = String(e);
			});
		check(
			"[CHECK:] placeholder refused",
			/placeholder/.test(ph),
			ph.slice(0, 80),
		);
	} finally {
		// remove only what this run created
		await db.lgJobRun.deleteMany({ where: { id: freshPoll.id } });
		if (createdDef) {
			await db.lgJobDefinition.delete({ where: { id: pollDef.id } });
		}
		for (const id of created) {
			await db.lgInboundMessage.deleteMany({ where: { matchedLeadId: id } });
			await db.lgOutreachSend.deleteMany({ where: { leadId: id } });
			await db.lgLead.delete({ where: { id } });
		}
		const left = await db.lgLead.count({
			where: { businessName: { startsWith: tag } },
		});
		const runsLeft = await db.lgJobRun.count({ where: { trigger: tag } });
		check(
			"cleanup left no test rows",
			left === 0 && runsLeft === 0,
			`${left} leads, ${runsLeft} runs`,
		);
	}
	console.log(
		failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} FAILED`,
	);
	await db.$disconnect();
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
	console.error("live test crashed:", e);
	await db.$disconnect();
	process.exit(1);
});
