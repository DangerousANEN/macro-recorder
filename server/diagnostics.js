import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Store dumps in data/.tmp (same as player TEMP_DIR)
const DATA_ROOT = join(__dirname, '..', 'data');
const TEMP_DIR = join(DATA_ROOT, '.tmp');

export async function collectRunDiagnostics({ page, context, browser, reason = 'unknown', label = 'macro', runId = null, lastStep = null } = {}) {
  const ts = Date.now();
  const id = runId || `${label}-${ts}`;
  const base = join(TEMP_DIR, `timeout-${id}`);

  const diag = {
    id,
    reason,
    lastStep,
    timestamp: new Date(ts).toISOString(),
    url: null,
    title: null,
    screenshotPath: null,
    htmlPath: null,
    contextPages: null,
  };

  try {
    const p = page || (context ? context.pages?.()[0] : null);
    if (p) {
      diag.url = await p.url().catch(() => null);
      diag.title = await p.title().catch(() => null);

      // Screenshot
      const pngPath = base + '.png';
      await p.screenshot({ path: pngPath, fullPage: true }).catch(() => null);
      diag.screenshotPath = pngPath;

      // HTML
      const htmlPath = base + '.html';
      const html = await p.content().catch(() => null);
      if (html) {
        const fs = await import('fs');
        fs.writeFileSync(htmlPath, html, 'utf-8');
        diag.htmlPath = htmlPath;
      }
    }
  } catch (e) {
    diag.collectError = String(e?.message || e);
  }

  try {
    if (context?.pages) {
      const pages = context.pages();
      diag.contextPages = [];
      for (const p of pages) {
        diag.contextPages.push({ url: await p.url().catch(() => null) });
      }
    }
  } catch (e) {}

  return diag;
}

export async function forceClosePlaywright({ page, context, browser } = {}) {
  // Close from leaf to root; swallow errors.
  try { if (page) await page.close({ runBeforeUnload: false }).catch(() => {}); } catch (e) {}
  try { if (context) await context.close().catch(() => {}); } catch (e) {}
  try { if (browser) await browser.close().catch(() => {}); } catch (e) {}
}
