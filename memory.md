# 🎬 Macro Recorder — Память проекта

> Читай этот файл в начале каждой сессии работы над проектом!

## Что это такое

Браузерный макро-рекордер — записывает действия пользователя в Chrome и воспроизводит их через Playwright. Разработан совместно с Katya (@katyagig).

## Архитектура

```
Chrome Extension (запись + снапшоты) → WebSocket → Node.js Server (localhost:3700)
                                                      ├── REST API (CRUD макросов)
                                                      ├── Snapshots API (HTML-снимки страниц)
                                                      ├── Web Editor (редактор с визуальным пикером)
                                                      └── Playwright Player (воспроизведение)
```

### Компоненты

| Компонент | Путь | Описание |
|-----------|------|----------|
| **Сервер** | `server/index.js` | Express + WebSocket на порту 3700. Макросы в `server/data/`, снапшоты в `server/data/snapshots/` |
| **Плеер** | `server/player.js` | Playwright — вложенные циклы, условия, прокси-ротация, SMS-коды |
| **Настройки** | `server/settings.js` | SMS-сервисы, прокси, фингерпринт, куки-профили, переменные, таблицы данных |
| **Расширение** | `extension/` | Chrome Manifest V3: content.js (подсветка + меню + снапшоты), background.js (WS), popup.js/html |
| **Редактор** | `editor/` | Блочный конструктор: карточки действий, визуальный пикер, цветные блоки |

## Все действия (полный список)

### 📌 Основные
| Действие | Иконка | Описание |
|----------|--------|----------|
| `click` | 📌 | Клик по элементу |
| `type` | ✍️ | Ввод текста / {{переменной}} + опц. Enter |
| `read` | 👁 | Чтение текста → сохранение в {{переменную}} |
| `wait` | ⏳ | Ждать элемент или N миллисекунд |
| `navigate` | 🔗 | Переход на URL |
| `go-back` | ↩️ | Назад (браузер) |
| `scroll` | 📜 | Прокрутка к элементу |
| `press-key` | ⌨️ | Нажать клавишу (Enter, Tab, Escape...) |
| `clear-field` | 🧹 | Очистить поле ввода |

### 🔁 Циклы и условия (блоки)
| Действие | Иконка | Описание |
|----------|--------|----------|
| `loop-table` | 🔄 | Цикл по таблице данных (каждая строка = итерация) |
| `loop-elements` | 🔁 | Цикл по элементам на странице (по CSS-селектору) |
| `if` | ❓ | Условие (если переменная = значение) + ИНАЧЕ |

### 🔌 Действия с текущим элементом (внутри loop-elements)
| Действие | Иконка | Описание |
|----------|--------|----------|
| `click-current` | 👆 | Клик по текущему элементу цикла |
| `type-current` | ✍️ | Ввод в текущий элемент цикла |
| `read-current` | 👁 | Чтение текущего элемента цикла |

### 🌐 Сервисы
| Действие | Иконка | Описание |
|----------|--------|----------|
| `request-code` | 📲 | Запрос SMS-кода → сохранение в {{переменную}} |
| `proxy-rotate` | 🔄 | Смена прокси (из списка или API ротации) |
| `save-to-table` | 💾 | Сохранить данные в таблицу |
| `user-input` | 💬 | Запрос ввода пользователя (модальное окно в браузере) → {{переменная}} |

## 📸 Снапшоты (HTML-снимки)

### Как работает:
1. **При записи** каждого шага extension/content.js вызывает `captureSnapshot()`:
   - Клонирует DOM, удаляет тяжёлые элементы (script, video, iframe, base64-картинки >1KB)
   - Обрезает до ~500KB
2. **background.js** отправляет снапшот на сервер через `POST /api/macros/:id/snapshots/:idx`
3. **Сервер** сохраняет в `server/data/snapshots/{macroId}/{stepIndex}.html`
4. **При запросе** `GET /api/macros/:id/snapshots/:idx` сервер инжектирует JavaScript-пикер:
   - Подсветка элемента при наведении (синяя рамка)
   - Tooltip с CSS-селектором
   - Клик → генерация селектора → `postMessage` обратно в редактор
5. **Редактор** показывает снапшот в iframe, пользователь кликает вместо ввода CSS вручную
6. **Стрелки ← →** позволяют листать снапшоты разных шагов

