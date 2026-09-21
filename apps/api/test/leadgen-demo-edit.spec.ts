import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@crm/db";
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	InternalServerErrorException,
	NotFoundException,
	PayloadTooLargeException,
} from "@nestjs/common";
import { BRIDGE_MARKER } from "../src/leadgen/demo-bridge";
import type { DemoDirs } from "../src/leadgen/demo-edit.config";
import { DemoEditService } from "../src/leadgen/demo-edit.service";
import { sha256Of } from "../src/leadgen/demo-files";
import { DemoPreviewService } from "../src/leadgen/demo-preview.service";

const PAGE = `<!doctype html><html><head><title>Acme</title></head><body>${"<p>hello</p>".repeat(60)}</body></html>`;
const EDITED = PAGE.replace("Acme", "Acme Plumbing");
const DANIO = { id: "user-1", email: "danio@wifielite.com" };
const OTHER = { id: "user-2", email: "someone@example.com" };
const REQ = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = Record<string, unknown>;

let root: string;
let dirs: DemoDirs;
let now: Date;
let audit: Row[];
let atCreate: Array<{ fileSha: string; backupExists: boolean }>;
let leadUrl: string | null;
let savedEnv: string | undefined;

function fakeDb(): Db {
	let n = 0;
	const lgLead = {
		findFirst: async (args: { where: { id: string } }) =>
			args.where.id === "missing" ? null : { demoUrl: leadUrl },
	};
	const lgDemoEdit = {
		create: async ({ data }: { data: Row }) => {
			const slug = String(data.slug);
			atCreate.push({
				fileSha: sha256Of(
					readFileSync(join(dirs.outputDir, slug, "index.html")),
				),
				backupExists: existsSync(
					join(dirs.backupDir, slug, String(data.backupName)),
				),
			});
			if (audit.some((a) => a.requestId === data.requestId))
				throw Object.assign(new Error("dup"), { code: "P2002" });
			const row = {
				id: `audit-${++n}`,
				createdAt: now,
				completedAt: null,
				result: null,
				outcome: null,
				...data,
			};
			audit.push(row);
			return row;
		},
		findUnique: async ({ where }: { where: { requestId: string } }) =>
			audit.find((a) => a.requestId === where.requestId) ?? null,
		findFirst: async ({ where }: { where: Row }) =>
			[...audit]
				.reverse()
				.find((a) =>
					Object.entries(where).every(([k, v]) =>
						k === "createdAt" ? true : a[k] === v,
					),
				) ?? null,
		update: async ({ where, data }: { where: { id: string }; data: Row }) => {
			const row = audit.find((a) => a.id === where.id);
			if (!row) throw new Error("no row");
			Object.assign(row, data);
			return row;
		},
	};
	return { lgLead, lgDemoEdit } as unknown as Db;
}

function makeService() {
	const key = Buffer.alloc(32, 7);
	const clock = () => now;
	const previews = new DemoPreviewService(key, dirs, clock);
	const service = new DemoEditService(fakeDb(), dirs, clock, previews);
	return { service, previews };
}

const index = () => join(dirs.outputDir, "acme-demo", "index.html");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "demo-edit-"));
	dirs = { outputDir: join(root, "output"), backupDir: join(root, "backups") };
	mkdirSync(join(dirs.outputDir, "acme-demo", "assets"), { recursive: true });
	writeFileSync(index(), PAGE);
	writeFileSync(
		join(dirs.outputDir, "acme-demo", "assets", "logo.png"),
		"png-bytes",
	);
	writeFileSync(join(root, "secret.txt"), "secret");
	now = new Date("2026-09-21T10:11:12.123Z");
	audit = [];
	atCreate = [];
	leadUrl = "https://acme-demo.ei-leadgen-demos.pages.dev";
	savedEnv = process.env.LEADGEN_DECISION_APPROVERS;
	process.env.LEADGEN_DECISION_APPROVERS = "danio@wifielite.com";
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.LEADGEN_DECISION_APPROVERS;
	else process.env.LEADGEN_DECISION_APPROVERS = savedEnv;
	rmSync(root, { recursive: true, force: true });
});

