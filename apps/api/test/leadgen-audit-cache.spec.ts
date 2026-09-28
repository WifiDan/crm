import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_NAME,
	auditName,
	readAudit,
	writeAudit,
} from "../src/leadgen/audit-cache";
import type { AuditResult } from "../src/leadgen/site-audit";

const LEAD = "clead123456";
const RESULT: AuditResult = {
	score: 55,
	priority: "Medium",
	signals: ["No mobile viewport meta tag (not responsive)"],
	url: "https://a.example/",
};

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "audits-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("audit cache", () => {
	test("names carry the lead id and a URL hash, and only that shape is accepted", () => {
		const a = auditName(LEAD, "https://a.example/");
		const b = auditName(LEAD, "https://b.example/");
		expect(a).not.toBe(b);
		expect(AUDIT_NAME.test(a)).toBe(true);
		expect(() => auditName("../etc", "https://a.example/")).toThrow();
		expect(() => auditName("a/b", "https://a.example/")).toThrow();
		for (const bad of [
			"../x.json",
			"a.b.json",
			`${LEAD}.zzzzzzzzzz.json`,
			"x/../y.json",
		])
			expect(AUDIT_NAME.test(bad)).toBe(false);
	});

	test("write then read; ttl decides fresh", async () => {
		const name = auditName(LEAD, "https://a.example/");
		await writeAudit(root, name, RESULT);
		const now = new Date();
		const hit = await readAudit(root, name, now);
		expect(hit?.fresh).toBe(true);
		expect(hit?.result).toEqual(RESULT);
		const later = new Date(now.getTime() + 15 * 24 * 3600 * 1000);
		expect((await readAudit(root, name, later))?.fresh).toBe(false);
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "secret.json"), "{}");
		expect(
			await readAudit(join(root, "sub"), "../secret.json", now),
		).toBeNull();
		expect(
			await readAudit(
				root,
				auditName("other123456", "https://a.example/"),
				now,
			),
		).toBeNull();
	});

	test("a new URL for the same lead replaces the old audit", async () => {
		const old = auditName(LEAD, "https://old.example/");
		const next = auditName(LEAD, "https://new.example/");
		await writeAudit(root, old, RESULT);
		const removed = await writeAudit(root, next, RESULT);
		expect(removed).toEqual([old]);
		expect(readdirSync(root)).toEqual([next]);
	});

	test("the cache is bounded by file count, oldest first, never the new file", async () => {
		const names = ["aaaaaa1", "bbbbbb2", "cccccc3", "dddddd4"].map((id) =>
			auditName(id.padEnd(8, "0"), "https://a.example/"),
		);
		for (const [i, n] of names.entries()) {
			await writeAudit(root, n, RESULT, { maxFiles: 99, maxBytes: 1e9 });
			const t = new Date(Date.now() - (10 - i) * 1000);
			utimesSync(join(root, n), t, t);
		}
		const fifth = auditName("eeeeee50", "https://a.example/");
		const removed = await writeAudit(root, fifth, RESULT, {
			maxFiles: 3,
			maxBytes: 1e9,
		});
		expect(removed.sort()).toEqual(
			[names[0] as string, names[1] as string].sort(),
		);
		expect(readdirSync(root).sort()).toEqual(
			[names[2] as string, names[3] as string, fifth].sort(),
		);
	});

	test("non-cache files in the folder are never touched", async () => {
		writeFileSync(join(root, "keep.txt"), "x");
		await writeAudit(root, auditName(LEAD, "https://a.example/"), RESULT, {
			maxFiles: 0,
			maxBytes: 0,
		});
		expect(existsSync(join(root, "keep.txt"))).toBe(true);
	});
});
