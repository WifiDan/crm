"use client";

import { Button } from "@crm/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTRPC } from "@/lib/trpc/client";

export function SiteShot({ leadId, name }: { leadId: string; name: string }) {
	const trpc = useTRPC();
	const status = useQuery(
		trpc.leadgenShots.status.queryOptions({ id: leadId }),
	);
	const capture = useMutation({
		...trpc.leadgenShots.capture.mutationOptions(),
		onSuccess: () => {
			void status.refetch();
		},
	});
	const tried = useRef(false);
	const data = status.data;

	useEffect(() => {
		if (!data || tried.current) return;
		tried.current = true;
		if (data.available && !data.cached)
			capture.mutate({ id: leadId, force: false });
	}, [data, leadId, capture]);

	if (status.isPending)
		return (
			<p className="text-xs text-muted-foreground">
				Checking for a screenshot…
			</p>
		);
	if (status.isError)
		return <p className="text-xs text-destructive">{status.error.message}</p>;
	if (!data?.available)
		return (
			<p className="text-xs text-muted-foreground">
				{data?.unavailableReason ?? "Screenshots are not available."} Use Open
				their site.
			</p>
		);
	return (
		<div className="flex flex-col gap-2 text-xs">
			{capture.isPending ? (
				<p className="text-muted-foreground">
					Taking a picture of their site… a few seconds.
				</p>
			) : null}
			{capture.isError ? (
				<p className="text-destructive">
					{capture.error.message} Use Open their site.
				</p>
			) : null}
			{capture.data?.note ? (
				<p className="text-muted-foreground">{capture.data.note}</p>
			) : null}
			{data.cached && data.capturedAt ? (
				<>
					{/* biome-ignore lint/performance/noImgElement: same-origin cached PNG, not an optimizable asset */}
					<img
						src={`/api/leadgen/shot/${encodeURIComponent(leadId)}?v=${encodeURIComponent(data.capturedAt)}`}
						alt={`Screenshot of ${name}'s current site`}
						className="max-h-[60vh] w-full overflow-auto rounded-md border border-border object-top"
					/>
					<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
						<span>
							Screenshot of their live site, taken{" "}
							{new Date(data.capturedAt).toLocaleString()}
							{data.stale ? " (older than 14 days)" : ""}.
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={capture.isPending}
							onClick={() => capture.mutate({ id: leadId, force: true })}
						>
							Re-capture
						</Button>
					</div>
				</>
			) : null}
			{!data.cached && !capture.isPending && !capture.isError ? (
				<Button
					size="sm"
					variant="outline"
					className="w-fit"
					onClick={() => capture.mutate({ id: leadId, force: false })}
				>
					Take a screenshot
				</Button>
			) : null}
		</div>
	);
}
