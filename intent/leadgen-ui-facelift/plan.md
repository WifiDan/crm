# Plan — Lead Gen UI facelift, Slice 1 (read-only)

**Depends on:** intent.md, spec.md (same folder). **Branch:** `feat/leadgen-ui`, child of `feat/leadgen-phase3` (a991328), dev clone `/data/leadgen/crm-dev` on Joshua. **Board:** Kanban #486.

Slice 1 reads only. It adds no NocoDB write, no `lg_*` write, no job handler, no migration, and no send path.

## Findings that shape the plan

- The old pages read NocoDB rows live. The CRM reads the `lg_lead` mirror (up to 15 min behind). Every page shows the last-mirror time.
- Prod mirror on 2026-09-20: 992 active rows (757 ISP, 235 gym). This is the "992 truncated to 200" size, so server-side pagination is required.
- `/api/prospects` rule is `no demo AND website AND not DNC`, decided rows included. The old UI hides decided rows by default. All 491 prospects carry a decision today, so the default "undecided" view is empty. The page shows per-decision counts so this is visible.
- `/api/leads` rule is `demo URL present AND a slug parses from it` (Cloudflare `demo-<slug>.pages.dev` or `<slug>.ei-leadgen-demos.pages.dev`). 258 rows have a demo URL. 7 hold a `file://` path, so the old page drops them. The CRM uses the same slug regexes so the counts can match.
- `lg_build` is empty (backfill not done). QA status and flags therefore come from `raw["Quality Notes"]` (`QA: PASS/FAIL` lines, `BUCKET: PLACEHOLDER`), the same source the old page used.
- `lg_lead.marketId` is set on 280 of 992 rows; `campaignId` on all 992. Filters offer campaign, market (incl. "no market") and pool (ISP / gym).
- Old ops dashboard health used `launchctl` and `~/Library/Logs`, both Mac Mini only. On Joshua they return nothing. The CRM Ops view reads `systemctl --user` and `/data/leadgen/health-state.json` instead.

## Old-site pane decision

The old `/old/?u=` proxy fetches any URL server-side and re-serves it as same-origin HTML with `<base>` injected. Hosting that inside the CRM app is an authenticated SSRF door plus foreign HTML on the CRM origin. It would also need iframe/CSP relaxations. The CRM does not host it. The Review "their site" pane is a link-out card: original URL, and the old dashboard's `/old/?u=` preview (built from `location.hostname` + port 8767, no hardcoded host). An opt-in "try showing it here" button frames the original https URL inside a sandboxed iframe (no same-origin, no top navigation). CRM headers are not changed.

## API (apps/api/src/leadgen)

| File | Purpose |
| --- | --- |
| `lead-views.config.ts` | Page sizes, file paths (env overridable), systemd unit patterns, truncation limits. One config object. |
| `lead-view.ts` | Pure helpers: `slugFromDemoUrl`, Pages URL patterns, `parseQaNotes`, `isPlaceholder`, `safeDemoUrl`, zod schema for the raw NocoDB fields we read. |
| `lead-views.sql.ts` | Pure builders for the triage and review WHERE fragments and the ORDER BY whitelist (`Prisma.sql`, values bound, sort never interpolated). |
| `lead-views.contracts.ts` | zod inputs/outputs for `triageList`, `reviewList`, `reviewDetail`. Lists take `listInput` and return `{ rows, total, facetCounts }`. |
| `lead-views.service.ts` | `LeadgenViewsService`: reads only. |
| `ops-health.ts` | Pure parsers: `systemctl show` blocks, `health-state.json`, standing tasks, company map, deal queue. |
| `ops.contracts.ts`, `ops.service.ts` | `LeadgenOpsService`: overview counts, per-pool sent/eligible, recent sends, call list (paginated), rework queue, standing tasks, systemd health, health checks, CRM-sync files. |
| `leadgen.router.ts` | Thin procedures: `triageList`, `reviewList`, `reviewDetail`, `opsOverview`, `opsHealth`, `opsCallList`, `opsRecentSends`. |
| `leadgen.module.ts` | Provide the two new services (no job handler, so no wiring change). |
| `src/generated/server.ts` | Regenerate with `bun run trpc:generate`. Commit. |

Raw SQL is used because the filters live in the NocoDB JSON (`raw`) and Prisma's NULL semantics on `<>` drop rows silently. All raw values are bound parameters.

## App (apps/app/app/(app)/[slug]/leadgen)

