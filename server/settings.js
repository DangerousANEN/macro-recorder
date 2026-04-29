import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// AC12: All user data consolidated under project-root/data/
const DATA_ROOT = join(__dirname, '..', 'data');
const SETTINGS_FILE = join(DATA_ROOT, 'settings.json');
const PERSISTENT_VARS_FILE = join(DATA_ROOT, 'variables', 'persistent.json');

// Ensure data directories exist
mkdirSync(join(DATA_ROOT, 'variables'), { recursive: true });

const DEFAULT_SETTINGS = {
  // SMS/Phone number services
  smsServices: {
    active: '', // which service is currently active
    services: {
      'sms-activate': { apiKey: '', baseUrl: 'https://api.sms-activate.org/stubs/handler_api.php' },
      '5sim': { apiKey: '', baseUrl: 'https://5sim.net/v1' },
      'smshub': { apiKey: '', baseUrl: 'http://smshub.org/stubs/handler_api.php' },
      'custom': { apiKey: '', baseUrl: '' }
    }
  },

  // Proxy settings
  proxy: {
    enabled: false,
    type: 'http', // http, socks5
    host: '',
    port: '',
    username: '',
    password: '',
    rotationUrl: '', // API URL for rotating proxies
    list: [] // list of proxies for rotation
  },

  // Fingerprint / anti-detect
  fingerprint: {
    enabled: false,
    userAgent: '',
    language: 'ru-RU',
    timezone: 'Europe/Moscow',
    screenResolution: '1920x1080',
    webglVendor: '',
    platform: 'Win32',
    hardwareConcurrency: 8,
    deviceMemory: 8
  },

  // Cookie management
  cookies: {
    autoSave: true,
    autoLoad: true,
    profiles: {} // named cookie profiles: { "profile1": [{cookie objects}] }
  },

  // Variables — user-defined data for macros
  variables: {
    global: {}, // key-value pairs available in all macros
    // e.g. { "email": "test@test.com", "password": "123" }
  },

  // Data tables — CSV/rows for bulk runs
  dataTables: {
    // tableName: { headers: [...], rows: [[...], [...]] }
  },

  // Browser profiles for persistent cookies/localStorage
  browserProfiles: {
    // profileName: { path: '/path/to/user-data-dir', lastUsed: '...' }
  },

  // Именованные селекторы — сохранённые CSS-селекторы с человекопонятными именами
  savedSelectors: {
    // "название": "css-селектор"
  },

  // Таймаут ожидания элементов по умолчанию (мс)
  timeout: 5000,

  // Browser runtime options
  // headless=true is the only reliable way to avoid Alt-Tab / focus stealing on Windows.
  browser: {
    headless: false
  },

  // AC43: Captcha services
  captchaServices: {
    active: '2captcha', // '2captcha' or 'anticaptcha'
    services: {
      '2captcha': { apiKey: '' },
      'anticaptcha': { apiKey: '' }
    }
  },

  // AC43: Autoreg configuration
  autoregConfig: {
    defaultCountry: 'ru',
    successRateThreshold: 30,
    maxRetries: 3,
    delayMultiplier: 1,
    smsTimeout: 120,
    smsCheckInterval: 5
  }
};

