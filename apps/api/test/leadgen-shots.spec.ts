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
import type { Db } from "@crm/db";
import {
	BadGatewayException,
	BadRequestException,
	HttpException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { Resolver } from "../src/leadgen/outbound-guard";
import { LeadgenShotService, type ShotEnv } from "../src/leadgen/shot.service";
import {
	allowRequest,
	type CdpConnection,
	type CdpMessage,
	captureScreenshot,
	findBrowser,
	type Launcher,
	ShotError,
	verifyChain,
} from "../src/leadgen/shot-browser";
import {
	readShot,
	SHOT_NAME,
	shotName,
	writeShot,
} from "../src/leadgen/shot-cache";

const PNG = Buffer.alloc(4000, 1);
const PUBLIC = "93.184.216.34";
const LEAD = "clead123456";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shots-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cache", () => {
	test("names carry the lead id and a URL hash, and only that shape is accepted", () => {
		const a = shotName(LEAD, "https://a.example/");
		const b = shotName(LEAD, "https://b.example/");
		expect(a).not.toBe(b);
		expect(SHOT_NAME.test(a)).toBe(true);
		expect(() => shotName("../etc", "https://a.example/")).toThrow();
		expect(() => shotName("a/b", "https://a.example/")).toThrow();
		for (const bad of [
			"../x.png",
			"a.b.png",
			`${LEAD}.zzzzzzzzzz.png`,
			"x/../y.png",
		])
			expect(SHOT_NAME.test(bad)).toBe(false);
	});

	test("write then read; ttl decides fresh", async () => {
		const name = shotName(LEAD, "https://a.example/");
		await writeShot(root, name, PNG);
		const now = new Date();
		expect((await readShot(root, name, now))?.fresh).toBe(true);
		const later = new Date(now.getTime() + 15 * 24 * 3600 * 1000);
		expect((await readShot(root, name, later))?.fresh).toBe(false);
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "secret.png"), PNG);
		expect(await readShot(join(root, "sub"), "../secret.png", now)).toBeNull();
		expect(
			await readShot(root, shotName("other123456", "https://a.example/"), now),
		).toBeNull();
	});

	test("a new URL for the same lead replaces the old picture", async () => {
		const old = shotName(LEAD, "https://old.example/");
		const next = shotName(LEAD, "https://new.example/");
		await writeShot(root, old, PNG);
		const removed = await writeShot(root, next, PNG);
		expect(removed).toEqual([old]);
		expect(readdirSync(root)).toEqual([next]);
	});

	test("the cache is bounded by file count and by bytes, oldest first, never the new file", async () => {
		const names = ["aaaaaa1", "bbbbbb2", "cccccc3", "dddddd4"].map((id) =>
			shotName(id.padEnd(8, "0"), "https://a.example/"),
		);
		for (const [i, n] of names.entries()) {
			await writeShot(root, n, PNG, { maxFiles: 99, maxBytes: 1e9 });
			const t = new Date(Date.now() - (10 - i) * 1000);
			utimesSync(join(root, n), t, t);
		}
		const fifth = shotName("eeeeee50", "https://a.example/");
		const removed = await writeShot(root, fifth, PNG, {
			maxFiles: 3,
			maxBytes: 1e9,
		});
		expect(removed.sort()).toEqual(
			[names[0] as string, names[1] as string].sort(),
		);
		expect(readdirSync(root).sort()).toEqual(
			[names[2] as string, names[3] as string, fifth].sort(),
		);
		const bigger = shotName("ffffff60", "https://a.example/");
		const removed2 = await writeShot(root, bigger, PNG, {
			maxFiles: 99,
			maxBytes: 5000,
		});
		expect(removed2.length).toBe(3);
		expect(readdirSync(root)).toEqual([bigger]);
		expect(readdirSync(root).includes(bigger)).toBe(true);
	});

	test("non-cache files in the folder are never touched", async () => {
		writeFileSync(join(root, "keep.txt"), "x");
		await writeShot(root, shotName(LEAD, "https://a.example/"), PNG, {
			maxFiles: 0,
			maxBytes: 0,
		});
		expect(existsSync(join(root, "keep.txt"))).toBe(true);
	});
});

