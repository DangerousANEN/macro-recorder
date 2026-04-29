# Evidence: refactor-and-docs

| AC  | Item                                       | Status |
| --- | ------------------------------------------ | ------ |
| AC1 | `server/selectors.js` module               | PASS   |
| AC2 | `player.js` delegates via thin shims       | PASS   |
| AC3 | `npm run smoke`                            | PASS (36/36) |
| AC4 | `.devin/skills/macro-recorder/SKILL.md`    | PASS   |
| AC5 | README rewritten                           | PASS   |
| AC6 | No behaviour regression                    | PASS (smoke same) |

## Smoke result

```
$ SMOKE_PORT=3708 node scripts/smoke-test.mjs
…
SMOKE TEST: PASS
```

## Refactor metric

```
Before:
  server/player.js: 3244 lines, all selector/click/fill code inline

After:
  server/player.js: 3046 lines (-198)
  server/selectors.js: 220 lines (new, focused module)
  Net code: roughly the same; cohesion much higher.
```

## Notes

- `selectors.js` has zero module-level mutable state — `tempDir` and
  `broadcastStatus` are passed via `opts`. This makes it trivially testable in
  isolation in a follow-up.
- The shims in `player.js` match the old call signatures exactly, so all 18+
  existing call sites in the file continue to work without diff.
- This is a *first* refactor pass. The next pass (planned PR #11+) splits the
  big `executeAtomicStep` switch into per-action handlers and extracts a
  `BrowserSession` for the module-level `page` / `context` / `browser` state.

## Files

- `server/selectors.js` — new module
- `server/player.js` — uses imports + shims
- `README.md` — rewritten
- `.devin/skills/macro-recorder/SKILL.md` — new
- `.agent/tasks/refactor-and-docs/{spec,evidence}.{md,json}`
