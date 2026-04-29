const API = 'http://localhost:3700/api';
const WS_URL = 'ws://localhost:3700';

// AC6/AC7: Hardcoded fallbacks — will be merged with dynamic block definitions from data/blocks/
const ACTION_ICONS = {
  click: '📌', type: '✍️', read: '👁', wait: '⏳', navigate: '🔗', scroll: '📜',
  'get-sms-code': '📱', 'request-code': '📲', 'proxy-rotate': '🔄',
  'save-to-table': '💾', 'go-back': '↩️', 'press-key': '⌨️',
  'clear-field': '🧹', 'click-current': '👆', 'type-current': '✍️', 'read-current': '👁',
  'user-input': '💬', 'read-table': '📖',
  'loop': '🔁', 'loop-table': '🔄', 'loop-elements': '🔁', 'if': '❓', 'python': '🐍',
  'try-except': '🛡️',
  'set-variable': '📝',
  'break': '🛑',
  'continue': '⏭',
  // Autoreg blocks
  'get-sms-number': '📱', 'wait-sms-code': '📞', 'solve-captcha': '🧩',
  'save-account': '📋', 'check-blocked': '🔍', 'human-delay': '⏱️', 'release-number': '📧',
  'browser-init': '🌐', 'switch-profile': '🧭'
};
const ACTION_NAMES = {
  click: 'Клик', type: 'Ввод текста', read: 'Чтение → переменная', wait: 'Ожидание',
  navigate: 'Переход', scroll: 'Прокрутка', 'get-sms-code': 'SMS-код',
  'request-code': 'Запрос кода → переменная', 'proxy-rotate': 'Смена прокси',
  'save-to-table': 'В таблицу', 'go-back': 'Назад (браузер)',
  'press-key': 'Клавиша', 'clear-field': 'Очистить поле',
  'click-current': 'Клик текущий', 'type-current': 'Ввод текущий',
  'read-current': 'Чтение текущий', 'user-input': 'Запрос ввода',
  'read-table': 'Чтение из таблицы',
  'loop': 'Цикл',
  'loop-table': 'Цикл по таблице',
  'loop-elements': 'Цикл по элементам', 'if': 'Условие (если)',
  'python': 'Python-код',
  'try-except': 'Try / Except',
  'set-variable': 'Переменная',
  'break': 'Прервать цикл',
  'continue': 'Следующая итерация',
  // Autoreg blocks
  'get-sms-number': 'Купить номер', 'wait-sms-code': 'Ждать SMS код',
  'solve-captcha': 'Решить капчу', 'save-account': 'Сохранить аккаунт',
  'check-blocked': 'Проверить блокировку', 'human-delay': 'Человеческая пауза',
  'release-number': 'Освободить номер',
  'browser-init': 'Инициализировать браузер',
  'switch-profile': 'Сменить профиль'
};

// AC6/AC7: Block definitions loaded from server
let blockDefinitions = {};

async function loadBlockDefinitions() {
  try {
    const res = await fetch(`${API}/blocks`);
    blockDefinitions = await res.json();
    // Merge into ACTION_ICONS and ACTION_NAMES (definitions take precedence, fallbacks remain)
    for (const [action, def] of Object.entries(blockDefinitions)) {
      if (def.icon && !ACTION_ICONS[action]) ACTION_ICONS[action] = def.icon;
      if (def.name && !ACTION_NAMES[action]) ACTION_NAMES[action] = def.name;
    }
  } catch (e) {
    console.warn('Failed to load block definitions:', e);
  }
}

// AC7: Resolve block definition for a step — returns {icon, name, color} with fallbacks
function resolveBlockDef(action) {
  const def = blockDefinitions[action];
  return {
    icon: (def && def.icon) || ACTION_ICONS[action] || '❓',
    name: (def && def.name) || ACTION_NAMES[action] || action,
    color: (def && def.color) || null,
    type: (def && def.type) || (BLOCK_ACTIONS.includes(action) ? 'block' : 'atomic'),
  };
}

const BLOCK_ACTIONS = ['loop', 'loop-table', 'loop-elements', 'if', 'try-except'];
const NEEDS_SELECTOR = ['click', 'type', 'read', 'wait', 'scroll', 'clear-field', 'loop', 'loop-elements'];
const NEEDS_VALUE = ['type', 'type-current', 'navigate', 'save-to-table', 'set-variable'];
const NEEDS_SAVEAS = ['read', 'read-current', 'request-code', 'user-input', 'read-table', 'set-variable'];
const NEEDS_ENTER = ['type', 'type-current'];

let savedSelectors = {}; // { name: "css-selector" }

let macros = [];
let currentMacro = null;
let selectedPath = '';
let ws = null;
let settings = {};
let availableSnapshots = [];

// ==================== Debug Mode State ====================
let debugMode = false;
let debugBreakpoints = new Set(); // Set of step paths with breakpoints
let debugCurrentStepId = null;
let debugVariables = {};
let debugPreviousVariables = {};

// AC2: Autoscroll toggle state
let debugAutoscroll = false; // OFF by default per AC2
let consoleAutoscroll = true; // Console autoscroll (separate)

// Multiselect & clipboard
let multiSelectedPaths = new Set();
let lastClickedPath = null;
let clipboard = []; // Array of step copies

// Undo stack
let undoStack = []; // Array of {steps: deepCopy} snapshots
const MAX_UNDO = 50;

