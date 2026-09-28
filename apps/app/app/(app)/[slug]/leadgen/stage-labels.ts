/**
 * One vocabulary for the whole Lead Gen console. The stored `stage` column
 * (derived at mirror time) is the funnel; these are the words shown for it.
 */
export const LEAD_STAGE_ORDER = [
	"NEW",
	"APPROVED",
	"BUILT",
	"READY",
	"SENT",
	"REPLIED",
	"REJECTED",
	"DEAD",
] as const;

export type LeadStage = (typeof LEAD_STAGE_ORDER)[number];

export type Tone = "neutral" | "waiting" | "good" | "info" | "bad" | "muted";

export const STAGE_INFO: Record<
	LeadStage,
	{ label: string; meaning: string; tone: Tone }
> = {
	NEW: {
		label: "New",
		meaning: "Not triaged yet",
		tone: "neutral",
	},
	APPROVED: {
		label: "Awaiting build",
		meaning: "Triage said yes; the nightly build makes the demo",
		tone: "waiting",
	},
	BUILT: {
		label: "Needs review",
		meaning: "Demo built; waiting for your send approval",
		tone: "waiting",
	},
	READY: {
		label: "Send-approved",
		meaning: "Approved for sending; goes out at 08:30 if it has an email",
		tone: "good",
	},
	SENT: { label: "Sent", meaning: "Outreach email sent", tone: "info" },
	REPLIED: { label: "Replied", meaning: "They wrote back", tone: "good" },
	REJECTED: { label: "Rejected", meaning: "Not pursuing", tone: "bad" },
	DEAD: {
		label: "Dead",
		meaning: "Opted out, bounced or closed",
		tone: "muted",
	},
};

export function stageInfo(stage: string | null | undefined) {
	return stage && stage in STAGE_INFO
		? STAGE_INFO[stage as LeadStage]
		: { label: stage ?? "Unknown", meaning: "", tone: "neutral" as Tone };
}

export const TONE_CLASS: Record<Tone, string> = {
	neutral: "border-border text-foreground",
	waiting:
		"border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	info: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
	bad: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
	muted: "border-border text-muted-foreground",
};

/** Where a demo stands in Review, in one word pair. */
export type ReviewState =
	| "needs-approval"
	| "send-approved"
	| "rejected"
	| "sent"
	| "rework"
	| "placeholder";

export const REVIEW_STATE: Record<ReviewState, { label: string; tone: Tone }> =
	{
		"needs-approval": { label: "needs send approval", tone: "waiting" },
		"send-approved": { label: "send approved", tone: "good" },
		rejected: { label: "rejected", tone: "bad" },
		sent: { label: "sent", tone: "info" },
		rework: { label: "rework requested", tone: "waiting" },
		placeholder: { label: "placeholder", tone: "muted" },
	};

export function reviewStateOf(row: {
	decision: string | null;
	sendApproved?: boolean | null;
	placeholder?: boolean;
	reworkRequested?: boolean;
	table?: "isp" | "gym" | null;
}): ReviewState {
	if (row.placeholder) return "placeholder";
	if (row.reworkRequested) return "rework";
	if (row.decision === "Sent") return "sent";
	if (row.decision === "Rejected") return "rejected";
	if (row.sendApproved) return "send-approved";
	if (row.table === "gym" && row.decision === "Approved")
		return "send-approved";
	return "needs-approval";
}