export function loadSettings() {
  // Try new location first, then fall back to old locations for migration
  let settingsPath = SETTINGS_FILE;
  
  if (!existsSync(settingsPath)) {
    // Fallback: old location server/data/settings.json
    const oldPath1 = join(__dirname, 'data', 'settings.json');
    const oldPath2 = join(__dirname, '..', 'macros', 'settings.json');
    if (existsSync(oldPath1)) settingsPath = oldPath1;
    else if (existsSync(oldPath2)) settingsPath = oldPath2;
  }
  
  if (existsSync(settingsPath)) {
    try {
      const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const merged = { ...DEFAULT_SETTINGS, ...data };
      // If loaded from old location, save to new location
      if (settingsPath !== SETTINGS_FILE) {
        mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
        writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
      }
      return merged;
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// AC8: Persistent variables
export function loadPersistentVars() {
  if (existsSync(PERSISTENT_VARS_FILE)) {
    try {
      return JSON.parse(readFileSync(PERSISTENT_VARS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to load persistent vars:', e);
    }
  }
  return {};
}

export function savePersistentVars(vars) {
  mkdirSync(dirname(PERSISTENT_VARS_FILE), { recursive: true });
  writeFileSync(PERSISTENT_VARS_FILE, JSON.stringify(vars, null, 2));
}

export function setupSettingsRoutes(app) {
  app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
  });

  app.put('/api/settings', (req, res) => {
    const settings = req.body;
    saveSettings(settings);
    res.json({ ok: true });
  });

  // Partial update — merge top-level fields
  app.patch('/api/settings', (req, res) => {
    const settings = loadSettings();
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      settings[key] = value;
    }
    saveSettings(settings);
    res.json({ ok: true });
  });

  // Partial update — merge specific section
  app.patch('/api/settings/:section', (req, res) => {
    const settings = loadSettings();
    const section = req.params.section;
    if (settings[section] !== undefined) {
      settings[section] = { ...settings[section], ...req.body };
      saveSettings(settings);
      res.json({ ok: true, [section]: settings[section] });
    } else {
      res.status(400).json({ error: `Unknown section: ${section}` });
    }
  });

  // Variables CRUD — AC8: includes persistent flag
  app.get('/api/variables', (req, res) => {
    const settings = loadSettings();
    const persistentVars = loadPersistentVars();
    // Merge: mark each variable with persistent flag
    const result = { global: {} };
    // Global (ephemeral) vars
    for (const [k, v] of Object.entries(settings.variables?.global || {})) {
      result.global[k] = { value: v, persistent: false };
    }
    // Persistent vars override
    for (const [k, v] of Object.entries(persistentVars)) {
      result.global[k] = { value: v, persistent: true };
    }
    res.json(result);
  });

  app.put('/api/variables', (req, res) => {
    const settings = loadSettings();
    const newVars = req.body;
    
    // Separate persistent from ephemeral
    if (newVars.global) {
      const ephemeral = {};
      const persistent = {};
      for (const [k, v] of Object.entries(newVars.global)) {
        if (v && typeof v === 'object' && v.persistent) {
          persistent[k] = v.value !== undefined ? v.value : v;
        } else {
          ephemeral[k] = typeof v === 'object' && v.value !== undefined ? v.value : v;
        }
      }
      settings.variables = { global: ephemeral };
      saveSettings(settings);
      savePersistentVars(persistent);
    } else {
      settings.variables = newVars;
      saveSettings(settings);
    }
    res.json({ ok: true });
  });

  // AC8: Persistent variables endpoint
  app.get('/api/variables/persistent', (req, res) => {
    res.json(loadPersistentVars());
  });

  app.put('/api/variables/persistent', (req, res) => {
    savePersistentVars(req.body);
    res.json({ ok: true });
  });

  // Data tables
  app.get('/api/tables', (req, res) => {
    const settings = loadSettings();
    res.json(settings.dataTables);
  });

  app.put('/api/tables/:name', (req, res) => {
    const settings = loadSettings();
    settings.dataTables[req.params.name] = req.body;
    saveSettings(settings);
    res.json({ ok: true });
  });

  app.delete('/api/tables/:name', (req, res) => {
    const settings = loadSettings();
    delete settings.dataTables[req.params.name];
    saveSettings(settings);
    res.json({ ok: true });
  });

  // Именованные селекторы CRUD
  app.get('/api/selectors', (req, res) => {
    const settings = loadSettings();
    res.json(settings.savedSelectors || {});
  });

  app.post('/api/selectors', (req, res) => {
    const { name, selector } = req.body;
    if (!name || !selector) return res.status(400).json({ error: 'name и selector обязательны' });
    const settings = loadSettings();
    if (!settings.savedSelectors) settings.savedSelectors = {};
    settings.savedSelectors[name] = selector;
    saveSettings(settings);
    res.json({ ok: true, name, selector });
  });

  app.put('/api/selectors/:name', (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).json({ error: 'selector обязателен' });
    const settings = loadSettings();
    if (!settings.savedSelectors) settings.savedSelectors = {};
    settings.savedSelectors[req.params.name] = selector;
    saveSettings(settings);
    res.json({ ok: true });
  });

  app.delete('/api/selectors/:name', (req, res) => {
    const settings = loadSettings();
    if (settings.savedSelectors) {
      delete settings.savedSelectors[req.params.name];
      saveSettings(settings);
    }
    res.json({ ok: true });
  });
}