function pushUndo() {
  if (!currentMacro) return;
  undoStack.push(JSON.parse(JSON.stringify(currentMacro.steps)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function popUndo() {
  if (undoStack.length === 0 || !currentMacro) return false;
  currentMacro.steps = undoStack.pop();
  saveMacro();
  renderSteps();
  logToConsole('SYS', '↩️ Отменено', 'info');
  return true;
}

// Save and record for undo (push undo BEFORE calling this, or use undoAndSave)
function saveAndPushUndo() {
  saveMacro();
}

// Helper: push undo state, execute fn, save
function undoableDo(fn) {
  pushUndo();
  fn();
  saveMacro();
  renderSteps();
}

// Wrap operations: push undo BEFORE the operation
function withUndo(fn) {
  pushUndo();
  fn();
  saveMacro();
  renderSteps();
}

// Edit mode: 'add' or 'edit'
let configMode = 'add';
let configAction = '';
let configEditPath = '';
let configParentPath = '';
// Snapshot picker callback
let pickerCallback = null;

// ===== DOM =====
const macroList = document.getElementById('macroList');
const emptyMain = document.getElementById('emptyMain');
const macroEditor = document.getElementById('macroEditor');
const settingsPanel = document.getElementById('settingsPanel');
const macroNameInput = document.getElementById('macroNameInput');
const startUrlInput = document.getElementById('startUrlInput');
const editorStepsList = document.getElementById('editorStepsList');
const stepsEmpty = document.getElementById('stepsEmpty');
let connectionStatus = null; // Will be set after DOM is ready
let executionStatus = null; // Legacy - now using console

// ==================== Path Helpers ====================
function getStepByPath(steps, path) {
  if (path === '' || path === undefined || path === null) return null;
  const parts = String(path).split('.');
  let current = steps;
  for (const p of parts) {
    if (p === 'children' || p === 'elseChildren') {
      current = current[p] || [];
    } else {
      const idx = parseInt(p);
      if (!Array.isArray(current) || idx >= current.length) return null;
      current = current[idx];
    }
  }
  return current;
}

function removeStepAt(steps, path) {
  const parts = String(path).split('.');
  const idx = parseInt(parts[parts.length - 1]);
  const parentPath = parts.slice(0, -1).join('.');
  const arr = parentPath ? getStepByPath(steps, parentPath) : steps;
  if (Array.isArray(arr) && idx < arr.length) arr.splice(idx, 1);
}

// Insert a step into array at path. parentPath = 'children' portion, insertIdx = numeric position
function insertStepAt(steps, parentPath, insertIdx, step) {
  const arr = parentPath ? getStepByPath(steps, parentPath) : steps;
  if (Array.isArray(arr)) {
    const idx = Math.min(insertIdx, arr.length);
    arr.splice(idx, 0, step);
  }
}

// Safely move a step: handles index shifts when src and dst are in the same array
function moveStep(steps, srcPath, dstParentPath, dstIdx) {
  const srcStep = getStepByPath(steps, srcPath);
  if (!srcStep) return false;
  const stepCopy = JSON.parse(JSON.stringify(srcStep));

  const srcParts = String(srcPath).split('.');
  const srcIdx = parseInt(srcParts[srcParts.length - 1]);
  const srcParent = srcParts.slice(0, -1).join('.');

  // Remove source first
  removeStepAt(steps, srcPath);

  // If src and dst are in the same parent, adjust dstIdx
  let adjustedIdx = dstIdx;
  if (srcParent === (dstParentPath || '')) {
    if (srcIdx < dstIdx) adjustedIdx--;
  }

  // Insert at destination
  insertStepAt(steps, dstParentPath, adjustedIdx >= 0 ? adjustedIdx : 0, stepCopy);
  return true;
}

// Move step into a block's children/elseChildren/exceptChildren (append)
function moveStepIntoBlock(steps, srcPath, blockPath, childKey) {
  const srcStep = getStepByPath(steps, srcPath);
  if (!srcStep) return false;
  const stepCopy = JSON.parse(JSON.stringify(srcStep));

  // Remove source first — but save the block reference BEFORE removal
  // Find block by walking the tree (stable reference)
  const block = getStepByPath(steps, blockPath);
  if (!block) return false;

  // Check if removing src shifts block position
  const srcParts = String(srcPath).split('.');
  const srcIdx = parseInt(srcParts[srcParts.length - 1]);
  const srcParent = srcParts.slice(0, -1).join('.');
  const blockParts = String(blockPath).split('.');
  const blockIdx = parseInt(blockParts[blockParts.length - 1]);
  const blockParent = blockParts.slice(0, -1).join('.');

  removeStepAt(steps, srcPath);

  // Re-find block after removal (index may have shifted)
  let adjustedBlockPath = blockPath;
  if (srcParent === blockParent && srcIdx < blockIdx) {
    // Block shifted down by 1
    const newBlockIdx = blockIdx - 1;
    blockParts[blockParts.length - 1] = String(newBlockIdx);
    adjustedBlockPath = blockParts.join('.');
  }

  const targetBlock = getStepByPath(steps, adjustedBlockPath);
  if (!targetBlock) return false;

  const key = childKey || 'children';
  if (!targetBlock[key]) targetBlock[key] = [];
  targetBlock[key].push(stepCopy);
  return true;
}

// ==================== API ====================
async function fetchMacros() {
  const res = await fetch(`${API}/macros`);
  macros = await res.json();
  renderMacroList();
}

async function fetchMacro(id) {
  const res = await fetch(`${API}/macros/${id}`);
  currentMacro = await res.json();
  // Fetch available snapshots
  try {
    const snapRes = await fetch(`${API}/macros/${id}/snapshots`);
    availableSnapshots = await snapRes.json();
  } catch (e) { availableSnapshots = []; }
  renderEditor();
}

async function createMacro() {
  const res = await fetch(`${API}/macros`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Новый макрос' })
  });
  const macro = await res.json();
  await fetchMacros();
  selectMacro(macro.id);
}

async function saveMacro() {
  if (!currentMacro) return;
  await fetch(`${API}/macros/${currentMacro.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentMacro)
  });
  fetchMacros();
}

async function deleteMacro() {
  if (!currentMacro || !confirm('Удалить макрос?')) return;
  await fetch(`${API}/macros/${currentMacro.id}`, { method: 'DELETE' });
  currentMacro = null;
  showView('empty');
  fetchMacros();
}

// ==================== Run ====================
function openRunModal() {
  if (!currentMacro) return;
  const modal = document.getElementById('runModal');
  modal.style.display = 'flex';
  const tableSelect = document.getElementById('runTableName');
  if (tableSelect) {
    const tables = settings.dataTables || {};
    tableSelect.innerHTML = '<option value="">— без таблицы —</option>' +
      Object.keys(tables).map(n => `<option value="${esc(n)}">${esc(n)} (${tables[n].rows?.length || 0})</option>`).join('');
  }
  updateRunModeUI();
}

function updateRunModeUI() {
  const mode = document.querySelector('input[name="runMode"]:checked')?.value || 'once';
  const parallelEnabled = document.getElementById('runParallelEnabled')?.checked || false;
  const tg = document.getElementById('runTimesGroup');
  const tblg = document.getElementById('runTableGroup');
  const dg = document.getElementById('runDelayGroup');
  const pcheck = document.getElementById('runParallelCheck');
  const pg = document.getElementById('runParallelGroup');
  if (tg) tg.style.display = mode === 'times' ? 'block' : 'none';
  if (tblg) tblg.style.display = mode === 'table' ? 'block' : 'none';
  if (pcheck) pcheck.style.display = mode === 'table' ? 'block' : 'none';
  if (pg) pg.style.display = (mode === 'table' && parallelEnabled) ? 'block' : 'none';
  if (dg) dg.style.display = mode !== 'once' ? 'block' : 'none';
  // Reset parallel checkbox when not in table mode
  if (mode !== 'table' && document.getElementById('runParallelEnabled')) {
    document.getElementById('runParallelEnabled').checked = false;
  }
}

async function runAll() {
  if (!currentMacro) return;
  logToConsole('SYS', '▶ Выполнение...', 'info');
  try {
    const res = await fetch(`${API}/macros/${currentMacro.id}/run`, { method: 'POST' });
    const data = await res.json();
    logToConsole('SYS', data.ok ? '✅ Готово' : `❌ ${data.error}`, data.ok ? 'info' : 'error');
  } catch (e) { logToConsole('SYS', `❌ ${e.message}`, 'error'); }
}

async function runWithOptions() {
  if (!currentMacro) return;
  const mode = document.querySelector('input[name="runMode"]:checked')?.value || 'once';
  const parallelEnabled = document.getElementById('runParallelEnabled')?.checked || false;
  const profileName = document.getElementById('runProfileSelect')?.value || null;
  const fingerprintPerIteration = document.getElementById('runFingerprintPerIteration')?.checked || false;
  const fingerprintSafeMode = document.getElementById('runFingerprintSafeMode')?.checked !== false; // default true
  document.getElementById('runModal').style.display = 'none';
  
  if (mode === 'once') {
    logToConsole('SYS', '▶▶ Запуск...', 'info');
    try {
      const res = await fetch(`${API}/macros/${currentMacro.id}/run`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName })
      });
      const data = await res.json();
      logToConsole('SYS', data.ok ? '✅ Готово' : `❌ ${data.error}`, data.ok ? 'info' : 'error');
    } catch (e) { 
      logToConsole('SYS', `❌ ${e.message}`, 'error'); 
    }
    return;
  }

  // Table mode with parallel checkbox enabled → use run-parallel endpoint
  if (mode === 'table' && parallelEnabled) {
    const windowCount = parseInt(document.getElementById('runWindowCount')?.value) || 2;
    const tableName = document.getElementById('runTableName')?.value || '';
    const delayMin = parseInt(document.getElementById('runDelayMin')?.value) || 3;
    const delayMax = parseInt(document.getElementById('runDelayMax')?.value) || 10;
    if (!tableName) {
      logToConsole('SYS', '❌ Выберите таблицу для параллельного запуска', 'error');
      return;
    }
    logToConsole('SYS', `🪟 Параллельный запуск: ${windowCount} окон, таблица "${tableName}"`, 'info');
    try {
      const res = await fetch(`${API}/macros/${currentMacro.id}/run-parallel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowCount, tableName, delayMin, delayMax, profileName, fingerprintPerIteration, fingerprintSafeMode })
      });
      const data = await res.json();
      logToConsole('SYS', data.ok ? `🪟 Запущено ${windowCount} окон (runId: ${data.runId})` : `❌ ${data.error}`, data.ok ? 'info' : 'error');
    } catch (e) { logToConsole('SYS', `❌ ${e.message}`, 'error'); }
    return;
  }
  
  const times = parseInt(document.getElementById('runTimes')?.value) || 1;
  const tableName = mode === 'table' ? (document.getElementById('runTableName')?.value || '') : '';
  const delayMin = parseInt(document.getElementById('runDelayMin')?.value) || 3;
  const delayMax = parseInt(document.getElementById('runDelayMax')?.value) || 10;
  logToConsole('SYS', `🔄 Цикл...`, 'info');
  try {
    const res = await fetch(`${API}/macros/${currentMacro.id}/run-loop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ times: mode === 'table' ? 0 : times, tableName, delayMin, delayMax, profileName, fingerprintPerIteration, fingerprintSafeMode })
    });
    const data = await res.json();
    logToConsole('SYS', data.ok ? `✅ Цикл завершён` : `❌ ${data.error}`, data.ok ? 'info' : 'error');
  } catch (e) { logToConsole('SYS', `❌ ${e.message}`, 'error'); }
}

// ==================== Views ====================
const overviewPanel = document.getElementById('overviewPanel');

function showView(view) {
  emptyMain.style.display = view === 'empty' ? 'flex' : 'none';
  macroEditor.style.display = view === 'editor' ? 'flex' : 'none';
  settingsPanel.style.display = view === 'settings' ? 'flex' : 'none';
  overviewPanel.style.display = view === 'overview' ? 'flex' : 'none';
  const autoregPanel = document.getElementById('autoregPanel');
  if (autoregPanel) autoregPanel.style.display = view === 'autoreg' ? 'flex' : 'none';
  if (view === 'overview') renderOverview();
  if (view === 'autoreg') loadAutoregData();
}

// ==================== Render ====================
function renderMacroList() {
  if (macros.length === 0) {
    macroList.innerHTML = '<div class="empty-state">Нет макросов</div>';
    return;
  }
  macroList.innerHTML = macros.map(m => `
    <div class="macro-item ${currentMacro?.id === m.id ? 'active' : ''}" data-id="${m.id}">
      <div class="macro-item-name">${esc(m.name)}</div>
      <div class="macro-item-info">${m.stepsCount} шагов</div>
    </div>
  `).join('');
  macroList.querySelectorAll('.macro-item').forEach(el => {
    el.addEventListener('click', () => selectMacro(el.dataset.id));
  });
}

function selectMacro(id) { fetchMacro(id); showView('editor'); }

function renderEditor() {
  if (!currentMacro) return;
  macroNameInput.value = currentMacro.name;
  startUrlInput.value = currentMacro.startUrl || '';
  renderSteps();
  renderMacroList();
}

function renderSteps() {
  const steps = currentMacro?.steps || [];
  stepsEmpty.style.display = steps.length === 0 ? 'block' : 'none';
  editorStepsList.innerHTML = renderStepList(steps, '', 0);
  attachStepEvents();
}

// Recursive render
function renderStepList(steps, parentPath, startNum) {
  let html = '';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = parentPath ? `${parentPath}.${i}` : `${i}`;
    if (BLOCK_ACTIONS.includes(step.action)) {
      html += renderBlock(step, path, startNum + i);
    } else {
      html += renderStepCard(step, path, startNum + i);
    }
  }
  const addPath = parentPath || '';
  html += `<button class="block-add-btn" data-add-parent="${esc(addPath)}">＋ Добавить шаг</button>`;
  return html;
}

function renderBlock(step, path, num) {
  const collapsed = step._collapsed ? 'collapsed' : '';
  let blockClass = '', headerInfo = '', bodyHtml = '';

  if (step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements') {
    // Determine mode
    const loopMode = step.action === 'loop-table' ? 'table'
                   : step.action === 'loop-elements' ? 'elements'
                   : (step.loopMode || 'elements');
    blockClass = 'loop'; // single color for all loop modes

    // Mode labels
    const modeLabels = { elements: 'по элементам', table: 'по таблице', count: 'N раз', while: 'пока условие' };
    const modeLabel = modeLabels[loopMode] || loopMode;

    if (loopMode === 'table') {
      headerInfo = `<span class="block-badge" style="background:rgba(166,227,161,0.15);color:var(--green)">📊 ${modeLabel}</span>
        <span class="block-subtitle">Таблица: <b>${esc(step.tableName || '?')}</b></span>
        ${step.maxRows ? `<span class="block-badge">макс ${step.maxRows}</span>` : ''}
        ${step.refreshEachIteration ? `<span class="block-badge" style="color:var(--yellow)">🔄 обновлять</span>` : ''}
        ${step.delayMin ? `<span class="block-badge">⏳ ${step.delayMin}-${step.delayMax || step.delayMin}с</span>` : ''}`;
    } else if (loopMode === 'elements') {
      const sel = step.cssSelector || step.selector || '';
      headerInfo = `<span class="block-badge" style="background:rgba(166,227,161,0.15);color:var(--green)">🔁 ${modeLabel}</span>
        <span class="block-subtitle" style="font-family:monospace;font-size:11px">${esc(sel.substring(0, 50))}</span>
        ${step.varName ? `<span class="block-badge">→ {{${esc(step.varName)}}}</span>` : ''}
        <span class="block-badge" style="color:var(--teal)">{{_current}}</span>
        ${step.maxElements ? `<span class="block-badge">макс ${step.maxElements}</span>` : ''}
        ${step.refreshEachIteration ? `<span class="block-badge" style="color:var(--yellow)">🔄 обновлять</span>` : ''}`;
    } else if (loopMode === 'count') {
      headerInfo = `<span class="block-badge" style="background:rgba(166,227,161,0.15);color:var(--green)">🔢 ${modeLabel}</span>
        <span class="block-subtitle">Повторить: <b>${step.count || '1'}</b> раз</span>`;
    } else if (loopMode === 'while') {
      headerInfo = `<span class="block-badge" style="background:rgba(166,227,161,0.15);color:var(--green)">🔄 ${modeLabel}</span>
        <span class="block-subtitle">Пока: {{${esc(step.conditionVar || '?')}}} ${esc(step.operator || '?')} ${esc(step.compareValue || '')}</span>`;
    }

    const children = step.children || [];
    if (children.length === 0) {
      if (loopMode === 'elements') {
        bodyHtml = `<div class="block-empty-placeholder">📦 Пусто — добавьте действия для каждого элемента. Используйте {{_current}} для работы с текущим элементом.</div>`;
      } else {
        bodyHtml = `<div class="block-empty-placeholder">📦 Пусто — нажмите «＋» чтобы добавить шаги</div>`;
      }
    }
    bodyHtml += renderStepList(children, `${path}.children`, 0);

  } else if (step.action === 'if') {
    blockClass = 'if-block';
    const opLabels = { 'not-empty': '≠ пусто', 'empty': '= пусто', 'equals': '=', 'not-equals': '≠', 'contains': '∋', 'not-contains': '∌', 'starts-with': 'начин.', 'ends-with': 'конч.', 'greater-than': '>', 'less-than': '<' };
    headerInfo = `<span class="block-subtitle">{{${esc(step.conditionVar || '?')}}} ${esc(opLabels[step.operator] || '')} ${step.compareValue ? `"${esc(step.compareValue)}"` : ''}</span>`;
    bodyHtml = `<div style="margin-bottom:4px;font-size:11px;color:var(--green);font-weight:700;margin-left:14px">✅ ТОГДА:</div>`;
    const children = step.children || [];
    if (children.length === 0) bodyHtml += `<div class="block-empty-placeholder">Добавьте шаги для условия «ДА»</div>`;
    bodyHtml += renderStepList(children, `${path}.children`, 0);

    if (step.elseChildren && step.elseChildren.length > 0) {
      bodyHtml += `<div class="block-container else-block" data-path="${esc(path)}.else">
        <div class="block-header" style="padding:6px 10px">
          <span class="block-icon">↪️</span><span class="block-title" style="font-size:12px">ИНАЧЕ</span>
        </div>
        <div class="block-body">${renderStepList(step.elseChildren, `${path}.elseChildren`, 0)}</div>
      </div>`;
    }
    bodyHtml += `<button class="block-add-btn" data-add-else="${esc(path)}" style="border-color:var(--orange);color:var(--orange)">＋ Добавить в ИНАЧЕ</button>`;

  } else if (step.action === 'try-except') {
    blockClass = 'try-except';
    const onError = step.onError || 'continue';
    const errorLabels = { continue: 'pass (продолжить)', stop: 'остановить макрос', custom: 'выполнить except-блок' };
    headerInfo = `<span class="block-subtitle">except → <b>${esc(errorLabels[onError] || onError)}</b></span>`;

    bodyHtml = `<div style="margin-bottom:4px;font-size:11px;color:var(--green);font-weight:700;margin-left:14px">🛡️ TRY:</div>`;
    const children = step.children || [];
    if (children.length === 0) bodyHtml += `<div class="block-empty-placeholder">Добавьте шаги для блока try</div>`;
    bodyHtml += renderStepList(children, `${path}.children`, 0);

    // Except block
    bodyHtml += `<div class="block-container except-block" data-path="${esc(path)}.except">
      <div class="block-header" style="padding:6px 10px">
        <span class="block-icon">⚠️</span><span class="block-title" style="font-size:12px">EXCEPT${step.exceptError ? ` → {{${esc(step.exceptError)}}}` : ''}</span>
      </div>
      <div class="block-body">${renderStepList(step.exceptChildren || [], `${path}.exceptChildren`, 0)}</div>
    </div>`;

    // Finally block (optional)
    if (step.finallyChildren && step.finallyChildren.length > 0) {
      bodyHtml += `<div class="block-container finally-block" data-path="${esc(path)}.finally">
        <div class="block-header" style="padding:6px 10px">
          <span class="block-icon">🏁</span><span class="block-title" style="font-size:12px">НАКОНЕЦ</span>
        </div>
        <div class="block-body">${renderStepList(step.finallyChildren, `${path}.finallyChildren`, 0)}</div>
      </div>`;
    }
    bodyHtml += `<button class="block-add-btn" data-add-finally="${esc(path)}" style="border-color:var(--teal);color:var(--teal)">＋ Добавить в НАКОНЕЦ</button>`;
  }

  // AC10: disabled state for blocks
  const isBlockDisabled = step.disabled;

  return `<div class="block-container ${blockClass} ${isBlockDisabled ? 'block-disabled' : ''}" data-path="${esc(path)}" draggable="true">
    <div class="block-header" data-toggle="${esc(path)}">
      <span class="block-icon">${ACTION_ICONS[step.action]}</span>
      <span class="block-title step-name-label" data-step-path="${esc(path)}" title="Двойной клик — переименовать">${step.customName || ACTION_NAMES[step.action]}</span>
      ${headerInfo}
      <div class="block-actions">
        <button class="step-btn disable-toggle-btn ${isBlockDisabled ? 'is-disabled' : ''}" data-toggle-disable="${esc(path)}" title="${isBlockDisabled ? 'Включить блок' : 'Отключить блок'}">${isBlockDisabled ? '👁‍🗨' : '👁'}</button>
        <button class="step-btn run-btn" data-run-block="${esc(path)}" title="▶ Выполнить">▶</button>
        <button class="step-btn" data-edit-block="${esc(path)}" title="✏️">✏️</button>
        <button class="step-btn delete-btn" data-delete="${esc(path)}" title="🗑">🗑</button>
      </div>
      <span class="block-collapse ${collapsed}">▼</span>
    </div>
    <div class="block-body ${collapsed}">${bodyHtml}</div>
  </div>`;
}

function renderStepCard(step, path, num) {
  const isCurrent = step.action.endsWith('-current');
  const hasSnap = availableSnapshots.includes(num);
  const hasPyOverride = !!step.pythonOverride;
  let detail = '';
  if (step.value) detail += `<span class="step-action-value">"${esc(step.value)}"</span>`;
  if (step.pressEnter) detail += '<span class="step-action-value" style="color:var(--orange)"> + Enter</span>';
  if (step.saveAs) detail += `<span class="step-action-value" style="color:#a6e3a1"> → {{${esc(step.saveAs)}}}</span>`;
  if (step.action === 'navigate' && step.url) detail += `<span class="step-action-value">${esc((step.url).substring(0, 50))}</span>`;
  if (step.action === 'press-key') detail += `<span class="step-action-value">${esc(step.key || 'Enter')}</span>`;
  if (step.action === 'wait' && step.waitType === 'time') detail += `<span class="step-action-value">${step.waitTime || 1000}мс</span>`;
  if (step.action === 'proxy-rotate') detail += `<span class="step-action-value" style="color:var(--orange)">следующий прокси</span>`;
  if (step.action === 'request-code') detail += `<span class="step-action-value" style="color:var(--teal)">SMS → {{${esc(step.saveAs || step.varName || 'code')}}}</span>`;
  if (step.action === 'save-to-table') detail += `<span class="step-action-value" style="color:var(--orange)">📊 ${esc(step.tableName || 'results')}</span>`;
  if (step.action === 'user-input') detail += `<span class="step-action-value" style="color:var(--mauve)">"${esc((step.promptTitle || 'Ввод').substring(0, 40))}" → {{${esc(step.saveAs || 'user_input')}}}</span>`;
  if (step.action === 'read-table') detail += `<span class="step-action-value" style="color:var(--teal)">📊 ${esc(step.tableName || 'table')} [${esc(step.rowIndex || '0')}].${esc(step.columnName || 'column')}</span>`;
  if (step.action === 'python') {
    const codePreview = (step.pythonCode || step.value || '').trim().split('\n')[0].substring(0, 60);
    detail += `<span class="step-action-value" style="color:var(--yellow)">${esc(codePreview)}${codePreview.length < (step.pythonCode || step.value || '').length ? '...' : ''}</span>`;
  }
  if (step.action === 'set-variable') {
    const modeIcons = { replace: '📝', append: '➕', prepend: '⬆️' };
    detail = `<span class="step-action-value" style="color:var(--mauve)">${modeIcons[step.setMode] || '📝'} {{${esc(step.varName || step.saveAs || '?')}}} = "${esc((step.value || '').substring(0, 40))}"</span>`;
  }
  if (hasPyOverride) {
    detail += `<span class="step-py-badge" title="Python-override активен">🐍</span>`;
  }

  const isMultiSelected = multiSelectedPaths.has(path);

  const hasBreakpoint = debugBreakpoints.has(path);
  const isDebugCurrent = debugMode && debugCurrentStepId === path;

  // AC10: disabled state
  const isDisabled = step.disabled;
  // AC7: resolve block definition for unknown actions
  const blockDef = resolveBlockDef(step.action);

  return `<div class="step-card ${path === selectedPath ? 'selected' : ''} ${isMultiSelected ? 'multi-selected' : ''} ${hasPyOverride ? 'has-py-override' : ''} ${hasBreakpoint ? 'debug-breakpoint' : ''} ${isDebugCurrent ? 'debug-current' : ''} ${isDisabled ? 'step-disabled' : ''}" data-path="${esc(path)}" draggable="true">
    <div class="step-number">${num + 1}</div>
    <div class="step-icon">${blockDef.icon}${isCurrent ? '<span class="step-icon-current">↺</span>' : ''}</div>
    <div class="step-details">
      <div class="step-action"><span class="step-name-label" data-step-path="${esc(path)}" title="Двойной клик — переименовать">${step.customName ? esc(step.customName) : blockDef.name}</span> ${detail}</div>
      <div class="step-selector">${esc(step.cssSelector || step.selector || '')}</div>
    </div>
    ${hasSnap ? '<div class="step-snapshot-badge" title="Есть снимок страницы"></div>' : ''}
    <div class="step-actions">
      <button class="step-btn disable-toggle-btn ${isDisabled ? 'is-disabled' : ''}" data-toggle-disable="${esc(path)}" title="${isDisabled ? 'Включить шаг' : 'Отключить шаг'}">${isDisabled ? '👁‍🗨' : '👁'}</button>
      <button class="step-btn run-btn" data-run="${esc(path)}" title="▶">▶</button>
      ${step.action !== 'python' ? `<button class="step-btn py-override-btn ${hasPyOverride ? 'active' : ''}" data-py-override="${esc(path)}" title="🐍 Python-код">🐍</button>` : ''}
      <button class="step-btn" data-edit="${esc(path)}" title="✏️">✏️</button>
      <button class="step-btn delete-btn" data-delete="${esc(path)}" title="🗑">🗑</button>
    </div>
  </div>`;
}

function attachStepEvents() {
  // Nothing here — all events use delegation below
}

// ===== EVENT DELEGATION — single listeners on editorStepsList =====
// This ensures events work for ALL cards including nested ones inside blocks
let dragSrcPath = null;

function clearAllDragStyles() {
  editorStepsList.querySelectorAll('.drag-over, .drag-over-block').forEach(el => {
    el.classList.remove('drag-over');
    el.classList.remove('drag-over-block');
  });
  editorStepsList.querySelectorAll('.block-add-btn').forEach(btn => {
    btn.style.borderColor = '';
    btn.style.color = '';
    btn.style.background = '';
  });
  // AC11: Remove insertion line indicators
  editorStepsList.querySelectorAll('.drag-insert-line').forEach(el => el.remove());
}

// AC11: Show a horizontal insertion line before target element
function showInsertionLine(targetEl) {
  clearAllDragStyles();
  let line = document.querySelector('.drag-insert-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'drag-insert-line';
  }
  targetEl.parentNode.insertBefore(line, targetEl);
}

function isDescendant(srcPath, targetPath) {
  return targetPath.startsWith(srcPath + '.') || targetPath === srcPath;
}

// --- Click delegation ---
editorStepsList.addEventListener('click', e => {
  // Breakpoint toggle: click on step number
  const stepNumber = e.target.closest('.step-number');
  if (stepNumber) {
    const card = stepNumber.closest('.step-card');
    if (card) {
      e.stopPropagation();
      const path = card.dataset.path;
      if (debugBreakpoints.has(path)) {
        debugBreakpoints.delete(path);
        card.classList.remove('debug-breakpoint');
      } else {
        debugBreakpoints.add(path);
        card.classList.add('debug-breakpoint');
      }
      return;
    }
  }

  // Button actions (run, edit, delete, py-override)
  const runBtn = e.target.closest('[data-run]');
  if (runBtn) {
    e.stopPropagation();
    const parts = runBtn.dataset.run.split('.');
    if (parts.length === 1) {
      logToConsole('SYS', `▶ Шаг...`, 'info');
      fetch(`${API}/macros/${currentMacro.id}/steps/${parts[0]}/run`, { method: 'POST' })
        .then(r => r.json()).then(d => logToConsole('SYS', d.ok ? '✅' : `❌ ${d.error}`, d.ok ? 'info' : 'error'));
    }
    return;
  }
  const runBlockBtn = e.target.closest('[data-run-block]');
  if (runBlockBtn) { e.stopPropagation(); runAll(); return; }

  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) { e.stopPropagation(); openStepConfigForEdit(editBtn.dataset.edit); return; }

  const editBlockBtn = e.target.closest('[data-edit-block]');
  if (editBlockBtn) { e.stopPropagation(); openStepConfigForEdit(editBlockBtn.dataset.editBlock); return; }

  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    e.stopPropagation();
    pushUndo();
    removeStepAt(currentMacro.steps, deleteBtn.dataset.delete);
    saveMacro(); renderSteps();
    return;
  }

  // AC10: Disable toggle
  const disableBtn = e.target.closest('[data-toggle-disable]');
  if (disableBtn) {
    e.stopPropagation();
    const step = getStepByPath(currentMacro.steps, disableBtn.dataset.toggleDisable);
    if (step) {
      pushUndo();
      step.disabled = !step.disabled;
      saveMacro(); renderSteps();
    }
    return;
  }

  const pyBtn = e.target.closest('[data-py-override]');
  if (pyBtn) { e.stopPropagation(); openPyOverrideModal(pyBtn.dataset.pyOverride); return; }

  // Add step buttons
  const addParentBtn = e.target.closest('[data-add-parent]');
  if (addParentBtn) { openAddStepModal(addParentBtn.dataset.addParent); return; }

  const addElseBtn = e.target.closest('[data-add-else]');
  if (addElseBtn) {
    const step = getStepByPath(currentMacro.steps, addElseBtn.dataset.addElse);
    if (step && step.action === 'if') {
      if (!step.elseChildren) step.elseChildren = [];
      openAddStepModal(`${addElseBtn.dataset.addElse}.elseChildren`);
    }
    return;
  }

  const addFinallyBtn = e.target.closest('[data-add-finally]');
  if (addFinallyBtn) {
    const step = getStepByPath(currentMacro.steps, addFinallyBtn.dataset.addFinally);
    if (step && step.action === 'try-except') {
      if (!step.finallyChildren) step.finallyChildren = [];
      openAddStepModal(`${addFinallyBtn.dataset.addFinally}.finallyChildren`);
    }
    return;
  }

  const addExceptBtn = e.target.closest('[data-add-except]');
  if (addExceptBtn) {
    const step = getStepByPath(currentMacro.steps, addExceptBtn.dataset.addExcept);
    if (step && step.action === 'try-except') {
      if (!step.exceptChildren) step.exceptChildren = [];
      openAddStepModal(`${addExceptBtn.dataset.addExcept}.exceptChildren`);
    }
    return;
  }

  // Toggle collapse on block header
  const toggleHeader = e.target.closest('[data-toggle]');
  if (toggleHeader && !e.target.closest('.step-btn') && !e.target.closest('.block-actions')) {
    const step = getStepByPath(currentMacro.steps, toggleHeader.dataset.toggle);
    if (step) { step._collapsed = !step._collapsed; renderSteps(); }
    return;
  }

  // Card selection (click on card body, not buttons)
  const card = e.target.closest('.step-card');
  if (card && !e.target.closest('.step-btn')) {
    const path = card.dataset.path;
    const allCards = Array.from(editorStepsList.querySelectorAll('.step-card'));
    const allPaths = allCards.map(c => c.dataset.path);

    if (e.ctrlKey || e.metaKey) {
      if (multiSelectedPaths.has(path)) multiSelectedPaths.delete(path);
      else multiSelectedPaths.add(path);
      lastClickedPath = path;
    } else if (e.shiftKey && lastClickedPath) {
      const startIdx = allPaths.indexOf(lastClickedPath);
      const endIdx = allPaths.indexOf(path);
      if (startIdx !== -1 && endIdx !== -1) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        for (let i = from; i <= to; i++) multiSelectedPaths.add(allPaths[i]);
      }
    } else {
      multiSelectedPaths.clear();
      lastClickedPath = path;
    }
    selectedPath = path;
    renderSteps();
  }
});

// --- Double-click inline rename ---
editorStepsList.addEventListener('dblclick', e => {
  const nameSpan = e.target.closest('.step-name-label');
  if (!nameSpan) return;
  e.stopPropagation();
  const stepPath = nameSpan.dataset.stepPath;
  if (!stepPath || !currentMacro) return;
  const step = getStepByPath(currentMacro.steps, stepPath);
  if (!step) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = step.customName || '';
  input.placeholder = ACTION_NAMES[step.action] || step.action;
  input.className = 'inline-label-edit';
  input.style.cssText = 'background:#313244;color:#cdd6f4;border:1px solid #89b4fa;border-radius:4px;padding:2px 6px;font-size:13px;width:150px;';
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const save = () => {
    const newLabel = input.value.trim();
    if (newLabel) {
      step.customName = newLabel;
    } else {
      delete step.customName;
    }
    saveMacro();
    renderSteps();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') save();
    if (ev.key === 'Escape') { input.value = ''; save(); }
  });
});

// --- Context menu delegation ---
// AC4: Works on both .step-card AND .block-container (via .block-header)
editorStepsList.addEventListener('contextmenu', e => {
  // Try step-card first
  let target = e.target.closest('.step-card');
  // AC4: If not a step-card, try block-header or block-container
  if (!target) {
    const blockHeader = e.target.closest('.block-header');
    if (blockHeader) {
      target = blockHeader.closest('.block-container[data-path]');
    }
  }
  if (!target) {
    const blockContainer = e.target.closest('.block-container[data-path]');
    if (blockContainer) target = blockContainer;
  }
  if (!target || !target.dataset.path) return;
  e.preventDefault();
  e.stopPropagation();

  const path = target.dataset.path;
  if (!multiSelectedPaths.has(path) && multiSelectedPaths.size > 0) {
    multiSelectedPaths.clear();
  }
  if (multiSelectedPaths.size === 0) {
    multiSelectedPaths.add(path);
    selectedPath = path;
  }
  showContextMenu(e.clientX, e.clientY, path);
  editorStepsList.querySelectorAll('.step-card').forEach(c => {
    c.classList.toggle('multi-selected', multiSelectedPaths.has(c.dataset.path));
    c.classList.toggle('selected', c.dataset.path === selectedPath);
  });
  editorStepsList.querySelectorAll('.block-container[data-path]').forEach(c => {
    c.classList.toggle('multi-selected', multiSelectedPaths.has(c.dataset.path));
  });
});

// --- Drag & Drop delegation ---
// Track actual mousedown target so dragstart can verify header-initiated drags
let _dragMousedownTarget = null;
editorStepsList.addEventListener('mousedown', e => { _dragMousedownTarget = e.target; }, true);

editorStepsList.addEventListener('dragstart', e => {
  const card = e.target.closest('.step-card[draggable]');
  const block = e.target.closest('.block-container[draggable]');

  if (card) {
    dragSrcPath = card.dataset.path;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcPath);
    setTimeout(() => card.style.opacity = '0.4', 0);
  } else if (block) {
    const header = block.querySelector(':scope > .block-header');
    // Use the real mousedown target to check if drag started from the header
    const realTarget = _dragMousedownTarget || e.target;
    if (!header || !header.contains(realTarget)) { e.preventDefault(); return; }
    dragSrcPath = block.dataset.path;
    block.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcPath);
    setTimeout(() => block.style.opacity = '0.4', 0);
  }
});

editorStepsList.addEventListener('dragend', e => {
  const el = e.target.closest('.dragging');
  if (el) { el.classList.remove('dragging'); el.style.opacity = ''; }
  clearAllDragStyles();
  dragSrcPath = null;
});

editorStepsList.addEventListener('dragover', e => {
  if (!dragSrcPath) return;

  // Drop on step-card → insert before (AC11: show insertion line)
  const card = e.target.closest('.step-card');
  if (card && card.dataset.path !== dragSrcPath && !isDescendant(dragSrcPath, card.dataset.path)) {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    showInsertionLine(card);
    return;
  }

  // Drop on block header → insert before block (AC11: show insertion line)
  const blockHeader = e.target.closest('.block-header');
  if (blockHeader) {
    const block = blockHeader.closest('.block-container[draggable]');
    if (block && block.dataset.path !== dragSrcPath && !isDescendant(dragSrcPath, block.dataset.path)) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      showInsertionLine(block);
      return;
    }
  }

  // Drop on block-body / placeholder → drop INTO block
  const blockBody = e.target.closest('.block-body');
  const placeholder = e.target.closest('.block-empty-placeholder');
  const zone = blockBody || placeholder;
  if (zone) {
    const bc = zone.closest('.block-container[draggable]') || zone.closest('.block-container');
    if (bc && !isDescendant(dragSrcPath, bc.dataset.path)) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      clearAllDragStyles();
      zone.classList.add('drag-over');
      return;
    }
  }

  // Drop on add-btn
  const addBtn = e.target.closest('.block-add-btn[data-add-parent]');
  if (addBtn) {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearAllDragStyles();
    addBtn.style.borderColor = 'var(--mauve)';
    addBtn.style.color = 'var(--mauve)';
    addBtn.style.background = 'rgba(203,166,247,0.1)';
    return;
  }

  // Root level (empty space)
  if (!e.target.closest('.step-card') && !e.target.closest('.block-container')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
});

editorStepsList.addEventListener('dragleave', e => {
  const card = e.target.closest?.('.step-card');
  if (card) card.classList.remove('drag-over');
  const block = e.target.closest?.('.block-container');
  if (block) block.classList.remove('drag-over-block');
});

editorStepsList.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  clearAllDragStyles();
  if (!dragSrcPath || !currentMacro) return;

  // Drop on step-card → insert before
  const card = e.target.closest('.step-card');
  if (card && card.dataset.path !== dragSrcPath && !isDescendant(dragSrcPath, card.dataset.path)) {
    pushUndo();
    const dropParts = card.dataset.path.split('.');
    const dropIdx = parseInt(dropParts[dropParts.length - 1]);
    const dropParent = dropParts.slice(0, -1).join('.');
    moveStep(currentMacro.steps, dragSrcPath, dropParent, dropIdx);
    saveMacro(); renderSteps();
    dragSrcPath = null;
    return;
  }

  // Drop on block header → insert before block
  const blockHeader = e.target.closest('.block-header');
  if (blockHeader) {
    const block = blockHeader.closest('.block-container[draggable]');
    if (block && block.dataset.path !== dragSrcPath && !isDescendant(dragSrcPath, block.dataset.path)) {
      pushUndo();
      const dropParts = block.dataset.path.split('.');
      const dropIdx = parseInt(dropParts[dropParts.length - 1]);
      const dropParent = dropParts.slice(0, -1).join('.');
      moveStep(currentMacro.steps, dragSrcPath, dropParent, dropIdx);
      saveMacro(); renderSteps();
      dragSrcPath = null;
      return;
    }
  }

  // Drop on block-body/placeholder → append to children
  const blockBody = e.target.closest('.block-body');
  const placeholder = e.target.closest('.block-empty-placeholder');
  const zone = blockBody || placeholder;
  if (zone) {
    const bc = zone.closest('.block-container[draggable]') || zone.closest('.block-container');
    if (bc && !isDescendant(dragSrcPath, bc.dataset.path)) {
      const isElse = zone.closest('.else-block');
      const isExcept = zone.closest('.except-block');
      let childKey = 'children';
      if (isElse) childKey = 'elseChildren';
      else if (isExcept) childKey = 'exceptChildren';
      pushUndo();
      moveStepIntoBlock(currentMacro.steps, dragSrcPath, bc.dataset.path, childKey);
      saveMacro(); renderSteps();
      dragSrcPath = null;
      return;
    }
  }

  // Drop on add-btn
  const addBtn = e.target.closest('.block-add-btn[data-add-parent]');
  if (addBtn) {
    const parentPath = addBtn.dataset.addParent;
    const srcStep = getStepByPath(currentMacro.steps, dragSrcPath);
    if (srcStep) {
      pushUndo();
      const stepCopy = JSON.parse(JSON.stringify(srcStep));
      removeStepAt(currentMacro.steps, dragSrcPath);
      if (!parentPath) currentMacro.steps.push(stepCopy);
      else {
        const arr = getStepByPath(currentMacro.steps, parentPath);
        if (Array.isArray(arr)) arr.push(stepCopy);
      }
      saveMacro(); renderSteps();
    }
    dragSrcPath = null;
    return;
  }

  // Root level (empty space) → append to end
  if (!e.target.closest('.step-card') && !e.target.closest('.block-container')) {
    const srcStep = getStepByPath(currentMacro.steps, dragSrcPath);
    if (srcStep) {
      pushUndo();
      const stepCopy = JSON.parse(JSON.stringify(srcStep));
      removeStepAt(currentMacro.steps, dragSrcPath);
      currentMacro.steps.push(stepCopy);
      saveMacro(); renderSteps();
    }
  }
  dragSrcPath = null;
});

// ==================== PYTHON OVERRIDE MODAL ====================
let pyOverrideEditPath = '';

function generatePythonFromStep(step) {
  const sel = step.cssSelector || step.selector || 'СЕЛЕКТОР';
  const selEsc = sel.replace(/"/g, '\\"');
  let code = `# Авто-генерация из шага: ${ACTION_NAMES[step.action] || step.action}\n`;
  code += `# Селектор: ${sel}\n\n`;

  switch (step.action) {
    case 'click':
      code += `page.click("${selEsc}")\n`;
      break;
    case 'type':
      code += `page.fill("${selEsc}", "${(step.value || '').replace(/"/g, '\\"')}")\n`;
      if (step.pressEnter) code += `page.press("${selEsc}", "Enter")\n`;
      break;
    case 'type-current':
      code += `# Ввод в текущий элемент цикла\ncurrent_element.fill("${(step.value || '').replace(/"/g, '\\"')}")\n`;
      if (step.pressEnter) code += `current_element.press("Enter")\n`;
      break;
    case 'read':
      code += `${step.saveAs || 'result'} = page.text_content("${selEsc}")\n`;
      code += `print(f"Прочитано: {${step.saveAs || 'result'}}")\n`;
      break;
    case 'read-current':
      code += `${step.saveAs || 'result'} = current_element.text_content()\n`;
      break;
    case 'click-current':
      code += `current_element.click()\n`;
      break;
    case 'wait':
      if (step.waitType === 'time') {
        code += `import time\ntime.sleep(${(parseInt(step.waitTime || '1000') / 1000).toFixed(1)})\n`;
      } else {
        code += `page.wait_for_selector("${selEsc}")\n`;
      }
      break;
    case 'navigate':
      code += `page.goto("${(step.url || '').replace(/"/g, '\\"')}")\n`;
      break;
    case 'go-back':
      code += `page.go_back()\n`;
      break;
    case 'scroll':
      code += `page.evaluate('document.querySelector("${selEsc}").scrollIntoView({behavior:"smooth",block:"center"})')\n`;
      break;
    case 'press-key':
      code += `page.keyboard.press("${step.key || 'Enter'}")\n`;
      break;
    case 'clear-field':
      code += `page.fill("${selEsc}", "")\n`;
      break;
    case 'save-to-table':
      code += `# Сохранение в таблицу "${step.tableName || 'results'}"\n`;
      code += `print("Сохраняем данные...")\n`;
      break;
    case 'request-code':
      code += `# Запрос SMS-кода\n${step.saveAs || 'sms_code'} = input("Введите код: ") # заглушка\n`;
      break;
    case 'proxy-rotate':
      code += `# Смена прокси\nprint("Ротация прокси...")\n`;
      break;
    default:
      code += `# TODO: реализуйте логику для "${step.action}"\nprint("Выполняем: ${step.action}")\n`;
  }

  code += `\n# Дописывайте свою логику ниже:\n# try/except, условия, дополнительные клики и т.д.\n`;
  return code;
}

function openPyOverrideModal(path) {
  const step = getStepByPath(currentMacro.steps, path);
  if (!step) return;
  pyOverrideEditPath = path;

  const modal = document.getElementById('pyOverrideModal');
  const title = document.getElementById('pyOverrideTitle');
  const info = document.getElementById('pyOverrideInfo');
  const codeEl = document.getElementById('pyOverrideCode');
  const testOutput = document.getElementById('pyOverrideTestOutput');
  const testStatus = document.getElementById('pyOverrideTestStatus');

  title.textContent = `🐍 Python-код: ${ACTION_ICONS[step.action] || ''} ${ACTION_NAMES[step.action] || step.action}`;
  info.innerHTML = `<span class="py-override-step-info">${ACTION_ICONS[step.action]} <b>${ACTION_NAMES[step.action]}</b> → <code>${esc(step.cssSelector || step.selector || step.url || step.key || '—')}</code></span>`;

  // If there's existing override, show it; otherwise generate from step
  if (step.pythonOverride) {
    codeEl.value = step.pythonOverride;
  } else {
    codeEl.value = generatePythonFromStep(step);
  }

  testOutput.style.display = 'none';
  testStatus.textContent = '';
  modal.style.display = 'flex';
}

// Save Python override
document.getElementById('pyOverrideSave').addEventListener('click', () => {
  const step = getStepByPath(currentMacro.steps, pyOverrideEditPath);
  if (!step) return;
  const code = document.getElementById('pyOverrideCode').value.trim();
  if (code) {
    step.pythonOverride = code;
  } else {
    delete step.pythonOverride;
  }
  saveMacro(); renderSteps();
  document.getElementById('pyOverrideModal').style.display = 'none';
});

// Clear Python override
document.getElementById('pyOverrideClear').addEventListener('click', () => {
  const step = getStepByPath(currentMacro.steps, pyOverrideEditPath);
  if (!step) return;
  delete step.pythonOverride;
  saveMacro(); renderSteps();
  document.getElementById('pyOverrideModal').style.display = 'none';
});

// Cancel
document.getElementById('pyOverrideCancel').addEventListener('click', () => {
  document.getElementById('pyOverrideModal').style.display = 'none';
});
document.getElementById('pyOverrideClose').addEventListener('click', () => {
  document.getElementById('pyOverrideModal').style.display = 'none';
});

// Test Python override
document.getElementById('pyOverrideTest').addEventListener('click', async () => {
  const code = document.getElementById('pyOverrideCode').value;
  if (!code.trim()) return;
  const statusEl = document.getElementById('pyOverrideTestStatus');
  const outputEl = document.getElementById('pyOverrideTestOutput');
  statusEl.textContent = '⏳ Выполняю...';
  statusEl.style.color = 'var(--yellow)';
  outputEl.style.display = 'none';
  outputEl.classList.remove('has-error');
  const variables = settings.variables?.global || {};
  try {
    const res = await fetch(`${API}/python/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, variables })
    });
    const data = await res.json();
    outputEl.style.display = 'block';
    if (data.ok) {
      statusEl.textContent = '✅ Успешно';
      statusEl.style.color = 'var(--green)';
      let html = data.output ? esc(data.output) : '';
      if (data.variables && Object.keys(data.variables).length > 0) {
        const changedVars = Object.entries(data.variables).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `  {{${k}}} = ${JSON.stringify(v)}`).join('\n');
        if (changedVars) html += (html ? '\n' : '') + '<div class="py-out-vars">📋 Переменные:\n' + esc(changedVars) + '</div>';
      }
      outputEl.innerHTML = html || '<span style="color:var(--overlay)">(нет вывода)</span>';
    } else {
      statusEl.textContent = '❌ Ошибка';
      statusEl.style.color = 'var(--red)';
      outputEl.classList.add('has-error');
      outputEl.textContent = (data.output || '') + '\n' + (data.error || '');
    }
  } catch (e) {
    statusEl.textContent = '❌ Сервер недоступен';
    statusEl.style.color = 'var(--red)';
    outputEl.style.display = 'block';
    outputEl.classList.add('has-error');
    outputEl.textContent = e.message;
  }
});

// Tab key in override editor
document.getElementById('pyOverrideCode').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 4;
  }
});

// ==================== ADD STEP MODAL (action cards) ====================
function openAddStepModal(parentPath) {
  configParentPath = parentPath || '';

  // Show/hide loop control category based on whether we're inside a loop
  const loopControlCat = document.getElementById('loopControlCategory');
  if (loopControlCat) {
    const insideLoop = isInsideLoop(parentPath);
    loopControlCat.style.display = insideLoop ? 'block' : 'none';
  }

  document.getElementById('addStepModal').style.display = 'flex';
}

function isInsideLoop(parentPath) {
  if (!parentPath || !currentMacro) return false;
  // Walk up the path checking for loop ancestors
  const parts = parentPath.split('.');
  let current = currentMacro.steps;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'children' || p === 'elseChildren' || p === 'exceptChildren' || p === 'finallyChildren') {
      current = current[p] || [];
    } else {
      const idx = parseInt(p);
      if (!Array.isArray(current) || idx >= current.length) return false;
      const step = current[idx];
      if (step && (step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements')) {
        return true;
      }
      current = step;
    }
  }
  return false;
}

// When user clicks an action card → open config modal
document.querySelectorAll('[data-new-action]').forEach(card => {
  card.addEventListener('click', () => {
    let action = card.dataset.newAction;
    // Convert old loop cards to unified loop
    if (action === 'loop-table' || action === 'loop-elements') {
      const origAction = action;
      action = 'loop';
      // Pre-set mode for openStepConfigForAdd
      window._pendingLoopMode = origAction === 'loop-table' ? 'table' : 'elements';
    }
    document.getElementById('addStepModal').style.display = 'none';
    openStepConfigForAdd(action);
  });
});

// ==================== STEP CONFIG MODAL ====================
function openStepConfigForAdd(action) {
  configMode = 'add';
  configAction = action;
  const modal = document.getElementById('stepConfigModal');
  document.getElementById('stepConfigTitle').textContent = `${ACTION_ICONS[action] || ''} ${ACTION_NAMES[action] || action}`;
  resetConfigFields();
  showConfigFields(action);
  // If adding a loop with pending mode, apply it
  if (action === 'loop' && window._pendingLoopMode) {
    const modeSelect = document.getElementById('cfgLoopMode');
    if (modeSelect) {
      modeSelect.value = window._pendingLoopMode;
      updateLoopModeFields(window._pendingLoopMode);
    }
    delete window._pendingLoopMode;
  }
  // Hide convert button in add mode
  document.getElementById('convertToPython').style.display = 'none';
  modal.style.display = 'flex';
}

function openStepConfigForEdit(path) {
  const step = getStepByPath(currentMacro.steps, path);
  if (!step) return;
  configMode = 'edit';
  configEditPath = path;
  configAction = step.action;
  const modal = document.getElementById('stepConfigModal');
  document.getElementById('stepConfigTitle').textContent = `✏️ ${ACTION_ICONS[step.action]} ${ACTION_NAMES[step.action]}`;
  resetConfigFields();
  showConfigFields(step.action);
  
  // Show "Convert to Python" button for non-Python actions
  const convertBtn = document.getElementById('convertToPython');
  if (step.action !== 'python' && !BLOCK_ACTIONS.includes(step.action)) {
    convertBtn.style.display = 'inline-block';
    convertBtn.onclick = () => convertStepToPython(step);
  } else {
    convertBtn.style.display = 'none';
  }
  
  // Fill values
  document.getElementById('cfgCustomName').value = step.customName || '';
  document.getElementById('cfgSelector').value = step.cssSelector || step.selector || '';
  document.getElementById('cfgValue').value = step.value || step.url || '';
  document.getElementById('cfgSaveAs').value = step.saveAs || step.varName || '';
  document.getElementById('cfgPressEnter').checked = step.pressEnter || false;
  if (step.action === 'set-variable') {
    const setModeEl = document.getElementById('cfgSetMode');
    if (setModeEl) setModeEl.value = step.setMode || 'replace';
  }
  if (step.action === 'wait') {
    document.getElementById('cfgWaitType').value = step.waitType || 'element';
    document.getElementById('cfgWaitTime').value = step.waitTime || '';
    if (step.waitType === 'time') document.getElementById('cfgWaitTime').style.display = 'block';
  }
  if (step.action === 'press-key') document.getElementById('cfgKey').value = step.key || 'Enter';
  if (step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements') {
    const loopMode = step.action === 'loop-table' ? 'table'
                   : step.action === 'loop-elements' ? 'elements'
                   : (step.loopMode || 'elements');
    document.getElementById('cfgLoopMode').value = loopMode;
    updateLoopModeFields(loopMode);
    if (loopMode === 'table') {
      populateTableSelect('cfgLoopTableName', step.tableName);
      document.getElementById('cfgLoopMaxRows').value = step.maxRows || 0;
      document.getElementById('cfgLoopDelayMin').value = step.delayMin || 1;
      document.getElementById('cfgLoopDelayMax').value = step.delayMax || 3;
      document.getElementById('cfgLoopRefreshTable').checked = step.refreshEachIteration || false;
    } else if (loopMode === 'elements') {
      document.getElementById('cfgSelector').value = step.cssSelector || step.selector || '';
      document.getElementById('cfgLoopVarName2').value = step.varName || '';
      document.getElementById('cfgLoopMaxElements').value = step.maxElements || 0;
      document.getElementById('cfgLoopElemDelayMin').value = step.delayMin || 1;
      document.getElementById('cfgLoopElemDelayMax').value = step.delayMax || 3;
      document.getElementById('cfgLoopRefreshElements').checked = step.refreshEachIteration || false;
    } else if (loopMode === 'count') {
      document.getElementById('cfgLoopCount').value = step.count || 1;
      document.getElementById('cfgLoopCountDelayMin').value = step.delayMin || 1;
      document.getElementById('cfgLoopCountDelayMax').value = step.delayMax || 3;
    } else if (loopMode === 'while') {
      document.getElementById('cfgLoopWhileCondVar').value = step.conditionVar || '';
      document.getElementById('cfgLoopWhileOperator').value = step.operator || 'not-empty';
      document.getElementById('cfgLoopWhileCompareValue').value = step.compareValue || '';
      document.getElementById('cfgLoopWhileMaxIter').value = step.maxIterations || 1000;
      document.getElementById('cfgLoopWhileDelayMin').value = step.delayMin || 1;
      document.getElementById('cfgLoopWhileDelayMax').value = step.delayMax || 3;
    }
  }
  if (step.action === 'if') {
    document.getElementById('cfgCondVar').value = step.conditionVar || '';
    document.getElementById('cfgOperator').value = step.operator || 'not-empty';
    document.getElementById('cfgCompareValue').value = step.compareValue || '';
  }
  if (step.action === 'try-except') {
    document.getElementById('cfgOnError').value = step.onError || 'continue';
    document.getElementById('cfgExceptError').value = step.exceptError || '';
    const sec = Math.max(0, Math.round((parseInt(step.tryTimeoutMs, 10) || 0) / 1000));
    const el = document.getElementById('cfgTryTimeoutSec');
    if (el) el.value = String(sec || 0);
  }
  if (step.action === 'save-to-table') {
    document.getElementById('cfgSaveTableName').value = step.tableName || 'results';
    if (step.columns && step.columns.length > 0) {
      document.getElementById('cfgSaveColumns').value = step.columns.join(', ');
    } else if (step.value) {
      document.getElementById('cfgValue').value = step.value;
    }
  }
  if (step.action === 'user-input') {
    document.getElementById('cfgPromptTitle').value = step.promptTitle || step.value || '';
    document.getElementById('cfgPromptPlaceholder').value = step.promptPlaceholder || '';
    document.getElementById('cfgIsPassword').checked = step.isPassword || false;
    document.getElementById('cfgInputTimeout').value = step.inputTimeout || 0;
  }
  if (step.action === 'read-table') {
    populateTableSelect('cfgReadTableName', step.tableName);
    document.getElementById('cfgReadRowIndex').value = step.rowIndex || '0';
    document.getElementById('cfgReadColumnName').value = step.columnName || '';
  }
  if (step.action === 'python') {
    document.getElementById('cfgPythonCode').value = step.pythonCode || step.value || '';
  }
  // Autoreg blocks — populate edit fields
  if (step.action === 'get-sms-number') {
    document.getElementById('cfgSmsService').value = step.service || '';
    document.getElementById('cfgSmsCountry').value = step.country || 'ru';
    document.getElementById('cfgSavePhoneTo').value = step.savePhoneTo || 'phone';
    document.getElementById('cfgSaveSmsIdTo').value = step.saveSmsIdTo || 'sms_id';
  }
  if (step.action === 'wait-sms-code') {
    document.getElementById('cfgSmsIdVar').value = step.smsIdVar || 'sms_id';
    document.getElementById('cfgSaveCodeTo').value = step.saveCodeTo || 'sms_code';
    document.getElementById('cfgSmsTimeout').value = step.timeout || '120';
  }
  if (step.action === 'solve-captcha') {
    document.getElementById('cfgCaptchaType').value = step.captchaType || 'recaptcha-v2';
    document.getElementById('cfgCaptchaSiteKey').value = step.siteKey || '';
    document.getElementById('cfgCaptchaAutoDetect').checked = step.autoDetect !== false;
    document.getElementById('cfgSaveTokenTo').value = step.saveTokenTo || 'captcha_token';
  }
  if (step.action === 'save-account') {
    document.getElementById('cfgAccountPhoneVar').value = step.phoneVar || 'phone';
    document.getElementById('cfgAccountUsernameVar').value = step.usernameVar || 'username';
    document.getElementById('cfgAccountSessionDataVar').value = step.sessionDataVar || 'session_data';
    document.getElementById('cfgAccountStatus').value = step.status || 'registered';
    document.getElementById('cfgAccountReason').value = step.reason || '';
  }
  if (step.action === 'check-blocked') {
    document.getElementById('cfgCheckBlockedType').value = step.checkType || 'ip';
    document.getElementById('cfgSaveBlockedTo').value = step.saveResultTo || 'is_blocked';
  }
  if (step.action === 'human-delay') {
    document.getElementById('cfgHumanDelayMin').value = step.minSeconds || '2';
    document.getElementById('cfgHumanDelayMax').value = step.maxSeconds || '5';
    document.getElementById('cfgHumanize').checked = step.humanize !== false;
  }
  if (step.action === 'release-number') {
    document.getElementById('cfgReleaseSmsIdVar').value = step.smsIdVar || 'sms_id';
    document.getElementById('cfgReleaseService').value = step.service || '';
  }

  // Browser init / switch profile / proxy rotate fields
  if (step.action === 'browser-init') {
    populateProfileSelect('cfgBrowserInitProfile', step.profileName || '');
    document.getElementById('cfgBrowserInitProxy').value = step.proxy || '';
    document.getElementById('cfgBrowserInitProxyUser').value = step.proxyUsername || '';
    document.getElementById('cfgBrowserInitProxyPass').value = step.proxyPassword || '';
    document.getElementById('cfgBrowserInitScope').value = step.scope || 'this';
    document.getElementById('cfgBrowserInitTimeout').value = step.timeoutMs || '120000';
  }
  if (step.action === 'switch-profile') {
    populateProfileSelect('cfgSwitchProfileName', step.profileName || '');
    document.getElementById('cfgSwitchProfileList').value = step.profileList || '';
    document.getElementById('cfgSwitchProfileCounterVar').value = step.counterVar || '_profile_index';
    document.getElementById('cfgSwitchProfileScope').value = step.scope || 'this';
  }
  if (step.action === 'proxy-rotate') {
    document.getElementById('cfgProxyApplyImmediately').checked = step.applyImmediately === true;
  }

  modal.style.display = 'flex';
}

function resetConfigFields() {
  document.querySelectorAll('.config-section').forEach(s => s.classList.remove('visible'));
  document.getElementById('cfgSelector').value = '';
  document.getElementById('cfgValue').value = '';
  document.getElementById('cfgSaveAs').value = '';
  document.getElementById('cfgPressEnter').checked = false;
  document.getElementById('cfgWaitTime').style.display = 'none';
  document.getElementById('cfgWaitTime').value = '';
  document.getElementById('cfgWaitType').value = 'element';
  document.getElementById('cfgPythonCode').value = '';
  document.getElementById('cfgLoopRefreshElements').checked = false;

  // Browser init / profile / proxy
  const biProxy = document.getElementById('cfgBrowserInitProxy');
  if (biProxy) biProxy.value = '';
  const biScope = document.getElementById('cfgBrowserInitScope');
  if (biScope) biScope.value = 'this';
  const biTimeout = document.getElementById('cfgBrowserInitTimeout');
  if (biTimeout) biTimeout.value = '120000';
  const biUser = document.getElementById('cfgBrowserInitProxyUser');
  if (biUser) biUser.value = '';
  const biPass = document.getElementById('cfgBrowserInitProxyPass');
  if (biPass) biPass.value = '';
  const spScope = document.getElementById('cfgSwitchProfileScope');
  if (spScope) spScope.value = 'this';
  const spList = document.getElementById('cfgSwitchProfileList');
  if (spList) spList.value = '';
  const spCounter = document.getElementById('cfgSwitchProfileCounterVar');
  if (spCounter) spCounter.value = '_profile_index';
  const prApply = document.getElementById('cfgProxyApplyImmediately');
  if (prApply) prApply.checked = false;
}

function showConfigFields(action) {
  if (NEEDS_SELECTOR.includes(action)) {
    document.getElementById('cfgSelectorSection').classList.add('visible');
    // Add hint for {{_current}} when in loop-elements child
    if (configMode === 'add' && configParentPath.includes('.children') && configParentPath.includes('loop-elements')) {
      const selectorSection = document.getElementById('cfgSelectorSection');
      let hint = selectorSection.querySelector('.config-current-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'config-var-hint config-current-hint';
        hint.innerHTML = '💡 Используйте <code>{{_current}}</code> для работы с текущим элементом цикла';
        selectorSection.appendChild(hint);
      }
    }
  }
  if (NEEDS_VALUE.includes(action)) {
    document.getElementById('cfgValueSection').classList.add('visible');
    const label = document.getElementById('cfgValueLabel');
    if (action === 'navigate') label.textContent = 'URL';
    else if (action === 'save-to-table') label.textContent = 'Значение ({{переменная}}) — или используйте колонки ниже';
    else if (action === 'set-variable') label.textContent = 'Значение';
    else label.textContent = 'Текст / {{переменная}}';
  }
  if (NEEDS_SAVEAS.includes(action)) {
    document.getElementById('cfgSaveAsSection').classList.add('visible');
    const saveAsLabel = document.getElementById('cfgSaveAsSection').querySelector('.config-label');
    if (action === 'set-variable' && saveAsLabel) saveAsLabel.textContent = 'Имя переменной';
  }
  // set-variable: show setMode selector
  const setModeGroup = document.getElementById('cfgSetModeGroup');
  if (setModeGroup) {
    setModeGroup.style.display = action === 'set-variable' ? 'block' : 'none';
  }
  if (NEEDS_ENTER.includes(action)) document.getElementById('cfgEnterSection').classList.add('visible');
  if (action === 'wait') document.getElementById('cfgWaitSection').classList.add('visible');
  if (action === 'press-key') document.getElementById('cfgKeySection').classList.add('visible');
  if (action === 'loop' || action === 'loop-table' || action === 'loop-elements') {
    document.getElementById('cfgLoopUnifiedSection').classList.add('visible');
    // Determine current mode
    let loopMode = 'elements';
    if (action === 'loop-table') loopMode = 'table';
    else if (action === 'loop-elements') loopMode = 'elements';
    else if (configMode === 'edit') {
      const editStep = getStepByPath(currentMacro.steps, configEditPath);
      if (editStep) loopMode = editStep.loopMode || 'elements';
    }
    const modeSelect = document.getElementById('cfgLoopMode');
    modeSelect.value = loopMode;
    updateLoopModeFields(loopMode);
  }
  if (action === 'if') document.getElementById('cfgIfSection').classList.add('visible');
  if (action === 'try-except') document.getElementById('cfgTryExceptSection').classList.add('visible');
  if (action === 'read-table') {
    document.getElementById('cfgReadTableSection').classList.add('visible');
    document.getElementById('cfgSaveAsSection').classList.add('visible');
    populateTableSelect('cfgReadTableName');
  }
  if (action === 'user-input') {
    document.getElementById('cfgUserInputSection').classList.add('visible');
    document.getElementById('cfgSaveAsSection').classList.add('visible');
  }
  if (action === 'save-to-table') document.getElementById('cfgTableSaveSection').classList.add('visible');
  if (action === 'python') document.getElementById('cfgPythonSection').classList.add('visible');
  
  // Autoreg blocks config sections
  if (action === 'get-sms-number') document.getElementById('cfgGetSmsNumberSection').classList.add('visible');
  if (action === 'wait-sms-code') document.getElementById('cfgWaitSmsCodeSection').classList.add('visible');
  if (action === 'solve-captcha') document.getElementById('cfgSolveCaptchaSection').classList.add('visible');
  if (action === 'save-account') document.getElementById('cfgSaveAccountSection').classList.add('visible');
  if (action === 'check-blocked') document.getElementById('cfgCheckBlockedSection').classList.add('visible');
  if (action === 'human-delay') document.getElementById('cfgHumanDelaySection').classList.add('visible');
  if (action === 'release-number') document.getElementById('cfgReleaseNumberSection').classList.add('visible');

  // Browser-init / Switch-profile / Proxy-rotate extras
  if (action === 'browser-init') {
    document.getElementById('cfgBrowserInitSection').classList.add('visible');
    populateProfileSelect('cfgBrowserInitProfile');
  }
  if (action === 'switch-profile') {
    document.getElementById('cfgSwitchProfileSection').classList.add('visible');
    populateProfileSelect('cfgSwitchProfileName');
  }
  if (action === 'proxy-rotate') {
    document.getElementById('cfgProxyRotateSection').classList.add('visible');
  }
}

function populateTableSelect(selectId, selectedVal) {
  const sel = document.getElementById(selectId);
  const tables = settings.dataTables || {};
  sel.innerHTML = Object.keys(tables).map(n =>
    `<option value="${esc(n)}" ${n === selectedVal ? 'selected' : ''}>${esc(n)} (${tables[n].rows?.length || 0})</option>`
  ).join('');
}

function populateProfileSelect(selectId, selectedVal) {
  const sel = document.getElementById(selectId);
  const profiles = settings.browserProfiles || {};
  const names = Object.keys(profiles);
  sel.innerHTML = names.map(n =>
    `<option value="${esc(n)}" ${n === selectedVal ? 'selected' : ''}>${esc(n)}</option>`
  ).join('');
}

// Loop mode switcher
function updateLoopModeFields(mode) {
  const tableFields = document.getElementById('cfgLoopTableFields');
  const elemFields = document.getElementById('cfgLoopElementsFields');
  const countFields = document.getElementById('cfgLoopCountFields');
  const whileFields = document.getElementById('cfgLoopWhileFields');
  const selectorSection = document.getElementById('cfgSelectorSection');
  if (tableFields) tableFields.style.display = mode === 'table' ? 'block' : 'none';
  if (elemFields) elemFields.style.display = mode === 'elements' ? 'block' : 'none';
  if (countFields) countFields.style.display = mode === 'count' ? 'block' : 'none';
  if (whileFields) whileFields.style.display = mode === 'while' ? 'block' : 'none';
  // Показывать пикер селектора только для режима elements
  if (mode === 'elements') {
    selectorSection.classList.add('visible');
  } else if (!NEEDS_SELECTOR.includes(configAction)) {
    selectorSection.classList.remove('visible');
  }
  if (mode === 'table') {
    populateTableSelect('cfgLoopTableName');
  }
}

// Wait type change
document.getElementById('cfgWaitType').addEventListener('change', e => {
  document.getElementById('cfgWaitTime').style.display = e.target.value === 'time' ? 'block' : 'none';
});

// Python test button
document.getElementById('cfgPythonTest').addEventListener('click', async () => {
  const code = document.getElementById('cfgPythonCode').value;
  if (!code.trim()) return;

  const statusEl = document.getElementById('cfgPythonTestStatus');
  const outputEl = document.getElementById('cfgPythonTestOutput');
  statusEl.textContent = '⏳ Выполняю...';
  statusEl.style.color = 'var(--yellow)';
  outputEl.style.display = 'none';
  outputEl.classList.remove('has-error');

  // Gather current variables from settings
  const variables = settings.variables?.global || {};

  try {
    const res = await fetch(`${API}/python/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, variables })
    });
    const data = await res.json();

    outputEl.style.display = 'block';

    if (data.ok) {
      statusEl.textContent = '✅ Успешно';
      statusEl.style.color = 'var(--green)';
      let html = '';
      if (data.output) html += esc(data.output);
      if (data.variables && Object.keys(data.variables).length > 0) {
        const changedVars = Object.entries(data.variables)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `  {{${k}}} = ${JSON.stringify(v)}`)
          .join('\n');
        if (changedVars) {
          html += (html ? '\n' : '') + '<div class="py-out-vars">📋 Переменные после выполнения:\n' + esc(changedVars) + '</div>';
        }
      }
      outputEl.innerHTML = html || '<span style="color:var(--overlay)">(нет вывода)</span>';
    } else {
      statusEl.textContent = '❌ Ошибка';
      statusEl.style.color = 'var(--red)';
      outputEl.classList.add('has-error');
      outputEl.textContent = data.error || 'Unknown error';
      if (data.output) {
        outputEl.textContent = data.output + '\n\n' + (data.error || '');
      }
    }
  } catch (e) {
    statusEl.textContent = '❌ Сервер недоступен';
    statusEl.style.color = 'var(--red)';
    outputEl.style.display = 'block';
    outputEl.classList.add('has-error');
    outputEl.textContent = e.message;
  }
});

