# Spec: replies.poll fetches only new mail, text parts only

Reads `intent.md` in this folder. Concrete design; the human reviews this, doesn't write it.

## 1. Incremental fetch (skip mail already stored)

**Cursor:** no new state table. Two facts, both already at hand:

- `MAX(imapUid)` over `lg_inbound_message` (the column already exists, just unused for this).
- The IMAP `UIDVALIDITY` of INBOX from the *last successful* poll, stored the same way
  `sentCheckBlocker` already reads job state: `LgJobRun.counters` JSON on the most recent row
  where `status = "OK"` and `job.name = "replies.poll"` (see `reply-approval.service.ts:58`,
  identical query shape, reused not duplicated). New counter key: `imapUidValidity` (string —
  IMAP UIDVALIDITY is an unsigned 32-bit value, `bigint` in imapflow's types, stored as a decimal
  string in the JSON counters column same as everything else there).

**Per run:**
1. Connect, open INBOX (unchanged). Read `client.mailbox.uidValidity` and `client.mailbox.uidNext`
   immediately after the lock is acquired.
2. Decide fetch mode:
   - **incremental** when: a last-OK run exists with a stored `imapUidValidity` that equals this
     run's `uidValidity` (string compare), AND a stored max UID exists, AND a full reconciliation
     isn't due (see §3).
   - **full** otherwise (no prior cursor, UIDVALIDITY changed — mailbox was recreated and UIDs
     were reassigned, UID cursor missing, or reconciliation due). Full mode is exactly today's
     `{ since }` 14-day window fetch — the existing safety net, never removed.
3. Incremental mode: if `lastUid + 1 >= uidNext`, there is nothing new — skip the fetch entirely
   (0 bytes, 0 IMAP FETCH command). This is the common case (a handful of replies against a poll
   every 15 minutes). Otherwise fetch range `{ uid: `${lastUid + 1}:*` }`.
4. Every run (incremental or full) still stores `imapUidValidity: String(uidValidity)` and
   `fetchMode: "incremental" | "full"` in its counters on success, so the next run can decide
   correctly and the acceptance-criteria bytes/mode are visible in Lead Gen > Jobs.

Idempotency is unaffected: `store()` already upserts by `messageId`, so an incremental fetch that
(for whatever reason) re-reads an already-stored UID is a no-op write, not a duplicate.

## 2. Text-only parts (skip attachments)

Replaces "fetch full RFC822 `source` for every candidate UID" with a two-step, per-batch fetch:

1. **Structure pass** (one IMAP FETCH over the whole candidate range): `{ uid: true, envelope:
   true, bodyStructure: true, size: true, headers: [...AUTO_HEADERS, "references", "in-reply-to"]
   }`. No body content — this is small even for a 600-message full-window fetch.