### API снапшотов:
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/macros/:id/snapshots/:idx` | Сохранить HTML-снапшот |
| GET | `/api/macros/:id/snapshots/:idx` | Получить снапшот с инжектированным пикером |
| GET | `/api/macros/:id/snapshots` | Список доступных снапшотов (массив индексов) |

## 🧱 Блочный конструктор (редактор)

### UI обновление (16.03.2026):
- **Карточки действий по категориям** вместо dropdown:
  - 📌 Основные (click, type, read, wait, navigate...)
  - 🔁 Циклы и условия (loop-table, loop-elements, if)
  - 🔌 Текущий элемент (click-current, type-current, read-current)
  - 🌐 Сервисы (request-code, proxy-rotate, save-to-table)
- **Цветные блоки** с вертикальной линией слева:
  - Синий = loop-table
  - Зелёный = loop-elements
  - Жёлтый = if
  - Оранжевый пунктир = else
- **Placeholder** для пустых блоков: "📦 Пусто — добавьте шаги"
- **Кнопка "📸 Выбрать"** для визуального выбора элемента на снапшоте
- **Подсказки** `{{переменная}}` в полях ввода
- **Drag-drop** шагов (пока только внутри одного контейнера)

## REST API (полный)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/macros` | Список макросов |
| GET | `/api/macros/:id` | Макрос с шагами |
| POST | `/api/macros` | Создать макрос |
| PUT | `/api/macros/:id` | Обновить макрос |
| DELETE | `/api/macros/:id` | Удалить макрос + его снапшоты |
| POST | `/api/macros/:id/run` | Запустить макрос |
| POST | `/api/macros/:id/steps/:idx/run` | Выполнить один шаг |
| POST | `/api/macros/:id/run-to/:idx` | Выполнить до указанного шага |
| POST | `/api/macros/:id/run-loop` | Запустить с повторами/таблицей (legacy) |
| POST | `/api/macros/:id/snapshots/:idx` | Сохранить снапшот |
| GET | `/api/macros/:id/snapshots/:idx` | Получить снапшот |
| GET | `/api/macros/:id/snapshots` | Список снапшотов |
| GET/PUT | `/api/settings` | Настройки |
| PATCH | `/api/settings/:section` | Обновить секцию |
| GET/PUT | `/api/variables` | Переменные |
| GET/PUT/DELETE | `/api/tables/:name` | Таблицы данных |

## Переменные и подстановка

- **Глобальные**: задаются в настройках, доступны через `{{имя}}`
- **Из таблицы**: при `loop-table` каждая колонка = переменная `{{колонка}}`
- **Из чтения**: `read` / `read-current` → `saveAs` → `{{результат}}`
- **Из SMS**: `request-code` → `saveAs` → `{{sms_code}}`
- **Системные**: `_loop_index`, `_loop_total`, `_current_proxy`, `_proxy_index`
- **Фильтры**: `{{var|numbers_only}}`, `{{var|trim}}`

## Вложенные циклы (пример сценария)

```
🔄 Цикл по таблице "search_names" ({{search_name}})
  ├── 📌 Клик → поле поиска
  ├── ✍️ Ввод → {{search_name}}
  ├── ⏳ Ждать → .search-result
  └── 🔁 Цикл по элементам ".search-result"
        ├── 👆 Клик текущий
        ├── ✍️ Ввод → /start + Enter
        └── ↩️ Назад
```

## Настройки (settings.js)

- **SMS-сервисы:** sms-activate, 5sim, smshub, custom (API ключ + base URL)
- **Прокси:** HTTP/SOCKS5, ротация через API или список, `proxy-rotate` действие
- **Фингерпринт:** UserAgent, язык, timezone, WebGL, платформа, ядра, память
- **Куки:** автосохранение, автозагрузка, именованные профили, JSON-импорт
- **Переменные:** глобальные key-value пары
- **Таблицы данных:** CSV/ручной ввод, используются в `loop-table`

## Запуск

```bash
cd server
npm install
npx playwright install chromium
node index.js
# → http://localhost:3700 (редактор)
# → ws://localhost:3700 (WebSocket для расширения)
```

Расширение: `chrome://extensions/` → Режим разработчика → Загрузить `extension/`

## Структура данных

### Атомарный шаг:
```json
{
  "action": "click|type|read|...",
  "cssSelector": ".class #id",
  "value": "текст или {{переменная}}",
  "saveAs": "имя_переменной",
  "pressEnter": true,
  "url": "URL (для navigate)",
  "key": "Enter (для press-key)",
  "waitType": "element|time",
  "waitTime": "1000",
  "timestamp": 1710000000000
}
```

### Блок (loop-table):
```json
{
  "action": "loop-table",
  "tableName": "search_names",
  "maxRows": 0,
  "delayMin": "1", "delayMax": "3",
  "children": [/* шаги */]
}
```

### Блок (loop-elements):
```json
{
  "action": "loop-elements",
  "cssSelector": ".result-item",
  "varName": "current_item",
  "maxElements": 0,
  "refreshEachIteration": false,
  "delayMin": "1", "delayMax": "3",
  "children": [/* шаги */]
}
```

