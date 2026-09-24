import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	escapeLike,
	excerpt,
	isPlaceholderNotes,
	parseQaNotes,
	poolKey,
	safeDemoUrl,
	safeHttpUrl,
	slugFromDemoUrl,
} from "../src/leadgen/lead-view";
import {
	NO_MARKET,
	reviewListInput,
	triageListInput,
} from "../src/leadgen/lead-views.contracts";
import {
	reviewOrder,
	reviewWhere,
	triageOrder,
	triageWhere,
	viewCondition,
} from "../src/leadgen/lead-views.sql";
import { MIRROR_TABLES } from "../src/leadgen/mirror-map";
import { resolveBuildDir } from "../src/leadgen/site-builds";

function oldSlugFromDemoUrl(u: string | null) {
	const old = (u || "").match(/demo-([a-z0-9-]+)\.pages\.dev/i);
	if (old) return old[1];
	const shared = (u || "").match(/([a-z0-9-]+)\.ei-leadgen-demos\.pages\.dev/i);
	return shared ? shared[1] : null;
}

const DEMO_URLS = [
	"https://demo-molina-baptist-church-demo.pages.dev",
	"https://cedaredge-community-methodis.ei-leadgen-demos.pages.dev",
	"https://kings-fitness-pitch.ei-leadgen-demos.pages.dev/",
	"HTTPS://DEMO-UPPER.PAGES.DEV",
	"file:///Volumes/Evo%20Drive/Claude/site-generator/output/black-hills-energy-demo/index.html",
	"https://example.com/demo",
	"",
	null,
];

describe("slugFromDemoUrl matches the old review-server function", () => {
	for (const url of DEMO_URLS) {
		test(`same slug for ${String(url).slice(0, 60)}`, () => {
			expect(slugFromDemoUrl(url)).toBe(oldSlugFromDemoUrl(url) ?? null);
		});
	}

	test("a file:// path has no slug, so the old page dropped it", () => {
		expect(slugFromDemoUrl(DEMO_URLS[4] ?? null)).toBeNull();
	});
});

describe("parseQaNotes", () => {
	test("no QA line is NONE", () => {
		expect(parseQaNotes("just notes")).toEqual({
			status: "NONE",
			failures: [],
		});
		expect(parseQaNotes(null)).toEqual({ status: "NONE", failures: [] });
	});

	test("a FAIL with a reason keeps the reason", () => {
		const notes =
			'QA: FAIL - broken link: "tel:" (tel: link with no phone number)';
		expect(parseQaNotes(notes)).toEqual({
			status: "FAIL",
			failures: ['broken link: "tel:" (tel: link with no phone number)'],
		});
	});

	test("the last QA line wins and a later PASS clears earlier failures", () => {
		const notes = "QA: FAIL - a\nother text\nQA: PASS\nREBUILD note\nQA: PASS";
		expect(parseQaNotes(notes)).toEqual({ status: "PASS", failures: [] });
	});

	test("a FAIL after a PASS is reported", () => {
		const notes = "QA: PASS\nQA: FAIL - late problem";
		expect(parseQaNotes(notes)).toEqual({
			status: "FAIL",
			failures: ["late problem"],
		});
	});

	test("two PASS lines in a row are both read as lines", () => {
		expect(
			parseQaNotes("QA: PASS\nQA: FAIL - x\nQA: FAIL - y").failures,
		).toEqual(["x", "y"]);
	});

	test("a FAIL without a reason is still a FAIL", () => {
		expect(parseQaNotes("QA: FAIL").failures).toEqual(["no reason recorded"]);
	});

	test("a long reason is cut", () => {
		const long = `QA: FAIL - ${"x".repeat(500)}`;
		expect(parseQaNotes(long).failures[0]?.length).toBe(200);
	});
});

describe("notes helpers", () => {
	test("placeholder marker", () => {
		expect(
			isPlaceholderNotes("[BUCKET: PLACEHOLDER - no real prior site]"),
		).toBe(true);
		expect(isPlaceholderNotes("plain")).toBe(false);
		expect(isPlaceholderNotes(null)).toBe(false);
	});

	test("excerpt cuts and flags", () => {
		expect(excerpt("abcdef", 3)).toEqual({ text: "abc", truncated: true });
		expect(excerpt("abc", 3)).toEqual({ text: "abc", truncated: false });
		expect(excerpt(null, 3)).toEqual({ text: "", truncated: false });
	});
});

