/**
 * probe-nifti.selftest.mjs — run tools/probe-nifti.js against a mock that actually projects splats.
 *
 * Standing rule for this repo: JavaScript that is about to be eval'd inside the page is run locally
 * over the SAME bytes first. probe-nifti.js makes orientation claims, so a mock that just returned
 * zeroed buffers would let it "pass" while the browser said nothing. Here the mock is a tiny
 * software rasteriser with the GL bottom-left framebuffer convention, a per-layer alpha gate and a
 * camera that only looks down the Y axis after the probe asks for a view — so the probe's verdicts
 * are produced by the same kind of reasoning the page will use.
 *
 * It is then run three ways, because a check that cannot fail is decoration:
 *   default       the probe must report upright, 32 teeth, every layer lit on its own
 *   FLIP_ROWS=1   the renderer draws top-left -> the probe must report the OTHER row convention
 *   SCRAMBLE=1    two layer bytes are swapped -> the sinus-above-nerve claim must go false
 *
 * The three page-side files are exercised over the same mock, in the order the browser runs them:
 * nifti-wrapper.js fetches probe-nifti-launch.js, which fetches probe-nifti.js. Each must report the
 * bytes and digest of the file it actually ran, and their results must agree with calling
 * probe-nifti.js directly -- that is what lets a verdict in the JSON be traced to a specific file.
 *
 *   node tools/probe-nifti.selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
  (k === 'loadMs' || k === 'wallMs') ? undefined : v));
/** Field-by-field diff, so a mismatch below names the key instead of just saying "not equal". */
function diff(a, b, p = '', out = []) {
  if (out.length > 12) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return out.concat(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, out);
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'probe-nifti.js'), 'utf8');
// The packet the probe is pointed at. Size and digest are READ from the staged file instead of being
// typed in: the last time this was a literal it outlived the packet it described by one rebuild and
// then asserted the wrong byte count, which is exactly how a check becomes decoration.
const assetPath = path.join(here, '..', 'dist', 'assets', 'sceneB_from_nifti.dspk');
const haveAsset = fs.existsSync(assetPath);
const ASSET_BYTES = haveAsset ? fs.statSync(assetPath).size : 1749018;
const ASSET_SHA_PREFIX = haveAsset ? sha256Hex(fs.readFileSync(assetPath)) : '';

// ---------------------------------------------------------------- the mock cloud
// Analytic CBCT-shaped cloud: 32 FDI ids, six layer codes, sinus high in Y, nerve low, incisors
// forward in +Z, the patient's right (quadrants 1 and 4) at -X — the same signs the real
// tools/out/cbct_route packet has, so a probe that reads them wrong fails HERE.
const BB = { min: [-40.5, -32, -39], max: [40.5, 32, 39] };
const NAMES = { 0: 'gingiva', 1: 'enamel/teeth', 2: 'root', 3: 'alveolar', 4: 'nerve',
                5: 'other', 6: 'pulp', 7: 'sinus', 8: 'restoration' };
const TINT = { 1: [238, 232, 216], 3: [206, 196, 176], 4: [250, 204, 60], 6: [226, 86, 96],
               7: [120, 160, 210], 8: [186, 196, 206] };

