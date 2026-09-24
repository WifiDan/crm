"use client";

import { Badge } from "@crm/ui/components/badge";
import { TablePagination } from "@crm/ui/components/table-pagination";
import { cn } from "@crm/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { CONTROL_CLASS, PoolBadge } from "./lead-parts";
import { useDebounced, when } from "./leadgen-format";

type Overview = RouterOutputs["leadgen"]["opsOverview"];

const PAGE_SIZE = 10;

export function ReworkList({ rework }: { rework: Overview["rework"] }) {
	if (rework.total === 0) {
		return (
			<p className="text-xs text-muted-foreground">Rework queue is empty.</p>
		);
	}
	return (
		<ul className="flex flex-col gap-2">
			{rework.rows.map((r) => (
				<li key={r.id} className="rounded-md border border-border p-2 text-xs">
					<div className="font-medium">{r.businessName}</div>
					<div className="text-muted-foreground">{r.notes ?? "(no notes)"}</div>
					<div className="text-[11px] text-muted-foreground">
						since {r.since ?? "unknown"}
					</div>
				</li>
			))}
			{rework.total > rework.rows.length ? (
				<li className="text-[11px] text-muted-foreground">
					Showing {rework.rows.length} of {rework.total}.
				</li>
			) : null}
		</ul>
	);
}

export function StandingList({ standing }: { standing: Overview["standing"] }) {
	if (standing.error) {
		return (
			<p className="text-xs text-destructive">
				Could not read the standing tasks file: {standing.error}
			</p>
		);
	}
	if (!standing.available) {
		return (
			<p className="text-xs text-muted-foreground">
				The standing tasks file is not on this host.
			</p>
		);
	}
	if (standing.items.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">No standing open items.</p>
		);
	}
	return (
		<ul className="flex flex-col gap-2">
			{standing.items.map((t) => (
				<li key={t.id} className="rounded-md border border-border p-2 text-xs">
					<div>{t.text}</div>
					<div className="text-[11px] text-muted-foreground">
						since {t.since ?? "unknown"}
					</div>
				</li>
			))}
		</ul>
	);
}

function SearchBox({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	return (
		<input
			className={cn(CONTROL_CLASS, "w-full sm:w-64")}
			placeholder={placeholder}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

export function CallList() {
	const trpc = useTRPC();
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const search = useDebounced(q);
	const list = useQuery({
		...trpc.leadgen.opsCallList.queryOptions({
			q: search,
			sort: "",
			dir: "asc",
			page,
			pageSize: PAGE_SIZE,
		}),
		placeholderData: keepPreviousData,
	});
	const total = list.data?.total ?? 0;
	return (
		<div className="flex flex-col gap-2">
			<SearchBox
				value={q}
				onChange={(v) => {
					setQ(v);
					setPage(1);
				}}
				placeholder="Search name or phone"
			/>
			{list.isError ? (
				<p className="text-xs text-destructive">{list.error.message}</p>
			) : null}
			{list.data && list.data.rows.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					Call / text list is empty.
				</p>
			) : null}
			<ul className="flex flex-col gap-2">
				{(list.data?.rows ?? []).map((r) => (
					<li
						key={r.id}
						className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs"
					>
						<span className="font-medium">{r.businessName}</span>
						<PoolBadge table={r.table} />
						<span className="text-muted-foreground">
							{r.contact ?? "no contact name"}
						</span>
						{r.phone ? (
							<a className="ml-auto underline" href={`tel:${r.phone}`}>
								{r.phone}
							</a>
						) : (
							<span className="ml-auto text-muted-foreground">no phone</span>
						)}
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
	);
}

export function RecentSends() {
	const trpc = useTRPC();
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const search = useDebounced(q);
	const list = useQuery({
		...trpc.leadgen.opsRecentSends.queryOptions({
			q: search,
			sort: "",
			dir: "desc",
			page,
			pageSize: PAGE_SIZE,
		}),
		placeholderData: keepPreviousData,
	});
	const total = list.data?.total ?? 0;
	return (
		<div className="flex flex-col gap-2">
			<SearchBox
				value={q}
				onChange={(v) => {
					setQ(v);
					setPage(1);
				}}
				placeholder="Search lead, address or subject"
			/>
			{list.isError ? (
				<p className="text-xs text-destructive">{list.error.message}</p>
			) : null}
			{list.data && list.data.rows.length === 0 ? (
				<p className="text-xs text-muted-foreground">No sends match.</p>
			) : null}
			<ul className="flex flex-col gap-2">
				{(list.data?.rows ?? []).map((r) => (
					<li
						key={r.id}
						className="flex flex-col gap-0.5 rounded-md border border-border p-2 text-xs"
					>
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{r.businessName}</span>
							<Badge variant="outline">{r.step}</Badge>
							{r.replied ? <Badge variant="secondary">replied</Badge> : null}
						</div>
						<div className="text-muted-foreground">
							{r.toAddr} · sent {when(r.sentAt)}
						</div>
						<div>{r.subject ?? "(no subject on file)"}</div>
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
	);
}
