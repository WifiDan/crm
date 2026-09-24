# Plan — Lead Gen console cleanup

**Depends on:** `intent.md`, `spec.md`. **Branch:** `feat/leadgen-ui-cleanup`. **Not deployed** until Danio says so.

## Files
API
- `lead-views.sql.ts` — pending excludes `sentAt IS NOT NULL` and decision `Sent`.
- `ops.sql.ts`, `ops.contracts.ts`, `ops.service.ts` — four new count keys.
- `leadgen.contracts.ts`, `leadgen.service.ts` — `hideDead`, `marketId: "none"`, stage facet counted without the stage filter.
App (`apps/app/app/(app)/[slug]/leadgen/`)
- new `stage-labels.ts`, `system-tab.tsx`, `reply-thread.ts` (pure quote splitter + grouping)
- `leadgen-console.tsx` (tabs, System button, Leads/Jobs), `ops-tab.tsx`, `review-tab.tsx`, `lead-actions.tsx`, `lead-parts.tsx`, `leadgen-format.tsx`, `triage-tab.tsx`, `replies-tab.tsx`
Tests
- `apps/app/test/leadgen-views-render.spec.tsx` updated; new `apps/app/test/leadgen-reply-thread.spec.ts`; `apps/api/test/leadgen-views.spec.ts` gains the pending/sent case.

## Order
1. API counts + filters, then `trpc:generate`.
2. Slice A app, B, C, D.
3. Gates: biome, `check-types` (api, app), `bun test test/leadgen-*` in api and app, no-send spec, `next build`.
4. Live read-only check of the new counts against prod numbers above (Ops needsSendApproval == Review pending).
