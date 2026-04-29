# Prompt for coding agent (macro-recorder-debug)

You are fixing a Node.js + Playwright automation project.

## Project
- Root: `F:\ANEN\Desktop\macro-recorder-debug`
- Server: `F:\ANEN\Desktop\macro-recorder-debug\server`
- Main server entry: `F:\ANEN\Desktop\macro-recorder-debug\server\index.js`
- Player/runner: `F:\ANEN\Desktop\macro-recorder-debug\server\player.js`
- Data dir: `F:\ANEN\Desktop\macro-recorder-debug\data`
- Macros: `F:\ANEN\Desktop\macro-recorder-debug\data\macros`
- Target macro file: `F:\ANEN\Desktop\macro-recorder-debug\data\macros\tg3-rotate-001.json`
- Server URL: `http://localhost:3700`

## Current goal
Make macro `tg3-rotate-001` run reliably against Telegram Web.
Observed failure previously: `page.click: Timeout ... waiting for locator('#telegram-search-input')`.

## Key constraints
- Do NOT change base URL/port: `http://localhost:3700`
- Do NOT change project paths.
- Bot table format in settings: `settings.dataTables.<name>` with shape:
  - `headers: ['botname']`
  - `rows: [['claw336'], ...]` (values strictly like `claw###`, no `openclaw` prefix)
- Running loop is done via API:
  - `POST http://localhost:3700/api/macros/tg3-rotate-001/run-loop` with JSON body
    `{ times: 0, delayMin: 3, delayMax: 10, tableName: 'test_bots3', profileName: 'tg-acc1' }`
- For now, test in single window: scope should effectively be `"this"`.

## What was already fixed
1) **Playwright window churn / extra window before browser-init**
- In `F:\ANEN\Desktop\macro-recorder-debug\server\player.js`, logic was changed so that lazy `ensureBrowser()` is NOT called when current step is `browser-init`.
- That prevented creating a temporary window (no-proxy) then closing it then opening a new one.

2) **Stale page reference after nested restarts**
- Also in `player.js`, `executeSteps()` now refreshes local page pointer every loop iteration:
  - `if (execContext?.page) p = execContext.page;`
- This fixes cases where a nested step (e.g. inside `if` / `try-except` / loops) restarts execution context (new Playwright page), but parent continues using an old `p`, causing clicks to happen in the wrong/closed window.

3) Global timeout was found too low (5000ms) in settings; it was increased to 30000ms via:
- `PATCH http://localhost:3700/api/settings` body `{ "timeout": 30000 }`

## What you need to do
A) Reproduce and confirm current behavior:
- Start server from `F:\ANEN\Desktop\macro-recorder-debug\server`:
  - `node index.js`
- Run loop macro via API (above).
- Poll status:
  - `GET http://localhost:3700/api/running`

B) If it still fails on `#telegram-search-input`, implement robust Telegram readiness:
- Ensure navigation goes to Telegram Web “A” version:
  - `https://web.telegram.org/a/` (not the legacy route)
- Add explicit waits before first Telegram interaction:
  - wait for `domcontentloaded` + a Telegram-specific stable selector.
- Consider updating the selector: Telegram Web DOM can change; make selector resilient (e.g. by role/placeholder/text).
- If element is inside an iframe/shadow DOM, update lookup strategy.

C) Add debug logging (without spamming) around click failures:
- On click timeout, log:
  - current URL (`page.url()`)
  - title
  - count of matches for selector (`page.locator(selector).count()`)
  - whether the page is closed

## Deliverable
- A small patch in `server/player.js` (and macro JSON only if absolutely needed) that makes tg3 run to the point where it reliably finds and interacts with Telegram UI.
- Keep changes minimal and compatible with other macros.