const save = (over: Partial<Parameters<DemoEditService["save"]>[0]> = {}) =>
	makeService().service.save({
		leadId: "lead-1",
		requestId: REQ(1),
		html: EDITED,
		baseSha256: sha256Of(PAGE),
		actor: DANIO,
		...over,
	});

const rejects = async (p: Promise<unknown>) => {
	try {
		await p;
	} catch (e) {
		return e;
	}
	return null;
};

const untouched = () => {
	expect(readFileSync(index(), "utf8")).toBe(PAGE);
	expect(existsSync(dirs.backupDir)).toBe(false);
	expect(audit.length).toBe(0);
	expect(readdirSync(join(dirs.outputDir, "acme-demo")).sort()).toEqual([
		"assets",
		"index.html",
	]);
};

describe("who may save", () => {
	test("a signed-in user who is not an approver is refused and nothing changes", async () => {
		expect(await rejects(save({ actor: OTHER }))).toBeInstanceOf(
			ForbiddenException,
		);
		untouched();
	});
	test("an unset allowlist refuses everyone", async () => {
		delete process.env.LEADGEN_DECISION_APPROVERS;
		expect(await rejects(save())).toBeInstanceOf(ForbiddenException);
		untouched();
	});
	test("an empty allowlist refuses everyone", async () => {
		process.env.LEADGEN_DECISION_APPROVERS = " , ";
		expect(await rejects(save())).toBeInstanceOf(ForbiddenException);
		untouched();
	});
	test("a missing email is refused", async () => {
		expect(
			await rejects(save({ actor: { id: "u", email: null } })),
		).toBeInstanceOf(ForbiddenException);
		untouched();
	});
});

describe("which demo may be saved", () => {
	test("an unknown lead is a 404", async () => {
		expect(await rejects(save({ leadId: "missing" }))).toBeInstanceOf(
			NotFoundException,
		);
		untouched();
	});
	test("a lead with no demo url has no local build", async () => {
		leadUrl = null;
		expect(await rejects(save())).toBeInstanceOf(NotFoundException);
		untouched();
	});
	test("a demo url that is not a Pages address has no local build", async () => {
		leadUrl = "https://evil.example.com/acme-demo";
		expect(await rejects(save())).toBeInstanceOf(NotFoundException);
		untouched();
	});
	test("a slug with no folder is a 404", async () => {
		leadUrl = "https://nothing-here.ei-leadgen-demos.pages.dev";
		expect(await rejects(save())).toBeInstanceOf(NotFoundException);
		untouched();
	});
	test("a 28-character alias resolves to its unique longer folder", async () => {
		mkdirSync(
			join(dirs.outputDir, "cedaredge-community-methodist-thrift-shop-demo"),
		);
		writeFileSync(
			join(
				dirs.outputDir,
				"cedaredge-community-methodist-thrift-shop-demo",
				"index.html",
			),
			PAGE,
		);
		leadUrl = "https://cedaredge-community-methodis.ei-leadgen-demos.pages.dev";
		const out = await save();
		expect(out.slug).toBe("cedaredge-community-methodist-thrift-shop-demo");
	});
	test("a folder that is a symlink is refused", async () => {
		rmSync(join(dirs.outputDir, "acme-demo"), { recursive: true });
		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(root, "elsewhere", "index.html"), PAGE);
		symlinkSync(join(root, "elsewhere"), join(dirs.outputDir, "acme-demo"));
		expect(await rejects(save())).toBeInstanceOf(NotFoundException);
		expect(readFileSync(join(root, "elsewhere", "index.html"), "utf8")).toBe(
			PAGE,
		);
		expect(audit.length).toBe(0);
	});
	test("a backup folder inside the output folder is refused", async () => {
		dirs = { ...dirs, backupDir: join(dirs.outputDir, "bak") };
		expect(await rejects(save())).toBeInstanceOf(InternalServerErrorException);
		expect(readFileSync(index(), "utf8")).toBe(PAGE);
		expect(existsSync(join(dirs.outputDir, "bak"))).toBe(false);
		expect(audit.length).toBe(0);
	});
});

