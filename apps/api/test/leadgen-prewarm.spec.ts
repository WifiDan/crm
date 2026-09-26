import { describe, expect, test } from "bun:test";
import { LeadgenPrewarmService } from "../src/leadgen/prewarm.service";
import type { LeadgenShotService } from "../src/leadgen/shot.service";
import type { SiteAuditService } from "../src/leadgen/site-audit.service";

type ShotStub = {
	status: (id: string) => Promise<{
		available: boolean;
		cached: boolean;
		stale: boolean;
	}>;
	capture: (id: string, force: boolean) => Promise<unknown>;
};

function fakes(overrides: {
	shot?: Partial<ShotStub>;
	captureDelayMs?: number;
	auditCached?: (id: string) => Promise<unknown>;
	auditRun?: (id: string) => Promise<unknown>;
}) {
	const captureCalls: string[] = [];
	let concurrent = 0;
	let maxConcurrent = 0;
	const capture = async (id: string, _force: boolean) => {
		concurrent += 1;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		captureCalls.push(id);
		if (overrides.captureDelayMs)
			await new Promise((r) => setTimeout(r, overrides.captureDelayMs));
		concurrent -= 1;
		return { fromCache: false };
	};
	const shots = {
		status: async (_id: string) => ({
			available: true,
			cached: false,
			stale: false,
		}),
		capture,
		...overrides.shot,
	} as unknown as LeadgenShotService;
	const audits = {
		cached: overrides.auditCached ?? (async () => null),
		run: overrides.auditRun ?? (async () => ({ priority: "Low" })),
	} as unknown as SiteAuditService;
	return {
		svc: new LeadgenPrewarmService(shots, audits),
		captureCalls,
		maxConcurrentCaptures: () => maxConcurrent,
	};
}

describe("LeadgenPrewarmService", () => {
	test("captures a screenshot when none is cached, and runs the audit when none is cached", async () => {
		const auditRunCalls: string[] = [];
		const f = fakes({
			auditCached: async () => null,
			auditRun: async (id: string) => {
				auditRunCalls.push(id);
				return { priority: "Low" };
			},
		});
		const out = await f.svc.prepare("lead-1");
		expect(out).toEqual({ shot: true, audit: true });
		expect(f.captureCalls).toEqual(["lead-1"]);
		expect(auditRunCalls).toEqual(["lead-1"]);
	});

	test("does nothing when both are already cached and fresh", async () => {
		const f = fakes({
			shot: {
				status: async () => ({ available: true, cached: true, stale: false }),
			},
			auditCached: async () => ({ priority: "Low" }),
		});
		const out = await f.svc.prepare("lead-1");
		expect(out).toEqual({ shot: true, audit: true });
		expect(f.captureCalls).toEqual([]);
	});

	test("re-captures a stale screenshot", async () => {
		const f = fakes({
			shot: {
				status: async () => ({ available: true, cached: true, stale: true }),
			},
		});
		await f.svc.prepare("lead-1");
		expect(f.captureCalls).toEqual(["lead-1"]);
	});

	test("screenshots for concurrent prepare() calls never overlap (RAM guard)", async () => {
		const f = fakes({ captureDelayMs: 15 });
		await Promise.all([
			f.svc.prepare("a"),
			f.svc.prepare("b"),
			f.svc.prepare("c"),
		]);
		expect(f.maxConcurrentCaptures()).toBe(1);
		expect(f.captureCalls.sort()).toEqual(["a", "b", "c"]);
	});

	test("a lead with no available browser is skipped, not thrown", async () => {
		const f = fakes({
			shot: {
				status: async () => ({
					available: false,
					cached: false,
					stale: false,
				}),
			},
		});
		const out = await f.svc.prepare("lead-1");
		expect(out.shot).toBe(false);
		expect(f.captureCalls).toEqual([]);
	});

	test("a capture failure is caught, logged, and does not stop later prepare() calls", async () => {
		let calls = 0;
		const shots = {
			status: async () => ({ available: true, cached: false, stale: false }),
			capture: async () => {
				calls += 1;
				if (calls === 1) throw new Error("browser sandbox could not start");
				return { fromCache: false };
			},
		} as unknown as LeadgenShotService;
		const audits = {
			cached: async () => ({ priority: "Low" }),
			run: async () => ({ priority: "Low" }),
		} as unknown as SiteAuditService;
		const svc = new LeadgenPrewarmService(shots, audits);
		const first = await svc.prepare("lead-1");
		expect(first.shot).toBe(false);
		const second = await svc.prepare("lead-2");
		expect(second.shot).toBe(true);
		expect(calls).toBe(2);
	});

	test("an audit failure is caught and logged, and the shot side still completes", async () => {
		const f = fakes({
			auditCached: async () => null,
			auditRun: async () => {
				throw new Error("timed out");
			},
		});
		const out = await f.svc.prepare("lead-1");
		expect(out.audit).toBe(false);
		expect(out.shot).toBe(true);
	});
});