2. **Body pass** (per message): walk `bodyStructure` depth-first, preferring the first
   `text/plain` node, else the first `text/html` node (mirrors `mailparser`'s existing
   preference, and this handler's own `p.text?.trim() ? p.text : htmlToText(...)` fallback).
   Skip messages with neither (rare; today `simpleParser` would give an empty body — same
   observable outcome, not a regression to guard). Download just that part with
   `client.download(uid, part, { uid: true, maxBytes: BODY_MAX_BYTES })` — imapflow decodes both
   the MIME transfer-encoding and the charset to UTF-8 for text parts, so no hand-rolled decoding
   is needed. `BODY_MAX_BYTES = 2_000_000` (existing store-time truncation is 20,000 chars; this
   cap only bounds a pathological single message, it does not change stored output for any real
   reply).

**Rebuilding `ParsedMail` without `simpleParser`:** the four things `simpleParser` gave this
handler from raw source are all available from the structure pass:
- `messageId` ← `envelope.messageId` (same `norm()` normalization as today).
- `fromAddr` ← `envelope.from[0].address` (same `norm()`).
- `subject` ← `envelope.subject`.
- `date` ← `envelope.date` (unchanged `envelopeDate()` guard).
- `refs` ← `referencedMessageIds(headers['in-reply-to'], headers['references'])`, parsed from the
  raw header `Buffer` the structure pass returns. `sent-match.ts` already has exactly this
  unfold-and-regex parser (`referencesFromHeaders`) for the Sent folder; add a sibling
  `headerValue(headers, name)` in the same style (fold-line-aware, case-insensitive) instead of
  writing a second one, and use it for `in-reply-to` too plus the `AUTO_HEADERS` set.
- `body` ← the downloaded text part (plain as-is; html through the existing `htmlToText`).
- `AUTO_HEADERS` (`auto-submitted`, `x-autoreply`, `x-autorespond`, `x-auto-response-suppress`,
  `x-vacation-message`, `precedence`) ← same header parser.

Net effect: `parseMail()` no longer calls `simpleParser` for INBOX messages fetched this way. This
is the one behavior-risk point in the whole change — everything downstream (`classifyInbound`,
`matchLeads`, `store`) is untouched and keeps taking a `ParsedMail`, so a header/body-extraction
mismatch is the only way this regresses classification or attribution. That is exactly what the
acceptance criterion in §4 (14-day replay parity) is for.

The Sent-folder read (`readSent`) already only pulls envelope + References header — untouched,
matches the card's own read ("probably fine").

## 3. Full-window reconciliation cadence

Once per day. Tracked the same way as the UID cursor: the most recent `status: "OK"` run for this
job with `counters.fetchMode === "full"`. If none exists, or its `startedAt` is more than 20 hours
ago (buffer under 24h so a slow tick doesn't push it past a day), force `full` mode this run
regardless of what §1 step 2 would otherwise pick. 20h vs 24h margin: polls run every 15 min, so
missing one cycle costs nothing.

## 4. Bytes-downloaded counter (acceptance evidence)

New counter `bytesDownloaded`, summed across the run:
- Structure-pass: sum of `msg.size` (requested via `size: true`) is the informational "would have
  cost this much to fetch full" number — logged separately as `bytesWouldFetchFull`, NOT added to
  `bytesDownloaded` (it does not reflect what actually crossed the wire for this run).
- Body pass: sum of `meta.expectedSize` (falls back to actual content length if `expectedSize` is
  absent) from every `download()` call — this IS what was actually pulled.
- Sent-folder pass: unchanged (envelope + one header only); add its already-small byte cost too so
  the total is a true run total, not just INBOX.

Surfaced in `LgJobResult.counters` (already flows into `LgJobRun.counters` and Lead Gen > Jobs —
no new plumbing).

## 5. What does NOT change

- `store()`, `tally()`, `applyAnswers()`, `classifyInbound`, `matchLeads`, `shouldKeepExistingJudgement`.
- `imap-retry.ts` — the bounded retry wraps `attemptInbox`, which still does "connect, open INBOX,
  read messages into memory, return"; it now reads fewer/smaller messages but the retry contract
  (no side effects outside the connection, safe to redo from scratch) is unchanged.
- `MAX_MESSAGES` cap (600) — still applies to both fetch modes.
- Anything under the send path (`reply-send.service.ts`, `reply-send-rules.ts`,
  `leadgen-no-send.spec.ts` stays untouched and green).
- `LEADGEN_REPLIES_SINCE_DAYS` env var — still governs the *full*-mode window.

## Acceptance criteria (from the card, restated concretely)

1. `bytesDownloaded` visible per-run in Lead Gen > Jobs.
2. On a run with zero new mail (the common case), `bytesDownloaded` for the INBOX portion drops by
   at least one order of magnitude vs. today's ~30 MB baseline — realistically close to zero,
   since step 3 of §1 means no FETCH command is even issued.
3. Replay the last 14 days of the real mailbox (read-only IMAP against Zoho, dev clone DB) in both
   `full` mode (today's code path) and the new incremental/text-only path started from an empty
   cursor, and diff: same `messageId` set stored, same `classification` per message, same
   `matchedLeadId` per message. Any diff is a blocker, not a nuance to note.
4. `replies.poll` failure rate measured over a week post-deploy, compared against the ~5% baseline
   (already measured, both before AND after the #486 retry landed) — not a hard target, a
   before/after data point per the card.
5. Tests green, including a deliberate-break test for the STOP path (a test that mutates the new
   header-parsing path to prove it — not the old path — is what's under test, then reverts).
6. All existing gates green, `leadgen-no-send.spec.ts` untouched and passing.

## Risks — checked against source, not assumed

- `client.mailbox` timing: read imapflow 2.0.5's `getMailboxLock()` (`imap-flow.js:3731`) —
  the returned lock promise only resolves after `processLocks()` completes the IMAP SELECT, which
  is what populates `this.mailbox` (`uidValidity: bigint`, `uidNext: number`, per `types.d.ts`).
  So reading `client.mailbox.uidValidity`/`uidNext` immediately after `await
  client.getMailboxLock('INBOX')` resolves is safe — confirmed from source, not assumed.
- Prisma JSON-path filtering (`counters: { path: [...], equals: ... }`) has a precedent already in
  this codebase: `apps/api/src/agent/agent-trigger.service.ts:473`. Same pattern, reused.