describe("what may be saved", () => {
	test("not a full page, too short, too big", async () => {
		expect(await rejects(save({ html: "<p>hi</p>" }))).toBeInstanceOf(
			BadRequestException,
		);
		expect(await rejects(save({ html: "x".repeat(900) }))).toBeInstanceOf(
			BadRequestException,
		);
		expect(
			await rejects(save({ html: `<html>${"a".repeat(8_000_100)}</html>` })),
		).toBeInstanceOf(PayloadTooLargeException);
		untouched();
	});
	test("a stale base hash is a 409 and nothing changes", async () => {
		expect(
			await rejects(save({ baseSha256: sha256Of("old page") })),
		).toBeInstanceOf(ConflictException);
		untouched();
	});
	test("the editor bridge never reaches the file", async () => {
		const withBridge = EDITED.replace(
			"<head>",
			`<head><script ${BRIDGE_MARKER}>x()</script>`,
		);
		await save({ html: withBridge });
		expect(readFileSync(index(), "utf8")).toBe(EDITED);
	});
});

describe("a save", () => {
	test("writes the file, keeps a backup outside the demo folder, and returns not-live", async () => {
		const out = await save();
		expect(readFileSync(index(), "utf8")).toBe(EDITED);
		expect(out.live).toBe(false);
		expect(out.replay).toBe(false);
		expect(out.sha256).toBe(sha256Of(EDITED));
		expect(
			readFileSync(join(dirs.backupDir, "acme-demo", out.backupName), "utf8"),
		).toBe(PAGE);
		expect(readdirSync(join(dirs.outputDir, "acme-demo")).sort()).toEqual([
			"assets",
			"index.html",
		]);
	});

	test("the audit row exists BEFORE the file changes, with who, slug, sizes, hashes and backup name", async () => {
		const out = await save();
		expect(atCreate).toEqual([
			{ fileSha: sha256Of(PAGE), backupExists: false },
		]);
		const row = audit[0] as Row;
		expect(row).toMatchObject({
			actorId: "user-1",
			actorEmail: "danio@wifielite.com",
			slug: "acme-demo",
			bytesBefore: Buffer.byteLength(PAGE),
			sha256Before: sha256Of(PAGE),
			bytesAfter: Buffer.byteLength(EDITED),
			sha256After: sha256Of(EDITED),
			backupName: out.backupName,
			status: "APPLIED",
		});
	});

	test("the same request id twice writes once and returns the first result", async () => {
		const first = await save();
		const second = await save({ baseSha256: sha256Of(EDITED) });
		expect(second.replay).toBe(true);
		expect(second.sha256).toBe(first.sha256);
		expect(audit.length).toBe(1);
		expect(readdirSync(join(dirs.backupDir, "acme-demo")).length).toBe(1);
	});

	test("another user cannot replay someone else's request id", async () => {
		await save();
		process.env.LEADGEN_DECISION_APPROVERS =
			"danio@wifielite.com,someone@example.com";
		expect(await rejects(save({ actor: OTHER }))).toBeInstanceOf(
			ConflictException,
		);
	});

	test("a second save from the page after the first needs the new hash", async () => {
		await save();
		expect(await rejects(save({ requestId: REQ(2) }))).toBeInstanceOf(
			ConflictException,
		);
		now = new Date(now.getTime() + 1000);
		const again = await save({
			requestId: REQ(2),
			baseSha256: sha256Of(EDITED),
			html: EDITED.replace("Plumbing", "Plumbing Co"),
		});
		expect(again.replay).toBe(false);
	});

	test("two saves at once: one wins, the other is told to wait", async () => {
		const { service } = makeService();
		const run = (n: number) =>
			service.save({
				leadId: "lead-1",
				requestId: REQ(n),
				html: EDITED,
				baseSha256: sha256Of(PAGE),
				actor: DANIO,
			});
		const results = await Promise.allSettled([run(1), run(2)]);
		expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
		const failed = results.find(
			(r) => r.status === "rejected",
		) as PromiseRejectedResult;
		expect(failed.reason).toBeInstanceOf(ConflictException);
		expect(readFileSync(index(), "utf8")).toBe(EDITED);
	});

	test("a write that fails leaves the file unchanged and the audit row FAILED", async () => {
		writeFileSync(join(root, "blocker"), "a file, not a folder");
		dirs = { ...dirs, backupDir: join(root, "blocker", "backups") };
		expect(await rejects(save())).toBeInstanceOf(InternalServerErrorException);
		expect(readFileSync(index(), "utf8")).toBe(PAGE);
		expect((audit[0] as Row).status).toBe("FAILED");
		expect(atCreate.length).toBe(1);
	});

	test("a request id whose earlier attempt failed is not silently retried", async () => {
		writeFileSync(join(root, "blocker"), "x");
		const good = dirs;
		dirs = { ...dirs, backupDir: join(root, "blocker", "backups") };
		await rejects(save());
		dirs = good;
		expect(await rejects(save())).toBeInstanceOf(ConflictException);
		expect(readFileSync(index(), "utf8")).toBe(PAGE);
	});
});

