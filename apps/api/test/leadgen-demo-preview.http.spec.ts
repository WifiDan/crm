import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ExpressAdapter,
	type NestExpressApplication,
} from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import helmet from "helmet";
import {
	LG_DEMO_CLOCK,
	LG_DEMO_DIRS,
	LG_PREVIEW_KEY,
} from "../src/leadgen/demo-edit.config";
import { DemoPreviewController } from "../src/leadgen/demo-preview.controller";
import { DemoPreviewService } from "../src/leadgen/demo-preview.service";

const PAGE = `<!doctype html><html><head><title>Http</title></head><body>${"<p>x</p>".repeat(80)}</body></html>`;

let app: NestExpressApplication;
let base = "";
let root = "";
let viewPath = "";
let editPath = "";

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "preview-http-"));
	const outputDir = join(root, "output");
	mkdirSync(join(outputDir, "acme-demo", "assets"), { recursive: true });
	writeFileSync(join(outputDir, "acme-demo", "index.html"), PAGE);
	writeFileSync(
		join(outputDir, "acme-demo", "assets", "logo.png"),
		Buffer.from([137, 80, 78, 71, 0, 255, 128]),
	);
	const moduleRef = await Test.createTestingModule({
		controllers: [DemoPreviewController],
		providers: [
			DemoPreviewService,
			{ provide: LG_PREVIEW_KEY, useValue: Buffer.alloc(32, 5) },
			{
				provide: LG_DEMO_DIRS,
				useValue: { outputDir, backupDir: join(root, "b") },
			},
			{ provide: LG_DEMO_CLOCK, useValue: () => new Date() },
		],
	}).compile();
	app = moduleRef.createNestApplication<NestExpressApplication>(
		new ExpressAdapter(),
	);
	app.use(helmet());
	await app.init();
	await app.listen(0, "127.0.0.1");
	base = await app.getUrl();
	const previews = moduleRef.get(DemoPreviewService);
	viewPath = previews.mint("acme-demo", "view").path;
	editPath = previews.mint("acme-demo", "edit").path;
});

afterAll(async () => {
	await app.close();
	rmSync(root, { recursive: true, force: true });
});

describe("the preview route through a real Nest + Express app with helmet in front", () => {
	test("serves the page, and the route headers win over helmet's defaults", async () => {
		const res = await fetch(`${base}${viewPath}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(PAGE);
		expect(res.headers.get("content-security-policy")).toBe(
			"sandbox allow-scripts; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(res.headers.get("cross-origin-resource-policy")).toBe(
			"cross-origin",
		);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	test("serves binary assets byte for byte with their type", async () => {
		const res = await fetch(
			`${base}${viewPath.replace("index.html", "assets/logo.png")}`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
			137, 80, 78, 71, 0, 255, 128,
		]);
	});

	test("an edit link injects the bridge, a view link does not", async () => {
		expect(await (await fetch(`${base}${editPath}`)).text()).toContain(
			"data-leadgen-bridge",
		);
		expect(await (await fetch(`${base}${viewPath}`)).text()).not.toContain(
			"data-leadgen-bridge",
		);
	});

	test("needs no cookie or session: the token is the credential", async () => {
		const res = await fetch(`${base}${viewPath}`, { headers: {} });
		expect(res.status).toBe(200);
	});

	test("bad tokens and path tricks are 404 with the sandbox headers still on", async () => {
		const token = viewPath.split("/")[4] as string;
		for (const path of [
			"/api/leadgen/demo-preview/nope/acme-demo/index.html",
			`/api/leadgen/demo-preview/${token}/other-demo/index.html`,
			`/api/leadgen/demo-preview/${token}/acme-demo/..%2f..%2fsecret`,
			`/api/leadgen/demo-preview/${token}/acme-demo/%2e%2e/%2e%2e/etc/passwd`,
			`/api/leadgen/demo-preview/${token}/acme-demo/assets/%00`,
			"/api/leadgen/demo-preview/",
			"/api/leadgen/demo-preview",
		]) {
			const res = await fetch(`${base}${path}`);
			expect({ path, status: res.status }).toEqual({ path, status: 404 });
			if (path.includes(token))
				expect(res.headers.get("content-security-policy")).toContain("sandbox");
		}
	});

	test("HEAD works and query strings are ignored", async () => {
		const head = await fetch(`${base}${viewPath}?x=1`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-security-policy")).toContain("sandbox");
	});

	test("only GET is routed: a POST is not served", async () => {
		const res = await fetch(`${base}${viewPath}`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});
