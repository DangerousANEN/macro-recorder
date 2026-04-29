# Task Spec: telegram-autoreg

## Metadata
- Task ID: telegram-autoreg
- Created: 2026-03-26T14:27:59+00:00
- Frozen: 2026-03-26T14:28+00:00
- Status: **FROZEN**
- Repo root: F:\ANEN\Desktop\macro-recorder-debug
- Working directory at init: F:\ANEN\Desktop\macro-recorder-debug

## Guidance sources
- AGENTS.md
- CLAUDE.md
- memory.md (project architecture & history)

## Original task statement
Добавить полный функционал авторегистрации Telegram аккаунтов в макро-рекордер.

---

## Summary

Extend the macro-recorder with a complete Telegram account auto-registration pipeline operating through `web.telegram.org`. The system adds: real SMS API integrations (sms-activate, 5sim, smshub), captcha-solving service integrations (2captcha, anticaptcha), an accounts database with CSV persistence, 7 new macro blocks, 7 new REST API endpoints, human-like behavior emulation, anti-blocking monitoring, and a dedicated "Авторегистрация" tab in the editor UI.

All new code must integrate with the **existing** block system (`data/blocks/*.json`), parallel execution (`runMacroParallel`), proxy/fingerprint infrastructure (`settings.proxy`, `settings.fingerprint`, `proxy-rotate` block), variable resolution (`resolveVars`), and WebSocket status broadcasting (`broadcastStatus`).

---

## Acceptance Criteria

### SMS API Integration
- **AC1:** New module `server/sms-api.js` wraps three SMS services behind a unified interface: `getNumber(service, country?)` → `{id, phone}`, `checkCode(service, id)` → `{code|null}`, `releaseNumber(service, id)` → `{ok}`, `getBalance(service)` → `{balance, currency}`.
- **AC2:** SMS-Activate API (`https://api.sms-activate.org/stubs/handler_api.php`) fully implemented: get number for Telegram (`service=tg`), poll for code (`getStatus`), cancel/release (`setStatus:8`). API key read from `settings.smsServices.services['sms-activate'].apiKey`.
- **AC3:** 5sim API (`https://5sim.net/v1`) fully implemented: buy number (`/user/buy/activation/{country}/any/telegram`), check (`/user/check/{id}`), cancel (`/user/cancel/{id}`). Bearer token auth.
- **AC4:** SMSHub API (`http://smshub.org/stubs/handler_api.php`) fully implemented: same protocol as sms-activate (compatible stubs).
- **AC5:** Retry logic: `checkCode` polls every 5s, up to configurable timeout (default 120s). On timeout, auto-releases number and logs to `failed.csv`.
- **AC6:** Balance checking exposed in UI settings and via `GET /api/sms/balance`.

