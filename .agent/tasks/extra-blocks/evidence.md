# Evidence: extra-blocks

## ACs

| AC  | Block            | Status |
| --- | ---------------- | ------ |
| AC1 | `delay` ⏸        | PASS   |
| AC2 | `set-cookie` 🍪  | PASS   |
| AC3 | `clear-cookies` 🧹| PASS   |
| AC4 | `tab-open` 🆕    | PASS   |
| AC5 | `tab-switch` 🗂  | PASS   |
| AC6 | `tab-close` ❌   | PASS   |
| AC7 | `hover` 👇       | PASS   |
| AC8 | `eval-js` 🔧     | PASS   |
| AC9 | Editor wiring    | PASS   |
| AC10| Smoke test       | PASS (36/36) |

## Smoke test result

```
$ SMOKE_PORT=3702 node scripts/smoke-test.mjs
[PASS] server boots and /api/macros responds
[PASS] GET /api/macros → 200
[PASS] GET /api/blocks → 200
[PASS] GET /api/settings → 200
[PASS] GET /api/variables → 200
... 26 block-presence checks PASS ...
[PASS] POST /api/macros creates macro
[PASS] GET /api/macros/.../export → 200
[PASS] exported macro has steps array
[PASS] POST /api/macros/import → 201

SMOKE TEST: PASS
```

## Implementation notes

- All eight new cases live in `server/player.js` `executeAtomicStep`. They use the
  module-level `page`, `context`, `currentMacroId` variables already in place from the
  preceding PR.
- `tab-open` / `tab-switch` / `tab-close` rebind the module-level `page` so subsequent
  steps target the new tab transparently. `tab-close` falls back to the last remaining
  tab if the closed one was current.
- `set-cookie` defaults `domain` to the current page's hostname when omitted so users
  don't have to repeat themselves. `expires=0` means session cookie.
- `eval-js` wraps user code in `(async () => { ... })()` so they can use `await` and
  `return`. Non-string returns are JSON-stringified before saving to the variable.
- `hover` reuses the existing `selector`/`useCurrentElement` logic so it works inside
  loop-elements just like `click`.

## Files touched

- `data/blocks/{delay,set-cookie,clear-cookies,tab-open,tab-switch,tab-close,hover,eval-js}.json` (new)
- `server/player.js` — eight new `case` clauses
- `editor/index.html` — two new action-card categories + six new config sections
- `editor/app.js` — ACTION_ICONS / ACTION_NAMES / NEEDS_* + show-section + load + save handlers
- `scripts/smoke-test.mjs` — extended `REQUIRED_BLOCKS` list
- `.agent/tasks/extra-blocks/{spec,evidence}.{md,json}`