describe("info", () => {
	test("reports the local file, who may edit, and the last edit", async () => {
		const { service } = makeService();
		const before = await service.info("lead-1", DANIO.email);
		expect(before).toMatchObject({
			hasLocal: true,
			slug: "acme-demo",
			sha256: sha256Of(PAGE),
			canEdit: true,
			lastEdit: null,
			keepBackups: 10,
		});
		expect(before.deployHint).toContain("deploy-demo.sh acme-demo");
		await service.save({
			leadId: "lead-1",
			requestId: REQ(1),
			html: EDITED,
			baseSha256: sha256Of(PAGE),
			actor: DANIO,
		});
		const after = await service.info("lead-1", DANIO.email);
		expect(after.sha256).toBe(sha256Of(EDITED));
		expect(after.lastEdit).toMatchObject({
			by: DANIO.email,
			status: "APPLIED",
		});
	});
	test("a non-approver sees the file but cannot edit, and is told why", async () => {
		const info = await makeService().service.info("lead-1", OTHER.email);
		expect(info.hasLocal).toBe(true);
		expect(info.canEdit).toBe(false);
		expect(info.editProblem).toContain("not an approved");
	});
	test("no build means hasLocal false with a reason, not an error", async () => {
		leadUrl = "https://nothing-here.ei-leadgen-demos.pages.dev";
		const info = await makeService().service.info("lead-1", DANIO.email);
		expect(info.hasLocal).toBe(false);
		expect(info.reason).toBeTruthy();
	});
});

