"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { cn } from "@crm/ui/lib/utils";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import { OpsTab } from "./ops-tab";
import { RepliesTab } from "./replies-tab";
import { ReviewTab } from "./review-tab";
import { TriageTab } from "./triage-tab";

const TABS = [
	"Ops",
	"Triage",
	"Review",
	"Replies",
	"Jobs",
	"Leads",
	"Markets",
	"Alerts",
] as const;
type Tab = (typeof TABS)[number];

const STAGES = [
	"NEW",
	"APPROVED",
	"REJECTED",
	"BUILT",
	"READY",
	"SENT",
	"REPLIED",
	"DEAD",
] as const;
type Stage = (typeof STAGES)[number];

const SELECT_CLASS =
	"h-8 rounded-md border border-border bg-background px-2 text-xs";

function when(iso: string | null): string {
	if (!iso) return "never";
	return new Date(iso).toLocaleString();
}

function statusVariant(status: string | null) {
	if (status === "OK") return "secondary" as const;
	if (status === "RUNNING") return "outline" as const;
	if (status) return "destructive" as const;
	return "outline" as const;
}

export function LeadgenConsole() {
	const [tab, setTab] = useState<Tab>("Ops");
	useEffect(() => {
		const fromHash = TABS.find(
			(t) => t === decodeURIComponent(window.location.hash.slice(1)),
		);
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
							"-mb-px shrink-0 border-b-2 px-3 py-2 text-xs font-medium",
							tab === t
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{t}
					</button>
				))}
			</div>
			{tab === "Ops" ? <OpsTab onNavigate={select} /> : null}
			{tab === "Triage" ? <TriageTab /> : null}
			{tab === "Review" ? <ReviewTab /> : null}
			{tab === "Jobs" ? <JobsTab /> : null}
			{tab === "Replies" ? <RepliesTab /> : null}
			{tab === "Leads" ? <LeadsTab /> : null}
			{tab === "Markets" ? <MarketsTab /> : null}
			{tab === "Alerts" ? <AlertsTab /> : null}
		</div>
	);
}

