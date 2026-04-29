import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadMacro } from './macro-store.js';
import { runMacroLoop, stopCurrentRun } from './player.js';
import { loadBotsCsv, saveBotsCsv, ensureColumns, detectUsernameColumn } from './bots-csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DATA_ROOT = join(PROJECT_ROOT, 'data');

export async function processBotsCsv({
  csvPath = join(DATA_ROOT, '.tmp', 'bots.csv'),
  limit = 50,
  macroId = 'tg4-adv-bots-001',
  profileName = null,
  startOffset = 0,
} = {}) {
  const macro = loadMacro(macroId);
  if (!macro) throw new Error(`Macro not found: ${macroId}`);

  const csv = loadBotsCsv(csvPath);
  const { headers, rows } = csv;
  const { headers: headers2, idx } = ensureColumns(headers, ['status', 'last_checked_at', 'notes']);

  const userCol = detectUsernameColumn(headers2);

  // Find next rows that need processing (status empty)
  const toProcessIdx = [];
  for (let i = startOffset; i < rows.length; i++) {
    const r = rows[i];
    const status = (r[idx.status] || '').trim();
    const uname = (r[userCol] || '').trim();
    if (!uname) continue;
    if (!status) toProcessIdx.push(i);
    if (toProcessIdx.length >= limit) break;
  }

  if (toProcessIdx.length === 0) {
    return {
      ok: true,
      processed: 0,
      message: 'No pending rows',
      csvPath,
      macroId,
      startOffset,
      nextStartOffset: startOffset,
    };
  }

  // Build a temporary dataTable "bots" with selected rows, run macro loop on that table.
  // Minimal invasive: we avoid changing macro; it already loops tableName=bots.
  const tableHeaders = ['botname', '_row_index'];
  const tableRows = toProcessIdx.map(i => {
    const uname = String(rows[i][userCol] || '').trim();
    return [uname, String(i)];
  });

  // Patch settings.json dataTables.bots
  const settingsPath = join(DATA_ROOT, 'settings.json');
  const settings = JSON.parse((await import('fs')).readFileSync(settingsPath, 'utf-8'));
  settings.dataTables = settings.dataTables || {};
  settings.dataTables.bots = { headers: tableHeaders, rows: tableRows };
  (await import('fs')).writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Run macro loop for exactly N rows
  // NOTE: runMacroLoop historically had no hard timeout and could hang on Playwright launch/navigation.
  // Add a hard timeout wrapper so /api/bots/process always returns.
  const HARD_TIMEOUT_MS = parseInt(process.env.BOTS_PROCESS_TIMEOUT_MS || '180000', 10);

  const results = await (async () => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`BOTS_PROCESS_TIMEOUT_${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        runMacroLoop(macro, null, {
          times: tableRows.length,
          tableName: 'bots',
          // Small default pacing to reduce Telegram Web blank shells / rate limits.
          delayMin: parseInt(process.env.BOTS_DELAY_MIN || '2', 10),
          delayMax: parseInt(process.env.BOTS_DELAY_MAX || '4', 10),
          profileName,
        }),
        timeoutPromise,
      ]);
    } catch (e) {
      // Best-effort stop/cleanup so next run can proceed.
      try { await stopCurrentRun('bots-process-timeout-or-error'); } catch (e2) {}
      throw e;
    }
  })();

  // If runMacroLoop returns fewer results than expected (e.g. hard-timeout), still map best-effort by index.
  if (Array.isArray(results) && results.length !== toProcessIdx.length) {
    console.warn(`⚠️ bots-process: results mismatch (expected ${toProcessIdx.length}, got ${results.length})`);
  }

  const nowIso = new Date().toISOString();

  // Map back results to CSV
  // IMPORTANT: Don't rely on macro-set vars like _row_index; just map by iteration order.
  // results[i] corresponds to toProcessIdx[i] (we generated the table rows in that order).
  for (let i = 0; i < toProcessIdx.length; i++) {
    const r = results?.[i] || {};
    const vars = r?.vars || {};
    const csvRowIndex = toProcessIdx[i];

    // Best-effort status vars. If macro doesn't set them, we still mark as checked.
    let status = (vars.status || vars.bot_status || vars.check_status || '').toString().trim();
    let notes = (vars.notes || vars.bot_notes || vars.check_notes || vars.reason || '').toString().trim();

    // If iteration failed, explicitly mark it.
    // IMPORTANT: always surface the error even if macro already set bot_notes (otherwise failures look like skips).
    if (r.ok === false) {
      status = 'failed';
      const errText = (r.error ? String(r.error) : 'iteration failed').slice(0, 700);
      notes = notes ? `${errText}; ${notes}` : errText;
    }

    if (!Number.isFinite(csvRowIndex) || csvRowIndex < 0 || csvRowIndex >= rows.length) continue;

    while (rows[csvRowIndex].length < headers2.length) rows[csvRowIndex].push('');
    rows[csvRowIndex][idx.status] = status || 'checked';
    rows[csvRowIndex][idx.last_checked_at] = nowIso;
    if (notes) rows[csvRowIndex][idx.notes] = notes;
  }

  saveBotsCsv(csvPath, { headers: headers2, rows });

  const minProcessed = Math.min(...toProcessIdx);
  const maxProcessed = Math.max(...toProcessIdx);
  const nextStartOffset = Number.isFinite(maxProcessed) ? (maxProcessed + 1) : startOffset;

  // Best-effort remaining pending rows count AFTER nextStartOffset (helps batching/monitoring).
  let pendingRemaining = 0;
  for (let i = nextStartOffset; i < rows.length; i++) {
    const r = rows[i];
    const status = (r[idx.status] || '').trim();
    const uname = (r[userCol] || '').trim();
    if (!uname) continue;
    if (!status) pendingRemaining++;
  }

  return {
    ok: true,
    processed: toProcessIdx.length,
    csvPath,
    macroId,
    startOffset,
    minProcessed,
    maxProcessed,
    nextStartOffset,
    pendingRemaining,
  };
}
