const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const nameGroup = document.getElementById('nameGroup');
const macroName = document.getElementById('macroName');
const stepsSection = document.getElementById('stepsSection');
const stepsList = document.getElementById('stepsList');
const editorBtn = document.getElementById('editorBtn');

const ACTION_ICONS = {
  click: '📌',
  type: '✍️',
  read: '👁',
  wait: '⏳',
  navigate: '🔗',
  scroll: '📜'
};

const ACTION_NAMES = {
  click: 'Клик',
  type: 'Ввод текста',
  read: 'Чтение',
  wait: 'Ожидание',
  navigate: 'Переход',
  scroll: 'Прокрутка'
};

function updateUI(state) {
  if (state.isRecording) {
    recordBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    nameGroup.style.display = 'none';
    statusDot.className = 'status-dot ' + (state.isPaused ? 'paused' : 'recording');
    statusText.textContent = state.isPaused ? '⏸ Пауза' : `🔴 Запись — ${state.steps.length} шагов`;
    
    if (state.steps.length > 0) {
      stepsSection.style.display = 'block';
      stepsList.innerHTML = state.steps.map((s, i) => `
        <div class="step-item">
          <span class="step-icon">${ACTION_ICONS[s.action] || '❓'}</span>
          <div class="step-info">
            ${ACTION_NAMES[s.action] || s.action}${s.value ? ': "' + s.value + '"' : ''}
            <span class="step-selector">${s.cssSelector || ''}</span>
          </div>
        </div>
      `).join('');
      stepsList.scrollTop = stepsList.scrollHeight;
    }
  } else {
    recordBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    nameGroup.style.display = 'block';
    statusDot.className = 'status-dot';
    statusText.textContent = 'Не записывает';
  }
}

// Get current state on popup open
chrome.runtime.sendMessage({ type: 'get-recording-state' }, (state) => {
  if (state) updateUI(state);
});

// Start recording
recordBtn.addEventListener('click', () => {
  const name = macroName.value.trim() || 'Новый макрос';
  chrome.runtime.sendMessage({ type: 'start-recording-request', name }, (response) => {
    updateUI({ isRecording: true, isPaused: false, steps: [], macroName: name });
  });
});

// Stop recording
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop-recording' }, (response) => {
    updateUI({ isRecording: false, steps: [] });
    if (response?.macroId) {
      statusText.textContent = '✅ Сохранено!';
      statusDot.className = 'status-dot connected';
    }
  });
  // Also stop in content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'stop-recording' });
  });
});

// Open editor
editorBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:3700' });
});

// Listen for updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'recording-status' || msg.type === 'record-step') {
    chrome.runtime.sendMessage({ type: 'get-recording-state' }, updateUI);
  }
});
