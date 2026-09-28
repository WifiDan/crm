# Spec — Lead Gen console cleanup

**Depends on:** `intent.md` (same folder). **Branch:** `feat/leadgen-ui-cleanup` (dev clone `/data/leadgen/crm-dev`). Danio said "proceed with all" (2026-09-24), so the intent's defaults stand: order A → B → C → D, the stage names below, DEAD rows hidden in the UI only (no NocoDB clean-up).

## What the numbers actually are (read from prod `lg_lead`, 2026-09-24, read-only)
The stored `stage` column (derived at mirror time by `deriveStage`) is coherent. The tabs disagree because they answer different questions under the same words:

| stage | decision | demo | sent | sendApproved | n |
|---|---|---|---|---|---|
| NEW | — | no | no | no | 159 (no website → not in Triage) |
| NEW | — | yes | no | no | 12 |
| APPROVED | Approved | no | no | no | 285 (waiting for a build) |
| BUILT | Approved | yes | no | no | 21 |
| READY | Approved | yes | no | yes | 87 (send-approved; only those with email + clean draft are "ready to send", 20) |
| SENT/REPLIED/DEAD | … | yes | yes | … | ever-sent 128, ever-replied 9 |

So: Ops "Sent 128" = ever sent; Leads "SENT 113" = currently in the Sent stage. "Ready to send 20" ⊂ READY 87. "Pending triage 0" hides 159 NEW leads with no website. Review "Pending" = demo built, not send-approved, not rejected (a different cut from Ops "Awaiting review", which only counts undecided rows).

## Changes

### A — Vocabulary and counts
- One label map (`stage-labels.ts`): NEW "New", APPROVED "Awaiting build", REJECTED "Rejected", BUILT "Needs review", READY "Send-approved", SENT "Sent", REPLIED "Replied", DEAD "Dead", each with a one-line meaning and a colour. Leads tab uses it.
- Review filters: Pending → **Needs send approval**, Approved → **Send-approved**, All → **All real demos**. Summary line: "N built demos: X real, Y placeholders." Pending no longer includes leads already sent or with decision `Sent`.
- Review card badge shows the review state (needs send approval / send-approved / rejected / sent / rework), not the triage decision. Detail shows "Triage: Approved" as a fact.
- Ops tiles relabelled and split into **Your queues** (Needs triage → Triage, Needs review → Review, using the Review "Needs send approval" predicate; Replies waiting → Replies) and **Pipeline** (Awaiting build, Send-approved not yet sent, Ready for 08:30 send, Ever sent, Ever replied, Reply rate, Do not contact, New with no website). API adds `awaitingBuild`, `needsSendApproval`, `sendApprovedUnsent`, `newNoWebsite` to the counts; existing keys keep their meaning (parity test unchanged).
- One compact sync indicator ("Synced 7 min ago", badges only when stale or mismatched, explanation in a tooltip) replaces the banner and the decision-panel mirror note.

### B — Review usability
- Detail order: header (name, state, Prev/Next) → decision panel → side-by-side → email draft → lead facts → notes. Header + decision sticky at the top of the detail on wide screens.
- Keyboard: `j` / `k` next / previous demo (ignored while typing). No keyboard shortcut for approve (it stays behind the confirm dialog).
- "Needs changes" becomes one disclosure: note box + **Request rework (rebuild the demo)** + **Mark needs changes (no rebuild)**. Both writes are unchanged; only layout and labels move.
- Draft email shown inline (subject + first lines, "Show full email"), tagged neutral "Draft — not sent".
- Notes split into bullets; lines that ask for a check (confirm/verify/redirect/parked/fail) get an amber callout.
- "no QA" chip hidden (only PASS/FAIL show). Their-site helper text moves to tooltips.

### C — Replies
- Three filters with counts: **Needs a reply**, **Already answered** (items with `answeredVia`), **Sent / discarded**.
- Items grouped by lead: newest reply is the card; older ones fold under "N earlier replies from this lead".
- Quoted history (`On … wrote:`, `>` lines, forwarded headers) folds under "Show earlier messages".
- Status strip: one plain sentence for the send state ("Sending is off on this server — you can review and edit drafts, not send."), sent-folder warning only when there is a problem.

### D — Navigation and remaining tabs
- Tabs: **Today · Triage · Review · Replies · Leads**, with count badges on Triage / Review / Replies, plus a right-aligned **System** button whose dot is green / red (failing jobs, PAGE alerts, failed health checks). Old hashes still work (`#Ops`→Today, `#Jobs`/`#Alerts`→System, `#Markets`→Leads).
- Today = Ops without the system parts. System = alerts, jobs, services/health, sync files.
- Triage opens on **Undecided** and always shows its count; empty state offers the Awaiting-build list; score badge hidden when 0; first item auto-selected on wide screens.
- Jobs: one-line human summary per job, raw counters in a disclosure; Recent runs shows problems only by default with an "All runs" toggle.
- Leads: friendly stage labels + colours, "Pool" column, DEAD hidden by default ("Show dead" toggle), stage counts no longer collapse when a stage is picked, market filter incl. "No market". Markets table moves under Leads with a "No market" row.

## Not changing
Send paths, `sendApproved` writes, `lead-decision.rules.ts`, NocoDB schema, the mirror, `deriveStage`. `test/leadgen-no-send.spec.ts` and the Approve confirm-dialog tests stay as they are.

## Risks
- Render tests pin old copy; they are updated in the same commits, keeping every safety assertion.
- `needsSendApproval` on Ops must equal the Review count; both use `viewCondition("pending")` + `PAGES_DEMO`.
