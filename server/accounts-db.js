/**
 * Accounts Database Module — CSV persistence for registration results
 * AC11-AC14: Account tracking with file locking
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '..', 'data');
const ACCOUNTS_DIR = join(DATA_ROOT, 'accounts');

// Ensure accounts directory exists
mkdirSync(ACCOUNTS_DIR, { recursive: true });

const REGISTERED_CSV = join(ACCOUNTS_DIR, 'registered.csv');
const FAILED_CSV = join(ACCOUNTS_DIR, 'failed.csv');
const IN_PROGRESS_CSV = join(ACCOUNTS_DIR, 'in-progress.csv');
const BLOCKED_IPS_CSV = join(ACCOUNTS_DIR, 'blocked-ips.csv');
const STATS_FILE = join(ACCOUNTS_DIR, 'stats.json');

// CSV headers
const REGISTERED_HEADERS = 'phone,username,session_data,proxy_used,created_at';
const FAILED_HEADERS = 'phone,reason,step_failed,timestamp';
const IN_PROGRESS_HEADERS = 'phone,sms_id,started_at,status';
const BLOCKED_IPS_HEADERS = 'ip,blocked_at,reason,fail_count';

// UTF-8 BOM for Excel compatibility (AC: TC6)
const BOM = '\uFEFF';

// ==================== File locking (AC13) ====================
function lockPath(filePath) { return filePath + '.lock'; }

async function acquireLock(filePath, timeoutMs = 5000) {
  const lp = lockPath(filePath);
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    if (!existsSync(lp)) {
      try {
        writeFileSync(lp, String(process.pid), { flag: 'wx' });
        return true;
      } catch (e) {
        // Lock exists, wait
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  
  // Force acquire on timeout (stale lock)
  try {
    writeFileSync(lp, String(process.pid));
    return true;
  } catch (e) {
    return false;
  }
}

function releaseLock(filePath) {
  const lp = lockPath(filePath);
  try { unlinkSync(lp); } catch (e) {}
}

// ==================== CSV helpers (TC6) ====================
function escapeCSV(val) {
  const s = String(val || '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function ensureCSVFile(filePath, headers) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, BOM + headers + '\n', 'utf-8');
  }
}

function readCSVRows(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return []; // Only header
  return lines.slice(1).map(parseCSVLine);
}

function appendCSVRow(filePath, headers, values) {
  ensureCSVFile(filePath, headers);
  const row = values.map(escapeCSV).join(',');
  appendFileSync(filePath, row + '\n', 'utf-8');
}

// ==================== Init files ====================
export function initAccountsDB() {
  ensureCSVFile(REGISTERED_CSV, REGISTERED_HEADERS);
  ensureCSVFile(FAILED_CSV, FAILED_HEADERS);
  ensureCSVFile(IN_PROGRESS_CSV, IN_PROGRESS_HEADERS);
  ensureCSVFile(BLOCKED_IPS_CSV, BLOCKED_IPS_HEADERS);
  
  if (!existsSync(STATS_FILE)) {
    writeFileSync(STATS_FILE, JSON.stringify(getDefaultStats(), null, 2), 'utf-8');
  }
}

function getDefaultStats() {
  return {
    total_attempts: 0,
    successful: 0,
    failed: 0,
    success_rate: 0,
    average_time_seconds: 0,
    failures_by_reason: {},
    last_updated: new Date().toISOString(),
  };
}

// ==================== Stats (AC12) ====================
export function loadStats() {
  if (!existsSync(STATS_FILE)) return getDefaultStats();
  try {
    return JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
  } catch (e) {
    return getDefaultStats();
  }
}

export function saveStats(stats) {
  stats.last_updated = new Date().toISOString();
  if (stats.total_attempts > 0) {
    stats.success_rate = Math.round((stats.successful / stats.total_attempts) * 100 * 100) / 100;
  }
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

// ==================== Account operations (AC13, AC14) ====================

/**
 * Add account to in-progress
 */
export async function addInProgress(phone, smsId) {
  await acquireLock(IN_PROGRESS_CSV);
  try {
    appendCSVRow(IN_PROGRESS_CSV, IN_PROGRESS_HEADERS, [
      phone, smsId, new Date().toISOString(), 'active'
    ]);
  } finally {
    releaseLock(IN_PROGRESS_CSV);
  }
}

/**
 * Save registered account (AC14: moves from in-progress to registered)
 */
export async function saveRegistered(phone, username = '', sessionData = '', proxyUsed = '') {
  await acquireLock(REGISTERED_CSV);
  try {
    appendCSVRow(REGISTERED_CSV, REGISTERED_HEADERS, [
      phone, username, sessionData, proxyUsed, new Date().toISOString()
    ]);
  } finally {
    releaseLock(REGISTERED_CSV);
  }
  
  // Remove from in-progress
  await removeInProgress(phone);
  
  // Update stats
  await updateStatsSuccess();
}

/**
 * Save failed account (AC14: moves from in-progress to failed)
 */
export async function saveFailed(phone, reason = '', stepFailed = '') {
  await acquireLock(FAILED_CSV);
  try {
    appendCSVRow(FAILED_CSV, FAILED_HEADERS, [
      phone, reason, stepFailed, new Date().toISOString()
    ]);
  } finally {
    releaseLock(FAILED_CSV);
  }
  
  // Remove from in-progress
  await removeInProgress(phone);
  
  // Update stats
  await updateStatsFailed(reason);
}

