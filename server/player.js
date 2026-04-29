import { chromium } from 'playwright';
import { loadSettings, saveSettings, loadPersistentVars, savePersistentVars } from './settings.js';
import { getNumber as smsGetNumber, waitForCode as smsWaitForCode, releaseNumber as smsReleaseNumber } from './sms-api.js';
import { solveCaptcha as captchaSolve, autoDetectCaptcha } from './captcha-solver.js';
import { saveAccount as dbSaveAccount, addInProgress, isIPBlocked, isPhoneFailed, addBlockedIP, trackResult, checkSuccessRate, shouldBlockProxy } from './accounts-db.js';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { createHardTimeout, HardTimeoutError } from './timeout.js';
import { collectRunDiagnostics, forceClosePlaywright } from './diagnostics.js';

// --- External stop (from server/index.js) ---
export async function stopCurrentRun(reason = 'stop-requested') {
  const lastStep = {
    path: lastStepPath,
    action: lastStepAction,
    at: lastStepAt ? new Date(lastStepAt).toISOString() : null
  };

  stopRequested = true;

  try {
    const diag = await collectRunDiagnostics({
      page: page,
      context: context,
      browser: browser,
      reason,
      label: 'macro',
      runId: `manual-${Date.now()}`,
      lastStep
    });
    console.log('🧯 STOP DIAGNOSTICS:', JSON.stringify(diag));
  } catch (e) {
    console.log('🧯 STOP DIAGNOSTICS failed:', e?.message || String(e));
  }

  await forceClosePlaywright({ page, context, browser });
  browser = null; context = null; page = null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// AC12: Use data/.tmp for temp files
const DATA_ROOT = join(__dirname, '..', 'data');
const TEMP_DIR = join(DATA_ROOT, '.tmp');
const PYTHON_DIR = join(DATA_ROOT, 'python');
const RUNTIME_SNAPSHOTS_DIR = join(DATA_ROOT, 'snapshots', 'runtime');
import { mkdirSync } from 'fs';
mkdirSync(TEMP_DIR, { recursive: true });
mkdirSync(RUNTIME_SNAPSHOTS_DIR, { recursive: true });

let browser = null;
let context = null;
let page = null;
let runtimeVars = {};
let stopRequested = false;
let currentMacroId = null;

// --- Execution diagnostics (best-effort) ---
let lastStepPath = null;
let lastStepAction = null;
let lastStepAt = null;

async function autoDismissTelegramOverlays(p) {
  try {
    const url = await p.url();
    if (!/web\.telegram\.org/i.test(url)) return;

    // ВАЖНО: НЕ кликаем общий OK/ОК/ПОНЯТНО — слишком рискованно (может совпасть с элементами UI/чата).
    // Снимаем только явные подтверждения сессии.
    const candidates = [
      /YES,? IT'S ME/i,
      /ДА,? ЭТО Я/i
    ];

    for (const re of candidates) {
      const btn = p.getByRole('button', { name: re }).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        const settings = loadSettings();
        let box = null;
        try { box = await btn.boundingBox(); } catch (e) {}
        try {
          if (settings?.debug?.clickShots && box) {
            const shot = await debugHighlightAndShot(p, box, `dismiss ${String(re)}`);
            if (shot) console.log('🟥 click-shot', JSON.stringify({ path: 'overlay-dismiss', method: 'dismiss', selector: String(re), screenshot: shot }));
          }
        } catch (e) {}
        console.log(`🧹 Telegram overlay detected, clicking: ${re} box=${box ? JSON.stringify(box) : 'null'}`);
        await btn.click({ timeout: 5000 }).catch(() => {});
        await p.waitForTimeout(300);
      }
    }

    // Sometimes it is rendered as clickable div with text
    const dangerText = /Someone just got access to your messages/i;
    const banner = p.getByText(dangerText).first();
    if (await banner.isVisible({ timeout: 200 }).catch(() => false)) {
      console.log('🧹 Telegram security banner is visible (may block UI)');
    }
  } catch (e) {}
}

