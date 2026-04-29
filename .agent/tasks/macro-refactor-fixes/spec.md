# Task Spec: macro-refactor-fixes

## Metadata
- Task ID: macro-refactor-fixes
- Created: 2026-03-25T09:27:43+00:00
- Frozen: 2026-03-25T09:28:00+00:00
- Repo root: F:\ANEN\Desktop\macro-recorder-debug
- Working directory at init: F:\ANEN\Desktop\macro-recorder-debug

## Status: FROZEN

---

## Original task statement
Critical bug fixes and modular architecture refactor for macro recorder. Three groups: critical bugs, modular architecture migration to `data/`, and UX improvements.

---

## Group 1: Critical Bugs

### AC1: Profile selector in debug mode
**Current state:** `startDebug()` in `editor/app.js:1970` sends `POST /api/macros/:id/run` with `{ debug: true, breakpoints }` but does NOT include `profileName`. The server endpoint (`server/index.js:259`) already reads `profileName` from `req.body` and passes it to the child process via `--profile` flag. The run modal has `#runProfileSelect` but debug bypasses it entirely.

**Acceptance criteria:**
- When the user clicks "🐛 Debug", the selected profile from `#runProfileSelect` (or a dedicated debug profile picker) is included in the POST body as `profileName`.
- The debug child process launches with the correct `--profile <name>` argument when a profile is selected.
- When no profile is selected, debug launches without `--profile` (current default behavior).

**Affected files:** `editor/app.js` (function `startDebug()`, ~line 1970)

---

### AC2: Scroll not blocked during debug — disable autoscroll, allow manual scroll
**Current state:** `highlightDebugStep()` in `editor/app.js:2077` calls `card.scrollIntoView({ behavior: 'smooth', block: 'center' })` on every debug pause event. The console's `renderConsole()` also auto-scrolls (`body.scrollTop = body.scrollHeight` at lines 2157, 2166). There is no way for the user to manually scroll the steps list or console while debugging — every pause event snaps the viewport.

**Acceptance criteria:**
- Autoscroll to the current debug step is **disabled by default** or toggleable via a visible UI control (e.g., a "📌 Автоскролл" toggle button in the debug controls bar `#debugControls`).
- When autoscroll is off, `highlightDebugStep()` still applies the `.debug-current` CSS class but does NOT call `scrollIntoView()`.
- Console autoscroll (`renderConsole()`) also respects a similar toggle or is disabled when the user has manually scrolled away from the bottom.
- The user can freely scroll the steps list and console during debug mode without being yanked back.

**Affected files:** `editor/app.js` (functions `highlightDebugStep`, `renderConsole`), `editor/index.html` (add toggle UI), optionally `editor/style.css`

---

### AC3: Fix loop-elements double execution bug
**Current state:** When a macro runs a `loop-elements` block, the children reportedly execute twice per iteration. The loop code in `server/player.js:626-760` re-queries elements each iteration (`p.$$(selector)`) which is correct. Potential causes:
1. The `executeSteps()` function (starting ~line 580) iterates with `for...of` over steps, and loop blocks go through the unified handler. If the loop block's children are somehow also processed as siblings after the loop completes, double execution occurs.
2. The `runStep()` export at line 1025 wraps a single step in `[step]` and calls `executeSteps()` — if called externally plus internally, steps run twice.

**Acceptance criteria:**
- A `loop-elements` block with N matching elements executes its children array exactly once per iteration (N total batches), not 2×N.
- Verified by adding a deterministic test macro: a `loop-elements` over 3 known elements, each containing a single `set-variable` that appends to a counter. After execution, the counter equals 3, not 6.
- The fix does not break `loop-table`, `loop` (count/while modes), or nested loops.

**Affected files:** `server/player.js` (function `executeSteps` and/or the loop-elements handler)

---

