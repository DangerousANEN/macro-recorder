# Evidence: fixes-and-features

## AC1 — break/continue не показываются как failed steps
- `server/player.js` cases `break`/`continue` бросают `BreakError`/`ContinueError`, не вызывая `broadcastStatus(success:true)`.
- Catch-блок в `executeAtomicStep` явно re-throws эти исключения **без** `broadcastStatus({success:false})`. См. `server/player.js:1820-1827`.

## AC2 — Atomic delay block — DEFERRED
В этом PR не реализован отдельным блоком, поскольку фиксированная пауза покрывается существующим блоком `wait` (по времени или элементу) и `human-delay`. Перенос — отдельный PR.

## AC3 — Atomic assert block (✅)
- `data/blocks/assert.json` создан.
- `server/player.js` case `assert` использует существующий `evaluateCondition`, бросает `Error(message)` если ложно.
- Editor: action card в "🧪 Проверки и данные", config: переиспользует if-section + extra `cfgAssertSection` для сообщения.

## AC4 — Atomic screenshot block (📸)
- `data/blocks/screenshot.json` создан.
- `server/player.js` пишет в `data/snapshots/runtime/<macroId>/<prefix>-<ts>.png`, поддерживает `fullPage`.
- `currentMacroId` теперь module-level переменная (set в `runMacro` / `runMacroLoop`).
- `server/index.js` отдаёт файлы через `GET /api/snapshots/runtime/:macroId/:file`.
- WebSocket broadcast: `{ type: 'screenshot-saved', file: <relPath> }`.

## AC5 — Atomic extract block (🔍)
- `data/blocks/extract.json` создан.
- `server/player.js` case `extract` строит `RegExp(pattern, flags)`, извлекает группу, сохраняет в `vars[saveAs]`. Невалидная regex → понятная ошибка.

## AC6 — Block JSON definitions
Созданы все недостающие json-файлы:
- `data/blocks/assert.json`
- `data/blocks/screenshot.json`
- `data/blocks/extract.json`
- `data/blocks/browser-init.json`
- `data/blocks/switch-profile.json`
- `data/blocks/debug-dump.json` (`hiddenInPalette: true`)

Smoke-test проверяет наличие всех блоков через `GET /api/blocks`.

## AC7 — Export / Import macros
- `GET /api/macros/:id/export` отдаёт JSON c `Content-Disposition: attachment`.
- `POST /api/macros/import` принимает JSON-тело, регенерирует id если нужно, возвращает `{id, name}`.
- Editor toolbar: кнопки `💾 Экспорт` (рядом с удалением) и `📂 Импорт` (в sidebar header), скрытый `<input type=file>` для импорта.

## AC8 — Duplicate step
- `cloneStepFresh()` deep-копирует, регенерирует все вложенные `id` (children/elseChildren/exceptChildren/finallyChildren).
- `duplicateStepAtPath()` вставляет копию сразу после оригинала.
- Доступно из контекстного меню (`📑 Дублировать`) и через `Ctrl+D` / `Cmd+D`.

## AC9 — Sidebar macro search
- Поле `#macroSearchInput` в sidebar.
- `renderMacroList()` фильтрует case-insensitively по `name`, всегда сохраняет текущий выбранный макрос в списке.

## AC10 — Smoke test script
- `scripts/smoke-test.mjs` стартует сервер на отдельном порту, проверяет `/api/macros`, `/api/blocks`, `/api/settings`, `/api/variables`, проверяет наличие всех новых блоков, делает round-trip создание/экспорт/импорт/удаление.
- `npm run smoke` (из `server/`) запускает тест. Локально все проверки PASS.

## Verification
```
$ SMOKE_PORT=3701 node scripts/smoke-test.mjs
... 28 checks ...
SMOKE TEST: PASS
```
См. `evidence.json` для machine-readable статуса.
