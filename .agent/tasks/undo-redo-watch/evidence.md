# Evidence: undo-redo-watch

## ACs

| AC  | Item                                       | Status |
| --- | ------------------------------------------ | ------ |
| AC1 | `redoStack` + `popRedo()`                  | PASS   |
| AC2 | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z shortcuts   | PASS   |
| AC3 | Toolbar undo/redo buttons                  | PASS   |
| AC4 | Watch-expressions panel UI                 | PASS   |
| AC5 | Bare name + `{{template}}` evaluation      | PASS   |
| AC6 | localStorage persistence                   | PASS   |
| AC7 | `npm run smoke` PASS                       | PASS (36/36) |

## Smoke result

Re-running `SMOKE_PORT=3704 node scripts/smoke-test.mjs` after the changes
returns `SMOKE TEST: PASS` (36/36). No server endpoints were touched in this
PR — all changes are scoped to `editor/`.

## Implementation notes

- Redo stack is cleared by `pushUndo` so users can't get into a stale-redo state
  after editing post-undo (standard editor contract).
- `Ctrl+Y` and `Ctrl+Shift+Z` are both bound to `popRedo` so muscle memory from
  Windows or Mac users works.
- Watch expressions support two forms: a bare variable name (`bot_name`) and a
  Mustache-like template (`Profile {{idx}} → {{phone}}`). The evaluator does no
  arbitrary code execution — only variable lookup — so it's safe to persist user
  input directly.
- Storage key: `macroRecorder.watchExpressions` (JSON array of strings).
- The watch list re-renders on every `renderDebugVariables()` call so changing
  variables instantly updates the watched values.

## Files

- `editor/app.js` — `redoStack`, `popRedo`, keyboard shortcuts, watch expression UI logic
- `editor/index.html` — toolbar undo/redo buttons, watch section in debug panel
- `editor/style.css` — `.debug-watch-*` rules
- `.agent/tasks/undo-redo-watch/{spec,evidence}.{md,json}`
