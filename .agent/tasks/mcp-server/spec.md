# Task: mcp-server

Add a Model Context Protocol (MCP) stdio server so an LLM agent (Claude Desktop,
Devin, Cursor, etc.) can drive the macro-recorder remotely. The server is a thin
wrapper around the existing HTTP API.

## Acceptance Criteria

### AC1 — `mcp/` package exists
- `mcp/package.json` declares `@modelcontextprotocol/sdk` dependency, `"type": "module"`, `"main": "index.js"`, `bin: { "macro-recorder-mcp": "index.js" }`.
- `mcp/index.js` is a stdio MCP server that boots without errors when the recorder server is reachable.

### AC2 — `list_macros` tool
- Returns array of `{id, name, stepCount}` from `GET /api/macros`.

### AC3 — `get_macro` tool
- Args: `{id: string}`. Returns full macro JSON from `GET /api/macros/:id`.

### AC4 — `run_macro` tool
- Args: `{id: string, fromStep?: number, toStep?: number}`. Calls `POST /api/macros/:id/run` (or `run-to/:idx` if `toStep` set, or `steps/:idx/run` if both `fromStep == toStep`). Returns `{runId}` or run result.

### AC5 — `stop_macro` tool
- Args: `{runId: string}`. Calls `POST /api/running/:runId/stop`.

### AC6 — `list_running` tool
- Returns array from `GET /api/running` (current macro runs).

### AC7 — `list_blocks` tool
- Returns the dictionary from `GET /api/blocks` so an agent knows what step types exist.

### AC8 — Configurable base URL
- `MCP_RECORDER_URL` env var (default `http://127.0.0.1:3700`) controls which recorder instance the MCP wraps. Mentioned in `mcp/README.md`.

### AC9 — Documentation
- `mcp/README.md` documents how to install, run, and connect (Claude Desktop, Devin, etc. config snippets).

### AC10 — Smoke test
- `scripts/smoke-mcp.mjs` spawns the recorder server + MCP server, sends an `initialize` and `tools/list` request over stdio, asserts at least the 6 tools listed above are present, and exits 0 on success. Wired as `npm run smoke:mcp`.

## Procedure

1. Add `mcp/package.json`, `mcp/index.js`, `mcp/README.md`.
2. Implement tool handlers using `fetch` to the HTTP API.
3. Add `scripts/smoke-mcp.mjs` and a script entry.
4. Run smoke, commit, push, open PR #4.
