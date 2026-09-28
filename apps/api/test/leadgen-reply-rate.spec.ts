import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POOL_COUNTS } from "../src/leadgen/ops.sql";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const sql = squash(POOL_COUNTS.sql);

describe("reply rate is distinct replied leads over initial sends", () => {
	test("replied counts lead rows that carry a reply timestamp", () => {
		expect(sql).toContain(
			`count(*) FILTER (WHERE l."repliedAt" IS NOT NULL)::int AS replied`,
		);
	});

	test("sent counts lead rows that carry an initial send timestamp", () => {
		expect(sql).toContain(
			`count(*) FILTER (WHERE l."sentAt" IS NOT NULL)::int AS sent`,
		);
	});

	test("both counts read one row per lead, so a lead with many replies counts once", () => {
		expect(sql).toMatch(/FROM lg_lead l WHERE/);
		expect(sql).not.toMatch(/\bJOIN\b/i);
		expect(sql).not.toMatch(/lg_inbound_message/);
		expect(sql).not.toMatch(/lg_outreach_send/);
	});

	test("the Ops tile divides those two counts and says so", () => {
		const tab = readFileSync(
			join(import.meta.dir, "../../app/app/(app)/[slug]/leadgen/ops-tab.tsx"),
			"utf8",
		);
		expect(tab).toContain("percent(t.replied, t.sent)");
		expect(tab).toContain("reply rate (leads, not messages)");
	});
});
