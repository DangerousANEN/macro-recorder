// Background service worker — manages WebSocket + state

let ws = null;
let wsReconnectTimer = null;
let currentMacroId = null;
let recordingState = { isRecording: false, isPaused: false, macroName: '', steps: [] };

const SERVER_URL = 'ws://localhost:3700';

// --- Persist critical state to survive service worker restarts ---
function persistState() {
  chrome.storage.local.set({
    _bg_currentMacroId: currentMacroId,
    _bg_isRecording: recordingState.isRecording,
    _bg_isPaused: recordingState.isPaused,
    _bg_macroName: recordingState.macroName,
    _bg_stepCount: recordingState.steps.length,
    _bg_startUrl: recordingState.startUrl || ''
  });
}

// Restore state on service worker startup (Chrome may kill & restart at any time)
chrome.storage.local.get([
  '_bg_currentMacroId', '_bg_isRecording', '_bg_isPaused',
  '_bg_macroName', '_bg_stepCount', '_bg_startUrl'
], (data) => {
  if (data._bg_currentMacroId) {
    currentMacroId = data._bg_currentMacroId;
    console.log('🔄 Restored macroId:', currentMacroId);
  }
  if (data._bg_isRecording) {
    recordingState.isRecording = true;
    recordingState.isPaused = !!data._bg_isPaused;
    recordingState.macroName = data._bg_macroName || 'Новый макрос';
    recordingState.startUrl = data._bg_startUrl || '';
    // Steps are already on the server, we just need the count for UI
    // Fetch current steps from server to stay in sync
    if (currentMacroId) {
      fetch(`http://localhost:3700/api/macros/${currentMacroId}`)
        .then(r => r.json())
        .then(macro => {
          if (macro && macro.steps) {
            recordingState.steps = macro.steps;
            console.log('🔄 Restored', macro.steps.length, 'steps from server');
          }
        })
        .catch(() => {});
    }
  }
});

// --- WebSocket connection ---
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  
  try {
    ws = new WebSocket(SERVER_URL);
    
    ws.onopen = () => {
      console.log('✅ Connected to server');
      clearTimeout(wsReconnectTimer);
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('📩 Server message:', msg.type);
      } catch (e) {}
    };
    
    ws.onclose = () => {
      console.log('❌ Disconnected from server');
      ws = null;
      wsReconnectTimer = setTimeout(connectWS, 3000);
    };
    
    ws.onerror = () => {
      ws = null;
    };
  } catch (e) {
    wsReconnectTimer = setTimeout(connectWS, 3000);
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Save macro to server via REST ---
async function saveMacroToServer() {
  if (!currentMacroId) {
    // Create new macro
    try {
      const res = await fetch('http://localhost:3700/api/macros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: recordingState.macroName || 'Новый макрос',
          steps: recordingState.steps,
          startUrl: recordingState.startUrl || ''
        })
      });
      const macro = await res.json();
      currentMacroId = macro.id;
      persistState(); // Immediately persist new macroId
      return macro;
    } catch (e) {
      console.error('Failed to create macro:', e);
    }
  } else {
    // Update existing
    try {
      const res = await fetch(`http://localhost:3700/api/macros/${currentMacroId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: recordingState.macroName,
          steps: recordingState.steps,
          startUrl: recordingState.startUrl || ''
        })
      });
      return await res.json();
    } catch (e) {
      console.error('Failed to update macro:', e);
    }
  }
}

// --- Message handling ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'record-step') {
    recordingState.steps.push(msg.step);
    sendToServer({ type: 'step-recorded', step: msg.step, macroId: currentMacroId });
    // Auto-save every step
    saveMacroToServer().then(() => {
      // Persist state after each save (in case service worker dies)
      persistState();
      // Save snapshot if available
      if (msg.snapshot && currentMacroId) {
        const stepIdx = recordingState.steps.length - 1;
        fetch(`http://localhost:3700/api/macros/${currentMacroId}/snapshots/${stepIdx}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/html' },
          body: msg.snapshot
        }).catch(e => console.error('Snapshot save failed:', e));
      }
    });
    sendResponse({ ok: true, stepCount: recordingState.steps.length });
  }
  
  if (msg.type === 'start-recording-request') {
    recordingState = { isRecording: true, isPaused: false, macroName: msg.name || 'Новый макрос', steps: [], startUrl: '' };
    currentMacroId = null;
    
    // Send to active tab's content script + capture startUrl
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        recordingState.startUrl = tabs[0].url || '';
        persistState(); // Persist fresh recording state
        chrome.tabs.sendMessage(tabs[0].id, { type: 'start-recording' }, (response) => {
          sendResponse({ ok: true });
        });
      }
    });
    return true; // async response
  }
  
  if (msg.type === 'stop-recording') {
    recordingState.isRecording = false;
    saveMacroToServer().then(() => {
      // Clear persisted state on stop
      chrome.storage.local.remove([
        '_bg_currentMacroId', '_bg_isRecording', '_bg_isPaused',
        '_bg_macroName', '_bg_stepCount', '_bg_startUrl'
      ]);
      sendResponse({ ok: true, macroId: currentMacroId });
    });
    return true;
  }
  
  if (msg.type === 'recording-status') {
    recordingState.isPaused = msg.isPaused;
    recordingState.isRecording = msg.isRecording;
    persistState(); // Persist pause/resume state
    sendToServer({ type: 'recording-status', ...msg });
  }
  
  if (msg.type === 'get-recording-state') {
    sendResponse(recordingState);
  }
});

// Connect on startup
connectWS();

// Reconnect periodically
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
}, 10000);
