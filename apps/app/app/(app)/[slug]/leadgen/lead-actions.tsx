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
import { DecisionBadge, SectionTitle } from "./lead-parts";
import { newRequestId } from "./request-id";

export type Applied = RouterOutputs["leadgenDecisions"]["decide"];
type Stage = "triage" | "review";
type Decision = "Approved" | "Rejected" | "Needs Changes";

const DECISIONS: Array<{ value: Decision; label: string }> = [
	{ value: "Approved", label: "Approve" },
	{ value: "Rejected", label: "Reject" },
	{ value: "Needs Changes", label: "Needs changes" },
];

const MIRROR_NOTE =
	"Saved changes go straight to NocoDB. This page reads the mirror, which trails by up to 15 minutes, so a list can look out of date right after you save.";

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

	return (
		<div className="flex flex-col gap-2 rounded-md border border-border p-3">
			<SectionTitle>Decision</SectionTitle>
			<div className="flex flex-wrap items-center gap-1 text-xs">
				<span className="text-muted-foreground">Now:</span>
				<DecisionBadge decision={current.decision} />
				{current.sendApproved ? (
					<Badge variant="secondary">send approved</Badge>
				) : null}
				{current.reworkRequested ? (
					<Badge variant="outline">rework requested</Badge>
				) : null}
			</div>
			{blockedReason ? (
				<p className="text-xs text-destructive">{blockedReason}</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				{arming ? (
					<ApproveForSending
						name={current.businessName}
						email={current.email ?? null}
						disabled={busy || blockedReason !== null}
						onConfirm={() => send("Approved")}
					/>
				) : (
					<Button
						size="sm"
						disabled={busy || blockedReason !== null}
						onClick={() => send("Approved")}
					>
						Approve
					</Button>
				)}
				{DECISIONS.filter((d) => d.value !== "Approved").map((d) => (
					<Button
						key={d.value}
						size="sm"
						variant="outline"
						disabled={busy || blockedReason !== null}
						onClick={() => send(d.value)}
					>
						{d.label}
					</Button>
				))}
			</div>
			<p className="text-[11px] text-muted-foreground">
				{stage === "triage"
					? "Approving here means the prospect is worth building. It does not send anything."
					: current.table === "gym"
						? "Gym sends stay manual. Approving here only records the decision."
						: "Reject and Needs changes take this lead out of the send queue."}
			</p>
			{stage === "review" && current.table === "isp" ? (
				<div className="flex flex-col gap-2">
					<SectionTitle>Send back for rework</SectionTitle>
					<Textarea
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						placeholder="What must change in this demo"
						rows={3}
					/>
					<Button
						size="sm"
						variant="outline"
						className="w-fit"
						disabled={busy || blockedReason !== null || notes.trim() === ""}
						onClick={sendRework}
					>
						Request rework
					</Button>
				</div>
			) : null}
			{stateNote(applied) ? (
				<p className="text-xs">{stateNote(applied)}</p>
			) : null}
			<p className="text-[11px] text-muted-foreground">{MIRROR_NOTE}</p>
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
