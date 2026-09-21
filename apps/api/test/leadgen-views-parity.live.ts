import { db } from "@crm/db";
import { LeadgenViewsService } from "../src/leadgen/lead-views.service";

const oldBase = process.env.PARITY_OLD_BASE ?? "http://100.78.149.77:8767";

type OldProspect = { id: number; table: string; decision: string | null };
type OldLead = {
	id: number;
	table: string;
	decision: string | null;
	sendApproved: boolean;
	isPlaceholder: boolean;
};

async function oldJson<T>(path: string): Promise<T> {
	const res = await fetch(`${oldBase}${path}`);
	if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	const body = (await res.json()) as T & { error?: string };
	if (body.error) throw new Error(`${path}: ${body.error}`);
	return body;
}

let failures = 0;
const canonical = (value: unknown) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort())
			: item,
	);

function report(label: string, oldValue: unknown, newValue: unknown) {
	const same = canonical(oldValue) === canonical(newValue);
	console.log(
		`${same ? "MATCH" : "DIFF "}  ${label}: old=${JSON.stringify(oldValue)} crm=${JSON.stringify(newValue)}`,
	);
	if (!same) failures++;
}

const tally = (values: string[]) => {
	const out: Record<string, number> = {};
	for (const v of values.sort()) out[v] = (out[v] ?? 0) + 1;
	return out;
};

const views = new LeadgenViewsService(db);
const base = { q: "", sort: "", dir: "asc" as const, pageSize: 100 };

async function crmKeys<
	T extends { table: string | null; nocodbRowId: number | null },
>(fetchPage: (page: number) => Promise<{ rows: T[]; total: number }>) {
	const keys: string[] = [];
	const rows: T[] = [];
	for (let page = 1; page < 100; page++) {
		const res = await fetchPage(page);
		if (res.rows.length === 0) break;
		for (const r of res.rows) {
			keys.push(`${r.table}:${r.nocodbRowId}`);
			rows.push(r);
		}
	}
	return { keys: keys.sort(), rows };
}

const mirror = await db.lgJobRun.findFirst({
	where: { job: { name: "nocodb.mirror" }, status: "OK" },
	orderBy: { startedAt: "desc" },
	select: { finishedAt: true },
});
console.log(
	`last OK mirror run finished ${mirror?.finishedAt?.toISOString() ?? "never"}`,
);

const oldProspects = (
	await oldJson<{ prospects: OldProspect[] }>("/api/prospects")
).prospects;
const oldLeads = (await oldJson<{ leads: OldLead[] }>("/api/leads")).leads;

const triage = await crmKeys((page) =>
	views.triageList({ ...base, page, decision: "all" }),
);
const review = await crmKeys((page) =>
	views.reviewList({ ...base, page, view: "all" }),
);
const reviewPlaceholder = await crmKeys((page) =>
	views.reviewList({ ...base, page, view: "placeholder" }),
);
const reviewCounts = (await views.reviewList({ ...base, page: 1, view: "all" }))
	.facetCounts;
const triageCounts = (
	await views.triageList({ ...base, page: 1, decision: "all" })
).facetCounts;

console.log(
	`TRIAGE  old /api/prospects = ${oldProspects.length}   CRM triage total = ${triage.keys.length}`,
);
console.log(
	`REVIEW  old /api/leads     = ${oldLeads.length}   CRM review everything = ${reviewCounts.view?.everything} (non-placeholder ${reviewCounts.view?.all} + placeholder ${reviewCounts.view?.placeholder})`,
);

report("prospects count", oldProspects.length, triage.keys.length);
report(
	"prospects by row",
	oldProspects.map((p) => `${p.table}:${p.id}`).sort(),
	triage.keys,
);
report(
	"prospects by decision",
	tally(oldProspects.map((p) => p.decision ?? "undecided")),
	Object.fromEntries(
		Object.entries(triageCounts.decision ?? {}).filter(([k]) => k !== "all"),
	),
);
report("leads count", oldLeads.length, reviewCounts.view?.everything);
report(
	"leads by row",
	oldLeads.map((l) => `${l.table}:${l.id}`).sort(),
	[...review.keys, ...reviewPlaceholder.keys].sort(),
);
report(
	"placeholder leads",
	oldLeads.filter((l) => l.isPlaceholder).length,
	reviewCounts.view?.placeholder,
);
const oldPending = oldLeads.filter(
	(l) =>
		!l.isPlaceholder &&
		(l.table === "gym"
			? l.decision !== "Approved" && l.decision !== "Rejected"
			: !l.sendApproved && l.decision !== "Rejected"),
).length;
report("pending view", oldPending, reviewCounts.view?.pending);
const oldApproved = oldLeads.filter(
	(l) =>
		!l.isPlaceholder &&
		(l.table === "gym" ? l.decision === "Approved" : l.sendApproved),
).length;
report("approved view", oldApproved, reviewCounts.view?.approved);

await db.$disconnect();
console.log(
	failures === 0 ? "PARITY: ALL MATCH" : `PARITY: ${failures} DIFFER`,
);
process.exit(failures === 0 ? 0 : 1);
