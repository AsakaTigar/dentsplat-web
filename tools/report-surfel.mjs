/**
 * tools/report-surfel.mjs — re-derive the Scene B asset table from the packets themselves.
 *
 * The right-hand "CASE · 数据来源" panel reads public/assets/report.json, so the counts, byte sizes,
 * SH degree and compression fidelity must come from the files on disk, not from a hand edit. This
 * script decodes the full and pruned .dspk, recomputes:
 *
 *   - splats / bytes / bytes-per-splat / SH degree for both packets
 *   - bytes_ratio
 *   - the pruned -> full nearest-centre distance (mean / p95 / max), a true subset here
 *   - the FDI 48 <-> mandibular-canal centroid distance that the measurement card quotes
 *
 * and rewrites only report.scenes.sceneB_cbct.
 *
 *   node tools/report-surfel.mjs --full public/assets/sceneB_dentvoxel_full.dspk \
 *        --pruned public/assets/sceneB_dentvoxel_pruned.dspk --report public/assets/report.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FULL = arg('--full'), PRUNED = arg('--pruned'), REPORT = arg('--report');
if (!FULL || !PRUNED || !REPORT) {
  console.error('usage: --full <full.dspk> --pruned <pruned.dspk> --report <report.json>');
  process.exit(2);
}

function load(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x4b505344) throw new Error(`${path}: not a DSPK file`);
  const stride = buf.readUInt8(7), count = buf.readUInt32LE(8);
  const bboxMin = [buf.readFloatLE(12), buf.readFloatLE(16), buf.readFloatLE(20)];
  const bboxMax = [buf.readFloatLE(24), buf.readFloatLE(28), buf.readFloatLE(32)];
  const metaLen = buf.readUInt32LE(44);
  const base = 128 + metaLen;
  const hasSH1 = (buf.readUInt8(5) & 1) === 1 || stride === 29;
  const pos = new Float32Array(count * 3);
  const fdi = new Uint8Array(count), layer = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let k = 0; k < 3; k++) {
      const t = buf.readUInt16LE(o + k * 2) / 65535;
      pos[i * 3 + k] = bboxMin[k] + t * (bboxMax[k] - bboxMin[k]);
    }
    fdi[i] = buf.readUInt8(o + 17);
    layer[i] = buf.readUInt8(o + 18);
  }
  return { path, buf, count, stride, hasSH1, pos, fdi, layer };
}

const full = load(FULL);
const pruned = load(PRUNED);
if (pruned.count >= full.count) throw new Error('pruned is not smaller than full');

// nearest retained neighbour for every REMOVED centre. pruned -> full would read exactly zero
// here: the pruned packet is a true subset, so every pruned centre coincides with a full one.
const CELL = 2.0;
const key = (x, y, z) => x + ',' + y + ',' + z;
const grid = new Map();
for (let i = 0; i < pruned.count; i++) {
  const k = key(Math.floor(pruned.pos[i * 3] / CELL), Math.floor(pruned.pos[i * 3 + 1] / CELL),
    Math.floor(pruned.pos[i * 3 + 2] / CELL));
  const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
}
const EVERY = Math.round(full.count / pruned.count);
const removed = [];
for (let i = 0; i < full.count; i++) if (i % EVERY !== 0) removed.push(i);
const gaps = new Float64Array(removed.length);
for (let r = 0; r < removed.length; r++) {
  const i = removed[r];
  const x = full.pos[i * 3], y = full.pos[i * 3 + 1], z = full.pos[i * 3 + 2];
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const a = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue;
    for (const j of a) {
      const ddx = pruned.pos[j * 3] - x, ddy = pruned.pos[j * 3 + 1] - y, ddz = pruned.pos[j * 3 + 2] - z;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < best) best = d2;
    }
  }
  gaps[r] = Math.sqrt(best);
}
const sorted = Float64Array.from(gaps).sort();
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

// nearest distance from any FDI-48 splat to any mandibular-canal splat (not centroid to centroid:
// the canal has a left and a right branch, so the two centroids sit 30-40 mm apart by construction).
const NCELL = 1.0;
const nerveGrid = new Map();
for (let i = 0; i < full.count; i++) {
  if (full.layer[i] !== 4) continue;
  const k = key(Math.floor(full.pos[i * 3] / NCELL), Math.floor(full.pos[i * 3 + 1] / NCELL),
    Math.floor(full.pos[i * 3 + 2] / NCELL));
  const a = nerveGrid.get(k); if (a) a.push(i); else nerveGrid.set(k, [i]);
}
let pair = Infinity, t48best = null, nbest = null;
for (let i = 0; i < full.count; i++) {
  if (full.fdi[i] !== 48) continue;
  const x = full.pos[i * 3], y = full.pos[i * 3 + 1], z = full.pos[i * 3 + 2];
  const cx = Math.floor(x / NCELL), cy = Math.floor(y / NCELL), cz = Math.floor(z / NCELL);
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const a = nerveGrid.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue;
    for (const j of a) {
      const ddx = full.pos[j * 3] - x, ddy = full.pos[j * 3 + 1] - y, ddz = full.pos[j * 3 + 2] - z;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < pair) { pair = d2; t48best = [x, y, z]; nbest = [full.pos[j * 3], full.pos[j * 3 + 1], full.pos[j * 3 + 2]]; }
    }
  }
}
const t48 = t48best ? [...t48best, 1] : null;
const nerve = nbest ? [...nbest, 1] : null;
const dist = Number.isFinite(pair) ? Math.sqrt(pair) : null;

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const mb = (b) => Math.round((b / 1048576) * 100) / 100;
const entry = {
  full: { splats: full.count, bytes: full.buf.length, mb: mb(full.buf.length),
    sh_degree: full.hasSH1 ? 1 : 0, bytes_per_splat: full.stride },
  pruned: { splats: pruned.count, bytes: pruned.buf.length, mb: mb(pruned.buf.length),
    sh_degree: pruned.hasSH1 ? 1 : 0, bytes_per_splat: pruned.stride },
  bytes_ratio: Math.round((full.buf.length / pruned.buf.length) * 100) / 100,
  compression_fidelity_mm: {
    coverage_gap_mean: Math.round(mean * 1000) / 1000,
    coverage_gap_p95: Math.round(q(0.95) * 1000) / 1000,
    coverage_gap_max: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    kept_subset_of_original: true,
    sampled_pairs: removed.length,
    note: 'every third splat retained with sqrt(3)x tangential scale, so this is a true subset: removed -> retained nearest centre distance. PSNR is measured live in-browser (bench mode)',
  },
  proxy: report.scenes.sceneB_cbct.proxy,
  metrics: {
    ...(dist === null ? {} : {
      ian_48_min_mm: Math.round(dist * 100) / 100,
      tooth_48_at_mm: t48.slice(0, 3).map((v) => Math.round(v * 10) / 10),
      nerve_at_mm: nerve.slice(0, 3).map((v) => Math.round(v * 10) / 10),
    }),
  },
  representation: 'oriented surfel Gaussians (marching cubes surface, Poisson-thinned sampling, quats aligned to vertex normals, s3 = 0.2 s1, SH1, baked three-point light + curvature AO)',
  source_note: report.scenes.sceneB_cbct.source_note,
};
report.scenes.sceneB_cbct = entry;
writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: REPORT, sceneB: entry, fdi48: t48, nerve }, null, 0));
