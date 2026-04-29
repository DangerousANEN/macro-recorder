# Task: undo-redo-watch

Add **redo** to the existing undo system, plus user-defined **watch expressions**
in the debug variables panel.

## Acceptance Criteria

### AC1 — `redoStack` and `popRedo`
- `editor/app.js` declares `let redoStack = []` alongside `undoStack`.
- `popRedo()` pushes the current state onto undo, pops from redo, re-renders.
- `pushUndo()` clears `redoStack` (standard editor contract).

### AC2 — Keyboard shortcuts
- `Ctrl+Z` / `Cmd+Z` triggers undo (existing).
- `Ctrl+Y` / `Cmd+Y` triggers redo (Windows-style).
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` triggers redo (Mac-style).
- All three preventDefault and don't fire while typing in inputs/textareas.

### AC3 — Toolbar buttons
- `↩️` undo button and `↪️` redo button visible in the editor toolbar.
- Wired to `popUndo` / `popRedo`.

### AC4 — Watch expressions panel
- New section "👁 Watch-выражения" inside the debug vars panel.
- "＋" button opens a prompt to add a new watch expression.
- Each row shows the expression, its evaluated value, and an "×" delete button.
- Clicking a row's expression text reopens the prompt to edit it.

### AC5 — Watch expression evaluation
- A bare name like `bot_name` looks up `vars[bot_name]`.
- A `{{template}}` string is expanded with current vars (multiple substitutions allowed).
- Unknown variables show `<undefined name>`.
- Values are recomputed every time `renderDebugVariables()` runs (i.e. on every var update push from the server during debug).

### AC6 — Persistence
- Watch expressions are saved to `localStorage` under `macroRecorder.watchExpressions` so they survive reloads.

### AC7 — Smoke test still PASS
- `npm run smoke` continues to PASS (the new code is editor-only and shouldn't affect server endpoints).

## Procedure

1. Extend undo system with `redoStack` and `popRedo`.
2. Wire keyboard shortcuts and toolbar buttons.
3. Add HTML section + CSS in debug panel.
4. Implement `evaluateWatchExpression`, `renderWatchExpressions`, click handlers.
5. Hook `renderWatchExpressions()` into `renderDebugVariables()`.
6. Run smoke, commit, push, open PR #5.