### Блок (if):
```json
{
  "action": "if",
  "conditionVar": "bot_name",
  "operator": "not-empty|empty|equals|contains|...",
  "compareValue": "test",
  "children": [/* если ДА */],
  "elseChildren": [/* если НЕТ */]
}
```

## 🔴 TODO

### ✅ РЕШЕНО (16.03.2026):
1. ~~Нет снапшотов~~ → ✅ HTML-снапшоты + визуальный пикер в iframe
2. ~~read бесполезно~~ → ✅ saveAs → переменная
3. ~~Нет {{переменных}} в type~~ → ✅ resolveVars() + UI подсказки
4. ~~Некрасивые блоки~~ → ✅ Полный редизайн UI
5. ~~Нет смены прокси~~ → ✅ proxy-rotate
6. ~~Нет запроса кода~~ → ✅ request-code → переменная

### ✅ РЕШЕНО (17.03.2026):
7. ~~Хайлайт бегает пока меню открыто~~ → ✅ `mousemove` заблокирован когда меню видимо, выбор фиксируется на клике
8. ~~CSS ломается в снапшотах~~ → ✅ Двойной фикс: клиент (`captureSnapshot()` конвертирует URL в абсолютные) + сервер (инжектирует `<base href>` из URL шага)
9. ~~Снапшот всегда открывается с первого~~ → ✅ Умный выбор: открывается снимок соответствующий редактируемому шагу
10. ~~Клики проходят через ловилку в Telegram~~ → ✅ Агрессивный перехват: `mousedown/mouseup/click/pointerdown/pointerup` в capture phase + Shadow DOM support
11. ~~Запись в таблицу {{переменной}} не работает~~ → ✅ `save-to-table` поддерживает как `columns` массив, так и одиночное `value` поле
12. ~~Нет консоли с логами~~ → ✅ Консоль внизу с табами (Все/Макрос/Python/Ошибки) + детальные логи выполнения
13. ~~Нет Python-редактора~~ → ✅ Python-блоки с полным доступом к переменным + синтаксис-подсветка + консольный вывод

### ✅ РЕШЕНО (19.03.2026):
14. ~~Клики проходят через Telegram (touchstart/pointerdown)~~ → ✅ Добавлен перехват touchstart/touchend/contextmenu + preventDefault на pointerdown/pointerup
15. ~~Пауза пропала при записи~~ → ✅ Кнопка паузы крупная, зелёная/оранжевая, всегда видна вверху
16. ~~Нет профилей браузера~~ → ✅ Профили (user-data-dir): создание, запуск, удаление. Сохраняет cookies+localStorage+IndexedDB
17. ~~Нет дозаписи~~ → ✅ Кнопка "🔴 Дозапись": Playwright проигрывает до шага N, открывает браузер с расширением для продолжения записи
18. ~~Нет запроса ввода от пользователя~~ → ✅ Блок `user-input`: модальное окно в браузере, режим пароля, таймаут, сохранение в {{переменную}}

### ✅ РЕШЕНО (25.03.2026) — Большой рефакторинг:
19. ~~Нет выбора профиля для debug~~ → ✅ `startDebug()` читает `#runProfileSelect` и передаёт `profileName` в POST
20. ~~Скролл блокируется при debug~~ → ✅ Автоскролл отключен по умолчанию, кнопка "📌 Автоскролл" в debug-панели
21. ~~Loop-elements выполняется дважды~~ → ✅ Добавлен `continue` после обработки loop-блока
22. ~~Контекстное меню не работает на блоках~~ → ✅ Проверка `.block-header` и `.block-container[data-path]`
23. ~~Python скрипты разбросаны по папкам~~ → ✅ Консолидация в `data/python/`, поле `pyFile` для внешних скриптов
24. ~~Нет модульной системы блоков~~ → ✅ `data/blocks/` с 27 JSON-конфигами (name, color, type), API `/api/blocks`
25. ~~Нет персистентных переменных~~ → ✅ `data/variables/persistent.json`, load/save при старте/завершении макроса
26. ~~{{переменные}} работают не везде~~ → ✅ `resolveVars()` для всех полей, документация в `data/variables/README.md`
27. ~~Нет отключения блоков~~ → ✅ Кнопка 👁/👁‍🗨, `step.disabled`, визуально: прозрачность + пунктир + зачёркивание
28. ~~Нет индикатора drag-drop~~ → ✅ Синяя анимированная линия 3px при переносе шагов
29. ~~Файлы разбросаны~~ → ✅ Всё в `data/`: blocks, macros, python, variables, snapshots, settings, profiles
30. ~~Python блоки выполняются дважды~~ → ✅ Удалены дублирующие `broadcastStatus` вызовы из callers
31. ~~Debug крашится при рестарте~~ → ✅ Фикс race condition: удаление старой записи до создания новой, проверка `process === child`
32. ~~UnicodeDecodeError с китайскими символами~~ → ✅ `encoding='utf-8'` во всех `open()` и `ensure_ascii=False` в `json.dump()`