describe("URL safety", () => {
	test("safeHttpUrl accepts http and https, adds https to a bare host", () => {
		expect(safeHttpUrl("http://old.example.com/x")).toBe(
			"http://old.example.com/x",
		);
		expect(safeHttpUrl("example.com")).toBe("https://example.com/");
	});

	test("safeHttpUrl rejects other schemes and blanks", () => {
		for (const bad of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,x",
			"file:///etc/passwd",
			"   ",
			"",
			null,
		]) {
			expect(safeHttpUrl(bad)).toBeNull();
		}
	});

	test("safeDemoUrl only allows https pages.dev hosts", () => {
		expect(safeDemoUrl("https://a-b.ei-leadgen-demos.pages.dev")).toBe(
			"https://a-b.ei-leadgen-demos.pages.dev/",
		);
		for (const bad of [
			"http://a.pages.dev",
			"https://pages.dev.evil.com",
			"https://evil.com/?x=.pages.dev",
			"javascript:alert(1)",
			"file:///x/index.html",
			null,
		]) {
			expect(safeDemoUrl(bad)).toBeNull();
		}
	});

	test("escapeLike escapes wildcards and the escape character", () => {
		expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
	});

	test("poolKey maps a NocoDB table id to its pool", () => {
		const isp = MIRROR_TABLES.find((t) => t.key === "isp");
		expect(poolKey(isp?.tableId ?? "", MIRROR_TABLES)).toBe("isp");
		expect(poolKey("nope", MIRROR_TABLES)).toBeNull();
		expect(poolKey(null, MIRROR_TABLES)).toBeNull();
	});
});

describe("resolveBuildDir", () => {
	const dirs = [
		"cedaredge-community-methodist-thrift-shop-demo",
		"alpha-demo",
		"alpha-demo-two",
	];

	test("exact directory wins", () => {
		expect(resolveBuildDir("alpha-demo", dirs)).toBe("alpha-demo");
	});

	test("a unique prefix resolves the 28-character truncated slug", () => {
		expect(resolveBuildDir("cedaredge-community-methodis", dirs)).toBe(
			"cedaredge-community-methodist-thrift-shop-demo",
		);
	});

	test("an ambiguous prefix stays unresolved", () => {
		expect(resolveBuildDir("alpha", dirs)).toBeNull();
	});

	test("a slug that could climb out of the directory is refused", () => {
		expect(resolveBuildDir("../etc", dirs)).toBeNull();
		expect(resolveBuildDir("a/b", dirs)).toBeNull();
	});
});

const HOSTILE = "'; DROP TABLE lg_lead; --";