### AC4: Context menu (right-click) works on block containers (loop/if/try)
**Current state:** The `contextmenu` event listener in `editor/app.js:743` targets only `.step-card` elements: `e.target.closest('.step-card')`. Block containers (loop, if, try-except) are rendered as `.block-container` divs with a `.block-header` — right-clicking on the block header or the block's colored border does NOT trigger the context menu because `closest('.step-card')` returns null.

**Acceptance criteria:**
- Right-clicking on a block's header (`.block-header`) or the block container itself opens the same context menu with Copy, Paste, Edit, Rename, Delete actions.
- The context menu path is correctly set to the block's `data-path`.
- All context menu operations (copy, paste, delete, rename) work correctly for block-type steps (steps with `children`).
- Existing context menu behavior for atomic `.step-card` elements is unchanged.

**Affected files:** `editor/app.js` (contextmenu event listener at ~line 743, possibly `showContextMenu`)

---

## Group 2: Modular Architecture — `data/` directory

### AC5: Consolidate Python scripts to `data/python/`
**Current state:** Python override scripts are stored inline in macro JSON files (as `pyOverride` string fields on steps). There is also `macros/.tmp/read.py`. No `data/` directory exists at project root.

**Acceptance criteria:**
- A `data/python/` directory is created at project root.
- Shared/reusable Python scripts can be placed in `data/python/` as `.py` files.
- The player (`server/player.js`) can reference external Python files from `data/python/` (e.g., via a `pyFile` field on a step) as an alternative to inline `pyOverride`.
- Existing inline `pyOverride` on steps continues to work (backward compatible).
- If both `pyFile` and `pyOverride` are present, `pyFile` takes precedence (or vice versa — document the choice).

**Affected files:** `server/player.js`, filesystem (`data/python/`)

---

### AC6: Create modular block system in `data/blocks/` with JSON configs
**Current state:** Block types (click, type, read, loop, if, etc.) are hardcoded in `editor/app.js` (`ACTION_ICONS`, `ACTION_NAMES`, `BLOCK_ACTIONS`, `NEEDS_SELECTOR`, etc.) and `server/player.js`. There is no external block definition system.

**Acceptance criteria:**
- A `data/blocks/` directory is created at project root.
- Each block type has a JSON config file: `data/blocks/<action>.json` with at minimum: `{ "name": "<display name>", "icon": "<emoji>", "color": "<hex>", "type": "atomic|block", "fields": [...] }`.
- The editor loads block definitions from an API endpoint (e.g., `GET /api/blocks`) served from `data/blocks/*.json` files.
- `ACTION_ICONS`, `ACTION_NAMES`, and related constants in `editor/app.js` are populated dynamically from the loaded block definitions (with hardcoded fallbacks for backward compatibility).
- Adding a new block type requires only: (1) a JSON config in `data/blocks/`, (2) optionally a `.py` executor, (3) a handler in `player.js` — no editor code changes needed for rendering.

**Affected files:** `server/index.js` (new API endpoint), `editor/app.js` (dynamic loading), filesystem (`data/blocks/`)

---

### AC7: Block instances — each macro step = instance of a block definition
**Current state:** Steps in macro JSON are plain objects with `action`, `cssSelector`, `value`, etc. They have no formal link to a block definition.

**Acceptance criteria:**
- Each step in a macro remains a JSON object with `action` as the key identifier linking it to a block definition in `data/blocks/<action>.json`.
- When rendering a step card, the editor resolves the block definition (name, icon, color, fields) from the loaded definitions.
- If a block definition is missing (e.g., old/custom action), the editor renders a fallback card with a "❓ Unknown" style and the raw action name.
- Step data structure is backward-compatible: existing macros load without migration.

**Affected files:** `editor/app.js` (rendering pipeline)

---

### AC8: Persistent global variables in `data/variables/`
**Current state:** Runtime variables (`runtimeVars` in `server/player.js`) are ephemeral — lost after macro execution. Global variables are stored in `settings.json` under `variables` section and accessed via `GET/PUT /api/variables`.

