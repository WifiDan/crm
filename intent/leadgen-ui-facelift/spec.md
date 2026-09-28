# Spec — Lead Gen UI facelift, Slice 1 (read-only)

**Depends on:** intent.md (same folder). **Repo:** WifiDan/crm fork, dev clone `/data/leadgen/crm-dev` on Joshua, branch `feat/leadgen-phase3` (or a child branch off it, e.g. `feat/leadgen-ui`). Feature branch only.

## Scope — Slice 1: three read-only views under the existing Lead Gen area
Existing: `apps/app/app/(app)/[slug]/leadgen/` has `page.tsx`, `leadgen-console.tsx` (Jobs/Alerts/mirror status), `replies-tab.tsx`. Extend it; do not create a parallel app. Follow the CRM's own components and styling (shadcn, `apps/app/components`, `apps/app/CLAUDE.md`, `AGENTS.md`).

1. **Triage** — port of `approval-queue/prospects.html` + `/api/prospects`: unreviewed prospects per market/campaign, filterable, sortable, sized for 900+ rows (server-side pagination — the "992 rows truncated to 200" bug class is a named risk; add a count assertion test).
2. **Review** — port of `approval-queue/dashboard.html` + `/api/leads`: queue of built demos with QA status/flags, and the **old site vs new demo side-by-side**. On narrow screens it must be a usable tabbed/toggle view, not a broken wide layout. Demo URLs are Cloudflare Pages branch aliases (`https://<slug>.ei-leadgen-demos.pages.dev`). The old-site pane depends on the `/old/?u=` header-stripping proxy in `review-server.js`; read how it works, and if the CRM cannot host an equivalent safely, link out to the old dashboard's proxy for that pane and say so plainly — do not weaken iframe/security headers on the CRM app itself.
3. **Ops** — port of `ops-dashboard/` (`server.js` endpoints + `ops-dashboard.html`): pipeline counts, systemd service health, sent/eligible per tier, standing tasks (`/data/leadgen/ops-dashboard/standing-tasks.json`), CRM sync status. Reuse what `leadgen-console.tsx` already shows rather than duplicating it; add only what is missing. **First produce a feature-by-feature table (old ops dashboard vs CRM console) so nothing is silently dropped.**

Data source: the `lg_*` tables via tRPC (`leadgen.router.ts` pattern; regenerate `src/generated/server.ts` after router changes). Read-only. No NocoDB writes, no `lg_lead` writes, no new job handlers.

## Out of scope (Slice 2, needs Danio's review of Slice 1)
Approve / Reject / Needs-Verification / Rework buttons, inline demo editing (`/api/save`), site audit, screenshots, retiring the old ports.

## Acceptance
- Gates from the memory notes all green: biome, `check-types` in `apps/api` and `apps/app`, `bun test test/leadgen-*.spec.ts` (incl. no-send spec and job-wiring spec), `trpc:generate` output committed.
- New tests: list endpoints paginate and total-count matches the table; a filter test; narrow-viewport layout check (screenshot via the dev app if feasible, otherwise state it was not verified).
- Row counts on the Triage/Review pages match the old dashboards' `/api/prospects` and `/api/leads` for the same moment (compare, report both numbers).
- Old dashboards (8767/8768) unmodified and still running.
- **Not deployed to prod.** Build + test on the dev clone, commit to the feature branch, write `plan.md` first, report back. Deploy follows the recipe in the project memory only after Vera/Danio review.

## Risks
- Old-site proxy (see above). · Mirror lag (up to 15 min) means CRM pages can trail NocoDB — show the last-mirror time on each page. · Dev `.env` points at prod DB — read-only work is safe, any migration/test write goes to `crm_dev`.
