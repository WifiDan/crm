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

## As built (2026-09-24)
- All four slices in one branch commit. Deviations: the Replies "Already answered" view is a client-side split of the existing OPEN list (no API change); System status reads the existing jobs / alerts / opsHealth queries.
- Gates: `tsc --noEmit` api + app clean; biome clean (one pre-existing warning in `apps/app/postcss.config.mjs`); api `bun test test/leadgen-` 889 pass (874 before, plus new cases); app `bun test test/leadgen-` 77 pass; `next build` compiled; `leadgen-no-send.spec.ts` green.
- Live READ-ONLY check against prod (`test/leadgen-cleanup-counts.live.ts`): Today "Needs send approval" = Review pending = **17** (was 20; the 3 dropped rows had already been sent). No sent lead left in the Review queue.
- Test copy changes are UI wording only. Every safety assertion kept: Approve for sending only through the confirm dialog, the `confirmArm` line, one iframe, sandbox flags, DNC disables every action.
- **Not verified:** how it looks in a real browser. The dev clone has no running app behind a session; the render tests cover structure, not appearance. Check on the pilot after deploy.
- **Not deployed.** Deploy = build this branch into the pilot checkout (`/data/docker/comp-crm/crm`, branch `pilot/leadgen-phase2`) and restart `crm-api` + `crm-app`. Danio decides.
