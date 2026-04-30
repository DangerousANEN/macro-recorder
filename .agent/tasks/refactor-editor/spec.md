# Task: refactor-editor

Begin SRP refactor of `editor/app.js` by extracting an HTTP API client into a
dedicated module (`editor/macro-api.js`).

## Acceptance Criteria

### AC1 — `editor/macro-api.js` exists
- Exports `window.MacroAPI` with method-per-route surface (listMacros, getMacro,
  createMacro, updateMacro, deleteMacro, importMacro, listSnapshots, runMacro,
  runMacroLoop, runMacroParallel, runStep, runUpToStep, stopRun, getSettings,
  putSettings, getPersistentVars, setPersistentVar, deletePersistentVar,
  putTable, deleteTable, listProfiles, createProfile, deleteProfile,
  launchProfile, listBlocks, pythonExec, snapshotsGc).
- Throws on non-2xx so call sites can `try/catch`.

### AC2 — `index.html` loads it before `app.js`
- `<script src="macro-api.js"></script>` precedes `<script src="app.js">`.

### AC3 — High-traffic call sites migrated
- `fetchMacros`, `fetchMacro`, `createMacro`, `saveMacro`, `deleteMacro`,
  `importMacro`, `stopRunningMacro`, `fetchProfiles`, `createProfile`,
  `deleteProfile`, `launchProfile` now use `MacroAPI.*` instead of raw `fetch`.

### AC4 — `npm run smoke` PASS
- 36/36, no behaviour regression.

### AC5 — `node --check editor/app.js` and `node --check editor/macro-api.js` OK

## Procedure

1. Build `editor/macro-api.js`.
2. Add script tag in `editor/index.html`.
3. Migrate macro CRUD + profiles + import + stop-run.
4. Run smoke, commit, push, open PR.

## Out of scope (next refactor pass)

- Splitting renderer / config-modal / context-menu / keyboard-shortcuts into
  their own modules.
- Migrating settings/tables/python/exec call sites.
- Moving from globals to a single `Editor` class.
