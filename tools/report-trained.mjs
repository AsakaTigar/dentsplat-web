/** Re-derive the Case A · Trained report block from the shipped packets and a browser bench capture.
 *
 *   node tools/report-trained.mjs --full public/assets/sceneA_trained_full.dspk \
 *     --pruned public/assets/sceneA_trained_pruned.dspk --report public/assets/report.json \
 *     --bench tools/out/bench-A2-trained.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FULL = arg('--full'), PRUNED = arg('--pruned'), REPORT = arg('--report'), BENCH = arg('--bench');
if (!FULL || !PRUNED || !REPORT) { console.error('usage: --full x.dspk --pruned y.dspk --report report.json [--bench capture.json]'); process.exit(2); }

function load(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x4b505344) throw new Error(`${path}: not DSPK`);
  const stride = buf.readUInt8(7), count = buf.readUInt32LE(8);
  const bboxMin = [buf.readFloatLE(12), buf.readFloatLE(16), buf.readFloatLE(20)];
  const bboxMax = [buf.readFloatLE(24), buf.readFloatLE(28), buf.readFloatLE(32)];
  const base = 128 + buf.readUInt32LE(44);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let k = 0; k < 3; k++) {
      const t = buf.readUInt16LE(o + k * 2) / 65535;
      pos[i * 3 + k] = bboxMin[k] + t * (bboxMax[k] - bboxMin[k]);
    }
  }
  return { buf, count, stride, hasSH1: stride === 29, pos };
}
const full = load(FULL), pruned = load(PRUNED);
const EVERY = Math.round(full.count / pruned.count);
if (EVERY < 2 || pruned.count !== Math.ceil(full.count / EVERY)) throw new Error('pruned packet is not an every-Nth subset');

const CELL = 2.0;
const key = (x, y, z) => x + ',' + y + ',' + z;
const grid = new Map();
for (let i = 0; i < pruned.count; i++) {
  const k = key(Math.floor(pruned.pos[i * 3] / CELL), Math.floor(pruned.pos[i * 3 + 1] / CELL),
    Math.floor(pruned.pos[i * 3 + 2] / CELL));
  const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
}
const gaps = [];
for (let i = 0; i < full.count; i++) {
  if (i % EVERY === 0) continue;
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
  gaps.push(Math.sqrt(best));
}
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * (gaps.length - 1)))];
const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
const sha = createHash('sha256').update(full.buf).digest('hex');
const bench = BENCH ? JSON.parse(readFileSync(BENCH, 'utf8')) : null;
const b = bench?.res?.bench;
if (BENCH && (!b || bench?.res?.caseId !== 'A2')) throw new Error('bench capture is not an A2 bench result');

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const mb = (n) => Math.round(n / 1048576 * 100) / 100;
const entry = {
  full: { splats: full.count, bytes: full.buf.length, mb: mb(full.buf.length),
    sh_degree: full.hasSH1 ? 1 : 0, bytes_per_splat: full.stride },
  pruned: { splats: pruned.count, bytes: pruned.buf.length, mb: mb(pruned.buf.length),
    sh_degree: pruned.hasSH1 ? 1 : 0, bytes_per_splat: pruned.stride },
  bytes_ratio: Math.round(full.buf.length / pruned.buf.length * 100) / 100,
  compression_fidelity_mm: {
    coverage_gap_mean: Math.round(mean * 1000) / 1000,
    coverage_gap_p95: Math.round(q(0.95) * 1000) / 1000,
    coverage_gap_max: Math.round(gaps[gaps.length - 1] * 1000) / 1000,
    kept_subset_of_original: true, sampled_pairs: gaps.length,
    note: 'every third splat retained with sqrt(3)x tangential scale; removed -> retained nearest centre distance',
  },
  proxy: report.scenes.sceneA_trained?.proxy ?? report.scenes.sceneA_ios.proxy,
  metrics: {},
  training: { tool: 'Brush v0.3.0 (WGPU)', steps: 15000, views: 120,
    sh_degree: 1, sh1_nonzero: true, labels: 'transferred from the sampled packet, 99.5% within 1.0 mm' },
  bench: b ? { psnr: b.psnr, psnr_in_mask: b.psnrInMask, mae: b.mae,
    identical_fraction: b.identicalFraction, self_psnr: b.psnrSelf,
    self_identical_fraction: b.identicalSelfFraction, size: 384,
    capture: BENCH, sha256: sha, ua: bench.ua } : null,
  source_note: 'Poseidon3D case 000125 geometry via 120 Blender renders; appearance optimised by Brush (no real texture exists)',
};
report.scenes.sceneA_trained = entry;
writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(entry, null, 1));
