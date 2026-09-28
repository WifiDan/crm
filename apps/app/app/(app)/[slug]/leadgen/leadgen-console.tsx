"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { cn } from "@crm/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import { StageBadge } from "./lead-parts";
import { MirrorFreshness, poolLabel, when } from "./leadgen-format";
import { OpsTab } from "./ops-tab";
import { RepliesTab } from "./replies-tab";
import { ReviewTab } from "./review-tab";
import { LEAD_STAGE_ORDER, type LeadStage, STAGE_INFO } from "./stage-labels";
import { SystemButton, SystemTab } from "./system-tab";
import { TriageTab } from "./triage-tab";

const TABS = ["Today", "Triage", "Review", "Replies", "Leads"] as const;
type Tab = (typeof TABS)[number] | "System";

/** Old bookmarks keep working after the tabs were merged. */
const LEGACY_HASH: Record<string, Tab> = {
	Ops: "Today",
	Jobs: "System",
	Alerts: "System",
	Markets: "Leads",
};

const SELECT_CLASS =
	"h-8 rounded-md border border-border bg-background px-2 text-xs";

function tabFromHash(hash: string): Tab | null {
	const name = decodeURIComponent(hash.replace(/^#/, ""));
	if (name === "System") return "System";
	return TABS.find((t) => t === name) ?? LEGACY_HASH[name] ?? null;
}

function useTabCounts(): Partial<Record<Tab, number>> {
	const trpc = useTRPC();
	const overview = useQuery({
		...trpc.leadgen.opsOverview.queryOptions(),
		refetchInterval: 60_000,
	});
	const replies = useQuery({
		...trpc.leadgenReplies.list.queryOptions({ view: "OPEN" }),
		refetchInterval: 60_000,
	});
	return {
		Triage: overview.data?.totals.pendingTriage,
		Review: overview.data?.totals.needsSendApproval,
		Replies: replies.data?.items.filter((i) => !i.inbound.answeredVia).length,
	};
}

export function LeadgenConsole() {
	const [tab, setTab] = useState<Tab>("Today");
	const counts = useTabCounts();
	useEffect(() => {
		const fromHash = tabFromHash(window.location.hash);
		if (fromHash) setTab(fromHash);
	}, []);
	const select = (next: Tab) => {
		setTab(next);
		window.history.replaceState(null, "", `#${next}`);
	};
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex gap-1 overflow-x-auto border-b border-border">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						onClick={() => select(t)}
						className={cn(
							"-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium",
							tab === t
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{t}
						{counts[t] ? (
							<span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] tabular-nums text-amber-700 dark:text-amber-300">
								{counts[t]}
							</span>
						) : null}
					</button>
				))}
				<SystemButton
					active={tab === "System"}
					onClick={() => select("System")}
				/>
			</div>
			{tab === "Today" ? <OpsTab onNavigate={select} /> : null}
			{tab === "Triage" ? <TriageTab /> : null}
			{tab === "Review" ? <ReviewTab /> : null}
			{tab === "Replies" ? <RepliesTab /> : null}
			{tab === "Leads" ? <LeadsTab /> : null}
			{tab === "System" ? <SystemTab /> : null}
		</div>
	);
}

