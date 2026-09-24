import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
	BRIDGE_BODY,
	BRIDGE_SCRIPT,
	injectBridge,
	stripBridge,
} from "../src/leadgen/demo-bridge";
import {
	assertBackupOutsideOutput,
	BACKUP_PATTERN,
	commitSave,
	contentTypeOf,
	DEMO_LIMITS,
	DemoFileError,
	prepareSave,
	pruneBackups,
	readDemoIndex,
	resolveDemoDir,
	resolveDemoFile,
	sha256Of,
} from "../src/leadgen/demo-files";
import { mintToken, verifyToken } from "../src/leadgen/demo-preview-token";

const PAGE = `<!doctype html><html><head><title>Demo</title></head><body>${"<p>hello</p>".repeat(60)}</body></html>`;

let root: string;
let out: string;
let backups: string;
let secret: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "demo-files-"));
	out = join(root, "output");
	backups = join(root, "backups");
	secret = join(root, "secret.txt");
	mkdirSync(join(out, "acme-demo", "assets"), { recursive: true });
	writeFileSync(join(out, "acme-demo", "index.html"), PAGE);
	writeFileSync(join(out, "acme-demo", "assets", "logo.png"), "png");
	writeFileSync(secret, "top secret");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const code = async (fn: () => Promise<unknown>) => {
	try {
		await fn();
	} catch (e) {
		return e instanceof DemoFileError ? e.code : `other:${String(e)}`;
	}
	return "no-error";
};

describe("resolveDemoDir", () => {
	test("finds a real build folder", async () => {
		expect(await resolveDemoDir(out, "acme-demo")).toBe(
			join(realpathSync(out), "acme-demo"),
		);
	});

	for (const bad of [
		"",
		"..",
		".",
		"../output",
		"acme-demo/",
		"acme/demo",
		"Acme-Demo",
		"acme_demo",
		"acme demo",
		"acme-demo\0",
		"%2e%2e",
		"acme-demo\\..",
	]) {
		test(`refuses slug ${JSON.stringify(bad)}`, async () => {
			expect(await code(() => resolveDemoDir(out, bad))).toBe("bad-slug");
		});
	}

	test("refuses a slug with no folder", async () => {
		expect(await code(() => resolveDemoDir(out, "nope"))).toBe("not-found");
	});

	test("refuses a folder with no index.html", async () => {
		mkdirSync(join(out, "empty-demo"));
		expect(await code(() => resolveDemoDir(out, "empty-demo"))).toBe(
			"not-found",
		);
	});

	test("refuses a symlinked demo folder even when it points at a real build", async () => {
		symlinkSync(join(out, "acme-demo"), join(out, "alias-demo"));
		expect(await code(() => resolveDemoDir(out, "alias-demo"))).toBe("symlink");
	});

	test("refuses a symlinked demo folder that points outside", async () => {
		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(root, "elsewhere", "index.html"), PAGE);
		symlinkSync(join(root, "elsewhere"), join(out, "escape-demo"));
		expect(await code(() => resolveDemoDir(out, "escape-demo"))).toBe(
			"symlink",
		);
	});

	test("refuses a symlinked index.html", async () => {
		mkdirSync(join(out, "linked-demo"));
		symlinkSync(secret, join(out, "linked-demo", "index.html"));
		expect(await code(() => resolveDemoDir(out, "linked-demo"))).toBe(
			"not-found",
		);
	});
});

