import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

const identity = {
	id: "lead-1",
	table: "isp",
	nocodbRowId: 12,
	businessName: "Alpha Plumbing",
	address: "1 Main St, Collbran CO",
	phone: "970-555-0100",
	oldSite: "https://old-alpha.example.com/",
	score: 22,
	decision: null,
	source: "Google Places",
	service: "Plumber",
	contact: "Pat",
	campaign: "ISP facelift",
	market: null,
};

const reviewRow = {
	...identity,
	demoUrl: "https://alpha.ei-leadgen-demos.pages.dev/",
	slug: "alpha",
	sendApproved: false,
	qa: { status: "FAIL", failures: ["broken link: tel:"] },
	placeholder: false,
	hasDraft: true,
	reworkRequested: false,
	build: "v2",
	updatedAt: "2026-09-20T12:00:00.000Z",
};

const detail = {
	...identity,
	email: "pat@alpha.example.com",
	demoUrl: "https://alpha.ei-leadgen-demos.pages.dev/",
	notes: "QA: FAIL - broken link: tel:",
	notesTruncated: false,
	draftSubject: "Your new site",
	draftBody: "Hello Pat",
	qa: { status: "FAIL", failures: ["broken link: tel:"] },
	placeholder: false,
	sendApproved: false,
	doNotContact: false,
	dncReason: null,
	hotLead: false,
	sentAt: null,
	repliedAt: null,
	reworkNotes: null,
	reworkRequestedAt: null,
	updatedAt: "2026-09-20T12:00:00.000Z",
};

const totals = {
	total: 992,
	pendingTriage: 0,
	sideBySideBuilt: 258,
	sent: 115,
	replied: 9,
	awaitingReview: 12,
	readyToSend: 8,
	callText: 333,
	doNotContact: 83,
};

const unit = {
	name: "leadgen-daily-send.timer",
	kind: "timer",
	description: "Run daily sender",
	activeState: "active",
	subState: "waiting",
	result: "success",
	exitStatus: 0,
	lastExitAt: null,
	lastTriggerAt: "2026-09-20T14:30:52.000Z",
	nextRunAt: "2026-09-21T14:30:00.000Z",
};

const failedUnit = {
	...unit,
	name: "leadgen-review-server.service",
	kind: "service",
	activeState: "failed",
	subState: "failed",
	result: "exit-code",
};

const FIXTURES: Record<string, unknown> = {
	mirrorStatus: {
		tables: [
			{
				table: "isp",
				mirroredActive: 757,
				missingFromSource: 0,
				lastRunSource: 757,
				inSync: true,
			},
		],
		lastRunAt: new Date().toISOString(),
		lastRunStatus: "OK",
	},
	jobs: {
		schedulerEnabled: true,
		jobs: [{ name: "nocodb.mirror", lastStatus: "OK" }],
	},
	alerts: [],
	campaigns: [{ id: "c1", name: "ISP facelift", status: "active" }],
	markets: [
		{
			id: "m1",
			name: "Montrose",
			kind: "GEO",
			status: "ACTIVE",
			leadCount: 8,
			dailyProspectCap: 25,
		},
	],
	triageList: {
		rows: [],
		total: 0,
		facetCounts: {
			decision: { Approved: 288, Rejected: 203, all: 491 },
			table: { isp: 318, gym: 173 },
		},
	},
	reviewList: {
		rows: [reviewRow],
		total: 1,
		facetCounts: {
			view: {
				pending: 22,
				approved: 214,
				rejected: 0,
				placeholder: 12,
				all: 239,
				everything: 251,
			},
		},
	},
	leadDetail: detail,
	opsOverview: {
		generatedAt: "2026-09-20T15:00:00.000Z",
		totals,
		pools: [
			{ table: "isp", ...totals },
			{ table: "gym", ...totals },
		],
		dailySends: [{ date: "2026-09-20", count: 10 }],
		prospectorYield: [],
		bySource: { "Google Places": 921 },
		byDecision: { Approved: 523, pending: 172 },
		rework: { total: 0, rows: [] },
		standing: {
			available: true,
			error: null,
			items: [{ id: "a", text: "Pricing story", since: "2026-07-18" }],
		},
	},
	opsHealth: {
		generatedAt: "2026-09-20T15:00:00.000Z",
		systemd: { available: true, error: null, units: [unit, failedUnit] },
		checks: {
			available: true,
			error: null,
			items: [{ name: "daily send ran", ok: true, detail: "ok", since: null }],
		},
		crmSync: {
			companyMap: { entries: 10, updatedAt: "2026-09-20T14:00:00.000Z" },
			dealQueue: { pending: 1, updatedAt: "2026-09-20T14:00:00.000Z" },
			error: null,
		},
	},
	opsCallList: {
		rows: [
			{
				id: "x",
				table: "gym",
				businessName: "Gym One",
				phone: "970-555-0101",
				contact: null,
			},
		],
		total: 1,
		facetCounts: {},
	},
	opsRecentSends: {
		rows: [
			{
				id: "s",
				leadId: "l",
				businessName: "Alpha Plumbing",
				toAddr: "pat@alpha.example.com",
				subject: "Your new site",
				step: "INITIAL",
				sentAt: "2026-09-20T14:30:00.000Z",
				replied: true,
				source: "python-send-log",
			},
		],
		total: 1,
		facetCounts: {},
	},
};

function node(path: string[]): unknown {
	return new Proxy(() => undefined, {
		get: (_t, key: string) => {
			if (key === "queryOptions") {
				const name = path[path.length - 1] ?? "";
				return (input?: unknown) => ({
					queryKey: [...path, input ?? null],
					queryFn: async () => FIXTURES[name],
					initialData: FIXTURES[name],
				});
			}
			return node([...path, key]);
		},
	});
}

