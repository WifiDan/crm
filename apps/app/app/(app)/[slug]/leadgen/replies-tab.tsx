"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@crm/ui/components/alert-dialog";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Textarea } from "@crm/ui/components/textarea";
import { cn } from "@crm/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";

type Item = RouterOutputs["leadgenReplies"]["list"]["items"][number];

const PLACEHOLDER = /\[\s*CHECK\b/i;
const INPUT_CLASS =
	"h-8 w-full rounded-md border border-border bg-background px-2 text-xs";

function when(iso: string | null): string {
	return iso ? new Date(iso).toLocaleString() : "unknown";
}

export function RepliesTab() {
	const trpc = useTRPC();
	const [view, setView] = useState<"OPEN" | "DONE">("OPEN");
	const status = useQuery({
		...trpc.leadgenReplies.status.queryOptions(),
		refetchInterval: 30_000,
	});
	const list = useQuery({
		...trpc.leadgenReplies.list.queryOptions({ view }),
		refetchInterval: 30_000,
	});

	return (
		<div className="flex flex-col gap-4">
			<StatusStrip status={status.data} error={status.error?.message} />
			<div className="flex gap-2">
				{(["OPEN", "DONE"] as const).map((v) => (
					<Button
						key={v}
						size="sm"
						variant={view === v ? "default" : "outline"}
						onClick={() => setView(v)}
					>
						{v === "OPEN" ? "Awaiting your review" : "Sent / discarded"}
					</Button>
				))}
			</div>
			{list.isPending ? (
				<p className="text-xs text-muted-foreground">Loading…</p>
			) : list.isError ? (
				<p className="text-xs text-destructive">{list.error.message}</p>
			) : list.data.items.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					{view === "OPEN"
						? "No drafts waiting. Nothing goes out unless you send it from here."
						: "Nothing sent or discarded yet."}
				</p>
			) : (
				<ul className="flex flex-col gap-4">
					{list.data.items.map((item) =>
						view === "OPEN" ? (
							<DraftCard
								key={item.id}
								item={item}
								canSend={
									!!status.data?.sendEnabled && !!status.data?.youAreApprover
								}
							/>
						) : (
							<DoneCard key={item.id} item={item} />
						),
					)}
				</ul>
			)}
		</div>
	);
}

function StatusStrip({
	status,
	error,
}: {
	status: RouterOutputs["leadgenReplies"]["status"] | undefined;
	error: string | undefined;
}) {
	if (error) return <p className="text-xs text-destructive">{error}</p>;
	if (!status) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
			<Badge variant={status.sendEnabled ? "secondary" : "destructive"}>
				Sending {status.sendEnabled ? "ON" : "OFF"}
			</Badge>
			<Badge variant={status.youAreApprover ? "secondary" : "destructive"}>
				{status.youAreApprover
					? "You can send"
					: "You are not an approved sender"}
			</Badge>
			<span className="text-muted-foreground">
				From {status.from} · {status.sentLast24h}/{status.maxPerDay} sent in the
				last 24h · nothing is sent automatically
			</span>
		</div>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			{children}
		</div>
	);
}

function TheirReply({ item }: { item: Item }) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<Field label="Their reply">
				<div className="text-xs">
					<div>
						<span className="text-muted-foreground">From </span>
						{item.inbound.fromAddr}
					</div>
					<div>
						<span className="text-muted-foreground">Subject </span>
						{item.inbound.subject ?? "(none)"}
					</div>
					<div className="text-muted-foreground">
						{when(item.inbound.receivedAt)}
					</div>
				</div>
			</Field>
			<div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs">
				{item.inbound.bodyText ?? "(no text)"}
			</div>
		</div>
	);
}

