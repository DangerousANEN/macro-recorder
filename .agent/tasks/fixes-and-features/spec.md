# Task Spec: fixes-and-features

## Metadata
- Task ID: fixes-and-features
- Created: 2026-04-29
- Status: FROZEN
- Branch: devin/1777470057-fixes-and-features

## Original task statement
The user asked to "доделать все фичи и починить ваще" (finish all features and fix everything). They also said the prior agent that wrote `TASKS.md` and `MERGE-TASK.md` was "глупенький" (dumb) and asked us to re-evaluate which features actually matter for a real, comfortable UX, drop low-value ones, and add what's missing.

This task addresses the high-impact bugs and missing features in a single PR.

---

## Acceptance Criteria

### AC1: `break` / `continue` no longer surface as failed steps in the UI
**Current state:** In `server/player.js` `executeAtomicStep`, `case 'break'` and `case 'continue'` throw `BreakError` / `ContinueError`. The surrounding `try/catch` at the bottom of the function catches *any* thrown error and broadcasts `{ type: 'step-completed', success: false, error: e.message }` before re-throwing. As a result the editor briefly flashes break/continue as red "failed" steps before the loop unwinds.

**Acceptance criteria:**
- The catch block in `executeAtomicStep` re-throws `BreakError` and `ContinueError` *without* broadcasting `success: false`.
- `break` and `continue` cases no longer pre-broadcast `success: true` (the success broadcast is unnecessary and misleading because the step does not really "complete" — it transfers control).
- After this change, running a `loop` containing a `break` shows the break step with neutral status (no green check, no red error), the loop terminates immediately, and no `step-completed success: false` is emitted for the break itself.

**Affected files:** `server/player.js`.

---

### AC2: Atomic `delay` step
**Current state:** Pausing inside a flow currently requires inserting a `wait` step with `waitType: time` or wrapping in a 1-iteration `loop` with `delayMin`. There is no first-class "pause for N seconds" atomic block, even though it is one of the most common needs.

**Acceptance criteria:**
- A new block `delay` exists at `data/blocks/delay.json` (icon ⏸, type atomic) with fields `delayMs` (single fixed value) or `delayMin` / `delayMax` (random range, optional).
- `executeAtomicStep` handles `case 'delay'` by waiting `delayMs` ms, or a random integer in `[delayMin*1000, delayMax*1000]` if a range is given.
- The action card for it appears in the editor's "Add Step" modal under "📌 Основные".
- The editor's config modal shows the right fields when editing a delay step.

**Affected files:** `data/blocks/delay.json`, `server/player.js`, `editor/index.html`, `editor/app.js`.

---

### AC3: Atomic `assert` step (fail-fast condition check)
**Current state:** Macros can branch on conditions via `if`, but there is no way to assert that a condition holds and abort the macro if it does not. Without it, the only way to fail-fast is to combine `if` + `python` raising an exception.

**Acceptance criteria:**
- A new block `assert` exists at `data/blocks/assert.json` (icon ✅, type atomic) with fields `conditionVar`, `operator`, `compareValue`, `message` (optional human-readable message shown on failure).
- `executeAtomicStep` handles `case 'assert'`: evaluates the condition using the existing `evaluateCondition` helper. If true, the step succeeds with no further effect. If false, it throws an `Error(step.message || \`Assert failed: ${conditionVar} ${operator} ${compareValue}\`)`.
- Action card and config UI are wired so an assert step can be added and edited.

**Affected files:** `data/blocks/assert.json`, `server/player.js`, `editor/index.html`, `editor/app.js`.

---

### AC4: Atomic `screenshot` step
**Current state:** The recorder takes HTML snapshots during recording, but there is no way to take a *runtime* PNG screenshot during macro execution. Useful for debugging macros that fail intermittently or for visual evidence.

**Acceptance criteria:**
- A new block `screenshot` exists at `data/blocks/screenshot.json` (icon 📸, type atomic) with fields `saveAs` (optional file-name prefix) and `fullPage` (boolean).
- `executeAtomicStep` handles `case 'screenshot'`: calls `await p.screenshot({ path, fullPage })` writing into `data/snapshots/runtime/<macroId>/<timestamp>.png`. Path is broadcast over WebSocket as `{ type: 'screenshot-saved', path, file: 'snapshots/runtime/...png' }` so the editor can show it.
- The Express server exposes `GET /api/snapshots/runtime/:file` to serve those PNGs.
- The action card and config UI are wired.

**Affected files:** `data/blocks/screenshot.json`, `server/player.js`, `server/index.js`, `editor/index.html`, `editor/app.js`.

---

### AC5: Atomic `extract` step (regex pull from a text into a variable)
**Current state:** `read` saves the *entire* text of an element. There is no built-in way to extract a numeric ID, an email address, or a regex group from that text. Users currently work around it by appending a Python step.

