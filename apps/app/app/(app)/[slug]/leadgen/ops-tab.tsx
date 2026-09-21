"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { SectionTitle } from "./lead-parts";
import { MirrorFreshness, poolLabel, when } from "./leadgen-format";
import { OpsHealthPanel } from "./ops-health-panel";
import { CallList, RecentSends, ReworkList, StandingList } from "./ops-lists";

type Overview = RouterOutputs["leadgen"]["opsOverview"];
type Counts = Overview["totals"];

export type OpsTarget = "Review" | "Triage" | "Jobs" | "Alerts" | "Replies";

const CHART_DAYS = 30;

const TILES: Array<{
	key: keyof Counts;
	label: string;
	target?: OpsTarget;
}> = [
	{ key: "total", label: "Total leads" },
	{ key: "pendingTriage", label: "Pending triage", target: "Triage" },
	{ key: "sideBySideBuilt", label: "Demos built" },
	{ key: "awaitingReview", label: "Awaiting review", target: "Review" },
	{ key: "readyToSend", label: "Ready to send" },
	{ key: "sent", label: "Sent" },
	{ key: "replied", label: "Replied", target: "Replies" },
	{ key: "callText", label: "Call / text list" },
	{ key: "doNotContact", label: "Do not contact" },
];

function percent(part: number, whole: number): string {
	return whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;
}

export function OpsTab({
	onNavigate,
}: {
	onNavigate: (tab: OpsTarget) => void;
}) {
	const trpc = useTRPC();
	const overview = useQuery({
		...trpc.leadgen.opsOverview.queryOptions(),
		refetchInterval: 60_000,
	});
	if (overview.isPending) {
		return <p className="text-xs text-muted-foreground">Loading…</p>;
	}
	if (overview.isError) {
		return <p className="text-xs text-destructive">{overview.error.message}</p>;
	}
	const data = overview.data;
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<MirrorFreshness />
			<SystemStrip onNavigate={onNavigate} />
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
				{TILES.map((t) => (
					<Tile
						key={t.key}
						label={t.label}
						value={data.totals[t.key]}
						onOpen={
							t.target ? () => onNavigate(t.target as OpsTarget) : undefined
						}
					/>
				))}
				<Tile
					label="Reply rate"
					value={percent(data.totals.replied, data.totals.sent)}
					note="replied leads / sent leads"
				/>
			</div>
			<PoolTable pools={data.pools} />
			<div className="grid gap-4 lg:grid-cols-2">
				<Panel title={`Daily sends, last ${CHART_DAYS} days`}>
					<Series series={data.dailySends} />
				</Panel>
				<Panel title="Prospector yield per day (Google Places)">
					<Series series={data.prospectorYield} />
				</Panel>
				<Panel title="By source">
					<Bars counts={data.bySource} />
				</Panel>
				<Panel title="By decision">
					<Bars counts={data.byDecision} />
				</Panel>
			</div>
			<div className="grid gap-4 lg:grid-cols-2">
				<Panel title="Rework queue">
					<ReworkList rework={data.rework} />
				</Panel>
				<Panel title="Standing open items">
					<StandingList standing={data.standing} />
				</Panel>
			</div>
			<Panel title="Call / text list">
				<CallList />
			</Panel>
			<Panel title="Recent sends">
				<RecentSends />
			</Panel>
			<OpsHealthPanel />
			<p className="text-[11px] text-muted-foreground">
				Counts as of {when(data.generatedAt)}. Same rules as the old ops
				dashboard. Reply rate counts leads that replied, not reply messages.
			</p>
		</div>
	);
}

function SystemStrip({ onNavigate }: { onNavigate: (tab: OpsTarget) => void }) {
	const trpc = useTRPC();
	const jobs = useQuery({
		...trpc.leadgen.jobs.queryOptions(),
		refetchInterval: 30_000,
	});
	const alerts = useQuery({
		...trpc.leadgen.alerts.queryOptions(),
		refetchInterval: 30_000,
	});
	const failing = (jobs.data?.jobs ?? []).filter(
		(j) =>
			j.lastStatus !== null &&
			j.lastStatus !== "OK" &&
			j.lastStatus !== "RUNNING",
	);
	const pages = (alerts.data ?? []).filter((a) => a.tier === "PAGE").length;
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
			<span className="font-medium">CRM jobs</span>
			{jobs.data ? (
				<>
					<Badge
						variant={jobs.data.schedulerEnabled ? "secondary" : "destructive"}
					>
						scheduler {jobs.data.schedulerEnabled ? "on" : "off"}
					</Badge>
					<Badge variant={failing.length > 0 ? "destructive" : "secondary"}>
						{failing.length} failing of {jobs.data.jobs.length}
					</Badge>
				</>
			) : (
				<span className="text-muted-foreground">loading</span>
			)}
			<Badge variant={pages > 0 ? "destructive" : "outline"}>
				{alerts.data?.length ?? 0} open alerts
			</Badge>
			<span className="ml-auto flex gap-1">
				<Button size="sm" variant="outline" onClick={() => onNavigate("Jobs")}>
					Jobs
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => onNavigate("Alerts")}
				>
					Alerts
				</Button>
			</span>
		</div>
	);
}

