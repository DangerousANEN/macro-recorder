# Macro Recorder — workflow & operations

This is a Node.js + Express + Playwright + WebSockets browser-automation tool.
The user records actions in a Chrome extension, then plays them back via
Playwright on a server with profile/proxy/2FA/SMS/captcha support.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.js` | Express HTTP API + WebSocket server. Routes for macros, snapshots, accounts, SMS, captcha, profiles, runs. |
| `server/player.js` | Macro execution engine. Orchestrates Playwright, executes steps, handles control flow. ~3000 lines — split incrementally per SRP (see `selectors.js`, `snapshot-gc.js`, `timeout.js`, `diagnostics.js`). |
| `server/selectors.js` | `resolveSelector` (`@named`), `smartClick`, `smartFill`, debug click screenshots. |
| `server/snapshot-gc.js` | Snapshot directory garbage collection. |
| `server/settings.js` | Settings + persistent vars storage. |
| `editor/` | Browser-based macro editor. `index.html` markup, `app.js` logic, `style.css` theme. |
| `data/blocks/` | JSON definitions for action types (icon/name/color/type/fields). |
| `data/macros/` | Saved macros (one JSON per macro). User content — `.gitignore`d except seed macros. |
| `data/snapshots/` | Editor + runtime screenshots. Auto-cleaned at boot (see `SNAPSHOT_GC_ON_BOOT`). |
| `mcp/` | MCP stdio server for LLM agents. |
| `scripts/smoke-test.mjs` | API smoke test. |
| `scripts/smoke-mcp.mjs` | MCP server smoke test. |
| `scripts/gc-snapshots.mjs` | Standalone snapshot GC CLI. |

## Common commands

```bash
# Server (default http://127.0.0.1:3700)
cd server && npm install
cd server && npm start

# Smoke tests
cd server && npm run smoke           # 36/36 — API contract
cd server && npm run smoke:mcp       # MCP stdio

# Snapshot GC (dry-run by default; --apply to delete)
cd server && npm run gc:snapshots
node scripts/gc-snapshots.mjs --apply --max-age-days=3 --keep=50

# MCP server (per-client over stdio)
cd mcp && npm install
node mcp/index.js  # bound to MCP_RECORDER_URL=http://127.0.0.1:3700 by default
```

## Useful environment variables

| Var | Default | Effect |
| --- | --- | --- |
| `PORT` | `3700` | Server listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `SNAPSHOT_GC_ON_BOOT` | `1` | Run snapshot GC at startup |
| `RUNTIME_SNAPSHOT_MAX_AGE_DAYS` | `7` | Boot GC threshold for runtime snapshots |
| `EDITOR_SNAPSHOT_MAX_AGE_DAYS` | `30` | Boot GC threshold for editor snapshots |
| `SNAPSHOT_KEEP_PER_DIR` | `200` | Boot GC max files retained per directory |
| `MCP_RECORDER_URL` | `http://127.0.0.1:3700` | Recorder URL the MCP server proxies |

## Key step concepts

- **Atomic steps**: leaf actions like `click`, `type`, `read`, `wait`, `navigate`, `scroll`, `assert`, `screenshot`, `extract`, `delay`, `set-cookie`, `clear-cookies`, `tab-open|switch|close`, `hover`, `eval-js`, `browser-init`, `switch-profile`, `debug-dump`.
- **Control flow**: `loop` (count/elements/table/while), `if`, `try-except`, `break`, `continue`.
- **Variables**: `{{name}}` / `{{name|filter}}` template substitution. Filters: `numbers_only`, `trim`. Saved selectors via `@name`.
- **Resilient selectors**: each step can declare `placeholder`, `xpath`, `fallbackSelectors` (CSS strings or `{kind, value, name?}` objects). Fallbacks run before site-specific heuristics.
- **Tabs**: `tab-open` / `tab-switch` / `tab-close` rebind the module-level `page` so subsequent steps execute against the new tab.

## When making changes

- Always run `npm run smoke` before opening a PR.
- For new step types: (1) `data/blocks/<name>.json`, (2) `case '<name>'` in `executeAtomicStep`, (3) action card + config section in `editor/index.html`, (4) ICONS/NAMES/load/save handlers in `editor/app.js`, (5) extend `REQUIRED_BLOCKS` in `scripts/smoke-test.mjs`.
- Don't import `@modelcontextprotocol/sdk` in `server/`. It belongs in `mcp/`.
- Keep PRs incremental — feature first, then refactor.

## Where the user actually runs things

The user runs the editor + server on Windows (`F:\\ANEN\\Desktop\\macro-recorder-debug` historically). Paths and proxies in saved macros may reflect that. When responding to user feedback that mentions Windows paths, treat them as their reality, not a bug.
