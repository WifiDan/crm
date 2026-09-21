import { describe, expect, test } from "bun:test";
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
import { SiteAuditService } from "../src/leadgen/site-audit.service";

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
