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

---

# Plan — Slice 2a (guarded decisions and rework)

**Depends on:** `spec-slice2.md` (same folder), and Slice 1 above. **Branch:** `feat/leadgen-ui-decisions`, child of `feat/leadgen-ui` (b8cfc96). **Board:** Kanban #486. **Not deployed.** Danio decides the deploy, because this is a send-affecting write path.

## Findings that shape the plan

- **Credential.** The mirror reads `NOCODB_LEADS_TOKEN`. In the production CRM `.env` its value is byte-identical to the Python sender's `NOCODB_LOCAL_LEADS_TOKEN` (compared by SHA-256, nothing printed). NocoDB reports the token owner as `danio@elitesystemsdesign.com` with base role `creator`. That role can write records. Not a stop condition: the token is present and write-capable. It is a least-privilege finding: a read-only job holds the sender's write token. The dev clone `.env` has no NocoDB variables, so every write test uses stubs.
- **`Send Approved` in the old code.** `apiDecision` writes the field only when `stage === "review"` on the ISP table. For a triage-stage decision it writes nothing and leaves an old value in place. Sequence that breaks: review Approve (true), triage Reject, triage Approve. The decision reads `Approved` and the stale `true` survives, so the sender mails a lead nobody re-reviewed. The spec rule ("everything else writes false") closes that hole. The CRM follows the spec. Deliberate delta from the old code: an ISP decision that is not review + Approved also writes `Send Approved=false`. The equivalence test pins this delta.
- **Table is never a client input.** The old API took `table` from the request body. The CRM derives the NocoDB table and row id from the `lg_lead` record, so a caller cannot aim a write at another table.
- **Version token.** NocoDB `UpdatedAt` has one-second resolution and is stored in `lg_lead.raw`. The page sends `UpdatedAt`, `Approval Decision` and `Decision Date` as it saw them. The server reads the live row and compares all three.
- **Live GET by row id works** (`/api/v2/tables/<t>/records/<id>`) and returns every column. `Send Approved` comes back as `1` (number), so the read-back check accepts `true`, `1` and `"true"`.
- **Gym table:** no `Send Approved`, no rework columns. Gym review writes only the decision.

## Decisions taken where the spec was silent

1. `LEADGEN_DECISION_APPROVERS` has no fallback. Unset or empty refuses everything. Deploy sets it explicitly (to the same account as the reply approvers).
2. Write token variable: `NOCODB_LEADS_WRITE_TOKEN`, falling back to `NOCODB_LEADS_TOKEN`. The status query reports which one is in use (never the value). A later dedicated write token needs no code change.
3. Audit table `lg_lead_decision` (additive migration, `crm_dev` only). Refusals before the write are logged, not stored. Every attempt that reaches NocoDB has a row.
4. `requestId` (uuid from the page, one per confirm click) gives idempotency. Same id twice: one write, the second call returns the first result.
5. Approve at review stage on an ISP lead needs `confirmArm: true`. The server refuses without it. The UI sets it only from the confirm dialog.
6. A decision or rework on a Do Not Contact lead is refused for every decision, as the spec says.
7. One decision per lead at a time: an in-process lock plus a refusal when a PENDING audit row for the lead is under two minutes old.
8. After a 2xx PATCH the service reads the row back and compares every written field. A mismatch (NocoDB discards unknown columns silently) is recorded UNKNOWN and reported as an error.

## API (apps/api/src/leadgen)

