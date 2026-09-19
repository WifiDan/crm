import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan hard rule (section 5.2): there is no code path from a reply draft to SMTP except an
 * authenticated UI action by Danio. Until that UI action exists, NOTHING in the leadgen module
 * may reference a mail-sending API. This test is the enforcement, not a comment.
 */
const DIR = join(import.meta.dir, "../src/leadgen");
const FORBIDDEN = [
	/nodemailer/i,
	/createTransport/i,
	/sendmail/i,
	/smtp[-_.]?client/i,
	/\bsmtp\.[a-z0-9.-]+\.[a-z]{2,}/i,
	/messages\.send/i,
	/mailbox-api\.client/i,
	/\.sendMessage\(/i,
];

describe("leadgen module cannot send mail", () => {
	const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

	test("the module has files to check", () => {
		expect(files.length).toBeGreaterThan(8);
	});

	for (const file of files) {
		test(`${file} has no mail-sending reference`, () => {
			const src = readFileSync(join(DIR, file), "utf8");
			// strip comments so documenting the rule does not trip it
			const code = src
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			for (const re of FORBIDDEN) {
				expect({ file, pattern: String(re), hit: re.test(code) }).toEqual({
					file,
					pattern: String(re),
					hit: false,
				});
			}
		});
	}
});
