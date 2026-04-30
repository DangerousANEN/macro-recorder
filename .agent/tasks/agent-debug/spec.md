# Task: agent-debug

Add a debugging API so an LLM agent can understand a running macro without
spamming screenshots and can patch broken steps directly.

## Acceptance Criteria

### AC1 — Per-run structured event log
- New module `server/run-history.js` with `recordEvent(runId, evt)`,
  `getEvents(runId, since)`, `getLastFailure(runId)`, `getAllFailures(runId)`,
  `markFinished(runId)`.
- Bounded ring buffer (≤500 events, ≤50 failures per run).
- Auto-GC after `markFinished`.
- `server/player.js` records every `broadcastStatus` call into the buffer
  (tagged with the active runId set by `setCurrentRunId`).

### AC2 — HTTP endpoints for debugging
- `GET /api/running/<runId>/events?since=<seq>` returns `{seq, events:[...]}`.
- `GET /api/running/<runId>/failures?last=1` returns `{failure: {...} | null}`.
- `GET /api/running/<runId>/inspect?depth=&maxNodes=` returns
  `{url, title, readyState, bodyOutline, cookies, truncated}` where bodyOutline
  is a structured DOM tree (NOT raw HTML).
- `POST /api/running/<runId>/query-dom {selector, kind?, limit?}` returns up to
  N matches with `{tag, id, classes, text, placeholder, ariaLabel, role, type,
  visible, box}`.
- `PATCH /api/macros/<id>/steps/<stepPath> {patch}` shallow-merges patch into
  the step at the given dot-delimited path.

### AC3 — MCP tools
Five new tools in `mcp/index.js`:
- `get_run_events(runId, since?)`
- `get_last_failure(runId)`
- `inspect_running_page(runId, depth?, maxNodes?)`
- `query_dom(runId, selector, kind?, limit?)`
- `patch_step(macroId, stepPath, patch)`

### AC4 — `node --check` clean for all changed files

### AC5 — `npm run smoke` PASS (extended for new endpoints)
- PATCH step round-trip
- events / failures shape checks
- inspect / query-dom 404 for unknown run

### AC6 — `npm run smoke:mcp` PASS (extended for new tools)
- All 13 tools registered (8 old + 5 new).

## Out of scope

- Persisting event log across restarts.
- Multi-run concurrent inspect (player.js currently single-run-at-a-time).
- A UI panel for the debug API; agents use it via MCP / curl.
