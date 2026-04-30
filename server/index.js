import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { runMacro, runStep, runUpTo, runMacroLoop, runMacroParallel, closeBrowser, stopCurrentRun, setCurrentRunId, getActivePage } from './player.js';
import { getEvents as getRunEvents, getLastFailure, getAllFailures, markFinished as markRunFinished } from './run-history.js';
import { setupSettingsRoutes, loadSettings, saveSettings } from './settings.js';
import { processBotsCsv } from './bots-process.js';
import archiver from 'archiver';
import { statSync } from 'fs';
import { getNumber, checkCode, releaseNumber, getBalance, waitForCode } from './sms-api.js';
import { solveCaptcha, getCaptchaBalance } from './captcha-solver.js';
import { initAccountsDB, saveAccount, loadStats, listAccounts } from './accounts-db.js';
import { runSnapshotGc } from './snapshot-gc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// AC12: Consolidate all user files to project-root/data/
const PROJECT_ROOT = join(__dirname, '..');
const DATA_ROOT = join(PROJECT_ROOT, 'data');
const DATA_DIR = join(DATA_ROOT, 'macros');
const SNAPSHOTS_DIR = join(DATA_ROOT, 'snapshots');
const BLOCKS_DIR = join(DATA_ROOT, 'blocks');
const PYTHON_DIR = join(DATA_ROOT, 'python');
const EDITOR_DIR = join(__dirname, '..', 'editor');

// Legacy data dirs (for migration)
const LEGACY_DATA_DIR = join(PROJECT_ROOT, 'macros');
const LEGACY_SERVER_DATA = join(__dirname, 'data', 'macros');

const ACCOUNTS_DIR = join(DATA_ROOT, 'accounts');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SNAPSHOTS_DIR, { recursive: true });
mkdirSync(BLOCKS_DIR, { recursive: true });
mkdirSync(PYTHON_DIR, { recursive: true });
mkdirSync(ACCOUNTS_DIR, { recursive: true });

// Initialize accounts database (AC11)
initAccountsDB();

// Migration: copy macros from old locations if data/macros is empty
function migrateIfNeeded() {
  const existingMacros = readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  if (existingMacros.length > 0) return; // Already migrated

  // Try legacy macros/ dir
  if (existsSync(LEGACY_DATA_DIR)) {
    const legacyFiles = readdirSync(LEGACY_DATA_DIR).filter(f => f.endsWith('.json') && f !== 'settings.json');
    for (const f of legacyFiles) {
      try {
        const src = join(LEGACY_DATA_DIR, f);
        const dst = join(DATA_DIR, f);
        writeFileSync(dst, readFileSync(src, 'utf-8'));
        console.log(`📦 Migrated: ${f}`);
      } catch (e) { console.error(`Migration error for ${f}:`, e.message); }
    }
  }

  // Try server/data/macros/
  if (existsSync(LEGACY_SERVER_DATA)) {
    const legacyFiles = readdirSync(LEGACY_SERVER_DATA).filter(f => f.endsWith('.json'));
    for (const f of legacyFiles) {
      try {
        const src = join(LEGACY_SERVER_DATA, f);
        const dst = join(DATA_DIR, f);
        if (!existsSync(dst)) {
          writeFileSync(dst, readFileSync(src, 'utf-8'));
          console.log(`📦 Migrated from server/data: ${f}`);
        }
      } catch (e) { console.error(`Migration error for ${f}:`, e.message); }
    }
  }

  // Migrate snapshots
  const legacySnapDir = join(LEGACY_DATA_DIR, 'snapshots');
  if (existsSync(legacySnapDir)) {
    try {
      const snapDirs = readdirSync(legacySnapDir);
      for (const dir of snapDirs) {
        const src = join(legacySnapDir, dir);
        const dst = join(SNAPSHOTS_DIR, dir);
        if (!existsSync(dst)) {
          mkdirSync(dst, { recursive: true });
          const files = readdirSync(src);
          for (const file of files) {
            writeFileSync(join(dst, file), readFileSync(join(src, file)));
          }
          console.log(`📦 Migrated snapshots: ${dir}`);
        }
      }
    } catch (e) { console.error('Snapshot migration error:', e.message); }
  }
}
migrateIfNeeded();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));
// Disable caching for editor files
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(EDITOR_DIR));

// --- Settings routes ---
setupSettingsRoutes(app);

// --- Helpers ---
function macroPath(id) { return join(DATA_DIR, `${id}.json`); }

function loadMacro(id) {
  const p = macroPath(id);
  if (!existsSync(p)) {
    // Fallback: try legacy location
    const legacyPath = join(LEGACY_DATA_DIR, `${id}.json`);
    if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, 'utf-8'));
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function saveMacro(macro) {
  writeFileSync(macroPath(macro.id), JSON.stringify(macro, null, 2));
}

