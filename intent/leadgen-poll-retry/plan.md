# Plan - replies.poll transient IMAP failure retry

**Branch:** `feat/leadgen-poll-retry`, child of `feat/leadgen-ui-sandbox` (ce5414f). **Request:** Danio via Vera, 2026-09-21. **Not deployed.**

## Problem

`replies.poll` (every 15 min) fails about 5% of runs. Since the 09-19 deploy: 8 FAILED `Connection not available` (0.9 to 12.7 s), 2 FAILED `getaddrinfo ETIMEOUT` (5 s), plus a 09-19/09-20 overnight block of 17 TIMED_OUT (a different, earlier event: 300 s hangs; none since 09-20 02:20). Each failure opens a PAGE alert that clears on the next success, and the reply-send safety check (`sent-match.ts`) refuses to send unless the last OK poll has `sentFolderChecked = 1` and is under 45 min old.

## Finding: which phase fails (measured, not assumed)

Stored failed runs carry only the message, no phase and no counters. So the phase was measured with a read-only probe against the real mailbox (connect, open INBOX, the same 14-day INBOX FETCH with sources, list, open Sent, envelope FETCH, logout; nothing marked, moved or deleted), 45 full cycles from Joshua:

- 2 of 45 (4.4%) failed, both `Connection not available`, `code=NoConnection`, `rejectedFrom=pendingRequest`, both at ~1.1 s **inside the INBOX FETCH**, after connect (~0.3 s) and the mailbox lock (~0.4 s) had succeeded.
- 43 connect+lock-only cycles (no fetch) earlier: 0 failures. Connect and mailbox-open are not where it fails.
- The FETCH pulls ~30 MB (19 messages with attachments; full RFC822 source) every poll. The server drops the socket mid-transfer; imapflow rejects the pending FETCH with `NoConnection`.

So the failure is mid-INBOX-read, not at connect. The request said to retry only connect/mailbox-open and, if it turns out mid-run, "do the safe thing for that phase". Safe here means: in `run()` every DB write (store, tally, applyAnswers) happens AFTER `fetchMailbox()` returns. The INBOX read only fills a local array that is discarded on failure. So the unit that is retried is "open a fresh connection, open INBOX, read INBOX", which has no side effect anywhere. Nothing that ingested, matched, classified or wrote is ever re-run.

## Changes

1. `apps/api/src/leadgen/imap-retry.ts` (new, pure, no imapflow import): `isTransientImapError`, `retryDelaysMs`, `withImapRetry`.
   - Transient only: `Connection not available` / `NoConnection`, `ETIMEOUT`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`, `socket hang up`. Auth failures are checked first and are never transient (`authenticationFailed`, `AUTHENTICATIONFAILED`, "authentication failed", "invalid credentials"). Anything unrecognised is permanent. `aborted` is never retried.
   - Max 3 attempts total. Delays about 2 s then 5 s, each jittered +/-25%. Hard window: no new attempt starts if more than 60 s have passed since the first started (the job timeout is 300 s), and the backoff wait stops on abort.
   - Failure rethrows the ORIGINAL last error object (same message, so the alert text is unchanged) with `lgCounters = { imapAttempts }` attached.
2. `replies-poll.handler.ts`: `fetchMailbox` wraps only `attemptInbox` (new client, connect, `readInbox`) in `withImapRetry`; a failed attempt closes its client and logs `attempt n/3 failed at connect|inbox`. The Sent read, its swallow-to-null behaviour, and the logout are unchanged and run once, on the successful connection. `createClient` becomes an overridable method (test seam; no DI change). New counter `imapAttempts`.
3. `job-handler.ts` + `job-scheduler.service.ts`: `failureCounters(err)` so a FAILED run row also keeps `imapAttempts` (previously counters were null on failure). Timed-out rows are unchanged (null).

## Tests (fakes only; no network, no DB write)

`test/leadgen-imap-retry.spec.ts`: classifier table; policy bounds (3 attempts, delay range, total added time under the window, window stops retries); fails N then succeeds; permanent and auth errors run once; exhaustion rethrows the last error with `imapAttempts: 3`; abort stops retrying.
`test/leadgen-poll-retry.spec.ts`: handler with a fake ImapFlow and a fake Db that records every write: drop mid-INBOX-fetch then success ingests exactly once and reports `imapAttempts: 2`; auth failure once, no writes; exhausted retries throw the last error with zero writes; a failed attempt writes nothing and its client is closed; `sentFolderChecked` and `sentFetched` are identical with and without a retry; a Sent failure is still swallowed to `sentFolderChecked = 0` and is not retried; a re-poll still keeps an existing judgement (existing regression tests untouched).
Each new test is proven able to fail by breaking the code on purpose (report in the hand-off).

## Risks

- A retry fetches another ~30 MB on the rare drop (about 5% of polls, so ~1.5 MB/h average): negligible. The real cost driver is that every poll downloads full sources; not changed here (out of scope, changes ingest behaviour). Worth a separate card.
- If Zoho throttles logins, 3 attempts inside ~10 s is 2 extra logins on a 5% path. Bounded.
- Not verifiable offline: that a retry after a real mid-fetch drop succeeds against Zoho. The probe shows the drop is per-connection (the next cycle 4 s later succeeded both times), which is the assumption the retry relies on.