**Acceptance criteria:**
- A new block `extract` exists at `data/blocks/extract.json` (icon 🔍, type atomic) with fields `source` (a `{{var}}` reference or literal), `pattern` (regex), `flags` (optional, default `i`), `group` (default `1`), `saveAs` (target variable, default `_extracted`).
- `executeAtomicStep` handles `case 'extract'`: resolves `source`, runs `new RegExp(pattern, flags).exec(source)`, stores the chosen group (or full match if `group=0`) into `vars[saveAs]`. Empty result stores `''`.
- Editor wiring (action card, config UI showing source/pattern/flags/group/saveAs).

**Affected files:** `data/blocks/extract.json`, `server/player.js`, `editor/index.html`, `editor/app.js`.

---

### AC6: Block JSON files for `browser-init`, `switch-profile`, `debug-dump`
**Current state:** `editor/index.html` already has action cards for `browser-init` and `switch-profile`, and `server/player.js` has full handlers for them. But `data/blocks/` lacks JSON definitions, so `resolveBlockDef()` falls back to the hard-coded `ACTION_ICONS`/`ACTION_NAMES` table. This works but is inconsistent and surfaces no metadata via `GET /api/blocks`. `debug-dump` exists in player.js but is invisible in the UI.

**Acceptance criteria:**
- `data/blocks/browser-init.json`, `data/blocks/switch-profile.json`, `data/blocks/debug-dump.json` exist with sensible icon/color/fields metadata.
- `GET /api/blocks` lists all three (37 entries instead of 34).
- `debug-dump` does NOT appear as a regular action card in the editor (it's an internal diagnostic — keep it discoverable via `GET /api/blocks` but hidden from the "Add Step" UI to avoid clutter).

**Affected files:** `data/blocks/browser-init.json`, `data/blocks/switch-profile.json`, `data/blocks/debug-dump.json`.

---

### AC7: Macro export / import (JSON)
**Current state:** Users cannot back up a single macro to disk or share one with another instance without manually copying the JSON file out of `data/macros/`.

**Acceptance criteria:**
- Server endpoints:
  - `GET /api/macros/:id/export` returns the full macro JSON with `Content-Disposition: attachment; filename="<name>.macro.json"`.
  - `POST /api/macros/import` accepts a JSON body matching the macro schema (with or without `id`); generates a new id if one is not present or already exists; saves the macro and returns `{ id }`.
- Editor toolbar:
  - "💾 Экспорт" button next to the macro list — downloads the currently-selected macro.
  - "📂 Импорт" button — opens a file picker, reads the JSON, POSTs to `/api/macros/import`, refreshes the macro list, and selects the imported macro.

**Affected files:** `server/index.js`, `editor/index.html`, `editor/app.js`.

---

### AC8: Duplicate step / block (context menu)
**Current state:** The context menu has Copy / Paste / Edit / Rename / Delete but no "Duplicate" option. Copying-then-pasting is two clicks where one would do.

**Acceptance criteria:**
- The context menu (and the `Ctrl+D` keyboard shortcut, when a step is focused) duplicates the selected step *or block* (with all `children`/`elseChildren`/`exceptChildren`/`finallyChildren` deep-cloned). The duplicate appears immediately after the original at the same nesting level.
- The duplicate's nested IDs (if any) are regenerated so they are unique.
- Works for atomic steps, loop blocks, if blocks, and try-except blocks.

**Affected files:** `editor/app.js`, `editor/index.html`.

---

### AC9: Sidebar macro search
**Current state:** The sidebar macro list grows linearly. Users with 30+ macros have to scroll to find one. There is no search box.

**Acceptance criteria:**
- A search input at the top of the macro list filters the list by case-insensitive substring match on macro name as the user types.
- An empty input shows all macros.
- The currently-selected macro stays selected even if filtered out (so its editor doesn't blank).

**Affected files:** `editor/index.html`, `editor/app.js`, `editor/style.css`.

---

### AC10: Smoke-test script for end-to-end audit
**Current state:** No automated way to confirm the server boots and the major API surfaces respond.

**Acceptance criteria:**
- `scripts/smoke-test.mjs` exists. When run via `node scripts/smoke-test.mjs`:
  - Starts the server in a child process on a free port (or 3700).
  - Waits for it to be reachable.
  - Hits `/api/macros`, `/api/blocks`, `/api/settings`, `/api/variables`.
  - For each endpoint, asserts HTTP 200 and prints a single-line PASS/FAIL.
  - Confirms `/api/blocks` returns a JSON object with at least `loop`, `set-variable`, `break`, `continue`, `delay`, `assert`, `screenshot`, `extract`, `browser-init`, `switch-profile`.
  - Tears down the server cleanly.
  - Exit code 0 on full PASS, non-zero otherwise.

**Affected files:** `scripts/smoke-test.mjs`, `server/package.json` (add `"smoke": "node ../scripts/smoke-test.mjs"` script).

---

## Out of scope for this PR
- TG3 macro reliability fix (separate PR).
- MCP server.
- Undo/redo.
- Watch expressions.
- Skill files / `.devin/skills/`.
- Tab switch / cookie blocks.