- `leadgen-console.tsx`: add tabs Triage, Review, Ops in front of the existing five. Tab row scrolls on a phone. Tab is kept in `location.hash`. Default tab: Ops.
- `triage-tab.tsx`: filters (search, decision, pool, campaign, market), sort, 25 per page, card list (phone) with detail panel, notes, link to their site, count line "N of M".
- `review-tab.tsx`: view chips with counts (pending, approved, rejected, placeholder, all), pool, search, paged list. Detail: on a wide screen two panes side by side; on a narrow screen a New demo / Their site toggle. QA status and flags, draft email (marked "not sent"), previous/next. Read-only. A link opens the old dashboard for decisions until Slice 2.
- `ops-tab.tsx`: tiles, per-pool sent/eligible, send velocity, by source and decision bars, tasks (awaiting review, call/text list, rework, standing items), recent sends, health (systemd, health checks, CRM sync files), plus compact mirror status, open alerts and failed jobs reusing existing queries, with links to the Jobs and Alerts tabs.
- `leadgen-format.ts`: shared `when()` and old-dashboard link builder.
- UI vocabulary follows `replies-tab.tsx` and `leadgen-console.tsx` (Badge, Button, `border-border`, `text-xs`). No code comments (AGENTS.md).

## Order of work

1. Commit intent, spec, plan.
2. Write the feature table (below in the report, and in `ops-feature-table.md`).
3. API: helpers and their unit tests first, then SQL builders, services, router, module. `trpc:generate`.
4. App: format helpers, Triage, Review, Ops, console wiring.
5. Live test on `crm_dev`: seed 1,005 synthetic rows, assert pagination, totals, filters. Delete only those rows after.
6. Parity script (read-only against prod DB): CRM counts vs old `/api/prospects` and `/api/leads` on port 8767.
7. Gates: biome, `check-types` (api, app), `bun test test/leadgen-*.spec.ts`, no-send spec, wiring spec.
8. Commit in logical units on `feat/leadgen-ui`. Stage explicit paths only.

## Tests that prove it

- Pure: slug parity with the old function (both URL shapes, `file://` rejected, 28-char truncation), QA parser (last line wins, FAIL reason kept), placeholder flag, `safeDemoUrl` rejects non-https and non-pages.dev, WHERE builders bind every value and never inline input, sort whitelist falls back on unknown keys, systemd/health parsers survive junk input.
- Live (`crm_dev` only): 1,005 rows paginate to exactly the table count with no duplicates and no gaps; filters each change the total to the value counted directly; facet counts add up; a page beyond the end is empty with the right total.
- Parity (read-only): CRM triage total equals old `/api/prospects` length; CRM review "everything" equals old `/api/leads` length.
- Gates: `test/leadgen-no-send.spec.ts` and `test/leadgen-job-wiring.spec.ts` stay green.

## Risks

- Mirror lag. Mitigation: last-mirror time on every page.
- `systemctl` may be unavailable in the API's environment. Mitigation: return `available: false` with the reason, never throw.
- Narrow-viewport look cannot be screenshotted without a signed-in browser session. If that stays true it is reported as NOT verified. Layout is built with responsive classes only (`hidden lg:block`), no JS measuring.
- Complexity cap 62: keep helpers small and pure.
- AGENTS.md says "no Co-Authored-By"; Danio's task and the branch history use it. Followed Danio's instruction.

## As built (departures from the plan above)

- One extra query, `campaigns`, because the campaign filter needs ids. Eight new procedures in total.
- Extra API files: `lead-views.rows.ts` (zod parse of SQL rows), `ops.sql.ts` (ops counts), `site-builds.ts` (v2 / v1 badge from `/data/leadgen/site-generator/output`).
- Extra app files: `lead-parts.tsx`, `ops-lists.tsx`, `ops-health-panel.tsx`, `leadgen-format.tsx` (holds the mirror-age strip and the old-dashboard link builder).
- Review shows their site on the left and the new demo on the right. Narrow screens toggle between the two.
- The narrow-viewport check is a server-render test (`apps/app/test/leadgen-views-render.spec.tsx`) that asserts the responsive structure. No screenshot was taken: the pages sit behind a Better Auth session and there is no browser on the host. The look on a real phone is NOT verified.
- The live test also parses every procedure's output through its zod contract, because calling the service directly skips the router's output validation.
- New env variables (all optional, file paths) are declared in `.env.example`.
- Ops numbers were compared with the old `/api/stats` and `/api/tasks` on port 8768. All nine counts matched. Reply rate is defined differently (see the report).