| File | Purpose |
| --- | --- |
| `lead-decision.rules.ts` | Pure. Pool config (table id, rework, send flag), `buildDecisionPatch`, `buildReworkPatch`, policy from env, version check, refusal reasons, eligibility via `buildCandidates` from `outreach-plan.ts`. The only file that names the `Send Approved` write. |
| `lead-decision.store.ts` | `LeadRowStore` port and the fetch adapter for NocoDB (`getRow`, `hasColumn`, `patchRow`). The only file with a NocoDB write call. Timeouts, 4xx = definite failure, 5xx or network = unknown. |
| `lead-decision.service.ts` | `LeadDecisionService.decide / rework / status`. Order: policy, request replay, mirror lookup, live read, column check, version, blockers, audit row (PENDING), PATCH, read-back, audit outcome. |
| `lead-decision.contracts.ts` | zod. No reviewer, no table, one lead id. |
| `lead-decision.router.ts` | Alias `leadgenDecisions`. `AuthMiddleware` + `SessionOnlyMiddleware`, no REST meta. Only caller of the service. |
| `lead-views.*` | Add `version` and `decisionDate` (from `raw`) to list rows and detail. Read only. |
| `leadgen.module.ts` | Provide store, service, router. |
| `packages/db` | Model `LgLeadDecision`, enum `LgDecisionStatus`, migration `20260920120000_leadgen_lead_decision` (create table only). |

## App

- `lead-actions.tsx`: `DecisionActions` (Approve, Reject, Needs Changes; review-stage Approve opens an alert dialog stating the lead becomes eligible for the next 08:30 send), `ReworkForm` (notes required), applied-result overlay, "mirror trails by up to 15 minutes" line.
- `triage-tab.tsx`: default filter `all`; actions in the detail panel (stage `triage`).
- `review-tab.tsx`: actions in the detail (stage `review`), rework form for ISP only; the "done in the old dashboard until Slice 2" note becomes "inline editing stays in the old dashboard".

## Order of work

1. Commit spec-slice2 and this plan.
2. Small items: Triage default `all`; reply-rate pin test (pure SQL pin plus a `crm_dev` live check with two inbound messages on one lead).
3. Rules and their tests, then the equivalence test against the real old `apiDecision` / `apiRework` (run in a `vm` sandbox with a stub `fetch`; skipped when the old file is absent, with a frozen table so it still runs elsewhere).
4. Store and its tests against a local HTTP stub.
5. Migration on `crm_dev` only, then service, contracts, router, module, `trpc:generate`.
6. Guard tests, structural test, door test.
7. App actions, render tests, `next build`.
8. Live check on `crm_dev` (real Postgres, stub store) and a READ-ONLY probe of NocoDB (column present, GET row, patch compared with old logic).
9. Break-on-purpose run: revert each guard, show its test fail, restore.
10. All gates. Commit in logical units, explicit paths, `git commit -F`, no trailer.

## Tests that prove it

- Patch equivalence with the old code over pool x stage x decision, and rework; the single delta is asserted.
- Guard tests: Send Approved matrix (gym included), missing column fails closed with no PATCH and no audit row, stale version 409, DNC and already-sent refusal, ineligible lead refusal, non-approver, unset and empty allowlist, `confirmArm`, audit row exists before the PATCH, timeout recorded UNKNOWN and never retried, 4xx recorded FAILED, double click with one `requestId` writes once, in-flight lock, `lg_lead` never written.
- Structural (`leadgen-decision-door.spec.ts`): only the store writes to NocoDB; only rules name the `Send Approved` write; only the decision router imports the service; no handler or scheduler reaches it; router is session-only with no REST; contracts have no reviewer, no table, no bulk field; only the mirror handler writes `lg_lead`.
- The existing `leadgen-no-send.spec.ts` stays unchanged and green.

## Risks

- Mirror lag: a second action on the same lead before the mirror catches up uses the version returned by the first write (page overlay).
- The read-back adds one GET per write. Acceptable at human click rate.
- Real NocoDB write path is not exercised (no prod writes allowed). It is covered by the HTTP stub and the read-only probe.
- Complexity cap 62: pure helpers, small methods.

## As built (Slice 2a, departures from the plan above)

