# Spec — Lead Gen UI facelift, Slice 2a (decisions + rework, guarded write into NocoDB)

**Decided by Danio 2026-09-20:** (1) reply-rate tile counts LEADS (already how it works: 9 of 115; keep, add a test that pins it); (2) decisions go through ONE guarded module that writes to NocoDB (not Postgres) — the Postgres-writer flip stays Phase 5; (3) Triage default filter = "All".
**Depends on:** intent.md, spec.md (Slice 1), plan.md. Slice 1 is live in prod at b8cfc96. Branch: child of `feat/leadgen-ui`, e.g. `feat/leadgen-ui-decisions`. **No Co-Authored-By trailer in any commit message (Danio's instruction).**

## What is in scope
0. Small: Triage default filter -> "All" (not "Undecided"). Pin the reply-rate definition (distinct replied leads / initial sends) with a test.
1. **Decision actions** on Triage and Review: Approve / Reject / Needs Changes, port of `approval-queue/review-server.js` `apiDecision` (read it, lines ~377-405).
2. **Rework request** on Review: port of `apiRework` (~407-430): notes required, sets `Rework Requested`, `Rework Notes`, clears `Approval Decision` and `Send Approved`.
NOT in scope (Slice 2b, later): inline demo editing (`apiSave`), site audit, screenshots, and retiring the old ports 8767/8768 — the old dashboards stay live and unmodified.

## The rule that makes this dangerous (preserve it exactly)
`Send Approved` is the ONE field `send_daily_batch.py` trusts to email a lead. From the old code: triage and review are different gates. Only `stage='review'` + `decision='Approved'` may set `Send Approved=true`; **any other decision or stage must write `Send Approved=false`** (a Reject/Needs Changes pulls a lead out of the send queue; a triage-stage Approve never arms sending). The gym table has NO `Send Approved` column: gym review writes only the decision, no send flag. If the `Send Approved` column is missing on the ISP table the write must fail closed (503-style), because NocoDB silently discards writes to unknown columns. **Therefore an "Approve" click in the review stage authorizes a cold email at the next 08:30 run** — treat this module with the same care as `reply-send.service.ts`.

## Guard design (mirror the reply-send pattern in `apps/api/src/leadgen/`)
- ONE module (e.g. `lead-decision.service.ts`) is the only code allowed to write lead decisions/rework to NocoDB. Only one router (e.g. `lead-decision.router.ts`) may call it. Router must use the same middleware as `reply-approval.router.ts` (AuthMiddleware + SessionOnlyMiddleware, no REST exposure, no API-key path) and the `LEADGEN_REPLY_APPROVERS` allowlist idea (add a separate `LEADGEN_DECISION_APPROVERS`, default to the same account; if unset or empty, refuse everything).
- Add a structural test (like `test/leadgen-no-send.spec.ts`) that fails if any other file writes NocoDB lead rows or sets `Send Approved`. The existing no-send spec must still pass untouched.
- Single lead per call only (no bulk endpoint). `reviewedBy` comes from the session, never from the request body.
- Every decision writes an audit row in Postgres BEFORE the NocoDB call (who, lead id, table, stage, decision, previous decision + previous Send Approved read from the mirror/NocoDB, timestamp) and records the outcome after. Ambiguous outcomes (timeout) are never auto-retried. If this needs a new table it needs a migration: allowed here, additive only, and tell me.
- Read the lead's current state from NocoDB immediately before the write and refuse (409) if it changed since the page loaded (the page sends the `Decision Date`/version it saw) or if the lead is `Do Not Contact`, already sent (`Sent At` set) for an Approve, or Rejected+DNC by the screen. An approval must never be possible on a lead that fails the sender's own eligibility invariants (import them, do not re-invent: see `outreach-plan.ts` and `send_daily_batch.py eligible()`).
- Optimistic UI update from the NocoDB response only. Do NOT write `lg_lead`; the 15-minute mirror stays the only writer of `lg_lead`. Show "mirror trails by up to 15 min" wherever the state is shown.
- Confirmation UX: Approve at review shows what will happen ("this lead becomes eligible for the next 08:30 send") and needs an explicit confirm step; Reject/Needs Changes do not.

## Credentials — possible blocker, do NOT improvise
The CRM needs a NocoDB token that can PATCH records in the EI Local Leads base. Find out what token the mirror handler uses. If it is read-only or absent, STOP and report exactly what is needed; do not create tokens, do not copy the Python token into the CRM `.env`, and do not paste secret values anywhere. Danio decides where a write credential comes from (Vaultwarden is the store of record).

## Testing rules (hard)
- No test, script or dev-server run may PATCH a real lead row in NocoDB. Unit tests use a stub `fetch`/local HTTP stub; the guard tests must cover: stage/decision -> Send Approved matrix (incl. gym), missing column fail-closed, stale-version 409, DNC/sent refusal, non-approver refused, non-session refused, allowlist unset refuses, audit row written before the call and on timeout, idempotent double-click.
- A live check may only READ NocoDB (e.g. confirm the `Send Approved` column exists, compare the CRM's computed patch to what `apiDecision` would build for the same input — a pure-function equivalence test of the patch builder against the old logic is required).
- All Slice 1 gates stay green (biome, both check-types, `bun test test/leadgen-*.spec.ts`, app tests, `next build`, trpc:generate committed). Prove the new guard tests can fail by breaking the code on purpose.

## Deploy
NOT to prod. Build and test on the dev clone, commit to the feature branch, update plan.md (as-built), report. Danio decides the deploy separately because this is a send-affecting write path.
