/**
 * probe-smoke.selftest.mjs — run tools/probe-smoke.js against a mock of the automation handle.
 *
 * Why: the same text is about to be eval'd inside the page. A typo in a handle method name costs
 * a 15 s browser timeout here and a misleading "render is broken" conclusion there, so the mock
 * uses the real handle surface from src/App.tsx and throws on anything the page would not have.
 *
 *   node tools/probe-smoke.selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'probe-smoke.js'), 'utf8');

const STATS = { fps: 60, splats: 88918, visible: 88918, sortMs: 3.1, frameMs: 6.4, bytes: 2582852, gpu: 'ANGLE (NVIDIA RTX 5070 Ti)' };
const UNIFORMS = {
  uJawGap: 0, uClipCount: 0, uClipBand: 0, uCapEnable: 0,
  uLayerAlpha: [1, 1, 1, 0.55, 1, 1, 1, 0.35, 0.9],
  uHiddenLo: 0, uHiddenHi: 0, uSheen: 0.35, uSH1Scale: 1, uSelectedToothId: 0,
};
// The mock's key list is the REAL one, lifted out of SplatLayer.ts, so the probe's assumptions
// about uniform names are tested against the code rather than against a hand-written sample.
const realUniformKeys = [...fs.readFileSync(path.join(here, '..', 'src', 'engine', 'SplatLayer.ts'), 'utf8')
  .matchAll(/\b(u[A-Z]\w*)\s*:/g)].map((m) => m[1]);
for (const k of realUniformKeys) if (!(k in UNIFORMS)) UNIFORMS[k] = 0;
const MATERIAL = { uniforms: UNIFORMS, program: {} };
const HANDLE = {
  viewer: {}, png: () => 'data:image/png;base64,AA', stats: () => STATS, pump: () => {},
  selfTest: () => ({ ok: true, layers: 2 }), debugShot: () => 'data:,', probe: () => ({}), forceLayout: () => {},
  caseId: () => 'A', gl: () => ({ getError: () => 0 }),
  layer: () => ({ cloud: { count: 88918 }, material: MATERIAL }),
  uniforms: () => UNIFORMS,
  truth: () => [{ name: 'FDI_11' }, { name: 'FDI_12' }],
  measurePts: () => [], pickAt: () => 0, screen: () => [1280, 720],
  project: () => [0, 0],
};
const nodes = (list) => list.map((t) => ({ textContent: t, children: [] }));
globalThis.window = { DentSplat: HANDLE };
globalThis.document = {
  querySelectorAll: (sel) => (sel === '*'
    ? nodes(['DentSplat', 'SYNTHETIC PREVIEW — synthetic arcade', 'FPS 60'])
    : nodes(['FPS 60 · splats 88,918 · drawn 88,918 · sort 2.60 ms · frame 7.33 ms · payload 2.58 MB'])),
};

const fn = eval(`(${src})`);
const res = await fn();
console.log(JSON.stringify(res, null, 2));

const checks = [
  ['probe reads only uniform names that exist in SplatLayer.ts',
    ['uJawGap', 'uClipCount', 'uCapEnable', 'uClipBand', 'uLayerAlpha', 'uHiddenLo', 'uHiddenHi', 'uSheen']
      .every((k) => realUniformKeys.includes(k))],
  ['SplatLayer declares a material (not .program)', /this\.material\s*=/.test(fs.readFileSync(path.join(here, '..', 'src', 'engine', 'SplatLayer.ts'), 'utf8'))],
  ['handle surface enumerated', Array.isArray(res.handleKeys) && res.handleKeys.includes('pickAt')],
  ['no fatal', !res.fatal],
  ['case id read', res.caseId === 'A'],
  ['stats pass through', res.stats.splats === 88918 && res.stats.bytes === 2582852],
  ['uniform snapshot from the material', res.uniformValues.uLayerAlpha.length === 9 && res.uniformValues.uJawGap === 0],
  ['uniform key list from the material', res.layer.uniforms.includes('uLayerAlpha') && res.layer.uniforms.length >= 10],
  ['program reported compiled', res.layer.program === true],
  ['badge found', /SYNTHETIC/.test(res.badge ?? '')],
  ['hud read after flush carries the pump numbers', /88,918/.test(res.hudAfterFlush ?? '')],
  ['truth count from array length', res.truthCount === 2],
  ['selfTest forwarded', res.selfTest && res.selfTest.ok === true],
  ['pump timed', typeof res.pump120Ms === 'number'],
  ['glError numeric both sides', res.glError === 0 && res.glErrorAfter === 0],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) bad++;
}
console.log(bad ? `\n${bad} mock check(s) failed -- fix tools/probe-smoke.js before sending it to the page`
  : `\nprobe-smoke.js runs clean against the handle surface (${checks.length}/${checks.length})`);
process.exit(bad ? 1 : 0);
