/**
 * test-label-sync.mjs — cross-language contract check for the semantic byte.
 *
 * The dental meaning of a splat travels as ONE uint8 (layer id) plus ONE uint8 (FDI), and it is
 * written by Python (pipeline/*.py) but interpreted by TypeScript (src/engine/dspk.ts, shaders,
 * UI sliders). Nothing in either language fails when they disagree: the viewer just recolours
 * anatomy. This check runs where Python cannot (this machine has no working interpreter) and
 * asserts the tables agree, plus the ToothFairy3 class count that the UI copy claims.
 *
 *   node tools/test-label-sync.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dspk = read('src/engine/dspk.ts');
const py = read('pipeline/toothfairy2_to_layers.py');
const cases = read('src/data/cases.ts');

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
};

/* ------------------------------------------------------------------ parse the TS side */
const layerBlock = /export const LAYER = \{([\s\S]*?)\} as const;/.exec(dspk);
if (!layerBlock) { console.error('could not find LAYER in dspk.ts'); process.exit(1); }
const tsLayer = {};
for (const m of layerBlock[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) tsLayer[m[1]] = +m[2];

const rgbBlock = /export const LAYER_RGB: Record<number, \[number, number, number\]> = \{([\s\S]*?)\n\};/.exec(dspk);
const tsRgb = {};
for (const m of (rgbBlock?.[1] ?? '').matchAll(/\[LAYER\.(\w+)\]:\s*\[(\d+),\s*(\d+),\s*(\d+)\]/g))
  tsRgb[m[1]] = [+m[2], +m[3], +m[4]];

/* ------------------------------------------------------------------ parse the PY side */
const pyBlock = (name) => {
  const re = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
  const m = re.exec(py);
  return m ? m[1] : '';
};
const pyLayerCodes = {};
for (const m of pyBlock('LAYER_CODES').matchAll(/"(\w+)"\s*:\s*(\d+)/g)) pyLayerCodes[m[1]] = +m[2];
const pyEmitCodes = {};
for (const m of pyBlock('EMIT_CODES').matchAll(/"(\w+)"\s*:\s*LAYER_CODES\["(\w+)"\]/g)) {
  pyEmitCodes[m[1]] = pyLayerCodes[m[2]];
}
Object.assign(pyEmitCodes, pyLayerCodes);

const tintBlock = pyBlock('DEFAULT_TINT');
const pyTint = {};
for (const m of tintBlock.matchAll(/"(\w+)"\s*:\s*\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g))
  pyTint[m[1]] = [+m[2], +m[3], +m[4]];

const huBlock = pyBlock('DEFAULT_HU_WINDOW');
const pyHu = new Set([...huBlock.matchAll(/"(\w+)"\s*:/g)].map((m) => m[1]));

const emittable = (/^EMITTABLE_LAYERS\s*=\s*\(([^)]*)\)/m.exec(py)?.[1] ?? '')
  .split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);

/* ------------------------------------------------------- 1. the shared byte table */
ok(Object.keys(tsLayer).length === Object.keys(pyLayerCodes).length,
  `layer table size matches (${Object.keys(tsLayer).length} names)`,
  `ts=${Object.keys(tsLayer).length} py=${Object.keys(pyLayerCodes).length}`);
for (const [name, code] of Object.entries(tsLayer))
  ok(pyLayerCodes[name] === code, `LAYER_CODES['${name}'] === ${code}`, `python has ${pyLayerCodes[name]}`);

/* ------------------------------------------------------- 2. teeth slot + shader width */
ok(pyEmitCodes.teeth === tsLayer.enamel,
  "'teeth' (CBCT crown+root band) borrows the enamel slot the viewer's slider listens on",
  `teeth->${pyEmitCodes.teeth} enamel->${tsLayer.enamel}`);
const shader = read('src/engine/shaders.ts');
const arrLen = /uniform float uLayerAlpha\[(\d+)\];/.exec(shader)?.[1];
const maxCode = Math.max(...Object.values(tsLayer));
ok(+arrLen === maxCode + 1, `uLayerAlpha[${arrLen}] covers every layer code (max ${maxCode})`);
const clampExpr = /uLayerAlpha\[min\(layerId,\s*(\d+)\)\]/.exec(shader)?.[1];
ok(clampExpr === String(maxCode), `shader clamps layerId to ${maxCode}`, `clamps to ${clampExpr}`);

