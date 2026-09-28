# Intent — Lead Gen UI facelift (review, triage, ops inside the CRM app)

**Date:** 2026-09-20 · **Owner:** Danio · **Plan ref:** CONSOLIDATION-PLAN-2026-09-14.md §6 Phase 5 ("Review/approval UI moved into the CRM app"), pulled forward · **Board:** Kanban #486

## The problem
The three pages Danio actually uses every day — prospect triage, the review/approval dashboard, and the ops dashboard — are the old standalone Node/HTML pages (`approval-queue/review-server.js` + `dashboard.html` + `prospects.html`, `ops-dashboard/server.js` + `ops-dashboard.html`). They were moved to Joshua unchanged. They are three separate tools on two ports that cross-link by hardcoded hostnames (that already broke once on 2026-09-20), they look nothing like the CRM, and the side-by-side review needs a wide screen. Danio's words: the dashboard "needs a facelift, which was supposed to be the main feature of the plan."

## What better looks like
One place — the Lead Gen area of the Comp AI CRM app on Joshua — where Danio triages prospects, reviews demo sites old-vs-new, and sees pipeline/ops health, in the CRM's own look and feel, usable on a phone over Tailscale. The old dashboards keep running, untouched, until the new pages have replaced what Danio uses.

## Constraints
- **Sending stays OFF and untouched.** `LEADGEN_REPLY_SEND_ENABLED` is not set; nothing in this work may enable, add, or route around a send path. `test/leadgen-no-send.spec.ts` must keep passing.
- **NocoDB is still the writer for lead approvals** (Python sender reads it; the 15-min mirror overwrites `lg_lead` from it). A page that writes only Postgres would silently do nothing. So Slice 1 is read-only.
- Feature branch only, never `main`. Dev clone's `.env` points at PROD — use `crm_dev` for anything that writes.
- Danio uses the dashboards from his phone on the tailnet.

## Open questions (Danio)
1. Slice 2 write path: decisions (approve/reject/needs-verification/rework) proxied to NocoDB through one guarded module, vs waiting for the Phase 5 Postgres-writer flip. Default assumed: proxy to NocoDB via one module with the same session-only + approver-allowlist pattern as `reply-approval.router.ts`.
2. Anything in the current pages he wants dropped or added (ask after he sees Slice 1).