function DraftCard({ item, canSend }: { item: Item; canSend: boolean }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [subject, setSubject] = useState(item.draftSubject);
	const [body, setBody] = useState(item.draftBody);
	const refresh = () => {
		void qc.invalidateQueries({
			queryKey: trpc.leadgenReplies.list.queryKey(),
		});
		void qc.invalidateQueries({
			queryKey: trpc.leadgenReplies.status.queryKey(),
		});
	};
	const send = useMutation({
		...trpc.leadgenReplies.send.mutationOptions(),
		onSuccess: (r) => toast.success(`Sent to ${r.to}`),
		onError: (e) => toast.error(e.message),
		onSettled: refresh,
	});
	const discard = useMutation({
		...trpc.leadgenReplies.discard.mutationOptions(),
		onSuccess: () => toast.success("Draft discarded"),
		onError: (e) => toast.error(e.message),
		onSettled: refresh,
	});

	const edited = subject !== item.draftSubject || body !== item.draftBody;
	const hasPlaceholder = PLACEHOLDER.test(body) || PLACEHOLDER.test(subject);
	const claimed = item.status !== "PENDING";
	const problems = [
		...item.blockers,
		...(hasPlaceholder ? ["fill in every [CHECK: ...] before sending"] : []),
		...(!body.trim() ? ["body is empty"] : []),
		...(claimed ? ["a send is already in progress or unconfirmed"] : []),
	];
	const disabled =
		!canSend || problems.length > 0 || send.isPending || discard.isPending;
	const to = item.to ?? "";

	return (
		<li className="flex flex-col gap-3 rounded-md border border-border p-3">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="text-sm font-medium">{item.lead.businessName}</span>
				{item.inbound.classification ? (
					<Badge variant="outline">{item.inbound.classification}</Badge>
				) : null}
				{item.lead.demoUrl ? (
					<a
						href={item.lead.demoUrl}
						target="_blank"
						rel="noreferrer"
						className="text-muted-foreground underline"
					>
						demo site
					</a>
				) : null}
				{claimed ? <Badge variant="destructive">{item.status}</Badge> : null}
			</div>

			{item.sendError ? (
				<p className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive">
					{item.sendError}
				</p>
			) : null}

			<div className="grid gap-4 md:grid-cols-2">
				<TheirReply item={item} />
				<div className="flex min-w-0 flex-col gap-2">
					<Field label="Your reply (edit before sending if you like)">
						<div className="text-xs">
							<span className="text-muted-foreground">To </span>
							<span className="font-medium">{to || "(no valid address)"}</span>
						</div>
					</Field>
					<input
						className={INPUT_CLASS}
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						aria-label="Subject"
						disabled={claimed}
					/>
					<Textarea
						className="min-h-48 text-xs"
						value={body}
						onChange={(e) => setBody(e.target.value)}
						aria-label="Reply body"
						disabled={claimed}
					/>
					{item.rationale ? (
						<p className="text-[11px] text-muted-foreground">
							Why: {item.rationale}
						</p>
					) : null}
					{item.checks.length > 0 ? (
						<ul className="list-disc pl-4 text-[11px] text-amber-600 dark:text-amber-400">
							{item.checks.map((c) => (
								<li key={c}>Check: {c}</li>
							))}
						</ul>
					) : null}
				</div>
			</div>

			{problems.length > 0 ? (
				<ul className="flex flex-wrap gap-1">
					{problems.map((p) => (
						<li key={p}>
							<Badge variant="destructive">{p}</Badge>
						</li>
					))}
				</ul>
			) : null}

			<div className={cn("flex items-center justify-end gap-2")}>
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							disabled={claimed || send.isPending || discard.isPending}
						>
							Discard
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Discard this draft?</AlertDialogTitle>
							<AlertDialogDescription>
								No email is sent. The draft is marked discarded.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => discard.mutate({ id: item.id })}
							>
								Discard
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>

				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button size="sm" disabled={disabled}>
							{edited ? "Edit & send" : "Send"}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Send this email now?</AlertDialogTitle>
							<AlertDialogDescription>
								A real email goes to <strong>{to}</strong> with subject “
								{subject}”. This cannot be undone.
								{edited ? " You edited the draft." : ""}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() =>
									send.mutate({ id: item.id, subject, body, expectedTo: to })
								}
							>
								Send email
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</li>
	);
}

function DoneCard({ item }: { item: Item }) {
	const sent = item.status === "SENT";
	return (
		<li className="flex flex-col gap-3 rounded-md border border-border p-3">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="text-sm font-medium">{item.lead.businessName}</span>
				<Badge variant={sent ? "secondary" : "outline"}>{item.status}</Badge>
				<span className="text-muted-foreground">
					by {item.reviewedBy ?? "unknown"} · {when(item.reviewedAt)}
				</span>
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<TheirReply item={item} />
				<div className="flex min-w-0 flex-col gap-2">
					<Field label={sent ? `Sent to ${item.to ?? ""}` : "Discarded draft"}>
						<div className="text-xs font-medium">
							{item.sentSubject ?? item.draftSubject}
						</div>
					</Field>
					<div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs">
						{item.sentBody ?? item.draftBody}
					</div>
				</div>
			</div>
		</li>
	);
}
