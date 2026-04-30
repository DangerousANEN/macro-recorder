// Thin client for the recorder's HTTP API. All fetches in app.js are being
// migrated to go through this object so URL/method assumptions live in one
// place. Loaded before app.js so `window.MacroAPI` is available globally.
//
// Each method returns a promise resolving to JSON (or undefined for DELETEs).
// Errors are surfaced to the caller — nothing is swallowed here.

(function () {
  const BASE = 'http://localhost:3700/api';

  async function jget(path) {
    const res = await fetch(BASE + path);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  }

  async function jsonReq(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    if (!res.ok && res.status !== 204) throw new Error(`${method} ${path} → ${res.status}`);
    if (res.status === 204) return undefined;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  const MacroAPI = {
    BASE,

    // Macros
    listMacros() { return jget('/macros'); },
    getMacro(id) { return jget('/macros/' + encodeURIComponent(id)); },
    createMacro(payload) { return jsonReq('POST', '/macros', payload || { name: 'Новый макрос' }); },
    updateMacro(id, macro) { return jsonReq('PUT', '/macros/' + encodeURIComponent(id), macro); },
    deleteMacro(id) { return jsonReq('DELETE', '/macros/' + encodeURIComponent(id)); },
    importMacro(macro) { return jsonReq('POST', '/macros/import', macro); },
    listSnapshots(id) { return jget('/macros/' + encodeURIComponent(id) + '/snapshots'); },

    // Run
    runMacro(id, body) { return jsonReq('POST', `/macros/${encodeURIComponent(id)}/run`, body || {}); },
    runMacroLoop(id, body) { return jsonReq('POST', `/macros/${encodeURIComponent(id)}/run-loop`, body || {}); },
    runMacroParallel(id, body) { return jsonReq('POST', `/macros/${encodeURIComponent(id)}/run-parallel`, body || {}); },
    runStep(id, stepPath) { return jsonReq('POST', `/macros/${encodeURIComponent(id)}/steps/${stepPath}/run`); },
    runUpToStep(id, stepPath) { return jsonReq('POST', `/macros/${encodeURIComponent(id)}/run-to/${stepPath}`); },
    stopRun(runId) { return jsonReq('POST', `/running/${encodeURIComponent(runId)}/stop`); },

    // Settings + variables + tables
    getSettings() { return jget('/settings'); },
    putSettings(settings) { return jsonReq('PUT', '/settings', settings); },
    getPersistentVars() { return jget('/variables/persistent'); },
    setPersistentVar(name, value) { return jsonReq('PUT', '/variables/persistent', { name, value }); },
    deletePersistentVar(name) { return jsonReq('DELETE', '/variables/persistent/' + encodeURIComponent(name)); },
    putTable(name, payload) { return jsonReq('PUT', '/tables/' + encodeURIComponent(name), payload); },
    deleteTable(name) { return jsonReq('DELETE', '/tables/' + encodeURIComponent(name)); },

    // Profiles
    listProfiles() { return jget('/profiles'); },
    createProfile(payload) { return jsonReq('POST', '/profiles', payload); },
    deleteProfile(name) { return jsonReq('DELETE', '/profiles/' + encodeURIComponent(name)); },
    launchProfile(name) { return jsonReq('POST', `/profiles/${encodeURIComponent(name)}/launch`); },

    // Misc
    listBlocks() { return jget('/blocks'); },
    pythonExec(payload) { return jsonReq('POST', '/python/exec', payload); },
    snapshotsGc(payload) { return jsonReq('POST', '/snapshots/gc', payload || {}); },
  };

  window.MacroAPI = MacroAPI;
})();