- **Extra app files.** `lead-actions-state.ts` (pure: overlay of the last saved result on a mirror row, the version the page sends back) and `request-id.ts` (a v4 id built from `getRandomValues`). Reason: the CRM is opened over plain http on the tailnet, where `crypto.randomUUID` does not exist. The helper is tested against the API's `z.uuid()`.
- **`TriageTab` takes an optional `initialDecision`** (default `all`) so the empty-state test can still render the Undecided view.
- **`DemoDetail` (Review) takes `applied` and `onApplied`.** The applied-result overlay lives in the tab so the list cards and the detail agree.
- **`MirrorFreshness` takes `writes`.** Triage and Review say a saved change goes to NocoDB at once and the list catches up within 15 minutes. Ops keeps the read-only wording.
- **Store.** `nocodbLeadStore(env, fetchImpl, timeoutMs)` so tests can inject a short timeout. `FetchLike` replaces `typeof fetch` so a guarded fetch can be passed.
- **Slice 1 test replaced.** "keeps decisions out of Slice 1" asserted the absence of the buttons; it now asserts the decision panel is present and Verify is not.
- **Live check** `test/leadgen-decision.live.ts` (crm_dev only, real Postgres, stub store) plus a READ-ONLY NocoDB probe behind a fetch that refuses any non-GET. Probe results are in the report, not here.
- **Non-vacuous control added.** A first version of the eligibility probe passed with zero candidates. It now builds the "everything approved" table, runs the sender's own `buildCandidates` over all 757 real ISP rows, and compares that with the per-row check: 4 pass, 753 refused, 0 disagree.
- **Arming rule copy on the page.** The page mirrors `armsSending` only to decide whether to show the confirm dialog. The server decides, and refuses an arming Approve without `confirmArm`.
- **No fallback for `LEADGEN_DECISION_APPROVERS`**, as planned. `.env.example` documents it and `NOCODB_LEADS_WRITE_TOKEN`.
- **Migration** `20260920120000_leadgen_lead_decision` is create-table only, applied to `crm_dev` only. `prisma migrate diff` against `crm_dev` reports no difference. Production is not migrated.

---

# Plan — Slice 2b (demo editing, site audit, local demo preview)

**Depends on:** `spec-slice2b.md`, `parity-table.md`, Slices 1 and 2a above. **Branch:** `feat/leadgen-ui-2b`, child of `feat/leadgen-ui-decisions` (9896ad4). **Board:** Kanban #486. **Not deployed.** Old dashboards stay untouched.

## Findings that shape the plan

- **How an edited demo reaches the live URL (asked for first).** It does not, by itself. Old `apiSave` overwrites only `site-generator/output/<slug>/index.html` on disk. The old dashboard never redeploys. Cloudflare only changes when `deploy-demo.sh <slug>` runs (`wrangler pages deploy output/<slug> --branch=<28-char slug>`), which republishes the same branch alias `https://<branch>.ei-leadgen-demos.pages.dev`. That is the URL emailed to leads, so a deploy after an edit changes what an already-emailed lead sees. `nightly_orchestrator.py` runs `deploy_and_link.js` only for slugs it just built or reworked (lines ~869 and ~986). So: an edit stays local until someone runs the deploy, or until a rebuild of that lead replaces the local file and deploys it (which also throws away the edit). 2b keeps that separation. No auto-redeploy. The UI says "Saved locally, not yet live" and prints the deploy command.
- **The old backup would have gone public.** `deploy-demo.sh` publishes the whole slug folder. Old `apiSave` wrote `index.<time>.bak.html` inside it. 2b writes backups to `LEADGEN_DEMO_BACKUP_DIR` (default `/data/leadgen/demo-edit-backups/<slug>/`), outside the output folder. Startup check refuses a backup dir inside the output dir.
- **Build records.** `lg_build` is empty and `manifest.json` names only 2 of the 75 output folders. The build record used is the lead's own mirrored `Demo Site URL`: its slug, resolved with the existing `resolveBuildDir` (exact folder, else unique 28-char-prefix match), must name an existing folder that holds `index.html`. The caller never supplies a slug or a path.
- **Cookies do not reach a sandboxed frame's subresources.** A sandboxed document without `allow-same-origin` has an opaque origin, so its image/CSS requests to the CRM origin are cross-site and the session cookie is not sent. A cookie-authenticated `/demo/` route would therefore break every asset. 2b serves demo files from a signed, short-lived link minted by a session-only tRPC call (below).
- **Everything is one origin.** The browser reaches only the Next app (`/api/[...path]` proxies to the API). Demo files therefore arrive on the CRM origin, so the sandbox must be enforced by the response headers as well as the iframe attribute.
- **Bun honours `lookup`** on `node:http(s).request` (checked on Joshua: bun 1.3.12 and node 22 both call it). That lets the SSRF guard pin the connection to the address it validated, which closes DNS rebinding.
- **Screenshots first looked blocked** (missing system libraries) and were later built with a rootless install; see the as-built section.

