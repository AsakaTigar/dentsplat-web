/** Decode a {name: "data:image/png;base64,..."} map into real PNG files.
 *  Usage: node tools/cap2png.mjs captures/caseA_imgs.json captures
 *  (browser captures come back through the automation bridge as JSON, never as files) */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [src, outDir = 'captures'] = process.argv.slice(2);
if (!src) {
  console.error('usage: node tools/cap2png.mjs <json-with-dataurls> [outDir]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const raw = JSON.parse(readFileSync(src, 'utf8'));
/** dataURLs may be nested at any depth; collect every string that looks like one. */
const found = [];
(function walk(node, path) {
  if (typeof node === 'string') {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(node);
    if (m) found.push({ path, b64: m[1] });
    return;
  }
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  }
})(raw, '');

if (found.length === 0) {
  console.error('no PNG dataURLs found in', src);
  process.exit(1);
}
const used = new Map();
for (const { path, b64 } of found) {
  const segs = path.split('.');
  // a capture is usually shots/<name>.data -> the leaf is useless, so prefer the segment above it
  let leaf = (segs[segs.length - 1] || 'shot').replace(/[^\w.-]/g, '_');
  if (/^(data|url|png|value)$/.test(leaf) && segs.length > 1) {
    leaf = (segs[segs.length - 2] || leaf).replace(/[^\w.-]/g, '_');
  } else {
    const m = /\[(\d+)\]$/.exec(leaf);
    if (m && segs.length > 1) leaf = (segs[segs.length - 2] || leaf).replace(/[^\w.[\]]/g, '') + '-' + m[1];
  }
  const n = used.get(leaf) ?? 0;
  used.set(leaf, n + 1);
  const name = (n ? `${leaf}-${n}` : leaf) + '.png';
  const file = join(outDir, name);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`${name}  ${(b64.length / 1024).toFixed(0)} KB b64 -> ${file}`);
}
console.log(`${found.length} images written to ${outDir}/`);
