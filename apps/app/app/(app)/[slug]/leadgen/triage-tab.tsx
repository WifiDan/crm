"use client";

import { Button } from "@crm/ui/components/button";
import { TablePagination } from "@crm/ui/components/table-pagination";
import { cn } from "@crm/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { type Applied, LeadActions } from "./lead-actions";
import { effectiveLead } from "./lead-actions-state";
import {
	CONTROL_CLASS,
	DecisionBadge,
	LeadFacts,
	NotesBlock,
	PoolBadge,
	ScoreBadge,
	SectionTitle,
} from "./lead-parts";
import {
	MirrorFreshness,
	useDebounced,
	useOldDashboard,
} from "./leadgen-format";

type Row = RouterOutputs["leadgen"]["triageList"]["rows"][number];

const PAGE_SIZE = 25;

const DECISIONS = [
	{ value: "undecided", label: "Undecided" },
	{ value: "Approved", label: "Approved" },
	{ value: "Rejected", label: "Rejected" },
	{ value: "all", label: "All" },
] as const;

type Decision = (typeof DECISIONS)[number]["value"];

const SORTS = [
	{ value: "score", label: "Worst score first" },
	{ value: "businessName", label: "Name" },
	{ value: "updatedAt", label: "Recently changed" },
] as const;