**Acceptance criteria:**
- A `data/variables/` directory is created (or a single `data/variables.json` file).
- Variables marked as "persistent" survive across macro runs — they are saved to disk after each macro execution and loaded before the next.
- The existing `runtimeVars` mechanism is extended: at macro start, persistent vars are loaded into `runtimeVars`; at macro end (or on explicit save), changed persistent vars are written back.
- The editor's variables UI (settings panel) shows which variables are persistent vs. ephemeral.
- API: `GET/PUT /api/variables` continues to work, with an added `persistent: true/false` flag per variable.

**Affected files:** `server/player.js`, `server/index.js`, `server/settings.js`, `editor/app.js` (settings UI), filesystem (`data/variables/`)

---

### AC9: Unify `{{variable}}` syntax rules
**Current state:** Variable substitution happens in `resolveVars()` in `server/player.js`. Filters exist: `{{var|numbers_only}}`, `{{var|trim}}`. The syntax is used in `type`, `navigate`, `save-to-table`, and other value fields. However, usage is inconsistent — some fields resolve vars, others don't.

**Acceptance criteria:**
- Document which step fields support `{{variable}}` substitution (at minimum: `value`, `cssSelector`, `url`, `compareValue`, `count`, `tableName`, `varName` target).
- All documented fields pass through `resolveVars()` before use.
- Filter syntax is documented: `{{var|filter}}` with available filters (numbers_only, trim, and any others that exist).
- No new filters are required — just consistency and documentation.
- A `data/variables/README.md` or equivalent documents the syntax.

**Affected files:** `server/player.js` (audit all `step.*` field usages), documentation

---

## Group 3: UX Improvements

### AC10: Block disable toggle (eye icon, skip on execution)
**Current state:** No mechanism exists to disable/skip individual steps during execution. All steps in a macro always execute.

**Acceptance criteria:**
- Each step card in the editor shows a toggle icon (👁 / 👁‍🗨 or similar) that sets `step.disabled = true/false`.
- Disabled steps are visually distinct: reduced opacity, strikethrough label, or grayed out.
- `executeSteps()` in `server/player.js` checks `step.disabled` and skips the step (with a broadcast message like `type: 'step-skipped'`).
- Disabled state is persisted in the macro JSON.
- Block-level disable: disabling a loop/if block skips the entire block and all children.

**Affected files:** `editor/app.js` (step card rendering, toggle handler), `server/player.js` (`executeSteps` skip logic), `editor/style.css` (disabled style)

---

### AC11: Drag-and-drop visual indicator (line/phantom on hover)
**Current state:** Drag-and-drop exists (`editor/app.js:764+`) using `drag-over` and `drag-over-block` CSS classes on target elements. There is no insertion line or phantom preview showing WHERE the step will land.

**Acceptance criteria:**
- During drag-over, a visible horizontal line (2-3px, accent color) appears between steps at the insertion point.
- The line appears above the step-card being hovered (for "insert before" semantics) or at the bottom of a block body (for "insert into block" semantics).
- When dragging over an empty block placeholder, the placeholder highlights (already partially works).
- No phantom/ghost of the dragged element is required — just the insertion line indicator.
- The indicator disappears on `dragleave` and `drop`.

**Affected files:** `editor/app.js` (dragover handler), `editor/style.css` (insertion line style)

---