// Confirm step config
// Convert existing step to Python code
function convertStepToPython(step) {
  let pythonCode = `# Автоконвертация: ${ACTION_NAMES[step.action] || step.action}\n`;
  
  switch (step.action) {
    case 'click':
      pythonCode += `# Клик по элементу\nfrom playwright.sync_api import Page\npage.click("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}")`;
      break;
    case 'type':
      pythonCode += `# Ввод текста\npage.fill("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}", "${step.value || 'ТЕКСТ'}")\n`;
      if (step.pressEnter) pythonCode += `page.press("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}", "Enter")`;
      break;
    case 'read':
      pythonCode += `# Чтение текста\n${step.saveAs || 'result'} = page.text_content("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}")`;
      break;
    case 'wait':
      if (step.waitType === 'time') {
        pythonCode += `# Пауза\nimport time\ntime.sleep(${(parseInt(step.waitTime || '1000') / 1000).toFixed(1)})`;
      } else {
        pythonCode += `# Ожидание элемента\npage.wait_for_selector("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}")`;
      }
      break;
    case 'navigate':
      pythonCode += `# Переход\npage.goto("${step.url || 'URL'}")`;
      break;
    case 'scroll':
      pythonCode += `# Прокрутка\npage.evaluate('document.querySelector("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}").scrollIntoView()')`;
      break;
    case 'press-key':
      pythonCode += `# Нажатие клавиши\npage.keyboard.press("${step.key || 'Enter'}")`;
      break;
    case 'clear-field':
      pythonCode += `# Очистка поля\npage.fill("${step.cssSelector || step.selector || 'СЕЛЕКТОР'}", "")`;
      break;
    case 'save-to-table':
      const cols = step.columns || [step.value || 'value'];
      pythonCode += `# Сохранение в таблицу "${step.tableName || 'results'}"\n`;
      pythonCode += `row_data = [${cols.map(c => `"${c}"`).join(', ')}]\nprint(f"Сохраняем: {row_data}")`;
      break;
    default:
      pythonCode += `# TODO: Реализуйте логику для действия "${step.action}"\nprint("Выполняем: ${step.action}")`;
  }
  
  // Switch to Python mode
  configAction = 'python';
  document.getElementById('stepConfigTitle').textContent = '🐍 Python-код (конвертировано)';
  resetConfigFields();
  showConfigFields('python');
  document.getElementById('cfgPythonCode').value = pythonCode;
  document.getElementById('convertToPython').style.display = 'none';
}

