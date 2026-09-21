import { db } from "@crm/db";
import {
	campaignListOutput,
	leadDetailOutput,
	reviewListOutput,
	triageListOutput,
} from "../src/leadgen/lead-views.contracts";
import { LeadgenViewsService } from "../src/leadgen/lead-views.service";
import { MIRROR_TABLES } from "../src/leadgen/mirror-map";
import {
	opsCallListOutput,
	opsHealthOutput,
	opsOverviewOutput,
	opsRecentSendsOutput,
} from "../src/leadgen/ops.contracts";
import { LeadgenOpsService } from "../src/leadgen/ops.service";

const dbName = /\/([a-z_]+)(\?|$)/.exec(process.env.DATABASE_URL ?? "")?.[1];
if (dbName !== "crm_dev") {
	console.error(
		`refusing to run: DATABASE_URL points at "${dbName}", not crm_dev`,
	);
	process.exit(2);
}

const current = await db.$queryRaw<
	Array<{ name: string }>
>`SELECT current_database() AS name`;
if (current[0]?.name !== "crm_dev") {
	console.error(`refusing to run: connected database is "${current[0]?.name}"`);
	process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}

const ISP = MIRROR_TABLES.find((t) => t.key === "isp")?.tableId ?? "";
const GYM = MIRROR_TABLES.find((t) => t.key === "gym")?.tableId ?? "";
const PREFIX = "ZZ-views-";
const ROW_BASE = 9_000_000;
const COUNT = 1005;
const SEND_COUNT = 30;

type Fixture = {
	i: number;
	name: string;
	table: string;
	website: string | null;
	demo: string | null;
	decision: string | null;
	sendApproved: boolean;
	dnc: boolean;
	score: number | null;
	notes: string;
	email: string | null;
};

function fixture(i: number): Fixture {
	let demo: string | null = null;
	if (i % 7 === 0) demo = `https://zz-${i}.ei-leadgen-demos.pages.dev`;
	if (i % 50 === 0) demo = "file:///Volumes/Evo%20Drive/x/index.html";
	let notes = "plain notes";
	if (i % 13 === 0) notes = "[BUCKET: PLACEHOLDER - test]\nQA: FAIL - x";
	else if (i % 4 === 0) notes = "QA: FAIL - broken link\nQA: PASS";
	else if (i % 5 === 0) notes = "QA: FAIL - tel link empty";
	return {
		i,
		name: `${PREFIX}${String(i).padStart(4, "0")}`,
		table: i % 5 === 0 ? GYM : ISP,
		website: i % 2 === 0 ? `https://old-${i}.example.com` : null,
		demo,
		decision: ["Approved", "Rejected", null][i % 3] ?? null,
		sendApproved: i % 6 === 0,
		dnc: i % 11 === 0,
		score: i % 10 === 0 ? null : i % 100,
		notes,
		email: i % 4 === 0 ? `zz${i}@example.com` : null,
	};
}

const fixtures = Array.from({ length: COUNT }, (_, i) => fixture(i));
const isPagesDemo = (f: Fixture) => f.demo?.includes(".pages.dev") ?? false;
const isPlaceholder = (f: Fixture) => f.notes.includes("BUCKET: PLACEHOLDER");
const isProspect = (f: Fixture) =>
	f.demo === null && f.website !== null && !f.dnc;
const isGymRow = (f: Fixture) => f.table === GYM;

const inView = {
	pending: (f: Fixture) =>
		!isPlaceholder(f) &&
		(isGymRow(f)
			? f.decision !== "Approved" && f.decision !== "Rejected"
			: !f.sendApproved && f.decision !== "Rejected"),
	approved: (f: Fixture) =>
		!isPlaceholder(f) &&
		(isGymRow(f) ? f.decision === "Approved" : f.sendApproved),
	rejected: (f: Fixture) => !isPlaceholder(f) && f.decision === "Rejected",
	placeholder: (f: Fixture) => isPlaceholder(f),
	all: (f: Fixture) => !isPlaceholder(f),
};

async function cleanup() {
	const ids = (
		await db.lgLead.findMany({
			where: {
				businessName: { startsWith: PREFIX },
				nocodbRowId: { gte: ROW_BASE },
			},
			select: { id: true },
		})
	).map((l) => l.id);
	await db.lgOutreachSend.deleteMany({ where: { leadId: { in: ids } } });
	await db.lgLead.deleteMany({ where: { id: { in: ids } } });
}

