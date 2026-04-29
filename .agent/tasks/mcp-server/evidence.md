# Evidence: mcp-server

## ACs

| AC  | Item                          | Status |
| --- | ----------------------------- | ------ |
| AC1 | `mcp/` package boots          | PASS   |
| AC2 | `list_macros` tool            | PASS   |
| AC3 | `get_macro` tool              | PASS   |
| AC4 | `run_macro` tool (full / range / single) | PASS |
| AC5 | `stop_macro` tool             | PASS   |
| AC6 | `list_running` tool           | PASS   |
| AC7 | `list_blocks` tool            | PASS   |
| AC8 | `MCP_RECORDER_URL` env var    | PASS   |
| AC9 | `mcp/README.md` documentation | PASS   |
| AC10| `npm run smoke:mcp` PASS      | PASS (13/13) |

## Smoke result

```
$ node scripts/smoke-mcp.mjs
[PASS] recorder server boots
[PASS] MCP initialize handshake
[PASS] tools/list includes "list_macros"
[PASS] tools/list includes "get_macro"
[PASS] tools/list includes "run_macro"
[PASS] tools/list includes "stop_macro"
[PASS] tools/list includes "list_running"
[PASS] tools/list includes "list_blocks"
[PASS] tools/list includes "export_macro"
[PASS] tools/list includes "import_macro"
[PASS] tools/call list_macros returns text content
[PASS] list_macros result is JSON-parseable array
[PASS] list_blocks returns the block dictionary

MCP SMOKE: PASS
```

## Files

- `mcp/package.json` — declares `@modelcontextprotocol/sdk@^1.0.4`, ESM, bin entry
- `mcp/index.js` — stdio MCP server, 8 tools wrapping HTTP API
- `mcp/README.md` — install + Claude Desktop / Cursor / Devin config snippets + tools table
- `scripts/smoke-mcp.mjs` — JSON-RPC roundtrip smoke (initialize → tools/list → tools/call)
- `server/package.json` — adds `npm run smoke:mcp`

## Notes

- MCP server uses `@modelcontextprotocol/sdk` 1.x stdio transport.
- All tool handlers are thin wrappers over `fetch` to the HTTP API.
- Errors from the HTTP API are surfaced via `isError: true` in the tool response so the LLM client sees them gracefully instead of the MCP server crashing.
- `list_macros` deliberately strips `steps` from the response (returning only id/name/stepCount) to keep token usage low; the agent can call `get_macro` if it wants the body.