## Sandbox design (the part that matters)

1. **Where demo HTML is shown.** Only inside `<iframe sandbox="allow-scripts">` (no `allow-same-origin`, no `allow-top-navigation`, no `allow-popups`, no `allow-forms`). Model-generated scripts run, but in an opaque origin: no `document.cookie`, no CRM `localStorage`, no DOM access to the parent.
2. **Header defence in depth** on every file the preview route serves: `Content-Security-Policy: sandbox allow-scripts; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`. So even a demo file opened directly in a tab is sandboxed. `connect-src 'none'` stops demo scripts from calling the CRM API or anything else with fetch/XHR/beacon. Helmet's own CSP and `Cross-Origin-Resource-Policy: same-origin` are overridden on these responses (`cross-origin` is required, or the opaque-origin frame cannot load its images and CSS). Fonts load with CORS, so `Access-Control-Allow-Origin: *` is set (safe: the link is the credential, there are no cookies).
3. **Access.** `leadgenDemos.previewLink({id})` (AuthMiddleware + SessionOnlyMiddleware, no REST) returns `{path, expiresAt}`. The path holds an HMAC token (`slug`, `mode`, `exp`; 15 minutes). The key is 32 random bytes made when the API starts, so a restart invalidates all links and no secret is stored anywhere. The token grants read of that one slug folder and nothing else. The route is `@AllowAnonymous()` for that reason and is the only such route in the leadgen module.
4. **Editing.** Approvers get an `edit` token. For HTML files only, the route injects a small bridge script (`data-leadgen-bridge`). It answers only messages whose `event.source` is `window.parent` and that carry `{leadgen:1}`: `edit` toggles `designMode`, `get-html` returns the serialized document (with the bridge removed) tagged with the caller's nonce. The parent accepts a reply only when `event.source` is the frame's `contentWindow`, the nonce matches a pending request, and the type is `html`. Nothing in the frame can call tRPC (`connect-src 'none'`), and the frame never holds a session.
5. **What a hostile demo script could still do:** answer `get-html` with different HTML than it shows. That HTML is then saved into that demo's own file, only after an approver clicks Save, and it passes the same size/shape checks. The blast radius is the demo being edited. The server also strips the bridge if it comes back and refuses HTML that still names it.
6. **Save path.** Serialized HTML goes browser -> tRPC `leadgenDemos.save`. The frame never talks to the server.

## API (apps/api/src/leadgen)

