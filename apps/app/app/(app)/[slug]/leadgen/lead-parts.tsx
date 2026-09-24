"use client";

import { Badge } from "@crm/ui/components/badge";
import { cn } from "@crm/ui/lib/utils";
import { poolLabel } from "./leadgen-format";
import {
	REVIEW_STATE,
	type ReviewState,
	stageInfo,
	TONE_CLASS,
	type Tone,
} from "./stage-labels";

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

/** Score 0 means "not scored yet", so it is not worth a chip. */
export function ScoreBadge({ score }: { score: number | null }) {
	return score === null || score === 0 ? null : (
		<Badge variant="outline">score {score}</Badge>
	);
}

/** Only PASS and FAIL are worth a chip; "no QA" was on every card. */
export function QaBadge({ qa }: { qa: Qa }) {
	if (qa.status === "PASS") return <Badge variant="secondary">QA pass</Badge>;
	if (qa.status === "FAIL") return <Badge variant="destructive">QA fail</Badge>;
	return null;
}

export function ToneBadge({
	tone,
	title,
	children,
}: {
	tone: Tone;
	title?: string;
	children: React.ReactNode;
}) {
	return (
		<Badge variant="outline" title={title} className={cn(TONE_CLASS[tone])}>
			{children}
		</Badge>
	);
}

export function StageBadge({ stage }: { stage: string | null }) {
	const info = stageInfo(stage);
	return (
		<ToneBadge tone={info.tone} title={info.meaning}>
			{info.label}
		</ToneBadge>
	);
}

export function ReviewStateBadge({ state }: { state: ReviewState }) {
	const info = REVIEW_STATE[state];
	return <ToneBadge tone={info.tone}>{info.label}</ToneBadge>;
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
		["Triage", lead.decision ?? "undecided"],
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

const CHECK_LINE = /\b(confirm|verify|redirect|parked|fail|warning|unverif)/i;

/** Quality notes are " | "-joined machine text; show one point per line. */
export function splitNotes(notes: string): string[] {
	return notes
		.split(/\s\|\s|\n+/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

export function NotesBlock({
	notes,
	truncated,
}: {
	notes: string;
	truncated: boolean;
}) {
	const lines = splitNotes(notes);
	if (lines.length === 0) {
		return <p className="text-xs text-muted-foreground">No notes on file.</p>;
	}
	return (
		<div className="flex flex-col gap-1">
			<ul className="flex max-h-64 flex-col gap-1 overflow-auto text-xs">
				{lines.map((line, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: note lines can repeat
						key={i}
						className={cn(
							"break-words rounded-md border px-2 py-1",
							CHECK_LINE.test(line)
								? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
								: "border-border bg-muted/30",
						)}
					>
						{line}
					</li>
				))}
			</ul>
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
