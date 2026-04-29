import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';

function splitCsvLine(line) {
  // Minimal CSV splitter supporting quotes.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function escapeCsvValue(v) {
  const s = (v ?? '') === null ? '' : String(v ?? '');
  if (/[\r\n,\"]/g.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function loadBotsCsv(csvPath) {
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  // drop trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length === 0) return { headers: [], rows: [] };

  const first = splitCsvLine(lines[0]);
  // If first line looks like header (contains 'username' or 'botname'), treat as header.
  const firstLower = first.map(s => String(s).trim().toLowerCase());
  const hasHeader = firstLower.includes('username') || firstLower.includes('botname');

  const headers = hasHeader ? first.map(s => String(s).trim()) : ['username'];
  const startIdx = hasHeader ? 1 : 0;

  const rows = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    // Pad to headers length
    while (cols.length < headers.length) cols.push('');
    rows.push(cols);
  }

  return { headers, rows };
}

export function saveBotsCsv(csvPath, { headers, rows }) {
  const tmp = csvPath + '.tmp';
  const outLines = [];
  outLines.push(headers.map(escapeCsvValue).join(','));
  for (const r of rows) {
    const cols = [...r];
    while (cols.length < headers.length) cols.push('');
    outLines.push(cols.map(escapeCsvValue).join(','));
  }
  writeFileSync(tmp, outLines.join('\r\n') + '\r\n', 'utf-8');
  // atomic-ish replace on Windows
  if (existsSync(csvPath)) {
    try { renameSync(csvPath, csvPath + '.bak'); } catch (e) {}
  }
  renameSync(tmp, csvPath);
}

export function ensureColumns(headers, required) {
  const out = [...headers];
  const idx = {};
  for (let i = 0; i < out.length; i++) idx[out[i]] = i;
  for (const col of required) {
    if (idx[col] === undefined) {
      idx[col] = out.length;
      out.push(col);
    }
  }
  return { headers: out, idx };
}

export function detectUsernameColumn(headers) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  let i = lower.indexOf('username');
  if (i !== -1) return i;
  i = lower.indexOf('botname');
  if (i !== -1) return i;
  return 0;
}
