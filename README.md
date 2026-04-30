# 🎬 Macro Recorder

Записывайте действия в браузере и воспроизводите их автоматически через
Playwright. Поддержка профилей, прокси, 2FA, SMS, captcha, циклов, условий,
дозаписи, отладчика и **MCP** (управление через LLM-агента: Claude Desktop,
Cursor, Devin).

## Архитектура

```
Chrome Extension (запись)  →  WebSocket  →  Server (localhost:3700)
                                              ├── REST API + WS
                                              ├── Web Editor (editor/)
                                              ├── Playwright Player
                                              └── MCP stdio (mcp/)
```

| Слой | Файл | Что делает |
| --- | --- | --- |
| HTTP API + WebSocket | `server/index.js` | Routes `/api/macros`, `/api/snapshots`, `/api/running`, broadcasts run events. |
| Player | `server/player.js` | Воспроизведение макроса через Playwright. Управляет браузером, переменными, контролем потока. |
| Selectors | `server/selectors.js` | `resolveSelector` (`@named`), `smartClick`, `smartFill` с fallback'ами. |
| Snapshot GC | `server/snapshot-gc.js` | Автоматическая чистка `data/snapshots/`. |
| Settings | `server/settings.js` | Глобальные переменные, persistent vars, savedSelectors. |
| Editor | `editor/index.html` + `app.js` | UI для редактирования / запуска / отладки. |
| Block defs | `data/blocks/<name>.json` | Метаданные действий (icon, name, color, fields). |
| MCP | `mcp/index.js` | stdio-сервер с tools для LLM-агента. |

## Установка

### Сервер

```bash
cd server
npm install
npx playwright install chromium
npm start
```

Сервер слушает `http://127.0.0.1:3700` (можно переопределить `PORT` / `HOST`).

### Chrome Extension

1. Chrome → `chrome://extensions/`
2. Developer mode ON → Load unpacked → выбрать `extension/`

### MCP сервер (опционально)

```bash
cd mcp
npm install
```

Конфиг для Claude Desktop / Cursor / Devin — см. `mcp/README.md`.

