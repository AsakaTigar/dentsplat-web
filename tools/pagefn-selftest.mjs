/**
 * pagefn-selftest.mjs — run a tools/probe-*.js page function against a mock of the viewer.
 *
 * Standing rule for this repo: JavaScript that is about to be eval'd inside the page gets run
 * locally over the SAME bytes first. Every browser typo here costs a 15 s automation timeout and,
 * worse, a confident-but-wrong reading of the app's state; the first draft of probe-selftest-diag.js
 * died exactly that way (`renderer.getViewport(new Object())` -> "e.copy is not a function").
 *
 *   node tools/pagefn-selftest.mjs tools/probe-selftest-diag.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) { console.error('usage: node tools/pagefn-selftest.mjs tools/<probe-fn>.js'); process.exit(2); }
const src = fs.readFileSync(path.isAbsolute(target) ? target : path.join(here, '..', target), 'utf8');

const glEnum = {};
const GL = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'getError') return () => 0;
    if (prop === 'getParameter') return (p) => params[String(p)] ?? 0;
    if (typeof prop !== 'string') return undefined;
    // Enum "values" are their own names, so getParameter(SCISSOR_TEST) looks up params.SCISSOR_TEST.
    if (!(prop in glEnum)) glEnum[prop] = prop;
    return glEnum[prop];
  },
});
const params = {
  SCISSOR_TEST: false,
  SCISSOR_BOX: [0, 0, 428, 1],
  VIEWPORT: [0, 0, 428, 1],
};

const mkLayer = () => {
  const uniforms = {};
  const splatSrc = fs.readFileSync(path.join(here, '..', 'src', 'engine', 'SplatLayer.ts'), 'utf8');
  for (const m of splatSrc.matchAll(/\b(u[A-Z]\w*)\s*:/g)) {
    uniforms[m[1]] = { value: m[1] === 'uLayerAlpha' ? new Array(9).fill(1) : 0 };
  }
  return { cloud: { count: 88918 }, material: { uniforms, program: {} }, mesh: { visible: true },
    geometry: { drawRange: { count: 533508 }, index: { array: new Uint32Array(4) } } };
};

const viewer = {
  renderer: {
    getContext: () => GL,
    getViewport: (t) => Object.assign(t, { x: 0, y: 0, w: 428, h: 1 }),
    getScissor: (t) => Object.assign(t, { x: 0, y: 0, w: 428, h: 1 }),
    setScissorTest: (on) => { scissorCleared = !on; },
    info: { render: { calls: 2 } },
  },
  canvas: { width: 428, height: 1 },
  camera: {
    aspect: 428, fov: 35, near: 1, far: 4000,
    position: { toArray: () => [82.4, -19.7, 41.2] },
    updateProjectionMatrix: () => {},
  },
  layer: mkLayer(),
  splitCompare: false,
  // Nested probes (probe-bench-opaque.js) drive the same uniform path the alpha sliders use.
  layerAlphas: { 0: 1, 1: 1, 2: 1, 3: 0.4, 4: 0.97, 5: 1, 6: 0.93, 7: 0.24, 8: 1 },
  setLayerAlphaMap(map) { Object.assign(this.layerAlphas, map); },
};

const selfTestShape = (lit) => ({
  box: { name: 'box', calls: 2, lit, e0: 0, e1: 0, e2: 0, mid: lit ? [255, 0, 0, 255] : [0, 0, 0, 255] },
  splat: { name: 'splat', calls: 2, lit, e0: 0, e1: 0, e2: 0, mid: lit ? [7, 11, 18, 255] : [0, 0, 0, 255] },
  splatNormalBlend: { name: 'splat-normal', calls: 2, lit, e0: 0, e1: 0, e2: 0, mid: lit ? [7, 11, 18, 255] : [0, 0, 0, 255] },
  state: { transparent: true, depthTest: false, depthWrite: false, side: 2, blending: 5,
    glslVersion: '300 es', drawRange: 533508, indexType: 'Uint32Array' },
});
// The mock reproduces the failure mode under investigation: with the live canvas aspect (428:1,
// i.e. a hidden automation window) the 96x96 offscreen pass comes back black, and it reads
// normally once the aspect is square. If the real page does NOT behave this way, the probe's
// before/after pair will say so, which is the point of running it.
let scissorCleared = false;
let variant = 'full';
const SPLATS = { full: 88918, pruned: 41205 };
const BUTTONS = ['Full', 'Pruned', 'Split'].map((label) => ({
  textContent: label,
  click: () => { if (label === 'Full' || label === 'Pruned') variant = label.toLowerCase(); },
}));
// probe-bench.js drives the real UI: a bench button whose label is the state machine ('跑一次
// bench(384²)' -> '回读像素中…' -> back) and a <dt>/<dd> pair that only changes once the measurement
// lands. Modelling the busy state matters -- runBench once awaited two requestAnimationFrames, which
// never fire in a hidden window, so the button stuck on busy and the row never changed. A mock that
// resolved synchronously would have passed that probe and failed in the browser.
const BENCH_IDLE = '跑一次 bench(384²)';
let benchBusy = false;
let benchPending = 0;
const ROWS = {
  'live PSNR': { value: '—' },
  full: { value: '88,918 splats · 2.46 MB · SH1' },
  pruned: { value: '30,232 splats · 0.58 MB · SH0' },
  ratio: { value: '4.24× smaller' },
  'coverage gap': { value: '0.469 mm mean · p95 1.359 mm' },
};
BUTTONS.push({
  get textContent() { return benchBusy ? '回读像素中…' : BENCH_IDLE; },
  click: () => { benchBusy = true; benchPending = 2; },
});
const DTS = Object.entries(ROWS).map(([label, row]) => ({
  textContent: label,
  nextElementSibling: { get textContent() { return row.value; } },
}));

const doBench = () => {
  // Masked PSNR sits *below* the whole-frame one in the mock on purpose: the background is
  // bit-identical in both shots, so it dilutes the global mean. A mock where the stricter figure is
  // larger would let a probe pass that mislabels the two in the UI.
  const pair = (psnr, psnrInMask) => ({ psnr, psnrInMask, mae: 0.0366, covered: 0.3574,
    identicalFraction: 0.7754, errorInTop1Percent: 0.612, maxDiff: 188,
    meanFull: [41.7, 44.2, 47.9], meanPruned: [41.1, 43.6, 47.2] });
  const head = pair(28.4, 26.1), control = pair(999, 999);
  ROWS['live PSNR'].value = `28.4 dB · 掩膜内 26.1 dB · MAE 0.0366 · 78% 逐位相同 · 同资产对照 999 dB · 误差 top1% 0.612`;
  return { ...head, samples: 384 * 384 * 3, control, psnrSelf: control.psnr, identicalSelfFraction: control.identicalFraction };
};

const D = {
  viewer,
  caseId: () => 'A',
  gl: () => GL,
  layer: () => viewer.layer,
  stats: () => ({ fps: 60, splats: SPLATS[variant], visible: SPLATS[variant], variant,
    sortMs: 2.1, frameMs: 7.33, bytes: variant === 'pruned' ? 823_900 : 2582852, gpu: 'RTX 5070 Ti' }),
  screen: () => [428, 1],
  truth: () => new Array(32).fill(0).map((_, i) => ({ name: `FDI_${11 + i}` })),
  uniforms: () => Object.fromEntries(Object.entries(viewer.layer.material.uniforms).map(([k, u]) => [k, u.value])),
  pump: () => { if (benchBusy && --benchPending <= 0) { benchBusy = false; doBench(); } },
  bench: () => Promise.resolve(doBench()),
  perf: (w = 1280, h = 720, iters = 25) => {
    // Fill-rate-shaped mock: if the probe ever stops forwarding w/h, the three rows collapse to
    // one identical number and the printout makes that obvious instead of it reading as "flat GPU".
    const px = (w * h) / (1280 * 720);
    const ms = (base) => +(base * px).toFixed(2);
    const stat = (min, p50, p95, max) => ({ n: iters, min, p50, p95, max });
    const serialMs = stat(ms(3.9), ms(4.4), ms(6.1), ms(7.0));
    const syncOnlyMs = stat(2.9, 3.1, 3.4, 4.0);
    const netGpuMs = +Math.max(0, serialMs.p50 - syncOnlyMs.p50).toFixed(3);
    const publishable = netGpuMs >= 0.2;
    return {
      w, h, iters, splats: SPLATS[variant], visible: SPLATS[variant], variant, sortMs: 2.1,
      gpuMs: serialMs, method: 'serialised 1x1 readback, sync latency subtracted', timerSupported: true,
      serialMs, syncOnlyMs, netGpuMs, finishMs: stat(0, 0.1, 0.4, 0.9),
      submitMs: ms(0.08), drainMs: 0, readbackFullMs: ms(140), syncConfirmed: true,
      fpsAtThisSize: publishable ? +(1000 / netGpuMs).toFixed(1) : null,
      fpsBasis: publishable ? 'netGpuMs' : 'below the readback floor',
      drawn: { calls: 1, tris: SPLATS[variant] * 6 }, paintedFraction: 0.214, glError: 0, gpu: 'RTX 5070 Ti',
    };
  },
  perfTimer: (w = 1280, h = 720, iters = 20) => {
    const k = (w * h) / (1280 * 720);
    const stat = (min, p50, p95, max) => ({ n: iters, min, p50, p95, max });
    const gpuMs = stat(+(1.1 * k).toFixed(3), +(1.3 * k).toFixed(3), +(1.9 * k).toFixed(3), +(2.4 * k).toFixed(3));
    return Promise.resolve({
      w, h, iters, asked: iters, got: iters, unavailable: 0, disjoint: 0,
      splats: SPLATS[variant], visible: SPLATS[variant], variant, sortMs: 2.1,
      gpuMs, fpsAtThisSize: +(1000 / gpuMs.p50).toFixed(1),
      method: 'EXT_disjoint_timer_query_webgl2', drawn: { calls: 1, tris: SPLATS[variant] * 6 },
      glError: 0, gpu: 'RTX 5070 Ti',
    });
  },
  png: () => 'data:image/png;base64,AA',
  measurePts: () => [],
  pickAt: () => 0,
  project: () => [0, 0],
  selfTest: () => selfTestShape(viewer.camera.aspect === 1 && scissorCleared ? 4213 : 0),
};

globalThis.window = { DentSplat: D, devicePixelRatio: 1 };
// Nested probes fetch another probe file by URL. Serving them from tools/ keeps the self-test honest:
// the bytes that run in the mock are the bytes the page will eval, so a syntax slip in probe-bench.js
// fails here instead of inside a 15 s browser timeout.
globalThis.fetch = async (u) => {
  const name = String(u).split('/').pop();
  const p = path.join(here, '..', 'tools', name);
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  return { ok: true, status: 200, text: async () => fs.readFileSync(p, 'utf8') };
};
// Node's globalThis.crypto is accessor-only, so assignment throws; redefine it. The probe only needs
// a 32-byte digest to label which bytes ran, so a deterministic stub is enough here.
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (_a, buf) => new Uint8Array(buf).slice(0, 32).buffer } } });
globalThis.document = {
  hidden: true,
  visibilityState: 'hidden',
  querySelectorAll: (sel) => (sel === 'button' ? BUTTONS : sel === 'dt' ? DTS
    : [{ textContent: 'SYNTHETIC PREVIEW', children: [] }]),
  createElement: () => ({ getContext: () => null }),
};

const fn = eval(`(${src})`);
const res = await fn();
if (res && res.fatal) { console.error('probe reported fatal:', res.fatal); process.exit(1); }
// --quiet keeps `npm run check` readable: the probe payloads are printed in full only when someone
// asks for them, and the check chain needs a verdict line, not 200 lines of mock numbers.
const quiet = process.argv.includes('--quiet');
if (quiet) {
  const n = (x) => (typeof x === 'string' ? x
    : Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : String(x ?? '-'));
  console.log(`  ok   ${path.basename(target)} ran over the mock: ` +
    Object.entries(res ?? {}).filter(([k]) => k !== 'definition').map(([k, v]) => `${k}=${n(v)}`).join(' '));
} else {
  console.log(JSON.stringify(res, null, 2));
  console.log('\n-- ran without throwing over the mock viewer surface');
}
// probe-*.js files yield with MessageChannel (the browser's setTimeout clamp workaround), and a
// Node port keeps the event loop alive for the whole process. Exit explicitly so `timeout N node
// tools/pagefn-selftest.mjs ...` reports the result instead of looking like a hung probe.
process.exit(0);