document.getElementById('confirmStepConfig').addEventListener('click', () => {
  const action = configAction;
  let step;

  if (configMode === 'edit') {
    step = getStepByPath(currentMacro.steps, configEditPath);
    if (!step) return;
  } else {
    step = { action, timestamp: Date.now() };
    if (BLOCK_ACTIONS.includes(action)) step.children = [];
    if (action === 'if') step.elseChildren = [];
    if (action === 'try-except') step.exceptChildren = [];
  }

  // Read fields
  const customName = document.getElementById('cfgCustomName').value.trim();
  if (customName) step.customName = customName;
  else delete step.customName;
  if (NEEDS_SELECTOR.includes(action)) step.cssSelector = document.getElementById('cfgSelector').value;
  if (NEEDS_VALUE.includes(action)) {
    const val = document.getElementById('cfgValue').value;
    if (action === 'navigate') step.url = val;
    else step.value = val;
  }
  if (NEEDS_SAVEAS.includes(action)) step.saveAs = document.getElementById('cfgSaveAs').value.replace(/^\{\{|\}\}$/g, '').trim();
  if (action === 'set-variable') {
    step.varName = document.getElementById('cfgSaveAs').value.replace(/^\{\{|\}\}$/g, '').trim();
    step.setMode = document.getElementById('cfgSetMode')?.value || 'replace';
  }
  if (NEEDS_ENTER.includes(action)) step.pressEnter = document.getElementById('cfgPressEnter').checked;
  if (action === 'wait') {
    step.waitType = document.getElementById('cfgWaitType').value;
    if (step.waitType === 'time') step.waitTime = document.getElementById('cfgWaitTime').value;
  }
  if (action === 'press-key') step.key = document.getElementById('cfgKey').value;
  if (action === 'loop' || action === 'loop-table' || action === 'loop-elements') {
    const loopMode = document.getElementById('cfgLoopMode').value;
    // Always save as unified 'loop' action
    step.action = 'loop';
    step.loopMode = loopMode;
    if (loopMode === 'table') {
      step.tableName = document.getElementById('cfgLoopTableName').value;
      step.maxRows = parseInt(document.getElementById('cfgLoopMaxRows').value) || 0;
      step.delayMin = document.getElementById('cfgLoopDelayMin').value || '1';
      step.delayMax = document.getElementById('cfgLoopDelayMax').value || '3';
      step.refreshEachIteration = document.getElementById('cfgLoopRefreshTable').checked;
      // Clean up elements-specific fields
      delete step.varName; delete step.maxElements;
    } else if (loopMode === 'elements') {
      step.cssSelector = document.getElementById('cfgSelector').value;
      step.varName = document.getElementById('cfgLoopVarName2').value;
      step.maxElements = parseInt(document.getElementById('cfgLoopMaxElements').value) || 0;
      step.refreshEachIteration = document.getElementById('cfgLoopRefreshElements').checked;
      step.delayMin = document.getElementById('cfgLoopElemDelayMin').value || '1';
      step.delayMax = document.getElementById('cfgLoopElemDelayMax').value || '3';
      // Очистка полей других режимов
      delete step.tableName; delete step.maxRows;
      delete step.count; delete step.conditionVar; delete step.operator; delete step.compareValue; delete step.maxIterations;
    } else if (loopMode === 'count') {
      step.count = parseInt(document.getElementById('cfgLoopCount').value) || 1;
      step.delayMin = document.getElementById('cfgLoopCountDelayMin').value || '1';
      step.delayMax = document.getElementById('cfgLoopCountDelayMax').value || '3';
      // Очистка полей других режимов
      delete step.tableName; delete step.maxRows; delete step.varName; delete step.maxElements;
      delete step.refreshEachIteration;
      delete step.conditionVar; delete step.operator; delete step.compareValue; delete step.maxIterations;
    } else if (loopMode === 'while') {
      step.conditionVar = document.getElementById('cfgLoopWhileCondVar').value;
      step.operator = document.getElementById('cfgLoopWhileOperator').value;
      step.compareValue = document.getElementById('cfgLoopWhileCompareValue').value;
      step.maxIterations = parseInt(document.getElementById('cfgLoopWhileMaxIter').value) || 1000;
      step.delayMin = document.getElementById('cfgLoopWhileDelayMin').value || '1';
      step.delayMax = document.getElementById('cfgLoopWhileDelayMax').value || '3';
      // Очистка полей других режимов
      delete step.tableName; delete step.maxRows; delete step.varName; delete step.maxElements;
      delete step.refreshEachIteration;
      delete step.count;
    }
  }
  if (action === 'if') {
    step.conditionVar = document.getElementById('cfgCondVar').value;
    step.operator = document.getElementById('cfgOperator').value;
    step.compareValue = document.getElementById('cfgCompareValue').value;
  }
  if (action === 'try-except') {
    step.onError = document.getElementById('cfgOnError').value || 'continue';
    step.exceptError = document.getElementById('cfgExceptError').value.replace(/^\{\{|\}\}$/g, '').trim();

    const secEl = document.getElementById('cfgTryTimeoutSec');
    const sec = secEl ? (parseInt(secEl.value, 10) || 0) : 0;
    const ms = Math.max(0, sec) * 1000;
    if (ms > 0) step.tryTimeoutMs = ms;
    else delete step.tryTimeoutMs;
  }
  if (action === 'save-to-table') {
    step.tableName = document.getElementById('cfgSaveTableName').value || 'results';
    const colsInput = document.getElementById('cfgSaveColumns').value.trim();
    const valueInput = document.getElementById('cfgValue').value.trim();
    
    if (colsInput) {
      step.columns = colsInput.split(',').map(s => s.trim());
    } else if (valueInput) {
      step.value = valueInput;
      delete step.columns; // Clear columns if using single value
    } else {
      step.columns = ['value']; // Default column
    }
  }
  if (action === 'user-input') {
    step.promptTitle = document.getElementById('cfgPromptTitle').value;
    step.value = step.promptTitle;
    step.promptPlaceholder = document.getElementById('cfgPromptPlaceholder').value;
    step.isPassword = document.getElementById('cfgIsPassword').checked;
    step.inputTimeout = document.getElementById('cfgInputTimeout').value || '0';
  }
  if (action === 'read-table') {
    step.tableName = document.getElementById('cfgReadTableName').value;
    step.rowIndex = document.getElementById('cfgReadRowIndex').value || '0';
    step.columnName = document.getElementById('cfgReadColumnName').value;
  }

  if (action === 'browser-init') {
    step.profileName = document.getElementById('cfgBrowserInitProfile').value;
    step.proxy = document.getElementById('cfgBrowserInitProxy').value.trim();
    step.proxyUsername = document.getElementById('cfgBrowserInitProxyUser').value.trim();
    step.proxyPassword = document.getElementById('cfgBrowserInitProxyPass').value.trim();
    if (!step.proxyUsername) delete step.proxyUsername;
    if (!step.proxyPassword) delete step.proxyPassword;
    step.scope = document.getElementById('cfgBrowserInitScope').value || 'this';
    step.timeoutMs = document.getElementById('cfgBrowserInitTimeout').value || '120000';
  }

  if (action === 'switch-profile') {
    const listVal = document.getElementById('cfgSwitchProfileList').value.trim();
    if (listVal) {
      step.profileList = listVal;
      delete step.profileName;
      const cv = document.getElementById('cfgSwitchProfileCounterVar').value.trim() || '_profile_index';
      step.counterVar = cv;
    } else {
      step.profileName = document.getElementById('cfgSwitchProfileName').value;
      delete step.profileList;
      delete step.counterVar;
    }
    step.scope = document.getElementById('cfgSwitchProfileScope').value || 'this';
    step.timeoutMs = '120000';
  }

  if (action === 'proxy-rotate') {
    step.applyImmediately = document.getElementById('cfgProxyApplyImmediately').checked;
  }
  if (action === 'python') {
    step.pythonCode = document.getElementById('cfgPythonCode').value;
    // Also store in value for compatibility
    step.value = step.pythonCode;
  }

  // Autoreg blocks
  if (action === 'get-sms-number') {
    step.service = document.getElementById('cfgSmsService').value;
    step.country = document.getElementById('cfgSmsCountry').value;
    step.savePhoneTo = document.getElementById('cfgSavePhoneTo').value || 'phone';
    step.saveSmsIdTo = document.getElementById('cfgSaveSmsIdTo').value || 'sms_id';
  }
  if (action === 'wait-sms-code') {
    step.smsIdVar = document.getElementById('cfgSmsIdVar').value || 'sms_id';
    step.saveCodeTo = document.getElementById('cfgSaveCodeTo').value || 'sms_code';
    step.timeout = document.getElementById('cfgSmsTimeout').value || '120';
  }
  if (action === 'solve-captcha') {
    step.captchaType = document.getElementById('cfgCaptchaType').value;
    step.siteKey = document.getElementById('cfgCaptchaSiteKey').value;
    step.autoDetect = document.getElementById('cfgCaptchaAutoDetect').checked;
    step.saveTokenTo = document.getElementById('cfgSaveTokenTo').value || 'captcha_token';
  }
  if (action === 'save-account') {
    step.phoneVar = document.getElementById('cfgAccountPhoneVar').value || 'phone';
    step.usernameVar = document.getElementById('cfgAccountUsernameVar').value || 'username';
    step.sessionDataVar = document.getElementById('cfgAccountSessionDataVar').value || 'session_data';
    step.status = document.getElementById('cfgAccountStatus').value;
    step.reason = document.getElementById('cfgAccountReason').value;
  }
  if (action === 'check-blocked') {
    step.checkType = document.getElementById('cfgCheckBlockedType').value;
    step.saveResultTo = document.getElementById('cfgSaveBlockedTo').value || 'is_blocked';
  }
  if (action === 'human-delay') {
    step.minSeconds = document.getElementById('cfgHumanDelayMin').value || '2';
    step.maxSeconds = document.getElementById('cfgHumanDelayMax').value || '5';
    step.humanize = document.getElementById('cfgHumanize').checked;
  }
  if (action === 'release-number') {
    step.smsIdVar = document.getElementById('cfgReleaseSmsIdVar').value || 'sms_id';
    step.service = document.getElementById('cfgReleaseService').value;
  }

  if (configMode === 'add') {
    // Insert step
    if (configParentPath === '') {
      currentMacro.steps.push(step);
    } else {
      let arr = getStepByPath(currentMacro.steps, configParentPath);
      if (Array.isArray(arr)) arr.push(step);
      else if (arr && typeof arr === 'object') {
        if (!arr.children) arr.children = [];
        arr.children.push(step);
      }
    }
  }

  saveMacro(); renderSteps();
  document.getElementById('stepConfigModal').style.display = 'none';
});

