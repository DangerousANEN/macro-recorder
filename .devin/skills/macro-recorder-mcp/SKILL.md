# Macro Recorder MCP — agent operating manual

You're an LLM agent driving a browser-automation tool over MCP. Read this
skill in full before running any tool — it covers (a) how to connect, (b) how
the data model works, (c) the typical loops, and (d) the debug-without-screenshots
workflow which is the whole reason this MCP exists.

## What this is

Macro Recorder is a Node + Playwright tool. A user records actions in a
Chrome extension, edits them in a web editor (`http://localhost:3700`), and
the server replays them via Playwright. Macros are JSON arrays of "steps".

You control it through 13 MCP tools. The tools are RPCs over a real HTTP API
(`http://127.0.0.1:3700/api/...`) — if you ever need to do something the tools
don't expose, you can curl the API directly.

## Connection

The MCP server is a stdio process; the client (Claude Desktop / Cursor /
Devin / Continue) spawns `node mcp/index.js` and pipes JSON-RPC over
stdin/stdout. The server itself must already be running on port 3700.

Sanity check before any work:

```bash
# 1. Is the recorder up?
curl -sf http://127.0.0.1:3700/api/macros >/dev/null && echo OK
# 2. Are the tools wired?
list_blocks()   # returns dict of {action: {name, icon, fields...}}
list_macros()   # returns array of {id, name, stepCount}
```

If the recorder isn't running, ask the user to start it
(`cd server && npm start` on Linux/macOS, or `nssm start MacroRecorder` on
Windows). On Windows, see `docs/install-windows.md`.

## Tool inventory

### Read

| Tool | Returns | Use when |
| --- | --- | --- |
| `list_macros` | `[{id, name, stepCount}]` | Pick a macro to operate on. |
| `get_macro` | full macro JSON | Inspect/modify steps. |
| `list_running` | `[{runId, macroId, macroName, status, startTime, type}]` | Find an active runId. |
| `list_blocks` | block registry | Discover available actions when constructing macros. |
| `export_macro` | macro JSON | Same shape as `get_macro` — useful for snapshotting. |

### Write

| Tool | Args | Returns |
| --- | --- | --- |
| `import_macro` | `{macro}` (steps[], optional name) | `{id, name}` of the saved macro. id is regenerated. |
| `patch_step` | `{macroId, stepPath, patch}` | `{ok, step, stepPath}`. **The fix-without-rewriting tool.** |

### Run

| Tool | Args | Returns |
| --- | --- | --- |
| `run_macro` | `{id, fromStep?, toStep?}` | `{runId, ...}`. `fromStep == toStep` runs a single step; `toStep` alone runs **up to** that index. |
| `stop_macro` | `{runId}` | `{ok, status}`. Best-effort. |

### Debug (no screenshots needed)

| Tool | Args | Returns |
| --- | --- | --- |
| `get_run_events` | `{runId, since?}` | `{seq, events:[...]}`. Poll progress incrementally. |
| `get_last_failure` | `{runId}` | `{failure: {type, stepPath, selectors, error, ...} \| null}`. **Always check this first when something errors.** |
| `inspect_running_page` | `{runId, depth?, maxNodes?}` | `{url, title, readyState, bodyOutline, cookies, truncated}`. Structured DOM tree, not raw HTML. |
| `query_dom` | `{runId, selector, kind?, limit?}` | `{total, matches:[{tag, id, classes, text, box, visible, attrs...}]}`. `kind = "css" \| "xpath" \| "placeholder" \| "role"`. |

## Step model — the only thing you really need to know

A macro looks like:

```json
{
  "id": "uuid",
  "name": "tg3",
  "startUrl": "https://web.telegram.org/k/",
  "steps": [
    { "id": "s1", "action": "browser-init", "profileName": "alice" },
    { "id": "s2", "action": "wait", "waitType": "selector",
      "cssSelector": "#telegram-search-input, .input-search-input",
      "waitTime": "30000" },
    { "id": "s3", "action": "click",
      "cssSelector": "#telegram-search-input",
      "fallbackSelectors": [
        ".input-search-input",
        { "kind": "placeholder", "value": "Search" },
        { "kind": "role", "value": "searchbox" }
      ] }
  ]
}
```

