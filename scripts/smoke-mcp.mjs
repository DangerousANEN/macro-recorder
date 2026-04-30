#!/usr/bin/env node
// MCP smoke test: spawn the recorder server, spawn the MCP stdio server, then
// drive the MCP server over stdio with raw JSON-RPC messages to verify that:
//   1. initialize handshake works
//   2. tools/list returns at least the required tools
//   3. tools/call list_macros returns successfully
// Exits 0 on PASS, non-zero otherwise.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const port = process.env.SMOKE_PORT || '3703';
const base = `http://127.0.0.1:${port}`;

const REQUIRED_TOOLS = [
  'list_macros', 'get_macro', 'run_macro', 'stop_macro',
  'list_running', 'list_blocks', 'export_macro', 'import_macro',
];

let failures = 0;
const log = (label, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`[${tag}] ${label}${detail ? ' — ' + detail : ''}`);
};

const recorder = spawn(process.execPath, ['server/index.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: port, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let recorderOut = '';
recorder.stdout.on('data', d => { recorderOut += d.toString(); });
recorder.stderr.on('data', d => { recorderOut += d.toString(); });

async function waitRecorder(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { const r = await fetch(base + '/api/macros'); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

const cleanup = async (code = 0) => {
  try { mcp?.kill('SIGTERM'); } catch {}
  try { recorder.kill('SIGTERM'); } catch {}
  await sleep(200);
  try { mcp?.kill('SIGKILL'); } catch {}
  try { recorder.kill('SIGKILL'); } catch {}
  if (failures > 0) {
    console.log('\n--- recorder output (tail) ---');
    console.log(recorderOut.slice(-1500));
    console.log('\n--- mcp stderr (tail) ---');
    console.log(mcpErr.slice(-1500));
  }
  process.exit(code);
};

let mcp;
let mcpErr = '';
let mcpBuf = '';
const pending = new Map();

async function rpc(method, params, id) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  mcp.stdin.write(msg + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc ${method} timed out`));
      }
    }, 8000);
  });
}

function handleMcpData(chunk) {
  mcpBuf += chunk.toString();
  // Each MCP message is a single JSON object terminated by newline (per stdio transport).
  let nl;
  while ((nl = mcpBuf.indexOf('\n')) !== -1) {
    const line = mcpBuf.slice(0, nl).trim();
    mcpBuf = mcpBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch (e) {
      // Ignore non-JSON noise.
    }
  }
}

try {
  const ready = await waitRecorder();
  log('recorder server boots', ready);
  if (!ready) await cleanup(1);

  mcp = spawn(process.execPath, ['mcp/index.js'], {
    cwd: repoRoot,
    env: { ...process.env, MCP_RECORDER_URL: base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp.stderr.on('data', d => { mcpErr += d.toString(); });
  mcp.stdout.on('data', handleMcpData);
  await sleep(500);

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  }, 1);
  log('MCP initialize handshake', !!init?.serverInfo);

  // Notify initialized (no id, no response).
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {}, 2);
  const names = (tools?.tools || []).map(t => t.name);
  for (const t of REQUIRED_TOOLS) {
    log(`tools/list includes "${t}"`, names.includes(t));
  }

  const callRes = await rpc('tools/call', { name: 'list_macros', arguments: {} }, 3);
  const text = callRes?.content?.[0]?.text;
  log('tools/call list_macros returns text content', typeof text === 'string');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  log('list_macros result is JSON-parseable array', Array.isArray(parsed));

  const blocksRes = await rpc('tools/call', { name: 'list_blocks', arguments: {} }, 4);
  const blocksText = blocksRes?.content?.[0]?.text;
  let blocks = null;
  try { blocks = JSON.parse(blocksText); } catch {}
  log('list_blocks returns the block dictionary', blocks && typeof blocks === 'object' && 'click' in blocks);

  console.log(failures === 0 ? '\nMCP SMOKE: PASS' : `\nMCP SMOKE: FAIL (${failures})`);
  await cleanup(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('mcp smoke crashed:', err);
  await cleanup(2);
}
