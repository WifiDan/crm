import { describe, expect, test } from "bun:test";
import {
	groupByLead,
	splitQuoted,
} from "../app/(app)/[slug]/leadgen/reply-thread";

describe("splitQuoted", () => {
	test("keeps the new text and folds an Apple Mail quote", () => {
		const body =
			"I just sent the photos.\nThanks\n\nOn Sep 12, 2026, at 20:43, Danio <d@x.com> wrote:\nOld text";
		const out = splitQuoted(body);
		expect(out.latest).toBe("I just sent the photos.\nThanks");
		expect(out.earlier.startsWith("On Sep 12")).toBe(true);
	});

	test("folds a Gmail quote split over two lines", () => {
		const out = splitQuoted(
			"What do you charge?\n\nOn Fri, Sep 4, 2026 at 6:30 PM <d@x.com>\nwrote:\n> Hi",
		);
		expect(out.latest).toBe("What do you charge?");
		expect(out.earlier).toContain("> Hi");
	});

	test("folds '>' quotes, forwarded mail and Zoho headers", () => {
		expect(splitQuoted("Yes\n> earlier").latest).toBe("Yes");
		expect(
			splitQuoted("FYI\nBegin forwarded message:\nFrom: Square").latest,
		).toBe("FYI");
		expect(
			splitQuoted("Ok\n---- On Wed, 26 Aug 2026 X wrote ----\nold").latest,
		).toBe("Ok");
	});

	test("does not cut ordinary sentences that start with On", () => {
		const body = "Hi\nOn payment, I can do half now.\nThanks";
		expect(splitQuoted(body)).toEqual({ latest: body, earlier: "" });
	});

	test("never returns an empty reply for a body that starts quoted", () => {
		expect(splitQuoted("> only a quote").latest).toBe("> only a quote");
		expect(splitQuoted(null)).toEqual({ latest: "", earlier: "" });
	});
});

describe("groupByLead", () => {
	const item = (id: string, lead: string, at: string) => ({
		id,
		lead: { id: lead },
		inbound: { receivedAt: at },
	});

	test("one group per lead, newest reply on top, groups newest first", () => {
		const groups = groupByLead([
			item("a", "fiona", "2026-09-08T10:00:00Z"),
			item("b", "fiona", "2026-09-14T10:00:00Z"),
			item("c", "red", "2026-09-20T10:00:00Z"),
			item("d", "fiona", "2026-09-12T10:00:00Z"),
		]);
		expect(groups.map((g) => g.key)).toEqual(["red", "fiona"]);
		expect(groups[1]?.latest.id).toBe("b");
		expect(groups[1]?.older.map((i) => i.id)).toEqual(["d", "a"]);
	});
});
