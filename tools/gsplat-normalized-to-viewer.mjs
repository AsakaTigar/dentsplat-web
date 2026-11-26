#!/usr/bin/env node
/** Map a gsplat normalized-world PLY back through the exact COLMAP normalization and into viewer frame. */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), TRANSFORM = arg('--transform'), OUT = arg('--out');
if (!IN || !TRANSFORM || !OUT) throw new Error('usage: --in normalized.ply --transform transform.json --out viewer.ply');

const jt = readFileSync(TRANSFORM, 'utf8');
const doc = JSON.parse(jt.slice(jt.indexOf('{')));
const T = doc.transform_normalized_from_colmap;
if (!Array.isArray(T) || T.length !== 4) throw new Error('invalid normalization transform');
const s = Math.hypot(T[0][0], T[1][0], T[2][0]);
const R = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => T[i][j] / s));
const Rt = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => R[j][i]));
const F = [[0, 0, -1], [0, 1, 0], [1, 0, 0]];
const A = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
  (F[i][0] * Rt[0][j] + F[i][1] * Rt[1][j] + F[i][2] * Rt[2][j]) / s));
const Q = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
  F[i][0] * Rt[0][j] + F[i][1] * Rt[1][j] + F[i][2] * Rt[2][j]));

function quatFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  if (tr > 0) {
    const q = Math.sqrt(tr + 1) * 2;
    return [0.25 * q, (m[2][1] - m[1][2]) / q, (m[0][2] - m[2][0]) / q, (m[1][0] - m[0][1]) / q];
  }
  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const q = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    return [(m[2][1] - m[1][2]) / q, 0.25 * q, (m[0][1] + m[1][0]) / q, (m[0][2] + m[2][0]) / q];
  }
  if (m[1][1] > m[2][2]) {
    const q = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    return [(m[0][2] - m[2][0]) / q, (m[0][1] + m[1][0]) / q, 0.25 * q, (m[1][2] + m[2][1]) / q];
  }
  const q = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
  return [(m[1][0] - m[0][1]) / q, (m[0][2] + m[2][0]) / q, (m[1][2] + m[2][1]) / q, 0.25 * q];
}
const qc = quatFromMatrix(Q);
const mul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

const b = readFileSync(IN);
const head = b.subarray(0, 65536).toString('latin1');
const marker = 'end_header\n';
const headEnd = head.indexOf(marker) + marker.length;
if (headEnd <= 0) throw new Error('no end_header');
const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
const props = [...head.matchAll(/^property float (\w+)/gm)].map((m) => m[1]);
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const rec = props.length * 4;
if (b.length !== headEnd + n * rec) throw new Error('size mismatch');
for (const p of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
  if (off[p] === undefined) throw new Error(`missing ${p}`);
}

const header = head.slice(0, headEnd).replace(marker,
  `comment inverse gsplat normalization scale=${s}; then R_y(-90) into viewer frame; SH bands left unchanged for audit-only geometry\n${marker}`);
const out = Buffer.allocUnsafe(header.length + n * rec);
out.write(header, 0, 'latin1');
const logS = Math.log(s);
for (let i = 0; i < n; i++) {
  const o = headEnd + i * rec, d = header.length + i * rec;
  for (const p of props) out.writeFloatLE(b.readFloatLE(o + off[p]), d + off[p]);
  const x = b.readFloatLE(o + off.x) - T[0][3];
  const y = b.readFloatLE(o + off.y) - T[1][3];
  const z = b.readFloatLE(o + off.z) - T[2][3];
  out.writeFloatLE(A[0][0] * x + A[0][1] * y + A[0][2] * z, d + off.x);
  out.writeFloatLE(A[1][0] * x + A[1][1] * y + A[1][2] * z, d + off.y);
  out.writeFloatLE(A[2][0] * x + A[2][1] * y + A[2][2] * z, d + off.z);
  for (let k = 0; k < 3; k++) out.writeFloatLE(b.readFloatLE(o + off[`scale_${k}`]) - logS, d + off[`scale_${k}`]);
  const q = [b.readFloatLE(o + off.rot_0), b.readFloatLE(o + off.rot_1), b.readFloatLE(o + off.rot_2), b.readFloatLE(o + off.rot_3)];
  const r = mul(qc, q), qn = Math.hypot(...r) || 1;
  for (let k = 0; k < 4; k++) out.writeFloatLE(r[k] / qn, d + off[`rot_${k}`]);
}
writeFileSync(OUT, out);
console.log(JSON.stringify({ in: IN, transform: TRANSFORM, out: OUT, splats: n, normalization_scale: s, combined_rotation: Q, combined_quaternion_wxyz: qc }));
