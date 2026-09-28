import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression: outreach.shadow was seeded and its class provided, but never added to the list the
 * scheduler resolves handlers from, so the first real run failed with "no handler registered".
 * Unit and live tests build handlers by hand and cannot see that, so this reads the wiring itself.
 */
const DIR = join(import.meta.dir, "../src/leadgen");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const handlerFiles = readdirSync(DIR).filter((f) => f.endsWith(".handler.ts"));
const moduleSrc = read("leadgen.module.ts");
const seedSrc = read("leadgen.seed.ts");

const injectList = /inject:\s*\[([\s\S]*?)\]/.exec(moduleSrc)?.[1] ?? "";
const factoryBody =
	/useFactory:\s*\([\s\S]*?\)\s*=>\s*\[([\s\S]*?)\]/.exec(moduleSrc)?.[1] ?? "";

const jobHandlers = handlerFiles.flatMap((f) => {
	const src = read(f);
	const cls = /export class (\w+) implements LgJobHandler/.exec(src)?.[1];
	const name = /readonly name = "([^"]+)"/.exec(src)?.[1];
	return cls && name ? [{ file: f, cls, name }] : [];
});

describe("every job handler is registered with the scheduler", () => {
	test("the wiring was found and there are handlers to check", () => {
		expect(injectList.length).toBeGreaterThan(0);
		expect(factoryBody.length).toBeGreaterThan(0);
		expect(jobHandlers.length).toBeGreaterThanOrEqual(6);
	});

	for (const h of jobHandlers) {
		test(`${h.cls} (${h.name}) is provided, injected and returned by the handler factory`, () => {
			expect(moduleSrc).toMatch(new RegExp(`\\b${h.cls},`));
			expect(injectList).toContain(h.cls);
			// the factory returns parameters by their local names, so count entries instead
			const returned = factoryBody.split(",").filter((x) => x.trim()).length;
			const injected = injectList.split(",").filter((x) => x.trim()).length;
			expect(returned).toBe(injected);
		});
	}

	test("the factory returns exactly as many handlers as there are handler classes", () => {
		const returned = factoryBody.split(",").filter((x) => x.trim()).length;
		expect(returned).toBe(jobHandlers.length);
	});

	test("every seeded job name has a handler class", () => {
		const seeded = [
			...seedSrc.matchAll(/name:\s*"([a-z]+\.[a-z.]+)"/g),
		].flatMap((m) => (m[1] ? [m[1]] : []));
		const known = new Set(jobHandlers.map((h) => h.name));
		expect(seeded.length).toBeGreaterThanOrEqual(6);
		for (const name of seeded)
			expect({ name, known: known.has(name) }).toEqual({ name, known: true });
	});
});
