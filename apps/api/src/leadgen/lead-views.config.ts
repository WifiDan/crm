const SCRIPTS_DIR = process.env.LEADGEN_PYTHON_DIR ?? "/data/leadgen/scripts";

export const LEAD_VIEWS = {
	paging: { defaultPageSize: 25, maxPageSize: 100 },
	text: { listNotesChars: 400, detailNotesChars: 20_000, failureChars: 200 },
	recentDays: 60,
	reworkLimit: 50,
	files: {
		standingTasks:
			process.env.LEADGEN_STANDING_TASKS_FILE ??
			"/data/leadgen/ops-dashboard/standing-tasks.json",
		healthState:
			process.env.LEADGEN_HEALTH_STATE_FILE ??
			"/data/leadgen/health-state.json",
		siteOutput:
			process.env.LEADGEN_SITE_OUTPUT_DIR ??
			"/data/leadgen/site-generator/output",
		companyMap: `${SCRIPTS_DIR}/crm_company_map.json`,
		dealQueue: `${SCRIPTS_DIR}/crm_deal_queue.jsonl`,
	},
	systemd: {
		unitPatterns: ["leadgen-*", "crm-api.service", "crm-app.service"],
		unitTypes: "service,timer",
		properties: [
			"Id",
			"Description",
			"ActiveState",
			"SubState",
			"Result",
			"ExecMainStatus",
			"ExecMainExitTimestamp",
			"LastTriggerUSec",
			"NextElapseUSecRealtime",
		],
		timeoutMs: 8000,
		maxBufferBytes: 1_000_000,
	},
	pages: {
		legacyPattern: "demo-([a-z0-9-]+)\\.pages\\.dev",
		sharedPattern: "([a-z0-9-]+)\\.ei-leadgen-demos\\.pages\\.dev",
		host: ".pages.dev",
	},
	placeholderMarker: "BUCKET: PLACEHOLDER",
	gymTableKey: "gym",
} as const;
