# Task: extra-blocks

Add the remaining set of atomic action blocks the user explicitly requested:
delay, cookie management, multi-tab control, hover, and arbitrary JS evaluation.

## Acceptance Criteria

### AC1 — `delay` (⏸)
- `data/blocks/delay.json` exists, type `atomic`, fields: `delayMs` (single fixed ms) OR `delayMin` / `delayMax` (random range, in seconds).
- `server/player.js` `case 'delay'` waits `delayMs` ms when set, otherwise random integer in `[delayMin*1000, delayMax*1000]`.
- Editor: action card under "📌 Основные", config modal shows fixed-ms input + range inputs.

### AC2 — `set-cookie` (🍪)
- `data/blocks/set-cookie.json`, fields: `cookieName`, `cookieValue`, `cookieDomain`, `cookiePath`, `cookieExpires` (seconds, optional).
- `case 'set-cookie'` calls `context.addCookies([{ name, value, domain, path, expires }])`. `domain` defaults to current page hostname; `path` defaults to `/`.
- Editor: action card + config UI under new "🍪 Куки и вкладки" category.

### AC3 — `clear-cookies` (🧹)
- `data/blocks/clear-cookies.json`, fields: `cookieDomain` (optional).
- `case 'clear-cookies'` calls `context.clearCookies({ domain })` if domain given, else clears all.

### AC4 — `tab-open` (🆕)
- `data/blocks/tab-open.json`, fields: `url`, `saveAs` (optional, saves new page index/url to var).
- `case 'tab-open'` opens `await context.newPage()`, navigates to `url`, switches `page` to the new tab.

### AC5 — `tab-switch` (🗂)
- `data/blocks/tab-switch.json`, fields: `tabIndex` (number or var ref) OR `tabUrlContains` (substring match).
- `case 'tab-switch'` looks up `context.pages()`, picks page where index matches or `page.url()` contains the substring, sets module-level `page` to it.

### AC6 — `tab-close` (❌)
- `data/blocks/tab-close.json`, fields: `tabIndex` (optional — closes specific tab; if empty, closes current).
- `case 'tab-close'` closes the target page; if it was the current one, switches to last remaining page.

### AC7 — `hover` (👇)
- `data/blocks/hover.json`, fields: `cssSelector` (and any saved-selector name like other selector-using blocks).
- `case 'hover'` resolves the locator via existing `resolveLocator` helper and calls `.hover()`.

### AC8 — `eval-js` (🔧)
- `data/blocks/eval-js.json`, fields: `code` (multi-line JS), `saveAs` (optional).
- `case 'eval-js'` runs `await page.evaluate(code)` and stores the result (stringified if non-string) in `vars[saveAs]` if set.

### AC9 — Editor wiring
All eight blocks have action cards in the "Add Step" modal under appropriate categories. Each has a config section in the step config modal. Load and save logic in `app.js` round-trips field values.

### AC10 — Smoke test
`scripts/smoke-test.mjs` is extended so `REQUIRED_BLOCKS` includes all eight new blocks. `npm run smoke` continues to PASS.

## Procedure

1. Create eight `data/blocks/*.json` files.
2. Add eight `case` clauses in `server/player.js` `executeAtomicStep`.
3. Add categorised action cards in `editor/index.html` and config sections.
4. Wire `app.js` ACTION_ICONS / ACTION_NAMES, load (`step.action === 'X'`) and save (`if (action === 'X')`) blocks.
5. Update `scripts/smoke-test.mjs` block list.
6. Run smoke test, commit, push, open PR.