function listMacros() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && f !== 'settings.json')
    .map(f => {
      try {
        const m = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
        return { id: m.id, name: m.name, stepsCount: (m.steps || []).length, createdAt: m.createdAt, updatedAt: m.updatedAt };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// --- REST API ---
app.get('/api/macros', (req, res) => res.json(listMacros()));

app.get('/api/macros/:id', (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});

app.post('/api/macros', (req, res) => {
  const macro = {
    id: uuid(),
    name: req.body.name || 'Новый макрос',
    steps: req.body.steps || [],
    startUrl: req.body.startUrl || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveMacro(macro);
  res.status(201).json(macro);
});

app.put('/api/macros/:id', (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  Object.assign(m, req.body, { id: m.id, updatedAt: new Date().toISOString() });
  saveMacro(m);
  res.json(m);
});

app.delete('/api/macros/:id', (req, res) => {
  const p = macroPath(req.params.id);
  if (existsSync(p)) unlinkSync(p);
  // Delete snapshots
  const snapDir = join(SNAPSHOTS_DIR, req.params.id);
  if (existsSync(snapDir)) rmSync(snapDir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Export a macro as a downloadable JSON file (browser triggers Save As).
app.get('/api/macros/:id/export', (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const safeName = (m.name || 'macro').replace(/[^\w.\-]+/g, '_').slice(0, 80);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.macro.json"`);
  res.send(JSON.stringify(m, null, 2));
});

// Import a macro from a JSON body. Generates a new id when missing or already taken.
app.post('/api/macros/import', (req, res) => {
  const incoming = req.body || {};
  if (!Array.isArray(incoming.steps)) {
    return res.status(400).json({ error: 'Invalid macro: missing steps array' });
  }
  const desiredId = (typeof incoming.id === 'string' && incoming.id) ? incoming.id : null;
  let id = desiredId;
  if (!id || existsSync(macroPath(id))) id = uuid();
  const macro = {
    ...incoming,
    id,
    name: incoming.name || 'Импорт',
    steps: incoming.steps,
    startUrl: incoming.startUrl || '',
    createdAt: incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
  };
  saveMacro(macro);
  res.status(201).json({ id: macro.id, name: macro.name });
});

// Serve runtime screenshots produced by the `screenshot` step.
app.get('/api/snapshots/runtime/:macroId/:file', (req, res) => {
  const safe = req.params.file.replace(/[^\w.\-]+/g, '_');
  const filePath = join(SNAPSHOTS_DIR, 'runtime', req.params.macroId, safe);
  if (!existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Run snapshot GC on demand. Body: { apply?: bool, runtimeMaxAgeDays?: number,
// editorMaxAgeDays?: number, keepPerDir?: number }. Returns summary.
app.post('/api/snapshots/gc', async (req, res) => {
  const opts = req.body || {};
  const apply = !!opts.apply;
  const runtimeMaxAgeDays = parseFloat(opts.runtimeMaxAgeDays ?? 7);
  const editorMaxAgeDays = parseFloat(opts.editorMaxAgeDays ?? 30);
  const keepPerDir = parseInt(opts.keepPerDir ?? 200);

  const summary = runSnapshotGc({
    snapshotsDir: SNAPSHOTS_DIR,
    apply,
    runtimeMaxAgeDays,
    editorMaxAgeDays,
    keepPerDir,
  });
  res.json(summary);
});

// --- Snapshots ---
app.post('/api/macros/:id/snapshots/:idx', express.text({ limit: '2mb', type: '*/*' }), (req, res) => {
  const snapDir = join(SNAPSHOTS_DIR, req.params.id);
  mkdirSync(snapDir, { recursive: true });
  const filePath = join(snapDir, `${req.params.idx}.html`);
  writeFileSync(filePath, req.body);
  res.json({ ok: true });
});

app.get('/api/macros/:id/snapshots/:idx', (req, res) => {
  const filePath = join(SNAPSHOTS_DIR, req.params.id, `${req.params.idx}.html`);
  if (!existsSync(filePath)) return res.status(404).send('Snapshot not found');
  const html = readFileSync(filePath, 'utf-8');

  // Inject <base> tag from step URL so relative CSS/assets resolve correctly
  const macro = loadMacro(req.params.id);
  const stepIndex = parseInt(req.params.idx, 10);
  const stepUrl = macro?.steps?.[stepIndex]?.url || macro?.startUrl || '';
  const baseHref = stepUrl ? `<base href="${stepUrl.replace(/"/g, '&quot;')}">` : '';

  // Inject element picker script into snapshot
  const pickerScript = `
<script>
(function(){
  document.addEventListener('DOMContentLoaded', () => init());
  if (document.readyState !== 'loading') init();
  
  function init() {
    document.querySelectorAll('a').forEach(a => { a.removeAttribute('href'); a.onclick = e => e.preventDefault(); });
    document.querySelectorAll('form').forEach(f => f.onsubmit = e => e.preventDefault());
    
    let hovered = null;
    const highlight = document.createElement('div');
    highlight.id = '_snap_highlight';
    Object.assign(highlight.style, {
      position: 'fixed', pointerEvents: 'none', border: '2px solid #89b4fa',
      background: 'rgba(137,180,250,0.15)', borderRadius: '3px', zIndex: '2147483647',
      display: 'none', transition: 'all 0.1s'
    });
    document.body.appendChild(highlight);

    const tooltip = document.createElement('div');
    tooltip.id = '_snap_tooltip';
    Object.assign(tooltip.style, {
      position: 'fixed', pointerEvents: 'none', background: '#1e1e2e', color: '#cdd6f4',
      padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace',
      zIndex: '2147483647', display: 'none', border: '1px solid #45475a', maxWidth: '400px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
    });
    document.body.appendChild(tooltip);

    function getSelector(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const attrs = ['data-testid','data-id','name','aria-label'];
      for (const a of attrs) { const v = el.getAttribute(a); if (v) return '[' + a + '="' + CSS.escape(v) + '"]'; }
      const path = [];
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
        const p = cur.parentElement;
        if (p) {
          const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName);
          if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
        path.unshift(seg);
        cur = cur.parentElement;
      }
      return path.join(' > ');
    }

    document.addEventListener('mousemove', e => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === highlight || el === tooltip || el.id === '_snap_highlight' || el.id === '_snap_tooltip') return;
      hovered = el;
      const r = el.getBoundingClientRect();
      highlight.style.display = 'block';
      highlight.style.left = r.left + 'px';
      highlight.style.top = r.top + 'px';
      highlight.style.width = r.width + 'px';
      highlight.style.height = r.height + 'px';
      
      const sel = getSelector(el);
      const tag = el.tagName.toLowerCase();
      const cls = el.className ? '.' + String(el.className).split(' ').filter(Boolean).slice(0,3).join('.') : '';
      tooltip.textContent = sel.length > 60 ? tag + cls : sel;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 420) + 'px';
      tooltip.style.top = Math.max(e.clientY - 30, 4) + 'px';
    }, true);

    document.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!hovered) return;
      const sel = getSelector(hovered);
      const tag = hovered.tagName.toLowerCase();
      const text = (hovered.textContent || '').trim().substring(0, 100);
      const rect = hovered.getBoundingClientRect();
      window.parent.postMessage({
        type: 'snapshot-element-picked',
        selector: sel,
        tagName: tag,
        textContent: text,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      }, '*');
      highlight.style.borderColor = '#a6e3a1';
      highlight.style.background = 'rgba(166,227,161,0.25)';
      setTimeout(() => {
        highlight.style.borderColor = '#89b4fa';
        highlight.style.background = 'rgba(137,180,250,0.15)';
      }, 500);
    }, true);
  }
})();
</script>`;
  let preparedHtml = html;
  if (baseHref) {
    if (preparedHtml.includes('<head')) {
      preparedHtml = preparedHtml.replace(/<head([^>]*)>/i, `<head$1>${baseHref}`);
    } else if (preparedHtml.includes('<html')) {
      preparedHtml = preparedHtml.replace(/<html([^>]*)>/i, `<html$1><head>${baseHref}</head>`);
    } else {
      preparedHtml = `<head>${baseHref}</head>` + preparedHtml;
    }
  }
  const injected = preparedHtml.includes('</body>')
    ? preparedHtml.replace('</body>', pickerScript + '</body>')
    : preparedHtml + pickerScript;
  res.type('html').send(injected);
});

app.get('/api/macros/:id/snapshots', (req, res) => {
  const snapDir = join(SNAPSHOTS_DIR, req.params.id);
  if (!existsSync(snapDir)) return res.json([]);
  const files = readdirSync(snapDir).filter(f => f.endsWith('.html')).map(f => parseInt(f)).sort((a, b) => a - b);
  res.json(files);
});

// --- AC6: Block definitions API ---
app.get('/api/blocks', (req, res) => {
  try {
    const blocks = {};
    if (existsSync(BLOCKS_DIR)) {
      const files = readdirSync(BLOCKS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const action = f.replace('.json', '');
          blocks[action] = JSON.parse(readFileSync(join(BLOCKS_DIR, f), 'utf-8'));
        } catch (e) { /* skip invalid */ }
      }
    }
    res.json(blocks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/blocks/:action', (req, res) => {
  const filePath = join(BLOCKS_DIR, `${req.params.action}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Block not found' });
  try {
    res.json(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AC5: Python scripts API ---
app.get('/api/python/scripts', (req, res) => {
  try {
    if (!existsSync(PYTHON_DIR)) return res.json([]);
    const files = readdirSync(PYTHON_DIR).filter(f => f.endsWith('.py'));
    const scripts = files.map(f => ({
      name: f,
      path: `data/python/${f}`,
    }));
    res.json(scripts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/python/scripts/:name', (req, res) => {
  const filePath = join(PYTHON_DIR, req.params.name);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Script not found' });
  res.type('text/plain').send(readFileSync(filePath, 'utf-8'));
});

// --- Backup (Version Control) ---
const BACKUP_DIR = 'F:\\ANEN\\Desktop\\macro-recorder-backups';
const MAX_BACKUPS = 10;

mkdirSync(BACKUP_DIR, { recursive: true });

app.post('/api/backup/create', async (req, res) => {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `macro-recorder-${timestamp}.zip`;
    const filepath = join(BACKUP_DIR, filename);

    const output = (await import('fs')).createWriteStream(filepath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      // Add entire project, excluding heavy/unnecessary dirs
      archive.glob('**/*', {
        cwd: PROJECT_ROOT,
        ignore: [
          'node_modules/**',
          '**/node_modules/**',
          '.git/**',
          'data/profiles/**',
          'data/snapshots/**',
          'macros/profiles/**',
          'macros/snapshots/**',
          'server/node_modules/**',
        ],
        dot: true,
      });

      archive.finalize();
    });

    // Get file size
    const stats = statSync(filepath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Cleanup: keep only last MAX_BACKUPS
    const allBackups = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('macro-recorder-') && f.endsWith('.zip'))
      .sort();
    
    if (allBackups.length > MAX_BACKUPS) {
      const toDelete = allBackups.slice(0, allBackups.length - MAX_BACKUPS);
      for (const f of toDelete) {
        try { unlinkSync(join(BACKUP_DIR, f)); } catch (e) {}
      }
    }

    res.json({ ok: true, filename, size: `${sizeMB} MB` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backup/list', (req, res) => {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('macro-recorder-') && f.endsWith('.zip'))
      .sort()
      .reverse()
      .map(f => {
        try {
          const stats = statSync(join(BACKUP_DIR, f));
          return {
            filename: f,
            size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
            date: stats.mtime.toISOString(),
          };
        } catch (e) { return null; }
      })
      .filter(Boolean);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/restore/:filename', async (req, res) => {
  const { filename } = req.params;
  // Validate filename
  if (!filename.startsWith('macro-recorder-') || !filename.endsWith('.zip')) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }
  const filepath = join(BACKUP_DIR, filename);
  if (!existsSync(filepath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  try {
    // First, create a safety backup before restoring
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const safetyName = `macro-recorder-pre-restore-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
    const safetyPath = join(BACKUP_DIR, safetyName);

    const safetyOutput = (await import('fs')).createWriteStream(safetyPath);
    const safetyArchive = archiver('zip', { zlib: { level: 6 } });

    await new Promise((resolve, reject) => {
      safetyOutput.on('close', resolve);
      safetyArchive.on('error', reject);
      safetyArchive.pipe(safetyOutput);
      safetyArchive.glob('**/*', {
        cwd: PROJECT_ROOT,
        ignore: ['node_modules/**', '**/node_modules/**', '.git/**', 'data/profiles/**', 'data/snapshots/**', 'macros/profiles/**', 'macros/snapshots/**', 'server/node_modules/**'],
        dot: true,
      });
      safetyArchive.finalize();
    });

    // Extract backup using built-in unzip
    const { execSync } = await import('child_process');
    // Use PowerShell to extract
    execSync(`powershell -Command "Expand-Archive -Path '${filepath}' -DestinationPath '${PROJECT_ROOT}' -Force"`, {
      timeout: 60000,
    });

    res.json({ ok: true, message: `Restored from ${filename}. Safety backup: ${safetyName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Autoreg API Endpoints (AC23-AC30) ====================

// AC23: POST /api/sms/get-number
app.post('/api/sms/get-number', async (req, res) => {
  try {
    const { service, country } = req.body;
    const activeService = service || loadSettings().smsServices?.active;
    if (!activeService) return res.status(400).json({ error: 'SMS сервис не указан и не настроен' });
    const result = await getNumber(activeService, country || 'ru');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC24: GET /api/sms/check-code/:id
app.get('/api/sms/check-code/:id', async (req, res) => {
  try {
    const service = req.query.service || loadSettings().smsServices?.active;
    if (!service) return res.status(400).json({ error: 'SMS сервис не указан' });
    const result = await checkCode(service, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC25: POST /api/sms/release/:id
app.post('/api/sms/release/:id', async (req, res) => {
  try {
    const { service } = req.body;
    const activeService = service || loadSettings().smsServices?.active;
    if (!activeService) return res.status(400).json({ error: 'SMS сервис не указан' });
    const result = await releaseNumber(activeService, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC26: GET /api/sms/balance
app.get('/api/sms/balance', async (req, res) => {
  try {
    const service = req.query.service || loadSettings().smsServices?.active;
    if (!service) return res.status(400).json({ error: 'SMS сервис не указан' });
    const result = await getBalance(service);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC27: POST /api/captcha/solve
app.post('/api/captcha/solve', async (req, res) => {
  try {
    const { type, siteKey, pageUrl, service, minScore } = req.body;
    if (!siteKey) return res.status(400).json({ error: 'siteKey обязателен' });
    if (!pageUrl) return res.status(400).json({ error: 'pageUrl обязателен' });
    const result = await solveCaptcha({ type: type || 'recaptcha-v2', siteKey, pageUrl, service, minScore });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Captcha balance endpoint
app.get('/api/captcha/balance', async (req, res) => {
  try {
    const service = req.query.service || loadSettings().captchaServices?.active || '2captcha';
    const result = await getCaptchaBalance(service);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC28: POST /api/accounts/save
app.post('/api/accounts/save', async (req, res) => {
  try {
    const { phone, username, sessionData, status, reason, stepFailed, proxyUsed } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone обязателен' });
    if (!status) return res.status(400).json({ error: 'status обязателен (registered/failed)' });
    await saveAccount({ phone, username, sessionData, status, reason, stepFailed, proxyUsed });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC29: GET /api/accounts/stats
app.get('/api/accounts/stats', (req, res) => {
  try {
    res.json(loadStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AC30: GET /api/accounts/list
app.get('/api/accounts/list', (req, res) => {
  try {
    const { status = 'registered', limit = '50', offset = '0' } = req.query;
    const result = listAccounts(status, parseInt(limit), parseInt(offset));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WebSocket clients (declared early for use by tracking/debug) ---
const extensionClients = new Set();

// --- Running macros tracking (Task 3: concurrent macro execution) ---
// NOTE: stop is best-effort and currently closes global Playwright resources (single-run at a time).
const runningMacros = new Map(); // runId -> { macroId, macroName, status, startTime, type, ... }
const runningAborters = new Map(); // runId -> async ({ reason }) => void
const RUN_HARD_TIMEOUT_MS = parseInt(process.env.MACRO_RUN_HARD_TIMEOUT_MS || '120000', 10);

function generateRunId() { return uuid().slice(0, 8); }

function trackRun(runId, macroId, macroName, type = 'normal') {
  runningMacros.set(runId, { macroId, macroName, status: 'running', startTime: new Date().toISOString(), type });
  // Tag broadcastStatus events with this runId so /api/running/<id>/events
  // can return structured progress for an LLM agent.
  setCurrentRunId(runId);
  broadcastRunningList();
}

async function abortRun(runId, { reason = 'stop-requested', timeout = false } = {}) {
  const run = runningMacros.get(runId);
  if (!run) return { ok: false, error: 'Run not found' };

  if (run.status === 'completed' || run.status === 'error' || run.status === 'timeout' || run.status === 'stopped') {
    return { ok: true, alreadyFinished: true, status: run.status };
  }

  run.status = timeout ? 'timeout' : 'stopping';
  run.stopReason = reason;
  run.stopRequestedAt = new Date().toISOString();
  broadcastRunningList();

  try {
    const aborter = runningAborters.get(runId);
    if (aborter) {
      await aborter({ reason });
    } else {
      // Fallback: close global Playwright resources.
      await stopCurrentRun(reason);
    }
  } catch (e) {
    run.stopError = e?.message || String(e);
  }

  run.status = timeout ? 'timeout' : 'stopped';
  run.endTime = new Date().toISOString();
  broadcastRunningList();
  return { ok: true, status: run.status };
}

function completeRun(runId, success = true, error = null) {
  const run = runningMacros.get(runId);
  if (run) {
    // If stop/timeout already set a terminal-ish status, don't overwrite it.
    if (run.status === 'stopping') run.status = 'stopped';
    if (run.status !== 'timeout' && run.status !== 'stopped') {
      run.status = success ? 'completed' : 'error';
    }
    run.error = error;
    run.endTime = new Date().toISOString();
    broadcastRunningList();
    runningAborters.delete(runId);
    // Schedule run-history GC. Events stay readable for a few minutes after
    // the run ends so an agent can still inspect failures.
    try { markRunFinished(runId); } catch {}
    // Remove from map after 30 seconds
    setTimeout(() => { runningMacros.delete(runId); broadcastRunningList(); }, 30000);
  }
}

function broadcastRunningList() {
  const list = Array.from(runningMacros.entries()).map(([id, r]) => ({ runId: id, ...r }));
  const msg = JSON.stringify({ type: 'running-macros', macros: list });
  for (const client of extensionClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// API: get running macros list
app.get('/api/running', (req, res) => {
  const list = Array.from(runningMacros.entries()).map(([id, r]) => ({ runId: id, ...r }));
  res.json(list);
});

// API: stop a running macro
app.post('/api/running/:runId/stop', async (req, res) => {
  try {
    const out = await abortRun(req.params.runId, { reason: req.body?.reason || 'manual-stop' });
    if (!out.ok && out.error === 'Run not found') return res.status(404).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === Agent debugging API ===========================================
// These endpoints exist so an LLM agent (e.g. via the MCP server) can inspect
// what's happening in a running macro without subscribing to the WebSocket
// and without taking screenshots.

// API: get structured event log for a run.
//   GET /api/running/<runId>/events?since=<seq>
// Returns { seq, events: [{seq, ts, type, ...}] } where each event mirrors
// what is broadcast over WS (step-completed, click-failed, fill-failed,
// var-saved, debug-dump, etc.).
app.get('/api/running/:runId/events', (req, res) => {
  const since = parseInt(req.query.since || '0', 10) || 0;
  const out = getRunEvents(req.params.runId, since);
  res.json(out);
});

// API: get only failure events for a run (or null if none).
//   GET /api/running/<runId>/failures
//   GET /api/running/<runId>/failures?last=1
app.get('/api/running/:runId/failures', (req, res) => {
  if (req.query.last === '1') {
    res.json({ failure: getLastFailure(req.params.runId) });
    return;
  }
  res.json({ failures: getAllFailures(req.params.runId) });
});

// API: snapshot of the live Playwright page for the active run.
//   GET /api/running/<runId>/inspect?depth=4&maxNodes=200
// Returns { url, title, cookies, outline } where outline is a structured
// (non-HTML) tree of the DOM truncated by depth and node count.
app.get('/api/running/:runId/inspect', async (req, res) => {
  const run = runningMacros.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const p = getActivePage();
  if (!p) return res.status(409).json({ error: 'No active page' });
  const depth = Math.min(parseInt(req.query.depth || '4', 10) || 4, 8);
  const maxNodes = Math.min(parseInt(req.query.maxNodes || '200', 10) || 200, 1000);
  try {
    const data = await p.evaluate(({ depth, maxNodes }) => {
      const visited = { count: 0 };
      function nodeInfo(el, d) {
        if (visited.count >= maxNodes) return null;
        visited.count++;
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const cs = el.classList ? Array.from(el.classList).slice(0, 6) : [];
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const visible = rect ? (rect.width > 0 && rect.height > 0) : false;
        const out = {
          tag: (el.tagName || '').toLowerCase(),
          id: el.id || undefined,
          classes: cs.length ? cs : undefined,
          text: text || undefined,
          visible,
          childCount: el.children?.length || 0,
        };
        if (el.getAttribute) {
          const ph = el.getAttribute('placeholder');
          const aria = el.getAttribute('aria-label');
          const role = el.getAttribute('role');
          if (ph) out.placeholder = ph;
          if (aria) out.ariaLabel = aria;
          if (role) out.role = role;
        }
        if (d > 0 && el.children?.length) {
          out.children = [];
          for (const c of el.children) {
            const ci = nodeInfo(c, d - 1);
            if (!ci) break;
            out.children.push(ci);
          }
        }
        return out;
      }
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyOutline: nodeInfo(document.body, depth),
        truncated: visited.count >= maxNodes,
      };
    }, { depth, maxNodes });
    let cookies = [];
    try {
      const ctx = p.context?.();
      if (ctx) cookies = await ctx.cookies();
    } catch {}
    res.json({ runId: req.params.runId, ...data, cookies: cookies.map(c => ({ name: c.name, domain: c.domain })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: query the live page for elements matching a selector.
//   POST /api/running/<runId>/query-dom { selector, kind?, limit? }
// kind = 'css'|'xpath'|'placeholder'|'role'. Returns up to `limit` matches
// (default 10, max 50) with tag/id/classes/text/box/visible/attrs.
app.post('/api/running/:runId/query-dom', async (req, res) => {
  const run = runningMacros.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const p = getActivePage();
  if (!p) return res.status(409).json({ error: 'No active page' });
  const { selector, kind = 'css' } = req.body || {};
  const limit = Math.min(parseInt(req.body?.limit ?? 10, 10) || 10, 50);
  if (!selector || typeof selector !== 'string') return res.status(400).json({ error: 'selector required' });
  try {
    let loc;
    if (kind === 'xpath') loc = p.locator('xpath=' + selector);
    else if (kind === 'placeholder') loc = p.getByPlaceholder(selector);
    else if (kind === 'role') loc = p.getByRole(selector);
    else loc = p.locator(selector);
    const total = await loc.count();
    const take = Math.min(total, limit);
    const matches = [];
    for (let i = 0; i < take; i++) {
      const handle = loc.nth(i);
      try {
        const info = await handle.evaluate(el => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const cs = el.classList ? Array.from(el.classList).slice(0, 8) : [];
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          return {
            tag: (el.tagName || '').toLowerCase(),
            id: el.id || undefined,
            classes: cs.length ? cs : undefined,
            text: text || undefined,
            placeholder: el.getAttribute ? el.getAttribute('placeholder') || undefined : undefined,
            ariaLabel: el.getAttribute ? el.getAttribute('aria-label') || undefined : undefined,
            role: el.getAttribute ? el.getAttribute('role') || undefined : undefined,
            type: el.getAttribute ? el.getAttribute('type') || undefined : undefined,
            visible: rect ? rect.width > 0 && rect.height > 0 : false,
            box: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
          };
        });
        matches.push(info);
      } catch (e) {
        matches.push({ error: e.message });
      }
    }
    res.json({ runId: req.params.runId, selector, kind, total, matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: surgical patch of a single step inside a macro.
//   PATCH /api/macros/<id>/steps/<stepPath> { patch: {...} }
// stepPath is dot-delimited (e.g. "3" or "2.children.0"). The patch object is
// shallow-merged into the target step. Returns the updated step.
app.patch('/api/macros/:id/steps/:stepPath', (req, res) => {
  const filePath = macroPath(req.params.id);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Macro not found' });
  const patch = req.body?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'patch must be an object' });
  }
  let macro;
  try { macro = JSON.parse(readFileSync(filePath, 'utf-8')); } catch (e) {
    return res.status(500).json({ error: 'Failed to read macro: ' + e.message });
  }
  const target = walkStepPath(macro.steps, req.params.stepPath);
  if (!target) return res.status(404).json({ error: 'Step path not found' });
  Object.assign(target, patch);
  macro.updatedAt = new Date().toISOString();
  try { writeFileSync(filePath, JSON.stringify(macro, null, 2)); } catch (e) {
    return res.status(500).json({ error: 'Failed to save macro: ' + e.message });
  }
  res.json({ ok: true, step: target, stepPath: req.params.stepPath });
});

function walkStepPath(steps, path) {
  if (!Array.isArray(steps) || !path) return null;
  const parts = String(path).split('.');
  let cur = steps;
  let target = null;
  while (parts.length) {
    const p = parts.shift();
    const idx = Number(p);
    if (Number.isInteger(idx)) {
      if (!Array.isArray(cur)) return null;
      target = cur[idx];
      if (!target) return null;
      // Default descent through known child arrays for control-flow blocks.
      if (parts.length) {
        const nextKey = parts[0];
        if (nextKey === 'children' || nextKey === 'finallyChildren' || nextKey === 'elseChildren') {
          parts.shift();
          cur = target[nextKey];
        } else {
          // numeric → look in `children` by default
          cur = target.children;
        }
      }
    } else {
      // Named (e.g. "children") — set cur and keep going
      if (!target) return null;
      cur = target[p];
    }
  }
  return target;
}

// API: close active Playwright browser (useful when UI got stuck)
app.post('/api/browser/close', async (req, res) => {
  try {
    await closeBrowser();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Debug state ---
const runningDebugProcesses = new Map(); // macroId -> { process, sendCommand }

function broadcastDebug(macroId, data) {
  const msg = JSON.stringify({ macroId, type: 'debug', ...data });
  for (const client of extensionClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// --- Playwright execution ---
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

app.post('/api/macros/:id/run', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { profileName = null, debug = false, breakpoints = [] } = req.body || {};

  if (debug) {
    // Debug mode: spawn player.js as child process with debug protocol
    const playerPath = join(__dirname, 'player.js');
    const args = [playerPath, m.id];
    args.push('--debug');
    if (breakpoints.length > 0) args.push('--breakpoints', breakpoints.join(','));
    // AC1: Include profile in debug mode
    if (profileName) args.push('--profile', profileName);

    // Kill existing debug process for this macro
    if (runningDebugProcesses.has(m.id)) {
      try { runningDebugProcesses.get(m.id).process.kill(); } catch (e) {}
      runningDebugProcesses.delete(m.id);
    }

    const child = spawn('node', args, {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    const debugRun = {
      process: child,
      sendCommand: (cmd) => {
        if (child && !child.killed) {
          child.stdin.write(JSON.stringify(cmd) + '\n');
        }
      }
    };
    runningDebugProcesses.set(m.id, debugRun);

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        if (line.startsWith('__DEBUG__:')) {
          try {
            const debugData = JSON.parse(line.slice(10));
            broadcastDebug(m.id, debugData);
          } catch (e) {}
          return;
        }
        broadcast({ type: 'step-executing', path: '', step: { action: 'debug-log' }, message: line });
      });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) broadcast({ type: 'step-completed', path: '', success: false, error: text });
    });

    child.on('close', (code) => {
      // Only clean up and broadcast 'finished' if this child is still the current debug process.
      // When debug is restarted, the old child's close event must NOT remove the new process or
      // broadcast 'finished' (which would kill the new debug session's UI).
      if (runningDebugProcesses.get(m.id)?.process === child) {
        runningDebugProcesses.delete(m.id);
        broadcastDebug(m.id, { action: 'finished' });
      }
    });

    child.on('error', (err) => {
      if (runningDebugProcesses.get(m.id)?.process === child) {
        runningDebugProcesses.delete(m.id);
        broadcastDebug(m.id, { action: 'finished' });
      }
    });

    return res.json({ ok: true, debug: true, macroId: m.id });
  }

  // Normal (non-debug) execution
  const runId = generateRunId();
  trackRun(runId, m.id, m.name, 'normal');

  // Hard timeout at server level (belt & suspenders)
  const run = runningMacros.get(runId);
  run.hardTimeoutMs = RUN_HARD_TIMEOUT_MS;
  const hardTimer = setTimeout(() => {
    abortRun(runId, { reason: `hard-timeout-${RUN_HARD_TIMEOUT_MS}ms`, timeout: true }).catch(() => {});
  }, RUN_HARD_TIMEOUT_MS);
  run.hardTimeoutAt = new Date(Date.now() + RUN_HARD_TIMEOUT_MS).toISOString();

  // Per-run aborter (for /api/running/:runId/stop)
  runningAborters.set(runId, async ({ reason }) => {
    await stopCurrentRun(reason || 'manual-stop');
  });

  try {
    const result = await runMacro(m, wss, profileName, { timeoutMs: RUN_HARD_TIMEOUT_MS });
    clearTimeout(hardTimer);
    completeRun(runId, true);
    res.json({ ok: true, result, runId });
  } catch (e) {
    clearTimeout(hardTimer);
    // If player hard-timeout fired, treat as timeout
    if ((e?.name === 'HardTimeoutError') || String(e?.message || '').toLowerCase().includes('hard timeout')) {
      const r = runningMacros.get(runId);
      if (r) r.status = 'timeout';
      completeRun(runId, false, e.message);
      return res.status(504).json({ ok: false, error: e.message, runId, timeout: true });
    }
    completeRun(runId, false, e.message);
    res.status(500).json({ error: e.message, runId });
  }
});

app.post('/api/macros/:id/steps/:idx/run', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= m.steps.length) return res.status(400).json({ error: 'Invalid step index' });
  const { profileName = null } = req.body || {};
  try {
    const result = await runStep(m.steps[idx], wss, profileName);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/macros/:id/run-to/:idx', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const idx = parseInt(req.params.idx);
  const { profileName = null } = req.body || {};
  try {
    const result = await runUpTo(m, idx, wss, profileName);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Process bots.csv ---
// POST /api/bots/process?limit=50&macroId=tg4-adv-bots-001&csvPath=...&profileName=tg
app.post('/api/bots/process', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || req.body?.limit || '50', 10);
    const macroId = String(req.query.macroId || req.body?.macroId || 'tg4-adv-bots-001');
    const csvPath = req.query.csvPath || req.body?.csvPath || undefined;
    const profileName = req.query.profileName || req.body?.profileName || null;
    const startOffset = parseInt(req.query.startOffset || req.body?.startOffset || '0', 10) || 0;

    const result = await processBotsCsv({ limit, macroId, csvPath, profileName, startOffset });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Loop execution ---
app.post('/api/macros/:id/run-loop', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { times = 1, tableName = '', delayMin = 3, delayMax = 10, profileName = null, fingerprintPerIteration = false, fingerprintSafeMode = true } = req.body || {};
  const runId = generateRunId();
  trackRun(runId, m.id, m.name, 'loop');
  try {
    const result = await runMacroLoop(m, wss, { times, tableName, delayMin, delayMax, profileName, fingerprintPerIteration, fingerprintSafeMode });
    completeRun(runId, true);
    res.json({ ok: true, result, runId });
  } catch (e) {
    completeRun(runId, false, e.message);
    res.status(500).json({ error: e.message, runId });
  }
});

// --- Parallel execution (Task 2: multi-window) ---
app.post('/api/macros/:id/run-parallel', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { windowCount = 2, tableName = '', delayMin = 3, delayMax = 10, profileName = null, fingerprintPerIteration = false, fingerprintSafeMode = true } = req.body || {};
  if (!tableName) return res.status(400).json({ error: 'tableName обязательна для параллельного запуска' });
  
  const runId = generateRunId();
  trackRun(runId, m.id, m.name, 'parallel');
  
  // Return immediately, run asynchronously
  res.json({ ok: true, runId, message: `Параллельный запуск: ${windowCount} окон` });
  
  try {
    await runMacroParallel(m, wss, { windowCount, tableName, delayMin, delayMax, profileName, fingerprintPerIteration, fingerprintSafeMode });
    completeRun(runId, true);
  } catch (e) {
    completeRun(runId, false, e.message);
  }
});

// --- Browser Profiles ---  (AC12: paths now use data/profiles/)
app.get('/api/profiles', (req, res) => {
  const settings = loadSettings();
  res.json(settings.browserProfiles || {});
});

app.post('/api/profiles', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Profile name required' });
  }
  const settings = loadSettings();
  if (!settings.browserProfiles) settings.browserProfiles = {};
  
  // AC12: profiles now under data/profiles/
  const profilePath = join(DATA_ROOT, 'profiles', name);
  mkdirSync(profilePath, { recursive: true });
  
  settings.browserProfiles[name] = {
    path: profilePath,
    lastUsed: new Date().toISOString()
  };
  saveSettings(settings);
  res.json({ ok: true, profile: settings.browserProfiles[name] });
});

app.delete('/api/profiles/:name', (req, res) => {
  const { name } = req.params;
  const settings = loadSettings();
  if (settings.browserProfiles && settings.browserProfiles[name]) {
    const profilePath = settings.browserProfiles[name].path;
    if (existsSync(profilePath)) {
      rmSync(profilePath, { recursive: true, force: true });
    }
    delete settings.browserProfiles[name];
    saveSettings(settings);
  }
  res.json({ ok: true });
});

app.post('/api/profiles/:name/launch', async (req, res) => {
  const { name } = req.params;
  const settings = loadSettings();
  const profile = settings.browserProfiles?.[name];
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  
  try {
    const { launchProfile } = await import('./player.js');
    await launchProfile(name);
    
    profile.lastUsed = new Date().toISOString();
    saveSettings(settings);
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Append recording ---
app.post('/api/macros/:id/append-record/:fromStep', async (req, res) => {
  const m = loadMacro(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const fromStep = parseInt(req.params.fromStep);
  const { profileName = null } = req.body || {};
  
  try {
    const { startAppendRecording } = await import('./player.js');
    await startAppendRecording(m, fromStep, wss, profileName);
    res.json({ ok: true, message: 'Append recording started' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Python execution ---
app.post('/api/python/exec', async (req, res) => {
  const { code, variables = {} } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const runId = randomUUID().slice(0, 8);
  const tmpDir = join(DATA_ROOT, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const varsInFile = join(tmpDir, `vars_in_${runId}.json`);
  const varsOutFile = join(tmpDir, `vars_out_${runId}.json`);
  const scriptFile = join(tmpDir, `script_${runId}.py`);

  writeFileSync(varsInFile, JSON.stringify(variables));

  const wrapper = `
import json, sys, os
with open(${JSON.stringify(varsInFile)}, 'r', encoding='utf-8') as f:
    _macro_vars = json.load(f)
_original_keys = set(_macro_vars.keys())
for _k, _v in _macro_vars.items():
    globals()[_k] = _v

${code}

_out = {}
for _k in set(list(_original_keys) + [k for k in dir() if not k.startswith('_') and k not in ('json', 'sys', 'os', 'f')]):
    try:
        _val = globals().get(_k)
        if _val is not None and not callable(_val) and not isinstance(_val, type) and _k not in ('json', 'sys', 'os'):
            json.dumps(_val)
            _out[_k] = _val
    except (TypeError, ValueError):
        pass
with open(${JSON.stringify(varsOutFile)}, 'w', encoding='utf-8') as f:
    json.dump(_out, f, ensure_ascii=False)
`;

  writeFileSync(scriptFile, wrapper);

  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const proc = spawn('python3', [scriptFile], {
        timeout: 30000, cwd: tmpDir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        let outVars = {};
        try { if (existsSync(varsOutFile)) outVars = JSON.parse(readFileSync(varsOutFile, 'utf-8')); } catch (e) {}
        try { unlinkSync(varsInFile); } catch (e) {}
        try { unlinkSync(varsOutFile); } catch (e) {}
        try { unlinkSync(scriptFile); } catch (e) {}
        if (code !== 0) resolve({ ok: false, error: stderr.trim().split('\n').pop(), output: stdout, variables: outVars });
        else resolve({ ok: true, output: stdout, variables: outVars });
      });
      proc.on('error', err => {
        try { unlinkSync(varsInFile); } catch (e) {}
        try { unlinkSync(varsOutFile); } catch (e) {}
        try { unlinkSync(scriptFile); } catch (e) {}
        reject(err);
      });
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  extensionClients.add(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      console.log('📩 WS message:', msg.type);

      // Forward debug commands to running debug processes
      if (msg.type === 'debug' && msg.command) {
        for (const [macroId, run] of runningDebugProcesses) {
          run.sendCommand({ command: msg.command });
        }
        return;
      }

      if (msg.type === 'step-recorded' || msg.type === 'recording-status') {
        for (const client of extensionClients) {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(msg));
          }
        }
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  ws.on('close', () => {
    extensionClients.delete(ws);
    console.log('🔌 WebSocket client disconnected');
  });
});

export function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of extensionClients) {
    if (client.readyState === 1) client.send(data);
  }
}

const PORT = Number(process.env.PORT || 3700);
// Bind explicitly to IPv4 loopback to avoid cases where the server listens only on ::1 and
// tools that hit 127.0.0.1 fail. Override via HOST env if needed.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`🚀 Macro Recorder Server: http://${HOST}:${PORT}`);
  console.log(`📁 Data directory: ${DATA_ROOT}`);

  // Boot-time snapshot GC. Default ON — runtime snapshots accumulate fast and
  // the user almost never wants the old ones. Disable with SNAPSHOT_GC_ON_BOOT=0.
  const gcOnBoot = process.env.SNAPSHOT_GC_ON_BOOT;
  if (gcOnBoot === undefined || gcOnBoot === '1' || gcOnBoot === 'true') {
    try {
      const summary = runSnapshotGc({
        snapshotsDir: SNAPSHOTS_DIR,
        apply: true,
        runtimeMaxAgeDays: parseFloat(process.env.RUNTIME_SNAPSHOT_MAX_AGE_DAYS || '7'),
        editorMaxAgeDays: parseFloat(process.env.EDITOR_SNAPSHOT_MAX_AGE_DAYS || '30'),
        keepPerDir: parseInt(process.env.SNAPSHOT_KEEP_PER_DIR || '200'),
      });
      if (summary.totalDeleted > 0) {
        const mb = (summary.totalBytesFreed / 1024 / 1024).toFixed(1);
        console.log(`🧹 Snapshot GC freed ~${mb} MB (${summary.totalDeleted} files)`);
      }
    } catch (e) {
      console.warn('⚠ Snapshot GC at boot failed:', e.message);
    }
  }
});
