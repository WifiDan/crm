# Ops dashboard (port 8768) vs CRM Lead Gen console — feature table

Written before the build, as spec.md requires. "CRM before" is `leadgen-console.tsx` at a991328. "Slice 1" is what the Ops, Triage and Review tabs add. Nothing is dropped without a reason in the last column.

| # | Old ops dashboard feature | CRM before | Slice 1 | Note |
| --- | --- | --- | --- | --- |
| 1 | Tile: total leads | Leads tab total | Ops tile (mirror total, split ISP / gym) | Same source as Leads tab |
| 2 | Tile: pending triage | none | Ops tile + Triage tab | Old rule: no demo, has website, not DNC, no decision |
| 3 | Tile: side-by-side built | none | Ops tile + Review tab | Ops shows all rows with a demo URL (258). Review shows only rows with a Pages slug (251), as the old `/api/leads` did |
| 4 | Tile: sent | Leads tab, stage SENT | Ops tile | Count of `sentAt` set, as `pipeline_status.py` |
| 5 | Tile: reply rate | Replies tab lists replies | Ops tile: replied leads / sent leads | Changed: old page ran IMAP via `fetch_replies.py` (45 s, 5 min cache). CRM uses `repliedAt` from the poller. Label says so |
| 6 | Tile: awaiting review | none | Ops tile + Review "pending" view | Old rule kept: no decision, has demo, no rework flag |
| 7 | Tile: ready to send | none | Ops tile, per pool | `eligible()` from `send_daily_batch.py`, verbatim. Read only. Sending is untouched |
| 8 | Tile: call/text list | none | Ops tile + paginated list | 333 rows today, so it pages |
| 9 | Tile: do not contact | DNC badge per lead | Ops tile | |
| 10 | Chart: daily send velocity | none | Ops chart, from `lg_outreach_send` by UTC day | Old page merged send-log.jsonl and NocoDB. The ledger is the backfilled send-log |
| 11 | Chart: prospector yield per day (Google Places) | none | Ops chart, from `raw.CreatedAt` | |
| 12 | Bars: by source | none | Ops bars | |
| 13 | Bars: by decision | Leads tab shows derived stage, not decision | Ops bars by Approval Decision | |
| 14 | Communications tab: sent list, subject, matched replies, name filter | Replies tab (drafting and approval); Leads tab (SENT/REPLIED, name search) | Ops "Recent sends": subject, to, sent time, replied flag, name search, paged | Reply body stays in the Replies tab |
| 15 | Tasks: awaiting review (with link to review dashboard) | none | Review tab "pending" view | Link replaced by the tab |
| 16 | Tasks: call/text list (phone, contact) | none | Ops call list | |
| 17 | Tasks: rework queue | none | Ops rework list | Empty today (0 rows) |
| 18 | Tasks: standing open items | none | Ops card, reads `standing-tasks.json` | Path from `LEADGEN_STANDING_TASKS_FILE`, default the old path. Still hand-maintained |
| 19 | Health: launchd services | Jobs tab lists CRM jobs only | Ops systemd table: `leadgen-*` services and timers, `crm-api`, `crm-app` | Changed: `launchctl` is Mac Mini only. Joshua uses `systemd --user` |
| 20 | Health: review server reachability (HTTP 200 with real body) | none | Covered by the `leadgen-review-server` and `leadgen-ops-dashboard` unit state and the "review dashboard" / "ops dashboard" health checks | HTTP body probe not ported. The old probe hit `127.0.0.1:8767`, but the server binds the tailnet IP, and the probe downloads every NocoDB row |
| 21 | Health: Comp CRM sync (company map entries, deal queue pending) | Leads tab mirror status | Ops card for both files, plus mirror status and last run | |
| 22 | Health: recent errors by job (log tail grep) | Jobs tab last error, Alerts tab | Not ported as log grep. Replaced by `health-state.json` checks (nightly, maintenance, send, reply watcher, STOP scan, tokens, dashboards, CRM jobs, disk), CRM open alerts, failed jobs | Reason: log dir `~/Library/Logs/elite-integration-leadgen` does not exist on Joshua, so the old panel is empty there |
| 23 | Cross links between the three dashboards (hardcoded host) | none | Tabs in one console. Old-dashboard links use `location.hostname` + port | Removes the hostname that broke on 2026-09-20 |
| 24 | GET-only guarantee | n/a | Every new procedure is a query. A test checks the new services contain no write call | |

## Existing CRM console features that stay as they are

Jobs (run now, pause, resume), Replies (draft, approve, send path), Leads (search, stage and pool filters, mirror status), Markets, Alerts. Slice 1 does not change them.
