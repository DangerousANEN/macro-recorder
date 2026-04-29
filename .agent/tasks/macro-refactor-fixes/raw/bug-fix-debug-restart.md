# Bug Fix: Debug mode crashes on second restart

## Root Cause
When restarting debug (clicking Debug again while a debug session is running):

1. Server kills old child process and spawns new one
2. Old child's `close` event fires asynchronously AFTER the new child is registered in `runningDebugProcesses`
3. Old child's `close` handler called `runningDebugProcesses.delete(m.id)` — deleting the NEW process entry
4. Old child's `close` handler broadcast `{ action: 'finished' }` — causing `exitDebugMode()` in the editor
5. New debug session immediately appears to finish, UI exits debug mode

## Fix (server/index.js)
1. Added `runningDebugProcesses.delete(m.id)` immediately after killing the old process (before spawning new one)
2. Changed `close` and `error` event handlers to check `runningDebugProcesses.get(m.id)?.process === child` before deleting or broadcasting
3. Only the CURRENT child's events trigger cleanup and 'finished' broadcast

## Files Changed
- `server/index.js` — debug spawn section (~line 390-440)

## Verification
- Start debug → stop → start debug again → should pause at first breakpoint normally
- Start debug → while running, click debug again → old process killed, new one starts cleanly
- Normal debug flow (start → step → stop) unchanged
