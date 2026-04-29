# Evidence: snapshot-gc-browser-init

## ACs

| AC  | Item                                       | Status |
| --- | ------------------------------------------ | ------ |
| AC1 | `server/snapshot-gc.js` module             | PASS   |
| AC2 | `scripts/gc-snapshots.mjs` CLI             | PASS   |
| AC3 | `POST /api/snapshots/gc` endpoint          | PASS   |
| AC4 | Boot-time GC hook (default ON, env-tunable)| PASS   |
| AC5 | `browser-init` JSON fields aligned         | PASS   |
| AC6 | `step.startUrl` override                   | PASS   |
| AC7 | `npm run smoke` PASS                       | PASS (36/36) |
| AC8 | Manual GC repro                            | PASS (2 deleted, 3 kept) |

## Smoke result

```
$ SMOKE_PORT=3705 node scripts/smoke-test.mjs
…
SMOKE TEST: PASS
```

## Manual GC repro

```
$ mkdir -p data/snapshots/runtime/test-macro
$ for i in $(seq 1 5); do echo fake > data/snapshots/runtime/test-macro/snap_$i.png; done
$ touch -d '14 days ago' data/snapshots/runtime/test-macro/snap_{1,2}.png
$ node scripts/gc-snapshots.mjs --apply
[runtime] 2 deleted, 3 kept, ~0.0 MB freed (max age 7d, keep 200/dir)
[editor] 0 deleted, 3 kept, ~0.0 MB freed (max age 30d, keep 200/dir)

Total: 2 files, 6 kept, ~0.0 MB freed.
```

Newest 3 files retained, the 2 aged-out files deleted, exit code 0.

## Implementation notes

- GC has both a time policy and a count policy in one pass — files are deleted if
  either criterion triggers. This means a sudden burst of 500 screenshots from
  one run will be cleaned even if all are < 7d old (keep=200 wins).
- Dry-run is the default for the CLI to avoid foot-gun behaviour. The boot hook
  uses `apply:true` because the recorder always wants stale runtime snapshots
  gone.
- After deleting all files in a directory the script attempts `rmdir` to leave
  the tree clean.
- `browser-init` no longer silently ignores `step.startUrl`. The order of
  precedence is: `step.startUrl` (with var substitution) → macro-level
  `_macro_start_url` → no navigation.

## Files

- `server/snapshot-gc.js` — GC helper module
- `server/index.js` — import, `POST /api/snapshots/gc`, boot-time hook
- `scripts/gc-snapshots.mjs` — CLI (dry-run / `--apply`)
- `server/package.json` — `npm run gc:snapshots`
- `server/player.js` — `step.startUrl` override in `case 'browser-init'`
- `data/blocks/browser-init.json` — fields list updated
- `.agent/tasks/snapshot-gc-browser-init/{spec,evidence}.{md,json}`