function Tile({
	label,
	value,
	note,
	onOpen,
}: {
	label: string;
	value: number | string;
	note?: string;
	onOpen?: () => void;
}) {
	const body = (
		<>
			<span className="text-2xl font-medium tabular-nums">{value}</span>
			<span className="text-xs text-muted-foreground">{label}</span>
			{note ? (
				<span className="text-[11px] text-muted-foreground">{note}</span>
			) : null}
		</>
	);
	const shell =
		"flex min-w-0 flex-col gap-0.5 rounded-md border border-border p-3 text-left";
	return onOpen ? (
		<button
			type="button"
			onClick={onOpen}
			className={`${shell} hover:bg-muted/50`}
		>
			{body}
		</button>
	) : (
		<div className={shell}>{body}</div>
	);
}

function Panel({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
			<SectionTitle>{title}</SectionTitle>
			{children}
		</section>
	);
}

function PoolTable({ pools }: { pools: Overview["pools"] }) {
	const columns: Array<[string, keyof Counts]> = [
		["Total", "total"],
		["Pending triage", "pendingTriage"],
		["Awaiting review", "awaitingReview"],
		["Ready to send", "readyToSend"],
		["Sent", "sent"],
		["Replied", "replied"],
		["Call / text", "callText"],
	];
	return (
		<Panel title="Sent and eligible by pool">
			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<thead className="bg-muted text-left">
						<tr>
							<th className="px-3 py-2 font-medium">Pool</th>
							{columns.map(([label]) => (
								<th key={label} className="px-3 py-2 text-right font-medium">
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{pools.map((p) => (
							<tr key={p.table} className="border-t border-border">
								<td className="px-3 py-2 font-medium">
									{poolLabel(
										p.table === "isp" || p.table === "gym" ? p.table : null,
									)}
								</td>
								{columns.map(([label, key]) => (
									<td key={label} className="px-3 py-2 text-right tabular-nums">
										{p[key]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Panel>
	);
}

function Series({
	series,
}: {
	series: Array<{ date: string; count: number }>;
}) {
	const points = series.slice(-CHART_DAYS);
	if (points.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">No data in this window.</p>
		);
	}
	const max = Math.max(...points.map((p) => p.count), 1);
	return (
		<div className="flex h-28 items-end gap-1">
			{points.map((p) => (
				<div
					key={p.date}
					title={`${p.date}: ${p.count}`}
					className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
				>
					<span className="text-[10px] text-muted-foreground">{p.count}</span>
					<div
						className="w-full rounded-sm bg-primary"
						style={{
							height: `${Math.max(4, Math.round((p.count / max) * 72))}px`,
						}}
					/>
				</div>
			))}
		</div>
	);
}

function Bars({ counts }: { counts: Record<string, number> }) {
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	if (entries.length === 0) {
		return <p className="text-xs text-muted-foreground">No data.</p>;
	}
	const max = Math.max(...entries.map(([, n]) => n), 1);
	return (
		<ul className="flex flex-col gap-1.5">
			{entries.map(([label, n]) => (
				<li key={label} className="flex items-center gap-2 text-xs">
					<span className="w-28 shrink-0 truncate sm:w-40" title={label}>
						{label}
					</span>
					<div className="h-3 min-w-0 flex-1 rounded-sm bg-muted">
						<div
							className="h-3 rounded-sm bg-primary"
							style={{ width: `${Math.max(3, Math.round((n / max) * 100))}%` }}
						/>
					</div>
					<span className="w-10 text-right tabular-nums text-muted-foreground">
						{n}
					</span>
				</li>
			))}
		</ul>
	);
}