function attachPageDebugHandlers(p, execContext = null) {
  if (!p) return;
  // Avoid attaching multiple times
  if (p.__ocDebugAttached) return;
  p.__ocDebugAttached = true;

  // --- Telegram Web auto-recovery ---
  // Goal: recover from transient network change (net::ERR_NETWORK_CHANGED) and known fatal Telegram Web errors
  // without triggering any macro actions. Recovery is limited to: wait(backoff) + reload/goto.
  // If the same fatal pattern repeats N times подряд — recreate Playwright context (restartExecContext/ensureBrowser)
  // and optionally clear Telegram site data (profile only).
  const RECOVERY = {
    enabled: true,
    backoffMinMs: 3000,
    backoffMaxMs: 5000,
    maxSoftRecoveries: 2,   // reload/goto
    maxHardRecoveries: 1,   // context restart
    // for net errors we prefer soft recoveries only
  };

  // Per-page state (kept on the page object)
  p.__ocRecovery = p.__ocRecovery || {
    inProgress: false,
    softStreak: 0,
    hardStreak: 0,
    lastReason: null,
    lastAt: 0
  };

  const isTelegramUrl = (u) => {
    try { return /web\.telegram\.org/i.test(String(u || '')); } catch (e) { return false; }
  };

  const shouldAttemptRecovery = () => {
    // IMPORTANT: do not interfere while stopped/closing
    if (stopRequested) return false;
    return !!RECOVERY.enabled;
  };

  const jitterBackoff = async () => {
    const ms = RECOVERY.backoffMinMs + Math.floor(Math.random() * (RECOVERY.backoffMaxMs - RECOVERY.backoffMinMs + 1));
    try { await p.waitForTimeout(ms); } catch (e) {}
    return ms;
  };

  const attemptTelegramRecovery = async ({ reason, fatal = false, preferGoto = false } = {}) => {
    if (!shouldAttemptRecovery()) return;

    const st = p.__ocRecovery;
    const now = Date.now();
    // Debounce repeated signals (console may spam)
    if (st.inProgress) return;
    if (now - (st.lastAt || 0) < 750) return;

    const currentUrl = await p.url().catch(() => null);
    if (!isTelegramUrl(currentUrl)) return;

    st.inProgress = true;
    st.lastReason = reason || 'unknown';
    st.lastAt = now;

    try {
      const backoff = await jitterBackoff();
      console.log(`🛠️ [tg-recovery] backoff=${backoff}ms reason=${st.lastReason} fatal=${fatal} url=${currentUrl}`);

      // Soft recovery: reload or goto current url (or Telegram root)
      if (!fatal) {
        st.softStreak += 1;
        if (st.softStreak <= RECOVERY.maxSoftRecoveries) {
          const target = preferGoto ? (currentUrl || 'https://web.telegram.org/a/') : null;
          if (target) {
            await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
          } else {
            await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
          }
          console.log(`✅ [tg-recovery] soft-ok streak=${st.softStreak}/${RECOVERY.maxSoftRecoveries}`);
          return;
        }
      }

      // Hard recovery (fatal or exceeded soft)
      st.hardStreak += 1;
      st.softStreak = 0;

      if (st.hardStreak > RECOVERY.maxHardRecoveries) {
        console.log(`⛔ [tg-recovery] hard-limit reached, giving up. lastReason=${st.lastReason}`);
        return;
      }

      const effectiveProfile = execContext?.vars?._current_profile || runtimeVars?._current_profile || null;
      console.log(`🔁 [tg-recovery] HARD restart context (hard=${st.hardStreak}/${RECOVERY.maxHardRecoveries}) profile=${effectiveProfile || 'none'}`);

      // Best-effort clear site data only when we have a profile (persistent context)
      try {
        if (effectiveProfile) {
          console.log(`🧽 [tg-recovery] clearing Telegram site data for profile=${effectiveProfile}`);
          clearTelegramWebSiteData(effectiveProfile);
        }
      } catch (e) {
        console.log(`⚠️ [tg-recovery] clearTelegramWebSiteData failed: ${e?.message || String(e)}`);
      }

      try {
        if (execContext && (execContext.page || execContext.context || execContext.browser)) {
          // preserve current url if possible, otherwise go to Telegram
          const gotoUrl = currentUrl || execContext?.vars?._macro_start_url || 'https://web.telegram.org/a/';
          await restartExecContext(execContext, {
            profileName: effectiveProfile,
            proxy: execContext?.vars?._current_proxy,
            gotoUrl,
            timeoutMs: 120000
          }).catch(() => {});
          execContext.page = execContext.page || p;
          attachPageDebugHandlers(execContext.page, execContext);
          console.log(`✅ [tg-recovery] hard-ok via restartExecContext goto=${gotoUrl}`);
        } else {
          // Fallback: global ensureBrowser
          const np = await ensureBrowser(effectiveProfile);
          attachPageDebugHandlers(np, execContext);
          try {
            const gotoUrl = currentUrl || 'https://web.telegram.org/a/';
            await np.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
          } catch (e) {}
          console.log(`✅ [tg-recovery] hard-ok via ensureBrowser`);
        }
      } catch (e) {
        console.log(`❌ [tg-recovery] hard failed: ${e?.message || String(e)}`);
      }
    } finally {
      st.inProgress = false;
    }
  };

  p.on('console', (msg) => {
    try {
      const text = msg.text();
      console.log(`🌐 [page console:${msg.type()}] ${text}`);

      // Detect specific Telegram Web fatal errors / network changed.
      // Note: keep patterns tight to avoid false positives.
      const t = String(text || '');
      if (t.includes('net::ERR_NETWORK_CHANGED')) {
        // Network interface changed: soft recovery is usually enough.
        attemptTelegramRecovery({ reason: 'net::ERR_NETWORK_CHANGED', fatal: false, preferGoto: true });
      }
      if (t.includes('NotReadableError') && t.includes('Data lost due to missing file')) {
        attemptTelegramRecovery({ reason: 'NotReadableError Data lost due to missing file', fatal: true, preferGoto: true });
      }
      if (t.includes('TypeError') && t.includes('Cannot convert undefined or null to object')) {
        attemptTelegramRecovery({ reason: 'TypeError Cannot convert undefined or null to object', fatal: true, preferGoto: true });
      }
    } catch (e) {}
  });

  p.on('pageerror', (err) => {
    const msg = String(err?.message || err);
    console.log(`💥 [pageerror] ${msg}`);
    try {
      if (msg.includes('NotReadableError') && msg.includes('Data lost due to missing file')) {
        attemptTelegramRecovery({ reason: 'pageerror NotReadableError Data lost due to missing file', fatal: true, preferGoto: true });
      }
      if (msg.includes('Cannot convert undefined or null to object')) {
        attemptTelegramRecovery({ reason: 'pageerror TypeError Cannot convert undefined or null to object', fatal: true, preferGoto: true });
      }
    } catch (e) {}
  });

  p.on('requestfailed', (req) => {
    try {
      const errText = req.failure()?.errorText || '';
      console.log(`🧱 [requestfailed] ${req.method()} ${req.url()} :: ${errText}`);
      if (String(errText).includes('net::ERR_NETWORK_CHANGED')) {
        attemptTelegramRecovery({ reason: 'requestfailed net::ERR_NETWORK_CHANGED', fatal: false, preferGoto: true });
      }
    } catch (e) {}
  });

  // Логирование навигаций для диагностики переходов в /#peer
  p.on('framenavigated', async (frame) => {
    try {
      if (frame === p.mainFrame()) {
        const url = frame.url();
        console.log(`🧭 [framenavigated] ${url}`);
        
        // Если перешли в /#<peer> — логируем как подозрительную навигацию.
        // Авто-dump (скрин) по умолчанию ВЫКЛЮЧЕН, потому что заспамливает диск.
        // Включается через settings.json: { "debug": { "autoDumpPeerNav": true } }
        if (url.includes('web.telegram.org') && /#\d+/.test(url)) {
          console.log(`⚠️ [UNEXPECTED NAVIGATION] Detected peer navigation: ${url}`);

          const s = loadSettings?.() || {};
          const enabled = !!(s.debug && s.debug.autoDumpPeerNav);
          if (enabled) {
            try {
              const fileBase = `auto-dump-peer-${Date.now()}-${randomUUID().slice(0, 6)}`;
              const pngPath = join(TEMP_DIR, fileBase + '.png');
              await p.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
              console.log(`📸 Auto-dump saved: ${pngPath}`);
            } catch (e) {
              console.log(`❌ Auto-dump failed: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {}
  });
}

// ==================== Debug Protocol ====================
const isDirectDebug = process.argv.includes('--debug');
const bpArgIdx = process.argv.indexOf('--breakpoints');
const directBreakpoints = bpArgIdx !== -1 && process.argv[bpArgIdx + 1]
  ? new Set(process.argv[bpArgIdx + 1].split(','))
  : new Set();

let debugResolve = null;
let debugCommand = null;
let debugDepth = 0;
let debugStepOutTarget = -1;

function sendDebug(data) {
  if (isDirectDebug) {
    console.log('__DEBUG__:' + JSON.stringify(data));
  }
}

if (isDirectDebug) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.command) {
        debugCommand = msg.command;
        if (debugResolve) {
          const r = debugResolve;
          debugResolve = null;
          r();
        }
      }
    } catch (e) {}
  });
}

async function debugPause(stepPath, depth) {
  if (!isDirectDebug) return;

  const shouldPause =
    debugCommand === 'step-over' ||
    debugCommand === 'step-into' ||
    debugCommand === null ||
    directBreakpoints.has(stepPath);

  if (debugCommand === 'step-out') {
    if (depth <= debugStepOutTarget) {
      // We're back at target, pause
    } else {
      return;
    }
  }

  if (debugCommand === 'step-over' && depth > debugDepth) {
    return;
  }

  if (debugCommand === 'continue' && !directBreakpoints.has(stepPath)) {
    return;
  }

  debugDepth = depth;
  debugCommand = null;

  sendDebug({
    action: 'paused',
    stepId: stepPath,
    variables: { ...runtimeVars },
    depth
  });

  await new Promise(resolve => {
    debugResolve = resolve;
  });

  if (debugCommand === 'stop') {
    sendDebug({ action: 'finished' });
    process.exit(0);
  }

  if (debugCommand === 'step-out') {
    debugStepOutTarget = depth - 1;
  }
}

// Custom error classes for break/continue
class BreakError extends Error { constructor() { super('__BREAK__'); this.name = 'BreakError'; } }
class ContinueError extends Error { constructor() { super('__CONTINUE__'); this.name = 'ContinueError'; } }

// Fail-fast when Playwright page/context is gone (e.g., hard-timeout forceClosePlaywright)
function ensureLivePage(p, execContext = null) {
  const ep = execContext?.page;
  const pageToCheck = p || ep;
  const isClosed = (pg) => {
    try { return !!pg?.isClosed?.(); } catch (e) { return true; }
  };

  if (!pageToCheck || isClosed(pageToCheck) || (execContext && (!execContext.page || isClosed(execContext.page)))) {
    const err = new Error('PAGE_CLOSED');
    err.name = 'PageClosedError';
    err.code = 'PAGE_CLOSED';
    throw err;
  }

  return pageToCheck;
}

async function ensureBrowser(profileName = null) {
  try {
    if (browser && browser.isConnected() && page) {
      try {
        await page.title();
        return page;
      } catch (e) {
        console.log(`⚠️ Page lost, recreating...`);
      }
    }
  } catch (e) {}

  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; context = null; page = null;

  const settings = loadSettings();
  const HEADLESS_ENV = String(process.env.PLAYWRIGHT_HEADLESS || '').trim() === '1';
  const HEADLESS = (settings?.browser?.headless === true) || HEADLESS_ENV;

  if (profileName) {
    const profile = settings.browserProfiles?.[profileName];
    // AC12: profiles under data/profiles/
    const baseUserDataDir = profile?.path || join(DATA_ROOT, 'profiles', profileName);
    mkdirSync(baseUserDataDir, { recursive: true });

    // On Windows, persistent profiles can get locked (Chrome already running / crash leftovers),
    // causing: "Target page, context or browser has been closed".
    // Strategy: try base profile, and on that specific failure, retry with a temporary copy.
    const tryLaunchPersistent = async (userDataDir) => {
      return await chromium.launchPersistentContext(userDataDir, {
        headless: HEADLESS,
        viewport: { width: 1280, height: 800 },
        // Make UI less intrusive when not headless (best-effort: reduce focus-steal/popups)
        args: HEADLESS ? [] : [
          '--disable-backgrounding-occluded-windows',
          '--start-minimized',
          '--disable-notifications',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });
    };

    let ctx = null;
    try {
      ctx = await tryLaunchPersistent(baseUserDataDir);
    } catch (e) {
      const msg = String(e?.message || e);
      const looksLikeProfileLock = msg.includes('Target page, context or browser has been closed');
      if (!looksLikeProfileLock) throw e;

      // Fallback: temp copy
      const tmpRoot = join(DATA_ROOT, 'profiles', '.tmp');
      mkdirSync(tmpRoot, { recursive: true });
      const tmpDir = join(tmpRoot, `${profileName}-${Date.now()}-${randomUUID().slice(0, 6)}`);
      try { cpSync(baseUserDataDir, tmpDir, { recursive: true, force: true }); } catch (copyErr) {
        // If copy fails, still try empty temp dir
        mkdirSync(tmpDir, { recursive: true });
      }
      ctx = await tryLaunchPersistent(tmpDir);
    }

    browser = ctx;
    page = browser.pages()[0] || await browser.newPage();
    browser.on('disconnected', () => { browser = null; context = null; page = null; });
    page.on('close', () => { page = null; });
    attachPageDebugHandlers(page, null);
  } else {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: HEADLESS ? [] : [
        '--disable-backgrounding-occluded-windows',
        '--start-minimized',
        '--disable-notifications',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    browser.on('disconnected', () => { browser = null; context = null; page = null; });

    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('close', () => { page = null; });
    attachPageDebugHandlers(page, null);
  }

  return page;
}

// ==================== Browser Init / Profile+Proxy Switching ====================
let pendingBrowserInit = null; // { token, scope, profileName, proxy, proxyUsername, proxyPassword, gotoUrl, timeoutMs, targets:Set }
let pendingBrowserInitAcks = new Set();
let activeExecIds = new Set();

function normalizeProxyServer(proxy) {
  if (!proxy) return null;
  let p = String(proxy).trim();
  if (!p) return null;
  // allow ip:port
  // IMPORTANT: Playwright proxy expects a scheme. For our use-case the default is SOCKS5.
  // If you want HTTP proxy, pass it explicitly as http://host:port
  if (!p.includes('://')) p = 'socks5://' + p;
  return p;
}

function parseProxy(proxy, username = null, password = null) {
  if (!proxy) return null;
  let p = String(proxy).trim();
  if (!p) return null;

  // If separate creds provided, prefer them
  const server = normalizeProxyServer(p.includes('@') ? p.split('@').pop() : p);

  if (username && password) {
    return { server, username: String(username), password: String(password) };
  }

  // Parse inline creds: user:pass@host:port
  if (p.includes('@')) {
    const left = p.split('@')[0];
    const right = p.split('@').slice(1).join('@');
    const server2 = normalizeProxyServer(right);
    const creds = left.replace(/^https?:\/\//, '');
    const [u, ...rest] = creds.split(':');
    const pass = rest.join(':');
    if (u && pass) return { server: server2, username: u, password: pass };
    return { server: server2 };
  }

  return { server };
}

async function safeCloseExecContext(execContext) {
  if (!execContext) return;
  try { await execContext.page?.close?.(); } catch (e) {}
  try { await execContext.context?.close?.(); } catch (e) {}
  // In persistent mode, execContext.browser is actually a BrowserContext (has close)
  try { await execContext.browser?.close?.(); } catch (e) {}
}

function resolveProfilePath(profileName) {
  const settings = loadSettings();
  const profile = settings.browserProfiles?.[profileName];
  return profile?.path || join(DATA_ROOT, 'profiles', profileName);
}

function clearTelegramWebSiteData(profileName) {
  // Telegram Web white-screen issues are often resolved by clearing site data (similar to private mode).
  // For automation profiles, we can safely delete Chromium caches/ServiceWorker stores.
  if (!profileName) return;
  const userDataDir = resolveProfilePath(String(profileName));

  const candidates = [
    // Most common layout
    join(userDataDir, 'Default'),
    // Some Chromium builds may store directly under userDataDir
    userDataDir,
  ];

  const toDeleteNames = [
    'Service Worker',
    'Cache',
    'Code Cache',
    'GPUCache',
    'CacheStorage',
    'IndexedDB',
    'Local Storage',
    'Session Storage'
  ];

  for (const base of candidates) {
    for (const name of toDeleteNames) {
      const p = join(base, name);
      try { rmSync(p, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

async function launchPersistentWithRetry({ baseUserDataDir, profileNameForTmp = 'profile', proxyObj = null, headless = false }) {
  const tryLaunch = async (dir) => {
    return await chromium.launchPersistentContext(dir, {
      headless,
      viewport: { width: 1280, height: 800 },
      ...(proxyObj ? { proxy: proxyObj } : {}),
      args: headless ? [] : ['--disable-backgrounding-occluded-windows']
    });
  };

  try {
    return await tryLaunch(baseUserDataDir);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!msg.includes('Target page, context or browser has been closed')) throw e;

    const tmpRoot = join(DATA_ROOT, 'profiles', '.tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = join(tmpRoot, `${profileNameForTmp}-${Date.now()}-${randomUUID().slice(0, 6)}`);
    try { cpSync(baseUserDataDir, tmpDir, { recursive: true, force: true }); } catch (copyErr) {
      mkdirSync(tmpDir, { recursive: true });
    }
    return await tryLaunch(tmpDir);
  }
}

async function restartExecContext(execContext, { profileName, proxy, proxyUsername, proxyPassword, gotoUrl, timeoutMs }) {
  const effectiveProfile = profileName ? String(profileName) : null;
  const userDataDir = effectiveProfile ? resolveProfilePath(effectiveProfile) : null;
  const proxyObj = parseProxy(proxy, proxyUsername, proxyPassword);

  await safeCloseExecContext(execContext);

  const settings = loadSettings();
  const HEADLESS_ENV = String(process.env.PLAYWRIGHT_HEADLESS || '').trim() === '1';
  const HEADLESS = (settings?.browser?.headless === true) || HEADLESS_ENV;

  if (effectiveProfile) {
    mkdirSync(userDataDir, { recursive: true });
    const ctx = await launchPersistentWithRetry({
      baseUserDataDir: userDataDir,
      profileNameForTmp: effectiveProfile,
      proxyObj,
      headless: HEADLESS
    });
    const p = ctx.pages()[0] || await ctx.newPage();
    execContext.browser = ctx;
    execContext.context = ctx;
    execContext.page = p;
  } else {
    const b = await chromium.launch({ headless: HEADLESS, args: HEADLESS ? [] : ['--disable-backgrounding-occluded-windows'], ...(proxyObj ? { proxy: proxyObj } : {}) });
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    execContext.browser = b;
    execContext.context = ctx;
    execContext.page = p;
  }

  // Track current selections in vars
  if (execContext.vars) {
    if (effectiveProfile) execContext.vars._current_profile = effectiveProfile;
    if (proxy !== undefined) execContext.vars._current_proxy = proxy;
  }

  if (gotoUrl) {
    await execContext.page.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 120000 });
  }

  return execContext.page;
}

function requestGlobalBrowserInit(payload, targets) {
  const token = randomUUID().slice(0, 8);
  pendingBrowserInit = { token, ...payload, targets: new Set(targets) };
  pendingBrowserInitAcks = new Set();
  return token;
}

async function applyPendingBrowserInitIfNeeded(execContext) {
  if (!pendingBrowserInit) return;
  const execId = execContext?.execId || 'main';
  if (!pendingBrowserInit.targets.has(execId)) return;
  if (pendingBrowserInitAcks.has(execId)) return;

  await restartExecContext(execContext, pendingBrowserInit);
  pendingBrowserInitAcks.add(execId);

  // Clear when everyone acked
  if (pendingBrowserInitAcks.size >= pendingBrowserInit.targets.size) {
    pendingBrowserInit = null;
    pendingBrowserInitAcks = new Set();
  }
}

// AC9: Resolve {{variables}} in a string вЂ" unified for all fields
// When varsOverride is provided, use it instead of global runtimeVars (for parallel execution)
function resolveVars(str, tableRow = {}, varsOverride = null) {
  if (!str || typeof str !== 'string') return str;
  const settings = loadSettings();
  const globalVars = settings.variables?.global || {};
  const persistentVars = loadPersistentVars();
  const activeVars = varsOverride !== null ? varsOverride : runtimeVars;
  const allVars = { ...globalVars, ...persistentVars, ...tableRow, ...activeVars };
  return str.replace(/\{\{(\w+)(\|(\w+))?\}\}/g, (match, varName, _, filter) => {
    const val = allVars[varName];
    if (val === undefined) return match;
    let result = String(val);
    if (filter === 'numbers_only') result = result.replace(/[^\d]/g, '');
    if (filter === 'trim') result = result.trim();
    return result;
  });
}

// Подставить именованный селектор (@имя → реальный CSS)
function resolveSelector(selectorStr) {
  if (!selectorStr || typeof selectorStr !== 'string') return selectorStr;
  if (!selectorStr.startsWith('@')) return selectorStr;

  const name = selectorStr.slice(1);
  const settings = loadSettings();
  const saved = settings.savedSelectors?.[name];
  if (saved) return saved;

  console.warn(`⚠️ Именованный селектор не найден: @${name}`);
  return selectorStr;
}

async function debugHighlightAndShot(p, box, label) {
  try {
    if (!box) return null;
    const id = '__oc_debug_box';
    await p.evaluate(({ id }) => {
      const old = document.getElementById(id);
      if (old) old.remove();
    }, { id }).catch(() => {});

    await p.evaluate(({ id, box, label }) => {
      const d = document.createElement('div');
      d.id = id;
      d.style.position = 'fixed';
      d.style.left = Math.max(0, Math.floor(box.x)) + 'px';
      d.style.top = Math.max(0, Math.floor(box.y)) + 'px';
      d.style.width = Math.max(1, Math.floor(box.width)) + 'px';
      d.style.height = Math.max(1, Math.floor(box.height)) + 'px';
      d.style.border = '3px solid red';
      d.style.background = 'rgba(255,0,0,0.05)';
      d.style.zIndex = '2147483647';
      d.style.pointerEvents = 'none';

      const t = document.createElement('div');
      t.textContent = label || '';
      t.style.position = 'absolute';
      t.style.left = '0';
      t.style.top = '-20px';
      t.style.padding = '2px 6px';
      t.style.font = '12px/1.2 monospace';
      t.style.color = '#fff';
      t.style.background = 'rgba(255,0,0,0.9)';
      t.style.maxWidth = '70vw';
      t.style.whiteSpace = 'nowrap';
      t.style.overflow = 'hidden';
      t.style.textOverflow = 'ellipsis';
      d.appendChild(t);

      document.body.appendChild(d);
    }, { id, box, label }).catch(() => {});

    await p.waitForTimeout(60).catch(() => {});

    const shot = join(TEMP_DIR, `click-${Date.now()}-${randomUUID().slice(0, 6)}.png`);
    await p.screenshot({ path: shot, fullPage: true }).catch(() => null);

    await p.evaluate(({ id }) => {
      const old = document.getElementById(id);
      if (old) old.remove();
    }, { id }).catch(() => {});

    return shot;
  } catch (e) {
    return null;
  }
}

async function smartClick(p, step, selector, timeout, wss, path) {
  const attempts = [];

  // 1) Provided CSS selector
  if (selector && typeof selector === 'string' && selector.trim()) {
    attempts.push({ kind: 'css', value: selector.trim() });
  }

  // 2) Raw recorded cssSelector (before resolveSelector) if present
  const rawSelector = step?.cssSelector || step?.selector;
  if (rawSelector && typeof rawSelector === 'string' && rawSelector.trim() && rawSelector.trim() !== selector?.trim()) {
    attempts.push({ kind: 'css', value: rawSelector.trim() });
  }

  // 3) Recorded XPath
  if (step?.xpath && typeof step.xpath === 'string' && step.xpath.trim()) {
    attempts.push({ kind: 'xpath', value: step.xpath.trim() });
  }

  // 4) Placeholder-based (Telegram часто меняет id)
  if (step?.placeholder && typeof step.placeholder === 'string' && step.placeholder.trim()) {
    attempts.push({ kind: 'placeholder', value: step.placeholder.trim() });
  }

  // 5) Heuristics for Telegram Web search
  if ((selector || '').includes('telegram-search-input') || (step?.cssSelector || '').includes('telegram-search-input')) {
    // Legacy /a/ UI
    attempts.push({ kind: 'placeholder', value: 'Search' });
    attempts.push({ kind: 'role', value: 'textbox', name: 'Search' });

    // New /k/ UI often doesn't have the old id; try broader search-field patterns
    attempts.push({ kind: 'css', value: 'input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i], [contenteditable="true"][role="textbox"]' });
  }

  const errors = [];
  for (const a of attempts) {
    try {
      let loc;
      if (a.kind === 'css') {
        loc = p.locator(a.value).first();
      } else if (a.kind === 'xpath') {
        loc = p.locator(`xpath=${a.value}`).first();
      } else if (a.kind === 'placeholder') {
        loc = p.getByPlaceholder(a.value, { exact: true }).first();
      } else if (a.kind === 'role') {
        loc = p.getByRole(a.value, { name: a.name, exact: true }).first();
      }

      if (!loc) continue;
      await loc.waitFor({ state: 'visible', timeout });

      // Optional debug: take a screenshot with red highlight of the click target
      const settings = loadSettings();
      if (settings?.debug?.clickShots) {
        const box = await loc.boundingBox().catch(() => null);
        const shot = await debugHighlightAndShot(p, box, `click ${path} :: ${a.kind}`);
        if (shot && wss) broadcastStatus(wss, { type: 'click-shot', path, method: a.kind, selector: a.value, screenshot: shot });
        if (shot) console.log('🟥 click-shot', JSON.stringify({ path, method: a.kind, selector: a.value, screenshot: shot }));
      }

      await loc.click({ timeout, force: true });

      // Post-click diagnostics: did focus move where we expect?
      const active = await p.evaluate(() => {
        const ae = document.activeElement;
        return {
          tag: ae?.tagName || null,
          id: ae?.id || null,
          className: typeof ae?.className === 'string' ? ae.className : null,
          placeholder: ae?.getAttribute ? ae.getAttribute('placeholder') : null,
          ariaLabel: ae?.getAttribute ? ae.getAttribute('aria-label') : null
        };
      }).catch(() => null);

      console.log('🖱️ click-ok', JSON.stringify({ path, method: a.kind, selector: a.value, active }, null, 0));
      if (wss) broadcastStatus(wss, { type: 'click-ok', path, method: a.kind, selector: a.value, active });
      return;
    } catch (e) {
      errors.push({ method: a.kind, selector: a.value, error: String(e?.message || e) });
    }
  }

  if (wss) broadcastStatus(wss, { type: 'click-failed', path, selector, attempts: errors.slice(0, 6) });
  const last = errors[errors.length - 1];
  throw new Error(last?.error || `Click failed: ${selector}`);
}

async function smartFill(p, step, selector, value, timeout, wss, path) {
  // Use same resolver chain as smartClick, but perform fill instead.
  const attempts = [];

  if (selector && typeof selector === 'string' && selector.trim()) attempts.push({ kind: 'css', value: selector.trim() });
  const rawSelector = step?.cssSelector || step?.selector;
  if (rawSelector && typeof rawSelector === 'string' && rawSelector.trim() && rawSelector.trim() !== selector?.trim()) {
    attempts.push({ kind: 'css', value: rawSelector.trim() });
  }
  if (step?.xpath && typeof step.xpath === 'string' && step.xpath.trim()) attempts.push({ kind: 'xpath', value: step.xpath.trim() });
  if (step?.placeholder && typeof step.placeholder === 'string' && step.placeholder.trim()) attempts.push({ kind: 'placeholder', value: step.placeholder.trim() });

  if ((selector || '').includes('telegram-search-input') || (step?.cssSelector || '').includes('telegram-search-input')) {
    // Legacy /a/ UI
    attempts.push({ kind: 'placeholder', value: 'Search' });
    attempts.push({ kind: 'role', value: 'textbox', name: 'Search' });

    // New /k/ UI often doesn't have the old id; try broader search-field patterns
    attempts.push({ kind: 'css', value: 'input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i], [contenteditable="true"][role="textbox"]' });
  }

  const errors = [];
  for (const a of attempts) {
    try {
      let loc;
      if (a.kind === 'css') loc = p.locator(a.value).first();
      else if (a.kind === 'xpath') loc = p.locator(`xpath=${a.value}`).first();
      else if (a.kind === 'placeholder') loc = p.getByPlaceholder(a.value, { exact: true }).first();
      else if (a.kind === 'role') loc = p.getByRole(a.value, { name: a.name, exact: true }).first();

      if (!loc) continue;
      await loc.waitFor({ state: 'visible', timeout });
      await loc.fill(String(value ?? ''), { timeout });
      if (wss) broadcastStatus(wss, { type: 'fill-ok', path, method: a.kind, selector: a.value });
      return;
    } catch (e) {
      errors.push({ method: a.kind, selector: a.value, error: String(e?.message || e) });
    }
  }

  if (wss) broadcastStatus(wss, { type: 'fill-failed', path, selector, attempts: errors.slice(0, 6) });
  const last = errors[errors.length - 1];
  throw new Error(last?.error || `Fill failed: ${selector}`);
}

function broadcastStatus(wss, msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Evaluate condition for if-blocks
// When varsOverride is provided, use it instead of global runtimeVars (for parallel execution)
function evaluateCondition(step, tableRow = {}, varsOverride = null) {
  const varName = step.conditionVar || '';
  const operator = step.operator || 'not-empty';
  // AC9: resolve compareValue through resolveVars
  const compareValue = resolveVars(step.compareValue || '', tableRow, varsOverride);

  const activeVars = varsOverride !== null ? varsOverride : runtimeVars;
  const allVars = { ...activeVars };
  const val = allVars[varName] !== undefined ? String(allVars[varName]) : '';

  switch (operator) {
    case 'not-empty': return val.trim().length > 0;
    case 'empty': return val.trim().length === 0;
    case 'equals': return val === compareValue;
    case 'not-equals': return val !== compareValue;
    case 'contains': return val.includes(compareValue);
    case 'not-contains': return !val.includes(compareValue);
    case 'starts-with': return val.startsWith(compareValue);
    case 'ends-with': return val.endsWith(compareValue);
    case 'greater-than': return parseFloat(val) > parseFloat(compareValue);
    case 'less-than': return parseFloat(val) < parseFloat(compareValue);
    default: return val.trim().length > 0;
  }
}

// Execute a single atomic step (non-recursive)
// execContext: optional { vars, browser, context } for parallel execution (avoids globals)
async function executeAtomicStep(p, step, path, wss, currentElement = null, execContext = null) {
  // When execContext is provided, use its vars; otherwise fall back to global runtimeVars
  const vars = execContext ? execContext.vars : runtimeVars;

  // Apply pending global browser init/switch in a safe point (between steps)
  if (execContext) {
    await applyPendingBrowserInitIfNeeded(execContext);
    p = execContext.page || p;
  }

  // If page is missing (e.g. first step is browser-init), create it lazily.
  if (!p && step?.action !== 'browser-init') {
    p = execContext?.page || await ensureBrowser();
    if (execContext && !execContext.page) execContext.page = p;
  }

  // Guard: if page was force-closed (hard-timeout/stop), fail fast.
  // IMPORTANT: guard must run AFTER lazy page creation (except browser-init which is allowed to recover).
  if (step?.action !== 'browser-init') {
    p = ensureLivePage(p, execContext);
  }

  if (p) {
    try { await p.title(); } catch (e) { p = await ensureBrowser(); if (execContext) execContext.page = p; }
  }

  // Load default timeout from settings (individual step waitTime can override)
  const currentSettings = loadSettings();
  const defaultTimeout = currentSettings.timeout || 30000;

  // Telegram Web часто показывает блокирующие баннеры/промпты — попробуем снять их до шага
  // ВАЖНО: для A/B диагностики можно отключить через settings.json -> debug.disableOverlayDismiss
  if (!(currentSettings?.debug?.disableOverlayDismiss)) {
    await autoDismissTelegramOverlays(p);
  }

  // Track current step for hard-timeout diagnostics
  lastStepPath = path;
  lastStepAction = step.action;
  lastStepAt = Date.now();

  broadcastStatus(wss, { type: 'step-executing', path, step: { action: step.action } });

  try {
    // AC5: If step has pyFile, load Python code from data/python/ and execute INSTEAD of standard logic
    if (step.pyFile && step.pyFile.trim()) {
      const pyFilePath = join(PYTHON_DIR, step.pyFile);
      if (!existsSync(pyFilePath)) {
        throw new Error(`Python-файл не найден: ${step.pyFile} (в data/python/)`);
      }
      const pyCode = readFileSync(pyFilePath, 'utf-8');
      broadcastStatus(wss, { type: 'python-output', path, output: `🐍 Python из С"айла: ${step.pyFile}` });
      const pyResult = await executePython(pyCode, vars, wss, path);
      if (pyResult.error) {
        broadcastStatus(wss, { type: 'python-error', path, error: pyResult.error });
        throw new Error(`Python-файл ошибка: ${pyResult.error}`);
      }
      if (pyResult.variables) {
        Object.assign(vars, pyResult.variables);
        for (const [k, v] of Object.entries(pyResult.variables)) {
          if (!k.startsWith('_')) broadcastStatus(wss, { type: 'var-saved', path, varName: k, value: String(v) });
        }
      }
      // Note: executePython already broadcasts output in real-time, no need to re-broadcast pyResult.output
      await p.waitForTimeout(300);
      broadcastStatus(wss, { type: 'step-completed', path, success: true });
      return { success: true, path };
    }

    // === PYTHON OVERRIDE: if step has pythonOverride, execute it INSTEAD of standard logic ===
    if (step.pythonOverride && step.pythonOverride.trim()) {
      broadcastStatus(wss, { type: 'python-output', path, output: `🐍 Python-override для ${step.action}` });
      const pyResult = await executePython(step.pythonOverride, vars, wss, path);
      if (pyResult.error) {
        broadcastStatus(wss, { type: 'python-error', path, error: pyResult.error });
        throw new Error(`Python-override ошибка: ${pyResult.error}`);
      }
      if (pyResult.variables) {
        Object.assign(vars, pyResult.variables);
        for (const [k, v] of Object.entries(pyResult.variables)) {
          if (!k.startsWith('_')) broadcastStatus(wss, { type: 'var-saved', path, varName: k, value: String(v) });
        }
      }
      // Note: executePython already broadcasts output in real-time, no need to re-broadcast pyResult.output
      await p.waitForTimeout(300);
      broadcastStatus(wss, { type: 'step-completed', path, success: true });
      return { success: true, path };
    }

    // AC9: Resolve all relevant fields through resolveVars
    const selector = resolveSelector(resolveVars(step.cssSelector || step.selector || '', step._tableRow || {}, vars));
    const useCurrentElement = selector === '{{_current}}' && currentElement;

    switch (step.action) {
      case 'debug-dump': {
        const dump = await p.evaluate(() => {
          const q = (sel) => document.querySelector(sel);
          const qa = (sel) => Array.from(document.querySelectorAll(sel));
          const searchByPlaceholder = qa('input').filter(i => (i.getAttribute('placeholder') || '').toLowerCase() === 'search');
          const searchByAria = qa('input').filter(i => ((i.getAttribute('aria-label') || '').toLowerCase().includes('search')));
          const editableCount = qa('[contenteditable="true"]').length;
          const editableTextboxCount = qa('[contenteditable="true"][role="textbox"]').length;
          
          // Диагностика результатов поиска (для Telegram Web)
          const searchResults = qa('.ListItem-button, a.ListItem, [data-testid*="search"], [class*="search-result"], [class*="SearchResult"]');
          const searchResultsText = searchResults.slice(0, 5).map(el => ({
            tag: el.tagName,
            text: (el.innerText || el.textContent || '').trim().slice(0, 100),
            classes: el.className,
            href: el.href || null
          }));
          
          return {
            url: location.href,
            readyState: document.readyState,
            hasTelegramSearchId: !!q('#telegram-search-input'),
            inputsCount: qa('input').length,
            searchPlaceholderCount: searchByPlaceholder.length,
            searchAriaCount: searchByAria.length,
            editableCount,
            editableTextboxCount,
            bodyTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
            searchResultsCount: searchResults.length,
            searchResultsSample: searchResultsText
          };
        });

        const fileBase = `dump-${Date.now()}-${randomUUID().slice(0, 6)}`;
        const pngPath = join(TEMP_DIR, fileBase + '.png');
        try { await p.screenshot({ path: pngPath, fullPage: true }); } catch (e) {}

        console.log('🧪 DEBUG_DUMP', JSON.stringify({ path, ...dump, screenshot: pngPath }, null, 0));
        broadcastStatus(wss, { type: 'debug-dump', path, dump, screenshot: pngPath });

        // If Telegram UI vanished (often after context/page got closed), fail fast so the iteration can recover.
        // Keep this conservative to avoid false positives on UI transitions / new Telegram layouts.
        if ((dump.url || '').includes('web.telegram.org') &&
            !dump.hasTelegramSearchId &&
            dump.inputsCount === 0 &&
            dump.editableTextboxCount === 0 &&
            String(dump.bodyTextSample || '').length < 50) {
          // One-shot recovery attempt: reload the page once per run to avoid marking rows failed on transient blank UI.
          if (String(vars.__tg_ui_reload_once || '') !== '1') {
            vars.__tg_ui_reload_once = '1';
            try {
              console.log('🧪 TELEGRAM_UI_MISSING: attempting one-shot reload');
              await p.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
              await p.waitForTimeout(3000);
              const uiOk = async () => {
                return await p.evaluate(() => {
                  const inputs = document.querySelectorAll('input').length;
                  const editableTb = document.querySelectorAll('[contenteditable="true"][role="textbox"]').length;
                  const txt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                  // Telegram /a has #telegram-search-input, /k may not. Use broad heuristics.
                  const hasSearchId = !!document.querySelector('#telegram-search-input');
                  return hasSearchId || inputs > 0 || editableTb > 0 || txt.length > 80;
                }).catch(() => false);
              };

              let ok = await uiOk();
              if (!ok) {
                // Fallback: sometimes /a becomes a blank shell; try forcing a fresh navigation.
                await p.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded', timeout: 20000 });
                await p.waitForTimeout(3000);
                ok = await uiOk();
              }
              if (!ok) {
                // Fallback to legacy UI route
                await p.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded', timeout: 20000 });
                await p.waitForTimeout(3000);
                ok = await uiOk();
              }
              if (ok) {
                // Take a second screenshot after recovery to avoid capturing a transient blank frame during reload.
                try {
                  await p.waitForTimeout(2000);
                  const pngPath2 = join(TEMP_DIR, fileBase + '-after-recovery.png');
                  await p.screenshot({ path: pngPath2, fullPage: true }).catch(() => {});
                  console.log('📸 TELEGRAM_UI_MISSING: after-recovery screenshot saved:', pngPath2);
                  broadcastStatus(wss, { type: 'debug-dump', path, dump: { ...dump, recovered: true }, screenshot: pngPath2 });
                } catch (e) {}
                break;
              }
            } catch (e) {
              // fall through to fail-fast
            }
          }
          throw new Error('TELEGRAM_UI_MISSING');
        }

        break;
      }

      case 'click':
        // First try to dismiss any modal overlay
        try { await p.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(el => el.remove())); } catch(e) {}
        if (useCurrentElement) {
          await currentElement.click({ timeout: defaultTimeout, force: true });
        } else {
          await smartClick(p, step, selector, defaultTimeout, wss, path);
        }
        break;

      case 'click-current':
        if (currentElement) {
          const settings = loadSettings();
          if (settings?.debug?.clickShots) {
            const box = await currentElement.boundingBox().catch(() => null);
            const shot = await debugHighlightAndShot(p, box, `click-current ${path}`);
            if (shot) console.log('🟥 click-shot', JSON.stringify({ path, method: 'click-current', selector: null, screenshot: shot }));
            if (shot && wss) broadcastStatus(wss, { type: 'click-shot', path, method: 'click-current', screenshot: shot });
          }
          await currentElement.click({ timeout: defaultTimeout });
        } else {
          throw new Error(`click-current: нет текущего элемента (используйте внутри loop-elements)`);
        }
        break;

      case 'type': {
        const resolvedValue = resolveVars(step.value || '', step._tableRow || {}, vars);
        const pressEnter = step.pressEnter || false;
        const humanMode = step.humanMode === true || step.humanMode === 'true';

        try { console.log('⌨️ type', JSON.stringify({ path, selector, value: String(resolvedValue).slice(0, 120) }, null, 0)); } catch(e) {}
        
        if (humanMode) {
          // AC32: Human-like typing with variable delays (80-200ms per char)
          const el = useCurrentElement ? currentElement : await p.$(selector);
          if (!el) throw new Error(`Элемент не найден: ${selector}`);
          await el.click({ timeout: defaultTimeout });
          await el.fill('', { timeout: defaultTimeout }); // Clear first
          for (const char of resolvedValue) {
            await el.type(char, { delay: 0 });
            const charDelay = 80 + Math.random() * 120; // 80-200ms
            await p.waitForTimeout(charDelay);
          }
          if (pressEnter) await el.press('Enter');
        } else {
          if (useCurrentElement) {
            await currentElement.fill(resolvedValue, { timeout: defaultTimeout });
            if (pressEnter) await currentElement.press('Enter');
          } else {
            await smartFill(p, step, selector, resolvedValue, defaultTimeout, wss, path);
            if (pressEnter) await p.keyboard.press('Enter');
          }
        }
        broadcastStatus(wss, { type: 'var-resolved', path, original: step.value, resolved: resolvedValue });
        break;
      }

      case 'type-current': {
        if (currentElement) {
          const resolvedValue = resolveVars(step.value || '', step._tableRow || {}, vars);
          await currentElement.fill(resolvedValue, { timeout: defaultTimeout });
          if (step.pressEnter) {
            await currentElement.press('Enter');
          }
        } else {
          throw new Error(`type-current: нет текущего элемента`);
        }
        break;
      }

      case 'read': {
        const text = useCurrentElement
          ? await currentElement.textContent({ timeout: defaultTimeout })
          : await p.textContent(selector, { timeout: defaultTimeout });
        step.readResult = text;
        if (step.saveAs) {
          vars[step.saveAs] = (text || '').trim();
          broadcastStatus(wss, { type: 'var-saved', path, varName: step.saveAs, value: vars[step.saveAs] });
        }
        break;
      }

      case 'read-current': {
        if (currentElement) {
          const text = await currentElement.textContent({ timeout: defaultTimeout });
          if (step.saveAs) {
            vars[step.saveAs] = (text || '').trim();
            broadcastStatus(wss, { type: 'var-saved', path, varName: step.saveAs, value: vars[step.saveAs] });
          }
        } else {
          throw new Error(`read-current: нет текущего элемента`);
        }
        break;
      }

      case 'save-to-table': {
        // AC9: resolve tableName through vars
        const tblName = resolveVars(step.tableName || 'results', step._tableRow || {}, vars);
        const currentSettings = loadSettings();
        if (!currentSettings.dataTables) currentSettings.dataTables = {};

        let cols;
        if (step.columns && step.columns.length > 0) {
          cols = step.columns.map(c => resolveVars(c, step._tableRow || {}, vars));
        } else if (step.value) {
          cols = [resolveVars(step.value, step._tableRow || {}, vars)];
        } else {
          cols = [''];
        }

        if (!currentSettings.dataTables[tblName]) {
          const headers = (step.columns && step.columns.length > 0)
            ? step.columns.map(c => c.replace(/\{\{|\}\}/g, '').trim())
            : (step.value ? [step.value.replace(/\{\{|\}\}/g, '').trim() || 'value'] : ['value']);
          currentSettings.dataTables[tblName] = { headers, rows: [] };
        }
        currentSettings.dataTables[tblName].rows.push(cols);
        saveSettings(currentSettings);
        broadcastStatus(wss, { type: 'table-row-saved', path, tableName: tblName, row: cols });
        break;
      }

      case 'wait':
        if (step.waitType === 'time' || step.waitType === 'delay') {
          // AC9: resolve waitTime through vars
          const ms = parseInt(resolveVars(String(step.waitTime || '1000'), step._tableRow || {}, vars));
          await p.waitForTimeout(ms);
        } else if (useCurrentElement) {
          // Element already exists in current loop context, skip
        } else {
          await p.waitForSelector(selector, { timeout: parseInt(step.waitTimeout || String(defaultTimeout)) });
        }
        break;

      case 'navigate': {
        // AC9: resolve url through vars
        const url = resolveVars(step.url || '', step._tableRow || {}, vars);
        const waitUntil = /web\.telegram\.org/i.test(url) ? 'networkidle' : 'domcontentloaded';
        await p.goto(url, { waitUntil, timeout: defaultTimeout });
        // Small settle delay helps Telegram Web render interactive UI before first click
        if (/web\.telegram\.org/i.test(url)) await p.waitForTimeout(750);
        break;
      }

      case 'go-back':
        await p.goBack({ waitUntil: 'domcontentloaded', timeout: defaultTimeout });
        break;

      case 'scroll':
        if (useCurrentElement) {
          await currentElement.scrollIntoViewIfNeeded();
        } else {
          await p.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, selector);
        }
        break;

      case 'press-key': {
        // AC9: resolve key through vars
        const key = resolveVars(step.key || 'Enter', step._tableRow || {}, vars);
        await p.keyboard.press(key);
        break;
      }

      case 'clear-field':
        if (useCurrentElement) {
          await currentElement.fill('', { timeout: defaultTimeout });
        } else {
          await smartFill(p, step, selector, '', defaultTimeout, wss, path);
        }
        break;

      case 'get-sms-code':
        broadcastStatus(wss, { type: 'sms-code-request', path, step });
        break;

      case 'request-code': {
        broadcastStatus(wss, { type: 'sms-code-request', path, step });
        const codeVarName = step.saveAs || step.varName || 'sms_code';
        const smsSettings = loadSettings().smsServices || {};
        broadcastStatus(wss, {
          type: 'code-requested',
          path,
          varName: codeVarName,
          service: smsSettings.active || 'manual'
        });
        if (!vars[codeVarName]) vars[codeVarName] = '';
        break;
      }

      case 'python': {
        const pythonCode = step.pythonCode || step.value || '';
        if (!pythonCode.trim()) {
          broadcastStatus(wss, { type: 'python-output', path, output: `(пустой Python-блок)` });
          break;
        }
        const pyResult = await executePython(pythonCode, vars, wss, path);
        if (pyResult.error) {
          broadcastStatus(wss, { type: 'python-error', path, error: pyResult.error });
          throw new Error(`Python ошибка: ${pyResult.error}`);
        }
        if (pyResult.variables) {
          Object.assign(vars, pyResult.variables);
          for (const [k, v] of Object.entries(pyResult.variables)) {
            broadcastStatus(wss, { type: 'var-saved', path, varName: k, value: String(v) });
          }
        }
        // Note: executePython already broadcasts output in real-time, no need to re-broadcast pyResult.output
        break;
      }

      case 'user-input': {
        // AC9: resolve prompt fields
        const promptTitle = resolveVars(step.promptTitle || step.value || `Введите значение`, step._tableRow || {}, vars);
        const promptPlaceholder = resolveVars(step.promptPlaceholder || '', step._tableRow || {}, vars);
        const isPassword = step.isPassword || false;
        const timeoutMs = parseInt(step.inputTimeout || '0') || 0;

        broadcastStatus(wss, { type: 'user-input-requested', path, title: promptTitle });

        const userValue = await p.evaluate(({ title, placeholder, isPassword, timeoutMs }) => {
          return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = '_macro_input_overlay';
            Object.assign(overlay.style, {
              position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
              background: 'rgba(0,0,0,0.7)', zIndex: '2147483647',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
            });

            const modal = document.createElement('div');
            Object.assign(modal.style, {
              background: '#1e1e2e', borderRadius: '16px', padding: '28px 32px',
              minWidth: '360px', maxWidth: '500px', boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
              border: '1px solid #45475a', color: '#cdd6f4'
            });

            const titleEl = document.createElement('div');
            Object.assign(titleEl.style, { fontSize: '16px', fontWeight: '700', marginBottom: '16px' });
            titleEl.textContent = title;

            const input = document.createElement('input');
            input.type = isPassword ? 'password' : 'text';
            input.placeholder = placeholder || '';
            Object.assign(input.style, {
              width: '100%', padding: '10px 14px', background: '#313244',
              border: '2px solid #585b70', borderRadius: '8px', color: '#cdd6f4',
              fontSize: '15px', outline: 'none', boxSizing: 'border-box'
            });
            input.addEventListener('focus', () => { input.style.borderColor = '#89b4fa'; });
            input.addEventListener('blur', () => { input.style.borderColor = '#585b70'; });

            const btnRow = document.createElement('div');
            Object.assign(btnRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '16px', gap: '8px' });

            const btnOk = document.createElement('button');
            btnOk.textContent = `✅ Продолжить`;
            Object.assign(btnOk.style, {
              padding: '8px 20px', background: '#a6e3a1', color: '#1e1e2e',
              border: 'none', borderRadius: '8px', fontSize: '14px',
              fontWeight: '700', cursor: 'pointer'
            });

            const submit = () => { overlay.remove(); resolve(input.value); };
            btnOk.addEventListener('click', submit);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

            btnRow.appendChild(btnOk);
            modal.appendChild(titleEl);
            modal.appendChild(input);
            modal.appendChild(btnRow);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            input.focus();

            if (timeoutMs > 0) {
              setTimeout(() => {
                if (document.getElementById('_macro_input_overlay')) {
                  overlay.remove();
                  resolve('');
                }
              }, timeoutMs);
            }
          });
        }, { title: promptTitle, placeholder: promptPlaceholder, isPassword, timeoutMs });

        const varName = step.saveAs || step.varName || 'user_input';
        vars[varName] = userValue || '';
        broadcastStatus(wss, { type: 'var-saved', path, varName, value: isPassword ? '***' : (userValue || '').substring(0, 50) });
        broadcastStatus(wss, { type: 'user-input-received', path, varName });
        break;
      }

      // ==================== Autoreg Blocks (AC15-AC21) ====================
      
      case 'get-sms-number': {
        // AC15: Buy phone number from SMS service
        const service = resolveVars(step.service || '', step._tableRow || {}, vars) || loadSettings().smsServices?.active;
        const country = resolveVars(step.country || 'ru', step._tableRow || {}, vars);
        const savePhoneTo = step.savePhoneTo || 'phone';
        const saveSmsIdTo = step.saveSmsIdTo || 'sms_id';
        
        if (!service) throw new Error('SMS сервис не указан (укажите в блоке или настройках)');
        
        broadcastStatus(wss, { type: 'sms-number-acquiring', path, service, country });
        const result = await smsGetNumber(service, country);
        
        vars[savePhoneTo] = result.phone;
        vars[saveSmsIdTo] = result.id;
        vars['_sms_service'] = service;
        
        // Track in-progress
        try { await addInProgress(result.phone, result.id); } catch (e) {}
        
        broadcastStatus(wss, { type: 'sms-number-acquired', path, phone: result.phone, smsId: result.id });
        broadcastStatus(wss, { type: 'var-saved', path, varName: savePhoneTo, value: result.phone });
        broadcastStatus(wss, { type: 'var-saved', path, varName: saveSmsIdTo, value: result.id });
        break;
      }
      
      case 'wait-sms-code': {
        // AC16: Wait for SMS code with polling
        const smsIdVar = step.smsIdVar || 'sms_id';
        const smsId = vars[smsIdVar];
        const saveCodeTo = step.saveCodeTo || 'sms_code';
        const timeout = parseInt(resolveVars(String(step.timeout || '120'), step._tableRow || {}, vars));
        const service = vars['_sms_service'] || resolveVars(step.service || '', step._tableRow || {}, vars) || loadSettings().smsServices?.active;
        
        if (!smsId) throw new Error(`wait-sms-code: переменная ${smsIdVar} пуста (нет sms_id)`);
        if (!service) throw new Error('SMS сервис не определён');
        
        broadcastStatus(wss, { type: 'sms-code-waiting', path, smsId, timeout });
        
        const result = await smsWaitForCode(service, smsId, timeout, 5000, (pollResult) => {
          broadcastStatus(wss, { type: 'sms-code-poll', path, status: pollResult.status });
        });
        
        vars[saveCodeTo] = result.code;
        broadcastStatus(wss, { type: 'sms-code-received', path, code: result.code });
        broadcastStatus(wss, { type: 'var-saved', path, varName: saveCodeTo, value: result.code });
        break;
      }
      
      case 'solve-captcha': {
        // AC17: Solve captcha
        let captchaType = resolveVars(step.captchaType || 'recaptcha-v2', step._tableRow || {}, vars);
        let siteKey = resolveVars(step.siteKey || '', step._tableRow || {}, vars);
        const autoDetect = step.autoDetect === true || step.autoDetect === 'true';
        const saveTokenTo = step.saveTokenTo || 'captcha_token';
        
        // AC10: Auto-detection
        if (autoDetect) {
          broadcastStatus(wss, { type: 'captcha-detecting', path });
          const detected = await autoDetectCaptcha(p);
          if (detected) {
            captchaType = detected.type;
            siteKey = detected.siteKey || siteKey;
            broadcastStatus(wss, { type: 'captcha-detected', path, captchaType, siteKey });
          }
        }
        
        if (!siteKey) throw new Error('solve-captcha: siteKey не указан и не обнаружен автоматически');
        
        const pageUrl = await p.url();
        broadcastStatus(wss, { type: 'captcha-solving', path, captchaType });
        
        const result = await captchaSolve({ type: captchaType, siteKey, pageUrl });
        
        vars[saveTokenTo] = result.token;
        broadcastStatus(wss, { type: 'captcha-solved', path });
        broadcastStatus(wss, { type: 'var-saved', path, varName: saveTokenTo, value: result.token.substring(0, 30) + '...' });
        break;
      }
      
      case 'save-account': {
        // AC18: Save account to database
        const phoneVar = step.phoneVar || 'phone';
        const usernameVar = step.usernameVar || 'username';
        const sessionDataVar = step.sessionDataVar || 'session_data';
        const status = resolveVars(step.status || 'registered', step._tableRow || {}, vars);
        const reason = resolveVars(step.reason || '', step._tableRow || {}, vars);
        
        const phone = vars[phoneVar] || '';
        const username = vars[usernameVar] || '';
        const sessionData = vars[sessionDataVar] || '';
        const proxyUsed = vars['_current_proxy'] || '';
        
        await dbSaveAccount({ phone, username, sessionData, status, reason, proxyUsed });
        
        // AC35: Track result for monitoring
        const success = status === 'registered' || status === 'success';
        trackResult(success, proxyUsed);
        
        // AC35: Check success rate and emit warning if needed
        const rateCheck = checkSuccessRate(
          loadSettings().autoregConfig?.successRateThreshold || 30
        );
        if (rateCheck.warning) {
          broadcastStatus(wss, { 
            type: 'autoreg-warning', 
            path,
            message: `Уровень успеха упал до ${rateCheck.rate}% — задержки удвоены`,
            rate: rateCheck.rate 
          });
        }
        
        // AC36: Check proxy block
        if (!success && proxyUsed && shouldBlockProxy(proxyUsed)) {
          await addBlockedIP(proxyUsed);
          broadcastStatus(wss, { type: 'autoreg-warning', path, message: `Прокси заблокирован (3 ошибки подряд): ${proxyUsed.substring(0, 30)}` });
        }
        
        const statusIcon = success ? 'account-registered' : 'account-failed';
        broadcastStatus(wss, { type: statusIcon, path, phone, status });
        break;
      }
      
      case 'check-blocked': {
        // AC19: Check if IP/phone is blocked
        const checkType = step.checkType || 'ip'; // 'ip' or 'phone'
        const saveResultTo = step.saveResultTo || 'is_blocked';
        
        let isBlocked = false;
        if (checkType === 'ip') {
          const currentProxy = vars['_current_proxy'] || '';
          isBlocked = currentProxy ? isIPBlocked(currentProxy) : false;
        } else if (checkType === 'phone') {
          const phone = vars['phone'] || '';
          isBlocked = phone ? isPhoneFailed(phone) : false;
        }
        
        vars[saveResultTo] = String(isBlocked);
        broadcastStatus(wss, { type: 'var-saved', path, varName: saveResultTo, value: String(isBlocked) });
        break;
      }
      
      case 'human-delay': {
        // AC20, AC31: Human-like random delay with gaussian distribution
        const minSec = parseFloat(resolveVars(String(step.minSeconds || '2'), step._tableRow || {}, vars));
        const maxSec = parseFloat(resolveVars(String(step.maxSeconds || '5'), step._tableRow || {}, vars));
        const humanize = step.humanize === true || step.humanize === 'true';
        
        // AC35: Apply delay multiplier from monitoring
        const autoregConfig = loadSettings().autoregConfig || {};
        const rateCheck = checkSuccessRate(autoregConfig.successRateThreshold || 30);
        const multiplier = rateCheck.shouldDoubleDelay ? 2 : (autoregConfig.delayMultiplier || 1);
        
        let delaySec;
        if (humanize) {
          // Gaussian distribution centered at midpoint
          const mid = (minSec + maxSec) / 2;
          const stdDev = (maxSec - minSec) / 6; // 99.7% within range
          // Box-Muller transform for gaussian random
          const u1 = Math.random();
          const u2 = Math.random();
          const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          delaySec = Math.max(minSec, Math.min(maxSec, mid + gaussian * stdDev));
        } else {
          delaySec = minSec + Math.random() * (maxSec - minSec);
        }
        
        delaySec *= multiplier;
        const delayMs = Math.round(delaySec * 1000);
        
        broadcastStatus(wss, { type: 'human-delay', path, delayMs, humanize, multiplier });
        await p.waitForTimeout(delayMs);
        break;
      }
      
      case 'release-number': {
        // AC21: Release/cancel SMS number
        const smsIdVar = step.smsIdVar || 'sms_id';
        const smsId = vars[smsIdVar] || '';
        const service = resolveVars(step.service || '', step._tableRow || {}, vars) || vars['_sms_service'] || loadSettings().smsServices?.active;
        
        if (!smsId) {
          broadcastStatus(wss, { type: 'step-completed', path, success: true, warning: 'sms_id пуст — пропущено' });
          break;
        }
        if (!service) {
          broadcastStatus(wss, { type: 'step-completed', path, success: false, error: 'SMS сервис не определён' });
          break;
        }
        
        try {
          const result = await smsReleaseNumber(service, smsId);
          broadcastStatus(wss, { type: 'sms-number-released', path, smsId, ok: result.ok });
        } catch (e) {
          // AC: release-number with invalid sms_id logs error but doesn't crash
          broadcastStatus(wss, { type: 'sms-release-error', path, error: e.message });
        }
        break;
      }
      
      case 'proxy-rotate': {
        const proxySettings = loadSettings().proxy || {};
        if (proxySettings.rotationUrl) {
          try {
            broadcastStatus(wss, { type: 'proxy-rotating', path, method: 'api' });
            const resp = await fetch(proxySettings.rotationUrl);
            const newProxy = await resp.text();
            vars['_current_proxy'] = newProxy.trim();
            broadcastStatus(wss, { type: 'proxy-rotated', path, proxy: newProxy.trim().substring(0, 30) + '...' });
          } catch (e) {
            broadcastStatus(wss, { type: 'proxy-error', path, error: e.message });
          }
        } else if (proxySettings.list && proxySettings.list.length > 0) {
          const currentIdx = parseInt(vars['_proxy_index'] || '-1');
          const nextIdx = (currentIdx + 1) % proxySettings.list.length;
          vars['_proxy_index'] = nextIdx;
          vars['_current_proxy'] = proxySettings.list[nextIdx];
          broadcastStatus(wss, { type: 'proxy-rotated', path, proxy: proxySettings.list[nextIdx].substring(0, 30), index: nextIdx });
        }

        // Optional: apply proxy immediately by restarting context
        const applyNow = step.applyImmediately === true || step.applyImmediately === 'true';
        if (applyNow) {
          const gotoUrl = vars._macro_start_url || null;
          const timeoutMs = parseInt(step.timeoutMs || '120000');
          const prof = vars._current_profile || null;
          broadcastStatus(wss, { type: 'proxy-applying', path, profile: prof, proxy: String(vars['_current_proxy'] || '').substring(0, 40) });
          if (execContext) {
            await restartExecContext(execContext, { profileName: prof, proxy: vars['_current_proxy'] || null, gotoUrl, timeoutMs });
            p = execContext.page;
          } else {
            // fall back: restart global browser
            try { if (browser) await browser.close(); } catch (e) {}
            browser = null; context = null; page = null;
            p = await ensureBrowser(prof);
            if (gotoUrl) await p.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          }
          broadcastStatus(wss, { type: 'proxy-applied', path, proxy: String(vars['_current_proxy'] || '').substring(0, 40) });
        }

        break;
      }

      case 'browser-init': {
        // Initialize (restart) browser context with chosen profile/proxy and navigate
        // to either step.startUrl (explicit override) or the macro's start URL.
        const scope = step.scope || 'this'; // this|all
        let targetProfile = step.profileName ? resolveVars(step.profileName, step._tableRow || {}, vars) : (vars._current_profile || null);
        let proxy = step.proxy !== undefined ? resolveVars(step.proxy, step._tableRow || {}, vars) : (vars._current_proxy || null);
        const proxyUsername = step.proxyUsername ? resolveVars(step.proxyUsername, step._tableRow || {}, vars) : null;
        const proxyPassword = step.proxyPassword ? resolveVars(step.proxyPassword, step._tableRow || {}, vars) : null;

        // Treat empty strings as "not provided" so we don't accidentally break defaults
        if (targetProfile !== null && targetProfile !== undefined && String(targetProfile).trim() === '') targetProfile = null;
        if (proxy !== null && proxy !== undefined && String(proxy).trim() === '') proxy = null;
        // Step-level startUrl override takes precedence over the macro-level start URL.
        const gotoUrl =
          (step.startUrl ? resolveVars(step.startUrl, step._tableRow || {}, vars) : null) ||
          vars._macro_start_url ||
          null;
        const timeoutMs = parseInt(step.timeoutMs || '120000');

        broadcastStatus(wss, { type: 'browser-init', path, scope, profile: targetProfile, proxy: proxy ? String(proxy).substring(0, 40) : '' });

        if (scope === 'all') {
          const targets = Array.from(activeExecIds);
          requestGlobalBrowserInit({ scope, profileName: targetProfile, proxy, proxyUsername, proxyPassword, gotoUrl, timeoutMs }, targets);
          // Apply immediately for this execContext too
          if (execContext) {
            await applyPendingBrowserInitIfNeeded(execContext);
            p = execContext.page;
          }
        } else {
          if (!execContext) {
            // fallback to globals
            p = await ensureBrowser(targetProfile);
            if (gotoUrl) await p.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          } else {
            await restartExecContext(execContext, { profileName: targetProfile, proxy, proxyUsername, proxyPassword, gotoUrl, timeoutMs });
            p = execContext.page;
          }
        }

        broadcastStatus(wss, { type: 'browser-initialized', path, scope, profile: targetProfile });
        break;
      }

      case 'switch-profile': {
        // Switch to a different browser profile (restart context). Supports scope=this|all.
        let targetProfile = null;

        if (step.profileList) {
          const profiles = resolveVars(step.profileList, step._tableRow || {}, vars)
            .split(',').map(s => s.trim()).filter(Boolean);
          const counterVar = step.counterVar || '_profile_index';
          const currentIdx = parseInt(vars[counterVar] || '-1');
          const nextIdx = (currentIdx + 1) % profiles.length;
          vars[counterVar] = nextIdx;
          targetProfile = profiles[nextIdx];
        } else if (step.profileName) {
          targetProfile = resolveVars(step.profileName, step._tableRow || {}, vars);
        }

        if (!targetProfile) throw new Error('switch-profile: нужен profileName или profileList');

        const scope = step.scope || 'this';
        const gotoUrl = vars._macro_start_url || null;
        const timeoutMs = parseInt(step.timeoutMs || '120000');
        const proxy = vars._current_proxy || null;

        broadcastStatus(wss, { type: 'profile-switching', path, scope, profile: targetProfile });

        if (scope === 'all') {
          const targets = Array.from(activeExecIds);
          requestGlobalBrowserInit({ scope, profileName: targetProfile, proxy, gotoUrl, timeoutMs }, targets);
          if (execContext) {
            await applyPendingBrowserInitIfNeeded(execContext);
            p = execContext.page;
          }
        } else {
          if (execContext) {
            await restartExecContext(execContext, { profileName: targetProfile, proxy, gotoUrl, timeoutMs });
            p = execContext.page;
          } else {
            p = await ensureBrowser(targetProfile);
            if (gotoUrl) await p.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          }
        }

        vars['_current_profile'] = targetProfile;
        broadcastStatus(wss, { type: 'profile-switched', path, scope, profile: targetProfile });
        break;
      }

      case 'read-table': {
        // AC9: resolve all fields
        const tblName = resolveVars(step.tableName || '', step._tableRow || {}, vars);
        const tblSettings = loadSettings();
        const table = tblSettings.dataTables?.[tblName];
        if (!table) throw new Error(`Таблица "${tblName}" не найдена`);
        const rowIdx = parseInt(resolveVars(String(step.rowIndex || '0'), step._tableRow || {}, vars));
        const colName = resolveVars(step.columnName || '', step._tableRow || {}, vars);
        const colIdx = table.headers.indexOf(colName);
        if (colIdx === -1) throw new Error(`Колонка "${colName}" не найдена в таблице "${tblName}"`);
        if (rowIdx < 0 || rowIdx >= table.rows.length) throw new Error(`Строка ${rowIdx} вне диапазона (0-${table.rows.length - 1})`);
        const cellValue = table.rows[rowIdx][colIdx] || '';
        if (step.saveAs) {
          vars[step.saveAs] = cellValue;
          broadcastStatus(wss, { type: 'var-saved', path, varName: step.saveAs, value: cellValue });
        }
        break;
      }

      case 'set-variable': {
        // AC9: resolve varName target and value
        const varName = resolveVars(step.varName || step.saveAs || '', step._tableRow || {}, vars);
        const value = resolveVars(step.value || '', step._tableRow || {}, vars);
        const setMode = step.setMode || 'replace';

        if (!varName) throw new Error(`set-variable: не указано имя переменной`);

        if (setMode === 'append') {
          vars[varName] = (vars[varName] || '') + value;
        } else if (setMode === 'prepend') {
          vars[varName] = value + (vars[varName] || '');
        } else {
          vars[varName] = value;
        }

        broadcastStatus(wss, { type: 'var-saved', path, varName, value: vars[varName] });
        break;
      }

      case 'assert': {
        // Fail-fast condition check: if condition is true, succeed; otherwise throw.
        const ok = evaluateCondition(step, step._tableRow || {}, vars);
        if (!ok) {
          const msg = resolveVars(step.message || '', step._tableRow || {}, vars)
            || `Assert failed: ${step.conditionVar || ''} ${step.operator || 'not-empty'} ${step.compareValue || ''}`;
          throw new Error(msg);
        }
        broadcastStatus(wss, { type: 'assert-passed', path, conditionVar: step.conditionVar, operator: step.operator });
        break;
      }

      case 'screenshot': {
        // Take a runtime PNG screenshot of the current page (or full page).
        const macroId = currentMacroId ? String(currentMacroId) : 'adhoc';
        const macroDir = join(RUNTIME_SNAPSHOTS_DIR, macroId);
        mkdirSync(macroDir, { recursive: true });
        const prefix = (resolveVars(step.saveAs || '', step._tableRow || {}, vars) || 'shot').replace(/[^\w.\-]+/g, '_');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${prefix}-${ts}.png`;
        const fullPath = join(macroDir, filename);
        const fullPage = !!step.fullPage;
        await p.screenshot({ path: fullPath, fullPage });
        const relPath = `runtime/${macroId}/${filename}`;
        broadcastStatus(wss, { type: 'screenshot-saved', path, file: relPath, fullPage });
        if (step.saveAs) vars[step.saveAs] = relPath;
        break;
      }

      case 'extract': {
        // Pull a regex group from a source (variable reference or literal) into a variable.
        const sourceText = resolveVars(step.source || '', step._tableRow || {}, vars);
        const pattern = step.pattern || '';
        const flags = step.flags || 'i';
        const groupIdx = parseInt(step.group ?? '1');
        const target = step.saveAs || '_extracted';
        let result = '';
        if (pattern) {
          try {
            const re = new RegExp(pattern, flags);
            const m = re.exec(sourceText);
            if (m) result = (groupIdx === 0 ? m[0] : (m[groupIdx] ?? '')) || '';
          } catch (regexErr) {
            throw new Error(`extract: bad regex "${pattern}" (${regexErr.message})`);
          }
        }
        vars[target] = result;
        broadcastStatus(wss, { type: 'var-saved', path, varName: target, value: result });
        break;
      }

      case 'break':
        // Don't broadcast step-completed here — break/continue are control flow,
        // not normal completable steps. The catch block below also skips them.
        throw new BreakError();

      case 'continue':
        throw new ContinueError();

      case 'delay': {
        // Fixed delayMs wins; otherwise fall back to delayMin/Max range (seconds).
        let waitMs = 0;
        if (step.delayMs !== undefined && step.delayMs !== '') {
          waitMs = parseInt(resolveVars(String(step.delayMs), step._tableRow || {}, vars)) || 0;
        } else {
          const minS = parseFloat(step.delayMin ?? 0) || 0;
          const maxS = parseFloat(step.delayMax ?? 0) || 0;
          if (maxS > 0) {
            const lo = Math.min(minS, maxS) * 1000;
            const hi = Math.max(minS, maxS) * 1000;
            waitMs = Math.round(lo + Math.random() * (hi - lo));
          }
        }
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        break;
      }

      case 'set-cookie': {
        const name = resolveVars(step.cookieName || '', step._tableRow || {}, vars);
        const value = resolveVars(step.cookieValue || '', step._tableRow || {}, vars);
        if (!name) throw new Error('set-cookie: cookieName обязателен');
        let domain = resolveVars(step.cookieDomain || '', step._tableRow || {}, vars);
        if (!domain) {
          try { domain = new URL(p.url()).hostname; } catch { domain = ''; }
        }
        const cookie = {
          name,
          value,
          domain,
          path: step.cookiePath || '/',
        };
        const expSec = parseInt(step.cookieExpires);
        if (Number.isFinite(expSec) && expSec > 0) {
          cookie.expires = Math.floor(Date.now() / 1000) + expSec;
        }
        await context.addCookies([cookie]);
        broadcastStatus(wss, { type: 'cookie-set', path, name, domain });
        break;
      }

      case 'clear-cookies': {
        const domain = resolveVars(step.cookieDomain || '', step._tableRow || {}, vars);
        if (domain) {
          await context.clearCookies({ domain });
        } else {
          await context.clearCookies();
        }
        broadcastStatus(wss, { type: 'cookies-cleared', path, domain: domain || '*' });
        break;
      }

      case 'tab-open': {
        const url = resolveVars(step.url || '', step._tableRow || {}, vars);
        const newPage = await context.newPage();
        if (url) await newPage.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        page = newPage;
        const idx = context.pages().indexOf(newPage);
        if (step.saveAs) vars[step.saveAs] = String(idx);
        broadcastStatus(wss, { type: 'tab-opened', path, index: idx, url: newPage.url() });
        break;
      }

      case 'tab-switch': {
        const pages = context.pages();
        let target = null;
        const urlMatch = resolveVars(step.tabUrlContains || '', step._tableRow || {}, vars);
        if (urlMatch) {
          target = pages.find(pg => pg.url().includes(urlMatch));
        }
        if (!target && step.tabIndex !== undefined && step.tabIndex !== '') {
          const idx = parseInt(resolveVars(String(step.tabIndex), step._tableRow || {}, vars));
          if (Number.isFinite(idx) && pages[idx]) target = pages[idx];
        }
        if (!target) throw new Error(`tab-switch: вкладка не найдена (index=${step.tabIndex}, urlContains=${urlMatch})`);
        await target.bringToFront().catch(() => {});
        page = target;
        broadcastStatus(wss, { type: 'tab-switched', path, index: pages.indexOf(target), url: target.url() });
        break;
      }

      case 'tab-close': {
        const pages = context.pages();
        let target = p;
        if (step.tabIndex !== undefined && step.tabIndex !== '') {
          const idx = parseInt(resolveVars(String(step.tabIndex), step._tableRow || {}, vars));
          if (Number.isFinite(idx) && pages[idx]) target = pages[idx];
        }
        const wasCurrent = target === p;
        await target.close().catch(() => {});
        if (wasCurrent) {
          const remaining = context.pages();
          if (remaining.length > 0) {
            page = remaining[remaining.length - 1];
            await page.bringToFront().catch(() => {});
          }
        }
        broadcastStatus(wss, { type: 'tab-closed', path });
        break;
      }

      case 'hover': {
        if (useCurrentElement) {
          await currentElement.hover({ timeout: defaultTimeout });
        } else {
          await p.locator(selector).first().hover({ timeout: defaultTimeout });
        }
        break;
      }

      case 'eval-js': {
        const code = step.code || '';
        if (!code) throw new Error('eval-js: code пустой');
        // page.evaluate accepts a function body via `new Function` semantics — wrap as async fn.
        const fn = new Function(`return (async () => { ${code} })();`);
        const result = await p.evaluate(`(${fn.toString()})()`);
        if (step.saveAs) {
          vars[step.saveAs] = (typeof result === 'string') ? result : JSON.stringify(result ?? '');
          broadcastStatus(wss, { type: 'var-saved', path, varName: step.saveAs, value: vars[step.saveAs] });
        }
        break;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }

    await p.waitForTimeout(300);
    broadcastStatus(wss, { type: 'step-completed', path, success: true });
    return { success: true, path };
  } catch (e) {
    // Control-flow exceptions (break/continue) are not failures — don't broadcast as such.
    if (e instanceof BreakError || e instanceof ContinueError) throw e;
    broadcastStatus(wss, { type: 'step-completed', path, success: false, error: e.message });
    throw e;
  }
}

// Recursively execute a list of steps (supports nesting)
// execContext: optional { vars, browser, context } for parallel execution (avoids globals)
async function executeSteps(p, steps, wss, basePath = '', tableRow = {}, currentElement = null, depth = 0, execContext = null) {
  const results = [];
  const currentSettings = loadSettings();
  const defaultTimeout = currentSettings.timeout || 30000;
  // When execContext is provided, use its vars; otherwise fall back to global runtimeVars
  const vars = execContext ? execContext.vars : runtimeVars;

  for (let i = 0; i < steps.length; i++) {
    // If a nested step restarted the execution context, always continue with the latest page.
    if (execContext?.page) p = execContext.page;

    // Guard: stop loops quickly if the page/context was force-closed.
    // NOTE: we only guard here for control-flow/container steps.
    // Atomic steps do their own guard in executeAtomicStep (after lazy page creation)
    // to avoid double-checking and to keep ordering correct.
    const a = steps?.[i]?.action;
    const isControlFlow = a === 'loop' || a === 'loop-table' || a === 'loop-elements' || a === 'if' || a === 'try-except';
    if (isControlFlow && a !== 'browser-init') {
      ensureLivePage(p, execContext);
    }

    if (stopRequested) {
      throw new Error('STOP_REQUESTED');
    }

    const step = { ...steps[i], _tableRow: tableRow };
    const path = basePath ? `${basePath}.${i}` : `${i}`;

    // AC10: Skip disabled steps
    if (step.disabled) {
      broadcastStatus(wss, { type: 'step-skipped', path, step: { action: step.action } });
      continue;
    }

    // Debug pause before each step
    await debugPause(path, depth);

    const sendVarsUpdate = () => {
      sendDebug({ action: 'variables', variables: { ...vars } });
    };

    if (step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements') {
      // --- ЕР"ИНЫЙ ОР'Р АР'ОТЧИК ЦИКЛОР' ---
      const mode = step.action === 'loop-table' ? 'table'
                 : step.action === 'loop-elements' ? 'elements'
                 : (step.loopMode || 'elements');

      if (mode === 'table') {
        // AC9: resolve tableName
        const tblName = resolveVars(step.tableName || '', tableRow, vars);
        const refreshEachIteration = step.refreshEachIteration || false;
        const settings = loadSettings();
        const table = settings.dataTables?.[tblName];
        if (!table || !table.rows?.length) {
          broadcastStatus(wss, { type: 'step-completed', path, success: true, skipped: true, reason: `Таблица "${tblName}" пуста` });
          continue;
        }
        const maxRows = step.maxRows ? parseInt(step.maxRows) : 0;

        if (refreshEachIteration) {
          // Dynamic mode: re-read table from disk on each iteration
          const totalEstimate = maxRows > 0 ? Math.min(maxRows, table.rows.length) : table.rows.length;
          broadcastStatus(wss, { type: 'loop-started', path, loopType: 'table', tableName: tblName, total: totalEstimate, dynamic: true });

          let tableBreak = false;
          let iteration = 0;
          while (true) {
            if (tableBreak) break;
            // Re-read settings from disk to get fresh table data
            const freshSettings = loadSettings();
            const freshTable = freshSettings.dataTables?.[tblName];
            if (!freshTable || !freshTable.rows?.length || iteration >= freshTable.rows.length) break;
            if (maxRows > 0 && iteration >= maxRows) break;

            const rowVars = {};
            freshTable.headers.forEach((h, idx) => {
              rowVars[h] = freshTable.rows[iteration][idx] || '';
            });
            Object.assign(vars, rowVars);

            const currentTotal = maxRows > 0 ? Math.min(maxRows, freshTable.rows.length) : freshTable.rows.length;
            broadcastStatus(wss, { type: 'loop-iteration', path, iteration: iteration + 1, total: currentTotal, rowVars, dynamic: true });

            const children = step.children || [];
            try {
              await executeSteps(p, children, wss, `${path}.children`, { ...tableRow, ...rowVars }, currentElement, depth + 1, execContext);
            } catch (loopErr) {
              if (loopErr instanceof BreakError) { tableBreak = true; continue; }
              if (loopErr instanceof ContinueError) { iteration++; continue; }
              throw loopErr;
            }
            sendVarsUpdate();
            iteration++;

            // Check if there are more rows after re-reading (for delay decision)
            const nextSettings = loadSettings();
            const nextTable = nextSettings.dataTables?.[tblName];
            const hasMore = nextTable && nextTable.rows?.length > iteration && (maxRows <= 0 || iteration < maxRows);

            if (hasMore && step.delayMin) {
              const delayMin = parseInt(step.delayMin || '1') * 1000;
              const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
              const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
              broadcastStatus(wss, { type: 'loop-delay', path, delayMs: delay, nextIteration: iteration + 1 });
              await p.waitForTimeout(delay);
            }
          }

          broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'table', totalIterations: iteration, dynamic: true });
        } else {
          // Static mode: read once, iterate over snapshot
          const totalRows = maxRows > 0 ? Math.min(maxRows, table.rows.length) : table.rows.length;

          broadcastStatus(wss, { type: 'loop-started', path, loopType: 'table', tableName: tblName, total: totalRows });

          let tableBreak = false;
          for (let r = 0; r < totalRows; r++) {
            if (tableBreak) break;
            const rowVars = {};
            table.headers.forEach((h, idx) => {
              rowVars[h] = table.rows[r][idx] || '';
            });
            Object.assign(vars, rowVars);

            broadcastStatus(wss, { type: 'loop-iteration', path, iteration: r + 1, total: totalRows, rowVars });

            const children = step.children || [];
            try {
              await executeSteps(p, children, wss, `${path}.children`, { ...tableRow, ...rowVars }, currentElement, depth + 1, execContext);
            } catch (loopErr) {
              if (loopErr instanceof BreakError) { tableBreak = true; continue; }
              if (loopErr instanceof ContinueError) { continue; }
              throw loopErr;
            }
            sendVarsUpdate();

            if (r < totalRows - 1 && step.delayMin) {
              const delayMin = parseInt(step.delayMin || '1') * 1000;
              const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
              const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
              broadcastStatus(wss, { type: 'loop-delay', path, delayMs: delay, nextIteration: r + 2 });
              await p.waitForTimeout(delay);
            }
          }

          broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'table', totalIterations: totalRows });
        }

      } else if (mode === 'elements') {
        const selector = resolveSelector(resolveVars(step.cssSelector || step.selector || '', tableRow, vars));
        if (!selector) {
          broadcastStatus(wss, { type: 'step-completed', path, success: false, error: `loop-elements: нет селектора` });
          continue;
        }

        try {
          await p.waitForSelector(selector, { timeout: parseInt(step.waitTimeout || String(defaultTimeout)) });
        } catch (e) {
          broadcastStatus(wss, { type: 'step-completed', path, success: true, skipped: true, reason: `Элементы не найдены: ${selector}` });
          continue;
        }

        const elements = await p.$$(selector);
        const maxElements = step.maxElements ? parseInt(step.maxElements) : 0;
        const refreshEachIteration = step.refreshEachIteration || false;
        const total = maxElements > 0 ? Math.min(maxElements, elements.length) : elements.length;

        broadcastStatus(wss, { type: 'loop-started', path, loopType: 'elements', selector, total: refreshEachIteration ? `в€ћ` : total });

        let elemBreak = false;
        let e = 0;
        while (true) {
          if (elemBreak) break;
          if (maxElements > 0 && e >= maxElements) break;

          // Re-query elements each iteration (DOM may change)
          let currentElements;
          try {
            currentElements = await p.$$(selector);
          } catch (err) {
            broadcastStatus(wss, { type: 'loop-error', path, iteration: e + 1, error: `Не удалось найти элементы после навигации` });
            break;
          }

          if (refreshEachIteration) {
            // Dynamic mode: stop when no more elements at current index
            if (e >= currentElements.length) break;
          } else {
            // Static mode: bounded by initial total
            if (e >= total) break;
            if (e >= currentElements.length) {
              broadcastStatus(wss, { type: 'loop-error', path, iteration: e + 1, error: `Элемент [${e}] больше не существует (осталось ${currentElements.length})` });
              break;
            }
          }

          const el = currentElements[e];
          const dynamicTotal = refreshEachIteration ? currentElements.length : total;

          if (step.varName) {
            try {
              const txt = await el.textContent();
              vars[step.varName] = (txt || '').trim();
            } catch (err) {}
          }

          vars['_loop_index'] = e;
          vars['_loop_total'] = dynamicTotal;

          broadcastStatus(wss, { type: 'loop-iteration', path, iteration: e + 1, total: dynamicTotal, elementText: vars[step.varName] || '' });

          const children = step.children || [];
          try {
            await executeSteps(p, children, wss, `${path}.children`, tableRow, el, depth + 1, execContext);
          } catch (loopErr) {
            if (loopErr instanceof BreakError) { elemBreak = true; e++; continue; }
            if (loopErr instanceof ContinueError) { e++; continue; }
            throw loopErr;
          }
          sendVarsUpdate();

          e++;
          if (step.delayMin) {
            const delayMin = parseInt(step.delayMin || '1') * 1000;
            const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
            const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
            broadcastStatus(wss, { type: 'loop-delay', path, delayMs: delay, nextIteration: e + 1 });
            await p.waitForTimeout(delay);
          }
        }

        broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'elements', totalIterations: e });

      } else if (mode === 'count') {
        // AC9: resolve count through vars
        const count = parseInt(resolveVars(String(step.count || '1'), tableRow, vars));
        broadcastStatus(wss, { type: 'loop-started', path, loopType: 'count', total: count });

        let countBreak = false;
        for (let c = 0; c < count; c++) {
          if (countBreak) break;
          vars['_loop_index'] = c;
          vars['_loop_total'] = count;
          broadcastStatus(wss, { type: 'loop-iteration', path, iteration: c + 1, total: count });

          const children = step.children || [];
          try {
            await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement, depth + 1, execContext);
          } catch (loopErr) {
            if (loopErr instanceof BreakError) { countBreak = true; continue; }
            if (loopErr instanceof ContinueError) { continue; }
            throw loopErr;
          }
          sendVarsUpdate();

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
        const maxIterations = parseInt(step.maxIterations || '1000');
        let iteration = 0;

        broadcastStatus(wss, { type: 'loop-started', path, loopType: 'while' });

        let whileBreak = false;
        while (evaluateCondition(step, tableRow, vars) && iteration < maxIterations && !whileBreak) {
          vars['_loop_index'] = iteration;
          broadcastStatus(wss, { type: 'loop-iteration', path, iteration: iteration + 1 });

          const children = step.children || [];
          try {
            await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement, depth + 1, execContext);
          } catch (loopErr) {
            if (loopErr instanceof BreakError) { whileBreak = true; continue; }
            if (loopErr instanceof ContinueError) { iteration++; continue; }
            throw loopErr;
          }
          sendVarsUpdate();
          iteration++;

          if (step.delayMin) {
            const delayMin = parseInt(step.delayMin || '1') * 1000;
            const delayMax = parseInt(step.delayMax || step.delayMin || '3') * 1000;
            const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
            await p.waitForTimeout(delay);
          }
        }

        if (iteration >= maxIterations) {
          broadcastStatus(wss, { type: 'loop-warning', path, message: `Цикл while остановлен: достигнут лимит ${maxIterations} итераций` });
        }
        broadcastStatus(wss, { type: 'loop-completed', path, loopType: 'while', totalIterations: iteration });
      }

      // AC3 FIX: After handling a loop/block step, continue to next sibling.
      // The loop handler already executed children вЂ" do NOT fall through to atomic handler.
      continue;

    } else if (step.action === 'if') {
      const condResult = evaluateCondition(step, tableRow, vars);
      broadcastStatus(wss, { type: 'condition-evaluated', path, result: condResult, conditionVar: step.conditionVar, operator: step.operator });
      sendDebug({ action: 'condition', stepId: path, result: condResult });

      if (condResult) {
        const children = step.children || [];
        await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement, depth + 1, execContext);
      } else if (step.elseChildren && step.elseChildren.length > 0) {
        await executeSteps(p, step.elseChildren, wss, `${path}.elseChildren`, tableRow, currentElement, depth + 1, execContext);
      }

    } else if (step.action === 'try-except') {
      broadcastStatus(wss, { type: 'step-executing', path, step: { action: 'try-except' } });

      const tryTimeoutMs = Math.max(0, parseInt(step.tryTimeoutMs, 10) || 0);
      let tryTimedOut = false;

      try {
        const children = step.children || [];

        if (tryTimeoutMs > 0) {
          // Best-effort timeout: we cannot forcibly cancel already running Playwright operations,
          // but we can stop awaiting further nested steps by racing with a timer.
          let timeoutId = null;
          const timeoutPromise = new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              tryTimedOut = true;
              resolve('try-timeout');
            }, tryTimeoutMs);
          });

          try {
            await Promise.race([
              (async () => {
                await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement, depth + 1, execContext);
                return 'try-done';
              })(),
              timeoutPromise,
            ]);
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }

          if (tryTimedOut) {
            broadcastStatus(wss, { type: 'try-timeout-skip', path, timeoutMs: tryTimeoutMs });
            // Expose a flag so macros can guard against accidental double-actions after timeout
            // (best-effort; does not cancel already-running operations)
            vars.__try_timed_out = 1;
            vars.__try_timeout_ms = tryTimeoutMs;
            broadcastStatus(wss, { type: 'var-saved', varName: '__try_timed_out', value: '1' });
            broadcastStatus(wss, { type: 'var-saved', varName: '__try_timeout_ms', value: String(tryTimeoutMs) });
            // Skip the rest of try body and continue after the try-except block.
            // Do NOT throw; do NOT run except; finally still runs below.
          } else {
            broadcastStatus(wss, { type: 'step-completed', path, success: true });
          }
        } else {
          await executeSteps(p, children, wss, `${path}.children`, tableRow, currentElement, depth + 1, execContext);
          broadcastStatus(wss, { type: 'step-completed', path, success: true });
        }
      } catch (err) {
        if (err instanceof BreakError || err instanceof ContinueError) throw err;

        const errorMsg = err.message || String(err);
        broadcastStatus(wss, { type: 'step-completed', path, success: false, error: `Try failed: ${errorMsg}` });

        if (step.exceptError) {
          vars[step.exceptError] = errorMsg;
          broadcastStatus(wss, { type: 'var-saved', varName: step.exceptError, value: errorMsg });
        }

        const onError = step.onError || 'continue';
        if (onError === 'stop') {
          throw err;
        } else if (onError === 'custom' && step.exceptChildren && step.exceptChildren.length > 0) {
          broadcastStatus(wss, { type: 'step-executing', path: `${path}.except`, step: { action: 'except' } });
          await executeSteps(p, step.exceptChildren, wss, `${path}.exceptChildren`, tableRow, currentElement, depth + 1, execContext);
        }
      }

      if (step.finallyChildren && step.finallyChildren.length > 0) {
        broadcastStatus(wss, { type: 'step-executing', path: `${path}.finally`, step: { action: 'finally' } });
        await executeSteps(p, step.finallyChildren, wss, `${path}.finallyChildren`, tableRow, currentElement, depth + 1, execContext);
      }

    } else {
      // --- ATOMIC STEP ---
      const result = await executeAtomicStep(p, step, path, wss, currentElement, execContext);
      // If the step restarted/replaced the page (browser-init / switch-profile / proxy-apply), sync local page reference
      if (execContext?.page) p = execContext.page;
      results.push(result);
      sendVarsUpdate();
    }
  }

  return results;
}

// ==================== Python Execution ====================
async function executePython(code, variables, wss, path) {
  const runId = randomUUID().slice(0, 8);
  // Each Python execution gets its own subdirectory to prevent file lock conflicts
  // (e.g., when a Python block writes to a CSV that loop-table also reads)
  const pyWorkDir = join(TEMP_DIR, `py_${runId}`);
  mkdirSync(pyWorkDir, { recursive: true });
  const varsInFile = join(pyWorkDir, `vars_in.json`);
  const varsOutFile = join(pyWorkDir, `vars_out.json`);
  const scriptFile = join(pyWorkDir, `script.py`);

  writeFileSync(varsInFile, JSON.stringify(variables || {}));

  const wrapper = `
import json, sys, os

_vars_in_path = ${JSON.stringify(varsInFile)}
_vars_out_path = ${JSON.stringify(varsOutFile)}

with open(_vars_in_path, 'r', encoding='utf-8') as f:
    _macro_vars = json.load(f)

_original_keys = set(_macro_vars.keys())
for _k, _v in _macro_vars.items():
    globals()[_k] = _v

# ====== USER CODE START ======
${code}
# ====== USER CODE END ======

_out = {}
for _k in set(list(_original_keys) + [k for k in dir() if not k.startswith('_') and k not in ('json', 'sys', 'os', 'f')]):
    try:
        _val = globals().get(_k)
        if _val is not None and not callable(_val) and not isinstance(_val, type) and _k not in ('json', 'sys', 'os'):
            json.dumps(_val)
            _out[_k] = _val
    except (TypeError, ValueError):
        pass

with open(_vars_out_path, 'w', encoding='utf-8') as f:
    json.dump(_out, f, ensure_ascii=False)
`;

  writeFileSync(scriptFile, wrapper);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('python3', [scriptFile], {
      timeout: 30000,
      cwd: pyWorkDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', MACRO_DATA_DIR: DATA_ROOT, MACRO_TEMP_DIR: pyWorkDir }
    });

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      broadcastStatus(wss, { type: 'python-output', path, output: chunk.trimEnd() });
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      let outVars = {};
      try {
        if (existsSync(varsOutFile)) {
          outVars = JSON.parse(readFileSync(varsOutFile, 'utf-8'));
        }
      } catch (e) {}

      // Clean up the entire unique workdir
      try { rmSync(pyWorkDir, { recursive: true, force: true }); } catch (e) {}

      if (exitCode !== 0) {
        const lines = stderr.trim().split('\n');
        let errorMsg = lines[lines.length - 1] || 'Unknown error';
        const userErrors = lines.filter(l => !l.includes('_vars_in_path') && !l.includes('_vars_out_path') && !l.includes('_macro_vars'));
        if (userErrors.length > 0) {
          errorMsg = userErrors.slice(-3).join('\n');
        }
        resolve({ error: errorMsg, output: stdout, variables: outVars });
      } else {
        resolve({ output: stdout, variables: outVars, error: null });
      }
    });

    proc.on('error', (err) => {
      try { rmSync(pyWorkDir, { recursive: true, force: true }); } catch (e) {}
      resolve({ error: `Не удалось запустить Python: ${err.message}`, output: '', variables: {} });
    });
  });
}

export async function runMacro(macro, wss, profileName = null, options = {}) {
  // HARD TIMEOUT: guarantee we return (or throw) within a bounded time.
  // Default: 120s. Can be overridden via options.timeoutMs.
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
  const watchdog = createHardTimeout(timeoutMs, `macro:${macro?.id || macro?.name || 'unknown'}`);

  // If first step is browser-init, delay browser creation so we don't flash an unproxied window.
  let p = null;
  runtimeVars = {};
  // Important: previous Stop/forced close should not block new runs
  stopRequested = false;
  currentMacroId = macro?.id || null;

  // AC8: Load persistent variables at start
  const persistentVars = loadPersistentVars();
  Object.assign(runtimeVars, persistentVars);

  // Create execution context for non-global variable passing
  const execContext = { execId: 'main', page: null, context: null, browser: null, vars: runtimeVars };
  activeExecIds.add('main');

  // Expose macro startUrl to steps via vars (used by browser-init/switch-profile/proxy apply)
  runtimeVars._macro_start_url = macro.startUrl || 'about:blank';
  if (profileName) runtimeVars._current_profile = profileName;

  console.log(`рџљЂ Running macro:`, macro.name, '| steps:', macro.steps.length);

  const firstAction = macro.steps?.[0]?.action;

  const execPromise = (async () => {
    if (firstAction !== 'browser-init') {
      p = await ensureBrowser(profileName);
      execContext.page = p;
      execContext.context = context;
      execContext.browser = browser;

      if (macro.startUrl && macro.startUrl !== 'about:blank') {
        await p.goto(macro.startUrl, { waitUntil: 'domcontentloaded' });
      }
    }

    broadcastStatus(wss, { type: 'macro-started', macroId: macro.id, totalSteps: macro.steps.length });

    const results = await executeSteps(p, macro.steps, wss, '', {}, null, 0, execContext);

    // AC8: Save persistent variables back after execution
    const currentPersistent = loadPersistentVars();
    let changed = false;

    // Update existing keys
    for (const key of Object.keys(currentPersistent)) {
      if (runtimeVars[key] !== undefined && runtimeVars[key] !== currentPersistent[key]) {
        currentPersistent[key] = runtimeVars[key];
        changed = true;
      }
    }

    // Persist any vars with prefix p_ automatically
    for (const [k, v] of Object.entries(runtimeVars)) {
      if (!k.startsWith('p_')) continue;
      if (currentPersistent[k] !== v) {
        currentPersistent[k] = v;
        changed = true;
      }
    }

    if (changed) savePersistentVars(currentPersistent);

    return results;
  })();

  try {
    const results = await Promise.race([execPromise, watchdog.timeoutPromise]);
    return results;
  } catch (e) {
    if (e instanceof HardTimeoutError) {
      const lastStep = {
        path: lastStepPath,
        action: lastStepAction,
        at: lastStepAt ? new Date(lastStepAt).toISOString() : null
      };

      const diag = await collectRunDiagnostics({
        page: execContext.page || p,
        context: execContext.context || context,
        browser: execContext.browser || browser,
        reason: e.message,
        label: 'macro',
        runId: macro?.id,
        lastStep
      });

      console.log('?? HARD TIMEOUT DIAGNOSTICS:', JSON.stringify(diag));
      broadcastStatus(wss, { type: 'macro-timeout', macroId: macro.id, error: e.message, diagnostics: diag, lastStep });

      await forceClosePlaywright({
        page: execContext.page || p,
        context: execContext.context || context,
        browser: execContext.browser || browser
      });

      // Reset globals so future runs can start cleanly.
      browser = null; context = null; page = null;

      throw e;
    }

    throw e;
  } finally {
    watchdog.clear();
    activeExecIds.delete('main');
    broadcastStatus(wss, { type: 'macro-completed', macroId: macro.id });
  }
}

export async function runStep(step, wss, profileName = null) {
  stopRequested = false;
  const p = await ensureBrowser(profileName);
  const execContext = { page: p, context, browser, vars: runtimeVars };
  if (step.children || step.action === 'loop' || step.action === 'loop-table' || step.action === 'loop-elements' || step.action === 'if' || step.action === 'try-except') {
    return executeSteps(p, [step], wss, '', {}, null, 0, execContext);
  }
  return executeAtomicStep(p, step, '0', wss, null, execContext);
}

export async function runUpTo(macro, upToIndex, wss, profileName = null) {
  stopRequested = false;
  const p = await ensureBrowser(profileName);
  runtimeVars = {};

  // AC8: Load persistent variables
  const persistentVars = loadPersistentVars();
  Object.assign(runtimeVars, persistentVars);

  const execContext = { page: p, context, browser, vars: runtimeVars };

  if (macro.startUrl) {
    await p.goto(macro.startUrl, { waitUntil: 'domcontentloaded' });
  }

  const steps = macro.steps.slice(0, upToIndex + 1);
  broadcastStatus(wss, { type: 'macro-started', macroId: macro.id, totalSteps: steps.length });

  const results = await executeSteps(p, steps, wss, '', {}, null, 0, execContext);

  broadcastStatus(wss, { type: 'macro-completed', macroId: macro.id });
  return results;
}

export async function runMacroLoop(macro, wss, { times = 1, tableName = '', delayMin = 3, delayMax = 10, profileName = null, fingerprintPerIteration = false, fingerprintSafeMode = true } = {}) {
  // If first step is browser-init, delay browser creation so we don't open an unproxied window.
  let p = null;
  currentMacroId = macro?.id || null;
  const firstAction = macro.steps?.[0]?.action;
  if (firstAction !== 'browser-init') {
    p = await ensureBrowser(profileName);
  }
  const allResults = [];
  const settings = loadSettings();
  const table = tableName ? settings.dataTables?.[tableName] : null;
  // BUG FIX: When table is provided, times=0 means "all rows" (default).
  // Previously times defaulted to 1, causing only first row to be processed.
  const totalIterations = table ? (times > 0 ? Math.min(times, table.rows.length) : table.rows.length) : times;

  broadcastStatus(wss, { type: 'loop-started', totalIterations });

  for (let i = 0; i < totalIterations; i++) {
    runtimeVars = {};
    stopRequested = false;

    // AC8: Load persistent variables each iteration
    const persistentVars = loadPersistentVars();
    Object.assign(runtimeVars, persistentVars);

    let tableRow = {};
    if (table && table.rows[i]) {
      table.headers.forEach((h, idx) => { tableRow[h] = table.rows[i][idx] || ''; });
    }
    Object.assign(runtimeVars, tableRow);

    // Create execution context for this iteration
    const execContext = { execId: 'main', page: p, context: p ? context : null, browser: p ? browser : null, vars: runtimeVars };

    // Guard: if previous iteration was killed by hard-timeout/stopCurrentRun,
    // do not keep looping on a dead page.
    // IMPORTANT: ensureLivePage must see execContext.page (and not execContext=null).
    if (firstAction !== 'browser-init') {
      p = ensureLivePage(p, execContext);
      execContext.page = p;
    }
    activeExecIds.add('main');
    runtimeVars._macro_start_url = macro.startUrl || 'about:blank';
    if (profileName) runtimeVars._current_profile = profileName;

    broadcastStatus(wss, { type: 'loop-iteration', iteration: i + 1, total: totalIterations, tableRow });

    // If we didn't run browser-init as the first step, do the legacy pre-navigation.
    if (macro.startUrl && firstAction !== 'browser-init') {
      const resolvedUrl = resolveVars(macro.startUrl, tableRow);
      await p.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      // Auto-dismiss any modal overlay (Telegram shows popups on load)
      try {
        await p.waitForTimeout(2000);
        await p.evaluate(() => {
          document.querySelectorAll('.modal-backdrop, .Modal.open, .popup-container').forEach(el => el.remove());
        });
        // Also press Escape just in case
        await p.keyboard.press('Escape');
        await p.waitForTimeout(500);
      } catch(e) { /* ignore */ }
    }

    let iterationError = null;
    let retriedUiMissing = false;
    try {
      await executeSteps(p, macro.steps, wss, '', tableRow, null, 0, execContext);
    } catch (e) {
      iterationError = String(e?.message || e);

      // If Telegram Web renders a blank white shell, do an aggressive recovery: restart Playwright context and retry once.
      if (!retriedUiMissing && iterationError.includes('TELEGRAM_UI_MISSING')) {
        retriedUiMissing = true;
        try {
          // Track consecutive blank-shell events; if they repeat, try flipping profile (tg <-> tg2)
          runtimeVars.__tg_ui_missing_streak = (parseInt(runtimeVars.__tg_ui_missing_streak || '0', 10) || 0) + 1;

          broadcastStatus(wss, { type: 'warn', message: `TELEGRAM_UI_MISSING: restarting browser context and retrying once (streak=${runtimeVars.__tg_ui_missing_streak})` });
          try { await stopCurrentRun('loop-iteration-telegram-ui-missing'); } catch (e2) {}

          let effectiveProfile = runtimeVars?._current_profile || profileName;
          if (!effectiveProfile) effectiveProfile = 'tg2';

          // If UI-missing repeats, flip profile to simulate a fresh/incognito-like environment.
          if (runtimeVars.__tg_ui_missing_streak >= 2) {
            const flipped = String(effectiveProfile) === 'tg2' ? 'tg' : 'tg2';
            effectiveProfile = flipped;
            runtimeVars._current_profile = effectiveProfile;
          }

          try { clearTelegramWebSiteData(effectiveProfile); } catch (e3) {}
          p = await ensureBrowser(effectiveProfile);
          execContext.page = p;
          iterationError = null;
          await executeSteps(p, macro.steps, wss, '', tableRow, null, 0, execContext);
        } catch (eRetry) {
          iterationError = String(eRetry?.message || eRetry);
        }
      }

      // If Playwright context was closed mid-iteration, attempt to recover for the next row.
      const closed = iterationError && iterationError.includes('Target page, context or browser has been closed');
      if (closed) {
        try { await stopCurrentRun('loop-iteration-context-closed'); } catch (e2) {}
        try {
          p = await ensureBrowser(profileName);
          execContext.page = p;
        } catch (e3) {
          // If we can't recover, rethrow to stop the batch.
          throw e;
        }
      }
    }

    // Sync page reference across iterations (browser-init/switch-profile can replace it)
    p = execContext.page;
    allResults.push({ iteration: i + 1, ok: !iterationError, error: iterationError, vars: { ...runtimeVars } });

    // Reset streak when iteration completes without Telegram blank-shell error.
    if (!iterationError || !String(iterationError).includes('TELEGRAM_UI_MISSING')) {
      runtimeVars.__tg_ui_missing_streak = 0;
    }

    // AC8: Save persistent vars after each iteration
    const currentPersistent = loadPersistentVars();
    let changed = false;

    for (const key of Object.keys(currentPersistent)) {
      if (runtimeVars[key] !== undefined && runtimeVars[key] !== currentPersistent[key]) {
        currentPersistent[key] = runtimeVars[key];
        changed = true;
      }
    }

    for (const [k, v] of Object.entries(runtimeVars)) {
      if (!k.startsWith('p_')) continue;
      if (currentPersistent[k] !== v) {
        currentPersistent[k] = v;
        changed = true;
      }
    }

    if (changed) savePersistentVars(currentPersistent);

    if (i < totalIterations - 1) {
      let delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;

      // Backoff on Telegram blank UI to reduce rate-limits / anti-bot blank shells.
      if (iterationError && iterationError.includes('TELEGRAM_UI_MISSING')) {
        delay = Math.max(delay, 15000);
      }

      broadcastStatus(wss, { type: 'loop-delay', delayMs: delay, nextIteration: i + 2 });
      try { if (p) await p.waitForTimeout(delay); } catch (e) { /* ignore */ }
    }
  }

  activeExecIds.delete('main');
  broadcastStatus(wss, { type: 'loop-completed', totalIterations, results: allResults });
  return allResults;
}

export async function launchProfile(profileName) {
  const settings = loadSettings();
  const profile = settings.browserProfiles?.[profileName];
  // AC12: profiles under data/profiles/
  const userDataDir = profile?.path || join(DATA_ROOT, 'profiles', profileName);
  mkdirSync(userDataDir, { recursive: true });

  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; context = null; page = null;

  browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });
  page = browser.pages()[0] || await browser.newPage();
  browser.on('disconnected', () => { browser = null; context = null; page = null; });
  page.on('close', () => { page = null; });

  return page;
}

async function launchWithExtension(profileName = null) {
  const extensionPath = join(__dirname, '..', 'extension');
  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];

  const userDataDir = profileName
    ? join(DATA_ROOT, 'profiles', profileName)
    : join(DATA_ROOT, 'profiles', '_default');

  mkdirSync(userDataDir, { recursive: true });

  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; context = null; page = null;

  browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: 1280, height: 800 },
  });
  page = browser.pages()[0] || await browser.newPage();
  browser.on('disconnected', () => { browser = null; context = null; page = null; });
  page.on('close', () => { page = null; });

  return page;
}

export async function startAppendRecording(macro, fromStepIndex, wss, profileName = null) {
  if (fromStepIndex >= 0) {
    const p = await ensureBrowser(profileName);
    runtimeVars = {};

    const execContext = { page: p, context, browser, vars: runtimeVars };

    if (macro.startUrl && macro.startUrl !== 'about:blank') {
      await p.goto(macro.startUrl, { waitUntil: 'domcontentloaded' });
    }

    const steps = macro.steps.slice(0, fromStepIndex + 1);
    broadcastStatus(wss, { type: 'append-setup', macroId: macro.id, upToStep: fromStepIndex });
    await executeSteps(p, steps, wss, '', {}, null, 0, execContext);
  }

  const extensionPage = await launchWithExtension(profileName);

  if (page && page !== extensionPage) {
    try {
      const currentUrl = await page.url();
      if (currentUrl && currentUrl !== 'about:blank') {
        await extensionPage.goto(currentUrl, { waitUntil: 'domcontentloaded' });
      }
    } catch (e) {
      console.warn('Could not navigate extension page to current URL:', e.message);
    }
  }

  broadcastStatus(wss, { type: 'append-recording-started', macroId: macro.id, fromStep: fromStepIndex });

  return extensionPage;
}

// ==================== Parallel Execution ====================
// Run macro with N parallel browser windows, distributing table rows round-robin
// Each worker gets its own browser and execContext — true parallel execution, no mutex needed
export async function runMacroParallel(macro, wss, { windowCount = 2, tableName = '', delayMin = 3, delayMax = 10, profileName = null, fingerprintPerIteration = false, fingerprintSafeMode = true } = {}) {
  const settings = loadSettings();
  const table = tableName ? settings.dataTables?.[tableName] : null;
  if (!table || !table.rows?.length) {
    throw new Error(`Таблица "${tableName}" не найдена или пуста`);
  }

  const totalRows = table.rows.length;
  const actualWindows = Math.min(windowCount, totalRows);

  broadcastStatus(wss, { type: 'parallel-started', macroId: macro.id, windowCount: actualWindows, totalRows });

  // Distribute rows round-robin across windows
  const windowRows = Array.from({ length: actualWindows }, () => []);
  for (let i = 0; i < totalRows; i++) {
    windowRows[i % actualWindows].push(i); // Store row indices
  }

  // Run each window as a sequential batch, but all windows run truly in parallel
  // Each worker has its own execContext (page, vars) — no shared globals needed
  const allResults = [];
  const workers = [];

  for (let w = 0; w < actualWindows; w++) {
    const rowIndices = windowRows[w];
    const workerPromise = (async () => {
      let workerBrowser = null;
      let workerContext = null;
      let workerPage = null;
      const workerResults = [];

      // Track temp profile dir for cleanup
      let tempProfileDir = null;
      try {
        // Create independent browser
        const fpSettings = settings.fingerprint || {};
        const launchOpts = { headless: false };
        const contextOpts = { viewport: { width: 1280, height: 800 } };

        if (fingerprintPerIteration && fpSettings.enabled) {
          const fp = generateRandomFingerprint(fpSettings, fingerprintSafeMode);
          contextOpts.viewport = fp.viewport;
          contextOpts.userAgent = fp.userAgent;
          contextOpts.locale = fp.locale;
          contextOpts.timezoneId = fp.timezoneId;
        }

        if (profileName) {
          // Use persistent context with profile (same logic as ensureBrowser)
          const profile = settings.browserProfiles?.[profileName];
          const srcDir = profile?.path || join(DATA_ROOT, 'profiles', profileName);
          // Playwright locks userDataDir, so each parallel worker needs its own copy
          tempProfileDir = join(TEMP_DIR, `parallel-profile-${profileName}-w${w}-${Date.now()}`);
          mkdirSync(tempProfileDir, { recursive: true });
          if (existsSync(srcDir)) {
            cpSync(srcDir, tempProfileDir, { recursive: true });
          }
          // launchPersistentContext returns a BrowserContext directly (no separate browser)
          workerContext = await chromium.launchPersistentContext(tempProfileDir, {
            ...launchOpts,
            viewport: contextOpts.viewport,
            userAgent: contextOpts.userAgent,
            locale: contextOpts.locale,
            timezoneId: contextOpts.timezoneId,
          });
          workerBrowser = workerContext; // persistentContext acts as both browser and context
          workerPage = workerContext.pages()[0] || await workerContext.newPage();
        } else {
          workerBrowser = await chromium.launch(launchOpts);
          workerContext = await workerBrowser.newContext(contextOpts);
          workerPage = await workerContext.newPage();
        }

        broadcastStatus(wss, { type: 'parallel-window-started', windowIndex: w, rowCount: rowIndices.length });

        for (let r = 0; r < rowIndices.length; r++) {
          const rowIndex = rowIndices[r];
          const rowData = table.rows[rowIndex];

          // Build row variables
          const rowVars = {};
          table.headers.forEach((h, idx) => { rowVars[h] = rowData[idx] || ''; });

          broadcastStatus(wss, { type: 'parallel-iteration', windowIndex: w, iteration: r + 1, total: rowIndices.length, rowIndex, rowVars });

          try {
            if (macro.startUrl && macro.startUrl !== 'about:blank') {
              // Resolve URL with row vars
              let url = macro.startUrl;
              for (const [k, v] of Object.entries(rowVars)) {
                url = url.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
              }
              await workerPage.goto(url, { waitUntil: 'domcontentloaded' });
            }

            // Execute steps using the worker page with its own execContext (no mutex needed)
            const workerVars = { ...loadPersistentVars(), ...rowVars };
            const execId = `worker:${workerIndex}`;
            const execContext = { execId, page: workerPage, context: workerContext, browser: workerBrowser, vars: workerVars };
            activeExecIds.add(execId);
            workerVars._macro_start_url = macro.startUrl || 'about:blank';
            workerVars._current_profile = profileName || workerVars._current_profile || null;

            try {
              await executeSteps(workerPage, macro.steps, wss, '', rowVars, null, 0, execContext);
              workerResults.push({ windowIndex: w, rowIndex, iteration: r + 1, success: true });
            } catch (err) {
              if (!(err instanceof BreakError) && !(err instanceof ContinueError)) {
                workerResults.push({ windowIndex: w, rowIndex, iteration: r + 1, success: false, error: err.message });
                broadcastStatus(wss, { type: 'parallel-error', windowIndex: w, rowIndex, error: err.message });
              }
            } finally {
              activeExecIds.delete(execId);
            }
          } catch (err) {
            workerResults.push({ windowIndex: w, rowIndex, iteration: r + 1, success: false, error: err.message });
            broadcastStatus(wss, { type: 'parallel-error', windowIndex: w, rowIndex, error: err.message });
          }

          // Delay between iterations within this window
          if (r < rowIndices.length - 1) {
            const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
            await workerPage.waitForTimeout(delay);
          }
        }

        broadcastStatus(wss, { type: 'parallel-window-completed', windowIndex: w, iterations: rowIndices.length });
      } catch (err) {
        broadcastStatus(wss, { type: 'parallel-window-error', windowIndex: w, error: err.message });
      } finally {
        try { if (workerBrowser) await workerBrowser.close(); } catch (e) {}
        // Clean up temporary profile copy
        if (tempProfileDir) {
          try { rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
        }
      }

      return workerResults;
    })();
    workers.push(workerPromise);
  }

  // Wait for all workers to complete
  const results = await Promise.allSettled(workers);
  results.forEach(r => {
    if (r.status === 'fulfilled') allResults.push(...r.value);
  });

  broadcastStatus(wss, { type: 'parallel-completed', macroId: macro.id, totalResults: allResults.length });
  return allResults;
}

// ==================== Fingerprint Randomization ====================
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 },
  { width: 1680, height: 1050 },
];

const TIMEZONES = [
  'Europe/Moscow', 'Europe/London', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo',
  'Asia/Shanghai', 'Australia/Sydney',
];

const LOCALES = ['en-US', 'en-GB', 'ru-RU', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'zh-CN'];

const WEBGL_VENDORS = [
  'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Google Inc. (Intel)',
  'Google Inc. (NVIDIA Corporation)', 'Google Inc. (ATI Technologies Inc.)',
];

const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64'];

// Safe mode: DON'T change fingerprint at all between iterations.
// Any change вЂ" even minor Chrome version or timezone вЂ" can trigger session logouts
// on sites like Telegram that fingerprint the browser aggressively.
// Returns a completely static fingerprint based on the user's configured settings.
function generateSafeFingerprint(baseSettings = {}) {
  const baseUA = baseSettings.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const baseTZ = baseSettings.timezone || 'Europe/Moscow';

  return {
    userAgent: baseUA, // Keep EXACTLY the same вЂ" no version changes
    viewport: (() => {
      if (baseSettings.screenResolution) {
        const [w, h] = baseSettings.screenResolution.split('x').map(Number);
        return { width: w || 1920, height: h || 1080 };
      }
      return { width: 1920, height: 1080 };
    })(),
    locale: baseSettings.language || 'ru-RU',
    timezoneId: baseTZ, // Keep EXACTLY the same timezone вЂ" no randomization
    platform: baseSettings.platform || 'Win32',
    hardwareConcurrency: baseSettings.hardwareConcurrency || 8,
    deviceMemory: baseSettings.deviceMemory || 8,
    webglVendor: baseSettings.webglVendor || 'Google Inc. (NVIDIA)',
  };
}

// Aggressive mode: randomizes everything (may trigger session logouts on sites like Telegram)
function generateRandomFingerprint(baseSettings = {}, safeMode = false) {
  if (safeMode) return generateSafeFingerprint(baseSettings);

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  return {
    userAgent: baseSettings.userAgent || pick(USER_AGENTS),
    viewport: (() => {
      if (baseSettings.screenResolution && baseSettings.screenResolution !== '1920x1080') {
        const [w, h] = baseSettings.screenResolution.split('x').map(Number);
        return { width: w || 1920, height: h || 1080 };
      }
      return pick(VIEWPORTS);
    })(),
    locale: baseSettings.language || pick(LOCALES),
    timezoneId: baseSettings.timezone || pick(TIMEZONES),
    platform: baseSettings.platform || pick(PLATFORMS),
    hardwareConcurrency: baseSettings.hardwareConcurrency || pick([2, 4, 8, 12, 16]),
    deviceMemory: baseSettings.deviceMemory || pick([2, 4, 8, 16]),
    webglVendor: baseSettings.webglVendor || pick(WEBGL_VENDORS),
  };
}

// Apply fingerprint to a browser context via page scripts
async function applyFingerprint(contextOrPage, fp) {
  await contextOrPage.addInitScript((fingerprint) => {
    // Override navigator properties
    Object.defineProperty(navigator, 'platform', { get: () => fingerprint.platform });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fingerprint.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => fingerprint.deviceMemory });

    // Override WebGL
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return fingerprint.webglVendor; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (NVIDIA, GeForce RTX 3060 Direct3D11)'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };
  }, fp);
}

export async function closeBrowser() {
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; context = null; page = null;
}

// ==================== Standalone Debug Mode ====================
if (isDirectDebug) {
  const macroIdArg = process.argv[2];
  const profileArgIdx = process.argv.indexOf('--profile');
  const profileArg = profileArgIdx !== -1 ? process.argv[profileArgIdx + 1] : null;

  if (!macroIdArg) {
    console.error('Usage: node player.js <macroId> --debug [--breakpoints p1,p2] [--profile name]');
    process.exit(1);
  }

  // AC12: Load macro from data/macros/ first, fallback to macros/
  const macroFile = join(DATA_ROOT, 'macros', `${macroIdArg}.json`);
  const legacyMacroFile = join(__dirname, '..', 'macros', `${macroIdArg}.json`);
  const actualMacroFile = existsSync(macroFile) ? macroFile : legacyMacroFile;

  if (!existsSync(actualMacroFile)) {
    console.error(`Macro not found: ${macroIdArg}`);
    process.exit(1);
  }

  const macro = JSON.parse(readFileSync(actualMacroFile, 'utf-8'));
  console.error(`рџђ› Debug mode: "${macro.name}" (${macro.steps.length} steps)`);
  console.error(`   Breakpoints: ${directBreakpoints.size > 0 ? Array.from(directBreakpoints).join(', ') : 'none'}`);

  (async () => {
    try {
      const p = await ensureBrowser(profileArg);

      const execContext = { page: p, context, browser, vars: runtimeVars };

      if (macro.startUrl && macro.startUrl !== 'about:blank') {
        await p.goto(macro.startUrl, { waitUntil: 'domcontentloaded' });
      }

      await executeSteps(p, macro.steps, null, '', {}, null, 0, execContext);

      sendDebug({ action: 'finished' });
      console.error(`вњ… Debug session complete`);
      await new Promise(() => {});
    } catch (e) {
      if (e instanceof BreakError || e instanceof ContinueError) {
        console.error(`⚠️ ${e.message} outside of loop`);
      } else {
        console.error(`вќЊ Error: ${e.message}`);
      }
      sendDebug({ action: 'finished' });
      process.exit(1);
    }
  })();
}
