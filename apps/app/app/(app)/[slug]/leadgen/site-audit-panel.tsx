"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { auditView } from "./site-audit-view";

export function SiteAuditPanel({ leadId }: { leadId: string }) {
	const trpc = useTRPC();
	const audit = useMutation(trpc.leadgenAudit.run.mutationOptions());
	const view = audit.data ? auditView(audit.data) : null;
	return (
		<div className="flex flex-col gap-2 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={audit.isPending}
					onClick={() => audit.mutate({ id: leadId })}
				>
					{audit.isPending ? "Auditing…" : "Audit their site"}
				</Button>
				<span className="text-muted-foreground">
					Scores how dated their site looks. Fetches only this lead's own
					website.
				</span>
			</div>
			{audit.isError ? (
				<p className="text-destructive">{audit.error.message}</p>
			) : null}
			{view ? (
				<div className="flex flex-col gap-1 rounded-md border border-border p-2">
					<Badge variant={view.tone} className="w-fit">
						{view.headline}
					</Badge>
					{view.empty ? (
						<p className="text-muted-foreground">{view.empty}</p>
					) : (
						<ul className="list-disc pl-4">
							{view.lines.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}
