import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { auditFailure, scoreSite } from "../src/leadgen/site-audit";

const OLD =
	process.env.LEADGEN_OLD_REVIEW_SERVER ??
	"/data/leadgen/approval-queue/review-server.js";

type Reply = { code: number; obj: unknown };

function loadOldAudit() {
	const src = readFileSync(OLD, "utf8");
	const from = src.indexOf(
		"if (req.method === 'GET' && urlPath === '/api/audit-site') {",
	);
	const to = src.indexOf(
		"if (req.method === 'GET' && urlPath.startsWith('/demo/'))",
	);
	if (from < 0 || to < 0 || to < from)
		throw new Error("could not locate the old audit handler");
	let pageHtml = "";
	let failWith: Error | null = null;
	let fetched: string[] = [];
	const sandbox: Record<string, unknown> = {
		fetch: async (url: string) => {
			fetched.push(url);
			if (failWith) throw failWith;
			return { text: async () => pageHtml };
		},
		AbortSignal,
		URL,
		Math,
		json: (_res: unknown, code: number, obj: unknown) => ({ code, obj }),
	};
	runInNewContext(
		`this.oldAudit = async function (req, res, urlPath) {\n${src.slice(from, to)}\n};`,
		sandbox,
	);
	const run = async (
		target: string | null,
		html: string,
		error: Error | null = null,
	): Promise<Reply & { fetched: string[] }> => {
		pageHtml = html;
		failWith = error;
		fetched = [];
		const qs = target === null ? "" : `?url=${encodeURIComponent(target)}`;
		const out = (await (
			sandbox.oldAudit as (a: unknown, b: unknown, c: string) => Promise<Reply>
		)({ method: "GET", url: `/api/audit-site${qs}` }, {}, "/api/audit-site")) as
			| Reply
			| undefined;
		return { ...(out as Reply), fetched };
	};
	return { run };
}

const haveOld = existsSync(OLD);

const FRAGMENTS = {
	jq: [
		"",
		"<script src='jquery-1.12.4.min.js'></script>",
		"<script src='jquery.2.2.4.js'></script>",
		"<script src='jquery-3.6.0.min.js'></script>",
		"<script src='jquery-1.7.2.js'></script><script src='jquery-3.1.1.js'>",
		"jquery-10.1.1",
		"jquery-1.4",
	],
	viewport: ["", "<meta name='viewport' content='width=device-width'>"],
	wp: [
		"",
		"wp-content",
		"Genesis",
		"wp-content Genesis",
		"Genesis wp-content",
		"Divi",
		"wp-content Divi",
		"DIVI theme",
	],
	plugins: [
		"",
		"jquery.slick.js",
		"jquery.nivo.slider",
		"JQUERY.PAROLLER",
		"jquery.superfish.min.js",
		"jquery-slick",
	],
	flash: [
		"",
		"<embed src='x.swf'>",
		"<object data=x>",
		"<applet code=y>",
		"<EMBED>",
		"< embed>",
	],
	copyright: [
		"",
		"&copy; 2012",
		"&copy;2015",
		"&copy;    2010 Foo",
		"2013 - 2020",
		"2014&nbsp;",
		"2011 &amp;",
		"&copy; 2016",
		"2016 -",
		"&copy; 2020",
		"© 2012",
		"2010-",
	],
};

const TARGETS = [
	"https://example.com/",
	"http://example.com/",
	"HTTPS://example.com/",
	"https://x.example.com/?a=1&b=2",
];

function grid(): Array<{ html: string; target: string }> {
	const out: Array<{ html: string; target: string }> = [];
	const keys = Object.keys(FRAGMENTS) as Array<keyof typeof FRAGMENTS>;
	let seed = 1234567;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed;
	};
	for (let i = 0; i < 1500; i++) {
		const html = keys
			.map((k) => {
				const list = FRAGMENTS[k];
				return list[next() % list.length];
			})
			.join("\n");
		out.push({ html, target: TARGETS[next() % TARGETS.length] as string });
	}
	for (const target of TARGETS) {
		for (let mask = 0; mask < 1 << 6; mask++) {
			const html = keys
				.map((k, i) => (mask & (1 << i) ? (FRAGMENTS[k][1] as string) : ""))
				.join("\n");
			out.push({ html, target });
		}
	}
	for (const wp of FRAGMENTS.wp)
		out.push({ html: wp, target: TARGETS[0] as string });
	out.push({ html: "", target: TARGETS[0] as string });
	return out;
}