/**
 * Save account based on status
 */
export async function saveAccount({ phone, username, sessionData, status, reason, stepFailed, proxyUsed }) {
  if (status === 'registered' || status === 'success') {
    await saveRegistered(phone, username, sessionData, proxyUsed);
  } else {
    await saveFailed(phone, reason || status, stepFailed);
  }
}

async function removeInProgress(phone) {
  await acquireLock(IN_PROGRESS_CSV);
  try {
    if (!existsSync(IN_PROGRESS_CSV)) return;
    const content = readFileSync(IN_PROGRESS_CSV, 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split('\n');
    const header = lines[0];
    const remaining = lines.slice(1).filter(l => {
      if (!l.trim()) return false;
      const fields = parseCSVLine(l);
      return fields[0] !== phone;
    });
    writeFileSync(IN_PROGRESS_CSV, BOM + header + '\n' + remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf-8');
  } finally {
    releaseLock(IN_PROGRESS_CSV);
  }
}

async function updateStatsSuccess(timeSec = 0) {
  const stats = loadStats();
  stats.total_attempts++;
  stats.successful++;
  if (timeSec > 0) {
    // Running average
    const prevTotal = stats.average_time_seconds * (stats.successful - 1);
    stats.average_time_seconds = Math.round((prevTotal + timeSec) / stats.successful);
  }
  saveStats(stats);
}

async function updateStatsFailed(reason = 'unknown') {
  const stats = loadStats();
  stats.total_attempts++;
  stats.failed++;
  stats.failures_by_reason[reason] = (stats.failures_by_reason[reason] || 0) + 1;
  saveStats(stats);
}

// ==================== Blocked IPs (AC36) ====================
export async function addBlockedIP(ip, reason = '3 consecutive failures') {
  await acquireLock(BLOCKED_IPS_CSV);
  try {
    // Check if already blocked
    const rows = readCSVRows(BLOCKED_IPS_CSV);
    const alreadyBlocked = rows.some(r => r[0] === ip);
    if (!alreadyBlocked) {
      appendCSVRow(BLOCKED_IPS_CSV, BLOCKED_IPS_HEADERS, [
        ip, new Date().toISOString(), reason, '3'
      ]);
    }
  } finally {
    releaseLock(BLOCKED_IPS_CSV);
  }
}

export function isIPBlocked(ip) {
  const rows = readCSVRows(BLOCKED_IPS_CSV);
  return rows.some(r => r[0] === ip);
}

export function isPhoneFailed(phone) {
  const rows = readCSVRows(FAILED_CSV);
  return rows.some(r => r[0] === phone);
}

// ==================== List & query (AC30) ====================
export function listAccounts(status = 'registered', limit = 50, offset = 0) {
  let filePath, headers;
  
  if (status === 'registered') {
    filePath = REGISTERED_CSV;
    headers = REGISTERED_HEADERS.split(',');
  } else if (status === 'failed') {
    filePath = FAILED_CSV;
    headers = FAILED_HEADERS.split(',');
  } else if (status === 'in-progress') {
    filePath = IN_PROGRESS_CSV;
    headers = IN_PROGRESS_HEADERS.split(',');
  } else {
    return { rows: [], total: 0, headers: [] };
  }
  
  const allRows = readCSVRows(filePath);
  const total = allRows.length;
  const rows = allRows.slice(offset, offset + limit).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
  
  return { rows, total, headers };
}

// ==================== Monitoring (AC35, AC36) ====================

// Track recent results for success rate monitoring
const recentResults = []; // Array of {success: boolean, proxy: string, timestamp: number}

export function trackResult(success, proxy = '') {
  recentResults.push({ success, proxy, timestamp: Date.now() });
  // Keep only last 100 results
  while (recentResults.length > 100) recentResults.shift();
}

/**
 * Check if success rate is below threshold (AC35)
 * @param {number} threshold - Min success rate % (default 30)
 * @param {number} windowSize - Number of recent attempts to check (default 20)
 * @returns {{warning: boolean, rate: number, shouldDoubleDelay: boolean}}
 */
export function checkSuccessRate(threshold = 30, windowSize = 20) {
  const recent = recentResults.slice(-windowSize);
  if (recent.length < windowSize) {
    return { warning: false, rate: 100, shouldDoubleDelay: false };
  }
  
  const successes = recent.filter(r => r.success).length;
  const rate = Math.round((successes / recent.length) * 100);
  
  return {
    warning: rate < threshold,
    rate,
    shouldDoubleDelay: rate < threshold,
  };
}

/**
 * Check for consecutive proxy failures (AC36)
 * @param {string} proxy - Proxy identifier
 * @param {number} maxConsecutive - Max consecutive failures before blocking (default 3)
 * @returns {boolean} - true if proxy should be blocked
 */
export function shouldBlockProxy(proxy, maxConsecutive = 3) {
  if (!proxy) return false;
  
  const proxyResults = recentResults.filter(r => r.proxy === proxy);
  if (proxyResults.length < maxConsecutive) return false;
  
  // Check last N results for this proxy
  const lastN = proxyResults.slice(-maxConsecutive);
  return lastN.every(r => !r.success);
}

// ==================== Export helpers ====================
export function getAccountsDir() { return ACCOUNTS_DIR; }
export function getRegisteredPath() { return REGISTERED_CSV; }
export function getFailedPath() { return FAILED_CSV; }
