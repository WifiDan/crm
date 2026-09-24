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
import { Button } from "@crm/ui/components/button";
import { Textarea } from "@crm/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import {
	type ActionLead,
	armsOnApprove,
	effectiveLead,
	seenOf,
	stateNote,
} from "./lead-actions-state";
import { ReviewStateBadge, SectionTitle, ToneBadge } from "./lead-parts";
import { newRequestId } from "./request-id";
import { reviewStateOf } from "./stage-labels";

export type Applied = RouterOutputs["leadgenDecisions"]["decide"];
type Stage = "triage" | "review";
type Decision = "Approved" | "Rejected" | "Needs Changes";

export function LeadActions({
	lead,
	stage,
	applied,
	onApplied,
}: {
	lead: ActionLead;
	stage: Stage;
	applied: Applied | undefined;
	onApplied: (result: Applied) => void;
}) {
	const trpc = useTRPC();
	const status = useQuery(trpc.leadgenDecisions.status.queryOptions());
	const request = useRef<{ key: string; id: string } | null>(null);
	const [notes, setNotes] = useState("");
	const current = effectiveLead(lead, applied);

	const idFor = (key: string) => {
		if (request.current?.key !== key)
			request.current = { key, id: newRequestId() };
		return request.current.id;
	};
	const saved = (result: Applied, label: string) => {
		request.current = null;
		onApplied(result);
		toast.success(label);
	};
	const failed = (error: { message: string }) => {
		request.current = null;
		toast.error(error.message);
	};

	const decide = useMutation({
		...trpc.leadgenDecisions.decide.mutationOptions(),
		onSuccess: (result) => saved(result, `Saved: ${result.decision}`),
		onError: failed,
	});
	const rework = useMutation({
		...trpc.leadgenDecisions.rework.mutationOptions(),
		onSuccess: (result) => {
			setNotes("");
			saved(result, "Rework requested");
		},
		onError: failed,
	});

	if (status.isPending) {
		return (
			<p className="text-xs text-muted-foreground">Checking decision access…</p>
		);
	}
	if (status.isError) {
		return <p className="text-xs text-destructive">{status.error.message}</p>;
	}
	if (!status.data.youAreApprover) {
		return (
			<p className="text-xs text-muted-foreground">
				{status.data.approversConfigured
					? "Your account may not make lead decisions."
					: "Lead decisions are switched off on this server."}
			</p>
		);
	}
	if (!status.data.writeConfigured) {
		return (
			<p className="text-xs text-destructive">
				Decisions cannot be saved: {status.data.writeProblem}.
			</p>
		);
	}

	const busy = decide.isPending || rework.isPending;
	const seen = seenOf(current);
	const blockedReason = current.doNotContact
		? "This lead is marked do not contact. No decision can be saved."
		: current.version
			? null
			: "This lead has no version in the mirror yet. Wait for the next mirror run.";
	const arming = armsOnApprove(stage, current.table);

	const send = (decision: Decision) => {
		decide.mutate({
			id: current.id,
			requestId: idFor(`${stage}:${decision}`),
			stage,
			decision,
			seen,
			confirmArm: arming && decision === "Approved",
		});
	};
	const sendRework = () => {
		rework.mutate({
			id: current.id,
			requestId: idFor("rework"),
			notes: notes.trim(),
			seen,
		});
	};

	const reviewIsp = stage === "review" && current.table === "isp";
	const disabledAll = busy || blockedReason !== null;
	const needsChangesButton = (label: string) => (
		<Button
			size="sm"
			variant="outline"
			disabled={disabledAll}
			onClick={() => send("Needs Changes")}
		>
			{label}
		</Button>
	);

	return (
		<div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<SectionTitle>Decision</SectionTitle>
				<span className="text-muted-foreground">now</span>
				{stage === "review" ? (
					<ReviewStateBadge state={reviewStateOf(current)} />
				) : (
					<ToneBadge
						tone={
							current.decision === "Rejected"
								? "bad"
								: current.decision === "Approved"
									? "good"
									: "waiting"
						}
					>
						{current.decision === "Approved"
							? "approved to build"
							: (current.decision?.toLowerCase() ?? "undecided")}
					</ToneBadge>
				)}
			</div>
			{blockedReason ? (
				<p className="text-xs text-destructive">{blockedReason}</p>
			) : null}
			<div className="flex flex-wrap items-start gap-2">
				{arming ? (
					<ApproveForSending
						name={current.businessName}
						email={current.email ?? null}
						disabled={disabledAll}
						onConfirm={() => send("Approved")}
					/>
				) : (
					<Button
						size="sm"
						disabled={disabledAll}
						onClick={() => send("Approved")}
					>
						Approve
					</Button>
				)}
				<Button
					size="sm"
					variant="outline"
					disabled={disabledAll}
					onClick={() => send("Rejected")}
				>
					Reject
				</Button>
				{reviewIsp ? null : needsChangesButton("Needs changes")}
			</div>
			{reviewIsp ? (
				<details className="group rounded-md border border-border px-3 py-2 text-xs">
					<summary className="cursor-pointer select-none font-medium">
						Needs changes…
					</summary>
					<div className="mt-2 flex flex-col gap-2">
						<Textarea
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="What must change in this demo"
							rows={3}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={disabledAll || notes.trim() === ""}
								onClick={sendRework}
							>
								Request rework
							</Button>
							{needsChangesButton("Mark needs changes (no rebuild)")}
						</div>
						<p className="text-[11px] text-muted-foreground">
							Request rework sends your note to the nightly build, which
							rebuilds the demo. Marking needs changes only records the
							decision. Either one takes the lead out of the send queue.
						</p>
					</div>
				</details>
			) : null}
			<p className="text-[11px] text-muted-foreground">
				{stage === "triage"
					? "Approving here means the prospect is worth building. It does not send anything."
					: current.table === "gym"
						? "Gym sends stay manual. Approving here only records the decision."
						: "Approve for sending asks you to confirm first. Reject takes the lead out of the send queue."}
			</p>
			{stateNote(applied) ? (
				<p className="text-xs">{stateNote(applied)}</p>
			) : null}
		</div>
	);
}

function ApproveForSending({
	name,
	email,
	disabled,
	onConfirm,
}: {
	name: string;
	email: string | null;
	disabled: boolean;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button size="sm" disabled={disabled}>
					Approve for sending
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Approve {name} for sending?</AlertDialogTitle>
					<AlertDialogDescription>
						This lead becomes eligible for the next 08:30 send. The sender
						emails{email ? <strong> {email}</strong> : " the lead"} unless a
						rule stops it (already mailed, replied, opt-out or do not contact).
						You can pull it back with Reject or Needs changes before then.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>
						Approve and allow sending
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
