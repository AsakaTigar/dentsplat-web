/**
 * tools/analyze_gaussians.mjs — a blob audit of a splat packet: what the primitives actually are.
 *
 * "Looks foggy" is a symptom; this turns it into numbers. For every splat it decodes the sorted axis
 * scales (s1 >= s2 >= s3), the opacity, the layer and the FDI byte, then reports:
 *
 *   shape      r_flat = s3/s2, r_elong = s1/s2  -> disk / needle / isotropic / bloated
 *   coverage   rho = sqrt(s1*s2) / mean kNN centre distance (k = 6)
 *   budget     splats and shells (s1*s2*pi) per layer and per tooth
 *
 *   node tools/analyze_gaussians.mjs --dspk public/assets/sceneB_dentvoxel_full.dspk --out tools/out/blob_audit_before.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DSPK = arg('--dspk');
const OUT = arg('--out', 'tools/out/blob_audit.json');
const K = Number(arg('--k', 6));
if (!DSPK) { console.error('usage: --dspk <file.dspk> [--out json] [--k 6]'); process.exit(2); }

const buf = readFileSync(DSPK);
if (buf.readUInt32LE(0) !== 0x4b505344) throw new Error('not a DSPK file');
const stride = buf.readUInt8(7);
const count = buf.readUInt32LE(8);
const bboxMin = [buf.readFloatLE(12), buf.readFloatLE(16), buf.readFloatLE(20)];
const bboxMax = [buf.readFloatLE(24), buf.readFloatLE(28), buf.readFloatLE(32)];
const logMin = buf.readFloatLE(36), logMax = buf.readFloatLE(40);
const metaLen = buf.readUInt32LE(44);
const base = 128 + metaLen;
if (buf.length < base + count * stride) throw new Error('truncated');

const P = new Float32Array(count * 3);
const S = new Float32Array(count * 3);
const A = new Uint8Array(count);
const L = new Uint8Array(count);
const F = new Uint8Array(count);
for (let i = 0; i < count; i++) {
  const o = base + i * stride;
  for (let k = 0; k < 3; k++) {
    const t = buf.readUInt16LE(o + k * 2) / 65535;
    P[i * 3 + k] = bboxMin[k] + t * (bboxMax[k] - bboxMin[k]);
    const e = buf.readUInt8(o + 10 + k) / 255;
    S[i * 3 + k] = Math.exp(logMin + e * (logMax - logMin));
  }
  A[i] = buf.readUInt8(o + 16);
  F[i] = buf.readUInt8(o + 17);
  L[i] = buf.readUInt8(o + 18);
}

// kNN by spatial hash; the cell is a few median radii so the first shell usually holds the neighbours
const med = S.slice().sort()[Math.floor(S.length / 2)];
const CELL = Math.max(2, med * 6);
const key = (x, y, z) => `${x},${y},${z}`;
const grid = new Map();
for (let i = 0; i < count; i++) {
  const k = key(Math.floor(P[i * 3] / CELL), Math.floor(P[i * 3 + 1] / CELL), Math.floor(P[i * 3 + 2] / CELL));
  const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
}
const knnMean = new Float32Array(count);
for (let i = 0; i < count; i++) {
  const cx = Math.floor(P[i * 3] / CELL), cy = Math.floor(P[i * 3 + 1] / CELL), cz = Math.floor(P[i * 3 + 2] / CELL);
  const best = [];
  for (let r = 0; r <= 3 && best.length < K; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const a = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!a) continue;
      for (const j of a) {
        if (j === i) continue;
        const d = Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
        if (best.length < K) { best.push(d); best.sort((a2, b2) => a2 - b2); }
        else if (d < best[K - 1]) { best[K - 1] = d; best.sort((a2, b2) => a2 - b2); }
      }
    }
  }
  knnMean[i] = best.length ? best.reduce((s, d) => s + d, 0) / best.length : NaN;
}

const shape = { disk: 0, needle: 0, isotropic: 0, bloated: 0 };
const rhoBins = { under: 0, good: 0, over: 0 };
const perLayer = new Map();
const perFdi = new Map();
const ENV = {};
for (let i = 0; i < count; i++) {
  const s = [S[i * 3], S[i * 3 + 1], S[i * 3 + 2]].sort((a, b) => b - a);
  const [s1, s2, s3] = s;
  const rFlat = s3 / Math.max(s2, 1e-9);
  const rElong = s1 / Math.max(s2, 1e-9);
  const alpha = A[i] / 255;
  let cls;
  if (s1 > 2.5 && alpha < 0.4) cls = 'bloated';
  else if (rFlat < 0.35 && rElong < 2.5) cls = 'disk';
  else if (rElong >= 2.5) cls = 'needle';
  else cls = 'isotropic';
  shape[cls]++;
  const rho = Math.sqrt(s1 * s2) / Math.max(knnMean[i], 1e-9);
  if (!Number.isFinite(rho)) { /* isolated */ } else if (rho < 0.6) rhoBins.under++;
  else if (rho > 2.0) rhoBins.over++;
  else rhoBins.good++;
  const layer = L[i];
  const le = perLayer.get(layer) ?? { splats: 0, area: 0, alpha: 0 };
  le.splats++; le.area += Math.PI * s1 * s2; le.alpha += alpha;
  perLayer.set(layer, le);
  if (F[i]) {
    const fe = perFdi.get(F[i]) ?? { splats: 0, area: 0 };
    fe.splats++; fe.area += Math.PI * s1 * s2;
    perFdi.set(F[i], fe);
  }
  if (alpha < 0.05) ENV.ghost = (ENV.ghost ?? 0) + 1;
  if (rho > 2.0) ENV.over = (ENV.over ?? 0) + 1;
}
const pct = (n) => +(100 * n / count).toFixed(1);
const totalArea = [...perLayer.values()].reduce((s, v) => s + v.area, 0);
const report = {
  file: DSPK, stride, count, bbox_mm: [bboxMin.map((v) => +v.toFixed(1)), bboxMax.map((v) => +v.toFixed(1))],
  scale_mm: [+Math.exp(logMin).toFixed(3), +Math.exp(logMax).toFixed(3)],
  shape: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, { n: v, pct: pct(v) }])),
  rho: Object.fromEntries(Object.entries(rhoBins).map(([k, v]) => [k, { n: v, pct: pct(v) }])),
  layers: Object.fromEntries([...perLayer.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, {
    splats: v.splats, pct: pct(v.splats), area_mm2: Math.round(v.area),
    area_pct: +(100 * v.area / Math.max(totalArea, 1e-9)).toFixed(1), mean_alpha: +(v.alpha / v.splats).toFixed(2),
  }])),
  teeth: [...perFdi.entries()].sort((a, b) => a[0] - b[0]).map(([fdi, v]) => ({
    fdi, splats: v.splats, area_mm2: Math.round(v.area),
    per_mm2: +(v.splats / Math.max(v.area, 1e-9)).toFixed(2),
  })),
  flags: ENV,
  verdict: {
    isotropic_pct: pct(shape.isotropic),
    disk_pct: pct(shape.disk),
    under_pct: pct(rhoBins.under),
    over_pct: pct(rhoBins.over),
  },
};
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.verdict, null, 0));
console.log(JSON.stringify({ layers: report.layers }, null, 0));
console.log(`# wrote ${OUT}`);
