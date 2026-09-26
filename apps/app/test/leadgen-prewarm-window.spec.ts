import { describe, expect, test } from "bun:test";
import {
	nextPrewarmIds,
	PREWARM_WINDOW,
} from "../app/(app)/[slug]/leadgen/prewarm";

const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("nextPrewarmIds", () => {
	test("takes the next windowSize ids after the current one, in order", () => {
		expect(nextPrewarmIds(ids, "b", 5)).toEqual(["c", "d", "e", "f", "g"]);
	});

	test("defaults to a window of 5", () => {
		expect(PREWARM_WINDOW).toBe(5);
		expect(nextPrewarmIds(ids, "a")).toEqual(["b", "c", "d", "e", "f"]);
	});

	test("stops at the end of the list instead of wrapping or padding", () => {
		expect(nextPrewarmIds(ids, "f", 5)).toEqual(["g", "h"]);
		expect(nextPrewarmIds(ids, "h", 5)).toEqual([]);
	});

	test("no current id, or one not in the list, warms nothing", () => {
		expect(nextPrewarmIds(ids, null)).toEqual([]);
		expect(nextPrewarmIds(ids, "nowhere")).toEqual([]);
	});

	test("a window of 0 warms nothing", () => {
		expect(nextPrewarmIds(ids, "a", 0)).toEqual([]);
	});
});