// Cancel config
['cancelStepConfig', 'cancelStepConfig2'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('stepConfigModal').style.display = 'none';
  });
});

// ==================== SNAPSHOT PICKER ====================
let snapCurrentIdx = 0;
let snapshotTargetPath = '';

// Find the best snapshot index for the step being edited
function getPreferredSnapshotIndex() {
  const candidatePath = configMode === 'edit' ? configEditPath : (selectedPath || configParentPath || '');
  snapshotTargetPath = candidatePath;
  const topLevelIndex = Number.parseInt(String(candidatePath).split('.')[0], 10);
  if (Number.isNaN(topLevelIndex) || availableSnapshots.length === 0) return 0;

  const exactIdx = availableSnapshots.indexOf(topLevelIndex);
  if (exactIdx !== -1) return exactIdx;

  // Find nearest snapshot before this step
  let nearest = 0;
  for (let i = 0; i < availableSnapshots.length; i++) {
    if (availableSnapshots[i] <= topLevelIndex) nearest = i;
    else break;
  }
  return nearest;
}

document.getElementById('cfgPickBtn').addEventListener('click', () => {
  if (!currentMacro || availableSnapshots.length === 0) {
    alert('Нет снимков. Запишите шаги через расширение — снимки создаются автоматически.');
    return;
  }
  snapCurrentIdx = getPreferredSnapshotIndex();
  openSnapshotPicker();
});

function openSnapshotPicker() {
  const modal = document.getElementById('snapshotModal');
  modal.style.display = 'flex';
  loadSnapshot(availableSnapshots[snapCurrentIdx]);
}

function loadSnapshot(idx) {
  const frame = document.getElementById('snapFrame');
  frame.src = `${API}/macros/${currentMacro.id}/snapshots/${idx}`;
  const targetTopLevel = Number.parseInt(String(snapshotTargetPath || '').split('.')[0], 10);
  const contextNote = Number.isNaN(targetTopLevel) ? '' : ` · для шага ${targetTopLevel + 1}`;
  document.getElementById('snapInfo').textContent = `Снимок ${snapCurrentIdx + 1} / ${availableSnapshots.length} (шаг ${idx + 1}${contextNote})`;
  document.getElementById('snapSelectedInfo').textContent = '';
}

document.getElementById('snapPrev').addEventListener('click', () => {
  if (snapCurrentIdx > 0) { snapCurrentIdx--; loadSnapshot(availableSnapshots[snapCurrentIdx]); }
});
document.getElementById('snapNext').addEventListener('click', () => {
  if (snapCurrentIdx < availableSnapshots.length - 1) { snapCurrentIdx++; loadSnapshot(availableSnapshots[snapCurrentIdx]); }
});
document.getElementById('snapClose').addEventListener('click', () => {
  document.getElementById('snapshotModal').style.display = 'none';
});

// Listen for element pick from snapshot iframe
window.addEventListener('message', e => {
  if (e.data?.type === 'snapshot-element-picked') {
    document.getElementById('cfgSelector').value = e.data.selector;
    document.getElementById('snapSelectedInfo').textContent = `✅ ${e.data.selector}`;
    // Auto-close after short delay
    setTimeout(() => {
      document.getElementById('snapshotModal').style.display = 'none';
    }, 600);
  }
});

// ==================== Settings ====================
async function loadSettingsFromServer() {
  try { 
    const res = await fetch(`${API}/settings`); 
    settings = await res.json(); 
  } catch (e) { 
    settings = {}; 
  }
  // AC8: Load persistent vars separately
  try {
    const pRes = await fetch(`${API}/variables/persistent`);
    settings._persistentVars = await pRes.json();
  } catch (e) {
    settings._persistentVars = {};
  }
  await fetchProfiles();
}
async function saveSettingsToServer() {
  await fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
}

function openSettings() { showView('settings'); renderSettings(); }

function renderSettings() {
  const sms = settings.smsServices || {};
  document.getElementById('smsActiveService').value = sms.active || '';
  if (sms.active && sms.services?.[sms.active]) {
    document.getElementById('smsApiKey').value = sms.services[sms.active].apiKey || '';
    document.getElementById('smsBaseUrl').value = sms.services[sms.active].baseUrl || '';
  }
  const proxy = settings.proxy || {};
  document.getElementById('proxyEnabled').checked = proxy.enabled || false;
  document.getElementById('proxyType').value = proxy.type || 'http';
  document.getElementById('proxyHost').value = proxy.host || '';
  document.getElementById('proxyPort').value = proxy.port || '';
  document.getElementById('proxyUser').value = proxy.username || '';
  document.getElementById('proxyPass').value = proxy.password || '';
  document.getElementById('proxyRotationUrl').value = proxy.rotationUrl || '';
  document.getElementById('proxyList').value = (proxy.list || []).join('\n');
  const fp = settings.fingerprint || {};
  document.getElementById('fpEnabled').checked = fp.enabled || false;
  document.getElementById('fpUserAgent').value = fp.userAgent || '';
  document.getElementById('fpLanguage').value = fp.language || 'ru-RU';
  document.getElementById('fpTimezone').value = fp.timezone || 'Europe/Moscow';
  document.getElementById('fpScreen').value = fp.screenResolution || '1920x1080';
  document.getElementById('fpPlatform').value = fp.platform || 'Win32';
  document.getElementById('fpCores').value = fp.hardwareConcurrency || 8;
  document.getElementById('fpMemory').value = fp.deviceMemory || 8;
  document.getElementById('fpWebgl').value = fp.webglVendor || '';
  const cookies = settings.cookies || {};
  document.getElementById('cookieAutoSave').checked = cookies.autoSave !== false;
  document.getElementById('cookieAutoLoad').checked = cookies.autoLoad !== false;
  renderCookieProfiles();
  renderVariables();
  renderTables();
}

function renderCookieProfiles() {
  const profiles = settings.cookies?.profiles || {};
  const list = document.getElementById('cookieProfilesList');
  list.innerHTML = Object.keys(profiles).map(name => `
    <div class="profile-row"><span style="flex:1">🍪 ${esc(name)} (${profiles[name].length})</span><button class="var-delete" data-profile="${esc(name)}">🗑</button></div>
  `).join('') || '<div style="color:var(--overlay);font-size:13px">Нет профилей</div>';
  list.querySelectorAll('[data-profile]').forEach(b => b.addEventListener('click', () => {
    delete settings.cookies.profiles[b.dataset.profile]; saveSettingsToServer(); renderCookieProfiles();
  }));
}

