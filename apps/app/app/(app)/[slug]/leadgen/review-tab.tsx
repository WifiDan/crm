"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { TablePagination } from "@crm/ui/components/table-pagination";
import { cn } from "@crm/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import { LocalDemoPane } from "./demo-local-pane";
import { type Applied, LeadActions } from "./lead-actions";
import { effectiveLead, nextIdAfter } from "./lead-actions-state";
import {
	CONTROL_CLASS,
	LeadFacts,
	NotesBlock,
	PoolBadge,
	QaBadge,
	ReviewStateBadge,
	SectionTitle,
	ToneBadge,
} from "./lead-parts";
import { MirrorFreshness, useDebounced } from "./leadgen-format";
import { SiteAuditPanel } from "./site-audit-panel";
import { SiteShot } from "./site-shot-panel";
import { reviewStateOf } from "./stage-labels";

type Row = RouterOutputs["leadgen"]["reviewList"]["rows"][number];
type Detail = NonNullable<RouterOutputs["leadgen"]["leadDetail"]>;

const PAGE_SIZE = 25;

const VIEWS = [
	{ value: "pending", label: "Needs send approval" },
	{ value: "approved", label: "Send-approved" },
	{ value: "rejected", label: "Rejected" },
	{ value: "placeholder", label: "Placeholder" },
	{ value: "all", label: "All real demos" },
] as const;

type View = (typeof VIEWS)[number]["value"];

const FRAME_SANDBOX =
	"allow-scripts allow-same-origin allow-popups allow-forms";
const OLD_FRAME_SANDBOX = "allow-scripts allow-popups";