/* ------------------------------------------------------- 3. every emittable layer is complete */
for (const layer of emittable) {
  ok(layer in pyEmitCodes, `"${layer}" resolves to a byte code`);
  ok(pyHu.has(layer), `"${layer}" has an HU window`);
  ok(layer in pyTint, `"${layer}" has a tint`);
}
const uiLayerIds = [...cases.matchAll(/\{\s*id:\s*(\d+),\s*key:\s*'(\w+)'/g)].map((m) => [+m[1], m[2]]);
for (const [id, key] of uiLayerIds) {
  const tsName = Object.entries(tsLayer).find(([, c]) => c === id)?.[0];
  // 'teeth' is the CBCT spelling of the enamel slot; everything else must name-match.
  ok(key === tsName || (key === 'teeth' && id === tsLayer.enamel) || (key === 'restoration' && id === tsLayer.restoration),
    `UI slider '${key}' (id ${id}) maps to dspk LAYER.${tsName}`);
}

/* ------------------------------------------------------- 4. tints track LAYER_RGB */
for (const [layer, tint] of Object.entries(pyTint)) {
  const slot = layer === 'teeth' ? 'enamel' : layer;
  const rgb = tsRgb[slot];
  if (!rgb) { ok(false, `tint '${layer}' has no LAYER_RGB counterpart`); continue; }
  const worst = Math.max(...rgb.map((v, i) => Math.abs(v / 255 - tint[i])));
  ok(worst < 0.02, `tint '${layer}' matches LAYER_RGB.${slot} within ${(worst * 255).toFixed(1)}/255`);
}

/* --------------------------------------- 5. the published 77-class table, from ground truth */
// The oracle here is tools/toothfairy3_labels.json -- a verbatim vendor of the label array the
// official dataset page embeds in its viewer (see tools/vendor-toothfairy3-labels.mjs). Comparing
// the python tables against the recorded page (rather than against a formula I re-run in JS) is
// what catches a wrong comprehension: an earlier TF3_PULP_IDS loop emitted 211-218/311-318/411-418
// instead of 121-128/131-138/141-148, which silently deletes the root-canal layer.
const tf3 = JSON.parse(read('tools/toothfairy3_labels.json'));
const official = new Map(tf3.labels.map((o) => [o.value, o.name]));
ok(tf3.labels.length === Number(tf3._classes_claimed_on_page),
  `the vendored table has the ${tf3._classes_claimed_on_page} classes the page advertises`,
  `got ${tf3.labels.length}`);

const tf3Extra = [...pyBlock('TF3_EXTRA_LABELS').matchAll(/(\d+)\s*:\s*"(\w+)"/g)].map((m) => [+m[1], m[2]]);
const defaultLabels = [...pyBlock('DEFAULT_LABELS').matchAll(/(\d+)\s*:\s*"(\w+)"/g)].map((m) => [+m[1], m[2]]);
const pyPulpBlock = /TF3_PULP_IDS\s*=\s*\[([^\]]*)\]/m.exec(py)?.[1] ?? '';

// ids the python actually knows, rebuilt the way build_label_table() does it
const fdiIds = [];
for (const q of [1, 2, 3, 4]) for (let pos = 1; pos <= 8; pos++) fdiIds.push(q * 10 + pos);
const pulpFromFdi = fdiIds.map((f) => f + 100);
const pyKnown = new Map();
for (const [id, layer] of defaultLabels) pyKnown.set(id, layer);
for (const [id, layer] of tf3Extra) pyKnown.set(id, layer);
for (const f of fdiIds) pyKnown.set(f, 'teeth');
for (const p of pulpFromFdi) pyKnown.set(p, 'pulp');
for (const [id, layer] of tf3Extra)
  ok(emittable.includes(layer) || layer === 'other',
    `tf3 id ${id} -> '${layer}' is emittable (or documented as not)`);

const officialStructural = [...official.keys()].filter((v) => v <= 10 || v === 103 || v === 104 || v === 105);
const officialTeeth = [...official.keys()].filter((v) => v >= 11 && v <= 48);
const officialPulp = [...official.keys()].filter((v) => v >= 111);
ok(officialTeeth.length === 32 && officialPulp.length === 32,
  'the page lists 32 tooth ids and 32 pulp ids');
ok(officialPulp.every((v) => official.has(v - 100) && v - 100 >= 11 && v - 100 <= 48),
  'every official pulp id is exactly FDI + 100 (the assumption the misc byte relies on)');
ok(officialPulp.join(',') === pulpFromFdi.join(','),
  "the pulp ids this script targets match the page's, in order",
  `page=${officialPulp.slice(0, 6).join(',')}... script=${pulpFromFdi.slice(0, 6).join(',')}...`);
ok(/sorted\(fdi \+ 100 for fdi in VALID_FDI\)/.test(py),
  'TF3_PULP_IDS is derived from VALID_FDI, not from quadrant arithmetic');
ok(officialStructural.every((v) => pyKnown.has(v)),
  `all ${officialStructural.length} structure ids on the page are mapped by the script`);
for (const [id, layer] of tf3Extra) {
  const name = official.get(id);
  ok(!!name, `tf3 id ${id} exists on the official page`, layer);
  const expect = { nerve: /Canal/, sinus: /Sinus/, restoration: /Bridge|Crown|Implant/, other: /Pharynx/ }[layer];
  if (name && expect) ok(expect.test(name), `tf3 id ${id} ('${name}') really is the '${layer}' layer`);
}
ok(new Set([...pyKnown.keys()]).size === 77,
  'script + page agree on 77 ids', `script has ${new Set([...pyKnown.keys()]).size}`);
for (const id of official.keys())
  if (!pyKnown.has(id)) ok(false, `id ${id} ('${official.get(id)}') is unmapped by the script`);
for (const id of pyKnown.keys())
  if (!official.has(id)) ok(false, `script maps id ${id} ('${pyKnown.get(id)}') which the page does not list`);

/* ------------------------------------------------------- 6. nothing references the deleted helper */
ok(!/_fdi_per_sampled\s*\(/.test(py), 'the double-sampling helper is gone from both definition and call sites');
ok(/def sample_mask_coords\(/.test(py) && /sample_mask_coords\(mask/.test(py),
  'emit() samples voxels once, so geometry and label rows cannot desynchronise');

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log('FAILED:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
