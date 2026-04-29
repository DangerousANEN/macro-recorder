# MERGE TASK: Add Debug Mode + Control Flow from macro-builder into macro-recorder-final

## Context
This project is "macro-recorder-final" — a browser macro recorder/player with a rich UI.
We need to ADD features from a newer version called "macro-builder" (see reference files below).

## What to ADD (integrate INTO the existing code):

### 1. Enhanced Control Flow Blocks in the Editor (editor/app.js + editor/index.html)
The editor already has `loop`, `if`, `try-except` blocks. Add these NEW features:
- **Loop types**: for/while/for-each (the editor already has elements/table/count/while modes — keep those, but ensure the player supports them)
- **Break and Continue**: Add `break` and `continue` action cards in the "Add Step" modal. They should ONLY appear if the step is being added inside a loop (check ancestor chain). Show them in a new category "🔁 Управление циклом" with cards:
  - break: 🛑 "Прервать цикл" / "Выход из текущего цикла"
  - continue: ⏭ "Следующая итерация" / "Пропустить остаток и продолжить цикл"
- **Try/Catch/Finally**: The existing `try-except` already works. Add support for `finallyChildren` (a "НАКОНЕЦ" section after EXCEPT, always executes). Show this in the block render.
- **Collapsible containers** with colored left borders are already implemented ✅

### 2. Debug Mode (NEW — biggest feature)
Add a complete debug mode to the editor. This is the main addition.

#### 2a. UI changes in editor/index.html:
- Add a `🐛 Debug` button next to `▶▶ Запустить` in the toolbar
- Add a **Variables Panel** on the right side (or as a slide-out panel):
  ```html
  <div class="debug-vars-panel" id="debugVarsPanel" style="display:none">
    <div class="debug-vars-header">📊 Переменные</div>
    <div class="debug-vars-list" id="debugVarsList"></div>
  </div>
  ```
  Shows variable name, type, value. Changed variables get a highlight animation.
- Add **Debug Controls** in the console area:
  ```html
  <div class="debug-controls" id="debugControls" style="display:none">
    <button id="debugStepOver">Step Over</button>
    <button id="debugStepInto">Step Into</button>
    <button id="debugStepOut">Step Out</button>
    <button id="debugContinue">▶ Continue</button>
    <button id="debugStop">⏹ Stop</button>
  </div>
  ```
- **Breakpoints**: Click on the step number (`.step-number`) to toggle a red dot 🔴. Store breakpoint IDs.

#### 2b. Logic in editor/app.js:
- Add `debugMode` state variable
- `startDebug()` function: POST to `/api/macros/:id/run` with `{ debug: true, breakpoints: [...] }`
- Listen for WebSocket debug messages:
  - `{ type: 'debug', action: 'paused', stepId, variables, depth }` → highlight current step (orange border), update variables panel, enable debug buttons
  - `{ type: 'debug', action: 'variables', variables }` → update variables panel (highlight changed values)
  - `{ type: 'debug', action: 'finished' }` → exit debug mode
- Send debug commands via WebSocket: `{ type: 'debug', command: 'step-over' | 'step-into' | 'step-out' | 'continue' | 'stop' }`
- When debug mode is active, step cards show:
  - Current step highlighted in orange/yellow
  - Breakpoint dots on step numbers
  - If/condition results shown inline (true/false badge)

#### 2c. CSS (editor/style.css):
```css
/* Debug mode */
.step-card.debug-current { border-left: 3px solid var(--yellow); background: rgba(249,226,175,0.1); }
.step-card.debug-breakpoint .step-number::after { content: '🔴'; position: absolute; top: -2px; right: -6px; font-size: 10px; }
.debug-vars-panel { width: 280px; background: var(--mantle); border-left: 1px solid var(--surface0); padding: 12px; overflow-y: auto; }
.debug-var-row { display: flex; gap: 8px; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid var(--surface0); }
.debug-var-changed { animation: varHighlight 1s ease; }
@keyframes varHighlight { 0% { background: rgba(166,227,161,0.3); } 100% { background: transparent; } }
.debug-controls { display: flex; gap: 6px; padding: 8px; background: var(--crust); border-top: 1px solid var(--surface0); }
.debug-controls button { padding: 4px 12px; border: 1px solid var(--surface1); border-radius: 4px; background: var(--surface0); color: var(--text); cursor: pointer; font-size: 12px; }
.debug-controls button:hover { background: var(--surface1); }
```

### 3. Server changes (server/index.js):
The existing server needs these additions from the macro-builder server:

- The `/api/macros/:id/run` endpoint should accept `{ debug: true, breakpoints: [...] }` and spawn player.js with `--debug` and `--breakpoints` flags
- WebSocket broadcast functions `broadcastDebug(macroId, data)` for forwarding debug messages from the player process stdout
- Parse `__DEBUG__:` lines from player stdout and broadcast via WebSocket
- The WebSocket `onmessage` handler should forward `{ type: 'debug', command: ... }` to the player's stdin

### 4. Player changes (server/player.js):
The existing player needs to support the debug protocol:

- Accept `--debug` and `--breakpoints id1,id2` command line args
- Add `debugPause(stepId, depth)` function that:
  - Sends `__DEBUG__:{"action":"paused","stepId":"...","variables":{...},"depth":N}` to stdout
  - Waits for command on stdin (JSON line)
  - Supports: step-over (skip children), step-into (enter children), step-out (run until parent), continue (run until next breakpoint), stop (exit)
- Send `__DEBUG__:{"action":"variables","variables":{...}}` after each step
- Send `__DEBUG__:{"action":"finished"}` when done
- The existing step execution already supports recursive blocks — just add the debug hooks

### 5. Package.json
Add `"type": "commonjs"` to server/package.json to prevent ESM issues.

## IMPORTANT RULES:
- Keep ALL existing functionality working! Don't remove anything.
- Keep the Catppuccin Mocha dark theme
- All text in Russian
- The editor already has a rich UI with modals, context menus, drag-drop — preserve everything
- Test that the server starts without errors: `cd server && node index.js`
- Existing actions, blocks, settings, snapshots, profiles, console — all must remain functional

## Reference: New player.js debug protocol (from macro-builder)
See `/tmp/macro-builder-clean/player/player.js` for the complete debug player implementation.
Copy the debug protocol (stdin/stdout JSON lines) pattern but adapt it to the existing player's step execution model.

## Reference: New server.js run endpoint (from macro-builder)
See `/tmp/macro-builder-clean/server/index.js` lines with `spawn`, `broadcastDebug`, WebSocket debug forwarding.

## Files to modify:
1. `editor/index.html` — add debug UI elements
2. `editor/style.css` — add debug styles
3. `editor/app.js` — add debug logic, breakpoints, variable panel
4. `server/index.js` — add debug-aware run endpoint, WebSocket forwarding
5. `server/player.js` — add debug protocol (stdin/stdout), break/continue support
6. `server/package.json` — add `"type": "commonjs"`
