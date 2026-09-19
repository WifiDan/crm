import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { replySendInput } from "../src/leadgen/reply-approval.contracts";

/**
 * Plan hard rule (section 5.2): there is no code path from a reply draft to SMTP except an
 * authenticated action by Danio.
 *
 * Phase 3c builds that one route, so the rule is now "exactly one send module, and nothing else".
 * This test is the enforcement, not a comment:
 *   1. only ALLOWED_SENDER may reference a mail-sending API;
 *   2. that allowlist entry must really be a sender (it cannot go stale and leave a hole);
 *   3. only the approval router and the module wiring may import it, and only the router may call it,
 *      so no job, handler, scheduler or other module can reach it;
 *   4. the router is session-only (API keys rejected) and has no REST/OpenAPI exposure;
 *   5. the send input cannot carry a caller-supplied reviewer.
 */
const SRC = join(import.meta.dir, "../src");
const DIR = join(SRC, "leadgen");
const ALLOWED_SENDER = "reply-send.service.ts";
const ROUTER = "reply-approval.router.ts";
const MODULE = "leadgen.module.ts";

const FORBIDDEN = [
	/nodemailer/i,
	/createTransport/i,
	/sendmail/i,
	/smtp[-_.]?client/i,
	/\bsmtp\.[a-z0-9.-]+\.[a-z]{2,}/i,
	/messages\.send/i,
	/mailbox-api\.client/i,
	/\.sendMessage\(/i,
	/\.sendMail\(/i,
	// reaching the CRM's own mailbox/conversation senders from the leadgen module is also a send path
	/from\s+["']\.\.\/(mailbox|conversations|zoho)\b/i,
];

const stripComments = (src: string) =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const leadgenFiles = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

function allTsFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "generated" ? [] : allTsFiles(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

const hits = (code: string) => FORBIDDEN.filter((re) => re.test(code));

describe("leadgen module: exactly one file can send mail", () => {
	test("the module has files to check", () => {
		expect(leadgenFiles.length).toBeGreaterThan(8);
	});

	for (const file of leadgenFiles.filter((f) => f !== ALLOWED_SENDER)) {
		test(`${file} has no mail-sending reference`, () => {
			const code = stripComments(readFileSync(join(DIR, file), "utf8"));
			expect({ file, patterns: hits(code).map(String) }).toEqual({
				file,
				patterns: [],
			});
		});
	}

	test("the allowlisted sender really is the sender (the allowlist cannot go stale)", () => {
		expect(leadgenFiles).toContain(ALLOWED_SENDER);
		const code = stripComments(readFileSync(join(DIR, ALLOWED_SENDER), "utf8"));
		expect(/createTransport/.test(code)).toBe(true);
	});

	test("exactly one leadgen file references a mail-sending API", () => {
		const withHits = leadgenFiles.filter(
			(f) => hits(stripComments(readFileSync(join(DIR, f), "utf8"))).length > 0,
		);
		expect(withHits).toEqual([ALLOWED_SENDER]);
	});
});

describe("nothing but the approval router can reach the sender", () => {
	const files = allTsFiles(SRC);
	const importers = files.filter((f) =>
		/reply-send\.service/.test(stripComments(readFileSync(f, "utf8"))),
	);

	test("only the router and the module wiring import the sender", () => {
		const names = importers.map((f) => relative(SRC, f)).sort();
		expect(names).toEqual([`leadgen/${MODULE}`, `leadgen/${ROUTER}`].sort());
	});

	test("only the router calls sendReply", () => {
		const callers = files
			.filter((f) =>
				/\bsendReply\s*\(/.test(stripComments(readFileSync(f, "utf8"))),
			)
			.map((f) => relative(SRC, f))
			.sort();
		expect(callers).toEqual(
			[`leadgen/${ROUTER}`, `leadgen/${ALLOWED_SENDER}`].sort(),
		);
	});

	test("no job handler imports or names the sender", () => {
		for (const f of leadgenFiles.filter((n) => /handler|scheduler/.test(n))) {
			const code = stripComments(readFileSync(join(DIR, f), "utf8"));
			expect({
				f,
				refs: /ReplySendService|reply-send\.service/.test(code),
			}).toEqual({
				f,
				refs: false,
			});
		}
	});
});

describe("the approval router is a human-session door", () => {
	const router = stripComments(readFileSync(join(DIR, ROUTER), "utf8"));

	test("it applies AuthMiddleware and SessionOnlyMiddleware to the whole class", () => {
		expect(router).toMatch(
			/@UseMiddlewares\(\s*AuthMiddleware\s*,\s*SessionOnlyMiddleware\s*\)\s*export class/,
		);
	});

	test("it has no REST/OpenAPI exposure", () => {
		expect(/restMeta/.test(router)).toBe(false);
	});

	test("the send input has no reviewer field and requires the recipient shown to the reviewer", () => {
		const keys = Object.keys(replySendInput.shape);
		expect(keys).not.toContain("reviewedBy");
		expect(keys).not.toContain("reviewer");
		expect(keys).toContain("expectedTo");
	});
});
