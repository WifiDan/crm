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
import { groupByLead, splitQuoted } from "./reply-thread";

type Item = RouterOutputs["leadgenReplies"]["list"]["items"][number];

const PLACEHOLDER = /\[\s*CHECK\b/i;
const ANSWERED_LABEL: Record<string, string> = {
	"sent-folder-thread": "You already replied from your mail app",
	"sent-folder-address":
		"You emailed this address after their reply (not threaded)",
	"crm-reply": "Already replied from here",
};
const INPUT_CLASS =
	"h-8 w-full rounded-md border border-border bg-background px-2 text-xs";

function when(iso: string | null): string {
	return iso ? new Date(iso).toLocaleString() : "unknown";
}

type View = "NEEDS" | "ANSWERED" | "DONE";

const VIEW_LABEL: Record<View, string> = {
	NEEDS: "Needs a reply",
	ANSWERED: "Already answered",
	DONE: "Sent / discarded",
};

export function RepliesTab() {
	const trpc = useTRPC();
	const [view, setView] = useState<View>("NEEDS");
	const status = useQuery({
		...trpc.leadgenReplies.status.queryOptions(),
		refetchInterval: 30_000,
	});
	const open = useQuery({
		...trpc.leadgenReplies.list.queryOptions({ view: "OPEN" }),
		refetchInterval: 30_000,
	});
	const done = useQuery({
		...trpc.leadgenReplies.list.queryOptions({ view: "DONE" }),
		refetchInterval: 60_000,
	});
	const openItems = open.data?.items ?? [];
	const byView: Record<View, Item[]> = {
		NEEDS: openItems.filter((i) => !i.inbound.answeredVia),
		ANSWERED: openItems.filter((i) => !!i.inbound.answeredVia),
		DONE: done.data?.items ?? [],
	};
	const current = view === "DONE" ? done : open;
	const groups = groupByLead(byView[view]);
	const canSend = !!status.data?.sendEnabled && !!status.data?.youAreApprover;

	return (
		<div className="flex flex-col gap-4">
			<StatusStrip status={status.data} error={status.error?.message} />
			<div className="flex flex-wrap gap-2">
				{(["NEEDS", "ANSWERED", "DONE"] as const).map((v) => (
					<Button
						key={v}
						size="sm"
						variant={view === v ? "default" : "outline"}
						onClick={() => setView(v)}
					>
						{VIEW_LABEL[v]}
						{(v === "DONE" ? done.data : open.data)
							? ` (${byView[v].length})`
							: ""}
					</Button>
				))}
			</div>
			{view === "ANSWERED" ? (
				<p className="text-xs text-muted-foreground">
					You already answered these from your mail app. Discard the drafts here
					once you are sure, so they stop showing up.
				</p>
			) : null}
			{current.isPending ? (
				<p className="text-xs text-muted-foreground">Loading…</p>
			) : current.isError ? (
				<p className="text-xs text-destructive">{current.error.message}</p>
			) : groups.length === 0 ? (
				<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
					{view === "NEEDS"
						? "All caught up. No lead reply is waiting on you."
						: view === "ANSWERED"
							? "Nothing here."
							: "Nothing sent or discarded yet."}
				</p>
			) : (
				<ul className="flex flex-col gap-4">
					{groups.map((g) => (
						<li key={g.key} className="flex flex-col gap-2">
							{view === "DONE" ? (
								<DoneCard item={g.latest} />
							) : (
								<DraftCard item={g.latest} canSend={canSend} />
							)}
							{g.older.length > 0 ? (
								<details className="rounded-md border border-dashed border-border px-3 py-2 text-xs">
									<summary className="cursor-pointer select-none text-muted-foreground">
										{g.older.length} earlier{" "}
										{g.older.length === 1 ? "reply" : "replies"} from{" "}
										{g.latest.lead.businessName}
									</summary>
									<ul className="mt-2 flex flex-col gap-3">
										{g.older.map((item) =>
											view === "DONE" ? (
												<DoneCard key={item.id} item={item} />
											) : (
												<DraftCard
													key={item.id}
													item={item}
													canSend={canSend}
												/>
											),
										)}
									</ul>
								</details>
							) : null}
						</li>
					))}
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
	const sentence = !status.sendEnabled
		? "Sending is off on this server. You can read and edit drafts here, but replies go out from your mail app."
		: !status.youAreApprover
			? "Sending is on, but your account is not an approved sender."
			: `You can send from ${status.from}. ${status.sentLast24h} of ${status.maxPerDay} sent in the last 24 hours. Nothing is sent automatically.`;
	return (
		<div className="flex flex-col gap-1 text-xs">
			<p
				className={cn(
					"rounded-md border px-3 py-2",
					status.sendEnabled && status.youAreApprover
						? "border-border"
						: "border-amber-500/40 bg-amber-500/5",
				)}
			>
				{sentence}
			</p>
			{status.sentCheck ? (
				<p className="text-destructive">
					Could not confirm your Sent folder: {status.sentCheck}. Replies you
					sent from your mail app may still show as waiting.
				</p>
			) : null}
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
			<QuotedBody body={item.inbound.bodyText} />
		</div>
	);
}

function QuotedBody({ body }: { body: string | null }) {
	const { latest, earlier } = splitQuoted(body);
	return (
		<div className="flex flex-col gap-1">
			<div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-xs">
				{latest || "(no text)"}
			</div>
			{earlier ? (
				<details className="text-xs">
					<summary className="cursor-pointer select-none text-muted-foreground">
						Show earlier messages
					</summary>
					<div className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 text-muted-foreground">
						{earlier}
					</div>
				</details>
			) : null}
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
				{item.inbound.answeredVia ? (
					<Badge variant="outline">
						{ANSWERED_LABEL[item.inbound.answeredVia] ?? "Already answered"}
					</Badge>
				) : null}
				<span className="ml-auto text-muted-foreground">
					{when(item.inbound.receivedAt)}
				</span>
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