describe("locating the browser", () => {
	test("finds the binary under the version folder and lists the library folders", () => {
		const bin = join(
			root,
			"chrome-headless-shell",
			"linux-1.0",
			"chrome-headless-shell-linux64",
		);
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "chrome-headless-shell"), "");
		mkdirSync(join(root, "libs", "usr", "lib", "x86_64-linux-gnu", "gbm"), {
			recursive: true,
		});
		const found = findBrowser("/nowhere", root);
		expect(found?.binary).toBe(join(bin, "chrome-headless-shell"));
		expect(found?.libDirs.length).toBe(2);
	});
	test("a stray file next to the version folders does not hide the install (the old .metadata bug)", () => {
		const bin = join(root, "chrome-headless-shell", "linux-1.0", "inner");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "chrome-headless-shell"), "");
		writeFileSync(join(root, "chrome-headless-shell", ".metadata"), "{}");
		expect(findBrowser("/nowhere", root)).not.toBeNull();
	});
	test("no install is null, not an error", () => {
		expect(findBrowser("/nowhere", join(root, "empty"))).toBeNull();
	});
});

describe("verification of where the browser went", () => {
	const hop = (url: string, ip: string | null) => ({
		url,
		status: 200,
		remoteIp: ip,
	});
	test("a public chain passes", () => {
		expect(
			verifyChain([
				hop("https://a.example/", PUBLIC),
				hop("https://b.example/", "[2606:4700:4700::1111]"),
			]).url,
		).toBe("https://b.example/");
	});
	for (const [name, chain] of [
		["loopback answer", [hop("https://a.example/", "127.0.0.1")]],
		["tailnet answer", [hop("https://a.example/", "100.78.149.77")]],
		["metadata answer", [hop("https://a.example/", "169.254.169.254")]],
		[
			"private hop in the middle",
			[
				hop("https://a.example/", PUBLIC),
				hop("https://b.example/", "10.0.0.5"),
				hop("https://c.example/", PUBLIC),
			],
		],
		["v6 ULA answer", [hop("https://a.example/", "[fd7a:115c:a1e0::1]")]],
		["no address reported", [hop("https://a.example/", null)]],
		["internal host name", [hop("http://printer.local/", PUBLIC)]],
		["literal loopback url", [hop("http://127.0.0.1:3041/", PUBLIC)]],
	] as const) {
		test(`discards a shot after a ${name}`, () => {
			expect(() => verifyChain([...chain])).toThrow(ShotError);
			try {
				verifyChain([...chain]);
			} catch (e) {
				expect((e as ShotError).kind).toBe("refused");
			}
		});
	}
	test("an empty chain is a failure, not a pass", () => {
		expect(() => verifyChain([])).toThrow("never answered");
	});
	test("request filter: public http(s) and inline schemes only", () => {
		for (const ok of [
			"https://a.example/x.png",
			"http://a.example/",
			"data:image/png;base64,AA",
			"about:blank",
			"blob:https://a.example/1",
		])
			expect(allowRequest(ok)).toBe(true);
		for (const bad of [
			"http://127.0.0.1/",
			"http://localhost:3041/",
			"http://100.78.149.77:8768/",
			"http://169.254.169.254/",
			"file:///etc/passwd",
			"ftp://a.example/",
			"chrome://gpu",
			"http://[::1]/",
			"http://joshua.tail261548.ts.net/",
			"nonsense",
		])
			expect(allowRequest(bad)).toBe(false);
	});
});

type Script = {
	docs?: Array<{
		url: string;
		ip: string | null;
		status?: number;
		frame?: string;
	}>;
	redirects?: Array<{ url: string; ip: string | null; frame?: string }>;
	requests?: string[];
	navError?: string;
	tiny?: boolean;
};

