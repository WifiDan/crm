import { z } from "zod";

export type UnitStatus = {
	name: string;
	kind: "service" | "timer";
	description: string;
	activeState: string;
	subState: string;
	result: string;
	exitStatus: number | null;
	lastExitAt: string | null;
	lastTriggerAt: string | null;
	nextRunAt: string | null;
};

export function parseUnixStamp(value: string | undefined): string | null {
	const match = /^@(\d+)$/.exec((value ?? "").trim());
	if (!match) return null;
	const seconds = Number(match[1]);
	return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

export function parseUnitNames(listOutput: string): string[] {
	const names = new Set<string>();
	for (const line of listOutput.split("\n")) {
		const first = line.trim().split(/\s+/)[0] ?? "";
		if (/^[\w@:.\\-]+\.(service|timer)$/.test(first)) names.add(first);
	}
	return [...names].sort();
}

function parseBlock(block: string): Record<string, string> {
	const record: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) record[line.slice(0, at)] = line.slice(at + 1);
	}
	return record;
}

function toUnit(record: Record<string, string>): UnitStatus | null {
	const name = record.Id ?? "";
	if (!name) return null;
	const exit = Number(record.ExecMainStatus);
	return {
		name,
		kind: name.endsWith(".timer") ? "timer" : "service",
		description: record.Description ?? "",
		activeState: record.ActiveState ?? "unknown",
		subState: record.SubState ?? "unknown",
		result: record.Result ?? "unknown",
		exitStatus:
			record.ExecMainStatus !== undefined && Number.isFinite(exit)
				? exit
				: null,
		lastExitAt: parseUnixStamp(record.ExecMainExitTimestamp),
		lastTriggerAt: parseUnixStamp(record.LastTriggerUSec),
		nextRunAt: parseUnixStamp(record.NextElapseUSecRealtime),
	};
}

export function parseSystemctlShow(output: string): UnitStatus[] {
	return output
		.split(/\n\s*\n/)
		.map(parseBlock)
		.flatMap((record) => {
			const unit = toUnit(record);
			return unit ? [unit] : [];
		});
}

const healthEntry = z.object({
	ok: z.boolean(),
	detail: z.string().default(""),
	since: z.number().optional(),
});

export type HealthCheck = {
	name: string;
	ok: boolean;
	detail: string;
	since: string | null;
};

export function parseHealthState(raw: string): HealthCheck[] {
	const parsed = z.record(z.string(), healthEntry).parse(JSON.parse(raw));
	return Object.entries(parsed)
		.map(([name, entry]) => ({
			name,
			ok: entry.ok,
			detail: entry.detail,
			since:
				entry.since === undefined
					? null
					: new Date(entry.since * 1000).toISOString(),
		}))
		.sort(
			(a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name),
		);
}

const standingFile = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			since: z.string().nullish(),
		}),
	),
});

export type StandingItem = { id: string; text: string; since: string | null };

export function parseStandingTasks(raw: string): StandingItem[] {
	return standingFile
		.parse(JSON.parse(raw))
		.items.map((i) => ({ id: i.id, text: i.text, since: i.since ?? null }));
}

export function countCompanyMap(raw: string): number {
	return Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(raw)))
		.length;
}

export function countQueueLines(raw: string): number {
	return raw.split("\n").filter((line) => line.trim() !== "").length;
}