13 tools: `list_macros`, `get_macro`, `run_macro`, `stop_macro`, `list_running`,
`list_blocks`, `export_macro`, `import_macro`, плюс **agent debugging**:
`get_run_events`, `get_last_failure`, `inspect_running_page`, `query_dom`,
`patch_step`. Подробнее в [mcp/README.md](mcp/README.md#agent-debugging).

## Agent debugging API

Сервер отдаёт структурированный лог прогона + DOM-инспекцию, чтобы LLM-агент
мог понимать что ломается без 1000 скриншотов:

| Endpoint | Зачем |
| --- | --- |
| `GET /api/running/<runId>/events?since=<seq>` | поллить ход выполнения (step-completed, click-failed, var-saved…) |
| `GET /api/running/<runId>/failures?last=1` | последняя ошибка с попытками селекторов |
| `GET /api/running/<runId>/inspect` | URL/title + структурированное дерево body (без HTML-сырца) |
| `POST /api/running/<runId>/query-dom` | найти элементы по `{selector, kind, limit}` — `kind = css \| xpath \| placeholder \| role` |
| `PATCH /api/macros/<id>/steps/<path>` | точечный патч одного шага (например, добавить `fallbackSelectors`) |

`stepPath` — точечный путь: `3` = индекс 3, `2.children.0` = первый child шага 2.

Сценарий: запустил макрос → events показали `click-failed` на `step 5` →
`get_last_failure` дал список перепробованных селекторов → `query_dom` нашёл
реальный input → `patch_step` добавил `fallbackSelectors` → перезапустил.

## Запуск макросов

### Через UI

Откройте `http://localhost:3700`, выберите макрос, нажмите **▶▶ Запустить** или **🐛 Debug** для пошаговой отладки.

### Через API

```bash
curl -X POST http://localhost:3700/api/macros/<id>/run -H 'Content-Type: application/json' -d '{}'
curl -X POST http://localhost:3700/api/macros/<id>/run-loop -d '{"times": 5, "tableName": "test_bots"}'
curl -X POST http://localhost:3700/api/running/<runId>/stop
```

### Через MCP (LLM-агент)

```
list_macros        — список макросов
get_macro(id)      — полный JSON
run_macro(id)      — запустить
stop_macro(runId)  — остановить
list_running       — что запущено сейчас
list_blocks        — какие шаги поддерживаются
```

## Возможности editor'а

- Запись через Chrome extension + дозапись (🔴 **Дозапись** в toolbar)
- Drag-and-drop порядок шагов
- ▶ Запустить отдельный шаг / ⏩ Запустить до выбранного / ▶▶ Запустить всё
- 🐛 Debug: breakpoints, step-over/into/out, переменные в реальном времени, **watch-выражения**
- Ctrl+Z / Ctrl+Y — **undo / redo** на 50 шагов
- Ctrl+D — дублировать шаг
- Поиск макросов в sidebar
- Экспорт / импорт макроса (JSON)
- Контекстное меню на шаге (ПКМ): дублировать, вырезать, вставить, удалить
- Variables panel + watch-выражения с поддержкой `{{template}}`

## Поддерживаемые блоки (45+)

**Базовые:** `click`, `type`, `read`, `wait`, `navigate`, `scroll`, `press-key`, `hover`, `delay`, `clear-field`

**Управление:** `loop` (count/elements/table/while), `if`, `try-except`, `break`, `continue`, `set-variable`

**Браузер:** `browser-init`, `switch-profile`, `tab-open`, `tab-switch`, `tab-close`, `set-cookie`, `clear-cookies`, `eval-js`

**Данные:** `read-table`, `save-to-table`, `request-code`, `user-input`, `extract` (regex)

**Проверки:** `assert`, `screenshot`, `debug-dump`

Каждый шаг поддерживает:
- `cssSelector` или `xpath`
- `placeholder` для resilient lookup (`getByPlaceholder`)
- `fallbackSelectors`: список альтернатив (CSS-строки или `{kind, value, name?}`)
- `customLabel` для переименования в UI
- `customName` для отображения вместо action name

## Resilient selectors

```json
{
  "action": "click",
  "cssSelector": "#telegram-search-input",
  "placeholder": "Search",
  "fallbackSelectors": [
    ".input-search-input",
    "input[type=\"search\"]",
    {"kind": "role", "value": "textbox", "name": "Search"}
  ]
}
```

Player перебирает попытки в таком порядке: primary CSS → raw recorded → xpath → placeholder → user fallbacks → site-specific эвристики (для Telegram /a/ и /k/ есть встроенные).

## Snapshot auto-cleanup

`data/snapshots/runtime/` очищается автоматически при старте сервера:

```
RUNTIME_SNAPSHOT_MAX_AGE_DAYS=7      # удалить runtime-снимки старше 7 дней
EDITOR_SNAPSHOT_MAX_AGE_DAYS=30      # удалить editor-снимки старше 30 дней
SNAPSHOT_KEEP_PER_DIR=200            # оставить максимум 200 файлов на директорию
SNAPSHOT_GC_ON_BOOT=0                # отключить
```

Ручной запуск:

```bash
cd server && npm run gc:snapshots               # dry-run
node scripts/gc-snapshots.mjs --apply           # реально удалить
curl -X POST localhost:3700/api/snapshots/gc -d '{"apply":false}'
```

## Smoke tests

```bash
cd server && npm run smoke         # API contract: 36 проверок
cd server && npm run smoke:mcp     # MCP stdio: initialize + tools/list + tools/call
```

## Технологии

- Node.js 18+ + Express + ws
- Playwright (chromium-only, headed)
- Chrome Extension (Manifest V3)
- Vanilla JS (без фреймворков)
- `@modelcontextprotocol/sdk` для MCP