function renderVariables() {
  const vars = settings.variables?.global || {};
  // AC8: Also show persistent vars
  const persistentVars = settings._persistentVars || {};
  const allVars = { ...vars };
  // Mark persistent ones
  const persistentKeys = new Set(Object.keys(persistentVars));
  for (const [k, v] of Object.entries(persistentVars)) {
    allVars[k] = v;
  }
  
  const list = document.getElementById('variablesList');
  list.innerHTML = Object.entries(allVars).map(([k, v]) => {
    const isPersistent = persistentKeys.has(k);
    return `<div class="var-row">
      <span class="var-name">{{${esc(k)}}}</span>
      <span class="var-value">${esc(String(v))}</span>
      ${isPersistent ? '<span style="font-size:10px;color:var(--teal);margin-left:4px" title="Персистентная переменная">💾</span>' : ''}
      <button class="var-persistent-toggle" data-var-persist="${esc(k)}" title="${isPersistent ? 'Сделать эфемерной' : 'Сделать персистентной'}" style="cursor:pointer;background:none;border:none;font-size:12px;padding:2px 4px;color:${isPersistent ? 'var(--teal)' : 'var(--overlay)'}">${isPersistent ? '🔒' : '🔓'}</button>
      <button class="var-delete" data-var="${esc(k)}">🗑</button>
    </div>`;
  }).join('') || '<div style="color:var(--overlay);font-size:13px">Нет переменных</div>';
  list.querySelectorAll('[data-var]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.var;
    delete settings.variables.global[key];
    if (settings._persistentVars) delete settings._persistentVars[key];
    saveSettingsToServer();
    // Also update persistent vars on server
    fetch(`${API}/variables/persistent`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings._persistentVars || {})
    });
    renderVariables();
  }));
  // AC8: Persistent toggle handlers
  list.querySelectorAll('[data-var-persist]').forEach(b => b.addEventListener('click', async () => {
    const key = b.dataset.varPersist;
    const val = allVars[key];
    if (!settings._persistentVars) settings._persistentVars = {};
    if (persistentKeys.has(key)) {
      // Move from persistent to ephemeral
      delete settings._persistentVars[key];
      if (!settings.variables) settings.variables = { global: {} };
      if (!settings.variables.global) settings.variables.global = {};
      settings.variables.global[key] = val;
    } else {
      // Move from ephemeral to persistent
      settings._persistentVars[key] = val;
      if (settings.variables?.global) delete settings.variables.global[key];
    }
    saveSettingsToServer();
    await fetch(`${API}/variables/persistent`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings._persistentVars || {})
    });
    renderVariables();
  }));
}

function renderTables() {
  const tables = settings.dataTables || {};
  const list = document.getElementById('tablesList');
  list.innerHTML = Object.entries(tables).map(([name, table]) => {
    const headers = table.headers || [];
    const rows = table.rows || [];
    let preview = '';
    if (headers.length) {
      preview = `<div class="table-preview"><table>
        <tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
        ${rows.slice(0, 3).map(r => `<tr>${r.map(c => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')}
        ${rows.length > 3 ? `<tr><td colspan="${headers.length}" style="text-align:center;color:var(--overlay)">... ещё ${rows.length - 3}</td></tr>` : ''}
      </table></div>`;
    }
    return `<div class="table-row" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;align-items:center;gap:8px"><span style="flex:1">📊 ${esc(name)} (${rows.length} × ${headers.length})</span><button class="var-delete" data-table="${esc(name)}">🗑</button></div>
      ${preview}
    </div>`;
  }).join('') || '<div style="color:var(--overlay);font-size:13px">Нет таблиц</div>';
  list.querySelectorAll('[data-table]').forEach(b => b.addEventListener('click', async () => {
    await fetch(`${API}/tables/${b.dataset.table}`, { method: 'DELETE' });
    delete settings.dataTables[b.dataset.table]; renderTables();
  }));
}

// ===== Settings event listeners =====
document.getElementById('smsActiveService').addEventListener('change', e => {
  const key = e.target.value;
  if (!settings.smsServices) settings.smsServices = { active: '', services: {} };
  settings.smsServices.active = key;
  if (key && settings.smsServices.services?.[key]) {
    document.getElementById('smsApiKey').value = settings.smsServices.services[key].apiKey || '';
    document.getElementById('smsBaseUrl').value = settings.smsServices.services[key].baseUrl || '';
  }
});

document.getElementById('saveSmsBtn').addEventListener('click', () => {
  const active = document.getElementById('smsActiveService').value;
  if (!settings.smsServices) settings.smsServices = { active: '', services: {} };
  settings.smsServices.active = active;
  if (active) {
    if (!settings.smsServices.services) settings.smsServices.services = {};
    settings.smsServices.services[active] = { apiKey: document.getElementById('smsApiKey').value, baseUrl: document.getElementById('smsBaseUrl').value };
  }
  saveSettingsToServer();
});

document.getElementById('saveProxyBtn').addEventListener('click', () => {
  settings.proxy = { enabled: document.getElementById('proxyEnabled').checked, type: document.getElementById('proxyType').value, host: document.getElementById('proxyHost').value, port: document.getElementById('proxyPort').value, username: document.getElementById('proxyUser').value, password: document.getElementById('proxyPass').value, rotationUrl: document.getElementById('proxyRotationUrl').value, list: document.getElementById('proxyList').value.split('\n').filter(l => l.trim()) };
  saveSettingsToServer();
});

document.getElementById('saveFpBtn').addEventListener('click', () => {
  settings.fingerprint = { enabled: document.getElementById('fpEnabled').checked, userAgent: document.getElementById('fpUserAgent').value, language: document.getElementById('fpLanguage').value, timezone: document.getElementById('fpTimezone').value, screenResolution: document.getElementById('fpScreen').value, platform: document.getElementById('fpPlatform').value, hardwareConcurrency: parseInt(document.getElementById('fpCores').value) || 8, deviceMemory: parseInt(document.getElementById('fpMemory').value) || 8, webglVendor: document.getElementById('fpWebgl').value };
  saveSettingsToServer();
});

document.getElementById('saveCookiesBtn').addEventListener('click', () => {
  if (!settings.cookies) settings.cookies = {};
  settings.cookies.autoSave = document.getElementById('cookieAutoSave').checked;
  settings.cookies.autoLoad = document.getElementById('cookieAutoLoad').checked;
  saveSettingsToServer();
});

document.getElementById('addCookieProfile').addEventListener('click', () => {
  const name = document.getElementById('newCookieProfile').value.trim();
  if (!name) return;
  if (!settings.cookies) settings.cookies = { profiles: {} };
  if (!settings.cookies.profiles) settings.cookies.profiles = {};
  settings.cookies.profiles[name] = [];
  saveSettingsToServer(); document.getElementById('newCookieProfile').value = ''; renderCookieProfiles();
});

document.getElementById('importCookiesBtn').addEventListener('click', () => {
  const json = document.getElementById('cookieImport').value.trim();
  if (!json) return;
  try {
    const cookies = JSON.parse(json);
    const profileName = prompt('Профиль?');
    if (!profileName) return;
    if (!settings.cookies.profiles) settings.cookies.profiles = {};
    settings.cookies.profiles[profileName] = cookies;
    saveSettingsToServer(); renderCookieProfiles();
  } catch (e) { alert('JSON ошибка: ' + e.message); }
});

document.getElementById('addVariableBtn').addEventListener('click', () => {
  const name = document.getElementById('newVarName').value.trim();
  const value = document.getElementById('newVarValue').value;
  if (!name) return;
  if (!settings.variables) settings.variables = { global: {} };
  if (!settings.variables.global) settings.variables.global = {};
  settings.variables.global[name] = value;
  saveSettingsToServer(); document.getElementById('newVarName').value = ''; document.getElementById('newVarValue').value = ''; renderVariables();
});

document.getElementById('saveVarsBtn').addEventListener('click', () => saveSettingsToServer());

document.getElementById('addTableBtn').addEventListener('click', () => {
  const name = document.getElementById('newTableName').value.trim();
  if (!name) return;
  const headersStr = prompt('Колонки через запятую:', 'email,password,name');
  if (!headersStr) return;
  const headers = headersStr.split(',').map(h => h.trim());
  if (!settings.dataTables) settings.dataTables = {};
  settings.dataTables[name] = { headers, rows: [] };
  fetch(`${API}/tables/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headers, rows: [] }) });
  document.getElementById('newTableName').value = ''; renderTables();
});

document.getElementById('createProfileBtn').addEventListener('click', createProfile);

document.getElementById('csvFileInput').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const name = file.name.replace(/\.\w+$/, '');
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.split('\n').filter(l => l.trim());
    if (lines.length < 1) return;
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));
    if (!settings.dataTables) settings.dataTables = {};
    settings.dataTables[name] = { headers, rows };
    fetch(`${API}/tables/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headers, rows }) });
    renderTables();
  };
  reader.readAsText(file);
});

document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ===== Toolbar =====
document.getElementById('newMacroBtn').addEventListener('click', createMacro);
document.getElementById('addStepBtn').addEventListener('click', () => openAddStepModal(''));
document.getElementById('addStepEmptyBtn')?.addEventListener('click', () => openAddStepModal(''));
document.getElementById('deleteMacroBtn').addEventListener('click', deleteMacro);
document.getElementById('runAllBtn').addEventListener('click', openRunModal);
document.getElementById('runToBtn').addEventListener('click', () => {
  if (selectedPath) {
    const parts = selectedPath.split('.');
    if (parts.length === 1) {
      logToConsole('SYS', `▶▶ До шага ${parseInt(parts[0]) + 1}...`, 'info');
      fetch(`${API}/macros/${currentMacro.id}/run-to/${parts[0]}`, { method: 'POST' })
        .then(r => r.json()).then(d => { logToConsole('SYS', d.ok ? '✅' : `❌ ${d.error}`, d.ok ? 'info' : 'error'); });
    }
  }
});
document.getElementById('appendRecordBtn').addEventListener('click', appendRecord);
document.getElementById('debugBtn').addEventListener('click', startDebug);

// ==================== Debug Mode ====================
function startDebug() {
  if (!currentMacro) return;
  debugMode = true;
  debugCurrentStepId = null;
  debugVariables = {};
  debugPreviousVariables = {};

  // Show debug UI
  document.getElementById('debugControls').style.display = 'flex';
  document.getElementById('debugVarsPanel').style.display = 'flex';
  macroEditor.classList.add('debug-active');
  document.querySelector('.main').classList.add('debug-layout');

  // Collect breakpoint paths
  const breakpointPaths = Array.from(debugBreakpoints);

  // AC1: Include selected profile in debug request
  const profileName = document.getElementById('runProfileSelect')?.value || null;
  
  logToConsole('DEBUG', `🐛 Запуск в режиме отладки...${profileName ? ` (профиль: ${profileName})` : ''}`, 'info');

  // POST to run with debug flag + profileName
  fetch(`${API}/macros/${currentMacro.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debug: true, breakpoints: breakpointPaths, profileName })
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      logToConsole('DEBUG', '🐛 Отладка запущена, ожидаю первую точку остановки...', 'info');
      setDebugButtonsEnabled(false); // Wait for first pause
    } else {
      logToConsole('DEBUG', `❌ Ошибка: ${d.error}`, 'error');
      exitDebugMode();
    }
  }).catch(e => {
    logToConsole('DEBUG', `❌ ${e.message}`, 'error');
    exitDebugMode();
  });
}

function exitDebugMode() {
  debugMode = false;
  debugCurrentStepId = null;

  document.getElementById('debugControls').style.display = 'none';
  document.getElementById('debugVarsPanel').style.display = 'none';
  macroEditor.classList.remove('debug-active');
  document.querySelector('.main').classList.remove('debug-layout');

  // Clear debug highlights
  document.querySelectorAll('.debug-current').forEach(el => el.classList.remove('debug-current'));
  document.querySelectorAll('.debug-cond-badge').forEach(el => el.remove());

  logToConsole('DEBUG', '🐛 Отладка завершена', 'info');
}

function setDebugButtonsEnabled(enabled) {
  ['debugStepOver', 'debugStepInto', 'debugStepOut', 'debugContinue', 'debugStop'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
}

function sendDebugCommand(command) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'debug', command }));
  setDebugButtonsEnabled(false);
  document.getElementById('debugStatus').textContent = `⏳ ${command}...`;
}

function handleDebugMessage(msg) {
  if (!debugMode) return;

  if (msg.action === 'paused') {
    debugCurrentStepId = msg.stepId;
    setDebugButtonsEnabled(true);
    document.getElementById('debugStatus').textContent = `⏸ Пауза: шаг ${msg.stepId || '?'}`;

    // Update variables panel
    if (msg.variables) {
      debugPreviousVariables = { ...debugVariables };
      debugVariables = msg.variables;
      renderDebugVariables();
    }

    // Highlight current step
    highlightDebugStep(msg.stepId);
    logToConsole('DEBUG', `⏸ Остановлен на шаге: ${msg.stepId || '?'} (глубина: ${msg.depth || 0})`, 'info');

  } else if (msg.action === 'variables') {
    debugPreviousVariables = { ...debugVariables };
    debugVariables = msg.variables || {};
    renderDebugVariables();

  } else if (msg.action === 'finished') {
    logToConsole('DEBUG', '✅ Отладка завершена', 'info');
    exitDebugMode();

  } else if (msg.action === 'condition') {
    // Show condition result badge
    const badge = msg.result ? 'true' : 'false';
    logToConsole('DEBUG', `❓ Условие: ${msg.result ? 'ДА' : 'НЕТ'}`, 'info');
  }
}

function highlightDebugStep(stepPath) {
  // Remove previous highlight
  document.querySelectorAll('.debug-current').forEach(el => el.classList.remove('debug-current'));

  if (!stepPath) return;

  // Find step card or block by path
  const card = editorStepsList.querySelector(`.step-card[data-path="${stepPath}"]`);
  if (card) {
    card.classList.add('debug-current');
    // AC2: Only scroll if autoscroll is enabled
    if (debugAutoscroll) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }
  const block = editorStepsList.querySelector(`.block-container[data-path="${stepPath}"]`);
  if (block) {
    block.classList.add('debug-current');
    // AC2: Only scroll if autoscroll is enabled
    if (debugAutoscroll) {
      block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function renderDebugVariables() {
  const list = document.getElementById('debugVarsList');
  const vars = debugVariables || {};
  const entries = Object.entries(vars).filter(([k]) => !k.startsWith('__'));

  if (entries.length === 0) {
    list.innerHTML = '<div class="debug-vars-empty">Нет переменных</div>';
    return;
  }

  list.innerHTML = entries.map(([name, value]) => {
    const type = typeof value;
    const displayType = type === 'string' ? 'str' : type === 'number' ? 'num' : type === 'boolean' ? 'bool' : type;
    const displayValue = typeof value === 'string' ? `"${value.substring(0, 100)}"` : JSON.stringify(value);
    const changed = debugPreviousVariables[name] !== undefined && JSON.stringify(debugPreviousVariables[name]) !== JSON.stringify(value);
    return `<div class="debug-var-row ${changed ? 'debug-var-changed' : ''}">
      <span class="debug-var-name">${esc(name)}</span>
      <span class="debug-var-type">${displayType}</span>
      <span class="debug-var-value">${esc(displayValue)}</span>
    </div>`;
  }).join('');
}

// Debug control buttons
document.getElementById('debugStepOver').addEventListener('click', () => sendDebugCommand('step-over'));
document.getElementById('debugStepInto').addEventListener('click', () => sendDebugCommand('step-into'));
document.getElementById('debugStepOut').addEventListener('click', () => sendDebugCommand('step-out'));
document.getElementById('debugContinue').addEventListener('click', () => sendDebugCommand('continue'));
document.getElementById('debugStop').addEventListener('click', () => {
  sendDebugCommand('stop');
  setTimeout(exitDebugMode, 500);
});

// AC2: Autoscroll toggle button
document.getElementById('debugAutoscrollToggle')?.addEventListener('click', () => {
  debugAutoscroll = !debugAutoscroll;
  const btn = document.getElementById('debugAutoscrollToggle');
  if (btn) {
    btn.classList.toggle('active', debugAutoscroll);
    btn.textContent = debugAutoscroll ? '📌 Автоскролл ✓' : '📌 Автоскролл';
  }
});

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', () => showView(currentMacro ? 'editor' : 'empty'));
document.getElementById('cancelAddStep').addEventListener('click', () => document.getElementById('addStepModal').style.display = 'none');

macroNameInput.addEventListener('change', () => { if (currentMacro) { currentMacro.name = macroNameInput.value; saveMacro(); } });
startUrlInput.addEventListener('change', () => { if (currentMacro) { currentMacro.startUrl = startUrlInput.value; saveMacro(); } });

// ==================== Console ====================
let consoleLogs = []; // {time, tag, msg, category, macroId?, macroName?}
let activeConsoleTab = 'all';
let activeOvConsoleTab = 'all';
let currentMacroId = null;

function logToConsole(tag, msg, category = 'info', macroId = null) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const logEntry = { time, tag, msg, category };
  if (macroId) {
    logEntry.macroId = macroId;
    logEntry.macroName = currentMacro?.name || 'Unknown';
  }
  consoleLogs.push(logEntry);
  if (consoleLogs.length > 500) consoleLogs = consoleLogs.slice(-300);
  renderConsole();
}

function renderConsole() {
  // Render main console (macro editor)
  const logEl = document.getElementById('consoleLog');
  if (logEl) {
    let baseLogs = consoleLogs;
    if (currentMacro) {
      baseLogs = consoleLogs.filter(l => !l.macroId || l.macroId === currentMacro.id);
    }
    const filtered = filterLogs(baseLogs, activeConsoleTab);
    logEl.innerHTML = renderLogEntries(filtered, false);
    // AC2: Only auto-scroll console if user hasn't scrolled away
    const body = document.getElementById('consoleBody');
    if (body && consoleAutoscroll) body.scrollTop = body.scrollHeight;
  }

  // Render overview console
  const ovLogEl = document.getElementById('ovConsoleLog');
  if (ovLogEl) {
    const filtered = filterLogs(consoleLogs, activeOvConsoleTab);
    ovLogEl.innerHTML = renderLogEntries(filtered, true);
    const ovBody = document.getElementById('ovConsoleBody');
    if (ovBody) ovBody.scrollTop = ovBody.scrollHeight;
  }
}

function filterLogs(logs, tab) {
  if (tab === 'errors') return logs.filter(l => l.category === 'error');
  if (tab === 'python') return logs.filter(l => l.category === 'python');
  if (tab === 'macro') return logs.filter(l => ['step','loop','var','info'].includes(l.category));
  // AC38: Autoreg console tab
  if (tab === 'autoreg') return logs.filter(l => l.category === 'autoreg');
  return logs;
}

function renderLogEntries(logs, showMacroName) {
  return logs.slice(-200).map(l => {
    const extraClass = l.category === 'error' ? ' error-entry' : l.category === 'python' ? ' python-entry' : '';
    const macroPrefix = showMacroName && l.macroName ? `[${l.macroName}] ` : '';
    return `<div class="log-entry${extraClass}"><span class="log-time">${esc(l.time)}</span><span class="log-tag ${l.category}">[${esc(l.tag)}]</span><span class="log-msg">${macroPrefix}${esc(l.msg)}</span></div>`;
  }).join('');
}

// Python editor: Tab key inserts spaces instead of switching focus
document.getElementById('cfgPythonCode').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 4;
  }
});

// Console tab switching
document.querySelectorAll('.console-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.console-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeConsoleTab = tab.dataset.console;
    renderConsole();
  });
});

// Console toggle
document.getElementById('consoleToggle')?.addEventListener('click', () => {
  document.getElementById('consolePanel')?.classList.toggle('collapsed');
});

// Console clear
document.getElementById('consoleClear')?.addEventListener('click', () => {
  consoleLogs = [];
  renderConsole();
});

// Overview console tabs
document.querySelectorAll('[data-ov-console]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-ov-console]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeOvConsoleTab = tab.dataset.ovConsole;
    renderConsole();
  });
});
document.getElementById('ovConsoleClear')?.addEventListener('click', () => {
  consoleLogs = [];
  renderConsole();
});