describe("resolveDemoFile", () => {
	test("serves index.html for an empty path and for a folder", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "index.html"), "x");
		expect((await resolveDemoFile(dir, [])).path).toBe(join(dir, "index.html"));
		expect((await resolveDemoFile(dir, ["sub"])).path).toBe(
			join(dir, "sub", "index.html"),
		);
	});

	test("serves an asset with its type", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const file = await resolveDemoFile(dir, ["assets", "logo.png"]);
		expect(file.type).toBe("image/png");
		expect(file.size).toBe(3);
	});

	const attacks: Array<[string, string[]]> = [
		["dot-dot", [".."]],
		["dot-dot then secret", ["..", "..", "secret.txt"]],
		["nested dot-dot", ["assets", "..", "index.html"]],
		["absolute", ["/etc/passwd"]],
		["backslash", ["..\\secret.txt"]],
		["slash inside a segment", ["assets/logo.png"]],
		["NUL", ["logo.png\0.html"]],
		["dotfile", [".env"]],
		["hidden temp", [".index.abc123.tmp"]],
		["empty segment", ["assets", "", "logo.png"]],
		["single dot", [".", "index.html"]],
		["long segment", ["a".repeat(500)]],
	];
	for (const [name, segments] of attacks) {
		test(`refuses ${name}`, async () => {
			const dir = await resolveDemoDir(out, "acme-demo");
			const result = await code(() => resolveDemoFile(dir, segments));
			expect(["bad-path", "not-found"]).toContain(result);
		});
	}

	test("refuses a backup file name", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const name = "index.2026-09-20T10-11-12-123Z.bak.html";
		writeFileSync(join(dir, name), "old");
		expect(await code(() => resolveDemoFile(dir, [name]))).toBe("bad-path");
	});

	test("refuses a symlinked file that points at a secret outside", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		symlinkSync(secret, join(dir, "assets", "leak.txt"));
		expect(await code(() => resolveDemoFile(dir, ["assets", "leak.txt"]))).toBe(
			"symlink",
		);
	});

	test("refuses a path through a symlinked directory", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		mkdirSync(join(root, "outside-dir"));
		writeFileSync(join(root, "outside-dir", "x.txt"), "x");
		symlinkSync(join(root, "outside-dir"), join(dir, "assets", "door"));
		expect(
			await code(() => resolveDemoFile(dir, ["assets", "door", "x.txt"])),
		).toBe("symlink");
	});

	test("a missing file is not-found", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		expect(await code(() => resolveDemoFile(dir, ["nope.png"]))).toBe(
			"not-found",
		);
	});

	test("content types: known, case-insensitive, unknown falls back to a download type", () => {
		expect(contentTypeOf("a.HTML")).toContain("text/html");
		expect(contentTypeOf("a.svg")).toBe("image/svg+xml");
		expect(contentTypeOf("a.woff2")).toBe("font/woff2");
		expect(contentTypeOf("a.exe")).toBe("application/octet-stream");
		expect(contentTypeOf("noext")).toBe("application/octet-stream");
	});
});

