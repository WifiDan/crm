"use client";

import { Badge } from "@crm/ui/components/badge";
import { poolLabel } from "./leadgen-format";

type Facts = {
	table: "isp" | "gym" | null;
	address: string | null;
	phone: string | null;
	service: string | null;
	contact: string | null;
	source: string | null;
	campaign: string | null;
	market: string | null;
	score: number | null;
	decision: string | null;
};

type Qa = { status: "PASS" | "FAIL" | "NONE"; failures: string[] };

export const CONTROL_CLASS =
	"h-8 rounded-md border border-border bg-background px-2 text-xs";

export function PoolBadge({ table }: { table: "isp" | "gym" | null }) {
	return <Badge variant="outline">{poolLabel(table)}</Badge>;
}

export function DecisionBadge({ decision }: { decision: string | null }) {
	if (decision === "Approved")
		return <Badge variant="secondary">Approved</Badge>;
	if (decision === "Rejected")
		return <Badge variant="destructive">Rejected</Badge>;
	return <Badge variant="outline">{decision ?? "undecided"}</Badge>;
}

export function ScoreBadge({ score }: { score: number | null }) {
	return score === null ? null : <Badge variant="outline">score {score}</Badge>;
}

export function QaBadge({ qa }: { qa: Qa }) {
	if (qa.status === "PASS") return <Badge variant="secondary">QA pass</Badge>;
	if (qa.status === "FAIL") return <Badge variant="destructive">QA fail</Badge>;
	return <Badge variant="outline">no QA</Badge>;
}

export function LeadFacts({ lead }: { lead: Facts }) {
	const rows: Array<[string, string | null]> = [
		["Pool", poolLabel(lead.table)],
		["Service", lead.service],
		["Address", lead.address],
		["Contact", lead.contact],
		["Phone", lead.phone],
		["Source", lead.source],
		["Campaign", lead.campaign],
		["Market", lead.market],
		["Score", lead.score === null ? null : String(lead.score)],
		["Decision", lead.decision ?? "undecided"],
	];
	return (
		<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
			{rows
				.filter(([, value]) => value !== null && value !== "")
				.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="min-w-0 break-words">{value}</dd>
					</div>
				))}
		</dl>
	);
}

export function NotesBlock({
	notes,
	truncated,
}: {
	notes: string;
	truncated: boolean;
}) {
	if (notes.trim() === "") {
		return <p className="text-xs text-muted-foreground">No notes on file.</p>;
	}
	return (
		<div className="flex flex-col gap-1">
			<div className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-xs">
				{notes}
			</div>
			{truncated ? (
				<p className="text-[11px] text-muted-foreground">
					Notes are cut here. The full text is in NocoDB.
				</p>
			) : null}
		</div>
	);
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
			{children}
		</h3>
	);
}
