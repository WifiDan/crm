import { describe, expect, it } from "bun:test";
import type { Evidence } from "../agent/lib/evidence";
import {
	blockWrites,
	citesFetchedHost,
	fetchedHosts,
	hostMatches,
	hostOf,
	recordFetchedSource,
	verifyEvidence,
	verifySource,
	writesBlocked,
} from "../agent/lib/sources";
import { inEveContext } from "./eve-context";

describe("hostOf", () => {
	it("normalises a URL to a comparable host", () => {
		expect(hostOf("https://www.Example.com/about?x=1")).toBe("example.com");
		expect(hostOf("example.com")).toBe("example.com");
		expect(hostOf("http://blog.example.com.")).toBe("blog.example.com");
	});

	it("refuses anything that is not a web address", () => {
		expect(hostOf("")).toBeNull();
		expect(hostOf("   ")).toBeNull();
		expect(hostOf("their website")).toBeNull();
		expect(hostOf("localhost")).toBeNull();
		expect(hostOf("file:///etc/passwd")).toBeNull();
	});
});

describe("hostMatches", () => {
	it("accepts the same site and its subdomains, since an extract crawls", () => {
		expect(hostMatches("example.com", "example.com")).toBe(true);
		expect(hostMatches("careers.example.com", "example.com")).toBe(true);
		expect(hostMatches("example.com", "careers.example.com")).toBe(true);
	});

	it("does not accept a different site that merely ends the same way", () => {
		expect(hostMatches("notexample.com", "example.com")).toBe(false);
		expect(hostMatches("linkedin.com", "example.com")).toBe(false);
	});

	it("checks a citation against everything actually fetched", () => {
		expect(citesFetchedHost("https://example.com/a", ["example.com"])).toBe(
			true,
		);
		expect(
			citesFetchedHost("https://linkedin.com/company/x", ["example.com"]),
		).toBe(false);
		expect(citesFetchedHost(null, ["example.com"])).toBe(false);
	});
});

const webClaim = (sourceUrl?: string): Evidence[] =>
	sourceUrl === undefined
		? [{ kind: "web.cited-claim", detail: "the site says so" }]
		: [{ kind: "web.cited-claim", detail: "the site says so", sourceUrl }];

describe("verifySource", () => {
	it("refuses every citation when the session has fetched nothing", async () => {
		await inEveContext(async () => {
			const verdict = verifySource("https://example.com");
			expect(verdict.ok).toBe(false);
			expect(fetchedHosts()).toEqual([]);
		});
	});

	it("accepts a page that was fetched, and the site it belongs to", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://www.example.com/");

			expect(fetchedHosts()).toEqual(["example.com"]);
			expect(verifySource("https://example.com/about").ok).toBe(true);
			expect(verifySource("https://careers.example.com/jobs").ok).toBe(true);
		});
	});

	it("refuses a plausible URL that was never opened, and says which were", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");

			const verdict = verifySource("https://www.linkedin.com/company/example");
			expect(verdict.ok).toBe(false);
			if (verdict.ok) return;
			expect(verdict.reason).toContain("linkedin.com");
			expect(verdict.reason).toContain("example.com");
		});
	});

	it("refuses a missing citation and a citation that is not a URL", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");

			expect(verifySource(undefined).ok).toBe(false);
			expect(verifySource("their about page").ok).toBe(false);
		});
	});

	it("refuses everything once the session is latched shut", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");
			blockWrites("HTTP 000", "https://example.com");

			expect(writesBlocked()).not.toBeNull();

			const verdict = verifySource("https://example.com/about");
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.reason).toContain("Source unavailable");
		});
	});

	it("fails closed with no session at all", () => {
		expect(verifySource("https://example.com").ok).toBe(false);
	});
});

describe("verifyEvidence", () => {
	it("lets our own mailbox stand on its own", async () => {
		await inEveContext(async () => {
			const verdict = verifyEvidence({
				evidence: [{ kind: "crm.thread-reply", detail: "they replied" }],
			});

			expect(verdict.ok).toBe(true);
		});
	});

	it("refuses a web claim citing a page nobody opened", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");

			const verdict = verifyEvidence({
				evidence: webClaim("https://www.linkedin.com/in/invented"),
			});

			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.reason).toContain("web.cited-claim");
		});
	});

	it("refuses a web claim with no citation at all", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");
			expect(verifyEvidence({ evidence: webClaim() }).ok).toBe(false);
		});
	});

	it("accepts a web claim on a page that was read", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");

			expect(
				verifyEvidence({ evidence: webClaim("https://example.com/team") }).ok,
			).toBe(true);
		});
	});

	it("refuses a fabricated top-level sourceUrl even beside good evidence", async () => {
		await inEveContext(async () => {
			recordFetchedSource("https://example.com");

			const verdict = verifyEvidence({
				evidence: [{ kind: "crm.thread-reply", detail: "they replied" }],
				sourceUrl: "https://www.linkedin.com/in/invented",
			});

			expect(verdict.ok).toBe(false);
		});
	});
});
