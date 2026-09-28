"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { SectionTitle } from "./lead-parts";
import { MirrorFreshness, poolLabel, when } from "./leadgen-format";
import { CallList, RecentSends, ReworkList, StandingList } from "./ops-lists";

type Overview = RouterOutputs["leadgen"]["opsOverview"];
type Counts = Overview["totals"];

export type OpsTarget = "Review" | "Triage" | "Replies" | "Leads" | "System";

const CHART_DAYS = 30;

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
	const replies = useQuery({
		...trpc.leadgenReplies.list.queryOptions({ view: "OPEN" }),
		refetchInterval: 60_000,
	});
	if (overview.isPending) {
		return <p className="text-xs text-muted-foreground">Loading…</p>;
	}
	if (overview.isError) {
		return <p className="text-xs text-destructive">{overview.error.message}</p>;
	}
	const data = overview.data;
	const t = data.totals;
	const repliesWaiting = replies.data
		? replies.data.items.filter((i) => !i.inbound.answeredVia).length
		: null;
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<MirrorFreshness />
			<section className="flex flex-col gap-2">
				<SectionTitle>Waiting on you</SectionTitle>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
					<Tile
						label="Needs triage"
						value={t.pendingTriage}
						note="Prospects with a website and no decision"
						urgent={t.pendingTriage > 0}
						onOpen={() => onNavigate("Triage")}
					/>
					<Tile
						label="Needs send approval"
						value={t.needsSendApproval}
						note="Built demos you have not approved for sending"
						urgent={t.needsSendApproval > 0}
						onOpen={() => onNavigate("Review")}
					/>
					<Tile
						label="Replies to answer"
						value={repliesWaiting ?? "…"}
						note="Lead replies you have not answered yet"
						urgent={(repliesWaiting ?? 0) > 0}
						onOpen={() => onNavigate("Replies")}
					/>
				</div>
			</section>
			<section className="flex flex-col gap-2">
				<SectionTitle>Pipeline</SectionTitle>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<Tile
						label="Awaiting build"
						value={t.awaitingBuild}
						note="Triage said yes; nightly build makes the demo"
					/>
					<Tile
						label="Send-approved, not sent"
						value={t.sendApprovedUnsent}
						note={`${t.readyToSend} have an email and draft for the 08:30 send`}
					/>
					<Tile
						label="Ever sent"
						value={t.sent}
						note="Leads that got at least one email"
					/>
					<Tile
						label="Ever replied"
						value={t.replied}
						note={`${percent(t.replied, t.sent)} reply rate (leads, not messages)`}
					/>
					<Tile
						label="Call / text list"
						value={t.callText}
						note="Approved but no email on file"
					/>
					<Tile
						label="New, no website"
						value={t.newNoWebsite}
						note="Undecided, not shown in Triage"
						onOpen={() => onNavigate("Leads")}
					/>
					<Tile
						label="Demos built"
						value={t.sideBySideBuilt}
						note="All time, including placeholders"
					/>
					<Tile
						label="Do not contact"
						value={t.doNotContact}
						note={`of ${t.total} leads in total`}
					/>
				</div>
			</section>
			<PoolTable pools={data.pools} />
			<div className="grid gap-4 lg:grid-cols-2">
				<Panel title="Rework queue">
					<ReworkList rework={data.rework} />
				</Panel>
				<Panel title="Standing open items">
					<StandingList standing={data.standing} />
				</Panel>
			</div>
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
				<Panel title="By triage decision">
					<Bars counts={decisionLabels(data.byDecision)} />
				</Panel>
			</div>
			<Panel title="Call / text list">
				<CallList />
			</Panel>
			<Panel title="Recent sends (emails, including follow-ups)">
				<RecentSends />
			</Panel>
			<p className="text-[11px] text-muted-foreground">
				Counts as of {when(data.generatedAt)}. Services, health checks and jobs
				are under System.
			</p>
		</div>
	);
}

function decisionLabels(counts: Record<string, number>) {
	const label: Record<string, string> = {
		pending: "Undecided",
		Sent: "Sent (gym, by hand)",
	};
	return Object.fromEntries(
		Object.entries(counts).map(([k, n]) => [label[k] ?? k, n]),
	);
}

function Tile({
	label,
	value,
	note,
	urgent = false,
	onOpen,
}: {
	label: string;
	value: number | string;
	note?: string;
	urgent?: boolean;
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
	const shell = `flex min-w-0 flex-col gap-0.5 rounded-md border p-3 text-left ${
		urgent ? "border-amber-500/50 bg-amber-500/5" : "border-border"
	}`;
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
		["Needs triage", "pendingTriage"],
		["Awaiting build", "awaitingBuild"],
		["Needs send approval", "needsSendApproval"],
		["Send-approved", "sendApprovedUnsent"],
		["Ever sent", "sent"],
		["Ever replied", "replied"],
		["Call / text", "callText"],
	];
	return (
		<Panel title="By pool">
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
