"use client";

import { Badge } from "@crm/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { SectionTitle } from "./lead-parts";
import { when } from "./leadgen-format";

type Health = RouterOutputs["leadgen"]["opsHealth"];
type Unit = Health["systemd"]["units"][number];

export function hasProblem(unit: Unit): boolean {
	if (unit.activeState === "failed") return true;
	return (
		unit.result !== "success" && unit.result !== "unknown" && unit.result !== ""
	);
}

function Box({
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

export function OpsHealthPanel() {
	const trpc = useTRPC();
	const health = useQuery({
		...trpc.leadgen.opsHealth.queryOptions(),
		refetchInterval: 60_000,
	});
	if (health.isPending) {
		return <p className="text-xs text-muted-foreground">Loading health…</p>;
	}
	if (health.isError) {
		return <p className="text-xs text-destructive">{health.error.message}</p>;
	}
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<Box title="Services and timers (systemd)">
				<Units systemd={health.data.systemd} />
			</Box>
			<div className="grid gap-4 lg:grid-cols-2">
				<Box title="Health checks">
					<Checks checks={health.data.checks} />
				</Box>
				<Box title="Comp CRM sync files">
					<CrmSync sync={health.data.crmSync} />
				</Box>
			</div>
			<p className="text-[11px] text-muted-foreground">
				Health read at {when(health.data.generatedAt)}.
			</p>
		</div>
	);
}

function Units({ systemd }: { systemd: Health["systemd"] }) {
	if (!systemd.available) {
		return (
			<p className="text-xs text-destructive">
				systemd could not be read: {systemd.error ?? "unknown error"}
			</p>
		);
	}
	if (systemd.units.length === 0) {
		return <p className="text-xs text-muted-foreground">No matching units.</p>;
	}
	const units = [...systemd.units].sort(
		(a, b) => Number(hasProblem(b)) - Number(hasProblem(a)),
	);
	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<table className="w-full text-xs">
				<thead className="bg-muted text-left">
					<tr>
						{["Unit", "State", "Last run", "Next run"].map((h) => (
							<th key={h} className="px-3 py-2 font-medium">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{units.map((u) => (
						<tr key={u.name} className="border-t border-border align-top">
							<td className="px-3 py-2">
								<div className="font-medium">{u.name}</div>
								<div className="max-w-xs text-muted-foreground">
									{u.description}
								</div>
							</td>
							<td className="px-3 py-2">
								<Badge variant={hasProblem(u) ? "destructive" : "secondary"}>
									{u.activeState}/{u.subState}
								</Badge>
								{u.result !== "success" ? (
									<div className="text-destructive">{u.result}</div>
								) : null}
							</td>
							<td className="px-3 py-2">
								{when(
									u.kind === "timer" ? u.lastTriggerAt : u.lastExitAt,
									"n/a",
								)}
							</td>
							<td className="px-3 py-2">{when(u.nextRunAt, "n/a")}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Checks({ checks }: { checks: Health["checks"] }) {
	if (checks.error) {
		return (
			<p className="text-xs text-destructive">
				Could not read health-state.json: {checks.error}
			</p>
		);
	}
	if (!checks.available) {
		return (
			<p className="text-xs text-muted-foreground">
				health-state.json is not on this host.
			</p>
		);
	}
	return (
		<ul className="flex flex-col gap-1.5">
			{checks.items.map((c) => (
				<li key={c.name} className="flex flex-wrap items-center gap-2 text-xs">
					<Badge variant={c.ok ? "secondary" : "destructive"}>
						{c.ok ? "ok" : "FAIL"}
					</Badge>
					<span className="font-medium">{c.name}</span>
					<span className="text-muted-foreground">{c.detail}</span>
				</li>
			))}
		</ul>
	);
}

function CrmSync({ sync }: { sync: Health["crmSync"] }) {
	if (sync.error) {
		return <p className="text-xs text-destructive">{sync.error}</p>;
	}
	return (
		<ul className="flex flex-col gap-2 text-xs">
			<li className="rounded-md border border-border p-2">
				<div className="font-medium">Company map (crm_company_map.json)</div>
				<div className="text-muted-foreground">
					{sync.companyMap
						? `${sync.companyMap.entries} entries, updated ${when(sync.companyMap.updatedAt)}`
						: "not found"}
				</div>
			</li>
			<li className="rounded-md border border-border p-2">
				<div className="font-medium">
					Deal sync queue (crm_deal_queue.jsonl)
				</div>
				<div className="text-muted-foreground">
					{sync.dealQueue
						? `${sync.dealQueue.pending} pending, touched ${when(sync.dealQueue.updatedAt)}`
						: "not found"}
				</div>
			</li>
		</ul>
	);
}