Key fields per atomic step:
- `action` — one of `click`, `type`, `read`, `wait`, `navigate`, `scroll`,
  `press-key`, `hover`, `delay`, `screenshot`, `assert`, `extract`,
  `set-variable`, `set-cookie`, `clear-cookies`, `tab-open|switch|close`,
  `eval-js`, `browser-init`, `switch-profile`, `debug-dump`. Get the live
  list with `list_blocks()`.
- `cssSelector` — primary selector. Can be `@named` to reuse a saved selector.
- `placeholder` / `xpath` — alternate selector kinds.
- `fallbackSelectors` — array of strings (CSS) or objects
  `{kind: "css"|"xpath"|"placeholder"|"role", value, name?}`. **Always
  populate this for fragile UIs (Telegram Web, dynamic SPAs).**
- `timeoutMs` — per-step timeout in ms (default depends on action).
- `value` — typed text, navigation URL, or eval-js source — context-dependent.

Control-flow steps have `children` (and sometimes `finallyChildren`,
`elseChildren`). `loop` has `mode = count|elements|table|while`.

Variables: `{{name}}` interpolation works in most string fields. `set-variable`
writes one. `read` and `extract` write one from the page.

## stepPath grammar (for `patch_step`)

Dot-delimited path from the root `steps[]`:

| Path | Means |
| --- | --- |
| `0` | First step |
| `3` | Step at index 3 |
| `2.children.0` | First child of step 2 (e.g. inside a loop) |
| `5.finallyChildren.1` | Second step in `finallyChildren` of try-except step 5 |

`patch_step` does a **shallow merge** into the target step. So:

```
patch_step(macroId, "3", { fallbackSelectors: [...], timeoutMs: 10000 })
```

replaces those two fields and leaves everything else untouched. To remove a
field, set it to `null` and let the player ignore it (most fields tolerate
null).

## The debug loop (the whole point)

Don't take screenshots. Don't ask the user to look at the screen. The MCP
gives you everything you need.

```text
1. start = run_macro({ id: macroId })
   runId = start.runId
   lastSeq = 0

2. loop:
     ev = get_run_events({ runId, since: lastSeq })
     lastSeq = ev.seq
     for each e in ev.events:
       if e.type in {step-failed, click-failed, fill-failed,
                     macro-failed, assertion-failed, extract-failed}:
         goto FIX
     if no active run anymore: break

3. FIX:
     fail = get_last_failure({ runId }).failure
     # fail = { type, stepPath, selectors: [...tried...], error, action, ... }

     page = inspect_running_page({ runId, depth: 4, maxNodes: 200 })
     # bodyOutline is a tree; scan for plausible candidates

     # Verify with concrete queries before committing to a selector:
     cands = query_dom({ runId, selector: "input[placeholder*='Search']",
                         kind: "css", limit: 5 })

     patch_step(macroId, fail.stepPath, {
       fallbackSelectors: [
         ".input-search-input",
         { kind: "placeholder", value: "Search" },
         { kind: "role", value: "searchbox" }
       ]
     })

     # Re-run from the failed step (fail.stepPath is "<index>" for top-level)
     stop_macro({ runId })       # if still alive
     start = run_macro({ id: macroId,
                        fromStep: parseInt(fail.stepPath, 10) })
     runId = start.runId
     goto 2
```

### Reading `bodyOutline` efficiently