function fakeBrowser(script: Script) {
	const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	let closed = false;
	let stops = 0;
	const makeCdp = (): CdpConnection => {
		let listener: (m: CdpMessage) => void = () => {};
		const emit = (method: string, params: Record<string, unknown>) =>
			listener({ method, params, sessionId: "s1" });
		return {
			onEvent: (fn) => {
				listener = fn;
			},
			close: () => {
				closed = true;
			},
			send: async (method, params) => {
				sent.push({ method, params });
				if (method === "Target.createTarget") return { targetId: "t1" };
				if (method === "Target.attachToTarget") return { sessionId: "s1" };
				if (method === "Page.navigate") {
					for (const [i, u] of (script.requests ?? []).entries())
						emit("Fetch.requestPaused", {
							requestId: `r${i}`,
							request: { url: u },
						});
					for (const r of script.redirects ?? [])
						emit("Network.requestWillBeSent", {
							type: "Document",
							frameId: r.frame ?? "f1",
							redirectResponse: {
								url: r.url,
								status: 302,
								remoteIPAddress: r.ip,
							},
						});
					for (const d of script.docs ?? [])
						emit("Network.responseReceived", {
							type: "Document",
							frameId: d.frame ?? "f1",
							response: {
								url: d.url,
								status: d.status ?? 200,
								remoteIPAddress: d.ip,
							},
						});
					emit("Page.loadEventFired", {});
					return script.navError
						? { frameId: "f1", errorText: script.navError }
						: { frameId: "f1" };
				}
				if (method === "Page.captureScreenshot")
					return {
						data: (script.tiny ? Buffer.alloc(10) : PNG).toString("base64"),
					};
				return {};
			},
		};
	};
	return {
		sent,
		wasClosed: () => closed,
		stops: () => stops,
		deps: {
			launch: (async () => ({
				wsUrl: "ws://fake",
				stop: async () => {
					stops++;
				},
			})) as Launcher,
			connect: async () => makeCdp(),
			sleep: async () => {},
		},
	};
}

const install = { binary: "/x/chrome-headless-shell", libDirs: [] };
const captured = (b: ReturnType<typeof fakeBrowser>) =>
	b.sent.some((m) => m.method === "Page.captureScreenshot");

describe("driving the browser", () => {
	test("a normal page returns the picture, the final URL and the status", async () => {
		const b = fakeBrowser({
			docs: [{ url: "https://a.example/", ip: PUBLIC, status: 200 }],
		});
		const out = await captureScreenshot(install, "https://a.example/", b.deps);
		expect(out.png.length).toBe(4000);
		expect(out.finalUrl).toBe("https://a.example/");
		expect(out.httpStatus).toBe(200);
		expect(b.wasClosed()).toBe(true);
		expect(b.stops()).toBe(1);
	});

	test("it asks the browser for a 1280 by 900 viewport and installs the request filter before navigating", async () => {
		const b = fakeBrowser({
			docs: [{ url: "https://a.example/", ip: PUBLIC }],
		});
		await captureScreenshot(install, "https://a.example/", b.deps);
		const order = b.sent.map((m) => m.method);
		expect(order.indexOf("Fetch.enable")).toBeLessThan(
			order.indexOf("Page.navigate"),
		);
		const metrics = b.sent.find(
			(m) => m.method === "Emulation.setDeviceMetricsOverride",
		);
		expect(metrics?.params).toMatchObject({ width: 1280, height: 900 });
	});

	for (const [name, script] of [
		[
			"a page that lands on loopback",
			{ docs: [{ url: "https://a.example/", ip: "127.0.0.1" }] },
		],
		[
			"a page that redirected through a private address",
			{
				redirects: [{ url: "https://a.example/", ip: "10.9.9.9" }],
				docs: [{ url: "https://b.example/", ip: PUBLIC }],
			},
		],
		[
			"a page whose frame answered from the tailnet",
			{
				docs: [
					{ url: "https://a.example/", ip: PUBLIC },
					{ url: "https://b.example/", ip: "100.78.149.77", frame: "f2" },
				],
			},
		],
		[
			"a page that reports no address",
			{ docs: [{ url: "https://a.example/", ip: null }] },
		],
	] as Array<[string, Script]>) {
		test(`discards the picture for ${name}, and never takes it`, async () => {
			const b = fakeBrowser(script);
			const err = await captureScreenshot(
				install,
				"https://a.example/",
				b.deps,
			).catch((e) => e);
			expect(err).toBeInstanceOf(ShotError);
			expect((err as ShotError).kind).toBe("refused");
			expect(captured(b)).toBe(false);
			expect(b.stops()).toBe(1);
		});
	}

	test("a navigation error is a failure and never a picture of the browser's error page", async () => {
		const b = fakeBrowser({ navError: "net::ERR_NAME_NOT_RESOLVED" });
		const err = await captureScreenshot(
			install,
			"https://nowhere.invalid/",
			b.deps,
		).catch((e) => e);
		expect(err).toBeInstanceOf(ShotError);
		expect((err as ShotError).message).toContain("ERR_NAME_NOT_RESOLVED");
		expect(captured(b)).toBe(false);
	});

	test("a picture that is too small to be a page is a failure", async () => {
		const b = fakeBrowser({
			docs: [{ url: "https://a.example/", ip: PUBLIC }],
			tiny: true,
		});
		const err = await captureScreenshot(
			install,
			"https://a.example/",
			b.deps,
		).catch((e) => e);
		expect((err as ShotError).message).toContain("no image");
	});

	test("a page that never answered is a failure", async () => {
		const b = fakeBrowser({});
		const err = await captureScreenshot(
			install,
			"https://a.example/",
			b.deps,
		).catch((e) => e);
		expect((err as ShotError).message).toContain("never answered");
		expect(captured(b)).toBe(false);
	});

	test("sub-requests to private targets are failed by the browser, public ones continue", async () => {
		const b = fakeBrowser({
			docs: [{ url: "https://a.example/", ip: PUBLIC }],
			requests: [
				"https://a.example/app.js",
				"http://127.0.0.1:3041/api/trpc",
				"http://100.78.149.77:8768/",
			],
		});
		const out = await captureScreenshot(install, "https://a.example/", b.deps);
		const verbs = b.sent.filter(
			(m) => m.method.startsWith("Fetch.") && m.method !== "Fetch.enable",
		);
		expect(verbs.map((v) => v.method)).toEqual([
			"Fetch.continueRequest",
			"Fetch.failRequest",
			"Fetch.failRequest",
		]);
		expect(out.blockedRequests).toBe(2);
	});
});

