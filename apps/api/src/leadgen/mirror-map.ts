import { createHash } from "node:crypto";

export type LgStage =
	| "NEW"
	| "APPROVED"
	| "REJECTED"
	| "BUILT"
	| "READY"
	| "SENT"
	| "REPLIED"
	| "DEAD";

export type NocoRow = Record<string, unknown>;

export type MirrorTable = {
	key: "isp" | "gym";
	tableId: string;
	nameField: string;
	addressField: string;
	websiteField: string;
	demoField: string;
};

export const MIRROR_TABLES: MirrorTable[] = [
	{
		key: "isp",
		tableId: "m8j68gaadph8fam",
		nameField: "Business Name",
		addressField: "Address",
		websiteField: "Website URL",
		demoField: "Demo Site URL",
	},
	{
		key: "gym",
		tableId: "mdgak4p9gi5oib4",
		nameField: "Gym Name",
		addressField: "Address / Location",
		websiteField: "Old Site URL",
		demoField: "Demo/New Site URL",
	},
];

function str(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = String(v).trim();
	return s === "" ? null : s;
}

function bool(v: unknown): boolean {
	return v === true || v === 1 || v === "true";
}

export function toDate(v: unknown): Date | null {
	const s = str(v);
	if (!s) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Best-effort funnel stage. `raw` stays the source of truth; this is a view. */
export function deriveStage(row: NocoRow, table: MirrorTable): LgStage {
	if (bool(row["Do Not Contact"])) return "DEAD";
	if (toDate(row["Replied At"])) return "REPLIED";
	if (toDate(row["Sent At"])) return "SENT";
	const decision = str(row["Approval Decision"]);
	if (decision === "Rejected") return "REJECTED";
	if (bool(row["Send Approved"])) return "READY";
	if (decision === "Approved" && str(row[table.demoField])) return "BUILT";
	if (decision === "Approved") return "APPROVED";
	return "NEW";
}

/** Stable across key order so an unchanged row hashes identically every run. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(",")}}`;
}

export function hashRow(row: NocoRow): string {
	return createHash("sha256").update(stableStringify(row)).digest("hex");
}

export function toLeadFields(row: NocoRow, table: MirrorTable) {
	return {
		businessName: str(row[table.nameField]) ?? "(unnamed)",
		address: str(row[table.addressField]),
		phone: str(row.Phone),
		email: str(row.Email) ?? str(row["Contact Email"]),
		websiteUrl: str(row[table.websiteField]),
		demoUrl: str(row[table.demoField]),
		hasWebsite:
			row["Has Website"] === null || row["Has Website"] === undefined
				? null
				: bool(row["Has Website"]),
		qualityScore: num(row["Quality Score"]),
		stage: deriveStage(row, table),
		approvalDecision: str(row["Approval Decision"]),
		sendApproved: bool(row["Send Approved"]),
		doNotContact: bool(row["Do Not Contact"]),
		sentAt: toDate(row["Sent At"]),
		repliedAt: toDate(row["Replied At"]),
		hotLead: bool(row["Hot Lead"]),
	};
}
