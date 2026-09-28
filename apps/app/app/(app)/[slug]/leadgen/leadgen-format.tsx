"use client";

import { Badge } from "@crm/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc/client";

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

export function MirrorFreshness({ writes = false }: { writes?: boolean }) {
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
	const explain = writes
		? "Lists read a copy of NocoDB that refreshes every 15 minutes. What you save here goes to NocoDB at once; the list catches up on the next refresh."
		: "Numbers come from a copy of NocoDB that refreshes every 15 minutes. Read-only.";
	return (
		<div
			className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"
			title={`${explain} Last refresh: ${when(lastRunAt)}.`}
		>
			<span
				aria-hidden
				className={`inline-block size-1.5 rounded-full ${stale || mismatched ? "bg-red-500" : "bg-emerald-500"}`}
			/>
			<span>
				{age === null ? "Not synced yet" : `Synced ${age} min ago`} from NocoDB
			</span>
			{stale ? <Badge variant="destructive">stale</Badge> : null}
			{mismatched ? (
				<Badge variant="destructive">row count mismatch</Badge>
			) : null}
		</div>
	);
}
