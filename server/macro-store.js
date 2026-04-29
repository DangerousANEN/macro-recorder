import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// IMPORTANT: do NOT depend on process.cwd().
// The server is often started from `server/`, so cwd would point to the wrong root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DATA_ROOT = join(PROJECT_ROOT, 'data');
const DATA_DIR = join(DATA_ROOT, 'macros');
const LEGACY_DATA_DIR = join(PROJECT_ROOT, 'macros');

function macroPath(id) { return join(DATA_DIR, `${id}.json`); }

export function loadMacro(id) {
  const p = macroPath(id);
  if (!existsSync(p)) {
    const legacyPath = join(LEGACY_DATA_DIR, `${id}.json`);
    if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, 'utf-8'));
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function saveMacro(macro) {
  writeFileSync(macroPath(macro.id), JSON.stringify(macro, null, 2));
}
