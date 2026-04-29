# Bug Fix: Python blocks execute twice

## Root Cause
`executePython()` broadcasts `python-output` messages in real-time via `proc.stdout.on('data')` (line ~955).
Then, every caller (`case 'python'`, `pyFile` handler, `pythonOverride` handler) broadcasts `pyResult.output` 
(the accumulated stdout) AGAIN after `executePython()` resolves.

This causes Python output to appear twice in the console — making it look like the block executed twice.

## Fix
Removed the duplicate `broadcastStatus(wss, { type: 'python-output', ... pyResult.output })` calls from:
1. `pyFile` handler (line ~245) 
2. `pythonOverride` handler (line ~267)
3. `case 'python'` in the switch (line ~459)

The real-time broadcast inside `executePython()` is sufficient.

## Files Changed
- `server/player.js` — 3 locations where duplicate python-output broadcasts were removed

## Verification
- Python block with `print("hello")` should show "hello" once in console, not twice
- Variables from Python still propagate correctly (var-saved broadcasts untouched)
- pyFile and pythonOverride paths still work (only output broadcast removed, not execution)