It's a tree of `{ tag, id?, classes?, text?, placeholder?, ariaLabel?, role?,
visible, childCount, children?[] }`. Useful filters when scanning:

- Looking for an input → grep `tag == "input"` or `tag == "textarea"` and
  prefer `visible: true`.
- Looking for a clickable thing → `tag in {a, button}` or `role in
  {button, link, tab}`. Beware: many SPAs use `<div role="button">`.
- Looking for "the search bar" → match on `placeholder`/`ariaLabel`
  containing "search" (case-insensitive).
- Truncated outline (`truncated: true`) → bump `maxNodes` or scope your
  next call to a deeper subtree by passing a smaller `depth` and re-running
  with a CSS selector via `query_dom`.

Don't scroll through the whole tree if `query_dom` can answer the question.
`inspect_running_page` is a sketch; `query_dom` is the lookup.

## Constructing a macro from scratch

```text
1. blocks = list_blocks()   # know what action types exist
2. Build the steps array. Required per step: id (any unique string), action,
   plus action-specific fields. For click/type: cssSelector + fallbackSelectors.
3. import_macro({ macro: { name, startUrl, steps } })
   → { id, name }
4. run_macro({ id })
   → debug loop
```

Always include `fallbackSelectors` for any user-visible action on a real
website. Targeting a single CSS selector on a modern SPA is a recipe for
flakiness.

## Failure cheatsheet

| Failure | Likely cause | Fix |
| --- | --- | --- |
| `click-failed` with all selectors NotFound | DOM changed / wrong CSS | `query_dom` for candidates, `patch_step` with `fallbackSelectors`. |
| `click-failed` Timeout but selector exists | Element hidden, covered, or off-screen | Add `wait` step before; or set `force: true`; or scroll to it via `scroll` step. |
| `fill-failed` ContentEditable | Input is a `[contenteditable]` (Telegram, Slack) | Use `kind: role` with `value: textbox`, or send keystrokes via `press-key`. |
| `assertion-failed` | `assert` step's condition didn't hold | Inspect the page; either the assertion is wrong (relax it) or the prior step didn't actually do its job. |
| `macro-failed` with hard-timeout | Run exceeded `MACRO_RUN_HARD_TIMEOUT_MS` (120s default) | Split macro; raise the env var; or remove a long `wait`. |

## What NOT to do

- Don't poll `get_run_events` faster than every ~500 ms — it's free but the
  server records every broadcast and you'll just churn tokens.
- Don't `patch_step` the user's macros without telling them. If a fix is
  speculative, save the result via `import_macro` under a new name.
- Don't take screenshots through `screenshot` step just to see the page —
  `inspect_running_page` is faster and structured.
- Don't bypass `run_macro` and start Playwright yourself. The server owns the
  browser; competing for it leads to file-locks and zombie processes.
- Don't write secrets into macros (cookies, tokens). Use the persistent
  variables API or env vars.

## Common API endpoints (when MCP isn't enough)

The MCP wraps these — fall back to `curl` only if you need something
exotic:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/macros` | list |
| GET | `/api/macros/<id>` | full macro |
| POST | `/api/macros/<id>/run` | start; returns `runId` |
| POST | `/api/macros/<id>/run-to/<n>` | run up to step n |
| POST | `/api/macros/<id>/steps/<n>/run` | run a single step |
| PATCH | `/api/macros/<id>/steps/<path>` | shallow merge into a step |
| GET | `/api/running` | list active runs |
| POST | `/api/running/<runId>/stop` | stop |
| GET | `/api/running/<runId>/events?since=<seq>` | poll progress |
| GET | `/api/running/<runId>/failures?last=1` | last failure |
| GET | `/api/running/<runId>/inspect?depth=&maxNodes=` | structured DOM |
| POST | `/api/running/<runId>/query-dom` | selector lookup |
| GET | `/api/blocks` | block registry |

## When you're done

Always leave the system clean:
- `stop_macro` any run you started for debugging.
- If you patched a step that didn't end up working, revert it with another
  `patch_step` — leaving half-fixed selectors makes the next run worse.
- Tell the user concretely what changed and which `stepPath`s you touched.
