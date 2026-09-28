"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { cn } from "@crm/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import { SectionTitle } from "./lead-parts";
import { when } from "./leadgen-format";
import { hasProblem, OpsHealthPanel } from "./ops-health-panel";

type Counters = Record<string, unknown>;

function statusVariant(status: string | null) {
	if (status === "OK") return "secondary" as const;
	if (status === "RUNNING") return "outline" as const;
	if (status) return "destructive" as const;
	return "outline" as const;
}

const num = (c: Counters, k: string) =>
	typeof c[k] === "number" ? (c[k] as number) : 0;

/** One plain sentence per job; the raw counters stay one click away. */
export function jobSummary(job: string, c: Counters): string {
	switch (job) {
		case "nocodb.mirror": {
			const changed =
				num(c, "isp.created") +
				num(c, "isp.updated") +
				num(c, "gym.created") +
				num(c, "gym.updated");
			const missing = num(c, "isp.missing") + num(c, "gym.missing");
			return `${num(c, "isp.mirrored") + num(c, "gym.mirrored")} leads copied, ${changed} changed${missing ? `, ${missing} missing` : ""}.`;
		}
		case "outreach.shadow":
			return `Would send ${num(c, "plannedSends")} of ${num(c, "candidates")} candidates (cap ${num(c, "cap")}). Sends nothing.`;
		case "outreach.shadow.compare":
			return `${num(c, "mismatch") === 0 ? "Matches" : `${num(c, "mismatch")} mismatches with`} the Python sender. Streak ${num(c, "matchStreak")}.`;
		case "replies.draft":
			return `${num(c, "drafted")} drafts written, ${num(c, "failed")} failed.`;
		case "replies.poll":
			return `${num(c, "fetched")} new messages, ${num(c, "matchedToLead")} matched to leads.`;
		case "sendlog.sync":
			return `${num(c, "created")} new sends logged, ${num(c, "inLedger")} in the ledger${num(c, "unmatchedLead") ? `, ${num(c, "unmatchedLead")} unmatched` : ""}.`;
		default: {
			const entries = Object.entries(c).slice(0, 3);
			return entries.map(([k, v]) => `${k} ${String(v)}`).join(", ");
		}
	}
}

function RawCounters({ counters }: { counters: Counters }) {
	return (
		<details className="mt-1 text-muted-foreground">
			<summary className="cursor-pointer select-none text-[11px]">
				details
			</summary>
			<div className="font-mono text-[11px] break-words">
				{Object.entries(counters)
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(" ")}
			</div>
		</details>
	);
}

/** Green when nothing needs attention; used by the header button too. */
export function useSystemStatus() {
	const trpc = useTRPC();
	const jobs = useQuery({
		...trpc.leadgen.jobs.queryOptions(),
		refetchInterval: 60_000,
	});
	const alerts = useQuery({
		...trpc.leadgen.alerts.queryOptions(),
		refetchInterval: 60_000,
	});
	const health = useQuery({
		...trpc.leadgen.opsHealth.queryOptions(),
		refetchInterval: 120_000,
	});
	const failingJobs = (jobs.data?.jobs ?? []).filter(
		(j) =>
			j.lastStatus !== null &&
			j.lastStatus !== "OK" &&
			j.lastStatus !== "RUNNING",
	).length;
	const pages = (alerts.data ?? []).filter((a) => a.tier === "PAGE").length;
	const failedChecks = (health.data?.checks.items ?? []).filter(
		(c) => !c.ok,
	).length;
	const failedUnits = (health.data?.systemd.units ?? []).filter(
		hasProblem,
	).length;
	const problems = [
		failingJobs
			? `${failingJobs} failing job${failingJobs > 1 ? "s" : ""}`
			: "",
		pages ? `${pages} paging alert${pages > 1 ? "s" : ""}` : "",
		failedChecks
			? `${failedChecks} failed check${failedChecks > 1 ? "s" : ""}`
			: "",
		failedUnits
			? `${failedUnits} service problem${failedUnits > 1 ? "s" : ""}`
			: "",
		jobs.data && !jobs.data.schedulerEnabled ? "scheduler off" : "",
	].filter(Boolean);
	const loaded = !!jobs.data && !!alerts.data;
	return {
		loaded,
		ok: loaded && problems.length === 0,
		problems,
		openAlerts: alerts.data?.length ?? 0,
	};
}

export function SystemButton({
	active,
	onClick,
}: {
	active: boolean;
	onClick: () => void;
}) {
	const status = useSystemStatus();
	return (
		<button
			type="button"
			onClick={onClick}
			title={
				status.ok ? "All systems OK" : status.problems.join(", ") || "Checking…"
			}
			className={cn(
				"-mb-px ml-auto flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium",
				active
					? "border-foreground text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"inline-block size-2 rounded-full",
					!status.loaded
						? "bg-muted-foreground"
						: status.ok
							? "bg-emerald-500"
							: "bg-red-500",
				)}
			/>
			System
		</button>
	);
}

export function SystemTab() {
	const status = useSystemStatus();
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<p
				className={cn(
					"rounded-md border px-3 py-2 text-xs",
					status.ok
						? "border-emerald-500/40 bg-emerald-500/5"
						: "border-red-500/40 bg-red-500/5",
				)}
			>
				{!status.loaded
					? "Checking…"
					: status.ok
						? "All systems OK. Jobs are running, no alerts, health checks pass."
						: `Needs a look: ${status.problems.join(", ")}.`}
			</p>
			<section className="flex flex-col gap-2">
				<SectionTitle>Alerts</SectionTitle>
				<AlertsPanel />
			</section>
			<section className="flex flex-col gap-2">
				<SectionTitle>CRM jobs</SectionTitle>
				<JobsPanel />
			</section>
			<OpsHealthPanel />
		</div>
	);
}

function JobsPanel() {
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
	const [allRuns, setAllRuns] = useState(false);
	const shownRuns = (runs.data ?? []).filter(
		(r) => allRuns || (r.status !== "OK" && r.status !== "RUNNING"),
	);
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
										<div className="mt-1 max-w-xs">
											<div>{jobSummary(j.name, j.lastCounters)}</div>
											<RawCounters counters={j.lastCounters} />
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

			<div className="flex items-center gap-2">
				<h3 className="text-xs font-medium">Recent runs</h3>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2"
					onClick={() => setAllRuns((v) => !v)}
				>
					{allRuns ? "Problems only" : "Show all runs"}
				</Button>
			</div>
			{!allRuns && shownRuns.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					No failed runs in the last {(runs.data ?? []).length} runs.
				</p>
			) : null}
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
						{shownRuns.map((r) => (
							<tr key={r.id} className="border-t border-border align-top">
								<td className="px-3 py-2">{when(r.startedAt)}</td>
								<td className="px-3 py-2">{r.job}</td>
								<td className="px-3 py-2">{r.trigger}</td>
								<td className="px-3 py-2">
									<Badge variant={statusVariant(r.status)}>{r.status}</Badge>
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{r.error ?? (r.counters ? jobSummary(r.job, r.counters) : "")}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function AlertsPanel() {
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
		return (
			<p className="text-xs text-muted-foreground">
				No open alerts. All quiet.
			</p>
		);
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