const noDb = (websiteUrl: string | null) =>
	({ lgLead: { findFirst: async () => ({ websiteUrl }) } }) as unknown as Db;

const resolver: Resolver = async (host) => {
	const table: Record<string, string> = {
		"a.example.com": PUBLIC,
		"rebind.example.com": "10.0.0.9",
	};
	const ip = table[host];
	if (!ip) throw new Error("ENOTFOUND");
	return [{ address: ip, family: 4 }];
};

function service(
	website: string | null,
	opts: Partial<ShotEnv> & { withBrowser?: boolean; script?: Script } = {},
) {
	const browserDir = join(root, "browser");
	if (opts.withBrowser !== false) {
		const bin = join(browserDir, "chrome-headless-shell", "linux-1", "x");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "chrome-headless-shell"), "");
	}
	const fake = fakeBrowser(
		opts.script ?? { docs: [{ url: "https://a.example.com/", ip: PUBLIC }] },
	);
	let launches = 0;
	let clock = new Date();
	const env: ShotEnv = {
		cacheDir: join(root, "cache"),
		browserDir,
		resolve: resolver,
		capture: {
			...fake.deps,
			launch: async (i) => {
				launches++;
				return fake.deps.launch(i);
			},
		},
		now: () => clock,
		...opts,
	};
	return {
		svc: new LeadgenShotService(noDb(website), env),
		launches: () => launches,
		advance: (ms: number) => {
			clock = new Date(clock.getTime() + ms);
		},
		fake,
	};
}

