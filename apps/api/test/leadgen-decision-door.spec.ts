import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	decideInput,
	reworkInput,
} from "../src/leadgen/lead-decision.contracts";

const SRC = join(import.meta.dir, "../src");
const RULES = "lead-decision.rules.ts";
const STORE = "lead-decision.store.ts";
const SERVICE = "lead-decision.service.ts";
const ROUTER = "lead-decision.router.ts";
const MODULE = "leadgen.module.ts";
const MIRROR = "nocodb-mirror.handler.ts";

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
	path,
	name: relative(SRC, path),
	code: stripComments(readFileSync(path, "utf8")),
}));
const leadgen = files.filter((f) => f.name.startsWith("leadgen/"));
const names = (list: Array<{ name: string }>) => list.map((f) => f.name).sort();
const at = (file: string) => `leadgen/${file}`;

describe("the source scan is looking at real files", () => {
	test("it found the leadgen module and the decision files", () => {
		expect(leadgen.length).toBeGreaterThan(30);
		for (const f of [RULES, STORE, SERVICE, ROUTER, MODULE, MIRROR])
			expect(names(leadgen)).toContain(at(f));
	});
});

describe("only the store can write to NocoDB", () => {
	const NOCODB = /NOCODB_URL|NOCODB_LEADS|xc-token|\/api\/v2\/(tables|meta)\b/;
	const WRITE_VERB = /["'`](PATCH|POST|PUT|DELETE)["'`]/;

	test("the files that reach NocoDB at all are the mirror (reads) and the store", () => {
		const reaching = files.filter((f) => NOCODB.test(f.code));
		expect(names(reaching)).toEqual([at(MIRROR), at(STORE)].sort());
	});
	test("the mirror handler uses no write verb", () => {
		const mirror = files.find((f) => f.name === at(MIRROR));
		expect(WRITE_VERB.test(mirror?.code ?? "")).toBe(false);
	});
	test("the store really holds the PATCH (the allowlist cannot go stale)", () => {
		const store = files.find((f) => f.name === at(STORE));
		expect(/method:\s*"PATCH"/.test(store?.code ?? "")).toBe(true);
	});
	test("no other source file has a NocoDB write verb next to a fetch", () => {
		const offenders = files.filter(
			(f) =>
				f.name !== at(STORE) &&
				/\bfetch\(/.test(f.code) &&
				WRITE_VERB.test(f.code) &&
				NOCODB.test(f.code),
		);
		expect(names(offenders)).toEqual([]);
	});
});

describe("only the rules name the Send Approved write", () => {
	const READERS = [at("mirror-map.ts"), at("outreach-plan.ts")];
	test("files that mention the field are the rules, the service, and two readers", () => {
		const mentioning = files.filter((f) =>
			/Send Approved|SEND_APPROVED_FIELD/.test(f.code),
		);
		expect(names(mentioning)).toEqual(
			[...READERS, at(RULES), at(SERVICE)].sort(),
		);
	});
	test("no file outside the rules assigns the field", () => {
		const assigning = files.filter(
			(f) =>
				f.name !== at(RULES) &&
				(/\[\s*["']Send Approved["']\s*\]\s*=(?!=)/.test(f.code) ||
					/["']Send Approved["']\s*:\s*(true|false)\b/i.test(f.code) ||
					/\[\s*SEND_APPROVED_FIELD\s*\]\s*[:=]/.test(f.code)),
		);
		expect(names(assigning)).toEqual([]);
	});
	test("the sender readers only read it", () => {
		for (const f of READERS) {
			const code = files.find((x) => x.name === f)?.code ?? "";
			expect(/["']Send Approved["']\s*\]\s*=(?!=)/.test(code)).toBe(false);
		}
	});
	test("the rules assign it in three places only: the two patch builders and the in-memory eligibility probe", () => {
		const rules = files.find((f) => f.name === at(RULES))?.code ?? "";
		expect((rules.match(/SEND_APPROVED_FIELD\s*\]\s*[:=]/g) ?? []).length).toBe(
			3,
		);
	});
});

describe("only the mirror handler writes lg_lead", () => {
	const WRITES =
		/\blgLead\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\b|\bUPDATE\s+lg_lead\b|\bINSERT\s+INTO\s+lg_lead\b|\bDELETE\s+FROM\s+lg_lead\b/i;
	test("no other source file writes it", () => {
		const writers = files.filter((f) => WRITES.test(f.code));
		expect(names(writers)).toEqual([at(MIRROR)]);
	});
	test("the decision files never even name a write on it", () => {
		for (const f of [RULES, STORE, SERVICE, ROUTER]) {
			const code = files.find((x) => x.name === at(f))?.code ?? "";
			expect({ f, hit: WRITES.test(code) }).toEqual({ f, hit: false });
		}
	});
});

describe("nothing but the decision router can reach the service", () => {
	const importers = files.filter((f) => /lead-decision\.service/.test(f.code));
	test("only the router and the module wiring import it", () => {
		expect(names(importers)).toEqual([at(MODULE), at(ROUTER)].sort());
	});
	test("only the router calls decide and rework on it", () => {
		const callers = files.filter((f) => /\.(decide|rework)\s*\(/.test(f.code));
		expect(names(callers)).toEqual([at(ROUTER)]);
	});
	test("only the service and the module wiring import the store", () => {
		const users = files.filter((f) => /lead-decision\.store/.test(f.code));
		expect(names(users)).toEqual([at(MODULE), at(SERVICE)].sort());
	});
	test("no job handler or scheduler names the service, store or rules", () => {
		for (const f of leadgen.filter((n) => /handler|scheduler/.test(n.name))) {
			expect({
				f: f.name,
				refs: /LeadDecisionService|lead-decision\./.test(f.code),
			}).toEqual({ f: f.name, refs: false });
		}
	});
	test("the view services have no route to the decision code", () => {
		for (const f of leadgen.filter((n) => /lead-views|ops\./.test(n.name))) {
			expect(/lead-decision\./.test(f.code)).toBe(false);
		}
	});
});

describe("the decision router is a human-session door", () => {
	const router = files.find((f) => f.name === at(ROUTER))?.code ?? "";
	test("it applies AuthMiddleware and SessionOnlyMiddleware to the whole class", () => {
		expect(router).toMatch(
			/@UseMiddlewares\(\s*AuthMiddleware\s*,\s*SessionOnlyMiddleware\s*\)\s*export class/,
		);
	});
	test("it has no REST or OpenAPI exposure", () => {
		expect(/restMeta/.test(router)).toBe(false);
	});
	test("every procedure is behind the class middleware (no per-method override)", () => {
		expect((router.match(/@UseMiddlewares/g) ?? []).length).toBe(1);
	});
	test("no other router exposes a decision procedure", () => {
		const routers = files.filter(
			(f) => f.name.endsWith(".router.ts") && f.name !== at(ROUTER),
		);
		for (const r of routers)
			expect(/LeadDecisionService|lead-decision/.test(r.code)).toBe(false);
	});
});

describe("the inputs cannot carry what must come from the server", () => {
	const seen = { updatedAt: "x", decision: null, decisionDate: null };
	const base = {
		id: "lead-1",
		requestId: "00000000-0000-4000-8000-000000000001",
		seen,
	};
	test("no reviewer, no table, no list of leads", () => {
		for (const shape of [decideInput.shape, reworkInput.shape]) {
			const keys = Object.keys(shape);
			for (const banned of [
				"reviewedBy",
				"reviewer",
				"actor",
				"table",
				"tableId",
				"ids",
				"leads",
				"rows",
			])
				expect(keys).not.toContain(banned);
			expect(shape.id.safeParse(["a", "b"]).success).toBe(false);
		}
	});
	test("a bulk payload is refused", () => {
		expect(
			decideInput.safeParse({
				...base,
				id: ["a", "b"],
				stage: "review",
				decision: "Approved",
			}).success,
		).toBe(false);
	});
	test("stage and decision are closed sets", () => {
		expect(
			decideInput.safeParse({ ...base, stage: "review", decision: "Approved" })
				.success,
		).toBe(true);
		expect(
			decideInput.safeParse({ ...base, stage: "send", decision: "Approved" })
				.success,
		).toBe(false);
		expect(
			decideInput.safeParse({ ...base, stage: "review", decision: "Send" })
				.success,
		).toBe(false);
	});
	test("a version is required and confirmArm defaults to false", () => {
		expect(
			decideInput.safeParse({
				id: "x",
				requestId: base.requestId,
				stage: "review",
				decision: "Approved",
			}).success,
		).toBe(false);
		const parsed = decideInput.parse({
			...base,
			stage: "review",
			decision: "Approved",
		});
		expect(parsed.confirmArm).toBe(false);
	});
	test("the request id must be a uuid and rework notes are required", () => {
		expect(
			decideInput.safeParse({
				...base,
				requestId: "abc",
				stage: "review",
				decision: "Approved",
			}).success,
		).toBe(false);
		expect(reworkInput.safeParse({ ...base, notes: "   " }).success).toBe(
			false,
		);
		expect(reworkInput.safeParse({ ...base, notes: "fix" }).success).toBe(true);
	});
});