describe("prepareSave and commitSave", () => {
	const now = new Date("2026-09-21T10:11:12.123Z");
	const edited = PAGE.replace("Demo", "Demo edited");

	test("refuses a page that is too short, not HTML, or too big, and touches nothing", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const sha = sha256Of(PAGE);
		for (const html of ["", "<html>tiny</html>", "x".repeat(600)]) {
			expect(
				await code(() => prepareSave({ dir, html, expectedSha256: sha, now })),
			).toBe("not-html");
		}
		const huge = `<html>${"a".repeat(DEMO_LIMITS.maxBytes + 10)}</html>`;
		expect(
			await code(() =>
				prepareSave({ dir, html: huge, expectedSha256: sha, now }),
			),
		).toBe("too-large");
		expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(PAGE);
		expect(readdirSync(dir).sort()).toEqual(["assets", "index.html"]);
	});

	test("the byte cap counts bytes, not characters", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const html = `<html>${"€".repeat(Math.ceil(DEMO_LIMITS.maxBytes / 3) + 10)}</html>`;
		expect(html.length).toBeLessThan(DEMO_LIMITS.maxBytes);
		expect(
			await code(() =>
				prepareSave({ dir, html, expectedSha256: sha256Of(PAGE), now }),
			),
		).toBe("too-large");
	});

	test("refuses when the file changed since the page loaded", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		expect(
			await code(() =>
				prepareSave({
					dir,
					html: edited,
					expectedSha256: sha256Of("other"),
					now,
				}),
			),
		).toBe("stale");
	});

	test("strips the editor bridge before saving", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const prepared = await prepareSave({
			dir,
			html: injectBridge(edited),
			expectedSha256: sha256Of(PAGE),
			now,
		});
		expect(prepared.html).not.toContain("data-leadgen-bridge");
		expect(prepared.html).toBe(edited);
	});

	test("refuses html that still names the bridge after stripping", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const sneaky = edited.replace(
			"</body>",
			"<script  data-leadgen-bridge>1</script></body>",
		);
		expect(
			await code(() =>
				prepareSave({ dir, html: sneaky, expectedSha256: sha256Of(PAGE), now }),
			),
		).toBe("not-html");
	});

	test("writes a backup first, then the new file, and records hashes", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const prepared = await prepareSave({
			dir,
			html: edited,
			expectedSha256: sha256Of(PAGE),
			now,
		});
		expect(prepared.backupName).toBe("index.2026-09-21T10-11-12-123Z.bak.html");
		expect(BACKUP_PATTERN.test(prepared.backupName)).toBe(true);
		const done = await commitSave(prepared, backups);
		expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(edited);
		expect(readFileSync(done.backupPath, "utf8")).toBe(PAGE);
		expect(done.backupPath).toBe(
			join(backups, "acme-demo", prepared.backupName),
		);
		expect(prepared.before.sha256).toBe(sha256Of(PAGE));
		expect(prepared.after.sha256).toBe(sha256Of(edited));
		expect(readDemoIndex(dir).then((r) => r.sha256)).resolves.toBe(
			sha256Of(edited),
		);
	});

	test("nothing but index.html changes inside the demo folder, and no backup or temp file lands there", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const prepared = await prepareSave({
			dir,
			html: edited,
			expectedSha256: sha256Of(PAGE),
			now,
		});
		await commitSave(prepared, backups);
		expect(readdirSync(dir).sort()).toEqual(["assets", "index.html"]);
	});

	test("a failed write removes its temp file and leaves the original", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const prepared = await prepareSave({
			dir,
			html: edited,
			expectedSha256: sha256Of(PAGE),
			now,
		});
		rmSync(join(dir, "index.html"));
		mkdirSync(join(dir, "index.html"));
		expect(await code(() => commitSave(prepared, backups))).toContain("other:");
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("two saves in the same millisecond do not overwrite a backup", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const first = await prepareSave({
			dir,
			html: edited,
			expectedSha256: sha256Of(PAGE),
			now,
		});
		await commitSave(first, backups);
		const second = await prepareSave({
			dir,
			html: PAGE,
			expectedSha256: sha256Of(edited),
			now,
		});
		expect(await code(() => commitSave(second, backups))).toContain("other:");
		expect(
			readFileSync(join(backups, "acme-demo", first.backupName), "utf8"),
		).toBe(PAGE);
	});
});

