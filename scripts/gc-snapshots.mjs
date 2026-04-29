#!/usr/bin/env node
// Prune old screenshots from data/snapshots/.
//
// Two policies in one pass:
//   1. Time-based: delete files older than --max-age-days (default 7 for runtime,
//      30 for editor snapshots).
//   2. Count-based: keep only the latest --keep files per directory (default 200).
//
// Usage:
//   node scripts/gc-snapshots.mjs                # default: dry-run
//   node scripts/gc-snapshots.mjs --apply        # actually delete
//   node scripts/gc-snapshots.mjs --apply --max-age-days=3 --keep=50
//
// Exit code: 0 always (advisory), prints summary to stdout.

import { readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const dataRoot = process.env.DATA_DIR || join(repoRoot, 'data');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.join('=') || true];
    })
);
const APPLY = !!args.apply;
const RUNTIME_MAX_AGE_DAYS = parseFloat(args['runtime-max-age-days'] || args['max-age-days'] || '7');
const EDITOR_MAX_AGE_DAYS = parseFloat(args['editor-max-age-days'] || args['max-age-days'] || '30');
const KEEP_PER_DIR = parseInt(args['keep'] || '200');

let totalDeleted = 0;
let totalBytesFreed = 0;
let totalKept = 0;

function listFilesRecursive(dir) {
  const out = [];
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...listFilesRecursive(full));
      else if (ent.isFile()) out.push(full);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return out;
}

function gcDirectory(rootDir, maxAgeDays, label) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = listFilesRecursive(rootDir);
  if (files.length === 0) {
    console.log(`[${label}] (empty) ${rootDir}`);
    return;
  }
  // Group by parent directory so per-dir keep policy applies sensibly.
  const byDir = new Map();
  for (const f of files) {
    const parent = dirname(f);
    if (!byDir.has(parent)) byDir.set(parent, []);
    byDir.get(parent).push(f);
  }

  let dirDeleted = 0;
  let dirBytes = 0;
  let dirKept = 0;

  for (const [parent, group] of byDir) {
    // Sort newest first so "keep latest N" works.
    const enriched = group.map(f => {
      try { return { f, st: statSync(f) }; } catch { return null; }
    }).filter(Boolean);
    enriched.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

    enriched.forEach((entry, idx) => {
      const tooOld = entry.st.mtimeMs < cutoff;
      const overKeep = idx >= KEEP_PER_DIR;
      if (tooOld || overKeep) {
        if (APPLY) {
          try { unlinkSync(entry.f); } catch (e) { console.warn('  ! failed to delete', entry.f, e.message); return; }
        }
        dirDeleted++;
        dirBytes += entry.st.size;
      } else {
        dirKept++;
      }
    });

    // Try to remove the now-empty directory (only when applying).
    if (APPLY) {
      try {
        const remaining = readdirSync(parent);
        if (remaining.length === 0 && parent !== rootDir) rmdirSync(parent);
      } catch {}
    }
  }

  totalDeleted += dirDeleted;
  totalBytesFreed += dirBytes;
  totalKept += dirKept;
  console.log(`[${label}] ${dirDeleted} deleted, ${dirKept} kept, ~${(dirBytes / 1024 / 1024).toFixed(1)} MB${APPLY ? ' freed' : ' would free'} (max age ${maxAgeDays}d, keep ${KEEP_PER_DIR}/dir)`);
}

console.log(`Macro Recorder snapshot GC ${APPLY ? '[APPLY]' : '[DRY RUN]'}  data=${dataRoot}`);
gcDirectory(join(dataRoot, 'snapshots', 'runtime'), RUNTIME_MAX_AGE_DAYS, 'runtime');
gcDirectory(join(dataRoot, 'snapshots'), EDITOR_MAX_AGE_DAYS, 'editor');

console.log(`\nTotal: ${totalDeleted} files, ${totalKept} kept, ~${(totalBytesFreed / 1024 / 1024).toFixed(1)} MB${APPLY ? ' freed' : ' would free'}.`);
if (!APPLY && totalDeleted > 0) {
  console.log('Run again with --apply to actually delete.');
}