function mkCloud(scramble) {
  const rows = [];   // [x, y, z, fdi, layer]
  for (let q = 1; q <= 4; q++) {
    for (let i = 1; i <= 8; i++) {
      const f = q * 10 + i;
      const sx = (q === 1 || q === 4) ? -1 : 1;          // patient's right -> -X
      const sy = (q === 1 || q === 2) ? 1 : -1;          // upper jaw -> +Y
      const ang = 0.15 + (i - 1) * (Math.PI / 2 - 0.15) / 7;
      const x = sx * 26 * Math.sin(ang), z = 26 * Math.cos(ang);
      for (let k = 0; k < 40; k++) {
        const t = k / 39;
        rows.push([x, sy * (14 + 6 * t), z + (t - 0.5) * 6, f, 1]);
        if (k % 4 === 0) rows.push([x, sy * (15 + 3 * t), z, f, 6]);   // pulp inside the tooth
      }
      for (let k = 0; k < 6; k++) rows.push([x + k * 0.4, sy * 8, z - 3, 0, 3]);   // alveolar shell
      if (i === 6) rows.push([x, sy * 20, z, 0, 8]);                    // restoration
    }
  }
  // IAN canals: low in Y, behind the molars. Sinuses: high in Y, behind the upper molars.
  for (let s = -1; s <= 1; s += 2) {
    for (let k = 0; k < 120; k++) rows.push([s * 18, -20, -10 + k * 0.4, 0, 4]);
    for (let k = 0; k < 120; k++) rows.push([s * 20, 26, -14 + k * 0.2, 0, 7]);
  }
  const n = rows.length;
  const pos = new Uint16Array(n * 3), rot = new Uint8Array(n * 4);
  const scale = new Uint8Array(n * 3), color = new Uint8Array(n * 3);
  const misc = new Uint8Array(n * 4), sh1 = null;
  const put = (v, lo, hi) => Math.max(0, Math.min(65535, Math.round(((v - lo) / (hi - lo)) * 65535)));
  rows.forEach(([x, y, z, f, l], i) => {
    pos[i * 3] = put(x, BB.min[0], BB.max[0]);
    pos[i * 3 + 1] = put(y, BB.min[1], BB.max[1]);
    pos[i * 3 + 2] = put(z, BB.min[2], BB.max[2]);
    rot[i * 4] = 128; rot[i * 4 + 3] = 255;
    scale[i * 3] = scale[i * 3 + 1] = scale[i * 3 + 2] = 128;
    const t = TINT[l] ?? [150, 150, 150];
    color[i * 3] = t[0]; color[i * 3 + 1] = t[1]; color[i * 3 + 2] = t[2];
    let layer = l;
    if (scramble && l === 7) layer = 4; else if (scramble && l === 4) layer = 7;  // swap the two
    misc[i * 4] = 255; misc[i * 4 + 1] = f; misc[i * 4 + 2] = layer; misc[i * 4 + 3] = 0;
  });
  return { count: n, bboxMin: BB.min.slice(), bboxMax: BB.max.slice(),
    scaleLogMin: Math.log(0.6), scaleLogMax: Math.log(0.6), hasSH1: false,
    pos, rot, scale, color, misc, sh1,
    meta: { kind: 'cbct', coordinate_system: 'glTF_Y_up', unit: 'mm',
      source: { appearance: { color: 'red/green/blue bytes', scale: 'synthesised 0.600 mm' } } },
    rows };
}

