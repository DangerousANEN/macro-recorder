# Evidence: agent-debug

| AC  | Item                                          | Status |
| --- | --------------------------------------------- | ------ |
| AC1 | `server/run-history.js` ring buffer           | PASS   |
| AC2 | HTTP debug endpoints                          | PASS   |
| AC3 | 5 new MCP tools                               | PASS   |
| AC4 | `node --check` clean                          | PASS   |
| AC5 | `npm run smoke` (42/42)                       | PASS   |
| AC6 | `npm run smoke:mcp` (18/18)                   | PASS   |

## Verification

```
$ SMOKE_PORT=3713 node scripts/smoke-test.mjs
…
SMOKE TEST: PASS

$ SMOKE_PORT=3714 node scripts/smoke-mcp.mjs
…
[PASS] tools/list includes "get_run_events"
[PASS] tools/list includes "get_last_failure"
[PASS] tools/list includes "inspect_running_page"
[PASS] tools/list includes "query_dom"
[PASS] tools/list includes "patch_step"
…
MCP SMOKE: PASS
```

## How an agent uses this

```
1. run_macro(id) → { runId }
2. poll get_run_events(runId, since=0) every 1-2 s
3. on error / step-failed:
     get_last_failure(runId) → { failure: { type, stepPath, selectors, error, ... } }
     inspect_running_page(runId) → outline of current DOM
     query_dom(runId, "input.search-bar")  → real candidates
     patch_step(macroId, stepPath, { fallbackSelectors: [...], cssSelector: "..." })
4. run_macro(id) again
```

No screenshots required.

## Files changed

- `server/run-history.js` — new (88 lines)
- `server/player.js` — `setCurrentRunId`, `getActivePage`, `broadcastStatus`
  hook into ring buffer.
- `server/index.js` — 4 new endpoints + `walkStepPath` + `markRunFinished`
  hook in `completeRun`.
- `mcp/index.js` — 5 new tools.
- `scripts/smoke-test.mjs` — patch-step round-trip + new endpoint shape checks.
- `scripts/smoke-mcp.mjs` — required tool list extended.
- `.agent/tasks/agent-debug/{spec,evidence}.{md,json}`
