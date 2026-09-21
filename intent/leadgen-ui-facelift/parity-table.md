# Parity table: old review dashboard and prospect page vs the CRM console

Written before the 2b code, as `spec-slice2b.md` Step 0 requires. Sources read line by line: `approval-queue/review-server.js` (595 lines), `dashboard.html` (303), `prospects.html` (237), `site-generator/deploy_and_link.js`, `deploy-demo.sh`. The ops dashboard (port 8768) is in `ops-feature-table.md`.

Status vocabulary: **S1** built in Slice 1, **2a** built in Slice 2a, **2b** to build in this slice, **BLOCKED** to build in 2b but the host cannot run it (see the last section), **DROPPED** intentionally dropped, with a reason Danio can overrule. A "changed" row is built, but behaves differently on purpose.

## A. Endpoints in `review-server.js`

| # | Old endpoint | What it does | New home | Status |
| --- | --- | --- | --- | --- |
| A1 | `GET /` | Review dashboard page | Review tab | S1 |
| A2 | `GET /prospects` | Prospect triage page | Triage tab | S1 |
| A3 | `GET /api/leads` | Leads with a demo URL and a parsed slug, with build info | `leadgen.reviewList` / `leadDetail` | S1. Old also returned `hasLocal`, `isV2`, `mtime` per row: `isV2` is S1 (`build`), `hasLocal` and `mtime` are 2b (`leadgenDemos.info`) |
| A4 | `GET /api/prospects` | No demo, has website, not DNC, all NocoDB rows (paged), worst score first | `leadgen.triageList` | S1 (default sort is score ascending, nulls last, then name, as the old page) |
| A5 | `POST /api/save/<slug>` | Save edited demo HTML | `leadgenDemos.save` | 2b |
| A6 | `POST /api/decision` | Approve / Reject / Needs Changes | `leadgenDecisions.decide` | 2a |
| A7 | `POST /api/rework` | Rework request with notes | `leadgenDecisions.rework` | 2a |
| A8 | `GET /api/shot?url=` | PNG screenshot of their site, disk cache, 14 day TTL | Screenshot service keyed by lead id | **BLOCKED** (host lacks system libraries) |
| A9 | `GET /old/?u=` | Fetch any URL, re-serve as same-origin HTML with `<base>` | Not ported | **DROPPED** (see D1) |
| A10 | `GET /api/audit-site?url=` | Score their site 0-100 with signals | `leadgenAudit.run` (takes a lead id) | 2b |
| A11 | `GET /demo/<path>` | Serve local demo files same-origin (editable iframe) | `GET /api/leadgen/demo-preview/<token>/<slug>/...` | 2b (changed: signed link, sandboxed, see plan) |
| A12 | uncaught-exception guards, token refresh, gym/ISP `SOURCES` table | Server plumbing | Nest service, `mirror-map`, `lead-decision.rules` | S1 / 2a (no user-visible feature) |

## B. `dashboard.html` (Review)

