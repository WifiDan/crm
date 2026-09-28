import { describe, expect, test } from "bun:test";
import {
	parseSendLog,
	sendDedupeKey,
} from "../src/leadgen/sendlog-sync.handler";

const legacy =
	'{"id": 1, "name": "A", "email": "a@b.co", "subject": "s", "sent_at": "2026-07-19T14:30:03.706739+00:00"}';
const modern =
	'{"id": 2, "name": "B", "email": "b@b.co", "subject": "s", "tier": "follow-up-1", "sent_at": "2026-09-08T14:30:03+00:00", "message_id": "<x@y>"}';

describe("send log parsing", () => {
	test("accepts legacy (no tier / no message_id) and modern lines", () => {
		const { lines, bad } = parseSendLog(`${legacy}\n${modern}\n`);
		expect(bad).toBe(0);
		expect(lines).toHaveLength(2);
	});

	test("counts garbage and unknown tiers as bad instead of skipping silently", () => {
		const { lines, bad } = parseSendLog(
			`${legacy}\nnot json\n{"id": 3, "name": "C", "email": "c@b.co", "subject": "s", "sent_at": "x", "tier": "weird"}\n`,
		);
		expect(lines).toHaveLength(1);
		expect(bad).toBe(2);
	});

	test("blank lines are ignored", () => {
		expect(parseSendLog(`\n${legacy}\n\n`).bad).toBe(0);
	});
});

describe("dedupe key", () => {
	test("uses the Message-ID when present", () => {
		const [line] = parseSendLog(modern).lines;
		expect(line && sendDedupeKey(line)).toBe("<x@y>");
	});

	test("falls back to lead+tier+timestamp for legacy lines", () => {
		const [line] = parseSendLog(legacy).lines;
		expect(line && sendDedupeKey(line)).toBe(
			"legacy:1:initial:2026-07-19T14:30:03.706739+00:00",
		);
	});
});
