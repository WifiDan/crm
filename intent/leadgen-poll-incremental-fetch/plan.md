# Plan: replies.poll fetches only new mail, text parts only

Implements `spec.md` in this folder. Files, order of work, tests, risks.

## Files touched

1. **`apps/api/src/leadgen/replies-poll.handler.ts`** (main change)
   - New module-level const `BODY_MAX_BYTES = 2_000_000`.
   - New `Counters` keys: `fetchMode` (string: "incremental" | "full"), `bytesDownloaded`,
     `bytesWouldFetchFull`, `newSinceCursor` (count of UIDs actually in range, pre-download —
     useful to see "0 new" runs distinctly from "fetch skipped for another reason").
   - `run()`: after building `mailbox`, pass through the new counters from `mailbox` (mirrors how
     `attempts`/`sentFetched` already flow from `fetchMailbox`'s return value into `c`).
   - `fetchMailbox()`: after the retry-wrapped `attemptInbox` returns `{ client, inbox, cursor }`
     (see below), keep the existing Sent-read step unchanged; thread the new counters through the
     return type.
   - `attemptInbox()` / `readInbox()`: this is where the cursor decision and the two-pass fetch
     live. Split `readInbox` into:
     - `decideFetchMode(client, opts)`: reads `client.mailbox.uidValidity` / `uidNext`, calls a
       new pure helper `chooseFetchMode()` (below) with the last-OK-run info (passed in from
       `run()`, one query before `fetchMailbox` is called — cheap, keeps DB access out of the
       retry-wrapped, re-run-from-scratch `attemptInbox`).
     - `readInboxStructures(client, range)`: the structure-pass fetch (§2 step 1 of spec.md),
       returns `{ uid, envelope, bodyStructure, headers, size }[]`.
     - `downloadTextParts(client, structures)`: the body-pass (§2 step 2), returns
       `{ uid, envelope, headers, body, bytesDownloaded }[]`.
     - `pickTextPart(bodyStructure)`: pure function, depth-first walk preferring `text/plain` then
       `text/html`, returns `{ part: string; type: "plain" | "html" } | null`. Pure and unit
       testable without any IMAP client.
   - `parseMail()` replaced for the INBOX path by a new pure function `mailFromStructure(entry)`
     (in the same file or a new `reply-mail.ts` if it grows — decide during implementation,
     default to same file unless it exceeds ~40 lines) that builds `ParsedMail` from envelope +
     parsed headers + downloaded body, per spec.md §2. The Sent-folder path is untouched.

2. **`apps/api/src/leadgen/mail-headers.ts`** (new, small)
   - `headerValue(raw: Buffer | undefined, name: string): string | undefined` — case-insensitive,
     fold-line-aware, single-header extractor. Same technique as
     `sent-match.ts`'s `referencesFromHeaders`, generalized to any header name so both files can
     use one implementation. `sent-match.ts`'s `referencesFromHeaders` becomes a one-line wrapper
     around this (`headerValue(headers, "references") ?? ""`) — reuse, don't duplicate.

3. **`apps/api/src/leadgen/imap-retry.ts`** — unchanged. Confirmed in spec.md: the retry contract
   doesn't care what `attempt()` does internally.

4. **`apps/api/src/leadgen/reply-approval.service.ts`, `reply-send.service.ts`** — unchanged.
   `sentCheckBlocker` and its callers are untouched; this build only adds a sibling read of the
   same `LgJobRun.counters` column (`imapUidValidity`, `fetchMode`), never writes to the
   `sentFolderChecked` key.

5. **Tests** (new file `apps/api/test/leadgen-poll-incremental-fetch.spec.ts`, plus edits to
   `apps/api/test/leadgen-poll-retry.spec.ts`'s `FakeClient` — see below):
   - `chooseFetchMode()` unit tests (pure function, no IMAP): no prior run → full; UIDVALIDITY
     mismatch → full; reconciliation overdue (>20h since last full) → full; matching cursor,
     recent reconciliation, `lastUid + 1 < uidNext` → incremental; `lastUid + 1 >= uidNext` →
     incremental-with-nothing-new (distinguish from "skip fetch" at the call site).
   - `pickTextPart()` unit tests: single-part text/plain message (no `childNodes`, part `"1"` per
     the spec's note on imapflow's single-node special case — confirm against
     `download()`'s own handling read in spec.md, mirror it rather than reinvent); multipart
     alternative (plain + html) prefers plain; html-only prefers html; attachment-only (no text
     node) returns null.
   - `mailFromStructure()` unit tests: builds the same `ParsedMail` shape `parseMail()` produces
     today, given equivalent inputs — direct comparison test using the *same* fixture email
     serialized two ways (once as raw RFC822 for today's `parseMail(uid, source)`, once as
     envelope+headers+body for the new path) and asserting field-for-field equality. This is the
     single most important test in the whole change per spec.md's risk note.
   - `FakeClient` in `leadgen-poll-retry.spec.ts` gains `mailbox` state (`uidValidity`,
     `uidNext`) and a `download()` method, so those existing retry tests keep passing against the
     new two-pass fetch instead of silently testing a code path that no longer runs. Existing
     assertions (attempts, upserts-once, Sent tracking) must still hold — this is the regression
     gate for the retry behavior built in card #486.
   - Deliberate-break test for the STOP path: a test that asserts a message with `Subject: STOP`
     and specific keyword body classifies as `STOP` end-to-end through the new fetch path,
     PLUS a second test that feeds the *same* raw fixture through `parseMail()` (old path) and
     `mailFromStructure()` (new path) and asserts identical `classification`. If someone breaks
     header extraction later, this pair fails loudly instead of quietly under-classifying.
   - `bytesDownloaded` test: a run with 3 new messages reports `bytesDownloaded` roughly equal to
     sum of their text-part sizes, NOT their full raw-source size (assert strictly less than a
     fixture with a large embedded fake attachment would have cost).
   - `leadgen-no-send.spec.ts`: run as-is, no edits — it must still pass, proving no import from
     the send path changed.

## Order of work

1. `mail-headers.ts` + its tests (pure, no risk, unblocks everything else).
2. `pickTextPart()` + tests (pure).
3. `chooseFetchMode()` + tests (pure, takes plain data in — no DB/IMAP types leak in).
4. Wire `chooseFetchMode()` into `run()`/`fetchMailbox()`: the one new DB read (last-OK-run
   counters + `MAX(imapUid)`) happens in `run()` before `fetchMailbox()` is called, exactly like
   `idx`/`py` are loaded today — keep it out of the retry-wrapped path.
5. `readInboxStructures` + `downloadTextParts` + `mailFromStructure`, replacing `readInbox` +
   `parseMail` on the INBOX path. Update `FakeClient` in the existing retry spec alongside this
   step so that spec never goes red mid-change.
6. Parity test: `mailFromStructure` vs `parseMail` on shared fixtures.
7. Full test suite for `apps/api` (not a scoped run — per engineering discipline, scoped passes
   hide breakage outside their scope).
8. Manual 14-day replay against the real mailbox (read-only IMAP, dev clone DB `crm_dev`, never
   prod) comparing full-mode output (today's behavior) against incremental-mode-from-empty-cursor
   output, per spec.md acceptance criterion 3. This is the step that actually validates the
   parity claim beyond fixtures — do not skip it or call the build done without it.
9. Update this plan.md in the same commit if implementation departs from it.

## Tests that prove it (summary)

- Pure-function unit tests: `mail-headers`, `pickTextPart`, `chooseFetchMode`.
- Integration tests against `FakeClient`: existing retry suite (updated, not weakened) +
  new incremental-fetch suite (skip-when-nothing-new, fetch-only-range-since-cursor,
  full-mode-fallback-on-UIDVALIDITY-change, full-mode-forced-by-reconciliation-age).
  parity fixture-based) + parity/STOP deliberate-break pair) +
  `bytesDownloaded` accounting.
- `leadgen-no-send.spec.ts` untouched, still green.
- Manual 14-day replay (not a CI test — a one-time acceptance check against real mail, logged on
  the card with counts, per spec.md criterion 3).

## Risks

- Header parsing divergence from `simpleParser` is the main regression surface (spec.md §2) —
  mitigated by the parity test pair and the manual replay, both required before calling this done.
- `bodyStructure` shape for unusual messages (multipart/mixed with nested multipart/alternative,
  inline images before the text part, etc.) — `pickTextPart`'s depth-first walk must be tested
  against at least one such nested fixture, not just flat single/multipart cases.
- DB migration: none required (spec.md §1 deliberately avoids a schema change) — lowest-risk
  option available, confirmed against existing `LgJobRun.counters` + `LgInboundMessage.imapUid`
  columns already in the schema.

## Deploy

Feature branch `feat/leadgen-poll-incremental-fetch`, pushed freely (no ceremony per git push
policy). PR against `pilot/leadgen-phase2` (the branch actually running in prod — confirmed by
reading `/data/docker/comp-crm/crm`'s checked-out branch and HEAD commit on Joshua, not assumed
from `origin/release`, which is behind and does not contain the #486 retry fix either). No merge
without Danio + Vera notified and confirmed first.
