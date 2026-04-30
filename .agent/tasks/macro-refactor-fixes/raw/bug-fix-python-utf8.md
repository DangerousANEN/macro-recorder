# Bug Fix: UnicodeDecodeError with Chinese text in Python blocks

## Root Cause
Python's `open()` without `encoding` parameter defaults to the system locale on Windows (e.g., cp1251, cp936).
When runtime variables contain non-ASCII text (e.g., Chinese "小龙虾"), the JSON files written by Node.js
(which uses UTF-8) cannot be read by Python's `open()` using the default system encoding.

Two locations affected:
1. `server/player.js` — `executePython()` wrapper template
2. `server/index.js` — `/api/python/exec` endpoint wrapper template

`PYTHONIOENCODING: 'utf-8'` was already set in env (for stdout/stderr), but `open()` calls in the
wrapper code didn't specify encoding.

## Fix
Added `encoding='utf-8'` to all `open()` calls in both Python wrapper templates:
- `open(_vars_in_path, 'r', encoding='utf-8')` — reading input variables
- `open(_vars_out_path, 'w', encoding='utf-8')` — writing output variables
- Also added `ensure_ascii=False` to `json.dump()` for cleaner UTF-8 output

## Files Changed
- `server/player.js` — executePython() wrapper template
- `server/index.js` — /api/python/exec wrapper template

## Verification
- Set a variable to "小龙虾" → run Python block that reads it → no UnicodeDecodeError
- Python block that sets `result = "日本語テスト"` → variable propagates correctly to runtime
- ASCII-only variables continue to work unchanged
