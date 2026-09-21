export const LOCAL_FRAME_SANDBOX = "allow-scripts";

export type BridgeEvent =
	| { type: "ready" }
	| { type: "edit-state"; on: boolean }
	| { type: "html"; nonce: string; html: string };

export function acceptBridgeMessage(
	event: { source: unknown; data: unknown },
	frameWindow: unknown,
): BridgeEvent | null {
	if (!frameWindow || event.source !== frameWindow) return null;
	const data = event.data as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || data.leadgen !== 1) return null;
	if (data.type === "ready") return { type: "ready" };
	if (data.type === "edit-state" && typeof data.on === "boolean")
		return { type: "edit-state", on: data.on };
	if (
		data.type === "html" &&
		typeof data.nonce === "string" &&
		typeof data.html === "string"
	)
		return { type: "html", nonce: data.nonce, html: data.html };
	return null;
}

export function linkExpired(expiresAt: string, nowMs: number): boolean {
	return new Date(expiresAt).getTime() <= nowMs;
}

export type LastEdit = {
	at: string;
	by: string | null;
	backupName: string;
	status: "PENDING" | "APPLIED" | "FAILED" | "UNKNOWN";
} | null;

export function localStatusLine(
	saved: { savedAt: string; backupName: string } | null,
	last: LastEdit,
): string | null {
	if (saved)
		return `Saved locally at ${new Date(saved.savedAt).toLocaleTimeString()}. Not live yet: the Cloudflare copy that leads see changes only when the demo is deployed. Backup: ${saved.backupName}.`;
	if (last && last.status === "APPLIED")
		return `Last saved locally ${new Date(last.at).toLocaleString()}${last.by ? ` by ${last.by}` : ""}. This page cannot tell whether it was deployed since, so treat it as not confirmed live. Backup: ${last.backupName}.`;
	if (last && last.status !== "FAILED")
		return `A save on ${new Date(last.at).toLocaleString()} has an unknown result. Check the file before editing again.`;
	return null;
}