function JobsTab() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const jobs = useQuery({
		...trpc.leadgen.jobs.queryOptions(),
		refetchInterval: 15_000,
	});
	const runs = useQuery({
		...trpc.leadgen.jobRuns.queryOptions({ limit: 25 }),
		refetchInterval: 15_000,
	});
	const refresh = () => {
		void qc.invalidateQueries({ queryKey: trpc.leadgen.jobs.queryKey() });
		void qc.invalidateQueries({ queryKey: trpc.leadgen.jobRuns.queryKey() });
	};
	const runNow = useMutation({
		...trpc.leadgen.jobRunNow.mutationOptions(),
		onSettled: refresh,
	});
	const setEnabled = useMutation({
		...trpc.leadgen.jobSetEnabled.mutationOptions(),
		onSettled: refresh,
	});

	if (jobs.isPending)
		return <p className="text-xs text-muted-foreground">Loading…</p>;
	if (jobs.isError)
		return <p className="text-xs text-destructive">{jobs.error.message}</p>;

	return (
		<div className="flex flex-col gap-4">
			{!jobs.data.schedulerEnabled ? (
				<p className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
					The scheduler ticker is OFF (LEADGEN_SCHEDULER_ENABLED is not true).
					Jobs can still be run by hand below.
				</p>
			) : null}
			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<thead className="bg-muted text-left">
						<tr>
							{["Job", "Schedule", "Last run", "Status", "Next run", ""].map(
								(h) => (
									<th key={h} className="px-3 py-2 font-medium">
										{h}
									</th>
								),
							)}
						</tr>
					</thead>
					<tbody>
						{jobs.data.jobs.map((j) => (
							<tr key={j.name} className="border-t border-border align-top">
								<td className="px-3 py-2">
									<div className="font-medium">{j.name}</div>
									<div className="text-muted-foreground">{j.description}</div>
									{!j.hasHandler ? (
										<Badge variant="destructive">no handler</Badge>
									) : null}
								</td>
								<td className="px-3 py-2">
									{j.scheduleKind === "INTERVAL"
										? `every ${Math.round((j.intervalSeconds ?? 0) / 60)} min`
										: `daily ${j.dailyAt} ${j.timezone}`}
								</td>
								<td className="px-3 py-2">
									{when(j.lastFinishedAt ?? j.lastRunAt)}
								</td>
								<td className="px-3 py-2">
									<Badge variant={statusVariant(j.lastStatus)}>
										{j.lastStatus ?? "never run"}
									</Badge>
									{j.lastError ? (
										<div className="mt-1 max-w-xs text-destructive">
											{j.lastError}
										</div>
									) : null}
									{j.lastCounters ? (
										<div className="mt-1 max-w-xs font-mono text-muted-foreground">
											{Object.entries(j.lastCounters)
												.map(([k, v]) => `${k}=${String(v)}`)
												.join(" ")}
										</div>
									) : null}
								</td>
								<td className="px-3 py-2">
									{j.enabled ? when(j.nextRunAt) : "paused"}
								</td>
								<td className="px-3 py-2">
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="outline"
											disabled={runNow.isPending || !j.hasHandler}
											onClick={() => runNow.mutate({ name: j.name })}
										>
											Run now
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												setEnabled.mutate({ name: j.name, enabled: !j.enabled })
											}
										>
											{j.enabled ? "Pause" : "Resume"}
										</Button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{runNow.data && !runNow.data.started ? (
				<p className="text-xs text-muted-foreground">{runNow.data.reason}</p>
			) : null}

			<h3 className="text-xs font-medium">Recent runs</h3>
			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<thead className="bg-muted text-left">
						<tr>
							{["Started", "Job", "Trigger", "Status", "Detail"].map((h) => (
								<th key={h} className="px-3 py-2 font-medium">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{(runs.data ?? []).map((r) => (
							<tr key={r.id} className="border-t border-border align-top">
								<td className="px-3 py-2">{when(r.startedAt)}</td>
								<td className="px-3 py-2">{r.job}</td>
								<td className="px-3 py-2">{r.trigger}</td>
								<td className="px-3 py-2">
									<Badge variant={statusVariant(r.status)}>{r.status}</Badge>
								</td>
								<td className="px-3 py-2 font-mono text-muted-foreground">
									{r.error ??
										(r.counters
											? Object.entries(r.counters)
													.map(([k, v]) => `${k}=${String(v)}`)
													.join(" ")
											: "")}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function LeadsTab() {
	const trpc = useTRPC();
	const [q, setQ] = useState("");
	const [stage, setStage] = useState<Stage | "">("");
	const [table, setTable] = useState<"" | "isp" | "gym">("");
	const [page, setPage] = useState(1);
	const [sort, setSort] = useState("businessName");
	const [dir, setDir] = useState<"asc" | "desc">("asc");
	const pageSize = 25;

	const mirror = useQuery({
		...trpc.leadgen.mirrorStatus.queryOptions(),
		refetchInterval: 30_000,
	});
	const leads = useQuery({
		...trpc.leadgen.leads.queryOptions({
			q,
			sort,
			dir,
			page,
			pageSize,
			stage: stage || undefined,
			table: table || undefined,
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
			<div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-xs">
				<span className="font-medium">Mirror</span>
				{mirror.data?.tables.map((t) => (
					<span key={t.table}>
						{t.table}: {t.mirroredActive}
						{t.lastRunSource !== null ? ` / ${t.lastRunSource}` : ""}{" "}
						<Badge variant={t.inSync === false ? "destructive" : "secondary"}>
							{t.inSync === null
								? "unverified"
								: t.inSync
									? "in sync"
									: "MISMATCH"}
						</Badge>
					</span>
				))}
				<span className="text-muted-foreground">
					last run {when(mirror.data?.lastRunAt ?? null)} (
					{mirror.data?.lastRunStatus ?? "none"})
				</span>
				<span className="text-muted-foreground">
					Read-only: NocoDB is still the writer.
				</span>
			</div>

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
						setStage(e.target.value as Stage | "");
						setPage(1);
					}}
				>
					<option value="">All stages</option>
					{STAGES.map((s) => (
						<option key={s} value={s}>
							{s}
							{leads.data?.facetCounts.stage?.[s] !== undefined
								? ` (${leads.data.facetCounts.stage[s]})`
								: ""}
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
				<span className="self-center text-xs text-muted-foreground">
					{leads.data?.total ?? 0} leads
				</span>
			</div>

			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<thead className="bg-muted text-left">
						<tr>
							{headerCell("Business", "businessName")}
							{headerCell("Table")}
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
								<td className="px-3 py-2">{r.table}</td>
								<td className="px-3 py-2">
									<Badge variant="outline">{r.stage}</Badge>
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
		</div>
	);
}

function MarketsTab() {
	const trpc = useTRPC();
	const markets = useQuery(trpc.leadgen.markets.queryOptions());
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
				</tbody>
			</table>
		</div>
	);
}

function AlertsTab() {
	const trpc = useTRPC();
	const alerts = useQuery({
		...trpc.leadgen.alerts.queryOptions(),
		refetchInterval: 30_000,
	});
	if (alerts.isPending)
		return <p className="text-xs text-muted-foreground">Loading…</p>;
	if (alerts.isError)
		return <p className="text-xs text-destructive">{alerts.error.message}</p>;
	if (alerts.data.length === 0) {
		return <p className="text-xs text-muted-foreground">No open alerts.</p>;
	}
	return (
		<ul className="flex flex-col gap-2">
			{alerts.data.map((a) => (
				<li
					key={a.id}
					className="rounded-md border border-border px-3 py-2 text-xs"
				>
					<Badge variant={a.tier === "PAGE" ? "destructive" : "outline"}>
						{a.tier}
					</Badge>{" "}
					<span className="font-mono text-muted-foreground">{a.key}</span>
					<div>{a.message}</div>
					<div className="text-muted-foreground">{when(a.createdAt)}</div>
				</li>
			))}
		</ul>
	);
}
