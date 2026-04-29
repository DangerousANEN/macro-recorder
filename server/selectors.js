// Selector resolution and resilient click/fill primitives extracted from
// player.js. These helpers are the moral equivalent of a `SelectorResolver`
// service and a `SmartActions` service in an OOP refactor — but kept as plain
// pure-ish functions because they have no internal mutable state.
//
// Dependencies (passed in or imported):
//   - loadSettings: () => settings    (named selector lookup, debug.clickShots flag)
//   - broadcastStatus: (wss, msg) => void  (WebSocket fan-out)
//   - tempDir: string                  (where to write debug click screenshots)

import { join } from 'path';
import { randomUUID } from 'crypto';
import { loadSettings } from './settings.js';

/**
 * Expand `@savedName` selectors using the user's saved selector dictionary.
 * Returns the input unchanged if it doesn't start with `@`.
 */
export function resolveSelector(selectorStr) {
  if (!selectorStr || typeof selectorStr !== 'string') return selectorStr;
  if (!selectorStr.startsWith('@')) return selectorStr;

  const name = selectorStr.slice(1);
  const settings = loadSettings();
  const saved = settings.savedSelectors?.[name];
  if (saved) return saved;

  console.warn(`⚠️ Именованный селектор не найден: @${name}`);
  return selectorStr;
}

/**
 * Highlight a bounding box on the page and capture a screenshot. Used when
 * `settings.debug.clickShots` is enabled to give the user a visual trail of
 * what got clicked. Returns the screenshot path on success or null on failure.
 */
export async function debugHighlightAndShot(p, box, label, tempDir) {
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

    const shot = join(tempDir, `click-${Date.now()}-${randomUUID().slice(0, 6)}.png`);
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

// Build the list of selector "attempts" honored by both smartClick and smartFill.
// Order: primary CSS → raw recorded → xpath → placeholder → user fallbacks → site heuristics.
function buildSelectorAttempts(step, selector) {
  const attempts = [];

  if (selector && typeof selector === 'string' && selector.trim()) {
    attempts.push({ kind: 'css', value: selector.trim() });
  }

  const rawSelector = step?.cssSelector || step?.selector;
  if (rawSelector && typeof rawSelector === 'string' && rawSelector.trim() && rawSelector.trim() !== selector?.trim()) {
    attempts.push({ kind: 'css', value: rawSelector.trim() });
  }

  if (step?.xpath && typeof step.xpath === 'string' && step.xpath.trim()) {
    attempts.push({ kind: 'xpath', value: step.xpath.trim() });
  }

  if (step?.placeholder && typeof step.placeholder === 'string' && step.placeholder.trim()) {
    attempts.push({ kind: 'placeholder', value: step.placeholder.trim() });
  }

  // User-supplied fallback selectors (plain CSS strings or {kind, value, name?} objects).
  if (Array.isArray(step?.fallbackSelectors)) {
    for (const fb of step.fallbackSelectors) {
      if (!fb) continue;
      if (typeof fb === 'string') attempts.push({ kind: 'css', value: fb });
      else if (typeof fb === 'object' && fb.kind && fb.value) attempts.push({ ...fb });
    }
  }

  // Telegram Web — both /a/ (legacy id) and /k/ (`.input-search-input`) UIs.
  if ((selector || '').includes('telegram-search-input') || (step?.cssSelector || '').includes('telegram-search-input')) {
    attempts.push({ kind: 'placeholder', value: 'Search' });
    attempts.push({ kind: 'role', value: 'textbox', name: 'Search' });
    attempts.push({ kind: 'css', value: '.input-search-input, input.input-search-input' });
    attempts.push({ kind: 'css', value: 'input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i], [contenteditable="true"][role="textbox"]' });
  }

  return attempts;
}

function locatorFor(p, attempt) {
  if (attempt.kind === 'css') return p.locator(attempt.value).first();
  if (attempt.kind === 'xpath') return p.locator(`xpath=${attempt.value}`).first();
  if (attempt.kind === 'placeholder') return p.getByPlaceholder(attempt.value, { exact: true }).first();
  if (attempt.kind === 'role') return p.getByRole(attempt.value, { name: attempt.name, exact: true }).first();
  return null;
}

/**
 * Click `selector`. If it fails, fall through alternative locators (raw CSS,
 * xpath, placeholder, user fallbackSelectors, Telegram heuristics). On success
 * broadcasts `click-ok`; on full failure throws with the last error.
 */
export async function smartClick(p, step, selector, timeout, wss, path, opts = {}) {
  const { broadcastStatus, tempDir } = opts;
  const attempts = buildSelectorAttempts(step, selector);
  const errors = [];

  for (const a of attempts) {
    try {
      const loc = locatorFor(p, a);
      if (!loc) continue;
      await loc.waitFor({ state: 'visible', timeout });

      // Optional debug screenshot of the click target.
      const settings = loadSettings();
      if (settings?.debug?.clickShots && tempDir) {
        const box = await loc.boundingBox().catch(() => null);
        const shot = await debugHighlightAndShot(p, box, `click ${path} :: ${a.kind}`, tempDir);
        if (shot && wss && broadcastStatus) {
          broadcastStatus(wss, { type: 'click-shot', path, method: a.kind, selector: a.value, screenshot: shot });
        }
        if (shot) console.log('🟥 click-shot', JSON.stringify({ path, method: a.kind, selector: a.value, screenshot: shot }));
      }

      await loc.click({ timeout, force: true });

      const active = await p.evaluate(() => {
        const ae = document.activeElement;
        return {
          tag: ae?.tagName || null,
          id: ae?.id || null,
          className: typeof ae?.className === 'string' ? ae.className : null,
          placeholder: ae?.getAttribute ? ae.getAttribute('placeholder') : null,
          ariaLabel: ae?.getAttribute ? ae.getAttribute('aria-label') : null,
        };
      }).catch(() => null);

      console.log('🖱️ click-ok', JSON.stringify({ path, method: a.kind, selector: a.value, active }, null, 0));
      if (wss && broadcastStatus) broadcastStatus(wss, { type: 'click-ok', path, method: a.kind, selector: a.value, active });
      return;
    } catch (e) {
      errors.push({ method: a.kind, selector: a.value, error: String(e?.message || e) });
    }
  }

  if (wss && broadcastStatus) broadcastStatus(wss, { type: 'click-failed', path, selector, attempts: errors.slice(0, 6) });
  const last = errors[errors.length - 1];
  throw new Error(last?.error || `Click failed: ${selector}`);
}

/**
 * Fill `value` into `selector` with the same fallback chain as smartClick.
 */
export async function smartFill(p, step, selector, value, timeout, wss, path, opts = {}) {
  const { broadcastStatus } = opts;
  const attempts = buildSelectorAttempts(step, selector);
  const errors = [];

  for (const a of attempts) {
    try {
      const loc = locatorFor(p, a);
      if (!loc) continue;
      await loc.waitFor({ state: 'visible', timeout });
      await loc.fill(String(value ?? ''), { timeout });
      if (wss && broadcastStatus) broadcastStatus(wss, { type: 'fill-ok', path, method: a.kind, selector: a.value });
      return;
    } catch (e) {
      errors.push({ method: a.kind, selector: a.value, error: String(e?.message || e) });
    }
  }

  if (wss && broadcastStatus) broadcastStatus(wss, { type: 'fill-failed', path, selector, attempts: errors.slice(0, 6) });
  const last = errors[errors.length - 1];
  throw new Error(last?.error || `Fill failed: ${selector}`);
}
