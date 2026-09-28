import { createHash } from "node:crypto";
import { z } from "zod";

const text = z
	.union([z.string(), z.number()])
	.nullish()
	.transform((v) => {
		const s = v === null || v === undefined ? "" : String(v).trim();
		return s === "" ? null : s;
	});

const truthy = z.union([z.boolean(), z.number(), z.string()]).nullish();

const flag = truthy.transform((v) => v === true || v === 1 || v === "true");

const optionalFlag = truthy.transform((v) =>
	v === null || v === undefined ? null : v === true || v === 1 || v === "true",
);

const instant = text.transform((s) => {
	if (!s) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
});

const whole = z
	.union([z.number(), z.string()])
	.nullish()
	.transform((v) => {
		if (v === null || v === undefined || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	});

/**
 * The columns the mirror understands, across BOTH NocoDB lead tables. The
 * NocoDB response is parsed against this at the boundary; anything it does not
 * name is ignored here but is still preserved verbatim in lg_lead.raw.
 */
export const nocoRowSchema = z.object({
	Id: z.number(),
	Source: text,
	Phone: text,
	Email: text,
	"Contact Email": text,
	"Quality Score": whole,
	"Has Website": optionalFlag,
	"Approval Decision": text,
	"Send Approved": flag,
	"Do Not Contact": flag,
	"Sent At": instant,
	"Replied At": instant,
	"Hot Lead": flag,
	"Business Name": text,
	Address: text,
	"Website URL": text,
	"Demo Site URL": text,
	"Gym Name": text,
	"Address / Location": text,
	"Old Site URL": text,
	"Demo/New Site URL": text,
});

export type NocoRow = z.infer<typeof nocoRowSchema>;

const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;

export const rawRowSchema = z.record(z.string(), jsonSchema);
export type RawRow = z.infer<typeof rawRowSchema>;

type NameField = "Business Name" | "Gym Name";
type AddressField = "Address" | "Address / Location";
type WebsiteField = "Website URL" | "Old Site URL";
type DemoField = "Demo Site URL" | "Demo/New Site URL";

export type MirrorTable = {
	key: "isp" | "gym";
	tableId: string;
	nameField: NameField;
	addressField: AddressField;
	websiteField: WebsiteField;
	demoField: DemoField;
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

export type LgStage =
	| "NEW"
	| "APPROVED"
	| "REJECTED"
	| "BUILT"
	| "READY"
	| "SENT"
	| "REPLIED"
	| "DEAD";

/** Best-effort funnel stage. `raw` stays the source of truth; this is a view. */
export function deriveStage(row: NocoRow, table: MirrorTable): LgStage {
	if (row["Do Not Contact"]) return "DEAD";
	if (row["Replied At"]) return "REPLIED";
	if (row["Sent At"]) return "SENT";
	const decision = row["Approval Decision"];
	if (decision === "Rejected") return "REJECTED";
	if (row["Send Approved"]) return "READY";
	if (decision === "Approved" && row[table.demoField]) return "BUILT";
	if (decision === "Approved") return "APPROVED";
	return "NEW";
}

/** Stable across key order so an unchanged row hashes identically every run. */
export function stableStringify(value: Json): string {
	const list = z.array(jsonSchema).safeParse(value);
	if (list.success) return `[${list.data.map(stableStringify).join(",")}]`;
	const dict = rawRowSchema.safeParse(value);
	if (dict.success) {
		const entries = Object.entries(dict.data).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${entries
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function hashRow(row: RawRow): string {
	return createHash("sha256").update(stableStringify(row)).digest("hex");
}

export function toLeadFields(row: NocoRow, table: MirrorTable) {
	return {
		businessName: row[table.nameField] ?? "(unnamed)",
		address: row[table.addressField],
		phone: row.Phone,
		email: row.Email ?? row["Contact Email"],
		websiteUrl: row[table.websiteField],
		demoUrl: row[table.demoField],
		hasWebsite: row["Has Website"],
		qualityScore: row["Quality Score"],
		stage: deriveStage(row, table),
		approvalDecision: row["Approval Decision"],
		sendApproved: row["Send Approved"],
		doNotContact: row["Do Not Contact"],
		sentAt: row["Sent At"],
		repliedAt: row["Replied At"],
		hotLead: row["Hot Lead"],
	};
}