export function TriageTab({
	initialDecision = "all",
}: {
	initialDecision?: Decision;
}) {
	const trpc = useTRPC();
	const [decision, setDecision] = useState<Decision>(initialDecision);
	const [applied, setApplied] = useState<Record<string, Applied>>({});
	const [table, setTable] = useState<"" | "isp" | "gym">("");
	const [campaignId, setCampaignId] = useState("");
	const [marketId, setMarketId] = useState("");
	const [sort, setSort] = useState<string>("score");
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const search = useDebounced(q);

	const campaigns = useQuery(trpc.leadgen.campaigns.queryOptions());
	const markets = useQuery(trpc.leadgen.markets.queryOptions());
	const list = useQuery({
		...trpc.leadgen.triageList.queryOptions({
			q: search,
			sort,
			dir: "asc",
			page,
			pageSize: PAGE_SIZE,
			decision,
			table: table || undefined,
			campaignId: campaignId || undefined,
			marketId: marketId || undefined,
		}),
		placeholderData: keepPreviousData,
	});

	const reset =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			set(value);
			setPage(1);
		};
	const decisionCounts = list.data?.facetCounts.decision ?? {};
	const total = list.data?.total ?? 0;
	const everything = decisionCounts.all ?? 0;
	const selected = list.data?.rows.find((r) => r.id === selectedId) ?? null;

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<MirrorFreshness writes />
			<div className="flex flex-wrap gap-2">
				{DECISIONS.map((d) => (
					<Button
						key={d.value}
						size="sm"
						variant={decision === d.value ? "default" : "outline"}
						onClick={() => reset(setDecision)(d.value)}
					>
						{d.label}
						{decisionCounts[d.value] !== undefined
							? ` (${decisionCounts[d.value]})`
							: ""}
					</Button>
				))}
			</div>
			<div className="flex flex-wrap gap-2">
				<input
					className={cn(CONTROL_CLASS, "w-full sm:w-56")}
					placeholder="Search name, address, email"
					value={q}
					onChange={(e) => reset(setQ)(e.target.value)}
				/>
				<select
					className={CONTROL_CLASS}
					value={table}
					onChange={(e) =>
						reset(setTable)(e.target.value as "" | "isp" | "gym")
					}
				>
					<option value="">ISP + gym</option>
					<option value="isp">
						ISP
						{list.data?.facetCounts.table?.isp !== undefined
							? ` (${list.data.facetCounts.table.isp})`
							: ""}
					</option>
					<option value="gym">
						Gym
						{list.data?.facetCounts.table?.gym !== undefined
							? ` (${list.data.facetCounts.table.gym})`
							: ""}
					</option>
				</select>
				<select
					className={CONTROL_CLASS}
					value={campaignId}
					onChange={(e) => reset(setCampaignId)(e.target.value)}
				>
					<option value="">All campaigns</option>
					{(campaigns.data ?? []).map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<select
					className={CONTROL_CLASS}
					value={marketId}
					onChange={(e) => reset(setMarketId)(e.target.value)}
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
					className={CONTROL_CLASS}
					value={sort}
					onChange={(e) => reset(setSort)(e.target.value)}
				>
					{SORTS.map((s) => (
						<option key={s.value} value={s.value}>
							{s.label}
						</option>
					))}
				</select>
			</div>
			<p className="text-xs text-muted-foreground">
				{total} of {everything} prospects with no demo built yet.
			</p>
			{list.isError ? (
				<p className="text-xs text-destructive">{list.error.message}</p>
			) : null}
			<div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<div
					className={cn(
						"flex min-w-0 flex-col gap-2",
						selectedId ? "hidden lg:flex" : "",
					)}
				>
					{list.isPending ? (
						<p className="text-xs text-muted-foreground">Loading…</p>
					) : null}
					{list.data && list.data.rows.length === 0 ? (
						<EmptyState decision={decision} counts={decisionCounts} />
					) : null}
					<ul className="flex flex-col gap-2">
						{(list.data?.rows ?? []).map((r) => (
							<li key={r.id}>
								<ProspectCard
									row={effectiveLead(r, applied[r.id])}
									active={r.id === selectedId}
									onSelect={() => setSelectedId(r.id)}
								/>
							</li>
						))}
					</ul>
					<TablePagination
						page={page}
						pageSize={PAGE_SIZE}
						total={total}
						totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
						loading={list.isFetching}
						onPageChange={setPage}
					/>
				</div>
				<div className={cn("min-w-0", selectedId ? "" : "hidden lg:block")}>
					{selectedId ? (
						<ProspectDetail
							id={selectedId}
							row={selected}
							applied={applied[selectedId]}
							onApplied={(r) => setApplied((p) => ({ ...p, [r.leadId]: r }))}
							onBack={() => setSelectedId(null)}
						/>
					) : (
						<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
							Pick a prospect to see its notes and open its current site.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

function EmptyState({
	decision,
	counts,
}: {
	decision: Decision;
	counts: Record<string, number>;
}) {
	const decided = (counts.Approved ?? 0) + (counts.Rejected ?? 0);
	if (decision === "undecided" && decided > 0) {
		return (
			<p className="rounded-md border border-border p-3 text-xs">
				Nothing left to triage. Every prospect here already has a decision (
				{counts.Approved ?? 0} approved, {counts.Rejected ?? 0} rejected).
			</p>
		);
	}
	return (
		<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
			No prospects match this view.
		</p>
	);
}

function ProspectCard({
	row,
	active,
	onSelect,
}: {
	row: Row;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex w-full min-w-0 flex-col gap-1 rounded-md border border-border p-3 text-left text-xs",
				active ? "bg-muted" : "hover:bg-muted/50",
			)}
		>
			<span className="text-sm font-medium">{row.businessName}</span>
			<span className="flex flex-wrap items-center gap-1">
				<PoolBadge table={row.table} />
				<ScoreBadge score={row.score} />
				<DecisionBadge decision={row.decision} />
				{row.source ? (
					<span className="text-muted-foreground">{row.source}</span>
				) : null}
			</span>
			{row.address ? (
				<span className="truncate text-muted-foreground">{row.address}</span>
			) : null}
		</button>
	);
}

function ProspectDetail({
	id,
	row,
	applied,
	onApplied,
	onBack,
}: {
	id: string;
	row: Row | null;
	applied: Applied | undefined;
	onApplied: (result: Applied) => void;
	onBack: () => void;
}) {
	const trpc = useTRPC();
	const old = useOldDashboard();
	const detail = useQuery(trpc.leadgen.leadDetail.queryOptions({ id }));
	const found = detail.data ?? row;
	if (!found) {
		return (
			<div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
				<Button
					size="sm"
					variant="ghost"
					className="w-fit lg:hidden"
					onClick={onBack}
				>
					Back to list
				</Button>
				{detail.isPending ? (
					<p className="text-muted-foreground">Loading…</p>
				) : (
					<p className="text-muted-foreground">
						This prospect is no longer in the mirror.
					</p>
				)}
			</div>
		);
	}
	const lead = effectiveLead(found, applied);
	const shot = lead.oldSite ? old.screenshot(lead.oldSite) : null;
	const preview = lead.oldSite ? old.preview(lead.oldSite) : null;
	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
			<Button
				size="sm"
				variant="ghost"
				className="w-fit lg:hidden"
				onClick={onBack}
			>
				Back to list
			</Button>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm font-medium">{lead.businessName}</span>
				<PoolBadge table={lead.table} />
				<DecisionBadge decision={lead.decision} />
			</div>
			<LeadFacts lead={lead} />
			<SectionTitle>Their current site</SectionTitle>
			{lead.oldSite ? (
				<div className="flex flex-col gap-2 text-xs">
					<a
						className="break-all underline"
						href={lead.oldSite}
						target="_blank"
						rel="noreferrer noopener"
					>
						{lead.oldSite}
					</a>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" asChild>
							<a href={lead.oldSite} target="_blank" rel="noreferrer noopener">
								Open their site
							</a>
						</Button>
						{shot ? (
							<Button size="sm" variant="outline" asChild>
								<a href={shot} target="_blank" rel="noreferrer noopener">
									Screenshot (old dashboard)
								</a>
							</Button>
						) : null}
						{preview ? (
							<Button size="sm" variant="outline" asChild>
								<a href={preview} target="_blank" rel="noreferrer noopener">
									Preview (old dashboard)
								</a>
							</Button>
						) : null}
					</div>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					The website URL on file is not a valid web address.
				</p>
			)}
			<SectionTitle>Notes</SectionTitle>
			<NotesBlock
				notes={detail.data?.notes ?? row?.notes ?? ""}
				truncated={detail.data?.notesTruncated ?? row?.notesTruncated ?? false}
			/>
			<LeadActions
				lead={{
					id: lead.id,
					table: lead.table,
					businessName: lead.businessName,
					decision: lead.decision,
					decisionDate: lead.decisionDate,
					version: lead.version,
					doNotContact: detail.data?.doNotContact ?? false,
					email: detail.data?.email ?? null,
				}}
				stage="triage"
				applied={applied}
				onApplied={onApplied}
			/>
		</div>
	);
}