function LeadsTab() {
	const trpc = useTRPC();
	const [q, setQ] = useState("");
	const [stage, setStage] = useState<LeadStage | "">("");
	const [showDead, setShowDead] = useState(false);
	const [marketId, setMarketId] = useState("");
	const [table, setTable] = useState<"" | "isp" | "gym">("");
	const [page, setPage] = useState(1);
	const [sort, setSort] = useState("businessName");
	const [dir, setDir] = useState<"asc" | "desc">("asc");
	const pageSize = 25;

	const markets = useQuery(trpc.leadgen.markets.queryOptions());
	const leads = useQuery({
		...trpc.leadgen.leads.queryOptions({
			q,
			sort,
			dir,
			page,
			pageSize,
			stage: stage || undefined,
			table: table || undefined,
			marketId: marketId || undefined,
			hideDead: !showDead,
		}),
		placeholderData: keepPreviousData,
	});

	const headerCell = (label: string, key?: string) => (
		<th className="px-3 py-2 font-medium">
			{key ? (
				<button
					type="button"
					onClick={() => {
						if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
						else {
							setSort(key);
							setDir("asc");
						}
					}}
				>
					{label}
					{sort === key ? (dir === "asc" ? " ▲" : " ▼") : ""}
				</button>
			) : (
				label
			)}
		</th>
	);
	const totalPages = Math.max(
		1,
		Math.ceil((leads.data?.total ?? 0) / pageSize),
	);

	return (
		<div className="flex flex-col gap-3">
			<MirrorFreshness />
			<div className="flex flex-wrap gap-2">
				<input
					className={cn(SELECT_CLASS, "w-56")}
					placeholder="Search name, email, address"
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						setPage(1);
					}}
				/>
				<select
					className={SELECT_CLASS}
					value={stage}
					onChange={(e) => {
						setStage(e.target.value as LeadStage | "");
						setPage(1);
					}}
				>
					<option value="">All stages</option>
					{LEAD_STAGE_ORDER.map((s) => (
						<option key={s} value={s}>
							{STAGE_INFO[s].label} ({leads.data?.facetCounts.stage?.[s] ?? 0})
						</option>
					))}
				</select>
				<select
					className={SELECT_CLASS}
					value={marketId}
					onChange={(e) => {
						setMarketId(e.target.value);
						setPage(1);
					}}
				>
					<option value="">All markets</option>
					<option value="none">No market</option>
					{(markets.data ?? []).map((m) => (
						<option key={m.id} value={m.id}>
							{m.name}
						</option>
					))}
				</select>
				<select
					className={SELECT_CLASS}
					value={table}
					onChange={(e) => {
						setTable(e.target.value as "" | "isp" | "gym");
						setPage(1);
					}}
				>
					<option value="">ISP + gym</option>
					<option value="isp">ISP</option>
					<option value="gym">Gym</option>
				</select>
				<label className="flex items-center gap-1 self-center text-xs">
					<input
						type="checkbox"
						checked={showDead}
						onChange={(e) => {
							setShowDead(e.target.checked);
							setPage(1);
						}}
					/>
					Show dead
				</label>
				<span className="self-center text-xs text-muted-foreground">
					{leads.data?.total ?? 0} leads
				</span>
			</div>

			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<thead className="bg-muted text-left">
						<tr>
							{headerCell("Business", "businessName")}
							{headerCell("Pool")}
							{headerCell("Stage", "stage")}
							{headerCell("Email")}
							{headerCell("Market")}
							{headerCell("Sent", "sentAt")}
							{headerCell("DNC")}
						</tr>
					</thead>
					<tbody>
						{(leads.data?.rows ?? []).map((r) => (
							<tr key={r.id} className="border-t border-border">
								<td className="px-3 py-2">
									<div className="font-medium">{r.businessName}</div>
									{r.demoUrl ? (
										<a
											className="text-muted-foreground underline"
											href={r.demoUrl}
											target="_blank"
											rel="noreferrer"
										>
											demo
										</a>
									) : null}
								</td>
								<td className="px-3 py-2">{poolLabel(r.table)}</td>
								<td className="px-3 py-2">
									<StageBadge stage={r.stage} />
								</td>
								<td className="px-3 py-2">{r.email ?? ""}</td>
								<td className="px-3 py-2">{r.market ?? ""}</td>
								<td className="px-3 py-2">{r.sentAt ? when(r.sentAt) : ""}</td>
								<td className="px-3 py-2">
									{r.doNotContact ? (
										<Badge variant="destructive">DNC</Badge>
									) : (
										""
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="flex items-center gap-2 text-xs">
				<Button
					size="sm"
					variant="outline"
					disabled={page <= 1}
					onClick={() => setPage(page - 1)}
				>
					Prev
				</Button>
				<span>
					Page {page} of {totalPages}
				</span>
				<Button
					size="sm"
					variant="outline"
					disabled={page >= totalPages}
					onClick={() => setPage(page + 1)}
				>
					Next
				</Button>
			</div>
			<details className="rounded-md border border-border px-3 py-2 text-xs">
				<summary className="cursor-pointer select-none font-medium">
					Markets
				</summary>
				<div className="mt-2">
					<MarketsTable />
				</div>
			</details>
		</div>
	);
}

function MarketsTable() {
	const trpc = useTRPC();
	const markets = useQuery(trpc.leadgen.markets.queryOptions());
	const overview = useQuery(trpc.leadgen.opsOverview.queryOptions());
	if (markets.isPending)
		return <p className="text-xs text-muted-foreground">Loading…</p>;
	if (markets.isError)
		return <p className="text-xs text-destructive">{markets.error.message}</p>;
	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<table className="w-full text-xs">
				<thead className="bg-muted text-left">
					<tr>
						{["Market", "Kind", "Status", "Leads", "Daily prospect cap"].map(
							(h) => (
								<th key={h} className="px-3 py-2 font-medium">
									{h}
								</th>
							),
						)}
					</tr>
				</thead>
				<tbody>
					{markets.data.map((m) => (
						<tr key={m.id} className="border-t border-border">
							<td className="px-3 py-2 font-medium">{m.name}</td>
							<td className="px-3 py-2">{m.kind}</td>
							<td className="px-3 py-2">
								<Badge variant="outline">{m.status}</Badge>
							</td>
							<td className="px-3 py-2">{m.leadCount}</td>
							<td className="px-3 py-2">{m.dailyProspectCap}</td>
						</tr>
					))}
					{overview.data ? (
						<tr className="border-t border-border text-muted-foreground">
							<td className="px-3 py-2 font-medium">No market</td>
							<td className="px-3 py-2" />
							<td className="px-3 py-2" />
							<td className="px-3 py-2">
								{overview.data.totals.total -
									markets.data.reduce((sum, m) => sum + m.leadCount, 0)}
							</td>
							<td className="px-3 py-2" />
						</tr>
					) : null}
				</tbody>
			</table>
		</div>
	);
}