// ---------------------------------------------------------------- the mock viewer
function mkViewer(mode) {
  const cloud = mkCloud(mode === 'scramble');
  const V = {
    caseId: 'A', variant: 'full', layerAlphas: {}, layer: null, layerAlt: null,
    loaded: null, view: null, phi: 84,       // starts in an occlusal view: no Y in the image rows
    statsSnapshot() { return { fps: 60, splats: this.layer ? this.layer.cloud.count : 0,
      visible: this.layer ? this.layer.cloud.count : 0, sortMs: 1.4, frameMs: 5.2,
      bytes: ASSET_BYTES, gpu: 'ANGLE (NVIDIA RTX 5070 Ti)' }; },
    async loadCase(a) { this.loaded = a;
      // The CBCT route has no pruned twin yet, so the "other variant" is a stand-in sized off the
      // cloud the mock actually built -- a literal here would be a number nobody can check.
      this.layer = { cloud }; this.layerAlt = { cloud: { count: Math.round(cloud.count * 0.35),
        hasSH1: false } }; },
    pump(n) { for (let i = 0; i < n; i++) { /* frames are instant here; the probe only needs order */ }
      return { frames: n, wallMs: 0, perFrameMs: 0, stats: this.statsSnapshot() }; },
    flyTo(p) { this.view = p; this.phi = p.phi; },
    setLayerAlphaMap(m) { this.layerAlphas = { ...m }; },
    renderProbe(size) {
      const w = size, h = Math.round(size * 0.62);
      const buf = new Uint8Array(w * h * 4).fill(0);
      const frontal = Math.abs(this.phi) < 60;      // an occlusal view puts Y into depth, not rows
      let painted = 0;
      for (let i = 0; i < cloud.count; i++) {
        const l = cloud.misc[i * 4 + 2];
        if (!(this.layerAlphas[l] > 0)) continue;
        const g = (k) => cloud.bboxMin[k] + (cloud.pos[i * 3 + k] / 65535) * (cloud.bboxMax[k] - cloud.bboxMin[k]);
        const [x, y, z] = [g(0), g(1), g(2)];
        const u = (x - BB.min[0]) / (BB.max[0] - BB.min[0]);
        const v = frontal ? (y - BB.min[1]) / (BB.max[1] - BB.min[1])
                          : (z - BB.min[2]) / (BB.max[2] - BB.min[2]);
        const col = Math.round(u * (w - 1));
        const row = Math.round(v * (h - 1));
        const r = mode === 'flip' ? (h - 1 - row) : row;     // FLIP_ROWS = a top-left rasteriser
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
          const px = Math.min(w - 1, col + dx), py = Math.min(h - 1, r + dy);
          const o = (py * w + px) * 4;
          buf[o] = cloud.color[i * 3]; buf[o + 1] = cloud.color[i * 3 + 1];
          buf[o + 2] = cloud.color[i * 3 + 2]; buf[o + 3] = 255;
          painted++;
        }
      }
      return { w, h, sorted: true, drawn: { calls: 1, tris: cloud.count * 6 }, glError: 0,
        paintedFraction: +(painted / (w * h)).toFixed(4), mean: [10, 10, 12], peak: 238, buf };
    },
    renderToDataURL(size) { const p = this.renderProbe(size); return 'data:image/png;base64,' +
      'AA'.repeat(Math.round(p.w * 3)); },
  };
  V.layer = { cloud };
  return V;
}

// ---------------------------------------------------------------- run one mode
// Serve the packet that is actually staged in dist/assets when it exists, so the digest the probe
// computes in-page is the same number tools/dspk-head.ts prints from disk. Without the file (a fresh
// clone) a deterministic stand-in keeps the probe's own code path exercised.
const buf = haveAsset ? new Uint8Array(fs.readFileSync(assetPath)) : (() => {
  const b = new Uint8Array(ASSET_BYTES);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
})();
const launcherSrc = fs.readFileSync(path.join(here, 'probe-nifti-launch.js'), 'utf8');
globalThis.fetch = async (u) => ({ ok: true, status: 200,
  // The probe reads content-length off the response, so the mock has to answer like a server does --
  // a missing headers object used to be harmless and now would silently lose the size cross-check.
  headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(buf.length) : null) },
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  text: async () => (String(u).endsWith('probe-nifti-launch.js') ? launcherSrc : src) });

async function run(mode) {
  const V = mkViewer(mode);
  globalThis.window = { DentSplat: { viewer: V, caseId: () => V.caseId, stats: () => V.statsSnapshot(),
    pump: (n) => V.pump(n), png: () => 'data:image/png;base64,AA' } };
  globalThis.window.__nifti = { full: '/assets/sceneB_from_nifti.dspk', proxy: '/assets/proxy_B.glb',
    bytes: ASSET_BYTES, shot: 320 };
  const fn = eval(`(${src})`);
  return { res: await fn(), V };
}

const base = await run('default');
const flip = await run('flip');
const scr = await run('scramble');

