# 🔧 План задач — Macro Recorder Refactor

> Задачи выполняются последовательно. После каждой — проверка и исправление багов.

## Статус
| # | Задача | Статус |
|---|--------|--------|
| 1 | Объединить loop-elements + loop-table → единый `loop` с режимами | ⏳ |
| 2 | UI редактора — переключатель режимов для `loop` | ⏳ |
| 3 | Удалить старый код loop-table / loop-elements (чистка) | ⏳ |
| 4 | Новые режимы цикла: count и while | ⏳ |
| 5 | Именованные селекторы (save-selector) — серверная часть | ⏳ |
| 6 | UI для save-selector | ⏳ |
| 7 | Шаг set-variable (записать/дополнить переменную) | ⏳ |
| 8 | Переименование шагов (customLabel) | ⏳ |
| 9 | Финальная проверка + архив ZIP | ⏳ |

---

## Задача 1: Объединить loop-elements + loop-table → единый `loop` с режимами

### Файл: `server/player.js`

**Что сделать:**
В функции `executeSteps()` (строка ~460) есть два отдельных блока:
- `if (step.action === 'loop-table')` (строка ~481) — цикл по таблице данных
- `else if (step.action === 'loop-elements')` (строка ~522) — цикл по DOM-элементам

Нужно объединить их в ОДИН обработчик `loop`, который работает по полю `step.loopMode`:

```javascript
// Вместо двух отдельных блоков:
if (step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements') {
  // Определяем режим:
  // - Если step.action === 'loop-table' → mode = 'table' (обратная совместимость)
  // - Если step.action === 'loop-elements' → mode = 'elements' (обратная совместимость)
  // - Иначе → mode = step.loopMode || 'elements'
  const mode = step.action === 'loop-table' ? 'table'
             : step.action === 'loop-elements' ? 'elements'
             : (step.loopMode || 'elements');

  if (mode === 'table') {
    // ... существующий код loop-table (строки 483-520) без изменений
  } else if (mode === 'elements') {
    // ... существующий код loop-elements (строки 523-580) без изменений
  }
  // (mode === 'count' и 'while' будут добавлены в задаче 4)
}
```

**Также обновить в `runStep()` (строка ~775):**
```javascript
// Было:
if (step.children || step.action === 'loop-table' || step.action === 'loop-elements' || step.action === 'if' || step.action === 'try-except')
// Стало:
if (step.children || step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements' || step.action === 'if' || step.action === 'try-except')
```

**Не трогать:** Остальной код. Не менять extension/. Не менять editor/.

---

## Задача 2: UI редактора — переключатель режимов для `loop`

### Файл: `editor/app.js` (2314 строк)

**Что сделать:**

1. **В функции создания карточки шага** (ищи где создаются карточки для `loop-elements` и `loop-table`):
   - Заменить отдельные карточки `loop-elements` и `loop-table` на ОДНУ карточку `loop`
   - Новые шаги создаются с `action: 'loop'` и `loopMode: 'elements'` (по умолчанию)

2. **Добавить переключатель режима** внутри карточки loop:
   ```html
   <div class="loop-mode-switcher">
     <label>Режим:</label>
     <select class="loop-mode-select">
       <option value="elements">🔁 По элементам</option>
       <option value="table">🔄 По таблице</option>
     </select>
   </div>
   ```

3. **Показывать/скрывать поля в зависимости от режима:**
   - Режим `elements`: показать поля cssSelector, varName, maxElements
   - Режим `table`: показать поля tableName, maxRows

4. **Обратная совместимость:** Если загружен макрос со старым `action: 'loop-elements'` → показывать как `loop` с `loopMode: 'elements'`. Если `loop-table` → показывать как `loop` с `loopMode: 'table'`.

5. **При сохранении:** Всегда сохранять как `action: 'loop'` с `loopMode`.