describe("backup pruning", () => {
	const name = (i: number) =>
		`index.2026-09-${String(10 + i).padStart(2, "0")}T00-00-00-000Z.bak.html`;

	test("keeps the newest N, removes only pattern matches, ignores everything else", async () => {
		const dir = join(backups, "acme-demo");
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 15; i++) writeFileSync(join(dir, name(i)), String(i));
		for (const other of [
			"notes.txt",
			"index.html",
			"index.2026-09-10.bak.html",
			"index.2026-09-10T00-00-00-000Z.bak.html.keep",
			"xindex.2026-09-10T00-00-00-000Z.bak.html",
		])
			writeFileSync(join(dir, other), "keep me");
		mkdirSync(join(dir, "index.2026-01-01T00-00-00-000Z.bak.html"));
		const removed = await pruneBackups(dir, 10);
		expect(removed.length).toBe(5);
		expect(removed).toEqual([name(0), name(1), name(2), name(3), name(4)]);
		const left = readdirSync(dir).sort();
		expect(left.filter((n) => BACKUP_PATTERN.test(n)).length).toBe(11);
		for (const other of [
			"notes.txt",
			"index.html",
			"index.2026-09-10.bak.html",
		])
			expect(left).toContain(other);
	});

	test("does nothing at or below the limit and tolerates a missing folder", async () => {
		expect(await pruneBackups(join(backups, "never-made"), 10)).toEqual([]);
		const dir = join(backups, "few");
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 10; i++) writeFileSync(join(dir, name(i)), "x");
		expect(await pruneBackups(dir, 10)).toEqual([]);
	});

	test("a commit prunes to the limit", async () => {
		const dir = await resolveDemoDir(out, "acme-demo");
		const slugBackups = join(backups, "acme-demo");
		mkdirSync(slugBackups, { recursive: true });
		for (let i = 0; i < 12; i++) writeFileSync(join(slugBackups, name(i)), "x");
		const prepared = await prepareSave({
			dir,
			html: PAGE.replace("Demo", "New"),
			expectedSha256: sha256Of(PAGE),
			now: new Date("2027-01-01T00:00:00.000Z"),
		});
		const done = await commitSave(prepared, backups);
		expect(
			readdirSync(slugBackups).filter((n) => BACKUP_PATTERN.test(n)).length,
		).toBe(DEMO_LIMITS.keepBackups);
		expect(existsSync(done.backupPath)).toBe(true);
	});
});

describe("the backup folder cannot sit inside the output folder", () => {
	test("refuses a backup dir inside output, even one that does not exist yet", async () => {
		expect(
			await code(() => assertBackupOutsideOutput(out, join(out, "bak"))),
		).toBe("outside");
		expect(
			await code(() => assertBackupOutsideOutput(out, join(out, "acme-demo"))),
		).toBe("outside");
		expect(await code(() => assertBackupOutsideOutput(out, out))).toBe(
			"outside",
		);
	});
	test("refuses a symlink that leads into the output folder", async () => {
		symlinkSync(out, join(root, "sneaky"));
		expect(
			await code(() =>
				assertBackupOutsideOutput(out, join(root, "sneaky", "x")),
			),
		).toBe("outside");
	});
	test("accepts a sibling folder", async () => {
		expect(await code(() => assertBackupOutsideOutput(out, backups))).toBe(
			"no-error",
		);
	});
});

describe("preview tokens", () => {
	const key = Buffer.from("k".repeat(32));
	const now = 1_000_000;
	const claims = { slug: "acme-demo", mode: "view" as const, exp: now + 1000 };

	test("a fresh token verifies and returns its claims", () => {
		expect(verifyToken(key, mintToken(key, claims), now)).toEqual(claims);
	});
	test("an expired token is refused", () => {
		expect(verifyToken(key, mintToken(key, claims), claims.exp)).toBeNull();
	});
	test("a token from another key is refused", () => {
		expect(
			verifyToken(Buffer.from("z".repeat(32)), mintToken(key, claims), now),
		).toBeNull();
	});
	test("a tampered payload is refused (slug swap, mode upgrade)", () => {
		const token = mintToken(key, claims);
		const [payload, mac] = token.split(".") as [string, string];
		const forge = (change: Record<string, unknown>) =>
			`${Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url")}.${mac}`;
		expect(payload).toBeTruthy();
		expect(verifyToken(key, forge({ slug: "other-demo" }), now)).toBeNull();
		expect(verifyToken(key, forge({ mode: "edit" }), now)).toBeNull();
		expect(verifyToken(key, forge({ exp: now + 10 ** 9 }), now)).toBeNull();
	});
	test("garbage is refused without throwing", () => {
		for (const t of ["", "a", "a.b", "a.b.c", ".", "..", "%%%.%%%"])
			expect(verifyToken(key, t, now)).toBeNull();
	});
	test("a validly signed token with a bad slug is refused", () => {
		expect(
			verifyToken(key, mintToken(key, { ...claims, slug: "../x" }), now),
		).toBeNull();
	});
});

