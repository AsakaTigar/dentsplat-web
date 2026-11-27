#!/usr/bin/env node
/**
 * Transfer Poseidon per-face FDI labels to a gsplat normalized-space PLY.
 * The trained cloud is mapped back through its exact COLMAP normalization into the original STL
 * frame, then each splat takes the nearest labelled surface sample within --max-mm. FDI order is
 * the PLY row order, which is what ply2dspk.ts verifies against the manifest.
 *
 *   node tools/label-transfer-stl-reference.mjs \
 *     --in out_s2_maxilla_3dgs/ply/point_cloud_14999.ply \
 *     --transform case_maxilla/transform.json \
 *     --reference-dir case_maxilla/labeled_reference \
 *     --out-dir tools/out/stage2/maxilla_3dgs/labels
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), TRANSFORM = arg('--transform'), REF = arg('--reference-dir'), OUT = arg('--out-dir');
const MAX_MM = Number(arg('--max-mm', 0.75));
if (!IN || !TRANSFORM || !REF || !OUT) throw new Error('missing args');
const sha = (b) => createHash('sha256').update(b).digest('hex');

function readPly(path) {
  const b = readFileSync(path);
  const head = b.subarray(0, 65536).toString('latin1');
  const marker = 'end_header\n';
  const headEnd = head.indexOf(marker) + marker.length;
  if (headEnd <= 0) throw new Error(`${path}: no end_header`);
  const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
  const props = [...head.matchAll(/^property\s+float\s+(\w+)/gm)].map((m) => m[1]);
  const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
  const rec = props.length * 4;
  if (b.length !== headEnd + n * rec) throw new Error(`${path}: size mismatch`);
  return { b, headEnd, rec, off, n, x: off.x, y: off.y, z: off.z };
}
const ply = readPly(IN);
const jt = readFileSync(TRANSFORM, 'utf8').replace(/^[^{]*/, '');
const T = JSON.parse(jt).transform_normalized_from_colmap;
const s = Math.hypot(T[0][0], T[1][0], T[2][0]);
const R = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => T[i][j] / s));
const Rt = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => R[j][i]));

const raw = readFileSync(join(REF, 'positions.f32'));
const allFdi = readFileSync(join(REF, 'fdi.u8'));
if (raw.length !== allFdi.length * 12) throw new Error('reference positions/fdi length mismatch');
const count = allFdi.length;
const ids = [];
for (let i = 0; i < count; i++) if (allFdi[i] > 0) ids.push(i);
const pts = raw; // already little-endian float32 xyz
function buildKd(ids, depth = 0) {
  if (ids.length <= 16) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const j of ids) for (let k = 0; k < 3; k++) {
      const v = pts.readFloatLE(j * 12 + k * 4); if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    return { leaf: ids, min: mn, max: mx };
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const j of ids) for (let k = 0; k < 3; k++) {
    const v = pts.readFloatLE(j * 12 + k * 4); if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }
  const axis = depth % 3;
  ids.sort((a, b) => pts.readFloatLE(a * 12 + axis * 4) - pts.readFloatLE(b * 12 + axis * 4));
  const mid = ids.length >> 1;
  return { axis, left: buildKd(ids.slice(0, mid), depth + 1), right: buildKd(ids.slice(mid), depth + 1), min: mn, max: mx };
}
const kd = buildKd(ids);
function nearest(x, y, z) {
  let best = Infinity, bestId = -1;
  const stack = [kd];
  while (stack.length) {
    const n = stack.pop();
    const dx = x < n.min[0] ? n.min[0] - x : x > n.max[0] ? x - n.max[0] : 0;
    const dy = y < n.min[1] ? n.min[1] - y : y > n.max[1] ? y - n.max[1] : 0;
    const dz = z < n.min[2] ? n.min[2] - z : z > n.max[2] ? z - n.max[2] : 0;
    if (dx * dx + dy * dy + dz * dz >= best) continue;
    if (n.leaf) {
      for (const j of n.leaf) {
        const d2 = (pts.readFloatLE(j * 12) - x) ** 2 + (pts.readFloatLE(j * 12 + 4) - y) ** 2 + (pts.readFloatLE(j * 12 + 8) - z) ** 2;
        if (d2 < best) { best = d2; bestId = j; }
      }
    } else stack.push(n.left, n.right);
  }
  return { d: Math.sqrt(best), id: bestId };
}

const fdi = Buffer.alloc(ply.n), layer = Buffer.alloc(ply.n);
const hist = new Map(); let assigned = 0; let sumD = 0; let maxD = 0;
for (let i = 0; i < ply.n; i++) {
  const o = ply.headEnd + i * ply.rec;
  const x0 = ply.b.readFloatLE(o + ply.x) - T[0][3];
  const y0 = ply.b.readFloatLE(o + ply.y) - T[1][3];
  const z0 = ply.b.readFloatLE(o + ply.z) - T[2][3];
  const x = (Rt[0][0] * x0 + Rt[0][1] * y0 + Rt[0][2] * z0) / s;
  const y = (Rt[1][0] * x0 + Rt[1][1] * y0 + Rt[1][2] * z0) / s;
  const z = (Rt[2][0] * x0 + Rt[2][1] * y0 + Rt[2][2] * z0) / s;
  const hit = nearest(x, y, z);
  const f = hit.d <= MAX_MM ? allFdi[hit.id] : 0;
  fdi[i] = f; layer[i] = f ? 1 : 0;
  hist.set(f, (hist.get(f) ?? 0) + 1);
  if (f) { assigned++; sumD += hit.d; if (hit.d > maxD) maxD = hit.d; }
}
mkdirSync(OUT, { recursive: true });
const fdiPath = join(OUT, 'fdi_labels.bin'), layerPath = join(OUT, 'layer_labels.bin');
writeFileSync(fdiPath, fdi); writeFileSync(layerPath, layer);
const refManifest = JSON.parse(readFileSync(join(REF, 'reference_manifest.json'), 'utf8'));
const doc = {
  schema: 'dentsplat-label-transfer-v2',
  trained_ply: IN,
  trained_ply_sha256: sha(readFileSync(IN)),
  transform: TRANSFORM,
  transform_sha256: sha(readFileSync(TRANSFORM)),
  reference: refManifest,
  count: ply.n,
  order: 'trained-ply-row-order, no permutation',
  files: {
    'fdi_labels.bin': { sha256: sha(fdi), count: ply.n },
    'layer_labels.bin': { sha256: sha(layer), count: ply.n },
  },
  max_mm: MAX_MM,
  fdi_sha256: sha(fdi),
  layer_sha256: sha(layer),
  fdi_file: 'fdi_labels.bin',
  layer_file: 'layer_labels.bin',
  fdi_histogram: Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0])),
  assigned: assigned,
  assigned_fraction: +(assigned / ply.n).toFixed(4),
  assigned_mean_distance_mm: +(sumD / Math.max(1, assigned)).toFixed(4),
  assigned_max_distance_mm: +maxD.toFixed(4),
};
writeFileSync(join(OUT, 'labels_manifest.json'), JSON.stringify(doc, null, 2));
console.log(JSON.stringify({ out: OUT, count: ply.n, assigned_fraction: doc.assigned_fraction, assigned_mean_distance_mm: doc.assigned_mean_distance_mm, fdi: doc.fdi_histogram }, null, 2));