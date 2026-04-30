# macro-recorder MCP server

Stdio MCP server that exposes the running Macro Recorder HTTP API as MCP tools,
so an LLM agent (Claude Desktop, Devin, Cursor, etc.) can list, inspect, run, and
stop macros.

## Install

```bash
cd mcp
npm install
```

## Run

The MCP server is a thin wrapper around the recorder HTTP API. Make sure the
recorder is running first:

```bash
cd server && npm start  # default http://127.0.0.1:3700
```

Then the MCP server is launched per-client over stdio. Configure your MCP client
to spawn `node /path/to/macro-recorder/mcp/index.js`. Set `MCP_RECORDER_URL` to
point at the recorder if it's not on `127.0.0.1:3700`.

### Claude Desktop

`~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "macro-recorder": {
      "command": "node",
      "args": ["/absolute/path/to/macro-recorder/mcp/index.js"],
      "env": {
        "MCP_RECORDER_URL": "http://127.0.0.1:3700"
      }
    }
  }
}
```

### Cursor / Devin / Continue

Use the same `command` / `args` / `env` shape — every MCP client supports stdio
servers.

## Tools

| Tool             | Description |
| ---------------- | --- |
| `list_macros`    | List all saved macros (id, name, step count). |
| `get_macro`      | Fetch full macro JSON by id. |
| `run_macro`      | Run a macro. Args: `{id, fromStep?, toStep?}`. `fromStep == toStep` runs a single step; `toStep` alone runs **up to** that step. |
| `stop_macro`     | Stop a currently running macro by `runId`. |
| `list_running`   | List currently running macros (status / type / start time). |
| `list_blocks`    | Block (action) registry — useful for an agent constructing macros. |
| `export_macro`   | Export a macro as JSON (same shape as the editor download). |
| `import_macro`   | Import a macro JSON. Returns `{id, name}` of the saved macro. |

## Smoke test

```bash
node scripts/smoke-mcp.mjs
```

Expect `MCP SMOKE: PASS`.
