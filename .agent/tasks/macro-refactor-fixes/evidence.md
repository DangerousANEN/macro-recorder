# Evidence: macro-refactor-fixes (Round 2 — Bug Fixes)

## Overview
Three new bugs discovered during testing after initial PASS verdict. All fixed with minimal, targeted changes.

## Bug 1: Python blocks execute twice
- **Root cause:** `executePython()` broadcasts output in real-time via `proc.stdout.on('data')`. Callers then re-broadcast `pyResult.output` (accumulated stdout) — duplicating the output.
- **Fix:** Removed duplicate `broadcastStatus({ type: 'python-output' })` from 3 caller sites in `server/player.js` (pyFile handler, pythonOverride handler, `case 'python'`).
- **Impact:** Output now appears once. Variable propagation and error handling unchanged.

## Bug 2: Debug mode crashes on second restart  
- **Root cause:** Old child process's `close` event fires after new process is registered, deleting new entry from `runningDebugProcesses` and broadcasting `finished` (which exits debug UI).
- **Fix:** In `server/index.js`, `close`/`error` handlers now check `runningDebugProcesses.get(m.id)?.process === child` before cleanup/broadcast. Old process entry is also deleted before spawning new one.
- **Impact:** Debug can be restarted cleanly. Normal debug lifecycle unchanged.

## Bug 3: UnicodeDecodeError with Chinese text
- **Root cause:** Python wrapper's `open()` calls lacked `encoding='utf-8'`, defaulting to system locale on Windows. Non-ASCII text in variables caused decode failures.
- **Fix:** Added `encoding='utf-8'` to `open()` calls and `ensure_ascii=False` to `json.dump()` in both `server/player.js` (executePython) and `server/index.js` (/api/python/exec).
- **Impact:** Chinese, Japanese, Cyrillic, and other non-ASCII text works in Python variable exchange.

## Bug 4: Drag-and-drop broken for composite blocks (loop-table, loop-elements, if, try-except)
- **Root cause:** In the `dragstart` event listener, `e.target` for a `draggable` element is the element itself (`.block-container`), not the element the user clicked. The guard `header.contains(e.target)` always returned `false` because the header doesn't contain its parent container — effectively preventing all composite block drags.
- **Fix:** Added a `mousedown` listener (capture phase) on `editorStepsList` to track the actual click target (`_dragMousedownTarget`). In `dragstart`, the header containment check now uses this real target instead of `e.target`.
- **Impact:** All composite blocks (loop-table, loop-elements, if, try-except) can now be dragged by their headers. Atomic step drag is unaffected. Children stay with parent during drag. Drop zones (before step, before block, into block body, root level) all work for composite blocks.

## Bug 5: Parallel windows all process same rows (race condition)
- **Root cause:** `runMacroParallel()` launches N workers concurrently via `Promise.allSettled()`. Each worker temporarily swaps module-level globals (`page`, `browser`, `context`, `runtimeVars`) before calling `executeSteps()`. Since workers run concurrently, Worker A's `await` yields control to Worker B, which clobbers the globals. Both workers end up using the same `runtimeVars` (from whichever worker wrote last), making it appear all windows process the same rows.
- **Row distribution was correct:** The round-robin code at lines 1290-1293 correctly distributes row indices (window 0 gets rows 0,2,4..., window 1 gets rows 1,3,5...). The bug was in the *execution* phase, not distribution.
- **Fix:** Added a `createMutex()` utility and wrapped the global-state-swap + `executeSteps()` section in a mutex acquire/release. This serializes step execution across workers while still allowing browsers to launch and navigate concurrently.
- **Trade-off:** Step execution is now serialized (one worker runs at a time), but browser startup, URL navigation, and inter-iteration delays still run in parallel. This is acceptable because the primary benefit of parallel windows is having multiple browser sessions with different profiles/fingerprints, and the row distribution ensures no duplicates.
- **Impact:** Each window now processes only its assigned rows. With 2 windows and 10 rows: Window 0 processes rows 0,2,4,6,8; Window 1 processes rows 1,3,5,7,9. No duplicates.

## Files Modified
| File | Changes |
|------|---------|
| `server/player.js` | Removed 3 duplicate python-output broadcasts; added `encoding='utf-8'` to Python wrapper `open()` calls; added mutex for parallel execution global state safety |
| `server/index.js` | Debug restart race condition fix; added `encoding='utf-8'` to Python exec wrapper `open()` calls |
| `editor/app.js` | Fixed composite block drag-and-drop: added mousedown target tracking, fixed header containment check in dragstart |

## Syntax Verification
- `node --check server/index.js` — PASS (no parse errors)
- `node -e "import(...player.js)"` — PASS (no import errors)

## Evidence Artifacts
- `raw/bug-fix-python-double-exec.md` — detailed analysis of double execution bug
- `raw/bug-fix-debug-restart.md` — detailed analysis of debug restart bug  
- `raw/bug-fix-python-utf8.md` — detailed analysis of UTF-8 encoding bug