### Captcha Solver Integration
- **AC7:** New module `server/captcha-solver.js` with unified interface: `solveCaptcha({type, siteKey, pageUrl, service})` → `{token}`.
- **AC8:** 2captcha API support: reCAPTCHA v2 (`createTask` → poll `getTaskResult`), reCAPTCHA v3 (with `minScore`), hCaptcha. API key from new `settings.captchaServices` section.
- **AC9:** AntiCaptcha API support as fallback: same task types. Automatic failover: if primary returns error/timeout after 180s, try secondary.
- **AC10:** Captcha auto-detection: the `solve-captcha` block, when `autoDetect: true`, scans page for `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, or `div.g-recaptcha` / `div.h-captcha` to determine type and siteKey automatically.

### Accounts Database
- **AC11:** Directory `data/accounts/` with CSV files: `registered.csv` (phone, username, session_data, proxy_used, created_at), `failed.csv` (phone, reason, step_failed, timestamp), `in-progress.csv` (phone, sms_id, started_at, status).
- **AC12:** `stats.json` tracks: total_attempts, successful, failed, success_rate, average_time_seconds, failures_by_reason (map), last_updated timestamp.
- **AC13:** CSV read/write via new `server/accounts-db.js` module. All writes append-only (no full rewrite). File locking via simple `.lock` file for parallel-safe writes.
- **AC14:** On registration success: row moves from `in-progress.csv` to `registered.csv`. On failure: moves to `failed.csv` with reason.

### New Macro Blocks (data/blocks/)
- **AC15:** `get-sms-number.json` — block config `{name: "Купить номер", icon: "📱", color: "#a6e3a1", type: "atomic", fields: ["service", "country", "savePhoneTo", "saveSmsIdTo"]}`. Player implementation: calls `sms-api.getNumber()`, stores phone and sms_id in variables.
- **AC16:** `wait-sms-code.json` — `{name: "Ждать SMS код", icon: "📞", color: "#a6e3a1", type: "atomic", fields: ["smsIdVar", "saveCodeTo", "timeout"]}`. Player: polls `sms-api.checkCode()` with retry logic from AC5.
- **AC17:** `solve-captcha.json` — `{name: "Решить капчу", icon: "🧩", color: "#a6e3a1", type: "atomic", fields: ["captchaType", "siteKey", "autoDetect", "saveTokenTo"]}`. Player: calls `captcha-solver.solveCaptcha()`.
- **AC18:** `save-account.json` — `{name: "Сохранить аккаунт", icon: "📋", color: "#a6e3a1", type: "atomic", fields: ["phoneVar", "usernameVar", "sessionDataVar", "status"]}`. Player: writes to `accounts-db` (registered or failed depending on status field/variable).
- **AC19:** `check-blocked.json` — `{name: "Проверить блокировку", icon: "🔍", color: "#a6e3a1", type: "atomic", fields: ["checkType", "saveResultTo"]}`. Player: checks current IP against `data/accounts/blocked-ips.csv`; optionally checks phone against failed.csv; stores `true`/`false` in variable.
- **AC20:** `human-delay.json` — `{name: "Человеческая пауза", icon: "⏱️", color: "#a6e3a1", type: "atomic", fields: ["minSeconds", "maxSeconds", "humanize"]}`. Player: random delay between min-max; if `humanize: true`, uses gaussian distribution centered at midpoint rather than uniform.
- **AC21:** `release-number.json` — `{name: "Освободить номер", icon: "📧", color: "#a6e3a1", type: "atomic", fields: ["smsIdVar", "service"]}`. Player: calls `sms-api.releaseNumber()`.
- **AC22:** All 7 new blocks registered in `data/blocks/` and returned by `GET /api/blocks`. Editor renders them in a new category "📱 Авторегистрация" in the block picker.

### API Endpoints
- **AC23:** `POST /api/sms/get-number` — body: `{service, country?}` → `{id, phone}`. Calls sms-api module.
- **AC24:** `GET /api/sms/check-code/:id` — query: `?service=...` → `{code: string|null, status}`.
- **AC25:** `POST /api/sms/release/:id` — body: `{service}` → `{ok: boolean}`.
- **AC26:** `GET /api/sms/balance` — query: `?service=...` → `{balance, currency}`.
- **AC27:** `POST /api/captcha/solve` — body: `{type, siteKey, pageUrl, service?}` → `{token}`.
- **AC28:** `POST /api/accounts/save` — body: `{phone, username?, sessionData?, status, reason?}` → writes to accounts-db.
- **AC29:** `GET /api/accounts/stats` — returns `stats.json` content.
- **AC30:** `GET /api/accounts/list` — query: `?status=registered|failed|in-progress&limit=50&offset=0` → paginated array.

### Human-like Behavior
- **AC31:** `human-delay` block implements gaussian random delays (AC20).
- **AC32:** `type` block gains optional `humanMode: true` field: when enabled, types characters with 80-200ms random intervals, occasionally makes typos (2-5% chance per char) and corrects them with Backspace after a brief pause.
- **AC33:** Mouse movement emulation: new optional `humanMove: true` on `click` block. When enabled, uses Playwright's `page.mouse.move()` with intermediate bezier-curve waypoints (3-5 points) before clicking, instead of instant teleport.
- **AC34:** Random scroll: `human-delay` block with `scrollRandom: true` triggers a random scroll of 100-400px in a random direction before the pause.

### Monitoring & Anti-blocking
- **AC35:** After each registration attempt, `accounts-db` updates `stats.json`. If success_rate drops below configurable threshold (default 30%) over last 20 attempts, `broadcastStatus` emits `{type: 'autoreg-warning', message: ...}` and auto-increases delays by 2x.
- **AC36:** IP block detection: if 3 consecutive failures from same proxy, proxy is added to `blocked-ips.csv` and `proxy-rotate` is triggered automatically.
- **AC37:** All autoreg actions log to WebSocket via existing `broadcastStatus(wss, {...})` pattern with new types: `sms-number-acquired`, `sms-code-received`, `captcha-solved`, `account-registered`, `account-failed`, `autoreg-warning`.
- **AC38:** Editor console (existing tabs: Все/Макрос/Python/Ошибки) gets a new tab "📱 Авторег" filtering autoreg-related status messages.

### UI — Авторегистрация Tab
- **AC39:** New tab "📱 Авторегистрация" in `editor/index.html` alongside existing tabs.
- **AC40:** Settings sub-panel: SMS service API keys (sms-activate, 5sim, smshub) with balance check buttons. Captcha service API keys (2captcha, anticaptcha) with balance check. Country selector for phone numbers.
- **AC41:** Live statistics sub-panel: total attempts, success/fail counts, success rate %, average registration time, chart or progress bar. Updated via WebSocket.
- **AC42:** Accounts table sub-panel: sortable/filterable table showing registered/failed/in-progress accounts from CSV files. Pagination. Export to CSV button.
- **AC43:** Settings persisted in `settings.json` under new sections: `captchaServices: { active, services: { '2captcha': {apiKey}, 'anticaptcha': {apiKey} } }` and `autoregConfig: { defaultCountry, successRateThreshold, maxRetries, delayMultiplier }`.

---

## Technical Constraints

- **TC1:** All new modules use ES modules (`import`/`export`) matching existing codebase style.
- **TC2:** No new npm dependencies except: none expected (use built-in `fetch` for HTTP calls to SMS/captcha APIs). If a dependency is truly needed, document justification.
- **TC3:** New blocks MUST follow existing JSON schema: `{name, icon, color, type, fields}` in `data/blocks/`.
- **TC4:** Player changes go in `server/player.js` inside `executeSteps()` switch statement, matching existing patterns (see `request-code`, `proxy-rotate` cases).
- **TC5:** All user-facing strings in Russian (matching existing convention).
- **TC6:** CSV files use UTF-8 encoding with BOM for Excel compatibility. Fields containing commas/quotes are properly escaped.
- **TC7:** New API endpoints added to `server/index.js` following existing Express patterns (same error handling, same JSON response format).
- **TC8:** Parallel execution (`runMacroParallel`) must work with all new blocks — each worker's `execContext.vars` holds its own sms_id/phone, no globals.
- **TC9:** No changes to existing block behavior. Existing blocks (click, type, wait, etc.) remain backward-compatible.
- **TC10:** Editor UI uses existing Catppuccin Mocha theme variables and vanilla JS (no frameworks).
- **TC11:** File structure: new modules in `server/` (sms-api.js, captcha-solver.js, accounts-db.js), new blocks in `data/blocks/`, accounts data in `data/accounts/`.

---

## Non-goals

- **NG1:** Desktop/mobile Telegram client automation — only `web.telegram.org` via Playwright.
- **NG2:** Session/TData file management — no Telethon/Pyrogram integration.
- **NG3:** Telegram API (MTProto) direct interaction — all registration through web UI.
- **NG4:** Account warming/farming after registration (posting, joining groups, etc.) — out of scope.
- **NG5:** Phone number pool management beyond what SMS APIs provide — no SIM bank integration.
- **NG6:** Multi-machine distributed execution — single machine, multiple browser windows via existing parallel system.
- **NG7:** Automated macro generation — user still builds the registration macro using blocks; we provide the specialized blocks.
- **NG8:** Two-factor authentication setup on registered accounts.
- **NG9:** Proxy purchasing/management UI — user provides proxy list in existing settings.

---

## Verification Plan

### Build
- `cd server && npm install` completes without errors.
- `node --check server/index.js` — no syntax errors.
- `node --check server/sms-api.js` — no syntax errors.
- `node --check server/captcha-solver.js` — no syntax errors.
- `node --check server/accounts-db.js` — no syntax errors.

### Structural Checks
- `ls data/blocks/` contains all 7 new JSON files: `get-sms-number.json`, `wait-sms-code.json`, `solve-captcha.json`, `save-account.json`, `check-blocked.json`, `human-delay.json`, `release-number.json`.
- Each new block JSON is valid and has required fields: `name`, `icon`, `color`, `type`, `fields`.
- `GET /api/blocks` returns all 34 blocks (27 existing + 7 new).
- `data/accounts/` directory exists with empty CSV files (headers only) after first server start.

### API Smoke Tests (curl / manual)
- `GET /api/sms/balance?service=sms-activate` — returns `{balance, currency}` or clear error if no API key.
- `POST /api/sms/get-number` with invalid API key — returns structured error, not crash.
- `POST /api/captcha/solve` with missing siteKey — returns 400 with descriptive error.
- `GET /api/accounts/stats` — returns valid stats.json content (zeroes initially).
- `GET /api/accounts/list?status=registered` — returns empty array initially.
- `POST /api/accounts/save` with test data — creates row in registered.csv, updates stats.json.

### Block Integration Tests (manual with macro)
- Create a macro with `get-sms-number` block → run → variables `{{phone}}` and `{{sms_id}}` are populated (requires valid SMS API key).
- Create a macro with `human-delay` (min=2, max=5) → run → delay is between 2-5 seconds.
- Create a macro with `save-account` → run → row appears in `data/accounts/registered.csv`.
- `release-number` block with invalid sms_id → logs error, does not crash player.

### Parallel Execution Test
- Create a macro with `get-sms-number` + `wait-sms-code` blocks inside `loop-table`.
- Run with `run-parallel` (2 windows, table with 4 rows).
- Each window gets its own phone/sms_id variables (no cross-contamination).
- Both windows execute independently, results logged per-window.

### UI Verification (manual)
- Open `http://localhost:3700` → "📱 Авторегистрация" tab visible.
- Tab shows settings panel with SMS/captcha API key fields.
- Balance check buttons call API and display result.
- Block picker shows new "📱 Авторегистрация" category with 7 blocks.
- Drag new block into macro → fields render correctly in step editor.
- Console "📱 Авторег" tab filters autoreg WebSocket messages.
- Run autoreg macro → live stats update in real-time.
- Accounts table shows entries after registration attempts.

### Anti-blocking Verification
- Simulate 20 failed attempts → stats.json success_rate drops → `autoreg-warning` emitted via WebSocket → delays auto-doubled.
- Simulate 3 consecutive failures with same proxy → proxy added to blocked-ips.csv → next run skips that proxy.

### Backward Compatibility
- Existing macro files in `data/macros/` load without errors.
- Run an existing macro (no autoreg blocks) → behavior identical to before changes.
- `GET /api/settings` returns settings with new sections but old sections intact.
- All 27 pre-existing blocks work unchanged.