| # | Feature | Status | Note |
| --- | --- | --- | --- |
| B1 | Filter select: Pending / Approved / Placeholder / All | S1 | CRM adds a Rejected view |
| B2 | Campaign select: all / ISP / gym | S1 | Pool select |
| B3 | Previous / Next arrows (wrap around at the ends) | S1, changed | CRM does not wrap: the list is paged (25), Previous/Next stop at page edges |
| B4 | Lead dropdown listing every lead, star for v2, "[Gym]", "SEND APPROVED", "REJECTED" | S1, changed | Replaced by the paged card list with badges. Sort is name A-Z, not v2 first (old: v2 first, then has-old-site, then name). Not rebuilt: v2 is a badge |
| B5 | v1 / v2 build pill | S1 | |
| B6 | ISP / gym source pill | S1 | |
| B7 | Meta line: service, address, contact, phone | S1 | |
| B8 | "EDITING" badge, Edit text, Save changes | 2b | |
| B9 | Edit mode = `designMode` in a same-origin iframe of the local file | 2b, changed | Same-origin is refused by the spec. Edits run in a sandboxed frame through `postMessage` |
| B10 | Save shows backup name | 2b | |
| B11 | Draft email overlay, "Not sent, draft only" badge | S1 | |
| B12 | Approve | 2a | Adds the explicit confirm step the spec requires |
| B13 | Verify (Needs Changes) | 2a | |
| B14 | Reject with a `confirm()` prompt | 2a, changed | 2a spec: Reject and Needs Changes need no confirm step. The old prompt is gone. **Danio: overrule if you want it back** |
| B15 | Rework with `prompt()` for notes | 2a | Notes textarea, required |
| B16 | Rework disabled for gym | 2a | |
| B17 | Status text after each action | 2a | |
| B18 | After a decision, advance to the next lead in the view | 2b | Added: the selection moves to the next card after a saved decision |
| B19 | "Pending" = not send-approved and not rejected (gym: no decision) | S1 | |
| B20 | Placeholder bucket held out of Pending and All | S1 | |
| B21 | Their-site pane: iframe through `/old/?u=` | DROPPED | D1 |
| B22 | "open in new tab" for their site | S1 | |
| B23 | Audit button, score + priority + signal list | 2b | |
| B24 | "No existing website on file" message | S1 | |
| B25 | New-demo pane iframes the LOCAL file `/demo/<slug>/` | 2b, changed | S1 shows the Cloudflare URL (what leads see). 2b adds a "Local copy" toggle that serves the local file for editing. Default stays the live URL |
| B26 | "No local build for this lead yet" | 2b | Shown when the slug has no local folder |
| B27 | New-demo "open in new tab" | S1 | Opens the Cloudflare URL. The local copy has no new-tab link (its link expires) |
| B28 | Links to the Ops dashboard and Prospect triage | S1 | Tabs in the same console |
| B29 | Keyboard shortcuts | n/a | The old page has none |
| B30 | Cross-host links built from `location.hostname` | S1 | |

## C. `prospects.html` (Triage)

| # | Feature | Status | Note |
| --- | --- | --- | --- |
| C1 | Search name / address | S1 | CRM also searches email |
| C2 | Decision filter: undecided / Approved / Rejected / All | S1 | Default is All (Danio 2026-09-20) |
| C3 | Campaign filter | S1 | Also market and campaign |
| C4 | Count "N of M" | S1 | |
| C5 | Row: name, pool tag, quality score pill (<30 red, <60 amber, else green), decision tag, source | S1 | |
| C6 | Detail: name, service, address, contact, phone, notes | S1 | |
| C7 | Their site as a screenshot, "re-capture" link, "could not capture" fallback text | BLOCKED | A8 |
| C8 | Open their site in a new tab | S1 | |
| C9 | Approve - worth building / Reject - skip | 2a | Triage stage: never arms sending |
| C10 | Audit button | 2b | |
| C11 | After a decision, move to the next prospect | 2b | Same helper as B18 |
| C12 | Sorted worst score first | S1 | |
| C13 | Retry button on load failure | S1, changed | React Query shows the error text. No retry button; the query retries on refocus. Minor |

## D. Intentionally dropped (Danio signs off)

| # | What | Reason | If you want it |
| --- | --- | --- | --- |
| D1 | `/old/` same-origin proxy of their site (A9, B21) | It is an authenticated open fetcher that re-serves foreign HTML on the CRM origin. The spec forbids porting it. The replacement is the screenshot (blocked, see below), the link out, and the Slice 1 opt-in sandboxed frame. While the old dashboard runs, the "Preview (old dashboard)" link still works | Not recommended |
| D2 | Confirm prompt on Reject (B14) | Decided in the 2a spec | One line in `lead-actions.tsx` |
| D3 | Wrap-around Previous/Next (B3) and v2-first ordering (B4) | The list is server-paged | Add a "v2 first" sort |
| D4 | "Retry" button on load failure (C13) | The query layer already retries | Small |

## E. What 2b adds that the old dashboard did not have

Audit takes a lead id, not a URL. Save is refused unless the file is unchanged since the page loaded. Backups live outside the deployed folder (old flow put `index.<time>.bak.html` inside the folder that `deploy-demo.sh` publishes, so every backup would go public on the next deploy). Only the last 10 backups per slug are kept. Every save has an audit row.

## F. BLOCKED: screenshots

`chrome-headless-shell` 153.0.8010.52 was installed for the `danio` user under `~/.cache/leadgen-browser` from the official Chrome for Testing source. It does not start: nine system libraries are missing and installing them needs root. Per the spec this feature is stopped and reported. Details and the exact package list are in plan.md and the final report. Everything the screenshot feature would sit on (lead-id-only endpoints, the SSRF guard) is built for the audit and is ready for it.