async function seed() {
	await cleanup();
	await db.lgLead.createMany({
		data: fixtures.map((f) => ({
			businessName: f.name,
			nocodbTable: f.table,
			nocodbRowId: ROW_BASE + f.i,
			websiteUrl: f.website,
			demoUrl: f.demo,
			approvalDecision: f.decision,
			sendApproved: f.sendApproved,
			doNotContact: f.dnc,
			qualityScore: f.score,
			email: f.email,
			raw: {
				Id: ROW_BASE + f.i,
				Source: "ZZ",
				"Quality Notes": f.notes,
				...(f.email ? { Email: f.email } : {}),
			},
			mirroredAt: new Date(),
		})),
	});
	const first = await db.lgLead.findMany({
		where: { businessName: { startsWith: PREFIX } },
		orderBy: { nocodbRowId: "asc" },
		take: SEND_COUNT,
		select: { id: true, nocodbRowId: true },
	});
	await db.lgOutreachSend.createMany({
		data: first.map((l, n) => ({
			leadId: l.id,
			step: "INITIAL" as const,
			toAddr: `zz${n}@example.com`,
			subject: `ZZ subject ${n}`,
			sentAt: new Date(Date.UTC(2026, 8, 1, 14, n)),
			dedupeKey: `zz-views-${l.id}`,
			source: "zz-views-test",
		})),
	});
}

async function pageAll<T extends { id: string }>(
	fetchPage: (page: number) => Promise<{ rows: T[]; total: number }>,
) {
	const ids: string[] = [];
	let total = 0;
	for (let page = 1; page < 60; page++) {
		const res = await fetchPage(page);
		total = res.total;
		if (res.rows.length === 0) break;
		ids.push(...res.rows.map((r) => r.id));
	}
	return { ids, total };
}

const views = new LeadgenViewsService(db);
const ops = new LeadgenOpsService(db);
const base = { q: PREFIX, sort: "", dir: "asc" as const, pageSize: 100 };

