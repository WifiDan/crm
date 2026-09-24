# Intent: replies.poll fetches only new mail, text parts only

Card: Kanban #506 (Elite Integration, Local Lead Gen)

## Problem

`replies.poll` (`apps/api/src/leadgen/replies-poll.handler.ts`) re-downloads the entire 14-day
INBOX window on every run, full RFC822 source including attachments. Measured 2026-09-21 (Keel,
read-only probe of 45 real poll cycles): ~30 MB per poll, 19 messages fetched and stored even when
none are new (`fetched=19 stored=19` on a post-deploy run — the same window read again). Polls run
every ~15 minutes (~96/day), so this mailbox moves on the order of 2.9 GB/day to service a handful
of real replies.

## Who's affected

Nobody sees this directly — it's a backend job. It matters because:
- Zoho drops the IMAP socket mid-fetch on ~4-5% of polls (measured both from prod logs and Keel's
  probe), and every drop happens inside the INBOX read, after connect/open succeed. A bounded
  retry (prod 77dc936, card #486) now masks most of these, but it treats the symptom — a smaller
  transfer very plausibly drops less often. NOT proven yet: this build's acceptance criteria
  includes measuring the failure rate before/after to test that.
- The reply-send safety check refuses any send when the last successful poll didn't read Sent or
  is stale (>45 min) — see `sentCheckBlocker` in `sent-match.ts`. Poll reliability is load-bearing
  for the eventual live-send cutover, not just cosmetic.

## What better looks like

- A poll with nothing new to report does close to zero IMAP data transfer, not a repeat of the
  full window.
- When there IS new mail, only the parts needed for classification/attribution (envelope,
  relevant headers, text/plain or text/html body) are downloaded — never attachments.
- A daily full-window reconciliation still runs, so a message missed by the incremental path
  (mailbox recreated, cursor lost, etc.) is caught within a day.
- Nothing downstream of `fetchMailbox` changes: same `ParsedMail` shape, same classification,
  same attribution, same STOP handling, same idempotent upsert-by-messageId.

## Constraints (must not break)

- STOP-reply detection — a missed STOP is a compliance failure.
- Lead attribution (Phase 3 shadow agreed 11/11 with the Python scanners; cutover gate needs 20
  matched replies).
- HTML-only mail must still produce a usable body (an earlier bug judged HTML-only mail
  UNRELATED for lack of a body — do not reintroduce that class of bug).
- A re-poll must never erase a recorded judgement (`shouldKeepExistingJudgement`).
- The poll must stay idempotent (upsert by `messageId`, safe to run twice on the same message).
- The reply-send safety check's "last poll read Sent" signal (`sentFolderChecked` counter) keeps
  working exactly as today.
- Sending stays OFF. No file under the send path changes;
  `apps/api/test/leadgen-no-send.spec.ts` must still pass untouched.

## Open questions (resolved in spec.md, not here)

- Exact mechanism for tracking "what's already been fetched" between runs.
- Exact mechanism for fetching only text body parts instead of full source.
- Cadence for the full-window reconciliation fallback.

## Process

Full intent → spec → plan chain (this is a multi-session build touching a system where poll
reliability is load-bearing). Feature branch off prod, dev clone at `/data/leadgen/crm-dev` on
Joshua (`.env` `DATABASE_URL` points at PROD — tests must use `crm_dev`, never touch prod data by
hand). No `Co-Authored-By` trailer (Danio's standing instruction for this repo). Do not deploy
(merge to a production-facing branch) without Danio and Vera's confirmation first.