describe("editor bridge", () => {
	test("inject puts the bridge first in <head>, once, and strip removes exactly it", () => {
		const once = injectBridge(PAGE);
		expect(
			once.startsWith(
				"<!doctype html><html><head><script data-leadgen-bridge>",
			),
		).toBe(true);
		expect(injectBridge(once)).toBe(once);
		expect(stripBridge(once)).toBe(PAGE);
	});
	test("inject falls back to <html>, then to the start", () => {
		expect(injectBridge("<html><body>x</body></html>")).toContain(
			`<html>${BRIDGE_SCRIPT}<body>`,
		);
		expect(injectBridge("<p>x</p>").startsWith(BRIDGE_SCRIPT)).toBe(true);
	});
	test("the script body cannot end its own <script> element early", () => {
		expect(BRIDGE_BODY.toLowerCase()).not.toContain("</script");
	});

	type Listener = (event: { source: unknown; data: unknown }) => void;
	function run() {
		const sent: Array<Record<string, unknown>> = [];
		const parent = {
			postMessage: (m: Record<string, unknown>, target: string) => {
				sent.push({ ...m, __target: target });
			},
		};
		const doc: Record<string, unknown> = {
			designMode: "off",
			documentElement: {
				cloneNode: () => ({
					querySelectorAll: () => [
						{
							parentNode: {
								removeChild: () => {
									doc.removed = true;
								},
							},
						},
					],
					outerHTML: "<html>serialized</html>",
				}),
			},
		};
		let listener: Listener | null = null;
		const win: Record<string, unknown> = {
			parent,
			addEventListener: (_t: string, fn: Listener) => {
				listener = fn;
			},
		};
		win.window = win;
		runInNewContext(BRIDGE_BODY, { window: win, document: doc });
		const fire = (source: unknown, data: unknown) =>
			(listener as Listener | null)?.({ source, data });
		return { sent, parent, doc, fire };
	}

	test("it announces itself to the parent", () => {
		const { sent } = run();
		expect(sent).toEqual([{ type: "ready", leadgen: 1, __target: "*" }]);
	});

	test("it does nothing when it is the top window", () => {
		const win: Record<string, unknown> = {};
		win.window = win;
		win.parent = win;
		let listening = false;
		win.addEventListener = () => {
			listening = true;
		};
		runInNewContext(BRIDGE_BODY, { window: win, document: {} });
		expect(listening).toBe(false);
	});

	test("edit toggles designMode and reports it", () => {
		const { sent, doc, fire, parent } = run();
		sent.length = 0;
		fire(parent, { leadgen: 1, type: "edit", on: true });
		expect(doc.designMode).toBe("on");
		fire(parent, { leadgen: 1, type: "edit", on: false });
		expect(doc.designMode).toBe("off");
		expect(sent.map((m) => m.on)).toEqual([true, false]);
	});

	test("get-html answers with the serialized page and the caller's nonce, editing off", () => {
		const { sent, doc, fire, parent } = run();
		fire(parent, { leadgen: 1, type: "edit", on: true });
		sent.length = 0;
		fire(parent, { leadgen: 1, type: "get-html", nonce: "abc" });
		expect(doc.designMode).toBe("off");
		expect(doc.removed).toBe(true);
		expect(sent).toEqual([
			{
				type: "html",
				nonce: "abc",
				html: "<!doctype html>\n<html>serialized</html>",
				leadgen: 1,
				__target: "*",
			},
		]);
	});

	test("messages from any other window, or without the marker, are ignored", () => {
		const { sent, doc, fire, parent } = run();
		sent.length = 0;
		fire({}, { leadgen: 1, type: "get-html", nonce: "x" });
		fire(parent, { type: "get-html", nonce: "x" });
		fire(parent, { leadgen: 1 });
		fire(parent, null);
		fire(parent, "string");
		fire(parent, { leadgen: 1, type: "edit", on: true, extra: 1 });
		expect(sent.filter((m) => m.type === "html")).toEqual([]);
		expect(doc.designMode).toBe("on");
	});
});
