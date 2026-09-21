"use client";

import { Badge } from "@crm/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc/client";

export const OLD_DASHBOARD = {
	protocol: "http:",
	reviewPort: 8767,
	opsPort: 8768,
} as const;

export const MIRROR_STALE_MINUTES = 30;

export const SEARCH_DEBOUNCE_MS = 300;

export function useDebounced<T>(
	value: T,
	delayMs: number = SEARCH_DEBOUNCE_MS,
): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}

export function when(iso: string | null, empty = "never"): string {
	return iso ? new Date(iso).toLocaleString() : empty;
}

export function minutesSince(iso: string | null): number | null {
	return iso
		? Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
		: null;
}

export function poolLabel(table: string | null): string {
	if (table === "isp") return "ISP";
	if (table === "gym") return "Gym";
	return "Other";
}

export function useOldDashboard(port: number = OLD_DASHBOARD.reviewPort) {
	const [origin, setOrigin] = useState<string | null>(null);
	useEffect(() => {
		setOrigin(`${OLD_DASHBOARD.protocol}//${window.location.hostname}:${port}`);
	}, [port]);
	return {
		home: origin,
		triage: origin ? `${origin}/prospects` : null,
		preview: (url: string) =>
			origin ? `${origin}/old/?u=${encodeURIComponent(url)}` : null,
		screenshot: (url: string) =>
			origin ? `${origin}/api/shot?url=${encodeURIComponent(url)}` : null,
	};
}

export function MirrorFreshness() {
	const trpc = useTRPC();
	const mirror = useQuery({
		...trpc.leadgen.mirrorStatus.queryOptions(),
		refetchInterval: 60_000,
	});
	if (mirror.isError) {
		return (
			<p className="text-xs text-destructive">
				Mirror status unavailable: {mirror.error.message}
			</p>
		);
	}
	const lastRunAt = mirror.data?.lastRunAt ?? null;
	const age = minutesSince(lastRunAt);
	const stale = age === null || age > MIRROR_STALE_MINUTES;
	const mismatched = mirror.data?.tables.some((t) => t.inSync === false);
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
			<span className="font-medium">Data from the NocoDB mirror</span>
			<span className="text-muted-foreground">
				last run {when(lastRunAt)}
				{age === null ? "" : ` (${age} min ago)`}
			</span>
			{stale ? <Badge variant="destructive">stale</Badge> : null}
			{mismatched ? (
				<Badge variant="destructive">row count mismatch</Badge>
			) : null}
			<span className="text-muted-foreground">
				Changes made in NocoDB show here after the next mirror run, up to 15
				minutes. Read-only.
			</span>
		</div>
	);
}
