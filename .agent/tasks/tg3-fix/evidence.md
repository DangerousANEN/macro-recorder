# Evidence: tg3-fix

| AC  | Item                                       | Status |
| --- | ------------------------------------------ | ------ |
| AC1 | `smartClick` reads `step.fallbackSelectors`| PASS   |
| AC2 | `smartFill` reads `step.fallbackSelectors` | PASS   |
| AC3 | Telegram /k/ heuristic added               | PASS   |
| AC4 | `tg3-smoke-001.json` updated               | PASS   |
| AC5 | `npm run smoke` PASS                       | PASS (36/36) |
| AC6 | Seed macro tracked in git                  | PASS   |

## Smoke result

```
$ SMOKE_PORT=3706 node scripts/smoke-test.mjs
…
SMOKE TEST: PASS
```

## Implementation notes

- `fallbackSelectors` accepts heterogeneous entries — plain CSS strings or
  `{kind, value, name?}` objects (so a user can mix CSS and role-based fallbacks
  in the same array).
- Order of attempts in `smartClick`: primary CSS → raw recorded CSS → xpath →
  placeholder → user fallback selectors → Telegram heuristics. This means
  user-supplied fallbacks always run before the auto-heuristics, which is what
  we want when the user knows their site better than the heuristic does.
- Telegram /k/ adds `.input-search-input` class which is the dominant search
  input class on the `https://web.telegram.org/k/` UI as of 2026-04.
- The example macro now waits for *any* of the known search-field variants via
  a CSS selector union before attempting to click — this means it tolerates
  both /a/ and /k/ UIs without code changes.

## Files

- `server/player.js` — fallbackSelectors logic in `smartClick` and `smartFill`, /k/ heuristic
- `data/macros/tg3-smoke-001.json` — resilient steps with placeholder + fallbacks
- `.gitignore` — whitelist for the example seed macro
- `.agent/tasks/tg3-fix/{spec,evidence}.{md,json}`