// The launcher is the text the automation bridge evals, so it runs here too -- same mock, same
// fetch, same crypto. Its payload must be the probe's own result rather than a re-implementation,
// which is what the deep-equality assertion below pins down.
try {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    getEntriesByType: (t) => (t === 'resource' ? [
      { name: '/assets/sceneB_from_nifti.dspk', encodedBodySize: ASSET_BYTES },
      { name: '/assets/index-DUqMfPP2.js', encodedBodySize: 911891 }] : []),
    now: () => Date.now() } });
} catch { /* node keeps its own performance: the launcher only reads resource entries */ }
// The launcher and the wrapper both read the viewer that `run()` installed last, so each leg is
// preceded by a fresh default run. Without that, a negative-control viewer (scramble/flip) would
// still be in `window` and the equality assertions below would only prove the mock is stateful.
await run('default');
const launched = await eval(launcherSrc);

// ...and so is tools/nifti-wrapper.js, the single expression the bridge actually sends. It must
// reproduce the launcher exactly and report the bytes it ran -- that is the whole point of the digest.
const wrapperSrc = fs.readFileSync(path.join(here, 'nifti-wrapper.js'), 'utf8');
// Both legs run against whichever mock viewer `run()` installed last, so each leg gets its own
// fresh default run -- otherwise a negative-control viewer would leak into the equality assertion
// and the diff would only be catching that the mock is stateful, not that the code agrees.
const fresh = await run('default');
const wrapped = await eval(`(${wrapperSrc})`)();
const wrapperDiff = diff(strip(wrapped.out?.res ?? {}), strip(fresh.res));
console.log(`[wrapper] launcher=${wrapped.launcherSha256?.slice(0, 12)} bytes=${wrapped.launcherBytes} ` +
  `probe=${wrapped.out?.probeSha256?.slice(0, 12)}/${wrapped.out?.probeBytes} fatal=${wrapped.out?.fatal ?? 'none'}`);
console.log(`\n[launcher] probe=${launched.url} bytes=${launched.probeBytes} sha=${launched.probeSha256?.slice(0, 12)} ` +
  `wallMs=${launched.wallMs} pngChars=${launched.pngChars} bundle=${launched.bundle} dspk=${launched.dspk}` +
  (launched.fatal ? ` FATAL ${launched.fatal}` : ''));

function report(tag, r) {
  const c = r.res.container ?? {}, o = r.res.orientation ?? {};
  console.log(`\n[${tag}] splats=${r.res.after?.splats} teeth=${c.distinct_fdi} ` +
    `colors=${c.distinct_colors} alpha=${JSON.stringify(c.alpha_byte)} ` +
    `lit(all)=${r.res.allLayers?.lit} row0=${o.row0_is} upright=${o.arch_upright} ` +
    `checks=${JSON.stringify(c.checks)}`);
  console.log(`       byLayer lit: ` + Object.entries(r.res.byLayer ?? {})
    .map(([k, v]) => `${k}=${v.lit}@row${v.meanRow}`).join(' '));
  console.log(`       loadCase urls: ${r.V.loaded ? [r.V.loaded.fullUrl, r.V.loaded.proxyUrl].join(',') : 'NONE'}` +
    ` | flyTo: ${r.V.view ? `theta=${r.V.view.theta} phi=${r.V.view.phi} r=${Math.round(r.V.view.radius)}` : 'NEVER CALLED'}` +
    ` | restored=${r.res.alphasRestored} png=${r.res.pngChars} sha=${r.res.asset?.sha256?.slice(0, 8)}`);
}
report('default', base);
report('FLIP_ROWS', flip);
report('SCRAMBLE', scr);