| File | Purpose |
| --- | --- |
| `outbound-guard.ts` | Pure host/IP classification (v4 and v6, embedded v4, `.local/.internal/.ts.net`, single-label hosts, credentials) plus `fetchPublic`: resolve, refuse if ANY address is non-public, pin the connection to the validated address, manual redirects (max 5) re-checked per hop, byte cap, time cap. Resolver and transport are injected so tests never touch a network. |
| `site-audit.ts` | Pure `scoreSite(html, target)` and `auditFailure`. Signals, weights, thresholds and messages copied from the old handler, quirks included. |
| `site-audit.service.ts`, `site-audit.router.ts` | `leadgenAudit.run({id})`. Looks up the lead's own website, normalizes with the existing `safeHttpUrl`, calls `fetchPublic` (2 MB, 10 s), scores. Max 3 audits at once. |
| `demo-files.ts` | The only file that touches demo files. `resolveDemoDir`, `resolveDemoFile` (segment walk with `lstat`, no symlinks, `realpath` inside the folder, no dotfiles, no backup pattern), MIME table, `saveDemoHtml` (validation, backup, temp file + rename in the same folder, prune to last 10 backups matching `^index\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak\.html$`). |
| `demo-bridge.ts` | Bridge script text, `injectBridge`, `stripBridge`. |
| `demo-preview-token.ts` | `mintToken`, `verifyToken` (HMAC-SHA256, `timingSafeEqual`, expiry). |
| `demo-edit.service.ts` | `previewLink`, `info`, `save`. Save order: policy (`LEADGEN_DECISION_APPROVERS`, unset refuses) -> replay by `requestId` -> lead + slug -> resolve dir -> in-process per-slug lock -> current sha256 must equal the page's `baseSha256` -> validate -> **audit row (PENDING: who, slug, bytes and sha256 before/after, backup name)** -> backup -> atomic write -> read back and compare sha256 -> audit APPLIED. A failed write is FAILED, an ambiguous one UNKNOWN, never retried. |
| `demo-edit.router.ts` | Alias `leadgenDemos`. Session-only. Only caller of the service. |
| `demo-preview.controller.ts` | `GET api/leadgen/demo-preview/:token/*`. Read only. Token check, resolve, headers above. |
| `packages/db` | Model `LgDemoEdit` (reuses enum `LgDecisionStatus`), migration `20260921000000_leadgen_demo_edit` (create table only, additive). Applied to `crm_dev` only. |

## App (apps/app/app/(app)/[slug]/leadgen)

- `demo-local-pane.tsx`: "Local copy" view in the Review demo pane: sandboxed frame, edit toggle, Save, status ("Saved locally, not yet live", deploy command, backup name), refresh link when the token expires.
- `site-audit-panel.tsx`: Audit button + result (priority colour, score, signals) used by Review and Triage.
- Review and Triage: auto-advance to the next card after a saved decision; the "editing and audits stay in the old dashboard" note is replaced.
- `site-shot-panel.tsx`: cached screenshot with Re-capture, used by Review and Triage. (First written as blocked, then built after the coordinator allowed a rootless browser install; see as-built.)

## Order of work

1. Commit spec, parity table, this plan.
2. `outbound-guard` + tests, then `site-audit` + the old-code fixture test. Break-on-purpose runs for both.
3. `demo-files`, `demo-bridge`, `demo-preview-token` + tests (temp dirs only). Break-on-purpose.
4. Migration on `crm_dev`; `demo-edit` service, router, controller, module; structural door spec; `trpc:generate`.
5. Live checks: `crm_dev` + temp output dir for save; real loopback/private/metadata probes and one public URL for the guard.
6. App components, render tests, `next build`.
7. All gates. Commit in logical units, explicit paths, `git commit -F`, no trailer.

## Tests that prove it

- Guard: refuses `http://127.0.0.1:3041/`, `http://100.78.149.77:8768/`, `http://169.254.169.254/`, `http://localhost/`, a hostname resolving to a private address, and a public URL that redirects to `http://127.0.0.1/` (the transport is asserted to be called once). Plus IPv6, mapped v4, decimal/hex/octal IP forms, `.local`, `.internal`, `.ts.net`, credentials, redirect cap, byte cap, timeout, DNS rebinding pin.
- Audit: fixtures run through the real old handler (extracted from `review-server.js` into a `vm`, stub `fetch`) and the port; outputs deep-equal over an exhaustive signal grid, the WordPress precedence cases, and a seeded random set; error shape equal.
- Files: traversal, symlink (file and directory), absolute path, encoded dots, NUL, dotfile, backup-name refusal, size and shape limits, backup before write, prune keeps 10 and touches only pattern matches, temp file cleaned on failure.
- Service: non-approver, unset allowlist, stale `baseSha256`, unknown slug, slug outside the output dir, audit row exists before the write, failed write, replay, in-flight lock.
- Structural: only `demo-files.ts` writes files; only the service imports it; router session-only with no REST; the only anonymous route is the preview controller and it has no write; contracts have no `url`, `path`, `slug` or `reviewer` field.
- Existing gates untouched: no-send spec, job wiring, decision door.

## Risks

