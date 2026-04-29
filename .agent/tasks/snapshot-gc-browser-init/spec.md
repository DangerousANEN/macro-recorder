# Task: snapshot-gc-browser-init

Two related reliability fixes:

1. **Snapshot auto-cleanup** — `data/snapshots/runtime/<macroId>/` accumulates
   PNGs every run. After a few hundred runs it can balloon into hundreds of MB.
2. **`browser-init` audit** — the JSON definition advertised `startUrl` /
   `useFingerprint` / `useProxy` fields but the server only used
   `vars._macro_start_url`. Bring the contract in line with reality and let the
   user override `startUrl` per step.

## Acceptance Criteria

### AC1 — `server/snapshot-gc.js` module
- Exports `runSnapshotGc({ snapshotsDir, apply, runtimeMaxAgeDays, editorMaxAgeDays, keepPerDir })`.
- Combines two policies: time-based (delete files older than N days) and count-based (keep newest K per dir).
- Returns `{apply, runtime, editor, totalDeleted, totalKept, totalBytesFreed}`.

### AC2 — CLI script
- `scripts/gc-snapshots.mjs` defaults to dry-run, `--apply` actually deletes.
- Prints per-bucket counts and total. Exit code 0.
- `npm run gc:snapshots` from `server/`.

### AC3 — HTTP endpoint
- `POST /api/snapshots/gc` accepts `{apply, runtimeMaxAgeDays, editorMaxAgeDays, keepPerDir}` and returns the GC summary as JSON.

### AC4 — Boot-time hook
- Default ON. Server runs `runSnapshotGc({apply:true})` once at startup with sensible defaults (runtime=7d, editor=30d, keep=200).
- Disable with `SNAPSHOT_GC_ON_BOOT=0`.
- Tunable via `RUNTIME_SNAPSHOT_MAX_AGE_DAYS`, `EDITOR_SNAPSHOT_MAX_AGE_DAYS`, `SNAPSHOT_KEEP_PER_DIR`.
- Logs `🧹 Snapshot GC freed ~X.X MB (N files)` if anything was deleted.

### AC5 — `browser-init` JSON definition reflects reality
- Fields: `["profileName", "startUrl", "proxy", "proxyUsername", "proxyPassword", "scope", "timeoutMs"]`.

### AC6 — `step.startUrl` override
- In `executeAtomicStep` `case 'browser-init'`, the goto URL is now
  `step.startUrl || vars._macro_start_url || null` (with `resolveVars`).

### AC7 — Smoke test still PASS
- `npm run smoke` continues to PASS.

### AC8 — GC verified end-to-end
- Manual repro (touch 5 files, age 2 of them 14 days, run with `--apply`) → 2 deleted, 3 kept.

## Procedure

1. Create `server/snapshot-gc.js` with the helper.
2. Wire it into `server/index.js` (import, endpoint, boot hook).
3. Add `scripts/gc-snapshots.mjs` for offline use + npm script.
4. Update `data/blocks/browser-init.json` fields.
5. Add `step.startUrl` override in `case 'browser-init'`.
6. Run smoke + manual gc test, commit, push, open PR #6.
