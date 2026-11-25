/**
 * test-gpu-name.mjs — the HUD's GPU chip must read "NVIDIA GeForce RTX 5070 Ti", not the first 42
 * characters of ANGLE's raw string, and not "Inc. on".
 *
 * The assertions run against the real expression lifted out of Viewer.ts (the same bytes that ship),
 * so this fails when someone edits the parser instead of only when the parser was wrong to begin
 * with. Same trick as test-label-sync.mjs: no browser, no Python, just text.
 *
 *   node tools/test-gpu-name.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src', 'engine', 'Viewer.ts'), 'utf8');

const start = src.indexOf('const inner = raw.replace(');
const end = src.indexOf('this.gpu =', start);
if (start < 0 || end < 0) { console.error('could not locate the GPU-name block in Viewer.ts'); process.exit(1); }
const block = src.slice(start, src.indexOf(';', src.indexOf('this.gpu =', end)) + 1);
if (!block.includes('VENDOR') || !block.includes('metal')) {
  console.error('the located block does not look like the parser:\n' + block.slice(0, 200));
  process.exit(1);
}
const evaluate = new Function('raw', `${block.replace('this.gpu =', 'return')} return null;`);

const cases = [
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'NVIDIA GeForce RTX 5070 Ti'],
  ['ANGLE (Google Inc. (NVIDIA), NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'NVIDIA GeForce RTX 5070 Ti'],
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x9A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Intel(R) Iris(R) Xe Graphics'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', 'Apple M3'],
  ['ANGLE (Advanced Micro Devices, Inc. on Direct3D11 vs_5_0 ps_5_0, AMD Radeon RX 7900 XTX (0x744c), D3D11)',
    'AMD Radeon RX 7900 XTX'],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Microsoft Basic Render Driver'],
  ['ANGLE (VMware, Inc. on Direct3D11 vs_5_0 ps_5_0, VMware SVGA 3D (0x0405), D3D11)', 'VMware SVGA 3D'],
  ['WebGL 1.0 stack', 'WebGL 1.0 stack'],
  ['Apple GPU', 'Apple GPU'],
];

let bad = 0;
for (const [raw, want] of cases) {
  const got = evaluate(raw);
  if (got === want) console.log(`  ok   ${JSON.stringify(got)}`);
  else { bad++; console.log(`  FAIL got ${JSON.stringify(got)} want ${JSON.stringify(want)}\n       from ${raw}`); }
}
console.log(`\n${cases.length - bad}/${cases.length} GPU-name cases passed`);
if (bad) process.exit(1);
