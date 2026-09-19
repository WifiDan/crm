import { describe, expect, test } from "bun:test";
import {
	classifyDsn,
	classifyInbound,
	classifyStopSignal,
	extractTopText,
	hasNewText,
	htmlToText,
	isAutoReply,
	referencedMessageIds,
} from "../src/leadgen/reply-rules";

const FOOTER =
	"Elite Integration, 3045 Aerotech Parkway Suite 2, Montrose, CO 81401\nDon't want future emails from us? Reply STOP to this message and we'll honor it within 10 business days.";

const human = (
	body: string,
	extra: Partial<{ from: string; subject: string }> = {},
) =>
	classifyInbound({
		fromAddr: extra.from ?? "owner@acme.com",
		subject: extra.subject ?? "Re: I rebuilt Acme's website",
		body,
		headers: {},
	});

describe("STOP detection", () => {
	test("a short plain opt-out is a high-confidence STOP", () => {
		const r = human("Please remove me from your list.");
		expect(r.classification).toBe("STOP");
	});

	test("our own footer, quoted back, is NOT a STOP", () => {
		const r = human(
			`Sounds great, let's talk Thursday!\n\nOn Mon, Sep 8, 2026 at 8:30 AM Danio wrote:\n> Hi there\n> ${FOOTER.replace("\n", "\n> ")}`,
		);
		expect(r.classification).toBeNull();
	});

	test("our footer with no quote marker at all is still stripped", () => {
		const r = human(`Interested, call me.\n${FOOTER}`);
		expect(r.classification).toBeNull();
	});

	test("the bare word stop inside a long message is low confidence, never an automatic STOP", () => {
		const long = `${"We would love to chat about the site and pricing and timing. ".repeat(6)} Please do not stop by the shop unannounced.`;
		const signal = classifyStopSignal(extractTopText(long).top);
		expect(signal.matched).toBe(true);
		expect(signal.confidence).toBe("low");
		expect(human(long).classification).toBeNull();
	});

	test("a specific phrase is high confidence even in a long message", () => {
		const long = `${"Thanks for reaching out about the redesign. ".repeat(10)} Please unsubscribe us.`;
		expect(human(long).classification).toBe("STOP");
	});

	test("an ordinary interested reply carries no rule classification", () => {
		const r = human("This looks great! How much would it cost?");
		expect(r.classification).toBeNull();
		expect(r.evidence).toContain("needs judgement");
	});
});

describe("bounces", () => {
	const dsn = (status: string) =>
		`Delivery has failed to these recipients.\nFinal-Recipient: rfc822; gone@acme.com\nAction: failed\nStatus: ${status}\n\n${FOOTER}`;

	test("5.x.x from mailer-daemon is a hard bounce, and its quoted footer never reads as STOP", () => {
		const r = classifyInbound({
			fromAddr: "MAILER-DAEMON@zoho.com",
			subject: "Undelivered Mail Returned to Sender",
			body: dsn("5.1.1"),
			headers: {},
		});
		expect(r.classification).toBe("BOUNCE_HARD");
	});

	test("4.x.x is a soft bounce", () => {
		const r = classifyInbound({
			fromAddr: "postmaster@acme.com",
			subject: "Delivery delayed",
			body: dsn("4.4.1"),
			headers: {},
		});
		expect(r.classification).toBe("BOUNCE_SOFT");
	});

	test("an unrecognisable failure is soft, never an automatic permanent suppression", () => {
		expect(classifyDsn("Something odd happened to your message.")).toBe("SOFT");
	});

	test("plain-language hard failures are recognised", () => {
		expect(classifyDsn("550 The email account does not exist")).toBe("HARD");
	});
});

describe("auto-replies", () => {
	test("Auto-Submitted header", () => {
		expect(isAutoReply({ "Auto-Submitted": "auto-replied" }, "Re: hi")).toBe(
			true,
		);
		expect(isAutoReply({ "auto-submitted": "no" }, "Re: hi")).toBe(false);
	});

	test("out-of-office subject with a curly apostrophe", () => {
		expect(isAutoReply({}, "Automatic reply: I’m away")).toBe(true);
	});

	test("Precedence: bulk", () => {
		expect(isAutoReply({ Precedence: "bulk" }, "Re: hi")).toBe(true);
	});

	test("a no-reply sender classifies as AUTO_REPLY", () => {
		const r = classifyInbound({
			fromAddr: "noreply@bigco.com",
			subject: "Thanks",
			body: "We received your message.",
			headers: {},
		});
		expect(r.classification).toBe("AUTO_REPLY");
	});
});

describe("threading headers", () => {
	test("extracts, lowercases and dedupes ids from In-Reply-To and References", () => {
		const ids = referencedMessageIds("<A1@ei.example>", [
			"<a1@ei.example> <B2@ei.example>",
		]);
		expect(ids).toEqual(["<a1@ei.example>", "<b2@ei.example>"]);
	});

	test("missing headers yield nothing", () => {
		expect(referencedMessageIds(undefined, undefined)).toEqual([]);
	});
});

describe("html-only mail", () => {
	test("is converted to readable text, entities decoded, scripts dropped", () => {
		const t = htmlToText(
			"<style>p{color:red}</style><div>Hi Danio,</div><p>Yes &amp; please call me.<br>Thanks</p><script>x()</script>",
		);
		expect(t).toContain("Hi Danio,");
		expect(t).toContain("Yes & please call me.");
		expect(t).not.toContain("color:red");
		expect(t).not.toContain("x()");
	});

	test("an html-only opt-out is still caught once converted", () => {
		expect(
			human(htmlToText("<div><b>Please unsubscribe me</b></div>"))
				.classification,
		).toBe("STOP");
	});

	test("nothing new to read means a human must look", () => {
		expect(hasNewText("")).toBe(false);
		expect(hasNewText("  \n ")).toBe(false);
		expect(hasNewText("ok")).toBe(false);
		expect(hasNewText("Yes, call me")).toBe(true);
	});
});
