import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type ActionLead,
	type AppliedChange,
	armsOnApprove,
	effectiveLead,
	seenOf,
	stateNote,
} from "../app/(app)/[slug]/leadgen/lead-actions-state";
import { newRequestId } from "../app/(app)/[slug]/leadgen/request-id";

const lead: ActionLead = {
	id: "l1",
	table: "isp",
	businessName: "Alpha",
	decision: null,
	decisionDate: null,
	version: "2026-09-20 14:31:07+00:00",
	sendApproved: false,
};

const applied: AppliedChange = {
	leadId: "l1",
	decision: "Approved",
	decisionDate: "2026-09-20",
	version: "2026-09-20 15:04:06+00:00",
	sendApproved: true,
	reworkRequested: false,
	appliedAt: "2026-09-20T15:04:06.000Z",
};

describe("request ids", () => {
	const pattern =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

	test("are v4 uuids that the API contract accepts", () => {
		for (let i = 0; i < 50; i++) {
			const id = newRequestId();
			expect(id).toMatch(pattern);
			expect(z.uuid().safeParse(id).success).toBe(true);
		}
	});
	test("work without crypto.randomUUID, as on a plain http page over the tailnet", () => {
		const id = newRequestId({
			getRandomValues: (bytes) => {
				bytes.fill(255);
				return bytes;
			},
		});
		expect(id).toMatch(pattern);
		expect(z.uuid().safeParse(id).success).toBe(true);
	});
	test("do not repeat", () => {
		const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
		expect(ids.size).toBe(200);
	});
});

describe("effective lead", () => {
	test("no applied change, or one for another lead, changes nothing", () => {
		expect(effectiveLead(lead, undefined)).toBe(lead);
		expect(effectiveLead(lead, { ...applied, leadId: "other" })).toBe(lead);
	});
	test("a newer applied change overlays decision, flag and version", () => {
		expect(effectiveLead(lead, applied)).toMatchObject({
			decision: "Approved",
			sendApproved: true,
			version: applied.version,
			decisionDate: "2026-09-20",
		});
	});
	test("once the mirror has caught up, the mirror row wins", () => {
		const caught = { ...lead, version: applied.version, decision: "Rejected" };
		expect(effectiveLead(caught, applied)).toBe(caught);
		const newer = { ...lead, version: "2026-09-20 16:00:00+00:00" };
		expect(effectiveLead(newer, applied)).toBe(newer);
	});
	test("a gym result keeps the row's own flag", () => {
		expect(
			effectiveLead(
				{ ...lead, sendApproved: false },
				{ ...applied, sendApproved: null },
			).sendApproved,
		).toBe(false);
	});
	test("the version sent back is the one the row shows, and empty when unknown", () => {
		expect(seenOf(lead)).toEqual({
			updatedAt: lead.version ?? "",
			decision: null,
			decisionDate: null,
		});
		expect(seenOf({ ...lead, version: null }).updatedAt).toBe("");
	});
});

describe("what arms sending, as the page understands it", () => {
	test("only review on the ISP pool", () => {
		expect(armsOnApprove("review", "isp")).toBe(true);
		expect(armsOnApprove("review", "gym")).toBe(false);
		expect(armsOnApprove("triage", "isp")).toBe(false);
		expect(armsOnApprove("triage", "gym")).toBe(false);
		expect(armsOnApprove("review", null)).toBe(false);
	});
	test("the saved note only appears after a save", () => {
		expect(stateNote(undefined)).toBeNull();
		expect(stateNote(applied)).toContain("next mirror run");
	});
});
