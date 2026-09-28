import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@crm/db";
import {
	BadRequestException,
	HttpException,
	NotFoundException,
} from "@nestjs/common";
import type {
	HopRequest,
	Resolver,
	Transport,
} from "../src/leadgen/outbound-guard";
import { scoreSite } from "../src/leadgen/site-audit";
import {
	type AuditEnv,
	SiteAuditService,
} from "../src/leadgen/site-audit.service";

const PUBLIC = "93.184.216.34";
const resolver: Resolver = async (host) => {
	const table: Record<string, string[]> = {
		"site.example.com": [PUBLIC],
		"redirector.example.com": [PUBLIC],
		"rebind.example.com": ["10.1.2.3"],
	};
	const found = table[host];
	if (!found) throw new Error("ENOTFOUND");
	return found.map((address) => ({ address, family: 4 }));
};

const dbWith = (websiteUrl: string | null, found = true) =>
	({
		lgLead: { findFirst: async () => (found ? { websiteUrl } : null) },
	}) as unknown as Db;

const stub = (
	answer: (
		hop: HopRequest,
		n: number,
	) => Promise<{
		status: number;
		location?: string;
		body?: string;
	}>,
) => {
	const calls: HopRequest[] = [];
	const transport: Transport = async (hop) => {
		calls.push(hop);
		const a = await answer(hop, calls.length);
		return {
			status: a.status,
			headers: (a.location ? { location: a.location } : {}) as Record<
				string,
				string
			>,
			body: new TextEncoder().encode(a.body ?? ""),
			truncated: false,
		};
	};
	return { calls, deps: { resolve: resolver, transport } };
};

const HTML = "<html>jquery-1.7.2 <embed> Divi</html>";

describe("the audit endpoint takes a lead id and only fetches that lead's own website", () => {
	test("a public site is fetched at its own address and scored", async () => {
		const s = stub(async () => ({ status: 200, body: HTML }));
		const out = await new SiteAuditService(
			dbWith("https://site.example.com/"),
			s.deps,
		).run("lead-1");
		expect(out).toEqual(scoreSite(HTML, "https://site.example.com/"));
		expect(s.calls.map((c) => c.url.href)).toEqual([
			"https://site.example.com/",
		]);
	});

	test("a website stored without a scheme is audited over https", async () => {
		const s = stub(async () => ({ status: 200, body: HTML }));
		const out = await new SiteAuditService(
			dbWith("site.example.com"),
			s.deps,
		).run("lead-1");
		expect(out.url).toBe("https://site.example.com/");
	});

	const refusedTargets = [
		"http://127.0.0.1:3041/",
		"http://100.78.149.77:8768/",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost/",
		"http://rebind.example.com/",
		"http://joshua.tail261548.ts.net:8768/",
	];
	for (const site of refusedTargets) {
		test(`a lead whose website is ${site} is refused with the old error shape and nothing is fetched`, async () => {
			const s = stub(async () => ({ status: 200, body: HTML }));
			const out = await new SiteAuditService(dbWith(site), s.deps).run(
				"lead-1",
			);
			expect(out.priority).toBe("Error");
			expect(out.score).toBe(0);
			expect(out.signals[0]).toStartWith("Could not audit: refused:");
			expect(out.url).toBe(site);
			expect(s.calls.length).toBe(0);
		});
	}

	test("a public site that redirects to loopback is refused after exactly one request", async () => {
		const s = stub(async () => ({
			status: 302,
			location: "http://127.0.0.1:3041/",
		}));
		const out = await new SiteAuditService(
			dbWith("https://redirector.example.com/"),
			s.deps,
		).run("lead-1");
		expect(out.priority).toBe("Error");
		expect(out.signals[0]).toContain("refused");
		expect(s.calls.length).toBe(1);
	});

	test("a fetch failure keeps the old error shape", async () => {
		const s = stub(async () => {
			throw new Error("timed out");
		});
		const out = await new SiteAuditService(
			dbWith("https://site.example.com/"),
			s.deps,
		).run("lead-1");
		expect(out).toEqual({
			score: 0,
			priority: "Error",
			signals: ["Could not audit: timed out"],
			url: "https://site.example.com/",
		});
	});

	test("an unknown lead is 404, and a lead with no usable website is the old 'bad url'", async () => {
		const s = stub(async () => ({ status: 200 }));
		const svc = (db: Db) => new SiteAuditService(db, s.deps);
		await expect(svc(dbWith(null, false)).run("x")).rejects.toBeInstanceOf(
			NotFoundException,
		);
		for (const bad of [
			null,
			"",
			"  ",
			"ftp://site.example.com/",
			"javascript:alert(1)",
		]) {
			const err = await svc(dbWith(bad))
				.run("x")
				.catch((e) => e);
			expect(err).toBeInstanceOf(BadRequestException);
			expect((err as Error).message).toBe("bad url");
		}
		expect(s.calls.length).toBe(0);
	});

	test("at most three audits run at once", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const s = stub(async () => {
			await gate;
			return { status: 200, body: HTML };
		});
		const svc = new SiteAuditService(
			dbWith("https://site.example.com/"),
			s.deps,
		);
		const running = [svc.run("a"), svc.run("b"), svc.run("c")];
		await new Promise((r) => setTimeout(r, 20));
		const err = await svc.run("d").catch((e) => e);
		expect(err).toBeInstanceOf(HttpException);
		expect((err as HttpException).getStatus()).toBe(429);
		release();
		await Promise.all(running);
		expect((await svc.run("e")).priority).not.toBe("Error");
	});
});

