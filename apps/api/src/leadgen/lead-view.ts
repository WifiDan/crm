import { LEAD_VIEWS } from "./lead-views.config";

const legacyPages = () => new RegExp(LEAD_VIEWS.pages.legacyPattern, "i");
const sharedPages = () => new RegExp(LEAD_VIEWS.pages.sharedPattern, "i");

export function slugFromDemoUrl(url: string | null | undefined): string | null {
	const text = url ?? "";
	const legacy = legacyPages().exec(text);
	if (legacy) return legacy[1] ?? null;
	return sharedPages().exec(text)?.[1] ?? null;
}

export type QaStatus = "PASS" | "FAIL" | "NONE";

export type QaResult = { status: QaStatus; failures: string[] };

const QA_LINE = /^[ \t]*QA:[ \t]*(PASS|FAIL)\b[ \t-]*(.*)$/gim;

export function parseQaNotes(notes: string | null | undefined): QaResult {
	let status: QaStatus = "NONE";
	let failures: string[] = [];
	for (const match of (notes ?? "").matchAll(QA_LINE)) {
		if (match[1]?.toUpperCase() === "PASS") {
			status = "PASS";
			failures = [];
			continue;
		}
		status = "FAIL";
		const reason = (match[2] ?? "")
			.trim()
			.slice(0, LEAD_VIEWS.text.failureChars);
		failures.push(reason === "" ? "no reason recorded" : reason);
	}
	return { status, failures };
}

export function isPlaceholderNotes(notes: string | null | undefined): boolean {
	return (notes ?? "").includes(LEAD_VIEWS.placeholderMarker);
}

export function excerpt(text: string | null | undefined, max: number) {
	const value = text ?? "";
	return value.length > max
		? { text: value.slice(0, max), truncated: true }
		: { text: value, truncated: false };
}

function parseHttpUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url : null;
	} catch {
		return null;
	}
}

export function safeHttpUrl(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim();
	if (trimmed === "") return null;
	const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
	if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
	const url = parseHttpUrl(hasScheme ? trimmed : `https://${trimmed}`);
	return url ? url.href : null;
}

export function safeDemoUrl(value: string | null | undefined): string | null {
	const url = parseHttpUrl((value ?? "").trim());
	return url?.protocol === "https:" &&
		url.hostname.endsWith(LEAD_VIEWS.pages.host)
		? url.href
		: null;
}

export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function poolKey(
	tableId: string | null,
	tables: ReadonlyArray<{ key: "isp" | "gym"; tableId: string }>,
): "isp" | "gym" | null {
	return tables.find((t) => t.tableId === tableId)?.key ?? null;
}