describe("preview links and the file route", () => {
	const linkOf = async (edit: boolean, actor = DANIO) => {
		const { service, previews } = makeService();
		const link = await service.previewLink("lead-1", edit, actor);
		const suffix = link.path.replace("/api/leadgen/demo-preview/", "");
		return { link, previews, suffix };
	};

	test("an edit link needs an approver, a view link does not", async () => {
		const { service } = makeService();
		expect(
			await rejects(service.previewLink("lead-1", true, OTHER)),
		).toBeInstanceOf(ForbiddenException);
		expect((await service.previewLink("lead-1", false, OTHER)).mode).toBe(
			"view",
		);
	});

	test("the link expires after 15 minutes", async () => {
		const { link, previews, suffix } = await linkOf(false);
		expect(link.expiresAt).toBe(
			new Date(now.getTime() + 15 * 60_000).toISOString(),
		);
		expect((await previews.serve(suffix)).status).toBe(200);
		now = new Date(now.getTime() + 15 * 60_000 + 1);
		expect((await previews.serve(suffix)).status).toBe(404);
	});

	test("serves the page and its assets with the sandbox headers on every response", async () => {
		const { previews, suffix } = await linkOf(false);
		const page = await previews.serve(suffix);
		const asset = await previews.serve(
			suffix.replace("index.html", "assets/logo.png"),
		);
		const missing = await previews.serve(
			suffix.replace("index.html", "nope.png"),
		);
		for (const r of [page, asset, missing]) {
			expect(r.headers["Content-Security-Policy"]).toBe(
				"sandbox allow-scripts; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
			);
			expect(r.headers["X-Content-Type-Options"]).toBe("nosniff");
			expect(r.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
			expect(r.headers["Cache-Control"]).toBe("private, no-store");
			expect(r.headers["Content-Security-Policy"]).not.toContain(
				"allow-same-origin",
			);
		}
		expect(page.status).toBe(200);
		expect(page.headers["Content-Type"]).toContain("text/html");
		expect(String(page.body)).toBe(PAGE);
		expect(asset.headers["Content-Type"]).toBe("image/png");
		expect(String(asset.body)).toBe("png-bytes");
		expect(missing.status).toBe(404);
	});

	test("the bridge is injected only into edit links, and only into html", async () => {
		const edit = await linkOf(true);
		const view = await linkOf(false);
		expect(String((await edit.previews.serve(edit.suffix)).body)).toContain(
			BRIDGE_MARKER,
		);
		expect(String((await view.previews.serve(view.suffix)).body)).not.toContain(
			BRIDGE_MARKER,
		);
		const asset = await edit.previews.serve(
			edit.suffix.replace("index.html", "assets/logo.png"),
		);
		expect(String(asset.body)).toBe("png-bytes");
	});

	test("a link works for its own slug only", async () => {
		mkdirSync(join(dirs.outputDir, "other-demo"));
		writeFileSync(join(dirs.outputDir, "other-demo", "index.html"), PAGE);
		const { previews, suffix } = await linkOf(false);
		expect(
			(await previews.serve(suffix.replace("/acme-demo/", "/other-demo/")))
				.status,
		).toBe(404);
	});

	test("tokens from another key, altered tokens and junk are 404", async () => {
		const { previews, suffix } = await linkOf(false);
		const [token, ...rest] = suffix.split("/");
		for (const bad of [
			`${token}x/${rest.join("/")}`,
			`${(token ?? "").replace(/.$/, "A")}/${rest.join("/")}`,
			`bad/${rest.join("/")}`,
			"",
			"/",
			`${token}`,
		])
			expect((await previews.serve(bad)).status).toBe(404);
	});

	test("path tricks are 404 and never read outside the demo", async () => {
		const { previews, suffix } = await linkOf(false);
		const base = suffix.replace("index.html", "");
		for (const trick of [
			"../secret.txt",
			"%2e%2e/secret.txt",
			"..%2fsecret.txt",
			"%2e%2e%2fsecret.txt",
			"assets/../../secret.txt",
			"%00",
			"assets//logo.png",
			".hidden",
			"%zz",
		]) {
			const r = await previews.serve(`${base}${trick}`);
			expect({ trick, status: r.status }).toEqual({ trick, status: 404 });
			expect(String(r.body)).not.toContain("secret");
		}
	});

	test("a symlink inside the demo pointing at a secret is 404", async () => {
		const { previews, suffix } = await linkOf(false);
		symlinkSync(
			join(root, "secret.txt"),
			join(dirs.outputDir, "acme-demo", "assets", "leak.txt"),
		);
		const r = await previews.serve(
			suffix.replace("index.html", "assets/leak.txt"),
		);
		expect(r.status).toBe(404);
	});

	test("backup files and temp files are never served", async () => {
		const { previews, suffix } = await linkOf(false);
		writeFileSync(
			join(
				dirs.outputDir,
				"acme-demo",
				"index.2026-09-20T10-11-12-123Z.bak.html",
			),
			"old",
		);
		writeFileSync(join(dirs.outputDir, "acme-demo", ".index.abc.tmp"), "tmp");
		for (const name of [
			"index.2026-09-20T10-11-12-123Z.bak.html",
			".index.abc.tmp",
		])
			expect(
				(await previews.serve(suffix.replace("index.html", name))).status,
			).toBe(404);
	});
});