describe("the audit cache: same lead + URL is served without a fetch until it goes stale", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "audit-svc-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function service(website: string, opts: Partial<AuditEnv> = {}) {
		const s = stub(async () => ({ status: 200, body: HTML }));
		let clock = new Date();
		const env: AuditEnv = { cacheDir: root, now: () => clock, ...opts };
		return {
			svc: new SiteAuditService(dbWith(website), s.deps, env),
			calls: s.calls,
			advance: (ms: number) => {
				clock = new Date(clock.getTime() + ms);
			},
		};
	}

	test("without a cache env, nothing is written and every call fetches (old behaviour)", async () => {
		const s = stub(async () => ({ status: 200, body: HTML }));
		const svc = new SiteAuditService(
			dbWith("https://site.example.com/"),
			s.deps,
		);
		await svc.run("clead000001");
		await svc.run("clead000001");
		expect(s.calls.length).toBe(2);
		expect(await svc.cached("clead000001")).toBeNull();
	});

	test("a second run for the same lead is served from cache and never fetches again", async () => {
		const s = service("https://site.example.com/");
		const first = await s.svc.run("clead000001");
		expect(s.calls.length).toBe(1);
		const second = await s.svc.run("clead000001");
		expect(second).toEqual(first);
		expect(s.calls.length).toBe(1);
		expect(await s.svc.cached("clead000001")).toEqual(first);
	});

	test("force always re-fetches and refreshes the cache", async () => {
		const s = service("https://site.example.com/");
		await s.svc.run("clead000001");
		await s.svc.run("clead000001", { force: true });
		expect(s.calls.length).toBe(2);
	});

	test("the cache goes stale after 14 days", async () => {
		const s = service("https://site.example.com/");
		await s.svc.run("clead000001");
		s.advance(13 * 24 * 3600 * 1000);
		await s.svc.run("clead000001");
		expect(s.calls.length).toBe(1);
		s.advance(2 * 24 * 3600 * 1000);
		await s.svc.run("clead000001");
		expect(s.calls.length).toBe(2);
	});

	test("a failed fetch is never cached, so the next call tries again", async () => {
		let fail = true;
		const failCalls: HopRequest[] = [];
		const transport: Transport = async (hop) => {
			failCalls.push(hop);
			if (fail) throw new Error("timed out");
			return {
				status: 200,
				headers: {},
				body: new TextEncoder().encode(HTML),
				truncated: false,
			};
		};
		const clock = new Date();
		const svc = new SiteAuditService(
			dbWith("https://site.example.com/"),
			{ resolve: resolver, transport },
			{ cacheDir: root, now: () => clock },
		);
		const first = await svc.run("clead000001");
		expect(first.priority).toBe("Error");
		expect(await svc.cached("clead000001")).toBeNull();
		fail = false;
		const second = await svc.run("clead000001");
		expect(second.priority).not.toBe("Error");
		expect(failCalls.length).toBe(2);
	});

	test("cached() checks the lead's own website, and returns null for a lead with no cache yet", async () => {
		const s = service("https://site.example.com/");
		expect(await s.svc.cached("clead000001")).toBeNull();
		await s.svc.run("clead000001");
		expect(await s.svc.cached("clead000001")).not.toBeNull();
		expect(await s.svc.cached("clead000002")).toBeNull();
	});
});