// ==================== WebSocket ====================
function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    connectionStatus = document.getElementById('connectionStatus');
    if (connectionStatus) connectionStatus.textContent = '🟢 Подключено';
    logToConsole('SYS', 'Подключено к серверу', 'info');
  };
  ws.onmessage = event => {
    try {
      const msg = JSON.parse(event.data);

      // Update status bar (legacy)
      if (msg.type === 'step-recorded' && currentMacro) fetchMacro(currentMacro.id);

      // Handle debug messages
      if (msg.type === 'debug') {
        handleDebugMessage(msg);
        return;
      }

      // Route all messages to console
      switch (msg.type) {
        case 'running-macros':
          renderRunningMacros(msg.macros || []);
          break;
        case 'macro-started':
          currentMacroId = msg.macroId;
          logToConsole('SYS', `🚀 Макрос запущен (${msg.totalSteps} шагов)`, 'info', msg.macroId);
          runningMacros++;
          break;
        case 'macro-completed':
          logToConsole('SYS', '✅ Макрос завершён', 'info', currentMacroId);
          runningMacros = Math.max(0, runningMacros - 1);
          currentMacroId = null;
          break;
        case 'parallel-started':
          logToConsole('SYS', `🪟 Параллельный запуск: ${msg.windowCount} окон, ${msg.totalRows} строк`, 'info', msg.macroId);
          break;
        case 'parallel-window-started':
          logToConsole('SYS', `🪟 Окно ${msg.windowIndex + 1}: ${msg.rowCount} строк`, 'info');
          break;
        case 'parallel-iteration':
          logToConsole('LOOP', `🪟 W${msg.windowIndex + 1}: итерация ${msg.iteration}/${msg.total} (строка ${msg.rowIndex + 1})${msg.rowVars ? `: ${JSON.stringify(msg.rowVars)}` : ''}`, 'loop');
          break;
        case 'parallel-window-completed':
          logToConsole('SYS', `✅ Окно ${msg.windowIndex + 1}: завершено (${msg.iterations} итераций)`, 'info');
          break;
        case 'parallel-window-error':
          logToConsole('ERROR', `❌ Окно ${msg.windowIndex + 1}: ${msg.error}`, 'error');
          break;
        case 'parallel-error':
          logToConsole('ERROR', `❌ Окно W${msg.windowIndex + 1} строка ${msg.rowIndex + 1}: ${msg.error}`, 'error');
          break;
        case 'parallel-completed':
          logToConsole('SYS', `✅ Параллельный запуск завершён: ${msg.totalResults} результатов`, 'info', msg.macroId);
          break;
        case 'step-executing':
          logToConsole('STEP', `▶ Выполняю: ${msg.step?.action || '?'} [${msg.path}]`, 'step', currentMacroId);
          break;
        case 'step-skipped':
          logToConsole('STEP', `⏭ Пропущен (отключён): ${msg.step?.action || '?'} [${msg.path}]`, 'step', currentMacroId);
          break;
        case 'step-completed':
          if (msg.success) {
            logToConsole('STEP', `✅ Готово [${msg.path}]${msg.skipped ? ` (пропущено: ${msg.reason})` : ''}`, 'step', currentMacroId);
          } else {
            logToConsole('ERROR', `❌ Ошибка [${msg.path}]: ${msg.error}`, 'error', currentMacroId);
            totalErrors++;
          }
          break;
        case 'var-saved':
          logToConsole('VAR', `{{${msg.varName}}} = "${(msg.value || '').substring(0, 80)}"`, 'var', currentMacroId);
          break;
        case 'var-resolved':
          logToConsole('VAR', `Подстановка: ${msg.original} → "${msg.resolved}"`, 'var', currentMacroId);
          break;
        case 'loop-started':
          logToConsole('LOOP', `🔄 Цикл ${msg.loopType || ''}: ${msg.total} итераций${msg.tableName ? ` (таблица: ${msg.tableName})` : ''}${msg.selector ? ` (${msg.selector})` : ''}`, 'loop', currentMacroId);
          break;
        case 'loop-iteration':
          logToConsole('LOOP', `  ↳ Итерация ${msg.iteration}/${msg.total}${msg.elementText ? `: "${msg.elementText.substring(0, 60)}"` : ''}${msg.rowVars ? `: ${JSON.stringify(msg.rowVars)}` : ''}`, 'loop', currentMacroId);
          break;
        case 'loop-delay':
          logToConsole('LOOP', `  ⏳ Пауза ${Math.round(msg.delayMs/1000)}с перед итерацией ${msg.nextIteration}`, 'loop', currentMacroId);
          break;
        case 'loop-completed':
          logToConsole('LOOP', `✅ Цикл завершён: ${msg.totalIterations} итераций`, 'loop', currentMacroId);
          break;
        case 'loop-warning':
          logToConsole('LOOP', `⚠️ ${msg.message}`, 'warn', currentMacroId);
          break;
        case 'loop-error':
          logToConsole('ERROR', `❌ Ошибка цикла [${msg.iteration}]: ${msg.error}`, 'error', currentMacroId);
          break;
        case 'condition-evaluated':
          logToConsole('STEP', `❓ Условие: {{${msg.conditionVar}}} ${msg.operator} → ${msg.result ? 'ДА' : 'НЕТ'}`, 'step', currentMacroId);
          break;
        case 'proxy-rotating':
          logToConsole('SYS', '🔄 Смена прокси...', 'info', currentMacroId);
          break;
        case 'proxy-rotated':
          logToConsole('SYS', `🌐 Новый прокси: ${msg.proxy}${msg.index !== undefined ? ` [#${msg.index}]` : ''}`, 'info', currentMacroId);
          break;
        case 'proxy-error':
          logToConsole('ERROR', `❌ Ошибка прокси: ${msg.error}`, 'error', currentMacroId);
          break;
        case 'code-requested':
          logToConsole('SYS', `📲 Запрос SMS-кода → {{${msg.varName}}} (${msg.service})`, 'info', currentMacroId);
          break;
        case 'user-input-requested':
          logToConsole('SYS', `💬 Запрос ввода: "${msg.title}"`, 'info', currentMacroId);
          break;
        case 'user-input-received':
          logToConsole('VAR', `💬 Пользователь ввёл → {{${msg.varName}}}`, 'var', currentMacroId);
          break;
        case 'table-row-saved':
          logToConsole('VAR', `💾 Сохранено в "${msg.tableName}": [${(msg.row || []).join(', ')}]`, 'var', currentMacroId);
          break;
        case 'python-output':
          logToConsole('PY', msg.output || '', 'python', currentMacroId);
          break;
        case 'python-error':
          logToConsole('PY-ERR', msg.error || '', 'error', currentMacroId);
          break;
        case 'step-recorded':
          logToConsole('REC', `📹 Записан: ${msg.step?.action || '?'}`, 'info', currentMacroId);
          break;
        // AC37: Autoreg WebSocket status types
        case 'sms-number-acquiring':
          logToConsole('📱', `Покупка номера (${msg.service}, ${msg.country})...`, 'autoreg', currentMacroId);
          break;
        case 'sms-number-acquired':
          logToConsole('📱', `✅ Номер получен: ${msg.phone} (id: ${msg.smsId})`, 'autoreg', currentMacroId);
          break;
        case 'sms-code-waiting':
          logToConsole('📞', `Ожидание SMS кода (таймаут: ${msg.timeout}с)...`, 'autoreg', currentMacroId);
          break;
        case 'sms-code-poll':
          logToConsole('📞', `  ↳ Статус: ${msg.status}`, 'autoreg', currentMacroId);
          break;
        case 'sms-code-received':
          logToConsole('📞', `✅ SMS код получен: ${msg.code}`, 'autoreg', currentMacroId);
          break;
        case 'captcha-detecting':
          logToConsole('🧩', `Автоопределение капчи...`, 'autoreg', currentMacroId);
          break;
        case 'captcha-detected':
          logToConsole('🧩', `Обнаружена: ${msg.captchaType} (${msg.siteKey?.substring(0,20)}...)`, 'autoreg', currentMacroId);
          break;
        case 'captcha-solving':
          logToConsole('🧩', `Решение капчи (${msg.captchaType})...`, 'autoreg', currentMacroId);
          break;
        case 'captcha-solved':
          logToConsole('🧩', `✅ Капча решена`, 'autoreg', currentMacroId);
          break;
        case 'account-registered':
          logToConsole('📋', `✅ Аккаунт зарегистрирован: ${msg.phone}`, 'autoreg', currentMacroId);
          updateAutoregStatsLive();
          break;
        case 'account-failed':
          logToConsole('📋', `❌ Аккаунт провалился: ${msg.phone} (${msg.status})`, 'autoreg', currentMacroId);
          updateAutoregStatsLive();
          break;
        case 'autoreg-warning':
          logToConsole('⚠️', `${msg.message}`, 'autoreg', currentMacroId);
          break;
        case 'sms-number-released':
          logToConsole('📧', `Номер освобождён (id: ${msg.smsId})`, 'autoreg', currentMacroId);
          break;
        case 'sms-release-error':
          logToConsole('📧', `Ошибка освобождения: ${msg.error}`, 'autoreg', currentMacroId);
          break;
        case 'human-delay':
          logToConsole('⏱️', `Пауза ${Math.round(msg.delayMs/1000)}с${msg.humanize ? ' (гауссова)' : ''}${msg.multiplier > 1 ? ` ×${msg.multiplier}` : ''}`, 'autoreg', currentMacroId);
          break;
        default:
          if (msg.type) logToConsole('WS', `${msg.type}: ${JSON.stringify(msg).substring(0, 100)}`, 'info');
      }
    } catch (e) {}
  };
  ws.onclose = () => {
    connectionStatus = document.getElementById('connectionStatus');
    if (connectionStatus) connectionStatus.textContent = '🔴 Отключено';
    logToConsole('SYS', '🔴 Отключено от сервера, переподключение...', 'warn');
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => { ws = null; };
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ==================== Running Macros Panel ====================
function renderRunningMacros(macrosList) {
  const panel = document.getElementById('runningMacrosPanel');
  const list = document.getElementById('runningMacrosList');
  if (!panel || !list) return;
  
  const active = macrosList.filter(m => m.status === 'running' || m.status === 'stopping');
  if (active.length === 0) {
    panel.style.display = 'none';
    return;
  }
  
  panel.style.display = 'block';
  list.innerHTML = active.map(m => {
    const typeIcon = m.type === 'parallel' ? '🪟' : m.type === 'loop' ? '🔄' : '▶';
    const statusIcon = m.status === 'stopping' ? '⏹' : '🏃';
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;color:var(--text)">
      <span>${typeIcon} ${statusIcon}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.macroName)}</span>
      <button class="step-btn delete-btn" onclick="stopRunningMacro('${esc(m.runId)}')" title="Остановить" style="font-size:10px;padding:2px 4px">⏹</button>
    </div>`;
  }).join('');
}

async function stopRunningMacro(runId) {
  try {
    await fetch(`${API}/running/${runId}/stop`, { method: 'POST' });
    logToConsole('SYS', `⏹ Остановка запрошена (${runId})`, 'info');
  } catch (e) {
    logToConsole('SYS', `❌ ${e.message}`, 'error');
  }
}

window.runWithOptions = runWithOptions;
window.updateRunModeUI = updateRunModeUI;
window.createProfile = createProfile;
window.deleteProfile = deleteProfile;
window.launchProfile = launchProfile;
window.stopRunningMacro = stopRunningMacro;

// ==================== Browser Profiles ====================
let profiles = {};

async function fetchProfiles() {
  try {
    const res = await fetch(`${API}/profiles`);
    profiles = await res.json() || {};
    renderProfiles();
    updateRunProfileSelector();
  } catch (e) {
    console.error('Failed to load profiles:', e);
  }
}

function renderProfiles() {
  const list = document.getElementById('profilesList');
  if (!list) return;
  
  list.innerHTML = Object.keys(profiles).map(name => {
    const profile = profiles[name];
    const lastUsed = profile.lastUsed ? new Date(profile.lastUsed).toLocaleString() : 'Никогда';
    return `
      <div class="profile-item">
        <div class="profile-info">
          <div class="profile-name">👤 ${esc(name)}</div>
          <div class="profile-lastused">Последний раз: ${lastUsed}</div>
        </div>
        <div class="profile-actions">
          <button class="btn btn-primary btn-small" onclick="launchProfile('${esc(name)}')">🚀 Открыть</button>
          <button class="btn btn-danger btn-small" onclick="deleteProfile('${esc(name)}')">🗑 Удалить</button>
        </div>
      </div>
    `;
  }).join('');
}

function updateRunProfileSelector() {
  const selector = document.getElementById('runProfileSelect');
  if (!selector) return;
  
  const currentValue = selector.value;
  selector.innerHTML = '<option value="">Стандартный (без профиля)</option>';
  
  Object.keys(profiles).forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `👤 ${name}`;
    selector.appendChild(option);
  });
  
  selector.value = currentValue;
}

async function createProfile() {
  const name = document.getElementById('newProfileName').value.trim();
  if (!name) {
    alert('Введите имя профиля');
    return;
  }
  
  try {
    const res = await fetch(`${API}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    
    if (res.ok) {
      document.getElementById('newProfileName').value = '';
      fetchProfiles();
      logToConsole('SYS', `✅ Профиль "${name}" создан`, 'info');
    } else {
      const error = await res.json();
      alert('Ошибка: ' + error.error);
    }
  } catch (e) {
    alert('Ошибка создания профиля: ' + e.message);
  }
}

async function deleteProfile(name) {
  if (!confirm(`Удалить профиль "${name}"?\nВсе данные будут потеряны!`)) return;
  
  try {
    await fetch(`${API}/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    fetchProfiles();
    logToConsole('SYS', `🗑 Профиль "${name}" удален`, 'info');
  } catch (e) {
    alert('Ошибка удаления: ' + e.message);
  }
}

async function launchProfile(name) {
  try {
    logToConsole('SYS', `🚀 Запуск профиля "${name}"...`, 'info');
    const res = await fetch(`${API}/profiles/${encodeURIComponent(name)}/launch`, { method: 'POST' });
    
    if (res.ok) {
      logToConsole('SYS', `✅ Профиль "${name}" открыт для ручного входа`, 'info');
      fetchProfiles(); // Update last used
    } else {
      const error = await res.json();
      logToConsole('SYS', `❌ Ошибка: ${error.error}`, 'error');
      alert('Ошибка: ' + error.error);
    }
  } catch (e) {
    logToConsole('SYS', `❌ Ошибка запуска профиля`, 'error');
    alert('Ошибка запуска профиля: ' + e.message);
  }
}

// ==================== Append Recording ====================
async function appendRecord() {
  if (!currentMacro) {
    alert('Выберите макрос');
    return;
  }
  
  let fromStep = -1;
  if (selectedPath && selectedPath.indexOf('.') === -1) {
    // Top-level step selected
    fromStep = parseInt(selectedPath);
  }
  
  const profileSelector = document.getElementById('runProfileSelect');
  const profileName = profileSelector?.value || null;
  
  try {
    logToConsole('SYS', `🔴 Начинаем дозапись с шага ${fromStep + 1}`, 'info');
    
    const res = await fetch(`${API}/macros/${currentMacro.id}/append-record/${fromStep}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName })
    });
    
    if (res.ok) {
      logToConsole('SYS', '🔴 Дозапись запущена! Записывайте новые шаги в окне браузера с расширением', 'info');
    } else {
      const error = await res.json();
      logToConsole('SYS', `❌ Ошибка дозаписи: ${error.error}`, 'error');
      alert('Ошибка дозаписи: ' + error.error);
    }
  } catch (e) {
    logToConsole('SYS', `❌ Ошибка дозаписи`, 'error');
    alert('Ошибка дозаписи: ' + e.message);
  }
}

// ==================== Overview ====================
const sessionStartTime = Date.now();
let runningMacros = 0;
let totalErrors = 0;

function openOverview() { showView('overview'); }

function renderOverview() {
  // Stats
  const totalMacros = macros.length;
  const totalSteps = macros.reduce((sum, m) => sum + (m.stepsCount || 0), 0);
  const uptimeMs = Date.now() - sessionStartTime;
  const uptimeMin = Math.floor(uptimeMs / 60000);
  const uptimeStr = uptimeMin >= 60 ? `${Math.floor(uptimeMin/60)}ч ${uptimeMin%60}м` : `${uptimeMin}м`;

  const el = (id) => document.getElementById(id);
  if (el('statTotalMacros')) el('statTotalMacros').textContent = totalMacros;
  if (el('statTotalSteps')) el('statTotalSteps').textContent = totalSteps;
  if (el('statRunning')) el('statRunning').textContent = runningMacros;
  if (el('statErrors')) el('statErrors').textContent = totalErrors;
  if (el('statUptime')) el('statUptime').textContent = uptimeStr;

  // Also render overview console
  renderConsole();
}

document.getElementById('overviewBtn').addEventListener('click', openOverview);
document.getElementById('closeOverviewBtn').addEventListener('click', () => showView(currentMacro ? 'editor' : 'empty'));

// ==================== CONTEXT MENU + COPY/PASTE + MULTISELECT ====================
const contextMenu = document.getElementById('contextMenu');
let ctxTargetPath = '';

function showContextMenu(x, y, path) {
  ctxTargetPath = path;
  contextMenu.style.display = 'block';

  // Position
  let left = x, top = y;
  if (left + 220 > window.innerWidth) left = x - 220;
  if (top + 300 > window.innerHeight) top = y - 300;
  contextMenu.style.left = Math.max(5, left) + 'px';
  contextMenu.style.top = Math.max(5, top) + 'px';

  // Enable/disable paste
  const pasteBtn = contextMenu.querySelector('[data-ctx="paste"]');
  if (pasteBtn) {
    if (clipboard.length > 0) pasteBtn.removeAttribute('disabled');
    else pasteBtn.setAttribute('disabled', '');
  }

  // Build submenu with macros
  const submenu = document.getElementById('ctxPasteSubmenu');
  submenu.innerHTML = macros.filter(m => m.id !== currentMacro?.id).map(m =>
    `<button class="ctx-item" data-paste-macro="${esc(m.id)}">${esc(m.name)}</button>`
  ).join('') || '<div style="padding:8px;color:var(--overlay);font-size:12px">Нет других макросов</div>';

  // Paste-to also needs clipboard
  const pasteToBtn = contextMenu.querySelector('[data-ctx="paste-to"]');
  if (pasteToBtn) {
    if (clipboard.length > 0) pasteToBtn.removeAttribute('disabled');
    else pasteToBtn.setAttribute('disabled', '');
  }
}

function hideContextMenu() {
  contextMenu.style.display = 'none';
}

