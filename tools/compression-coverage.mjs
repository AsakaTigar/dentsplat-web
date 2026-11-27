#!/usr/bin/env node
/**
 * Full→compressed point-cloud coverage for the Scene-B 10x packets.
 * For every point in the full 111k cloud, find the nearest compressed centre (kd-tree).
 * This measures holes in the compressed surface; unlike pruned→full distance it is non-zero
 * even when the compressed packet is a strict subset of the full cloud.
 *
 *   node tools/compression-coverage.mjs \
 *     --full public/assets/sceneB_dentvoxel_full.dspk \
 *     --uniform public/assets/sceneB_10x_uniform.dspk \
 *     --anatomy public/assets/sceneB_10x_anatomy.dspk \
 *     --out public/assets/compression_coverage.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FULL = arg('--full'), UNIFORM = arg('--uniform'), ANATOMY = arg('--anatomy'), OUT = arg('--out');
if (!FULL || !UNIFORM || !ANATOMY || !OUT) throw new Error('missing args');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function centers(path) {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== 0x4b505344) throw new Error(`${path}: not DSPK`);
  const stride = b[7], count = b.readUInt32LE(8), meta = b.readUInt32LE(44), base = 128 + meta;
  if (b.length !== base + count * stride) throw new Error(`${path}: size mismatch`);
  const lo = [b.readFloatLE(12), b.readFloatLE(16), b.readFloatLE(20)];
  const hi = [b.readFloatLE(24), b.readFloatLE(28), b.readFloatLE(32)];
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = lo[k] + b.readUInt16LE(o + k * 2) / 65535 * (hi[k] - lo[k]);
  }
  return { count, points: out, sha256: sha(path) };
}
function buildKd(points, ids, depth = 0) {
  if (ids.length <= 16) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const j of ids) for (let k = 0; k < 3; k++) {
      const v = points[j * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    return { leaf: ids, min: mn, max: mx };
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const j of ids) for (let k = 0; k < 3; k++) {
    const v = points[j * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }
  const axis = depth % 3;
  ids.sort((a, b) => points[a * 3 + axis] - points[b * 3 + axis]);
  const mid = ids.length >> 1;
  return { axis, left: buildKd(points, ids.slice(0, mid), depth + 1), right: buildKd(points, ids.slice(mid), depth + 1), min: mn, max: mx };
}
function nearest(root, points, x, y, z) {
  let best = Infinity;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    const dx = x < n.min[0] ? n.min[0] - x : x > n.max[0] ? x - n.max[0] : 0;
    const dy = y < n.min[1] ? n.min[1] - y : y > n.max[1] ? y - n.max[1] : 0;
    const dz = z < n.min[2] ? n.min[2] - z : z > n.max[2] ? z - n.max[2] : 0;
    if (dx * dx + dy * dy + dz * dz >= best) continue;
    if (n.leaf) {
      for (const j of n.leaf) {
        const d2 = (points[j * 3] - x) ** 2 + (points[j * 3 + 1] - y) ** 2 + (points[j * 3 + 2] - z) ** 2;
        if (d2 < best) best = d2;
      }
    } else stack.push(n.left, n.right);
  }
  return Math.sqrt(best);
}
function measure(full, compact) {
  const kd = buildKd(compact.points, Array.from({ length: compact.count }, (_, i) => i));
  const d = new Float32Array(full.count);
  for (let i = 0; i < full.count; i++) d[i] = nearest(kd, compact.points, full.points[i * 3], full.points[i * 3 + 1], full.points[i * 3 + 2]);
  const sorted = Array.from(d).sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3);
  return {
    full_points: full.count,
    compressed_points: compact.count,
    compressed_sha256: compact.sha256,
    mean_mm: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(3),
    p50_mm: pct(0.5),
    p95_mm: pct(0.95),
    max_mm: +sorted[sorted.length - 1].toFixed(3),
  };
}
const full = centers(FULL), uniform = centers(UNIFORM), anatomy = centers(ANATOMY);
const doc = {
  schema: 'dentsplat-compression-coverage-v1',
  generated_at: new Date().toISOString(),
  definition: 'for every full-cloud centre, nearest compressed-cloud centre (coverage holes); full and compressed DSPK positions are decoded through their own bounding boxes',
  full: { file: FULL, ...full, points: undefined },
  uniform: measure(full, uniform),
  anatomy: measure(full, anatomy),
};
writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log(JSON.stringify({ uniform: doc.uniform, anatomy: doc.anatomy }, null, 2));