const B = base.res, F = flip.res, S = scr.res;
const launchDiff = diff(strip(launched.res ?? {}), strip(base.res));
if (launchDiff.length) console.log('\nlauncher vs direct probe, fields that differ:\n  ' + launchDiff.join('\n  '));
const litCodes = Object.keys(B.byLayer ?? {});
const checks = [
  ['no fatal in any mode', ![B, F, S].some((r) => r.fatal)],
  ['loadCase got the real urls', base.V.loaded.fullUrl.endsWith('sceneB_from_nifti.dspk') && !!base.V.loaded.proxyUrl],
  ['asset digest is the staged file\'s own sha (hashing path, not decode)',
    B.asset?.bytes === ASSET_BYTES && (haveAsset
      ? (B.asset?.sha256 ?? '').startsWith(ASSET_SHA_PREFIX)
      : /^[0-9a-f]{32}$/.test(B.asset?.sha256 ?? ''))],
  ['container decoded', B.after.splats > 1000 && B.after.stride === 20 && B.after.scaleMm[0] === 0.6],
  ['the size the page hashed is the size the server claimed',
    B.asset?.bytes === ASSET_BYTES && B.asset?.content_length === B.asset?.bytes],
  ['all 32 FDI ids survive', B.container.checks.all_32_teeth === true],
  ['frame signs agree with the pipeline', B.container.checks.upper_above_lower &&
    B.container.checks.incisors_forward && B.container.checks.right_side_at_minus_x],
  ['every layer paints on its own', litCodes.length === 6 && litCodes.every((k) => B.byLayer[k].lit > 0)],
  ['glError 0 and one draw call per pass', litCodes.every((k) => B.byLayer[k].glError === 0 &&
    B.byLayer[k].drawn.calls === 1)],
  ['view was set before measuring pixels', !!base.V.view && base.V.view.phi === 9],
  ['orientation measured as upright, GL bottom-left rows', B.orientation.arch_upright === true &&
    /bottom scanline/.test(B.orientation.row0_is)],
  ['alphas handed back', B.alphasRestored === true],
  ['png produced', B.pngChars > 100 && typeof globalThis.window.__niftiPng === 'string'],
  // negative controls -- the reason the positive results above mean anything
  ['FLIP_ROWS makes the probe say the opposite', F.orientation.arch_upright === false &&
    /top scanline/.test(F.orientation.row0_is)],
  ['SCRAMBLE breaks the sinus/nerve claim', S.container.checks.sinus_above_nerve === false],
  // the launcher: the text the bridge actually evals must reproduce the probe, not paraphrase it
  ['launcher runs and finds the probe', !launched.fatal && launched.probeBytes > 1000],
  ['launcher digest is the probe file on disk', launched.probeSha256 === sha256Hex(src)],
  ['launcher byte count is bytes, not UTF-16 chars',
    launched.probeBytes === new TextEncoder().encode(src).length],
  ['launcher payload equals the direct probe result (timings aside)',
    // Two runs of the same probe over the same mock differ only in wall-clock fields, so those are
    // dropped before the comparison. Anything else that moved would mean the launcher is running
    // different code or a different view state than the probe was tested with.
    launchDiff.length === 0],
  ['launcher saw the staged asset', (launched.dspk || []).join('').includes('sceneB_from_nifti.dspk=')],
  // the wrapper: what the bridge really sends
  ['wrapper digests the launcher bytes it ran',
    wrapped.launcherSha256 === sha256Hex(launcherSrc) &&
    wrapped.launcherBytes === new TextEncoder().encode(launcherSrc).length],
  ['wrapper carries the probe digest too',
    wrapped.out?.probeSha256 === sha256Hex(src) && wrapped.out?.probeBytes === new TextEncoder().encode(src).length],
  ['wrapper result equals a direct probe run', wrapperDiff.length === 0],
];
let bad = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) bad++; }
console.log(bad ? `\n${bad} mock check(s) failed -- fix tools/probe-nifti.js before sending it to the page`
  : `\nprobe-nifti.js verified against a projecting mock, both negative controls included (${checks.length}/${checks.length})`
    + (haveAsset ? '' : '  [asset not staged: digest check degraded to format-only]'));
process.exit(bad ? 1 : 0);