describe("the screenshot service", () => {
	test("captures once, caches, and serves the cache after that", async () => {
		const s = service("https://a.example.com/");
		const first = await s.svc.capture(LEAD, false);
		expect(first.fromCache).toBe(false);
		const second = await s.svc.capture(LEAD, false);
		expect(second.fromCache).toBe(true);
		expect(s.launches()).toBe(1);
		expect((await s.svc.image(LEAD))?.png.length).toBe(4000);
	});

	test("a forced re-capture inside a minute is served from cache; after that it captures", async () => {
		const s = service("https://a.example.com/");
		await s.svc.capture(LEAD, false);
		expect((await s.svc.capture(LEAD, true)).fromCache).toBe(true);
		s.advance(61_000);
		expect((await s.svc.capture(LEAD, true)).fromCache).toBe(false);
		expect(s.launches()).toBe(2);
	});

	test("the ttl is 14 days", async () => {
		const s = service("https://a.example.com/");
		await s.svc.capture(LEAD, false);
		s.advance(13 * 24 * 3600 * 1000);
		expect((await s.svc.capture(LEAD, false)).fromCache).toBe(true);
		s.advance(2 * 24 * 3600 * 1000);
		expect((await s.svc.capture(LEAD, false)).fromCache).toBe(false);
	});

	for (const site of [
		"http://127.0.0.1:3041/",
		"http://100.78.149.77:8768/",
		"http://169.254.169.254/",
		"http://localhost/",
		"http://rebind.example.com/",
	]) {
		test(`a lead whose website is ${site} is refused before any browser starts`, async () => {
			const s = service(site);
			const err = await s.svc.capture(LEAD, false).catch((e) => e);
			expect(err).toBeInstanceOf(BadRequestException);
			expect(s.launches()).toBe(0);
		});
	}

	test("a lead with no usable website is 'bad url'", async () => {
		const s = service("ftp://x");
		const err = await s.svc.capture(LEAD, false).catch((e) => e);
		expect(err).toBeInstanceOf(BadRequestException);
		expect((err as Error).message).toBe("bad url");
	});

	test("without a browser install the service says so and status reports it", async () => {
		const s = service("https://a.example.com/", { withBrowser: false });
		expect(await s.svc.capture(LEAD, false).catch((e) => e)).toBeInstanceOf(
			ServiceUnavailableException,
		);
		const st = await s.svc.status(LEAD);
		expect(st.available).toBe(false);
		expect(st.unavailableReason).toContain("not installed");
	});

	test("a failed capture with an earlier picture shows the earlier one and says so", async () => {
		const good = service("https://a.example.com/");
		await good.svc.capture(LEAD, false);
		good.advance(15 * 24 * 3600 * 1000);
		const bad = new LeadgenShotService(noDb("https://a.example.com/"), {
			...(good.svc as unknown as { env: ShotEnv }).env,
			capture: fakeBrowser({ navError: "net::ERR_CONNECTION_REFUSED" }).deps,
		});
		const out = await bad.capture(LEAD, false);
		expect(out.fromCache).toBe(true);
		expect(out.stale).toBe(true);
		expect(out.note).toContain("ERR_CONNECTION_REFUSED");
	});

	test("a failed capture with nothing cached is a 502; a refused one is a 400", async () => {
		const failed = service("https://a.example.com/", {
			script: { navError: "net::ERR_TIMED_OUT" },
		});
		expect(
			await failed.svc.capture(LEAD, false).catch((e) => e),
		).toBeInstanceOf(BadGatewayException);
		const refused = service("https://a.example.com/", {
			script: { docs: [{ url: "https://a.example.com/", ip: "127.0.0.1" }] },
		});
		expect(
			await refused.svc.capture(LEAD, false).catch((e) => e),
		).toBeInstanceOf(BadRequestException);
		expect(await refused.svc.image(LEAD)).toBeNull();
	});

	test("a picture that failed verification is never written to the cache", async () => {
		const s = service("https://a.example.com/", {
			script: { docs: [{ url: "https://a.example.com/", ip: "10.0.0.5" }] },
		});
		await s.svc.capture(LEAD, false).catch(() => {});
		expect(
			existsSync(join(root, "cache")) ? readdirSync(join(root, "cache")) : [],
		).toEqual([]);
	});

	test("two viewers of one lead start one browser", async () => {
		const s = service("https://a.example.com/");
		const [a, b] = await Promise.all([
			s.svc.capture(LEAD, false),
			s.svc.capture(LEAD, false),
		]);
		expect(s.launches()).toBe(1);
		expect(a.capturedAt).toBe(b.capturedAt);
	});

	test("at most three browsers at once", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const browserDir = join(root, "browser");
		const bin = join(browserDir, "chrome-headless-shell", "linux-1", "x");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "chrome-headless-shell"), "");
		const fake = fakeBrowser({
			docs: [{ url: "https://a.example.com/", ip: PUBLIC }],
		});
		const svc = new LeadgenShotService(noDb("https://a.example.com/"), {
			cacheDir: join(root, "cache"),
			browserDir,
			resolve: resolver,
			capture: {
				...fake.deps,
				launch: async (i) => {
					await gate;
					return fake.deps.launch(i);
				},
			},
		});
		const ids = ["lead0001x", "lead0002x", "lead0003x"];
		const running = ids.map((id) => svc.capture(id, false));
		await new Promise((r) => setTimeout(r, 20));
		const err = await svc.capture("lead0004x", false).catch((e) => e);
		expect(err).toBeInstanceOf(HttpException);
		expect((err as HttpException).getStatus()).toBe(429);
		release();
		await Promise.all(running);
	});
});
