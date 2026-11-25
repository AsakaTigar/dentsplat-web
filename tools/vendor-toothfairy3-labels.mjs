// One-shot vendor: extract the official ToothFairy3 label table out of the saved dataset-page
// copy and write tools/toothfairy3_labels.json. Kept in tools/ (rather than deleted) so the
// provenance of that JSON is reproducible instead of "the assistant typed 77 numbers".
//
//   node tools/vendor-toothfairy3-labels.mjs <path-to-saved-page.md>
//
// The saved page came from WebFetch of https://ditto.ing.unimore.it/toothfairy3/ and is
// markdown-escaped (\[ \{ \_), so escapes are undone before JSON.parse. Values are otherwise
// untouched; nothing here invents an id.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const srcPath = process.argv[2];
if (!srcPath || !fs.existsSync(srcPath)) {
  console.error(`usage: node tools/vendor-toothfairy3-labels.mjs <saved-page.md>  (got: ${srcPath})`);
  process.exit(2);
}
let src = fs.readFileSync(srcPath, 'utf8');
src = src.replace(/\\([[{\]})_#*.`>~!-])/g, '$1');   // undo markdown escapes only

const key = '"labels": [';
const at = src.indexOf(key);
if (at < 0) { console.error('FAIL: no "labels": [ array in the saved page -- wrong file?'); process.exit(1); }
let depth = 0, end = -1;
for (let i = at + key.length - 1; i < src.length; i++) {
  if (src[i] === '[') depth++;
  else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('FAIL: labels array never closes'); process.exit(1); }

const arr = JSON.parse(src.slice(at + key.length - 1, end + 1));
const vals = arr.map((o) => o.value);
if (new Set(vals).size !== vals.length) { console.error('FAIL: duplicate label ids on the page'); process.exit(1); }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toothfairy3_labels.json');
fs.writeFileSync(outDir, JSON.stringify({
  _source: 'https://ditto.ing.unimore.it/toothfairy3/  (the labels JSON embedded in the dataset volume viewer)',
  _fetched_utc: '2026-11-24T18:23:05Z',
  _extractor: 'tools/vendor-toothfairy3-labels.mjs',
  _note: 'Verbatim vendor of the official class table so pipeline label maps are checked against ' +
    'ground truth instead of a re-derived formula. Only markdown escapes from the saved page copy ' +
    'were undone; ids, names, groups and colours are untouched.',
  _classes_claimed_on_page: '77',
  labels: arr.map((o) => ({ value: o.value, name: o.name, group: o.group, color: o.color })),
}, null, 2) + '\n');

console.log(`wrote ${outDir}`);
console.log(`  ${arr.length} labels, ids ${Math.min(...vals)}..${Math.max(...vals)}, all unique`);
console.log(`  pulp ids (>=111): ${vals.filter((v) => v >= 111).join(',')}`);
console.log(`  groups: ${[...new Set(arr.map((o) => o.group))].join(' | ')}`);
