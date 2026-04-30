#!/usr/bin/env node
// Smoke test: spawn the server, hit core endpoints, assert HTTP 200 and that all
// new block JSON definitions are present. Exits 0 on PASS, non-zero on any failure.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const port = process.env.SMOKE_PORT || '3700';
const base = `http://127.0.0.1:${port}`;

const REQUIRED_BLOCKS = [
  'click', 'type', 'read', 'wait', 'navigate', 'scroll', 'press-key',
  'loop', 'if', 'try-except', 'set-variable', 'break', 'continue',
  'assert', 'screenshot', 'extract',
  'browser-init', 'switch-profile', 'debug-dump',
];

let failures = 0;
const log = (label, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`[${tag}] ${label}${detail ? ' — ' + detail : ''}`);
};

async function fetchOk(path) {
  const res = await fetch(base + path);
  return { ok: res.ok, status: res.status, body: res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text() };
}

async function waitReady(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(base + '/api/macros');
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: port, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

const cleanup = async (code = 0) => {
  try { child.kill('SIGTERM'); } catch {}
  await sleep(200);
  try { child.kill('SIGKILL'); } catch {}
  if (failures > 0) {
    console.log('\n--- server output (tail) ---');
    console.log(serverOut.slice(-2000));
  }
  process.exit(code);
};

try {
  const ready = await waitReady();
  log('server boots and /api/macros responds', ready);
  if (!ready) await cleanup(1);

  for (const ep of ['/api/macros', '/api/blocks', '/api/settings', '/api/variables']) {
    const r = await fetchOk(ep);
    log(`GET ${ep} → ${r.status}`, r.ok);
  }

  const blocksRes = await fetchOk('/api/blocks');
  if (blocksRes.ok && typeof blocksRes.body === 'object') {
    for (const b of REQUIRED_BLOCKS) {
      log(`/api/blocks has "${b}"`, !!blocksRes.body[b]);
    }
  } else {
    log('/api/blocks returns JSON object', false);
  }

  // Round-trip export/import on a tiny throwaway macro.
  const created = await fetch(base + '/api/macros', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-test', steps: [] }),
  }).then(r => r.json()).catch(() => null);
  log('POST /api/macros creates macro', !!created?.id);

  if (created?.id) {
    const exp = await fetch(`${base}/api/macros/${created.id}/export`);
    log(`GET /api/macros/${created.id}/export → 200`, exp.ok);
    const exported = await exp.json().catch(() => null);
    log('exported macro has steps array', Array.isArray(exported?.steps));

    if (exported) {
      const imp = await fetch(base + '/api/macros/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exported, id: undefined, name: 'smoke-import' }),
      });
      log('POST /api/macros/import → 201', imp.status === 201);
      const impBody = await imp.json().catch(() => ({}));
      if (impBody.id) {
        await fetch(`${base}/api/macros/${impBody.id}`, { method: 'DELETE' });
      }
    }
    await fetch(`${base}/api/macros/${created.id}`, { method: 'DELETE' });
  }

  console.log(failures === 0 ? '\nSMOKE TEST: PASS' : `\nSMOKE TEST: FAIL (${failures} failures)`);
  await cleanup(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('smoke-test crashed:', err);
  await cleanup(2);
}