6. **Цвет:** ОДИН цвет для всех режимов loop — зелёный (#a6e3a1 / #40a02b).

### Файл: `editor/style.css`
- Убрать отдельные стили для `.loop-table-block` и `.loop-elements-block` если есть
- Добавить единый `.loop-block` стиль (зелёный)

### Файл: `editor/index.html`
- Обновить карточки действий в панели: вместо двух карточек (loop-elements, loop-table) → одна карточка "🔁 Цикл (loop)"

**Не трогать:** server/, extension/

---

## Задача 3: Удалить старый код loop-table / loop-elements (чистка)

### Что сделать:
- В `editor/app.js`: удалить любые остатки кода, которые ссылаются на `loop-elements` или `loop-table` как отдельные действия (кроме обратной совместимости в player.js)
- В `editor/style.css`: убрать дублирующие стили
- Проверить `editor/index.html` на остатки
- В `server/player.js`: обратная совместимость ОСТАВИТЬ (старые макросы должны работать)

**Не трогать:** extension/ (там может быть запись, не ломать)

---

## Задача 4: Новые режимы цикла: count и while

### Файл: `server/player.js`

**В блоке `if (mode === ...)` добавить два новых режима:**

```javascript
} else if (mode === 'count') {
  // Цикл N раз
  const count = parseInt(step.count || '1');
  broadcastStatus(wss, { type: 'loop-started', path, loopType: 'count', total: count });
  
  for (let c = 0; c < count; c++) {
    runtimeVars['_loop_index'] = c;
    runtimeVars['_loop_total'] = count;
    broadcastStatus(wss, { type: 'loop-iteration', path, iteration: c + 1, total: count });
    
    const children = step.children || [];
    await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement);
    
    // Задержка между итерациями
    if (c < count - 1 && step.delayMin) {
      const delayMin = parseInt(step.delayMin || '1') * 1000;
      const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
      const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
      broadcastStatus(wss, { type: 'loop-delay', path, delayMs: delay });
      await p.waitForTimeout(delay);
    }
  }
  broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'count', totalIterations: count });

} else if (mode === 'while') {
  // Цикл пока условие истинно (используем ту же логику что в if-блоке)
  const maxIterations = parseInt(step.maxIterations || '1000'); // защита от бесконечного цикла
  let iteration = 0;
  
  broadcastStatus(wss, { type: 'loop-started', path, loopType: 'while' });
  
  while (evaluateCondition(step, tableRow) && iteration < maxIterations) {
    runtimeVars['_loop_index'] = iteration;
    broadcastStatus(wss, { type: 'loop-iteration', path, iteration: iteration + 1 });
    
    const children = step.children || [];
    await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement);
    iteration++;
    
    // Задержка
    if (step.delayMin) {
      const delayMin = parseInt(step.delayMin || '1') * 1000;
      const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
      const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
      await p.waitForTimeout(delay);
    }
  }
  broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'while', totalIterations: iteration });
}
```

### Файл: `editor/app.js`
**Добавить в переключатель режимов loop:**
```html
<option value="count">🔢 N раз</option>
<option value="while">🔄 Пока условие</option>
```

**Показывать поля по режиму:**
- `count`: поле `count` (число) + delayMin/delayMax
- `while`: поля `conditionVar`, `operator`, `compareValue`, `maxIterations` + delayMin/delayMax
  (Точно такие же поля как в блоке `if`, скопировать UI)

---

## Задача 5: Именованные селекторы (save-selector) — серверная часть

### Файл: `server/settings.js`
Добавить новую секцию `savedSelectors` в настройки:
```javascript
savedSelectors: {}
// Формат: { "название": "css-селектор" }
// Пример: { "кнопка_поиск": ".search-btn", "поле_email": "#email-input" }
```

### Файл: `server/index.js`
Добавить API эндпоинты:
```
GET    /api/selectors          → список всех сохранённых селекторов
POST   /api/selectors          → { name, selector } → сохранить
PUT    /api/selectors/:name    → { selector } → обновить
DELETE /api/selectors/:name    → удалить
```

### Файл: `server/player.js`
В функции `resolveVars()` или перед использованием `cssSelector`:
- Если `step.cssSelector` начинается с `@` → это именованный селектор
- Искать в `settings.savedSelectors[name]` и подставлять реальный CSS
- Пример: `@кнопка_поиск` → `.search-btn`

---

## Задача 6: UI для save-selector

### Файл: `editor/app.js`
1. В каждом поле `cssSelector` добавить кнопку "💾 Сохранить" рядом с полем
   - При нажатии: спросить имя → POST /api/selectors
2. Добавить кнопку "📋 Выбрать из сохранённых" рядом с полем cssSelector
   - При нажатии: показать список сохранённых → при выборе вставить `@имя`
3. В панель настроек: добавить вкладку "Селекторы" для управления списком

---

## Задача 7: Шаг set-variable (записать/дополнить переменную)

### Файл: `server/player.js`
Добавить в `executeAtomicStep()` новый case:
```javascript
case 'set-variable': {
  const varName = step.varName || step.saveAs || '';
  const value = resolveVars(step.value || '', step._tableRow || {});
  const setMode = step.setMode || 'replace'; // replace | append | prepend
  
  if (setMode === 'append') {
    runtimeVars[varName] = (runtimeVars[varName] || '') + value;
  } else if (setMode === 'prepend') {
    runtimeVars[varName] = value + (runtimeVars[varName] || '');
  } else {
    runtimeVars[varName] = value;
  }
  
  broadcastStatus(wss, { type: 'var-saved', path, varName, value: runtimeVars[varName] });
  break;
}
```

### Файл: `editor/app.js`
1. Добавить карточку действия "📝 Переменная" в категорию "🔌 Сервисы"
2. Поля в UI:
   - Имя переменной (varName)
   - Значение (value) — с поддержкой {{переменных}}
   - Режим: Записать / Дополнить в конец / Дополнить в начало (radio или select)

### Файл: `editor/index.html`
Добавить карточку в панель действий.

---

## Задача 8: Переименование шагов (customLabel)

### Файл: `editor/app.js`
1. У каждого шага в карточке добавить поле **customLabel** (название шага)
2. Рядом с иконкой действия показывать:
   - Если `customLabel` задан: `🔌 Мой кастомный шаг` (эмодзи оригинальное + customLabel)
   - Если не задан: стандартное название (`🔌 Клик`, `✍️ Ввод`, и т.д.)
3. **Эмодзи менять НЕЛЬЗЯ** — оно привязано к типу действия (action)
4. Кликнуть на название → поле редактирования (inline edit)
5. Пустое поле = вернуться к стандартному названию

### Формат данных:
```json
{
  "action": "click",
  "customLabel": "Нажать кнопку Войти",
  "cssSelector": ".login-btn"
}
```

---

## Задача 9: Финальная проверка
1. Запустить сервер: `cd server && node index.js`
2. Проверить что все эндпоинты работают
3. Проверить что старые макросы с `loop-elements` и `loop-table` загружаются корректно
4. Проверить что editor открывается без ошибок в консоли
5. Создать ZIP-архив
