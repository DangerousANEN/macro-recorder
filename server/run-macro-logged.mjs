/**
 * Macro runner with detailed logging
 * Logs to: data/.tmp/macro-runner.log
 */
import { runMacroLoop } from './player.js';
import { loadSettings, saveSettings } from './settings.js';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, '..', 'data', '.tmp', 'macro-runner.log');
const STATUS_FILE = join(__dirname, '..', 'data', '.tmp', 'macro-runner-status.json');

function log(msg) {
  const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Novosibirsk' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function setStatus(status, detail = '') {
  const data = {
    status,
    detail,
    timestamp: new Date().toISOString(),
    pid: process.pid
  };
  try { writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

const MACRO_ID = process.argv[2] || 'tg3-rotate-001';
const PROFILE = process.argv[3] || 'tg-acc1';
const TIMES = parseInt(process.argv[4]) || 0; // 0 = all rows
const TABLE = process.argv[5] || 'mixed_bots';

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
  log(`Stack: ${err.stack?.substring(0, 500)}`);
  setStatus('uncaught_exception', err.message);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
  setStatus('unhandled_rejection', String(reason).substring(0, 200));
});

(async () => {
  log('=== MACRO RUNNER START ===');
  log(`Macro: ${MACRO_ID}, Profile: ${PROFILE}, Times: ${TIMES}, Table: ${TABLE}`);
  setStatus('starting', `macro=${MACRO_ID}, profile=${PROFILE}`);

  // Load macro
  const macroPath = join(__dirname, '..', 'data', 'macros', `${MACRO_ID}.json`);
  if (!existsSync(macroPath)) {
    log(`ERROR: Macro file not found: ${macroPath}`);
    setStatus('error', 'Macro file not found');
    process.exit(1);
  }

  let macro;
  try {
    macro = JSON.parse(readFileSync(macroPath, 'utf-8'));
    log(`Macro loaded: "${macro.name}", ${macro.steps.length} steps`);
  } catch(e) {
    log(`ERROR parsing macro: ${e.message}`);
    setStatus('error', `JSON parse: ${e.message}`);
    process.exit(1);
  }

  // Check settings/table and remove already-completed rows
  try {
    const settings = loadSettings();
    const table = settings.dataTables?.[TABLE];
    if (!table) {
      log(`ERROR: Table "${TABLE}" not found in settings`);
      setStatus('error', `Table not found: ${TABLE}`);
      process.exit(1);
    }
    const totalBefore = table.rows?.length || 0;
    log(`Table "${TABLE}": ${totalBefore} rows, headers: ${table.headers}`);
    
    // Load completed bots and remove them from the table
    const completedPath = join(__dirname, '..', 'data', '.tmp', 'completed_botnames.txt');
    let completedSet = new Set();
    if (existsSync(completedPath)) {
      const lines = readFileSync(completedPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
      completedSet = new Set(lines);
    }
    
    // Also load from readed.csv
    const readedPath = join(__dirname, '..', 'data', '.tmp', 'readed.csv');
    if (existsSync(readedPath)) {
      const lines = readFileSync(readedPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
      lines.forEach(l => completedSet.add(l.replace(/"/g, '')));
    }
    
    if (completedSet.size > 0) {
      const before = table.rows.length;
      table.rows = table.rows.filter(row => !completedSet.has(row[0]));
      const removed = before - table.rows.length;
      if (removed > 0) {
        log(`Removed ${removed} already-processed rows. Remaining: ${table.rows.length}`);
        saveSettings(settings);
      }
    }
  } catch(e) {
    log(`ERROR loading settings: ${e.message}`);
    setStatus('error', `Settings: ${e.message}`);
    process.exit(1);
  }

  // Run in batches, rotate profile every ROTATE_EVERY new bots
  const ROTATE_EVERY = 500;
  const BATCH_SIZE = 50; // iterations per batch (then check if rotate needed)
  const PROFILES = ['tg-acc1', 'tg-acc2'];
  const READED_PATH = join(__dirname, '..', 'data', '.tmp', 'readed.csv');
  
  let currentProfile = PROFILE;
  let profileIdx = PROFILES.indexOf(currentProfile);
  if (profileIdx === -1) profileIdx = 0;
  
  let lastRotateReaded = 0;
  try { lastRotateReaded = readFileSync(READED_PATH, 'utf-8').split('\n').filter(Boolean).length; } catch(e) {}
  log(`Starting readed: ${lastRotateReaded}, profile: ${currentProfile}`);
  
  setStatus('running', `Profile: ${currentProfile}`);
  
  let totalIterations = 0;
  
  while (true) {
    // Check if rotation needed
    let currentReaded = 0;
    try { currentReaded = readFileSync(READED_PATH, 'utf-8').split('\n').filter(Boolean).length; } catch(e) {}
    const sinceLast = currentReaded - lastRotateReaded;
    
    if (sinceLast >= ROTATE_EVERY) {
      profileIdx = (profileIdx + 1) % PROFILES.length;
      currentProfile = PROFILES[profileIdx];
      lastRotateReaded = currentReaded;
      log(`🔄 ROTATE to ${currentProfile} (${sinceLast} new bots since last rotate)`);
      setStatus('running', `Rotated to ${currentProfile}, readed: ${currentReaded}`);
    }
    
    // Reload settings and remove processed rows (first BATCH_SIZE rows = already done)
    try {
      const settings = loadSettings();
      const table = settings.dataTables?.[TABLE];
      if (!table || !table.rows.length) {
        log('Table empty — ALL DONE!');
        break;
      }
      // After each batch, the first BATCH_SIZE rows were processed — remove them
      if (totalIterations > 0) {
        const before = table.rows.length;
        table.rows = table.rows.slice(BATCH_SIZE);
        saveSettings(settings);
        log(`Removed ${BATCH_SIZE} processed rows: ${before} -> ${table.rows.length}. Next: ${table.rows[0]?.[0] || 'EMPTY'}`);
      }
      if (!table.rows.length) {
        log('No rows left — ALL DONE!');
        break;
      }
      log(`Table: ${table.rows.length} rows, starting from ${table.rows[0]?.[0]}`);
    } catch(e) { log(`Settings reload error: ${e.message}`); }
    
    // Run batch
    try {
      const result = await runMacroLoop(macro, null, {
        times: BATCH_SIZE,
        tableName: TABLE,
        delayMin: 2,
        delayMax: 4,
        profileName: currentProfile
      });
      const count = Array.isArray(result) ? result.length : 0;
      totalIterations += count;
      log(`Batch done: +${count} (total: ${totalIterations}), readed: ${currentReaded + count}`);
      
      if (count === 0) {
        log('Zero iterations — table might be empty');
        break;
      }
    } catch(e) {
      log(`BATCH CRASH: ${e.message}`);
      log(`Stack: ${e.stack?.substring(0, 300)}`);
      // Don't exit — try to continue with next batch
      log('Retrying after 10s...');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  
  log(`=== ALL DONE: ${totalIterations} total iterations ===`);
  setStatus('completed', `${totalIterations} iterations`);

  log('=== MACRO RUNNER END ===');
  process.exit(0);
})();
