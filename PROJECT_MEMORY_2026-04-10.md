## 2026-04-10 — macro-recorder-debug session memory (handoff)

### What we were doing
- Restoring and running project `macro-recorder-debug` (server + UI/extension) on Windows.
- Running Playwright macros via HTTP API on `http://localhost:3700`.
- Using tables from `settings.dataTables` (NOT CSV directly) to iterate bots (`claw###` values).

### Paths / identifiers
- Project root: `F:\ANEN\Desktop\macro-recorder-debug`
- Server: `F:\ANEN\Desktop\macro-recorder-debug\server\index.js`
- Runner: `F:\ANEN\Desktop\macro-recorder-debug\server\player.js`
- Macro file: `F:\ANEN\Desktop\macro-recorder-debug\data\macros\tg3-rotate-001.json`
- Data dir: `F:\ANEN\Desktop\macro-recorder-debug\data`
- API base: `http://localhost:3700`

### Working API calls
- Profiles: `GET http://localhost:3700/api/profiles`
- Macros: `GET http://localhost:3700/api/macros`
- Running: `GET http://localhost:3700/api/running`
- Patch tables: `PATCH http://localhost:3700/api/settings/dataTables`
- Run loop:
  - `POST http://localhost:3700/api/macros/tg3-rotate-001/run-loop`
  - Typical body: `{ times: 0, delayMin: 3, delayMax: 10, tableName: 'test_bots3', profileName: 'tg-acc1' }`

### Data tables constraint
- Table shape must match `mixed_bots.csv`:
  - `headers: ['botname']`
  - `rows: [['claw484'], ...]`
- Values strictly `claw###` (no `openclaw` prefix).

### Fixes already made in code
1) Fix: **extra Playwright window created before `browser-init`**
- File: `F:\ANEN\Desktop\macro-recorder-debug\server\player.js`
- Change: in `executeAtomicStep()` lazy page creation (`ensureBrowser()`) is skipped when current step action is `browser-init`.
- Goal: prevent window churn (open temp window -> close -> reopen).

2) Fix: **stale page pointer after nested restarts**
- File: `F:\ANEN\Desktop\macro-recorder-debug\server\player.js`
- Change: in `executeSteps()` loop, before each step:
  - `if (execContext?.page) p = execContext.page;`
- Reason: steps like `switch-profile`/`browser-init` can restart context and replace `execContext.page`. Without this, parent would keep using an old page and clicks would happen in the wrong/closed window.

3) Settings: timeout too small
- `GET /api/settings` showed `timeout: 5000`.
- Patched to `30000` via `PATCH http://localhost:3700/api/settings` with `{ "timeout": 30000 }`.

### Remaining issue
- Macro previously errored on Telegram selector:
  - `page.click: Timeout ... waiting for locator('#telegram-search-input')`
- Next debugging direction:
  - verify Telegram is on `https://web.telegram.org/a/` and logged-in
  - replace brittle selector / add explicit readiness waits
  - add debug logs on click timeout (url/title/locator count/page closed)

### Cron/monitoring
- Cron job existed earlier (every 15 min, tz `Asia/Novosibirsk`, Telegram notify `telegram:831992162`).
- If re-check needed, look up gateway cron by job id: `476749a4-ba7e-4662-9a86-8073c7f3b3ec`.
