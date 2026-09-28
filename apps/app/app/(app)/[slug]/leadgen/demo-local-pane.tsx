"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";
import {
	acceptBridgeMessage,
	LOCAL_FRAME_SANDBOX,
	linkExpired,
	localStatusLine,
} from "./demo-local-state";
import { newRequestId } from "./request-id";

type Saved = RouterOutputs["leadgenDemos"]["save"];

export function LocalDemoPane({
	leadId,
	name,
}: {
	leadId: string;
	name: string;
}) {
	const trpc = useTRPC();
	const info = useQuery(trpc.leadgenDemos.info.queryOptions({ id: leadId }));
	const link = useMutation(trpc.leadgenDemos.previewLink.mutationOptions());
	const save = useMutation(trpc.leadgenDemos.save.mutationOptions());
	const frame = useRef<HTMLIFrameElement>(null);
	const pending = useRef<{ nonce: string; requestId: string } | null>(null);
	const wantEdit = useRef(false);
	const [ready, setReady] = useState(false);
	const [editing, setEditing] = useState(false);
	const [saved, setSaved] = useState<Saved | null>(null);
	const [baseSha, setBaseSha] = useState<string | null>(null);
	const started = useRef(false);

	const open = useCallback(
		(edit: boolean) => {
			setReady(false);
			setEditing(false);
			wantEdit.current = edit;
			link.mutate(
				{ id: leadId, edit },
				{ onSuccess: (result) => setBaseSha(result.sha256) },
			);
		},
		[leadId, link],
	);

	useEffect(() => {
		if (started.current || !info.data?.hasLocal) return;
		started.current = true;
		open(false);
	}, [info.data?.hasLocal, open]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = acceptBridgeMessage(event, frame.current?.contentWindow);
			if (!message) return;
			if (message.type === "ready") setReady(true);
			else if (message.type === "edit-state") setEditing(message.on);
			else if (pending.current && message.nonce === pending.current.nonce) {
				const request = pending.current;
				pending.current = null;
				if (!baseSha) return;
				save.mutate(
					{
						id: leadId,
						requestId: request.requestId,
						html: message.html,
						baseSha256: baseSha,
					},
					{
						onSuccess: (result) => {
							setSaved(result);
							setBaseSha(result.sha256);
							setEditing(false);
							toast.success("Saved locally. Not live yet.");
							void info.refetch();
						},
						onError: (error) => {
							setEditing(false);
							toast.error(error.message);
						},
					},
				);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [baseSha, leadId, save, info]);

	useEffect(() => {
		if (!ready || !wantEdit.current || editing) return;
		wantEdit.current = false;
		frame.current?.contentWindow?.postMessage(
			{ leadgen: 1, type: "edit", on: true },
			"*",
		);
	}, [ready, editing]);

	const canEdit = info.data?.canEdit ?? false;
	const mode = link.data?.mode ?? "view";
	const saveNow = () => {
		const target = frame.current?.contentWindow;
		if (!target) return;
		pending.current = { nonce: newRequestId(), requestId: newRequestId() };
		target.postMessage(
			{ leadgen: 1, type: "get-html", nonce: pending.current.nonce },
			"*",
		);
	};

	if (info.isPending)
		return (
			<p className="text-xs text-muted-foreground">
				Looking for the local copy…
			</p>
		);
	if (info.isError)
		return <p className="text-xs text-destructive">{info.error.message}</p>;
	if (!info.data.hasLocal)
		return (
			<p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
				No local build for this lead yet.{" "}
				{info.data.reason ? `(${info.data.reason})` : ""}
			</p>
		);

	const status = localStatusLine(
		saved,
		info.data.lastEdit
			? {
					at: info.data.lastEdit.at,
					by: info.data.lastEdit.by,
					backupName: info.data.lastEdit.backupName,
					status: info.data.lastEdit.status,
				}
			: null,
	);
	const expired = link.data
		? linkExpired(link.data.expiresAt, Date.now())
		: false;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				{editing ? <Badge variant="secondary">EDITING</Badge> : null}
				{canEdit ? (
					mode === "edit" ? (
						<>
							<Button
								size="sm"
								disabled={!editing || save.isPending}
								onClick={saveNow}
							>
								{save.isPending ? "Saving…" : "Save changes"}
							</Button>
							<Button size="sm" variant="outline" onClick={() => open(false)}>
								Stop editing
							</Button>
						</>
					) : (
						<Button size="sm" variant="outline" onClick={() => open(true)}>
							Edit text
						</Button>
					)
				) : (
					<span className="text-xs text-muted-foreground">
						{info.data.editProblem}
					</span>
				)}
				<Button size="sm" variant="ghost" onClick={() => open(mode === "edit")}>
					{expired ? "Reload (link expired)" : "Reload"}
				</Button>
			</div>
			{link.isError ? (
				<p className="text-xs text-destructive">{link.error.message}</p>
			) : null}
			{link.data ? (
				<iframe
					key={link.data.path}
					ref={frame}
					title={`Local copy of the demo for ${name}`}
					src={link.data.path}
					sandbox={LOCAL_FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					className="h-[65vh] w-full rounded-md border border-border bg-background"
				/>
			) : null}
			{mode === "edit" && !editing && ready ? (
				<p className="text-xs text-muted-foreground">
					Click Edit text again if editing does not start.
				</p>
			) : null}
			{editing ? (
				<p className="text-xs text-muted-foreground">
					Click any text in the demo and type, then Save changes.
				</p>
			) : null}
			{status ? <p className="text-xs">{status}</p> : null}
			{info.data.deployHint ? (
				<p className="text-[11px] text-muted-foreground">
					To publish a saved edit, run{" "}
					<code className="rounded bg-muted px-1">{info.data.deployHint}</code>{" "}
					with the Cloudflare credentials the nightly job uses. That changes the
					page leads already have a link to. Keeping the last{" "}
					{info.data.keepBackups} backups outside the demo folder.
				</p>
			) : null}
			<p className="text-[11px] text-muted-foreground">
				This copy runs inside a sandbox with no access to your CRM session. Some
				scripts on a demo may not work here.
			</p>
		</div>
	);
}