### AC12: Consolidate all user files to `data/` directory
**Current state:** User files are scattered:
- Macros: `macros/*.json` (project root level) AND `server/data/macros/` (server's own data dir)
- Profiles: `macros/profiles/` (Chrome user-data-dirs)
- Settings: `server/data/settings.json`
- Snapshots: `server/data/snapshots/`
- Python tmp: `macros/.tmp/`

**Acceptance criteria:**
- A single `data/` directory at project root consolidates all user-generated content:
  ```
  data/
  ├── blocks/          # Block definitions (AC6)
  ├── macros/          # Macro JSON files
  ├── profiles/        # Browser profile dirs
  ├── python/          # User Python scripts (AC5)
  ├── variables/       # Persistent variables (AC8)
  ├── snapshots/       # HTML snapshots
  └── settings.json    # Global settings
  ```
- The server reads/writes from `data/` at project root, not `server/data/` or `macros/`.
- Existing macros in `macros/` and `server/data/macros/` are migrated (or a migration script is provided).
- Profile directories move from `macros/profiles/` to `data/profiles/`.
- All path references in `server/index.js`, `server/player.js`, `server/settings.js` are updated.
- A `.gitignore` in `data/` ignores `profiles/` (large Chrome data), `snapshots/`, and `*.tmp`.

**Affected files:** `server/index.js`, `server/player.js`, `server/settings.js`, filesystem restructuring

---

## Constraints

1. **Backward compatibility:** Existing macros with `loop-elements`, `loop-table` action names must continue to work in the player. Old macro JSON files must load in the editor without manual migration.
2. **No frameworks:** The project uses Vanilla JS. Do not introduce React, Vue, or other frameworks.
3. **Language:** All UI text is in Russian (Cyrillic). Keep this convention.
4. **Theme:** Catppuccin Mocha dark theme. New UI elements must use existing CSS variables (`--mauve`, `--green`, `--overlay`, etc.).
5. **No extension changes for Group 1:** Chrome extension (`extension/`) should not be modified for bug fixes. Extension changes only if needed for Group 2/3 architecture.
6. **Incremental delivery:** Groups can be delivered incrementally (Group 1 first, then 2, then 3). Each group must leave the project in a working state.
7. **File encoding:** All files UTF-8.

## Non-goals

1. **New block types:** Do not add new action types beyond what already exists. The modular system enables future additions but this task doesn't create new ones.
2. **SMS API integration:** Real SMS service integration is out of scope.
3. **Cross-block drag-drop:** Moving steps between different macros via drag-drop is not required.
4. **Undo/redo for settings:** Undo stack applies only to macro step editing (already exists).
5. **Test framework:** No automated test framework setup is required. Verification is manual.
6. **Cloud sync / multi-user:** Out of scope entirely.
7. **Extension recording improvements:** No changes to how the Chrome extension records actions.

## Verification plan

### Build
- `cd server && node index.js` starts without errors on port 3700.
- Editor loads at `http://localhost:3700` without console errors.

### Manual checks — Group 1 (Bugs)
- **AC1:** Click Debug with a profile selected → verify child process args include `--profile <name>` (check server stdout or add a log).
- **AC2:** Start debug → step through several steps → manually scroll up in steps list → confirm view does NOT snap back on next pause. Toggle autoscroll on → confirm it snaps again.
- **AC3:** Create a test macro with `loop-elements` over 3 elements, each containing a `set-variable` that appends "X" to a variable. Run → variable should be "XXX" (3 chars), not "XXXXXX" (6 chars).
- **AC4:** Right-click on a loop block header → context menu appears. Copy → paste → works. Delete → block is removed.

### Manual checks — Group 2 (Architecture)
- **AC5:** Place a `.py` file in `data/python/`. Reference it from a step. Execute → Python runs.
- **AC6:** `GET /api/blocks` returns all block definitions from `data/blocks/*.json`.
- **AC7:** Load an old macro → renders correctly with icons/colors from block definitions.
- **AC8:** Set a persistent variable. Run macro. Restart server. Run another macro → variable is still available.
- **AC9:** Use `{{var}}` in `cssSelector`, `url`, `value`, `count` fields → all resolve correctly.

### Manual checks — Group 3 (UX)
- **AC10:** Toggle a step disabled → it grays out. Run macro → step is skipped in console log.
- **AC11:** Drag a step over other steps → blue/accent insertion line appears between steps at drop position.
- **AC12:** All files are in `data/` at project root. `server/data/` is no longer used. Old macros still load.

### Regression checks
- Existing macros with `loop-table`, `loop-elements`, `if`, `try-except` blocks still execute correctly.
- Nested loops (loop-table containing loop-elements) work.
- Python blocks with inline `pyOverride` still work.
- WebSocket connection between editor and server works.
- Snapshot picker in editor works.
- Profile creation/deletion in settings works.