mock.module("@/lib/trpc/client", () => ({ useTRPC: () => node([]) }));

const { LeadgenConsole } = await import(
	"../app/(app)/[slug]/leadgen/leadgen-console"
);
const { TriageTab } = await import("../app/(app)/[slug]/leadgen/triage-tab");
const { ReviewTab, DemoDetail } = await import(
	"../app/(app)/[slug]/leadgen/review-tab"
);
const { OpsTab } = await import("../app/(app)/[slug]/leadgen/ops-tab");

function html(element: React.ReactElement): string {
	const client = new QueryClient();
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>{element}</QueryClientProvider>,
	);
}

describe("console", () => {
	const out = html(<LeadgenConsole />);

	test("opens on Ops and lists every tab, with the row allowed to scroll on a phone", () => {
		for (const tab of [
			"Ops",
			"Triage",
			"Review",
			"Replies",
			"Jobs",
			"Leads",
			"Markets",
			"Alerts",
		]) {
			expect(out).toContain(`>${tab}</button>`);
		}
		expect(out).toContain("overflow-x-auto");
		expect(out).toContain("Total leads");
	});
});

describe("Triage", () => {
	const out = html(<TriageTab />);

	test("says there is nothing left to triage instead of showing a blank list", () => {
		expect(out).toContain("Nothing left to triage");
		expect(out).toContain("288 approved, 203 rejected");
		expect(out).toContain("0 of 491 prospects");
	});

	test("shows the mirror age and the decision counts", () => {
		expect(out).toContain("Data from the NocoDB mirror");
		expect(out).toContain("Approved (288)");
		expect(out).toContain("All (491)");
	});

	test("stacks the list above the detail on a phone and pairs them on a wide screen", () => {
		expect(out).toContain("lg:grid-cols-");
	});
});

describe("Review", () => {
	const out = html(<ReviewTab />);

	test("lists the demo with its QA state and build kind", () => {
		expect(out).toContain("Alpha Plumbing");
		expect(out).toContain("QA fail");
		expect(out).toContain("v2 facelift");
	});

	test("shows view counts that include the placeholder hold and the total", () => {
		expect(out).toContain("Pending (22)");
		expect(out).toContain("Placeholder (12)");
		expect(out).toContain("251 built demos");
	});

	test("hides the list behind the detail only when a demo is open", () => {
		expect(out).toContain("xl:grid-cols-");
		expect(out).not.toContain("hidden xl:flex");
	});
});

describe("Review detail, side by side and narrow", () => {
	const out = html(
		<DemoDetail
			id="lead-1"
			row={reviewRow as never}
			hasPrev={false}
			hasNext={true}
			onPrev={() => undefined}
			onNext={() => undefined}
			onBack={() => undefined}
		/>,
	);

	test("has a toggle that only shows on a narrow screen", () => {
		expect(out).toContain("flex gap-1 lg:hidden");
		expect(out).toContain(">New demo</button>");
		expect(out).toContain(">Their site</button>");
	});

	test("shows both panes side by side on a wide screen, old first, and one at a time when narrow", () => {
		expect(out).toContain("lg:grid-cols-2");
		expect(out.indexOf("Their current site")).toBeLessThan(
			out.indexOf("New demo</h3>"),
		);
		expect(out).toContain("hidden lg:block");
	});

	test("frames the Cloudflare demo in a sandbox and does not frame the old site by default", () => {
		const frames = out.match(/<iframe[^>]*>/g) ?? [];
		expect(frames.length).toBe(1);
		expect(frames[0]).toContain(
			'src="https://alpha.ei-leadgen-demos.pages.dev/"',
		);
		expect(frames[0]).toContain(
			'sandbox="allow-scripts allow-same-origin allow-popups allow-forms"',
		);
		expect(frames[0]).not.toContain("allow-top-navigation");
		expect(frames[0]).not.toContain("old-alpha");
	});

	test("links out to the old site itself", () => {
		expect(out).toContain('href="https://old-alpha.example.com/"');
		expect(out).toContain("Their current site");
	});

	test("keeps decisions out of Slice 1", () => {
		for (const word of [">Approve<", ">Reject<", ">Rework<", ">Verify<"]) {
			expect(out).not.toContain(word);
		}
		expect(out).toContain("still done in the old dashboard");
	});

	test("shows the QA failure and marks the draft as not sent", () => {
		expect(out).toContain("broken link: tel:");
		expect(out).toContain("Not sent, draft only");
	});
});

describe("Ops", () => {
	const out = html(<OpsTab onNavigate={() => undefined} />);

	test("shows the tiles with the same numbers the old dashboard shows", () => {
		for (const [label, value] of [
			["Total leads", "992"],
			["Demos built", "258"],
			["Ready to send", "8"],
			["Sent", "115"],
			["Call / text list", "333"],
		]) {
			expect(out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(
				`${value} ${label}`,
			);
		}
	});

	test("puts a failing unit first and flags it", () => {
		expect(out.indexOf("leadgen-review-server.service")).toBeLessThan(
			out.indexOf("leadgen-daily-send.timer"),
		);
		expect(out).toContain("failed/failed");
	});

	test("shows standing items, health checks, and the CRM sync files", () => {
		expect(out).toContain("Pricing story");
		expect(out).toContain("daily send ran");
		expect(out).toContain("1 pending");
	});

	test("the wide tables scroll sideways instead of breaking the page", () => {
		expect(out).toContain("overflow-x-auto");
	});
});