export function ReviewTab() {
	const trpc = useTRPC();
	const [view, setView] = useState<View>("pending");
	const [table, setTable] = useState<"" | "isp" | "gym">("");
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [applied, setApplied] = useState<Record<string, Applied>>({});
	const search = useDebounced(q);

	const list = useQuery({
		...trpc.leadgen.reviewList.queryOptions({
			q: search,
			sort: "",
			dir: "asc",
			page,
			pageSize: PAGE_SIZE,
			view,
			table: table || undefined,
		}),
		placeholderData: keepPreviousData,
	});
	const rows = list.data?.rows ?? [];
	const total = list.data?.total ?? 0;
	const viewCounts = list.data?.facetCounts.view ?? {};
	const index = rows.findIndex((r) => r.id === selectedId);
	const selected = index >= 0 ? (rows[index] ?? null) : null;

	const reset =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			set(value);
			setPage(1);
			setSelectedId(null);
		};
	const advance = (leadId: string) => {
		const next = nextIdAfter(
			rows.map((r) => r.id),
			leadId,
		);
		if (next && leadId === selectedId) setSelectedId(next);
	};
	const step = (delta: number) => {
		const next = rows[index + delta];
		if (next) setSelectedId(next.id);
	};

	// On a wide screen open the first demo, so the detail pane is never blank.
	const firstId = rows[0]?.id ?? null;
	useEffect(() => {
		if (selectedId || !firstId) return;
		if (window.matchMedia?.("(min-width: 1280px)").matches)
			setSelectedId(firstId);
	}, [selectedId, firstId]);

	// j / k move through the list. Nothing is decided from the keyboard.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			if (
				e.metaKey ||
				e.ctrlKey ||
				e.altKey ||
				el?.closest("input, textarea, select, [contenteditable=true]")
			)
				return;
			const at = rows.findIndex((r) => r.id === selectedId);
			const target =
				e.key === "j" ? rows[at + 1] : e.key === "k" ? rows[at - 1] : null;
			if (target) {
				e.preventDefault();
				setSelectedId(target.id);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rows, selectedId]);

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<MirrorFreshness writes />
			<div className="flex flex-wrap gap-2">
				{VIEWS.map((v) => (
					<Button
						key={v.value}
						size="sm"
						variant={view === v.value ? "default" : "outline"}
						onClick={() => reset(setView)(v.value)}
					>
						{v.label}
						{viewCounts[v.value] !== undefined
							? ` (${viewCounts[v.value]})`
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
					<option value="isp">ISP</option>
					<option value="gym">Gym</option>
				</select>
			</div>
			<p className="text-xs text-muted-foreground">
				{viewCounts.everything ?? 0} built demos:{" "}
				{(viewCounts.everything ?? 0) - (viewCounts.placeholder ?? 0)} real,{" "}
				{viewCounts.placeholder ?? 0} placeholders. Keys: j / k next and
				previous.
			</p>
			{list.isError ? (
				<p className="text-xs text-destructive">{list.error.message}</p>
			) : null}
			<div className="grid gap-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
				<div
					className={cn(
						"flex min-w-0 flex-col gap-2",
						selectedId ? "hidden xl:flex" : "",
					)}
				>
					{list.isPending ? (
						<p className="text-xs text-muted-foreground">Loading…</p>
					) : null}
					{list.data && rows.length === 0 ? (
						<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
							{view === "pending"
								? "All caught up. Nothing is waiting for a send approval."
								: "No demos in this view."}
						</p>
					) : null}
					<ul className="flex flex-col gap-2">
						{rows.map((r) => (
							<li key={r.id}>
								<DemoCard
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
						onPageChange={(p) => {
							setPage(p);
							setSelectedId(null);
						}}
					/>
				</div>
				<div className={cn("min-w-0", selectedId ? "" : "hidden xl:block")}>
					{selectedId ? (
						<DemoDetail
							key={selectedId}
							id={selectedId}
							row={selected}
							applied={applied[selectedId]}
							onApplied={(r) => {
								setApplied((p) => ({ ...p, [r.leadId]: r }));
								advance(r.leadId);
							}}
							hasPrev={index > 0}
							hasNext={index >= 0 && index < rows.length - 1}
							onPrev={() => step(-1)}
							onNext={() => step(1)}
							onBack={() => setSelectedId(null)}
						/>
					) : (
						<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
							Pick a demo to compare it with their current site.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

function BuildBadge({ build }: { build: Row["build"] }) {
	if (build === "v2") return <Badge variant="secondary">v2 facelift</Badge>;
	if (build === "v1") return <Badge variant="outline">v1 build</Badge>;
	return null;
}

function DemoCard({
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
				<ReviewStateBadge state={reviewStateOf(row)} />
				<PoolBadge table={row.table} />
				<QaBadge qa={row.qa} />
				<BuildBadge build={row.build} />
			</span>
			{row.address ? (
				<span className="truncate text-muted-foreground">{row.address}</span>
			) : null}
		</button>
	);
}

export function DemoDetail({
	id,
	row,
	applied,
	onApplied,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	onBack,
}: {
	id: string;
	row: Row | null;
	applied: Applied | undefined;
	onApplied: (result: Applied) => void;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev: () => void;
	onNext: () => void;
	onBack: () => void;
}) {
	const trpc = useTRPC();
	const [pane, setPane] = useState<"new" | "old">("new");
	const detail = useQuery(trpc.leadgen.leadDetail.queryOptions({ id }));
	const lead = detail.data ? effectiveLead(detail.data, applied) : null;
	const demoUrl = lead?.demoUrl ?? row?.demoUrl ?? null;
	const name = lead?.businessName ?? row?.businessName ?? "";

	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
			<div className="flex flex-col gap-2 bg-background xl:sticky xl:top-0 xl:z-10 xl:-mx-3 xl:-mt-3 xl:rounded-t-md xl:border-b xl:border-border xl:p-3">
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						variant="ghost"
						className="xl:hidden"
						onClick={onBack}
					>
						Back to list
					</Button>
					<span className="text-sm font-medium">{name}</span>
					{row ? <QaBadge qa={row.qa} /> : null}
					{row ? <BuildBadge build={row.build} /> : null}
					<span className="ml-auto flex gap-1">
						<Button
							size="sm"
							variant="outline"
							disabled={!hasPrev}
							onClick={onPrev}
							title="Previous (k)"
						>
							Previous
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!hasNext}
							onClick={onNext}
							title="Next (j)"
						>
							Next
						</Button>
					</span>
				</div>
				{lead ? (
					<LeadActions
						lead={lead}
						stage="review"
						applied={applied}
						onApplied={onApplied}
					/>
				) : null}
			</div>
			<div className="flex gap-1 lg:hidden">
				{(["new", "old"] as const).map((p) => (
					<Button
						key={p}
						size="sm"
						variant={pane === p ? "default" : "outline"}
						onClick={() => setPane(p)}
					>
						{p === "new" ? "New demo" : "Their site"}
					</Button>
				))}
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				<section
					className={cn("min-w-0", pane === "new" ? "hidden lg:block" : "")}
				>
					<OldSitePane
						leadId={id}
						name={name}
						oldSite={lead?.oldSite ?? row?.oldSite ?? null}
					/>
				</section>
				<section
					className={cn("min-w-0", pane === "old" ? "hidden lg:block" : "")}
				>
					<DemoPane leadId={id} name={name} demoUrl={demoUrl} />
				</section>
			</div>
			{row?.qa.status === "FAIL" ? (
				<div className="flex flex-col gap-1">
					<SectionTitle>QA failures</SectionTitle>
					<ul className="list-disc pl-4 text-xs text-destructive">
						{row.qa.failures.map((f) => (
							<li key={f}>{f}</li>
						))}
					</ul>
				</div>
			) : null}
			{lead ? <DetailBody lead={lead} /> : null}
			{detail.isPending ? (
				<p className="text-xs text-muted-foreground">Loading details…</p>
			) : null}
		</div>
	);
}

const PREVIEW_LINES = 6;

function DraftEmail({ lead }: { lead: Detail }) {
	const [full, setFull] = useState(false);
	const body = lead.draftBody ?? "";
	const lines = body.split("\n");
	const long = lines.length > PREVIEW_LINES;
	return (
		<div className="flex flex-col gap-1 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<SectionTitle>Email they will get</SectionTitle>
				<ToneBadge tone="neutral">Draft, not sent</ToneBadge>
			</div>
			<div className="rounded-md border border-border bg-muted/30 p-2">
				<div className="font-medium">
					{lead.draftSubject ?? "(no draft subject yet)"}
				</div>
				<div className="mt-1 whitespace-pre-wrap break-words">
					{body === ""
						? "(no draft written for this lead yet)"
						: full || !long
							? body
							: `${lines.slice(0, PREVIEW_LINES).join("\n")}…`}
				</div>
				{long ? (
					<Button
						size="sm"
						variant="ghost"
						className="mt-1 h-7 px-2"
						onClick={() => setFull((v) => !v)}
					>
						{full ? "Show less" : "Show full email"}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function DetailBody({ lead }: { lead: Detail }) {
	return (
		<>
			<DraftEmail lead={lead} />
			<SectionTitle>Lead</SectionTitle>
			<LeadFacts lead={lead} />
			{lead.doNotContact || lead.hotLead ? (
				<div className="flex flex-wrap gap-1 text-xs">
					{lead.doNotContact ? (
						<Badge variant="destructive">do not contact</Badge>
					) : null}
					{lead.hotLead ? <Badge variant="secondary">hot lead</Badge> : null}
				</div>
			) : null}
			<SectionTitle>Notes</SectionTitle>
			<NotesBlock notes={lead.notes} truncated={lead.notesTruncated} />
		</>
	);
}

function DemoPane({
	leadId,
	name,
	demoUrl,
}: {
	leadId: string;
	name: string;
	demoUrl: string | null;
}) {
	const [view, setView] = useState<"live" | "local">("live");
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<SectionTitle>New demo</SectionTitle>
				<span className="flex gap-1">
					{(["live", "local"] as const).map((v) => (
						<Button
							key={v}
							size="sm"
							variant={view === v ? "default" : "outline"}
							onClick={() => setView(v)}
						>
							{v === "live" ? "Live (what leads see)" : "Local copy (editable)"}
						</Button>
					))}
				</span>
				{view === "live" && demoUrl ? (
					<a
						className="text-xs underline"
						href={demoUrl}
						target="_blank"
						rel="noreferrer noopener"
					>
						Open in new tab
					</a>
				) : null}
			</div>
			{view === "local" ? (
				<LocalDemoPane key={leadId} leadId={leadId} name={name} />
			) : demoUrl ? (
				<iframe
					title={`New demo for ${name}`}
					src={demoUrl}
					sandbox={FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					loading="lazy"
					className="h-[65vh] w-full rounded-md border border-border bg-background"
				/>
			) : (
				<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
					This demo has no viewable address. Only https Cloudflare Pages
					addresses are shown here.
				</p>
			)}
		</div>
	);
}

function OldSitePane({
	leadId,
	name,
	oldSite,
}: {
	leadId: string;
	name: string;
	oldSite: string | null;
}) {
	const [embed, setEmbed] = useState(false);
	const embeddable = oldSite?.startsWith("https://") ?? false;
	return (
		<div className="flex flex-col gap-2">
			<SectionTitle>Their current site</SectionTitle>
			{oldSite ? (
				<div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
					<a
						className="break-all underline"
						href={oldSite}
						target="_blank"
						rel="noreferrer noopener"
					>
						{oldSite}
					</a>
					<SiteShot key={leadId} leadId={leadId} name={name} />
					<SiteAuditPanel key={`audit-${leadId}`} leadId={leadId} />
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" asChild>
							<a
								href={oldSite}
								target="_blank"
								rel="noreferrer noopener"
								title="Many sites refuse to be framed, so the screenshot is the dependable view. The CRM does not proxy their pages."
							>
								Open their site
							</a>
						</Button>
						{embeddable ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setEmbed((v) => !v)}
							>
								{embed ? "Hide here" : "Try showing it here"}
							</Button>
						) : null}
					</div>
				</div>
			) : (
				<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
					No existing website on file. The demo was built from research.
				</p>
			)}
			{embed && oldSite ? (
				<iframe
					title={`Current site for ${name}`}
					src={oldSite}
					sandbox={OLD_FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					loading="lazy"
					className="h-[55vh] w-full rounded-md border border-border bg-background"
				/>
			) : null}
		</div>
	);
}
