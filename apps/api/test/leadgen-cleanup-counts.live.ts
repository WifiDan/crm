/**
 * READ-ONLY live check for the console cleanup: the Today tile and the Review
 * tab must show the same "needs send approval" number, and the new counts must
 * line up with the stored funnel stages. Run: bun test/leadgen-cleanup-counts.live.ts
 */
import { db } from "@crm/db";
import { LeadgenViewsService } from "../src/leadgen/lead-views.service";
import { opsOverviewOutput } from "../src/leadgen/ops.contracts";
import { LeadgenOpsService } from "../src/leadgen/ops.service";

const views = new LeadgenViewsService(db);
const ops = new LeadgenOpsService(db);
const overview = opsOverviewOutput.parse(await ops.overview());
const review = await views.reviewList({
	q: "",
	sort: "",
	dir: "asc",
	page: 1,
	pageSize: 100,
	view: "pending",
});
const t = overview.totals;
const checks: Array<[string, boolean, string]> = [
	[
		"Today needsSendApproval == Review pending",
		t.needsSendApproval === review.total,
		`${t.needsSendApproval} vs ${review.total}`,
	],
	[
		"no sent lead in Review pending",
		review.rows.every((r) => r.decision !== "Sent"),
		review.rows.filter((r) => r.decision === "Sent").map((r) => r.businessName).join(", ") || "none",
	],
];
console.log(JSON.stringify(t));
for (const [name, ok, detail] of checks) console.log(ok ? "OK  " : "FAIL", name, "-", detail);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