// Hide on click outside (with small delay to avoid race with show)
document.addEventListener('mousedown', e => {
  if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// Context menu actions
contextMenu.addEventListener('click', async e => {
  const btn = e.target.closest('[data-ctx]');
  const pasteBtn = e.target.closest('[data-paste-macro]');

  if (pasteBtn) {
    // Paste into another macro
    const targetId = pasteBtn.dataset.pasteMacro;
    if (clipboard.length > 0 && targetId) {
      try {
        const res = await fetch(`${API}/macros/${targetId}`);
        const targetMacro = await res.json();
        clipboard.forEach(s => targetMacro.steps.push(JSON.parse(JSON.stringify(s))));
        await fetch(`${API}/macros/${targetId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(targetMacro)
        });
        logToConsole('SYS', `📌 Вставлено ${clipboard.length} шагов в "${targetMacro.name}"`, 'info');
      } catch (err) {
        logToConsole('SYS', `❌ Ошибка вставки: ${err.message}`, 'error');
      }
    }
    hideContextMenu();
    return;
  }

  if (!btn) return;
  const action = btn.dataset.ctx;

  if (action === 'copy') {
    copySelected();
  } else if (action === 'paste') {
    pasteAfterSelected();
  } else if (action === 'edit') {
    openStepConfigForEdit(ctxTargetPath);
  } else if (action === 'rename') {
    const step = getStepByPath(currentMacro.steps, ctxTargetPath);
    if (step) {
      const name = prompt('Название шага (иконка не меняется):', step.customName || ACTION_NAMES[step.action] || '');
      if (name !== null) {
        if (name.trim()) step.customName = name.trim();
        else delete step.customName;
        saveMacro(); renderSteps();
      }
    }
  } else if (action === 'delete') {
    deleteSelected();
  }

  hideContextMenu();
});

function getSelectedPaths() {
  if (multiSelectedPaths.size > 0) return Array.from(multiSelectedPaths);
  if (selectedPath) return [selectedPath];
  return [];
}

function copySelected() {
  const paths = getSelectedPaths();
  if (paths.length === 0) return;
  clipboard = paths.map(p => {
    const step = getStepByPath(currentMacro.steps, p);
    return step ? JSON.parse(JSON.stringify(step)) : null;
  }).filter(Boolean);
  logToConsole('SYS', `📋 Скопировано ${clipboard.length} шагов`, 'info');
}

function pasteAfterSelected() {
  if (clipboard.length === 0 || !currentMacro) return;
  pushUndo();
  const targetPath = selectedPath || '';
  const targetParts = targetPath.split('.');
  const targetIdx = parseInt(targetParts[targetParts.length - 1]);
  const parentPath = targetParts.slice(0, -1).join('.');
  const arr = parentPath ? getStepByPath(currentMacro.steps, parentPath) : currentMacro.steps;

  if (Array.isArray(arr)) {
    const insertAt = (!isNaN(targetIdx) ? targetIdx + 1 : arr.length);
    clipboard.forEach((step, i) => {
      arr.splice(insertAt + i, 0, JSON.parse(JSON.stringify(step)));
    });
  } else {
    // No selection — append to end
    clipboard.forEach(step => {
      currentMacro.steps.push(JSON.parse(JSON.stringify(step)));
    });
  }

  saveMacro(); renderSteps();
  logToConsole('SYS', `📌 Вставлено ${clipboard.length} шагов`, 'info');
}

function deleteSelected() {
  const paths = getSelectedPaths();
  if (paths.length === 0) return;
  pushUndo();
  // Sort paths descending so removal doesn't shift indices
  const sorted = paths.sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      if ((bParts[i] || 0) !== (aParts[i] || 0)) return (bParts[i] || 0) - (aParts[i] || 0);
    }
    return 0;
  });
  sorted.forEach(p => removeStepAt(currentMacro.steps, p));
  multiSelectedPaths.clear();
  selectedPath = '';
  saveMacro(); renderSteps();
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  // Don't intercept when typing in inputs/textareas
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  // Don't intercept when modals are open
  if (document.querySelector('.modal-overlay[style*="flex"]')) return;
  if (!currentMacro) return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    popUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    e.preventDefault();
    copySelected();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    e.preventDefault();
    pasteAfterSelected();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    // Select all top-level steps
    const allCards = editorStepsList.querySelectorAll('.step-card');
    multiSelectedPaths.clear();
    allCards.forEach(c => multiSelectedPaths.add(c.dataset.path));
    renderSteps();
  } else if (e.key === 'Escape') {
    multiSelectedPaths.clear();
    selectedPath = '';
    hideContextMenu();
    renderSteps();
  } else if (e.key === 'Delete') {
    if (getSelectedPaths().length > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }
});

// ==================== Named Selectors ====================
async function loadSelectors() {
  try {
    const resp = await fetch(`${API}/selectors`);
    savedSelectors = await resp.json();
  } catch (e) { savedSelectors = {}; }
}

// Save selector button
document.getElementById('cfgSaveSelectorBtn').addEventListener('click', async () => {
  const selector = document.getElementById('cfgSelector').value.trim();
  if (!selector) { alert('Введите селектор для сохранения'); return; }
  const name = prompt('Имя для селектора:');
  if (!name || !name.trim()) return;
  try {
    await fetch(`${API}/selectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), selector })
    });
    await loadSelectors();
    logToConsole('SYS', `💾 Селектор сохранён: @${name.trim()} → ${selector}`, 'info');
  } catch (e) {
    logToConsole('SYS', `❌ Ошибка сохранения селектора: ${e.message}`, 'error');
  }
});

// Load selector popup
document.getElementById('cfgLoadSelectorBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const popup = document.getElementById('selectorPopup');
  if (popup.style.display === 'block') { popup.style.display = 'none'; return; }
  await loadSelectors();
  renderSelectorPopup();
  // Position popup below the button
  const btn = document.getElementById('cfgLoadSelectorBtn');
  const rect = btn.getBoundingClientRect();
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.style.display = 'block';
});

function renderSelectorPopup() {
  const listEl = document.getElementById('selectorPopupList');
  const emptyEl = document.getElementById('selectorPopupEmpty');
  const names = Object.keys(savedSelectors);
  if (names.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    listEl.innerHTML = names.map(name => `
      <div class="selector-popup-item" data-selector-name="${esc(name)}">
        <span class="selector-popup-name">@${esc(name)}</span>
        <span class="selector-popup-css">→ ${esc(savedSelectors[name])}</span>
        <button class="selector-popup-delete" data-delete-selector="${esc(name)}">❌</button>
      </div>
    `).join('');
  }
}

// Delegate clicks inside popup
document.getElementById('selectorPopup').addEventListener('click', async (e) => {
  e.stopPropagation();
  const deleteBtn = e.target.closest('[data-delete-selector]');
  if (deleteBtn) {
    const name = deleteBtn.dataset.deleteSelector;
    try {
      await fetch(`${API}/selectors/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadSelectors();
      renderSelectorPopup();
      logToConsole('SYS', `🗑 Селектор @${name} удалён`, 'info');
    } catch (err) {
      logToConsole('SYS', `❌ Ошибка удаления: ${err.message}`, 'error');
    }
    return;
  }
  const item = e.target.closest('[data-selector-name]');
  if (item) {
    const name = item.dataset.selectorName;
    document.getElementById('cfgSelector').value = `@${name}`;
    document.getElementById('selectorPopup').style.display = 'none';
  }
});

// Close popup on click outside
document.addEventListener('mousedown', (e) => {
  const popup = document.getElementById('selectorPopup');
  if (popup.style.display === 'block' && !popup.contains(e.target) && e.target.id !== 'cfgLoadSelectorBtn') {
    popup.style.display = 'none';
  }
});

// ==================== Backup (Version Control) ====================
async function loadBackupList() {
  const list = document.getElementById('backupList');
  if (!list) return;
  try {
    const res = await fetch(`${API}/backup/list`);
    const backups = await res.json();
    if (backups.length === 0) {
      list.innerHTML = '<div style="color:var(--overlay);font-size:13px;padding:12px;text-align:center">Нет резервных копий</div>';
      return;
    }
    list.innerHTML = backups.map(b => {
      const date = new Date(b.date);
      const dateStr = date.toLocaleString('ru-RU');
      return `<div class="backup-item">
        <div class="backup-info">
          <div class="backup-name">📦 ${esc(b.filename)}</div>
          <div class="backup-date">📅 ${dateStr}</div>
          <div class="backup-size">💿 ${b.size}</div>
        </div>
        <div class="backup-actions">
          <button class="btn btn-primary btn-small" data-restore-backup="${esc(b.filename)}">♻️ Восстановить</button>
        </div>
      </div>`;
    }).join('');

    // Attach restore handlers
    list.querySelectorAll('[data-restore-backup]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.restoreBackup;
        if (!confirm(`Восстановить из ${filename}?\n\nТекущее состояние будет сохранено в safety-backup перед восстановлением.`)) return;
        btn.disabled = true;
        btn.textContent = '⏳...';
        try {
          const res = await fetch(`${API}/backup/restore/${encodeURIComponent(filename)}`, { method: 'POST' });
          const data = await res.json();
          if (data.ok) {
            showBackupStatus('success', `✅ Восстановлено! ${data.message}`);
            logToConsole('SYS', `♻️ Проект восстановлен из ${filename}`, 'info');
          } else {
            showBackupStatus('error', `❌ Ошибка: ${data.error}`);
          }
        } catch (e) {
          showBackupStatus('error', `❌ ${e.message}`);
        }
        btn.disabled = false;
        btn.textContent = '♻️ Восстановить';
        loadBackupList();
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red);font-size:13px;padding:12px">Ошибка: ${esc(e.message)}</div>`;
  }
}

function showBackupStatus(type, msg) {
  const el = document.getElementById('backupStatus');
  if (!el) return;
  el.className = `backup-status ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 8000);
}

document.getElementById('createBackupBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('createBackupBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Создаю архив...';
  try {
    const res = await fetch(`${API}/backup/create`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showBackupStatus('success', `✅ Создана копия: ${data.filename} (${data.size})`);
      logToConsole('SYS', `💾 Бэкап создан: ${data.filename} (${data.size})`, 'info');
      loadBackupList();
    } else {
      showBackupStatus('error', `❌ Ошибка: ${data.error}`);
    }
  } catch (e) {
    showBackupStatus('error', `❌ ${e.message}`);
  }
  btn.disabled = false;
  btn.textContent = '💾 Сохранить версию';
});

// Load backup list when backup tab is opened
document.querySelectorAll('.settings-tab').forEach(tab => {
  if (tab.dataset.tab === 'backup') {
    tab.addEventListener('click', () => loadBackupList());
  }
});

// ==================== Авторегистрация Panel (AC39-AC43) ====================

// Panel navigation
document.getElementById('autoregBtn')?.addEventListener('click', () => showView('autoreg'));
document.getElementById('closeAutoregBtn')?.addEventListener('click', () => showView(currentMacro ? 'editor' : 'empty'));

// Autoreg tab switching
document.querySelectorAll('[data-autoreg-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-autoreg-tab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabId = tab.dataset.autoregTab;
    document.querySelectorAll('#autoregPanel .tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`autoreg-tab-${tabId}`)?.classList.add('active');
  });
});

// Load autoreg data (stats + accounts)
async function loadAutoregData() {
  await loadAutoregStats();
  await loadAutoregAccounts();
  await loadAutoregSettings();
}

// AC41: Stats
async function loadAutoregStats() {
  try {
    const resp = await fetch(`${API}/accounts/stats`);
    const stats = await resp.json();
    document.getElementById('arStatAttempts').textContent = stats.total_attempts || 0;
    document.getElementById('arStatSuccess').textContent = stats.successful || 0;
    document.getElementById('arStatFailed').textContent = stats.failed || 0;
    document.getElementById('arStatRate').textContent = (stats.success_rate || 0) + '%';
    document.getElementById('arStatAvgTime').textContent = (stats.average_time_seconds || 0) + 'с';
    
    // Failure reasons
    const reasonsEl = document.getElementById('arFailureReasons');
    const reasons = stats.failures_by_reason || {};
    if (Object.keys(reasons).length === 0) {
      reasonsEl.textContent = 'Нет данных';
    } else {
      reasonsEl.innerHTML = Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `<div style="margin:2px 0">❌ ${esc(reason)}: <b>${count}</b></div>`)
        .join('');
    }
  } catch (e) { console.error('Failed to load autoreg stats:', e); }
}

function updateAutoregStatsLive() {
  // Refresh stats if autoreg panel is visible
  if (document.getElementById('autoregPanel')?.style.display !== 'none') {
    loadAutoregStats();
  }
}

document.getElementById('arRefreshStats')?.addEventListener('click', loadAutoregStats);

// AC42: Accounts table
let arAccountsPage = 0;
const AR_PAGE_SIZE = 50;

async function loadAutoregAccounts() {
  const status = document.getElementById('arAccountsFilter')?.value || 'registered';
  try {
    const resp = await fetch(`${API}/accounts/list?status=${status}&limit=${AR_PAGE_SIZE}&offset=${arAccountsPage * AR_PAGE_SIZE}`);
    const data = await resp.json();
    
    const headEl = document.getElementById('arAccountsHead');
    const bodyEl = document.getElementById('arAccountsBody');
    
    if (data.headers && data.headers.length > 0) {
      headEl.innerHTML = `<tr>${data.headers.map(h => `<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--surface1);color:var(--subtext)">${esc(h)}</th>`).join('')}</tr>`;
    }
    
    if (data.rows && data.rows.length > 0) {
      bodyEl.innerHTML = data.rows.map(row => {
        const cells = data.headers.map(h => `<td style="padding:4px 10px;border-bottom:1px solid var(--surface0);font-size:12px">${esc(row[h] || '')}</td>`);
        return `<tr>${cells.join('')}</tr>`;
      }).join('');
    } else {
      bodyEl.innerHTML = `<tr><td colspan="${data.headers?.length || 1}" style="padding:12px;text-align:center;color:var(--overlay)">Нет данных</td></tr>`;
    }
    
    document.getElementById('arAccountsPage').textContent = `${arAccountsPage + 1} (${data.total} всего)`;
  } catch (e) { console.error('Failed to load accounts:', e); }
}

document.getElementById('arAccountsRefresh')?.addEventListener('click', () => { arAccountsPage = 0; loadAutoregAccounts(); });
document.getElementById('arAccountsFilter')?.addEventListener('change', () => { arAccountsPage = 0; loadAutoregAccounts(); });
document.getElementById('arAccountsPrev')?.addEventListener('click', () => { if (arAccountsPage > 0) { arAccountsPage--; loadAutoregAccounts(); } });
document.getElementById('arAccountsNext')?.addEventListener('click', () => { arAccountsPage++; loadAutoregAccounts(); });

// AC42: Export CSV
document.getElementById('arAccountsExport')?.addEventListener('click', async () => {
  const status = document.getElementById('arAccountsFilter')?.value || 'registered';
  try {
    const resp = await fetch(`${API}/accounts/list?status=${status}&limit=10000&offset=0`);
    const data = await resp.json();
    if (!data.rows?.length) { alert('Нет данных для экспорта'); return; }
    
    const csv = [data.headers.join(','), ...data.rows.map(row => data.headers.map(h => {
      const v = row[h] || '';
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','))].join('\n');
    
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `accounts-${status}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  } catch (e) { alert('Ошибка экспорта: ' + e.message); }
});

// AC40: Settings
async function loadAutoregSettings() {
  try {
    const resp = await fetch(`${API}/settings`);
    const s = await resp.json();
    
    // SMS keys
    document.getElementById('arSmsActivateKey').value = s.smsServices?.services?.['sms-activate']?.apiKey || '';
    document.getElementById('ar5simKey').value = s.smsServices?.services?.['5sim']?.apiKey || '';
    document.getElementById('arSmshubKey').value = s.smsServices?.services?.['smshub']?.apiKey || '';
    
    // Captcha keys
    document.getElementById('ar2captchaKey').value = s.captchaServices?.services?.['2captcha']?.apiKey || '';
    document.getElementById('arAnticaptchaKey').value = s.captchaServices?.services?.['anticaptcha']?.apiKey || '';
    document.getElementById('arCaptchaActive').value = s.captchaServices?.active || '2captcha';
    
    // Autoreg config
    document.getElementById('arDefaultCountry').value = s.autoregConfig?.defaultCountry || 'ru';
    document.getElementById('arSuccessThreshold').value = s.autoregConfig?.successRateThreshold || 30;
    document.getElementById('arSmsTimeout').value = s.autoregConfig?.smsTimeout || 120;
    document.getElementById('arDelayMultiplier').value = s.autoregConfig?.delayMultiplier || 1;
  } catch (e) { console.error('Failed to load autoreg settings:', e); }
}

// Save autoreg settings
document.getElementById('arSaveSettings')?.addEventListener('click', async () => {
  try {
    const resp = await fetch(`${API}/settings`);
    const s = await resp.json();
    
    // Update SMS services
    if (!s.smsServices) s.smsServices = { active: '', services: {} };
    if (!s.smsServices.services) s.smsServices.services = {};
    s.smsServices.services['sms-activate'] = { ...(s.smsServices.services['sms-activate'] || {}), apiKey: document.getElementById('arSmsActivateKey').value };
    s.smsServices.services['5sim'] = { ...(s.smsServices.services['5sim'] || {}), apiKey: document.getElementById('ar5simKey').value };
    s.smsServices.services['smshub'] = { ...(s.smsServices.services['smshub'] || {}), apiKey: document.getElementById('arSmshubKey').value };
    
    // Update captcha services (AC43)
    s.captchaServices = {
      active: document.getElementById('arCaptchaActive').value,
      services: {
        '2captcha': { apiKey: document.getElementById('ar2captchaKey').value },
        'anticaptcha': { apiKey: document.getElementById('arAnticaptchaKey').value }
      }
    };
    
    // Update autoreg config (AC43)
    s.autoregConfig = {
      defaultCountry: document.getElementById('arDefaultCountry').value,
      successRateThreshold: parseInt(document.getElementById('arSuccessThreshold').value) || 30,
      maxRetries: s.autoregConfig?.maxRetries || 3,
      delayMultiplier: parseFloat(document.getElementById('arDelayMultiplier').value) || 1,
      smsTimeout: parseInt(document.getElementById('arSmsTimeout').value) || 120,
      smsCheckInterval: s.autoregConfig?.smsCheckInterval || 5
    };
    
    await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
    
    document.getElementById('arSettingsStatus').textContent = '✅ Сохранено!';
    setTimeout(() => { document.getElementById('arSettingsStatus').textContent = ''; }, 3000);
  } catch (e) {
    document.getElementById('arSettingsStatus').textContent = '❌ Ошибка: ' + e.message;
  }
});

// Balance check buttons (AC6, AC40)
async function checkServiceBalance(service, type = 'sms') {
  try {
    const endpoint = type === 'sms' ? `/sms/balance?service=${service}` : `/captcha/balance?service=${service}`;
    const resp = await fetch(`${API}${endpoint}`);
    const data = await resp.json();
    if (data.error) {
      alert(`Ошибка: ${data.error}`);
    } else {
      alert(`💰 Баланс ${service}: ${data.balance} ${data.currency}`);
    }
  } catch (e) {
    alert(`Ошибка проверки баланса: ${e.message}`);
  }
}

document.getElementById('arSmsActivateBalance')?.addEventListener('click', () => checkServiceBalance('sms-activate', 'sms'));
document.getElementById('ar5simBalance')?.addEventListener('click', () => checkServiceBalance('5sim', 'sms'));
document.getElementById('arSmshubBalance')?.addEventListener('click', () => checkServiceBalance('smshub', 'sms'));
document.getElementById('ar2captchaBalance')?.addEventListener('click', () => checkServiceBalance('2captcha', 'captcha'));
document.getElementById('arAnticaptchaBalance')?.addEventListener('click', () => checkServiceBalance('anticaptcha', 'captcha'));

// ==================== Init ====================
loadBlockDefinitions(); // AC6: Load block definitions first
fetchMacros();
loadSettingsFromServer();
loadSelectors();
connectWS();

// AC2: Console scroll detection — disable autoscroll when user scrolls away from bottom
document.getElementById('consoleBody')?.addEventListener('scroll', function() {
  const el = this;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  consoleAutoscroll = atBottom;
});