### ✅ РЕШЕНО (25.03.2026) — Новые фичи:
33. ~~Loop-elements не поддерживает динамические элементы~~ → ✅ Опция "🔄 Обновлять каждый цикл" (`refreshEachIteration`): цикл пере-запрашивает элементы на каждой итерации и продолжает пока есть новые. Чекбокс в UI, бейдж в карточке, бэкенд в player.js.

### Ещё можно:
- [ ] Реальная интеграция SMS API (sms-activate, 5sim)
- [ ] Drag-drop между блоками (не только внутри контейнера)
- [ ] Экспорт/импорт макросов (JSON)
- [ ] Хоткеи для записи
- [ ] Скриншоты (PNG) вместо HTML-снапшотов
- [ ] Отмена/повтор (undo/redo)
- [ ] Дублирование шагов/блоков
- [ ] Поиск по макросам

## Технологии

- Node.js + Express + ws (WebSocket)
- Playwright (headless: false)
- Chrome Extension Manifest V3
- Vanilla JS (без фреймворков)
- Catppuccin Mocha тёмная тема
- Все тексты на русском

## Обновления 25.03.2026

### Fix: Debug Panel Sticky + Responsive
- Debug variables panel (`#debugVarsPanel`) теперь `position: sticky; top: 0;` — не исчезает при скролле списка шагов
- Добавлен класс `.debug-layout` на `<main>` для правильного row-layout при отладке
- Responsive CSS: на экранах <900px debug panel переключается на горизонтальный layout
- На экранах <600px высоты — ограничена max-height панелей

### Feature: ZIP Backup (Version Control)
- Новая вкладка «💾 Резервные копии» в настройках
- Кнопка «💾 Сохранить версию» создаёт ZIP проекта (исключая node_modules, .git, profiles, snapshots)
- Бэкапы сохраняются в `F:\ANEN\Desktop\macro-recorder-backups\`
- Формат: `macro-recorder-YYYY-MM-DD-HHmmss.zip`
- Максимум 10 копий (старые удаляются автоматически)
- Восстановление из бэкапа с safety-backup
- API: `POST /api/backup/create`, `GET /api/backup/list`, `POST /api/backup/restore/:filename`
- npm-пакет `archiver` установлен в server/

### Bug Fix: loop-table only processed first row (runMacroLoop)
- **Root cause:** `runMacroLoop` calculated `totalIterations = Math.min(times || table.rows.length, table.rows.length)`. When `times` defaulted to 1, only 1 row was processed.
- **Fix (server/player.js):** Changed to `times > 0 ? Math.min(times, table.rows.length) : table.rows.length` — when `times=0`, all rows are used.
- **Fix (editor/app.js):** Changed client to send `times: 0` for table mode instead of `times || 9999`.
- Note: The inner `loop-table` action inside `executeSteps` was already correct (line ~665) — it iterates `for (let r = 0; r < totalRows; r++)` over the table properly.

### Bug Fix: Parallel windows all process same rows (race condition on globals)
- **Root cause:** `runMacroParallel()` in `server/player.js` runs N workers concurrently via `Promise.allSettled()`. Each worker swaps module-level globals (`page`, `browser`, `context`, `runtimeVars`) before `executeSteps()`. Since workers yield on `await`, they clobber each other's globals — all windows end up using the same `runtimeVars` from whichever worker wrote last.
- **The row distribution was already correct** — round-robin at lines 1290-1293 properly assigns row indices to each window. The bug was in the execution phase.
- **Fix:** Added `createMutex()` utility and wrapped the global-state-swap + `executeSteps()` in mutex acquire/release. Step execution is now serialized across workers while browser startup and navigation remain parallel.
- **Result:** Window 0 processes rows 0,2,4,6,8; Window 1 processes rows 1,3,5,7,9. No duplicates.

### Bug Fix: Fingerprint randomization logs out Telegram
- **Root cause:** `generateRandomFingerprint` changed platform, viewport, WebGL vendor, locale, timezone across unrelated regions — Telegram fingerprints all of these and forces re-login.
- **Fix (server/player.js):** Added `generateSafeFingerprint()` mode that only changes:
  - Chrome minor version (118-123) — looks like normal browser updates
  - Timezone within the same region (e.g., Europe/* stays in Europe)
  - Everything else stays consistent: viewport, platform, WebGL, locale, hardware
- **UI (editor/index.html):** Added "🔒 Сохранять сессию (безопасный режим)" checkbox, checked by default
- **API:** Added `fingerprintSafeMode` parameter (default: true) to run-loop and run-parallel endpoints

## Дата создания: 16.03.2026
## Разработчик: Katya (@katyagig) + Jag (AI)
