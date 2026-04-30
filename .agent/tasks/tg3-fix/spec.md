# Task: tg3-fix

Make Telegram Web automation resilient to DOM changes (`#telegram-search-input`
disappears on the `/k/` UI variant) by adding a generic `fallbackSelectors`
mechanism to `smartClick` and `smartFill`, plus updating the example macro
`tg3-smoke-001` to use it.

## Acceptance Criteria

### AC1 — `step.fallbackSelectors` honored by `smartClick`
- Array of strings (CSS) or `{kind, value, name?}` objects.
- Tried after the primary selector + raw `cssSelector` + xpath + placeholder, before the Telegram heuristics.

### AC2 — `step.fallbackSelectors` honored by `smartFill`
- Same as AC1 for `type` action.

### AC3 — Telegram /k/ search field heuristic
- When the primary selector contains `telegram-search-input`, additionally try
  `.input-search-input` / `input.input-search-input` (Telegram /k/) before the
  generic search-field fallback.

### AC4 — `tg3-smoke-001.json` updated
- Has a `wait` for any of the search field variants before clicking.
- `click` and `type` steps include `placeholder: "Search"` and `fallbackSelectors`.

### AC5 — Smoke test still PASS
- `npm run smoke` still PASSes.

### AC6 — Example macro tracked in git
- `.gitignore` updated so `data/macros/tg3-smoke-001.json` isn't ignored.

## Procedure

1. Extend `smartClick` and `smartFill` with `fallbackSelectors` handling.
2. Add Telegram /k/ class to the heuristic block.
3. Rewrite `tg3-smoke-001.json` to use the new fields.
4. Whitelist the seed macro in `.gitignore`.
5. Run smoke, commit, push, open PR #7.
