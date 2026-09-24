import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	version: "2026-09-20 14:31:07+00:00",
	decisionDate: null,
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
	awaitingBuild: 285,
	needsSendApproval: 22,
	sendApprovedUnsent: 87,
	newNoWebsite: 159,
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

const approver = {
	youAreApprover: true,
	approversConfigured: true,
	writeConfigured: true,
	writeProblem: null,
	tokenSource: "shared-with-mirror",
};

const FIXTURES: Record<string, unknown> = {
	status: approver,
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
	list: { items: [] },
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
	"leadgenShots.status": {
		available: true,
		unavailableReason: null,
		cached: true,
		capturedAt: "2026-09-21T10:00:00.000Z",
		stale: false,
		url: "https://old-alpha.example.com/",
	},
	"leadgenDemos.info": {
		hasLocal: true,
		slug: "alpha-demo",
		reason: null,
		bytes: 1000,
		sha256: "a".repeat(64),
		modifiedAt: "2026-09-20T10:00:00.000Z",
		canEdit: true,
		editProblem: null,
		keepBackups: 10,
		lastEdit: null,
		deployHint:
			"cd /data/leadgen/site-generator && bash deploy-demo.sh alpha-demo",
	},
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
				const scoped = path.slice(-2).join(".");
				const data = scoped in FIXTURES ? FIXTURES[scoped] : FIXTURES[name];
				return (input?: unknown) => ({
					queryKey: [...path, input ?? null],
					queryFn: async () => data,
					initialData: data,
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
const { SystemTab } = await import("../app/(app)/[slug]/leadgen/system-tab");
const { LocalDemoPane } = await import(
	"../app/(app)/[slug]/leadgen/demo-local-pane"
);
const { SiteShot } = await import(
	"../app/(app)/[slug]/leadgen/site-shot-panel"
);

import type { ActionLead } from "../app/(app)/[slug]/leadgen/lead-actions-state";

const { LeadActions } = await import(
	"../app/(app)/[slug]/leadgen/lead-actions"
);

function html(element: React.ReactElement): string {
	const client = new QueryClient();
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>{element}</QueryClientProvider>,
	);
}

describe("console", () => {
	const out = html(<LeadgenConsole />);

	test("opens on Today with five work tabs and a System button, the row allowed to scroll on a phone", () => {
		const text = out.replace(/<[^>]+>/g, " ");
		for (const tab of ["Today", "Triage", "Review", "Replies", "Leads"]) {
			expect(text).toContain(` ${tab} `);
		}
		expect(text).toContain("System");
		for (const gone of [">Ops<", ">Jobs<", ">Markets<", ">Alerts<"]) {
			expect(out).not.toContain(gone);
		}
		expect(out).toContain("overflow-x-auto");
		expect(out).toContain("Needs triage");
	});

	test("the Review tab carries the same count as the Today tile", () => {
		const at = out.indexOf(">Review");
		expect(at).toBeGreaterThan(-1);
		expect(out.slice(at, at + 200)).toContain(">22</span>");
	});
});

describe("Triage", () => {
	const out = html(<TriageTab initialDecision="undecided" />);

	test("opens on Undecided and shows its count even when it is zero", () => {
		const first = html(<TriageTab />);
		expect(/data-variant="default"[^<]*>Undecided/.test(first)).toBe(true);
		expect(first.replace(/<!-- -->/g, "")).toContain("Undecided (0)");
		const all = html(<TriageTab initialDecision="all" />);
		expect(/data-variant="default"[^<]*>All/.test(all)).toBe(true);
	});

	test("an empty Undecided view points at the leads waiting for a build", () => {
		expect(out.replace(/<!-- -->/g, "")).toContain(
			"See the 288 awaiting a build",
		);
	});

	test("says there is nothing left to triage instead of showing a blank list", () => {
		expect(out).toContain("Nothing left to triage");
		expect(out).toContain("288 approved, 203 rejected");
		expect(out.replace(/<!-- -->/g, "")).toContain("0 of 491 prospects");
	});

	test("shows the mirror age and the decision counts", () => {
		const text = out.replace(/<!-- -->/g, "");
		expect(text).toMatch(/Synced \d+ min ago/);
		expect(text).toContain("Approved (288)");
		expect(text).toContain("All (491)");
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
		const text = out.replace(/<!-- -->/g, "");
		expect(text).toContain("Needs send approval (22)");
		expect(text).toContain("Send-approved (214)");
		expect(text).toContain("Placeholder (12)");
		expect(text).toContain("All real demos (239)");
		expect(text).toContain("251 built demos: 239 real, 12 placeholders");
	});

	test("a card says where the demo stands for sending, not the triage decision", () => {
		expect(out).toContain("needs send approval");
		expect(out).not.toContain(">no QA<");
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
			applied={undefined}
			onApplied={() => undefined}
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

	test("offers the decision panel, and no verify control", () => {
		expect(out).toContain(">Approve for sending<");
		expect(out).toContain(">Reject<");
		expect(out).toContain("Needs changes…");
		expect(out).not.toContain(">Verify<");
	});

	test("puts the decision above the side-by-side so it is reachable without scrolling", () => {
		expect(out.indexOf(">Approve for sending<")).toBeLessThan(
			out.indexOf("Their current site"),
		);
		expect(out).toContain("xl:sticky");
	});

	test("shows the QA failure and the draft email inline, marked as not sent", () => {
		expect(out).toContain("broken link: tel:");
		expect(out).toContain("Draft, not sent");
		expect(out).toContain("Your new site");
		expect(out).toContain("Hello Pat");
	});
});

describe("Ops", () => {
	const out = html(<OpsTab onNavigate={() => undefined} />);

	test("splits the tiles into what waits on Danio and the pipeline, with the same numbers", () => {
		const text = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text.indexOf("Waiting on you")).toBeLessThan(
			text.indexOf("Pipeline"),
		);
		for (const [label, value] of [
			["Needs triage", "0"],
			["Needs send approval", "22"],
			["Awaiting build", "285"],
			["Send-approved, not sent", "87"],
			["Ever sent", "115"],
			["Call / text list", "333"],
			["Demos built", "258"],
		]) {
			expect(text).toContain(`${value} ${label}`);
		}
		expect(text).toContain("8 have an email and draft for the 08:30 send");
	});

	test("shows standing items and leaves services to System", () => {
		expect(out).toContain("Pricing story");
		expect(out).not.toContain("leadgen-daily-send.timer");
		expect(out).toContain("Undecided");
	});

	test("the wide tables scroll sideways instead of breaking the page", () => {
		expect(out).toContain("overflow-x-auto");
	});
});

describe("System", () => {
	const out = html(<SystemTab />);

	test("puts a failing unit first and flags it", () => {
		expect(out.indexOf("leadgen-review-server.service")).toBeLessThan(
			out.indexOf("leadgen-daily-send.timer"),
		);
		expect(out).toContain("failed/failed");
	});

	test("says what needs a look in one line", () => {
		expect(out).toContain("Needs a look");
		expect(out).toContain("1 service problem");
	});

	test("shows health checks and the CRM sync files", () => {
		expect(out).toContain("daily send ran");
		expect(out).toContain("1 pending");
	});
});

const actionLead: ActionLead = {
	id: "lead-1",
	table: "isp",
	businessName: "Alpha Plumbing",
	decision: null,
	decisionDate: null,
	version: "2026-09-20 14:31:07+00:00",
	sendApproved: false,
	doNotContact: false,
	email: "pat@alpha.example.com",
};

const actions = (
	lead: Partial<typeof actionLead>,
	stage: "triage" | "review",
	status: Record<string, unknown> = approver,
	applied?: unknown,
) => {
	FIXTURES.status = status;
	try {
		return html(
			<LeadActions
				lead={{ ...actionLead, ...lead }}
				stage={stage}
				applied={applied as never}
				onApplied={() => undefined}
			/>,
		);
	} finally {
		FIXTURES.status = approver;
	}
};

describe("decision actions", () => {
	test("review stage on ISP: Approve sits behind a confirm dialog; needs changes and rework share one fold", () => {
		const out = actions({}, "review");
		expect(out).toContain(">Approve for sending</button>");
		expect(out).not.toContain(">Approve</button>");
		expect(out).toContain(">Reject</button>");
		expect(out).toContain("Needs changes…");
		expect(out).toContain(">Request rework</button>");
		expect(out).toContain(">Mark needs changes (no rebuild)</button>");
		expect(out.indexOf("<details")).toBeLessThan(
			out.indexOf(">Request rework</button>"),
		);
	});

	test("the review Approve control is only reachable through the confirm dialog", () => {
		const source = readFileSync(
			join(import.meta.dir, "../app/(app)/[slug]/leadgen/lead-actions.tsx"),
			"utf8",
		);
		expect(source).toMatch(
			/<ApproveForSending[\s\S]*?onConfirm=\{\(\) => send\("Approved"\)\}/,
		);
		expect(source).toMatch(/arming \? \(\s*<ApproveForSending/);
		expect(source).toContain('confirmArm: arming && decision === "Approved"');
		expect((source.match(/send\("Approved"\)/g) ?? []).length).toBe(2);
	});

	test("triage stage: plain Approve, and it says it sends nothing", () => {
		const out = actions({}, "triage");
		expect(out).toContain(">Approve</button>");
		expect(out).not.toContain("Approve for sending");
		expect(out).not.toContain("Request rework");
		expect(out).toContain("does not send anything");
	});

	test("gym review: no confirm, no rework, manual sends", () => {
		const out = actions({ table: "gym" }, "review");
		expect(out).toContain(">Approve</button>");
		expect(out).not.toContain("Request rework");
		expect(out).toContain("Gym sends stay manual");
	});

	test("a do-not-contact lead has every action disabled", () => {
		const out = actions({ doNotContact: true }, "review");
		expect(out).toContain("do not contact");
		const buttons =
			out.match(
				/<button[^<]*>(Approve for sending|Reject|Mark needs changes \(no rebuild\)|Request rework)</g,
			) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const b of buttons) expect(b).toContain("disabled");
	});

	test("a lead with no mirror version cannot be acted on", () => {
		const out = actions({ version: null }, "review");
		expect(out).toContain("no version in the mirror");
	});

	test("an account outside the allowlist gets no buttons", () => {
		const out = actions({}, "review", { ...approver, youAreApprover: false });
		expect(out).toContain("may not make lead decisions");
		expect(out).not.toContain(">Reject</button>");
	});

	test("switched off, and unable to write, both say so and show no buttons", () => {
		const off = actions({}, "review", {
			...approver,
			youAreApprover: false,
			approversConfigured: false,
		});
		expect(off).toContain("switched off");
		const nowrite = actions({}, "review", {
			...approver,
			writeConfigured: false,
			writeProblem: "no NocoDB token is set",
		});
		expect(nowrite).toContain("no NocoDB token is set");
		expect(nowrite).not.toContain(">Reject</button>");
	});

	test("after a save the list shows NocoDB's answer and says the mirror trails", () => {
		const out = actions({}, "review", approver, {
			auditId: "a1",
			replay: false,
			leadId: "lead-1",
			action: "DECISION",
			decision: "Approved",
			sendApproved: true,
			decisionDate: "2026-09-20",
			version: "2026-09-20 15:04:06+00:00",
			reworkRequested: false,
			appliedAt: "2026-09-20T15:04:06.000Z",
		});
		expect(out).toContain("send approved");
		expect(out).toContain("Saved to NocoDB");
		expect(out).toContain("after the next mirror run");
	});

	test("an older applied change never hides a newer mirror row", () => {
		const out = actions(
			{ decision: "Rejected", version: "2026-09-20 16:00:00+00:00" },
			"review",
			approver,
			{
				auditId: "a1",
				replay: false,
				leadId: "lead-1",
				action: "DECISION",
				decision: "Approved",
				sendApproved: true,
				decisionDate: "2026-09-20",
				version: "2026-09-20 15:04:06+00:00",
				reworkRequested: false,
				appliedAt: "2026-09-20T15:04:06.000Z",
			},
		);
		expect(out).not.toContain("send approved</span>");
	});
});

describe("Review detail, 2b additions", () => {
	const out = html(
		<DemoDetail
			id="lead-1"
			row={reviewRow as never}
			applied={undefined}
			onApplied={() => undefined}
			hasPrev={false}
			hasNext={true}
			onPrev={() => undefined}
			onNext={() => undefined}
			onBack={() => undefined}
		/>,
	);

	test("offers the live demo and the editable local copy, live first", () => {
		expect(out).toContain("Live (what leads see)");
		expect(out).toContain("Local copy (editable)");
		expect(out.indexOf("Live (what leads see)")).toBeLessThan(
			out.indexOf("Local copy (editable)"),
		);
	});

	test("shows their site as a cached screenshot from the CRM's own image route", () => {
		expect(out).toContain(
			'src="/api/leadgen/shot/lead-1?v=2026-09-21T10%3A00%3A00.000Z"',
		);
		expect(out).toContain("Screenshot of their live site");
		expect(out).toContain(">Re-capture<");
	});

	test("has an audit button", () => {
		expect(out).toContain(">Audit their site<");
	});

	test("no longer points at the old dashboard or its proxy", () => {
		expect(out).not.toMatch(/old dashboard|:8767|\/old\/\?u=|api\/shot\?url/i);
	});

	test("keeps exactly one iframe, the sandboxed Cloudflare demo", () => {
		expect((out.match(/<iframe/g) ?? []).length).toBe(1);
	});
});

describe("Triage detail, 2b additions", () => {
	test("shows the screenshot and audit, and no old-dashboard links", async () => {
		const { TriageTab: Triage } = await import(
			"../app/(app)/[slug]/leadgen/triage-tab"
		);
		FIXTURES.triageList = {
			rows: [
				{
					...identity,
					notes: "",
					notesTruncated: false,
					updatedAt: "2026-09-20T12:00:00.000Z",
				},
			],
			total: 1,
			facetCounts: { decision: { all: 1 }, table: { isp: 1 } },
		};
		try {
			const out = html(<Triage />);
			expect(out).toContain("Alpha Plumbing");
		} finally {
			FIXTURES.triageList = {
				rows: [],
				total: 0,
				facetCounts: {
					decision: { Approved: 288, Rejected: 203, all: 491 },
					table: { isp: 318, gym: 173 },
				},
			};
		}
	});
	test("the triage source has no old-dashboard link left", () => {
		const source = readFileSync(
			join(import.meta.dir, "../app/(app)/[slug]/leadgen/triage-tab.tsx"),
			"utf8",
		);
		expect(source).not.toMatch(
			/useOldDashboard|old\.(preview|screenshot|home)/,
		);
		expect(source).toContain("<SiteShot");
		expect(source).toContain("<SiteAuditPanel");
	});
});

describe("local copy pane", () => {
	const out = html(<LocalDemoPane leadId="lead-1" name="Alpha Plumbing" />);
	test("offers editing to an approver and says nothing is live", () => {
		expect(out).toContain(">Edit text<");
		expect(out).toContain("deploy-demo.sh alpha-demo");
		expect(out).toContain("no access to your CRM session");
	});
	test("a non-approver gets no edit button and is told why", () => {
		const base = FIXTURES["leadgenDemos.info"] as Record<string, unknown>;
		FIXTURES["leadgenDemos.info"] = {
			...base,
			canEdit: false,
			editProblem: "This account is not an approved decision maker.",
		};
		try {
			const view = html(<LocalDemoPane leadId="lead-1" name="Alpha" />);
			expect(view).not.toContain(">Edit text<");
			expect(view).toContain("not an approved decision maker");
		} finally {
			FIXTURES["leadgenDemos.info"] = base;
		}
	});
	test("no local build says so instead of showing an empty frame", () => {
		const base = FIXTURES["leadgenDemos.info"] as Record<string, unknown>;
		FIXTURES["leadgenDemos.info"] = {
			...base,
			hasLocal: false,
			reason: "no local build for this slug",
		};
		try {
			const view = html(<LocalDemoPane leadId="lead-1" name="Alpha" />);
			expect(view).toContain("No local build for this lead yet");
			expect(view).not.toContain("<iframe");
		} finally {
			FIXTURES["leadgenDemos.info"] = base;
		}
	});
});

describe("screenshot panel", () => {
	test("says so plainly when the host has no browser", () => {
		const base = FIXTURES["leadgenShots.status"] as Record<string, unknown>;
		FIXTURES["leadgenShots.status"] = {
			...base,
			available: false,
			unavailableReason: "The headless browser is not installed on this host.",
			cached: false,
			capturedAt: null,
		};
		try {
			const view = html(<SiteShot leadId="lead-1" name="Alpha" />);
			expect(view).toContain("not installed on this host");
			expect(view).toContain("Open their site");
			expect(view).not.toContain("<img");
		} finally {
			FIXTURES["leadgenShots.status"] = base;
		}
	});
	test("offers a manual button when nothing is cached yet", () => {
		const base = FIXTURES["leadgenShots.status"] as Record<string, unknown>;
		FIXTURES["leadgenShots.status"] = {
			...base,
			cached: false,
			capturedAt: null,
		};
		try {
			expect(html(<SiteShot leadId="lead-1" name="Alpha" />)).toContain(
				">Take a screenshot<",
			);
		} finally {
			FIXTURES["leadgenShots.status"] = base;
		}
	});
});
