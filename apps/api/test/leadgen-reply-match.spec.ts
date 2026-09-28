import { describe, expect, test } from "bun:test";
import {
	buildMatchIndexes,
	describeMatch,
	matchLeads,
} from "../src/leadgen/reply-match";

const leads = [
	{ id: "L1", email: "owner@acme.com", nocodbRowId: 10, doNotContact: false },
	{
		id: "L2",
		email: "shared@winery.com",
		nocodbRowId: 20,
		doNotContact: false,
	},
	{ id: "L3", email: "shared@winery.com", nocodbRowId: 5, doNotContact: false },
	{ id: "L4", email: null, nocodbRowId: 40, doNotContact: false },
];
const sends = [
	{
		id: "S1",
		leadId: "L1",
		messageId: "<M1@ei.example>",
		toAddr: "Owner@Acme.com",
	},
	{ id: "S2", leadId: "L2", messageId: null, toAddr: "shared@winery.com" },
	{ id: "S3", leadId: "L3", messageId: null, toAddr: "shared@winery.com" },
];
const contacts = [{ leadId: "L4", value: "Found@Discovered.org" }];
const idx = buildMatchIndexes(sends, leads, contacts);

describe("reply attribution", () => {
	test("our own Message-ID coming back beats every other signal", () => {
		const m = matchLeads(idx, {
			fromAddr: "someone-else@gmail.com",
			subject: "Re: hi",
			refs: ["<m1@ei.example>"],
		});
		expect(m).toEqual({
			leadIds: ["L1"],
			method: "in_reply_to",
			matchedSendId: "S1",
		});
	});

	test("an address we mailed matches, case-insensitively", () => {
		const m = matchLeads(idx, {
			fromAddr: "OWNER@acme.com",
			subject: "hello",
			refs: [],
		});
		expect(m.method).toBe("send_log_email");
		expect(m.leadIds).toEqual(["L1"]);
	});

	test("a shared address returns EVERY lead row, ordered by NocoDB row id", () => {
		const m = matchLeads(idx, {
			fromAddr: "shared@winery.com",
			subject: "Re: x",
			refs: [],
		});
		expect(m.leadIds).toEqual(["L3", "L2"]);
		expect(describeMatch(m)).toBe("send_log_email(2 leads)");
	});

	test("a lead's own address needs a reply-shaped message", () => {
		const cold = matchLeads(idx, {
			fromAddr: "found@discovered.org",
			subject: "Quick question about your services",
			refs: [],
		});
		expect(cold.method).toBeNull();
		const reply = matchLeads(idx, {
			fromAddr: "found@discovered.org",
			subject: "Re: I rebuilt your website",
			refs: [],
		});
		expect(reply).toEqual({
			leadIds: ["L4"],
			method: "lead_email",
			matchedSendId: null,
		});
	});

	test("a stranger who merely mentions a business name is never matched", () => {
		const m = matchLeads(idx, {
			fromAddr: "stranger@example.net",
			subject: "Re: I rebuilt Acme's website",
			refs: [],
		});
		expect(m).toEqual({ leadIds: [], method: null, matchedSendId: null });
		expect(describeMatch(m)).toBeNull();
	});
});
