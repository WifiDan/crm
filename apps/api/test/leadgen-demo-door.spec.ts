import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	demoInfoInput,
	previewInput,
	saveInput,
} from "../src/leadgen/demo-edit.contracts";
import {
	shotCaptureInput,
	shotStatusInput,
} from "../src/leadgen/shot.contracts";
import { auditInput } from "../src/leadgen/site-audit.contracts";

const SRC = join(import.meta.dir, "../src");
const stripComments = (src: string) =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function allTsFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "generated" ? [] : allTsFiles(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

const files = allTsFiles(SRC).map((path) => ({
	name: relative(SRC, path),
	code: stripComments(readFileSync(path, "utf8")),
}));
const leadgen = files.filter((f) => f.name.startsWith("leadgen/"));
const names = (list: Array<{ name: string }>) => list.map((f) => f.name).sort();
const at = (f: string) => `leadgen/${f}`;
const get = (f: string) => files.find((x) => x.name === at(f))?.code ?? "";

describe("the scan is looking at real files", () => {
	test("it found the new files", () => {
		for (const f of [
			"demo-files.ts",
			"demo-edit.service.ts",
			"demo-edit.router.ts",
			"demo-preview.controller.ts",
			"demo-preview.service.ts",
			"outbound-guard.ts",
			"site-audit.service.ts",
			"site-audit.router.ts",
		])
			expect(names(leadgen)).toContain(at(f));
	});
});

describe("only demo-files.ts changes files on disk", () => {
	const WRITE_API =
		/\b(writeFile|writeFileSync|appendFile|copyFile|rename|unlink|rm|rmdir|mkdir|truncate|symlink|createWriteStream|chmod|utimes)\b\s*\(/;
	test("no other leadgen file calls a file-changing API (the screenshot cache, the audit cache and the browser profile cleanup are the only other writers)", () => {
		const writers = leadgen.filter((f) => WRITE_API.test(f.code));
		expect(names(writers)).toEqual(
			[
				at("audit-cache.ts"),
				at("demo-files.ts"),
				at("shot-browser.ts"),
				at("shot-cache.ts"),
			].sort(),
		);
	});
	test("demo-files.ts really holds them (the allowlist cannot go stale)", () => {
		expect(WRITE_API.test(get("demo-files.ts"))).toBe(true);
	});
	test("only the edit service and the preview service import demo-files", () => {
		const users = leadgen.filter((f) => /["']\.\/demo-files["']/.test(f.code));
		expect(names(users)).toEqual(
			[
				at("demo-edit.contracts.ts"),
				at("demo-edit.service.ts"),
				at("demo-preview.service.ts"),
			].sort(),
		);
	});
	test("only the edit service calls the save path", () => {
		const callers = leadgen.filter((f) =>
			/\b(prepareSave|commitSave)\s*\(/.test(f.code),
		);
		expect(names(callers)).toEqual(
			[at("demo-edit.service.ts"), at("demo-files.ts")].sort(),
		);
	});
	test("the preview service and controller never write", () => {
		for (const f of ["demo-preview.service.ts", "demo-preview.controller.ts"])
			expect(/prepareSave|commitSave|pruneBackups/.test(get(f))).toBe(false);
	});
});

describe("the demo edit and audit routers are human-session doors", () => {
	for (const f of [
		"demo-edit.router.ts",
		"site-audit.router.ts",
		"shot.router.ts",
	]) {
		test(`${f} is session-only for the whole class, with no REST exposure`, () => {
			const code = get(f);
			expect(code).toMatch(
				/@UseMiddlewares\(\s*AuthMiddleware\s*,\s*SessionOnlyMiddleware\s*\)\s*export class/,
			);
			expect(/restMeta/.test(code)).toBe(false);
			expect((code.match(/@UseMiddlewares/g) ?? []).length).toBe(1);
		});
	}
	test("only the edit router imports the edit service", () => {
		const users = leadgen.filter((f) =>
			/["']\.\/demo-edit\.service["']/.test(f.code),
		);
		expect(names(users)).toEqual(
			[at("demo-edit.router.ts"), at("leadgen.module.ts")].sort(),
		);
	});
	test("only the audit router, the module and the prewarm service import the audit service", () => {
		const users = leadgen.filter((f) =>
			/["']\.\/site-audit\.service["']/.test(f.code),
		);
		expect(names(users)).toEqual(
			[
				at("leadgen.module.ts"),
				at("prewarm.service.ts"),
				at("site-audit.router.ts"),
			].sort(),
		);
	});
	test("no job handler or scheduler names any of it", () => {
		for (const f of leadgen.filter((n) => /handler|scheduler/.test(n.name)))
			expect(/demo-|site-audit|outbound-guard|LeadgenShot/.test(f.code)).toBe(
				false,
			);
	});
});

describe("the one anonymous route is a read-only, token-checked file route", () => {
	test("AllowAnonymous appears in exactly one leadgen file", () => {
		expect(names(leadgen.filter((f) => /AllowAnonymous/.test(f.code)))).toEqual(
			[at("demo-preview.controller.ts")],
		);
	});
	test("that controller has one GET and no write verb", () => {
		const code = get("demo-preview.controller.ts");
		expect((code.match(/@Get\(/g) ?? []).length).toBe(1);
		expect(/@(Post|Put|Patch|Delete)\(/.test(code)).toBe(false);
	});
	test("the signing key is random per process, never read from env or a file", () => {
		const service = get("demo-preview.service.ts");
		expect(service).toMatch(/randomBytes\(32\)/);
		expect(
			/process\.env|readFile\(.*key/i.test(get("demo-preview-token.ts")),
		).toBe(false);
	});
});

describe("the inputs cannot carry a URL, a path, a slug or an identity", () => {
	const banned = [
		"url",
		"path",
		"slug",
		"file",
		"target",
		"reviewer",
		"actor",
		"actorId",
		"ids",
		"leads",
		"table",
	];
	for (const [name, shape] of [
		["audit", auditInput.shape],
		["info", demoInfoInput.shape],
		["preview", previewInput.shape],
		["save", saveInput.shape],
	] as const) {
		test(`${name} input has none of them`, () => {
			for (const key of banned) expect(Object.keys(shape)).not.toContain(key);
		});
	}
	test("save requires the hash the page saw and a request id", () => {
		expect(
			saveInput.safeParse({
				id: "x",
				html: "<html>",
				requestId: "no",
				baseSha256: "a".repeat(64),
			}).success,
		).toBe(false);
		expect(
			saveInput.safeParse({
				id: "x",
				html: "<html>",
				requestId: "00000000-0000-4000-8000-000000000001",
				baseSha256: "zz",
			}).success,
		).toBe(false);
		expect(
			saveInput.safeParse({
				id: ["a", "b"],
				html: "<html>",
				requestId: "00000000-0000-4000-8000-000000000001",
				baseSha256: "a".repeat(64),
			}).success,
		).toBe(false);
	});
});

describe("only the outbound guard opens network connections to lead-supplied addresses", () => {
	test("node:http and node:https are imported by the guard alone", () => {
		const users = leadgen.filter((f) =>
			/from\s+["']node:https?["']/.test(f.code),
		);
		expect(names(users)).toEqual([at("outbound-guard.ts")]);
	});
	test("the audit service has no direct fetch and never follows redirects itself", () => {
		const code = get("site-audit.service.ts");
		expect(/\bfetch\s*\(/.test(code)).toBe(false);
		expect(/redirect\s*:/.test(code)).toBe(false);
		expect(/fetchPublic\(/.test(code)).toBe(true);
	});
	test("no leadgen file except the guard asks fetch to follow redirects", () => {
		const offenders = leadgen.filter((f) =>
			/redirect\s*:\s*["']follow["']/.test(f.code),
		);
		expect(names(offenders)).toEqual([]);
	});
});

describe("the screenshot browser", () => {
	test("among the screenshot, demo and audit files among the screenshot, demo and audit files only shot-browser.ts starts a process", () => {
		const users = leadgen.filter(
			(f) =>
				/^leadgen\/(shot|demo|site-audit|outbound)/.test(f.name) &&
				/node:child_process/.test(f.code),
		);
		expect(names(users)).toEqual([at("shot-browser.ts")]);
	});
	test("the browser gets a minimal environment, never the API own environment", () => {
		const code = get("shot-browser.ts");
		expect(/process\.env/.test(code)).toBe(false);
		expect(/\.\.\.process/.test(code)).toBe(false);
		expect(/LD_LIBRARY_PATH/.test(code)).toBe(true);
	});
	test("LD_LIBRARY_PATH is never set on the API process itself", () => {
		for (const f of leadgen)
			expect({
				f: f.name,
				hit: /process\.env\.LD_LIBRARY_PATH|process\.env\[["']LD_LIBRARY_PATH/.test(
					f.code,
				),
			}).toEqual({ f: f.name, hit: false });
	});
	test("the image route needs a session (no anonymous access) and only serves cached files", () => {
		const code = get("shot.controller.ts");
		expect(/AllowAnonymous/.test(code)).toBe(false);
		expect(/captureScreenshot|\.capture\(/.test(code)).toBe(false);
		expect((code.match(/@Get\(/g) ?? []).length).toBe(1);
	});
	test("the shot inputs carry a lead id only", () => {
		const banned = ["url", "path", "slug", "file", "target", "host"];
		for (const shape of [shotStatusInput.shape, shotCaptureInput.shape])
			for (const key of banned) expect(Object.keys(shape)).not.toContain(key);
	});
	test("the service checks the address before it ever starts a browser", () => {
		const code = get("shot.service.ts");
		expect(code.indexOf("this.precheck(")).toBeGreaterThan(-1);
		expect(code.indexOf("this.precheck(")).toBeLessThan(
			code.indexOf("this.run("),
		);
	});
});
