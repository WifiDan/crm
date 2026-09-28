# Intent — Lead Gen console cleanup (make it easy to understand and use)

**Date:** 2026-09-24 · **Owner:** Danio · **Written by:** Vera, from a live walk-through of all 8 tabs with Danio · **Follows:** `intent/leadgen-ui-facelift/` (Slices 1, 2a, 2b)

## The problem
The facelift moved the old dashboards into the CRM, but the console is hard to read. Danio asked for it to be "easier to understand and use." What he actually hits:

1. **The same words mean different things on different tabs, and the numbers disagree.**
   - "Approved" on a Review card is the *triage* decision (`approvalDecision`, "worth building a demo"). The Review **Pending** filter means *not send-approved* (`sendApproved = false`). So Pending (20) shows 19 cards badged **Approved** plus one **Sent** (a gym whose decision is `Sent`, which falls into the gym branch of `viewCondition('pending')`). It reads as a broken filter.
   - Review **All (240)** excludes placeholders; the line under it says 252 built demos. 20+215+5+12 = 252.
   - Ops, Leads and Review each derive stages their own way: Ops `pendingTriage` 0 vs Leads `NEW` 172 (stored `stage` column vs `PROSPECT AND approvalDecision IS NULL`); Ops Sent 128 vs Leads SENT 113; Replied 9 vs 6; Ready to send 20 vs READY 87; Demos built 259 vs BUILT 21 vs 252.
   - Ops "By decision" shows lowercase `pending` and a `Sent` decision value.
2. **Review:** decision buttons sit below two previews, lead facts, and notes. "Needs changes" and "Send back for rework" overlap. The draft email (the thing being approved) is hidden behind a button, and its "Not sent, draft only" tag is red like an error. "no QA" appears on every card. Notes are pipe-joined machine text. Score has no scale. The mirror-lag note appears twice.
3. **Replies:** "Awaiting your review" is filled with cards tagged "You already replied from your mail app." One lead (Fiona's Bartique) takes 5 cards. Full quoted threads are expanded. The status strip says "Sending OFF" and "You can send" side by side. Filters have no counts.
4. **Triage:** opens on All, not Undecided; Undecided has no count; every row shows score 0, so "Worst score first" does nothing; the detail pane is empty until a click.
5. **Ops** mixes business numbers with systemd units, health checks and sync files. **Jobs** shows raw `key=value` dumps and every OK run. **Leads** opens on junk DEAD rows named after street addresses. **Markets** hides that ~712 of 992 leads have no market. **Alerts** is a tab that says "No open alerts."

## What better looks like
- One vocabulary and one source for every count, used on every tab: New → Triage-approved → Demo built → Needs review → Ready to send → Sent → Replied (+ Rejected, Dead / Do not contact). A number on Ops matches the same number wherever it is clickable.
- Five tabs: **Today** (slimmed Ops, tiles link into the queues), **Triage**, **Review**, **Replies**, **Leads** (Markets as a filter). A **System** view (Jobs, Alerts, services, health, sync files) behind a header status pill that turns red on a failure. One small "Synced N min ago" indicator instead of banners.
- Each queue opens on the thing that needs Danio, shows its count, and says "All caught up" when empty. Decisions are reachable without scrolling and by keyboard.

## Constraints
- **Sending stays OFF and untouched.** No change to any send path, `sendApproved` semantics, or `lead-decision.rules.ts` write logic. `test/leadgen-no-send.spec.ts` stays green.
- **NocoDB is still the writer.** This is presentation and read-query work only. No NocoDB schema change, no new NocoDB writes.
- Count changes are in read-only SQL (`lead-views.sql.ts`, `ops.sql.ts`, `leadgen.service.ts`). The Leads `stage` column comes from the mirror; changing how it is *derived* is out of scope unless Danio says otherwise — relabel/recompute at read time instead.
- Feature branch in the dev clone (`/data/leadgen/crm-dev`), never `main`. Deploying to the pilot checkout is Danio's call.
- Must stay usable on a phone over Tailscale.

## Proposed slices
- **A — Vocabulary and counts** (fixes the trust problem first): shared stage definitions, Review filter relabel ("Needs send approval" / "Send-approved" / "Rejected" / "Placeholder" / "All built"), triage-vs-send badges distinct, Ops/Leads/Review counts from the same predicates, one sync indicator.
- **B — Review usability:** sticky decision bar with keyboard shortcuts, merge Needs changes + rework, inline email preview, notes as bullets with warnings called out, chip clean-up and status colours.
- **C — Replies:** auto-move answered threads, group by lead, collapse quoted history, one send-state label, counts.
- **D — Navigation:** 8 tabs → 5 + System pill; Triage defaults; Jobs summaries; Leads hides DEAD; Markets "No market" row.

## Open questions (Danio)
1. Slice order A → B → C → D OK, or Replies first?
2. Stage names: are the ones above the words you use? (e.g. "Send-approved" vs "Ready to send")
3. Leads DEAD rows named after street addresses — hide in the UI only, or flag them for clean-up in NocoDB?
