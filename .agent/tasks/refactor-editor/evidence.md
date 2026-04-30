# Evidence: refactor-editor

| AC  | Item                                       | Status |
| --- | ------------------------------------------ | ------ |
| AC1 | `editor/macro-api.js` module               | PASS   |
| AC2 | `index.html` loads it before `app.js`      | PASS   |
| AC3 | High-traffic call sites migrated           | PASS   |
| AC4 | `npm run smoke`                            | PASS (36/36) |
| AC5 | `node --check` both files                  | PASS   |

## Smoke result

```
$ SMOKE_PORT=3709 node scripts/smoke-test.mjs
…
SMOKE TEST: PASS
```

## Migrated call sites

- `fetchMacros` → `MacroAPI.listMacros()`
- `fetchMacro` → `MacroAPI.getMacro` + `MacroAPI.listSnapshots`
- `createMacro` → `MacroAPI.createMacro`
- `saveMacro` → `MacroAPI.updateMacro`
- `deleteMacro` → `MacroAPI.deleteMacro`
- import-macro file handler → `MacroAPI.importMacro`
- `stopRunningMacro` → `MacroAPI.stopRun`
- `fetchProfiles` → `MacroAPI.listProfiles`
- `createProfile` → `MacroAPI.createProfile`
- `deleteProfile` → `MacroAPI.deleteProfile`
- `launchProfile` → `MacroAPI.launchProfile`

## Not yet migrated (deliberate, follow-up PR)

- `python/exec` (line ~1300, ~1819)
- `settings`, `variables/persistent`, `tables`
- per-step run / run-to / parallel / loop (`run`, `run-loop`, `run-parallel`, `steps/X/run`, `run-to/X`)

The MacroAPI surface already covers these endpoints; only the call sites need
to be flipped over. Doing it incrementally avoids one giant blast-radius diff.

## Files

- `editor/macro-api.js` — new (70 lines)
- `editor/index.html` — added `<script src="macro-api.js">` before `app.js`
- `editor/app.js` — call sites migrated
- `.agent/tasks/refactor-editor/{spec,evidence}.{md,json}`
