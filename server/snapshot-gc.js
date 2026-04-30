// Programmatic snapshot garbage collection used by both the HTTP endpoint
// (`POST /api/snapshots/gc`) and the optional boot-time hook.

import { readdirSync, statSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function listFilesRecursive(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFilesRecursive(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function gcDirectory({ rootDir, maxAgeDays, keepPerDir, apply }) {
  if (!existsSync(rootDir)) return { deleted: 0, kept: 0, bytesFreed: 0 };
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = listFilesRecursive(rootDir);

  const byDir = new Map();
  for (const f of files) {
    const parent = dirname(f);
    if (!byDir.has(parent)) byDir.set(parent, []);
    byDir.get(parent).push(f);
  }

  let deleted = 0;
  let kept = 0;
  let bytesFreed = 0;

  for (const [parent, group] of byDir) {
    const enriched = group
      .map(f => { try { return { f, st: statSync(f) }; } catch { return null; } })
      .filter(Boolean);
    enriched.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

    enriched.forEach((entry, idx) => {
      const tooOld = entry.st.mtimeMs < cutoff;
      const overKeep = idx >= keepPerDir;
      if (tooOld || overKeep) {
        if (apply) {
          try { unlinkSync(entry.f); } catch { return; }
        }
        deleted++;
        bytesFreed += entry.st.size;
      } else {
        kept++;
      }
    });

    if (apply) {
      try {
        const remaining = readdirSync(parent);
        if (remaining.length === 0 && parent !== rootDir) rmdirSync(parent);
      } catch {}
    }
  }

  return { deleted, kept, bytesFreed };
}

/**
 * Run the snapshot GC and return a JSON summary.
 * @param {Object} opts
 * @param {string} opts.snapshotsDir   Path to data/snapshots
 * @param {boolean} opts.apply         If false, count only (dry run).
 * @param {number} opts.runtimeMaxAgeDays  Default 7.
 * @param {number} opts.editorMaxAgeDays   Default 30.
 * @param {number} opts.keepPerDir          Default 200.
 */
export function runSnapshotGc({
  snapshotsDir,
  apply = false,
  runtimeMaxAgeDays = 7,
  editorMaxAgeDays = 30,
  keepPerDir = 200,
}) {
  const runtime = gcDirectory({
    rootDir: join(snapshotsDir, 'runtime'),
    maxAgeDays: runtimeMaxAgeDays,
    keepPerDir,
    apply,
  });
  const editor = gcDirectory({
    rootDir: snapshotsDir,
    maxAgeDays: editorMaxAgeDays,
    keepPerDir,
    apply,
  });
  return {
    apply,
    runtime,
    editor,
    totalDeleted: runtime.deleted + editor.deleted,
    totalKept: runtime.kept + editor.kept,
    totalBytesFreed: runtime.bytesFreed + editor.bytesFreed,
  };
}