try {
	await seed();
	const seeded = await db.lgLead.count({
		where: { businessName: { startsWith: PREFIX } },
	});
	check("fixture rows are in crm_dev", seeded === COUNT, `${seeded}`);

	const idOf = new Map(
		(
			await db.lgLead.findMany({
				where: { businessName: { startsWith: PREFIX } },
				select: { id: true, businessName: true },
			})
		).map((l) => [l.businessName, l.id]),
	);
	const idsFor = (list: Fixture[]) =>
		new Set(list.map((f) => idOf.get(f.name)));

	const prospects = fixtures.filter(isProspect);
	check(
		"fixture has more prospects than the old 200-row cap",
		prospects.length > 200,
		`${prospects.length}`,
	);

	const allPages = await pageAll((page) =>
		views.triageList({ ...base, page, decision: "all" }),
	);
	check(
		"triage: paging reaches every prospect, no gap and no repeat",
		allPages.ids.length === prospects.length &&
			new Set(allPages.ids).size === allPages.ids.length &&
			[...idsFor(prospects)].every((id) => allPages.ids.includes(id ?? "")),
		`${allPages.ids.length} of ${prospects.length}`,
	);
	check(
		"triage: total equals the fixture count",
		allPages.total === prospects.length,
		`${allPages.total}`,
	);

	for (const decision of ["undecided", "Approved", "Rejected"] as const) {
		const want = prospects.filter((f) =>
			decision === "undecided" ? f.decision === null : f.decision === decision,
		).length;
		const got = await views.triageList({ ...base, page: 1, decision });
		check(
			`triage: decision ${decision} total`,
			got.total === want,
			`${got.total} vs ${want}`,
		);
		check(
			`triage: decision ${decision} rows all match`,
			got.rows.every((r) =>
				decision === "undecided"
					? r.decision === null
					: r.decision === decision,
			),
		);
	}

	const facets = (
		await views.triageList({ ...base, page: 1, decision: "Approved" })
	).facetCounts;
	check(
		"triage: decision facet ignores the decision filter",
		facets.decision?.all === prospects.length &&
			facets.decision?.undecided ===
				prospects.filter((f) => f.decision === null).length,
		JSON.stringify(facets.decision),
	);
	check(
		"triage: pool facet adds up",
		(facets.table?.isp ?? 0) + (facets.table?.gym ?? 0) ===
			prospects.filter((f) => f.decision === "Approved").length,
		JSON.stringify(facets.table),
	);

	for (const [key, tableId] of [
		["isp", ISP],
		["gym", GYM],
	] as const) {
		const want = prospects.filter((f) => f.table === tableId).length;
		const got = await views.triageList({
			...base,
			page: 1,
			decision: "all",
			table: key,
		});
		check(
			`triage: pool ${key} total`,
			got.total === want,
			`${got.total} vs ${want}`,
		);
	}

	const byName = await views.triageList({
		...base,
		page: 1,
		decision: "all",
		sort: "businessName",
	});
	const names = byName.rows.map((r) => r.businessName);
	check(
		"triage: sort by name ascending",
		names.every((n, i) => i === 0 || (names[i - 1] ?? "") <= n),
	);
	const byScore = await views.triageList({ ...base, page: 1, decision: "all" });
	const scores = byScore.rows.map((r) => r.score);
	const firstNull = scores.indexOf(null);
	check(
		"triage: default sort is score ascending with empty scores last",
		scores
			.slice(0, firstNull < 0 ? scores.length : firstNull)
			.every((s, i, a) => i === 0 || (a[i - 1] ?? 0) <= (s ?? 0)) &&
			(firstNull < 0 || scores.slice(firstNull).every((s) => s === null)),
	);

	const beyond = await views.triageList({
		...base,
		page: 999,
		decision: "all",
	});
	check(
		"triage: a page past the end is empty and keeps the total",
		beyond.rows.length === 0 && beyond.total === prospects.length,
	);

	const hostile = await views.triageList({
		...base,
		q: "'; DROP TABLE lg_lead; --",
		page: 1,
		decision: "all",
	});
	check(
		"triage: hostile search text returns nothing and drops nothing",
		hostile.total === 0 && (await db.lgLead.count()) >= COUNT,
	);
	const wild = await views.triageList({
		...base,
		q: "%",
		page: 1,
		decision: "all",
	});
	check(
		"triage: a percent sign is searched literally",
		wild.total === 0,
		`${wild.total}`,
	);

	const reviewFixtures = fixtures.filter(isPagesDemo);
	check(
		"fixture has file:// demos that must not appear",
		fixtures.some((f) => f.demo?.startsWith("file:")),
	);
	const everything = await views.reviewList({ ...base, page: 1, view: "all" });
	check(
		"review: everything = placeholder + non-placeholder rows with a Pages demo",
		everything.facetCounts.view?.everything === reviewFixtures.length,
		`${everything.facetCounts.view?.everything} vs ${reviewFixtures.length}`,
	);

	for (const view of [
		"pending",
		"approved",
		"rejected",
		"placeholder",
		"all",
	] as const) {
		const want = reviewFixtures.filter(inView[view]);
		const got = await pageAll((page) =>
			views.reviewList({ ...base, page, pageSize: 10, view }),
		);
		check(
			`review: view ${view} pages to the exact set`,
			got.total === want.length &&
				got.ids.length === want.length &&
				new Set(got.ids).size === got.ids.length &&
				[...idsFor(want)].every((id) => got.ids.includes(id ?? "")),
			`${got.ids.length}/${got.total} vs ${want.length}`,
		);
		check(
			`review: facet count for ${view}`,
			everything.facetCounts.view?.[view] === want.length,
			`${everything.facetCounts.view?.[view]} vs ${want.length}`,
		);
	}

	const sample = reviewFixtures.find((f) => f.i % 4 === 0 && !isPlaceholder(f));
	if (sample) {
		const list = await views.reviewList({
			...base,
			q: sample.name,
			page: 1,
			view: "all",
		});
		const row = list.rows[0];
		check(
			"review: QA reads the last QA line and the demo URL is a safe Pages URL",
			list.rows.length === 1 &&
				row?.qa.status === "PASS" &&
				row.demoUrl === `${sample.demo}/`,
			JSON.stringify(row?.qa),
		);
	}
	const placeholder = reviewFixtures.find(isPlaceholder);
	if (placeholder) {
		const list = await views.reviewList({
			...base,
			q: placeholder.name,
			page: 1,
			view: "placeholder",
		});
		check(
			"review: placeholder row is flagged and its QA failure is kept",
			list.rows[0]?.placeholder === true && list.rows[0]?.qa.status === "FAIL",
		);
	}

	const detailId = idOf.get(`${PREFIX}0004`) ?? "";
	const detail = await views.leadDetail(detailId);
	check(
		"detail: returns the lead with its notes",
		detail?.businessName === `${PREFIX}0004` && detail.notes.includes("QA:"),
	);
	check(
		"detail: unknown id is null",
		(await views.leadDetail("no-such-id")) === null,
	);
	await db.lgLead.update({
		where: { id: detailId },
		data: { mirrorMissingAt: new Date() },
	});
	check(
		"detail: a lead missing from the mirror is null",
		(await views.leadDetail(detailId)) === null,
	);
	await db.lgLead.update({
		where: { id: detailId },
		data: { mirrorMissingAt: null },
	});

	const overview = await ops.overview();
	const activeAll = await db.lgLead.count({ where: { mirrorMissingAt: null } });
	check(
		"ops: total equals the mirrored table count",
		overview.totals.total === activeAll,
		`${overview.totals.total} vs ${activeAll}`,
	);
	check(
		"ops: pools add up to the total",
		overview.pools.reduce((n, p) => n + p.total, 0) === overview.totals.total,
	);
	check(
		"ops: sent equals rows with sentAt",
		overview.totals.sent ===
			(await db.lgLead.count({
				where: { mirrorMissingAt: null, sentAt: { not: null } },
			})),
	);
	check(
		"ops: source and decision bars add up to the total",
		Object.values(overview.bySource).reduce((a, b) => a + b, 0) === activeAll &&
			Object.values(overview.byDecision).reduce((a, b) => a + b, 0) ===
				activeAll,
	);

	const calls = fixtures.filter(
		(f) => f.decision === "Approved" && f.email === null,
	);
	const callAll = await pageAll((page) => ops.callList({ ...base, page }));
	check(
		"ops: call list pages to the exact set",
		callAll.total === calls.length &&
			callAll.ids.length === calls.length &&
			new Set(callAll.ids).size === callAll.ids.length,
		`${callAll.ids.length}/${callAll.total} vs ${calls.length}`,
	);

	const sends = await pageAll((page) =>
		ops.recentSends({ ...base, page, pageSize: 10 }),
	);
	check(
		"ops: recent sends page to the ledger rows",
		sends.total === SEND_COUNT && sends.ids.length === SEND_COUNT,
		`${sends.ids.length}/${sends.total}`,
	);
	const oneSend = await ops.recentSends({
		...base,
		q: "ZZ subject 7",
		page: 1,
	});
	check(
		"ops: recent sends filter by subject",
		oneSend.total === 1 && oneSend.rows[0]?.subject === "ZZ subject 7",
	);

	const health = await ops.health();
	check(
		"ops health: systemd answers and lists the lead-gen timers",
		health.systemd.available &&
			health.systemd.units.some((u) => u.name === "leadgen-daily-send.timer"),
		health.systemd.error ?? `${health.systemd.units.length} units`,
	);
	check(
		"ops health: health-state.json is read",
		health.checks.available && health.checks.items.length > 0,
		health.checks.error ?? `${health.checks.items.length}`,
	);
	check(
		"ops health: CRM sync files are read",
		health.crmSync.companyMap !== null && health.crmSync.dealQueue !== null,
		health.crmSync.error ?? "",
	);
	const contracts: Array<[string, () => Promise<unknown>]> = [
		[
			"triageList",
			async () =>
				triageListOutput.parse(
					await views.triageList({ ...base, page: 1, decision: "all" }),
				),
		],
		[
			"reviewList",
			async () =>
				reviewListOutput.parse(
					await views.reviewList({ ...base, page: 1, view: "all" }),
				),
		],
		[
			"leadDetail",
			async () => leadDetailOutput.parse(await views.leadDetail(detailId)),
		],
		[
			"campaigns",
			async () => campaignListOutput.parse(await views.campaigns()),
		],
		["opsOverview", async () => opsOverviewOutput.parse(await ops.overview())],
		["opsHealth", async () => opsHealthOutput.parse(await ops.health())],
		[
			"opsCallList",
			async () =>
				opsCallListOutput.parse(await ops.callList({ ...base, page: 1 })),
		],
		[
			"opsRecentSends",
			async () =>
				opsRecentSendsOutput.parse(await ops.recentSends({ ...base, page: 1 })),
		],
	];
	for (const [name, run] of contracts) {
		try {
			await run();
			check(`output contract: ${name} matches its zod schema`, true);
		} catch (error) {
			check(
				`output contract: ${name} matches its zod schema`,
				false,
				String(error).slice(0, 300),
			);
		}
	}
} finally {
	await cleanup();
	const left = await db.lgLead.count({
		where: { businessName: { startsWith: PREFIX } },
	});
	check("cleanup: no fixture rows left", left === 0, `${left}`);
	await db.$disconnect();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
