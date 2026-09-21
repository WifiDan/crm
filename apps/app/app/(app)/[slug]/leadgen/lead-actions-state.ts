export type ActionLead = {
	id: string;
	table: "isp" | "gym" | null;
	businessName: string;
	decision: string | null;
	decisionDate: string | null;
	version: string | null;
	sendApproved?: boolean;
	doNotContact?: boolean;
	email?: string | null;
	reworkRequested?: boolean;
};

export type AppliedChange = {
	leadId: string;
	decision: string | null;
	decisionDate: string | null;
	version: string | null;
	sendApproved: boolean | null;
	reworkRequested: boolean;
	appliedAt: string;
};

export function effectiveLead<T extends ActionLead>(
	lead: T,
	applied: AppliedChange | undefined,
): T {
	if (!applied || applied.leadId !== lead.id) return lead;
	if (lead.version && applied.version && lead.version >= applied.version)
		return lead;
	return {
		...lead,
		decision: applied.decision,
		decisionDate: applied.decisionDate,
		version: applied.version,
		sendApproved: applied.sendApproved ?? lead.sendApproved,
		reworkRequested: applied.reworkRequested,
	};
}

export function seenOf(lead: ActionLead) {
	return {
		updatedAt: lead.version ?? "",
		decision: lead.decision,
		decisionDate: lead.decisionDate,
	};
}

export function stateNote(applied: AppliedChange | undefined): string | null {
	if (!applied) return null;
	return `Saved to NocoDB at ${new Date(applied.appliedAt).toLocaleTimeString()}. This list shows it after the next mirror run.`;
}

export function armsOnApprove(
	stage: "triage" | "review",
	table: ActionLead["table"],
): boolean {
	return stage === "review" && table === "isp";
}

export function nextIdAfter(
	ids: readonly string[],
	currentId: string,
): string | null {
	const at = ids.indexOf(currentId);
	if (at < 0) return null;
	return ids[at + 1] ?? ids[at - 1] ?? null;
}