describe("SQL builders bind every value", () => {
	const triageBase = triageListInput.parse({});
	const reviewBase = reviewListInput.parse({});

	test("search text is a bound value and never part of the SQL text", () => {
		const where = triageWhere({ ...triageBase, q: HOSTILE });
		expect(where.text).not.toContain("DROP TABLE");
		expect(where.values.some((v) => String(v).includes("DROP TABLE"))).toBe(
			true,
		);
	});

	test("campaign and market ids are bound", () => {
		const where = triageWhere({
			...triageBase,
			campaignId: HOSTILE,
			marketId: HOSTILE,
		});
		expect(where.text).not.toContain("DROP TABLE");
		expect(where.values.filter((v) => v === HOSTILE).length).toBe(2);
	});

	test("the no-market sentinel becomes IS NULL, not a bound id", () => {
		const where = triageWhere({ ...triageBase, marketId: NO_MARKET });
		expect(where.text).toContain('"marketId" IS NULL');
		expect(where.values).not.toContain(NO_MARKET);
	});

	test("the decision filter changes the SQL", () => {
		const undecided = triageWhere({ ...triageBase, decision: "undecided" });
		const all = triageWhere({ ...triageBase, decision: "all" });
		expect(undecided.text).toContain('"approvalDecision" IS NULL');
		expect(all.text).not.toContain('"approvalDecision"');
	});

	test("omitting a facet dimension removes only that filter", () => {
		const input = { ...triageBase, decision: "Approved" as const };
		expect(triageWhere(input).text).toContain('"approvalDecision" =');
		expect(triageWhere(input, "decision").text).not.toContain(
			'"approvalDecision"',
		);
	});

	test("every review view has its own condition", () => {
		const texts = (
			["pending", "approved", "rejected", "placeholder", "all"] as const
		).map((v) => viewCondition(v).text);
		expect(new Set(texts).size).toBe(5);
	});

	test("review where always requires a Pages demo URL", () => {
		expect(reviewWhere(reviewBase).text).toContain("~*");
		expect(
			reviewWhere(reviewBase, "view").values.length,
		).toBeGreaterThanOrEqual(2);
	});

	test("sort keys outside the whitelist fall back to the default order", () => {
		const fallbackTriage = triageOrder({ sort: "", dir: "asc" }).text;
		const fallbackReview = reviewOrder({ sort: "", dir: "asc" }).text;
		for (const sort of [
			"constructor",
			"toString",
			"__proto__",
			HOSTILE,
			"id; --",
		]) {
			expect(triageOrder({ sort, dir: "asc" }).text).toBe(fallbackTriage);
			expect(reviewOrder({ sort, dir: "asc" }).text).toBe(fallbackReview);
		}
	});

	test("known sort keys change the order and honour direction", () => {
		const asc = triageOrder({ sort: "businessName", dir: "asc" }).text;
		const desc = triageOrder({ sort: "businessName", dir: "desc" }).text;
		expect(asc).toContain("ASC");
		expect(desc).toContain("DESC");
		expect(asc).not.toBe(desc);
	});

	test("every order ends on the row id so pages never overlap", () => {
		for (const sort of ["", "score", "businessName", "updatedAt"]) {
			expect(triageOrder({ sort, dir: "desc" }).text.trim()).toEndWith(
				"l.id ASC",
			);
			expect(reviewOrder({ sort, dir: "desc" }).text.trim()).toEndWith(
				"l.id ASC",
			);
		}
	});
});

describe("list inputs", () => {
	test("defaults", () => {
		expect(triageListInput.parse({}).decision).toBe("undecided");
		expect(reviewListInput.parse({}).view).toBe("pending");
		expect(triageListInput.parse({}).pageSize).toBe(25);
	});

	test("page size above 100 and unknown enums are refused", () => {
		expect(triageListInput.safeParse({ pageSize: 101 }).success).toBe(false);
		expect(reviewListInput.safeParse({ view: "everything" }).success).toBe(
			false,
		);
		expect(triageListInput.safeParse({ table: "mail" }).success).toBe(false);
	});
});

describe("Slice 1 is read only", () => {
	const dir = join(import.meta.dir, "../src/leadgen");
	const strip = (s: string) =>
		s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	const files = [
		"lead-view.ts",
		"lead-views.sql.ts",
		"lead-views.rows.ts",
		"lead-views.service.ts",
		"site-builds.ts",
		"ops-health.ts",
		"ops.sql.ts",
		"ops.service.ts",
	];
	const WRITES = [
		/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
		/\$executeRaw/,
		/\$transaction/,
		/\bINSERT\s+INTO\b/i,
		/\bUPDATE\s+["a-z_]/i,
		/\bDELETE\s+FROM\b/i,
		/\bTRUNCATE\b/i,
		/writeFile|appendFile|unlink|rename|mkdir|rm\(/,
		/\bfetch\s*\(/,
	];

	for (const file of files) {
		test(`${file} contains no write, no network call`, () => {
			const code = strip(readFileSync(join(dir, file), "utf8"));
			expect({
				file,
				hits: WRITES.filter((re) => re.test(code)).map(String),
			}).toEqual({ file, hits: [] });
		});
	}

	test("the new router procedures are all queries", () => {
		const router = strip(readFileSync(join(dir, "leadgen.router.ts"), "utf8"));
		for (const name of [
			"campaigns",
			"triageList",
			"reviewList",
			"leadDetail",
			"opsOverview",
			"opsHealth",
			"opsCallList",
			"opsRecentSends",
		]) {
			expect(router).toMatch(
				new RegExp(`@Query\\(\\{[^}]*\\}\\)\\s*async ${name}\\(`, "s"),
			);
		}
	});

	test("the services register no job handler and no scheduler hook", () => {
		for (const file of ["lead-views.service.ts", "ops.service.ts"]) {
			const code = strip(readFileSync(join(dir, file), "utf8"));
			expect(
				/LgJobHandler|LG_JOB_HANDLERS|LgJobSchedulerService/.test(code),
			).toBe(false);
		}
	});
});
