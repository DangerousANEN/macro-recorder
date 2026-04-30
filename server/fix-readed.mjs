import { readFileSync, writeFileSync } from 'fs';

const f = 'F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\.tmp\\readed.csv';
let lines = readFileSync(f, 'utf-8').split('\n').map(s => {
  // Remove quotes, BOM, whitespace
  return s.trim().replace(/^\uFEFF/, '').replace(/^"|"$/g, '');
}).filter(Boolean);

console.log('Total lines:', lines.length);

// Dedupe
const unique = [...new Set(lines)];
console.log('Unique:', unique.length, 'Removed:', lines.length - unique.length);

// Write clean
writeFileSync(f, unique.join('\n') + '\n');
console.log('Done. First 3:', unique.slice(0, 3));
console.log('Last 3:', unique.slice(-3));
