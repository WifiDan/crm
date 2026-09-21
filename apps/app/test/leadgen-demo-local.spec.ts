import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	acceptBridgeMessage,
	LOCAL_FRAME_SANDBOX,
	linkExpired,
	localStatusLine,
} from "../app/(app)/[slug]/leadgen/demo-local-state";
import { nextIdAfter } from "../app/(app)/[slug]/leadgen/lead-actions-state";
import { auditView } from "../app/(app)/[slug]/leadgen/site-audit-view";

const DIR = join(import.meta.dir, "../app/(app)/[slug]/leadgen");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

describe("the sandbox attribute for the local copy", () => {
	test("is exactly allow-scripts: no same-origin, no navigation, no popups, no forms", () => {
		expect(LOCAL_FRAME_SANDBOX).toBe("allow-scripts");
	});
	test("the pane uses that constant for its iframe and never spells out a weaker one", () => {
		const pane = read("demo-local-pane.tsx");
		expect(pane).toContain("sandbox={LOCAL_FRAME_SANDBOX}");
		expect((pane.match(/<iframe/g) ?? []).length).toBe(1);
		expect(pane).not.toContain("allow-same-origin");
		expect(pane).not.toContain("allow-top-navigation");
		expect(read("demo-local-state.ts")).not.toContain("allow-same-origin");
	});
	test("the iframe source is the signed preview path from the API, nothing built from user input", () => {
		const pane = read("demo-local-pane.tsx");
		expect(pane).toContain("src={link.data.path}");
	});
	test("the local pane never reads the CRM cookie or storage and never calls fetch itself", () => {
		const pane = read("demo-local-pane.tsx");
		expect(pane).not.toMatch(
			/document\.cookie|localStorage|sessionStorage|\bfetch\(/,
		);
	});
});

describe("messages from the frame", () => {
	const win = {};
	const good = { leadgen: 1, type: "html", nonce: "n1", html: "<html></html>" };
	test("accepts the three known shapes from the frame's own window", () => {
		expect(
			acceptBridgeMessage(
				{ source: win, data: { leadgen: 1, type: "ready" } },
				win,
			),
		).toEqual({ type: "ready" });
		expect(
			acceptBridgeMessage(
				{ source: win, data: { leadgen: 1, type: "edit-state", on: true } },
				win,
			),
		).toEqual({ type: "edit-state", on: true });
		expect(acceptBridgeMessage({ source: win, data: good }, win)).toEqual({
			type: "html",
			nonce: "n1",
			html: "<html></html>",
		});
	});
	test("refuses any other window, including when the frame window is missing", () => {
		expect(acceptBridgeMessage({ source: {}, data: good }, win)).toBeNull();
		expect(acceptBridgeMessage({ source: win, data: good }, null)).toBeNull();
		expect(acceptBridgeMessage({ source: null, data: good }, null)).toBeNull();
	});
	test("refuses malformed or unmarked data", () => {
		for (const data of [
			null,
			"x",
			5,
			{},
			{ type: "html", nonce: "n", html: "x" },
			{ leadgen: 2, type: "ready" },
			{ leadgen: 1, type: "html", nonce: 1, html: "x" },
			{ leadgen: 1, type: "html", nonce: "n" },
			{ leadgen: 1, type: "edit-state", on: "yes" },
			{ leadgen: 1, type: "other" },
		])
			expect(acceptBridgeMessage({ source: win, data }, win)).toBeNull();
	});
});

describe("link expiry and the not-live wording", () => {
	test("a link expires exactly at its expiry time", () => {
		expect(
			linkExpired(
				"2026-09-21T10:00:00.000Z",
				Date.parse("2026-09-21T09:59:59.999Z"),
			),
		).toBe(false);
		expect(
			linkExpired(
				"2026-09-21T10:00:00.000Z",
				Date.parse("2026-09-21T10:00:00.000Z"),
			),
		).toBe(true);
	});
	test("a fresh save says saved locally and not live, with the backup name", () => {
		const line = localStatusLine(
			{ savedAt: "2026-09-21T10:00:00.000Z", backupName: "index.x.bak.html" },
			null,
		);
		expect(line).toContain("Saved locally");
		expect(line).toContain("Not live yet");
		expect(line).toContain("index.x.bak.html");
	});
	test("an earlier saved edit is never called live", () => {
		const line = localStatusLine(null, {
			at: "2026-09-20T10:00:00.000Z",
			by: "danio@wifielite.com",
			backupName: "b",
			status: "APPLIED",
		});
		expect(line).toContain("not confirmed live");
		expect(line).not.toMatch(/\bis live\b/);
	});
	test("an unknown-result save warns, a failed one stays quiet, nothing says nothing", () => {
		expect(
			localStatusLine(null, {
				at: "2026-09-20T10:00:00.000Z",
				by: null,
				backupName: "b",
				status: "UNKNOWN",
			}),
		).toContain("unknown result");
		expect(
			localStatusLine(null, {
				at: "2026-09-20T10:00:00.000Z",
				by: null,
				backupName: "b",
				status: "FAILED",
			}),
		).toBeNull();
		expect(localStatusLine(null, null)).toBeNull();
	});
});

describe("advancing after a decision", () => {
	test("goes to the next card, else the previous one, else nowhere", () => {
		expect(nextIdAfter(["a", "b", "c"], "a")).toBe("b");
		expect(nextIdAfter(["a", "b", "c"], "b")).toBe("c");
		expect(nextIdAfter(["a", "b", "c"], "c")).toBe("b");
		expect(nextIdAfter(["a"], "a")).toBeNull();
		expect(nextIdAfter(["a", "b"], "zzz")).toBeNull();
		expect(nextIdAfter([], "a")).toBeNull();
	});
});

describe("audit display", () => {
	test("mirrors the old colours and wording", () => {
		expect(
			auditView({ score: 45, priority: "Medium", signals: ["x"], url: "u" }),
		).toEqual({
			headline: "Priority: Medium | Score: 45/100",
			tone: "outline",
			lines: ["x"],
			empty: null,
		});
		expect(
			auditView({ score: 100, priority: "Low", signals: [], url: "u" }),
		).toEqual({
			headline: "Priority: Low | Score: 100/100",
			tone: "secondary",
			lines: [],
			empty: "No outdated signals detected.",
		});
		expect(
			auditView({ score: 10, priority: "High", signals: ["a", "b"], url: "u" })
				.tone,
		).toBe("destructive");
	});
	test("a failed audit shows the reason and never claims there were no signals", () => {
		const v = auditView({
			score: 0,
			priority: "Error",
			signals: ["Could not audit: refused: x"],
			url: "u",
		});
		expect(v.headline).toBe("Audit failed");
		expect(v.empty).toBeNull();
		expect(v.lines).toEqual(["Could not audit: refused: x"]);
	});
});