- Real-browser behaviour of the sandbox, the bridge and CORP/CORS on assets is not testable here (no runnable browser). It is covered by header assertions and a bridge test against a fake window, and reported as NOT verified.
- The audit fetch must not be a way into the tailnet: see "Residual SSRF risk" in the as-built section.
- Complexity cap 62: pure helpers.

## As built (Slice 2b, departures from the plan above)

**Screenshots were built.** The plan above said "not built (blocked)". The first install of the browser would not start (nine missing libraries, root needed). The coordinator then allowed a rootless fix, so the feature was built and is live-tested. Everything below about the browser is what was actually done.

### What was installed for screenshots (all under `~/.cache/leadgen-browser`, user `danio`, no sudo, no `apt install`)

| Item | Detail |
| --- | --- |
| Browser | `chrome-headless-shell` 153.0.8010.52 (Chrome for Testing, Stable), from `storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/linux64/chrome-headless-shell-linux64.zip`. The source publishes no checksum file; Google Cloud Storage sends an `x-goog-hash: md5=` header and the downloaded file matched it (md5 `2d32adf1c0bcaf66602c32faa645749a`). sha256 recorded: `944dc1eae654637fed4d57650198774f9c43b45f34e48febb84f43c541b5de76`. Zip 119,702,187 bytes, unpacked 261 MB, in `chrome-headless-shell/linux-153.0.8010.52/`. |
| Libraries | 12 Ubuntu 26.04 packages fetched with `apt-get download` (apt checks the archive signatures; the trusted keys are Ubuntu's own) and unpacked with `dpkg -x` into `libs/` (2.5 MB; the `.deb` files, 784 KB, stay in `debs/`): libasound2t64 1.2.15.3-1ubuntu1.1, libatk-bridge2.0-0t64 2.60.4-0ubuntu0.1, libatk1.0-0t64 2.60.4-0ubuntu0.1, libatspi2.0-0t64 2.60.4-0ubuntu0.1, libgbm1 26.0.8-1ubuntu0.3, libxcomposite1 1:0.4.6-1build1, libxdamage1 1:1.1.7-1, libxfixes3 1:6.0.0-2build2, libxi6 2:1.8.2-2, libxrandr2 2:1.5.4-1build1, libxrender1 1:0.9.12-1build1, libxres1 2:1.2.1-1build2. The last three were transitive (found by `ldd` after the first nine). |
| Total | 264 MiB under `~/.cache/leadgen-browser` (270,220 KB). |
| Launch shape | `chrome-headless-shell --headless --disable-gpu --hide-scrollbars --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-sync --disable-default-apps --disable-component-update --no-first-run --mute-audio --remote-debugging-port=0 --window-size=1280,900 --user-data-dir=<fresh temp dir> about:blank`, spawned with an environment of exactly `PATH`, `HOME` (the temp dir), `LANG` and `LD_LIBRARY_PATH` (the two library folders). `LD_LIBRARY_PATH` exists only in that child's environment; a test fails if any file sets it on the API process. The API's own environment (database URL, tokens) is never handed to the browser. |
| Browser sandbox | ON by default (branch `feat/leadgen-ui-sandbox`). The launch arguments no longer contain `--no-sandbox`. `--no-sandbox` is added only when `LEADGEN_BROWSER_NO_SANDBOX` is exactly `yes` (an unsafe fallback for hosts where the sandbox cannot start; documented in `.env.example`). There is no automatic fallback: if Chrome cannot start its sandbox (stderr `No usable sandbox`, seen as rc 133 before the AppArmor profile that lets only `chrome-headless-shell` create user namespaces), the capture fails with `browser sandbox could not start; see plan.md` (HTTP 503 from `leadgenShots.capture`), `leadgenShots.status` reports `available: false` with the same text for 5 minutes (then it tries again, so it recovers once the profile is loaded), and an older cached picture, if any, is shown with a note. Live check with the profile loaded: sandbox-on launch of `chrome-headless-shell --headless --disable-gpu --screenshot=... https://example.com` succeeded (rc 0), and the full live script (real screenshot of elitesystemsdesign.com through the service) passed with the sandbox on. |
| Live proof | A real capture of `https://elitesystemsdesign.com` (562,452 byte PNG, HTTP 200, 2.8 s). A non-existent host is refused ("could not resolve") and no picture is cached; the first raw run showed why this matters: the old code's `size > 1000` check would have cached Chrome's 5,289-byte "site can't be reached" page as if it were their site. |

### Screenshot design

Endpoints take a lead id. `leadgenShots.capture` looks up that lead's website, checks it with the same guard as the audit, then drives the browser over the DevTools protocol (a WebSocket to the browser the API itself started, on 127.0.0.1, no HTTP fetch). Before navigating it turns on a request filter: any request to a non-public literal address, an internal host name, or a non-http(s)/data/blob scheme is failed by the browser. After the page loads, every document response (main frame, redirects, iframes) must have come from a public address, or the picture is discarded and never taken. A navigation error is a failure, not a picture. Pictures are cached under `LEADGEN_SHOT_CACHE_DIR` (default `/data/leadgen/crm-shots`), named `<lead id>.<sha1 of the URL, 10 chars>.png`, 14 days, at most 400 files or 300 MB, oldest evicted, one picture per lead. A forced re-capture inside 60 seconds is answered from the cache. Three browsers at most; two viewers of the same lead share one browser. If a re-capture fails and an older picture exists, the older one is shown with a note. The image reaches the page through `GET /api/leadgen/shot/<lead id>`, which needs a session, takes no URL, and only reads the cache.

### Residual SSRF risk (plainly)

- **Audit (`leadgenAudit.run`).** The connection is pinned to the address the guard validated (so DNS rebinding cannot swap it), every redirect hop is re-checked, the cap is 5 hops, 2 MB and 10 s. The port is not restricted: any port on a public address can be probed, which only matters if a lead's website is set to point somewhere hostile, and the response is never shown. Compressed bodies are capped after decompression. Risk left: low.
- **Screenshots.** The browser resolves DNS itself. The guard resolves the name once before launching; the browser may resolve it again, so a hostile name could answer differently the second time. Literal addresses, known internal names and every redirect/frame that reports a private address are caught (blocked before, or discarded after). A sub-resource (an image or script) on a public-looking name that resolves to a private address is not caught: the browser would make one blind GET to it and nothing from the response reaches the user. Closing that fully needs a network namespace or an egress proxy, which needs root. The browser-sandbox gap from the first build is closed: Chrome now runs with its own sandbox (default on) once the AppArmor profile is installed, so a hostile page that exploits the renderer no longer runs with the full rights of `danio`. Only if someone sets `LEADGEN_BROWSER_NO_SANDBOX=yes` does that risk return. The DNS-level gap above remains. Risk left: low-medium, dominated by the sub-resource GET gap.

### Where the spec was silent, and what was chosen

1. **Build records.** `lg_build` is empty and `manifest.json` names 2 of the 75 output folders. A "build record" is the lead's own mirrored Demo Site URL: its slug, resolved with the existing prefix rule, must name an existing folder holding `index.html`. Nothing takes a slug or path from the caller.
2. **Demo file access is a signed link, not the session cookie.** A sandboxed frame has an opaque origin, so its image and CSS requests do not carry the session cookie (confirmed in Chrome: the page request carried it, the asset requests did not). The link is minted by a session-only, no-REST tRPC call, lasts 15 minutes, names one folder, and is signed with a key made at API start (a restart invalidates links; no secret is stored). The route is the one `@AllowAnonymous()` in the leadgen module and is read-only. Anyone holding a live link can read that demo's files, which are the same files the public Cloudflare copy serves.
3. **Backups.** Kept outside the deployed folder, in `LEADGEN_DEMO_BACKUP_DIR/<slug>/`, named `index.<ISO time with : and . as ->.bak.html` as before. The last 10 are kept per demo. Pruning removes only names matching the exact pattern.
4. **Stale-file check.** The page sends the hash of the file it loaded. A save is refused (409) if the file changed since, for example after a rebuild or an edit in the old dashboard.
5. **Old-dashboard links removed** from the CRM pages (Preview, Screenshot, Open the review dashboard) and the helper code deleted, so retiring ports 8767/8768 leaves no dead link. A test pins it.
6. **Audit input normalisation.** The audit uses the same `safeHttpUrl` the pages already use, so a website stored without `https://` is audited over https. The old code answered `400 bad url` for that. A lead with no usable website still gets `bad url`.
7. **Audit truncation.** A page over 2 MB is scored on its first 2 MB (the old code read it all). Not observed on any real site.
8. **Auto-advance** after a saved decision moves to the next card, else the previous one.
9. **Editing needs the decision allowlist** (`LEADGEN_DECISION_APPROVERS`). Viewing the local copy and running an audit or screenshot needs only a session.

### Audit port, quirks recorded (not fixed)

- The WordPress check in the old code is `html.includes('wp-content') && html.includes('Genesis') || html.includes('Divi')`. `&&` binds tighter than `||`, so the word "Divi" alone triggers the signal. The port keeps that behaviour (written with explicit brackets that mean the same thing) and a test pins it.
- `startsWith('https')` is case sensitive and looks at the address as given, not the final address after redirects. Kept. `HTTPS://x` scores as "HTTP only".
- The copyright regex accepts `2010-`, `2015&` and `&copy; 2012`, not `(c)` or the character (c). Kept.
- Equality with the old handler is proved by running the real `review-server.js` audit block in a `vm` against 1,754 generated pages (exhaustive over which signals are present, plus a seeded random set). Breaking a weight, a threshold, the precedence, or the year fallback each turns it red.

### How an edited demo reaches the live URL (summary of the finding above)

It does not. Save writes the local file only and the UI says "Saved locally, not yet live" and prints `cd /data/leadgen/site-generator && bash deploy-demo.sh <slug>`. Cloudflare changes only when that runs (by hand, or in the nightly job for a demo it just built or reworked, which replaces the local file and so also discards the edit). Deploying republishes the same alias URL that leads already have, so it changes what an emailed lead sees. No auto-redeploy was added. The page cannot tell whether a later deploy happened, so it never says "live".

### Tests that exist now (and were shown able to fail)

API: 802 tests in `test/leadgen-*.spec.ts` across 27 files (514 across 19 files at 9896ad4, so 288 are new). New: SSRF guard (87), audit port and old-code equality (9), audit service (12), demo files and tokens and bridge (66), demo edit service and preview route (34), shots (44), structural door (29), preview route through Nest + helmet (7). Live scripts, run once: `leadgen-demo-edit.live.ts` (crm_dev, temp output dir, 11 checks), `leadgen-outbound.live.ts` (real resolver, one public URL, real browser, loopback trap server that saw 0 requests, 20 checks), `leadgen-demo-sandbox.live.ts` (real Chrome, 15 checks; a naive same-origin variant fails 8 of them). App: 234 tests. Break-on-purpose runs were done for every guard listed in the final report.

### Sandbox default (follow-up)

See the "Browser sandbox" row in the install table. Tests: default argument list has no `--no-sandbox`; the flag is added only for exactly `yes` (nine other values checked); the source contains the flag once, inside that branch; a fake browser that prints `No usable sandbox` and exits 133 gives the clear error, is launched once, and is never retried with the flag; the service returns a 503, reports it in status and recovers after 5 minutes; a cached picture is shown with a note. Each was shown red by breaking the code (flag always on, opt-in ignored, `!== false` instead of `=== true`, sandbox text not recognised, error kind wrong, service forcing the flag, wrong status code, and a deliberate automatic retry with `--no-sandbox`).

### Before any deploy

Apply migration `20260921000000_leadgen_demo_edit` to production (create table only; it is applied to `crm_dev` only and `prisma migrate diff` shows 0 drift there and exit 2 against prod, as expected). Keep `LEADGEN_DECISION_APPROVERS` set. The API user needs write access to `/data/leadgen` for the two new folders (created on first use). The service must run with `HOME=/home/danio` so the browser is found (check `leadgenShots.status` says `available`).