describe("scoring port: pure behaviour", () => {
	test("a clean modern page scores 100 / Low", () => {
		expect(
			scoreSite("<meta name='viewport' content='x'>", "https://a.example"),
		).toEqual({
			score: 100,
			priority: "Low",
			signals: [],
			url: "https://a.example",
		});
	});

	test("every signal at once floors at zero and reports High", () => {
		const html =
			"jquery-1.2.3 wp-content Genesis jquery.slick <embed> &copy; 2011";
		const out = scoreSite(html, "http://a.example");
		expect(out.score).toBe(0);
		expect(out.priority).toBe("High");
		expect(out.signals.length).toBe(7);
	});

	test("priority thresholds sit at 70 and 40", () => {
		const view = "viewport";
		expect(scoreSite(`${view} <embed>`, "https://a").priority).toBe("Low");
		expect(scoreSite(`${view} <embed> Divi`, "https://a").score).toBe(60);
		expect(scoreSite(`${view} <embed> Divi`, "https://a").priority).toBe(
			"Medium",
		);
		expect(scoreSite("<embed>", "https://a").score).toBe(50);
		expect(scoreSite("<embed> Divi", "https://a").score).toBe(40);
		expect(scoreSite("<embed> Divi", "https://a").priority).toBe("Medium");
		expect(scoreSite("<embed> Divi jquery.slick", "https://a").score).toBe(25);
		expect(scoreSite("<embed> Divi jquery.slick", "https://a").priority).toBe(
			"High",
		);
	});

	test("the WordPress check keeps the old precedence: 'Divi' alone triggers it", () => {
		const only = (html: string) =>
			scoreSite(`viewport ${html}`, "https://a").signals;
		expect(only("Divi")).toEqual([
			"WordPress with legacy theme (Genesis/Divi)",
		]);
		expect(only("Genesis")).toEqual([]);
		expect(only("wp-content")).toEqual([]);
		expect(only("wp-content Genesis")).toEqual([
			"WordPress with legacy theme (Genesis/Divi)",
		]);
	});

	test("the failure shape is the old one", () => {
		expect(auditFailure("https://a", "timed out")).toEqual({
			score: 0,
			priority: "Error",
			signals: ["Could not audit: timed out"],
			url: "https://a",
		});
	});
});

describe.skipIf(!haveOld)("identical to the real old audit handler", () => {
	test("the harness runs the old code (it can fail): a known page gets the old answer", async () => {
		const old = loadOldAudit();
		const out = await old.run(
			"http://legacy.example.com/",
			"jquery-1.7.2 <embed> Divi",
		);
		expect(out.code).toBe(200);
		expect(out.obj).toEqual({
			score: 0,
			priority: "High",
			signals: [
				"jQuery 1.7.2 (2014-2016, 8-10 years old)",
				"No mobile viewport meta tag (not responsive)",
				"HTTP only (no HTTPS/SSL)",
				"WordPress with legacy theme (Genesis/Divi)",
				"Flash/Java elements (extremely outdated)",
			],
			url: "http://legacy.example.com/",
		});
		expect(out.fetched).toEqual(["http://legacy.example.com/"]);
	});

	test("old and new agree on every fixture", async () => {
		const old = loadOldAudit();
		const cases = grid();
		expect(cases.length).toBeGreaterThan(1500);
		const seen = new Set<string>();
		let disagreements = 0;
		for (const c of cases) {
			const before = await old.run(c.target, c.html);
			const after = scoreSite(c.html, c.target);
			seen.add(`${after.priority}:${after.signals.length}`);
			if (JSON.stringify(before.obj) !== JSON.stringify(after)) {
				disagreements++;
				expect(after).toEqual(before.obj as never);
			}
		}
		expect(disagreements).toBe(0);
		expect([...seen].some((s) => s.startsWith("High"))).toBe(true);
		expect([...seen].some((s) => s.startsWith("Medium"))).toBe(true);
		expect([...seen].some((s) => s.startsWith("Low"))).toBe(true);
	});

	test("the error shape matches when the fetch fails", async () => {
		const old = loadOldAudit();
		const before = await old.run(
			"https://down.example.com/",
			"",
			new Error("fetch failed"),
		);
		expect(before.code).toBe(200);
		expect(before.obj).toEqual(
			auditFailure("https://down.example.com/", "fetch failed"),
		);
	});

	test("the old code's bad-url answer is a 400 {error: 'bad url'} (the CRM refuses in the service instead)", async () => {
		const old = loadOldAudit();
		for (const bad of [null, "", "ftp://x", "example.com"]) {
			const out = await old.run(bad, "");
			expect({ bad, code: out.code, obj: out.obj }).toEqual({
				bad,
				code: 400,
				obj: { error: "bad url" },
			});
		}
	});
});
