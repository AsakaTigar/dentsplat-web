#!/usr/bin/env node
/**
 * Exact point-to-triangle geometry audit for the Stage-2 cross-case runs.
 *
 * Inputs are gsplat normalized-space PLYs. They are mapped back through the exact COLMAP
 * normalization transform (scale + translation + rotation) into the source-mesh frame, then
 * audited against the decimated mesh that the trainer actually saw (face count is checked by
 * the caller against render_meta.json).
 *
 *   node tools/geometry-audit-crosscase.mjs \
 *     --mesh E:/dentsplat_work/case_maxilla/decimated.obj \
 *     --transform E:/dentsplat_work/case_maxilla/transform.json \
 *     --out tools/out/stage2/maxilla_geometry.json \
 *     --cloud 3dgs=E:/dentsplat_work/out_s2_maxilla_3dgs/ply/point_cloud_14999.ply \
 *     --cloud 2dgs=E:/dentsplat_work/out_s2_maxilla_2dgs/ply/point_cloud_15000.ply
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const argsAll = (f) => argv.reduce((acc, v, i) => (v === f ? [...acc, argv[i + 1]] : acc), []);
const MESH = arg('--mesh');
const TRANSFORM = arg('--transform');
const OUT = arg('--out');
const clouds = argsAll('--cloud').map((s) => { const k = s.indexOf('='); return { name: s.slice(0, k), path: s.slice(k + 1) }; });
if (!MESH || !TRANSFORM || !OUT || !clouds.length) throw new Error('missing args');
const MESH_SAMPLES = 120000;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- source mesh (the exact decimated surface used to render training views) ----
function readObj(path) {
  const text = readFileSync(path, 'utf8');
  const verts = [], faces = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      verts.push(p[0], p[1], p[2]);
    } else if (line.startsWith('f ')) {
      const ids = line.slice(2).trim().split(/\s+/).map((s) => Number(s.split('/')[0]) - 1);
      for (let k = 1; k + 1 < ids.length; k++) faces.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  return { V: new Float32Array(verts), faces: new Int32Array(faces), nv: verts.length / 3, nt: faces.length / 3 };
}
const { V, faces, nv, nt } = readObj(MESH);
const faceN = new Float32Array(nt * 3), faceArea = new Float32Array(nt);
for (let t = 0; t < nt; t++) {
  const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  faceN[t * 3] = nx / l; faceN[t * 3 + 1] = ny / l; faceN[t * 3 + 2] = nz / l;
  faceArea[t] = 0.5 * l;
}

// ---- exact point-to-triangle BVH ----
const triCenter = new Float32Array(nt * 3);
for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
  triCenter[t * 3 + k] = (V[faces[t * 3] * 3 + k] + V[faces[t * 3 + 1] * 3 + k] + V[faces[t * 3 + 2] * 3 + k]) / 3;
}
function buildBVH(ids) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let cmnx = Infinity, cmny = Infinity, cmnz = Infinity, cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
  for (const t of ids) {
    for (let k = 0; k < 3; k++) {
      const p = V[faces[t * 3 + k] * 3], q = V[faces[t * 3 + k] * 3 + 1], r = V[faces[t * 3 + k] * 3 + 2];
      if (p < mnx) mnx = p; if (p > mxx) mxx = p; if (q < mny) mny = q; if (q > mxy) mxy = q; if (r < mnz) mnz = r; if (r > mxz) mxz = r;
    }
    const cx = triCenter[t * 3], cy = triCenter[t * 3 + 1], cz = triCenter[t * 3 + 2];
    if (cx < cmnx) cmnx = cx; if (cx > cmxx) cmxx = cx; if (cy < cmny) cmny = cy; if (cy > cmxy) cmxy = cy; if (cz < cmnz) cmnz = cz; if (cz > cmxz) cmxz = cz;
  }
  const node = { min: [mnx, mny, mnz], max: [mxx, mxy, mxz], leaf: null, left: null, right: null };
  if (ids.length <= 12) { node.leaf = ids; return node; }
  const ex = [cmxx - cmnx, cmxy - cmny, cmxz - cmnz];
  const axis = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
  ids.sort((a, b) => triCenter[a * 3 + axis] - triCenter[b * 3 + axis]);
  const mid = ids.length >> 1;
  node.left = buildBVH(ids.slice(0, mid));
  node.right = buildBVH(ids.slice(mid));
  return node;
}
const bvh = buildBVH(Array.from({ length: nt }, (_, i) => i));
const scratch = { d2: 0, nx: 0, ny: 0, nz: 0 };
function pointTriangle(p, t) {
  const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
  const ax = V[a], ay = V[a + 1], az = V[a + 2];
  const bx = V[b], by = V[b + 1], bz = V[b + 2];
  const cx = V[c], cy = V[c + 1], cz = V[c + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let px, py, pz;
  if (d1 <= 0 && d2 <= 0) { px = ax; py = ay; pz = az; }
  else {
    const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { px = bx; py = by; pz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); px = ax + v * abx; py = ay + v * aby; pz = az + v * abz; }
      else {
        const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { px = cx; py = cy; pz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); px = ax + w * acx; py = ay + w * acy; pz = az + w * acz; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              px = bx + w * (cx - bx); py = by + w * (cy - by); pz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              px = ax + abx * v + acx * w; py = ay + aby * v + acy * w; pz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  scratch.d2 = (p[0] - px) ** 2 + (p[1] - py) ** 2 + (p[2] - pz) ** 2;
  scratch.nx = faceN[t * 3]; scratch.ny = faceN[t * 3 + 1]; scratch.nz = faceN[t * 3 + 2];
  return scratch;
}
function boxD2(node, p) {
  const dx = p[0] < node.min[0] ? node.min[0] - p[0] : p[0] > node.max[0] ? p[0] - node.max[0] : 0;
  const dy = p[1] < node.min[1] ? node.min[1] - p[1] : p[1] > node.max[1] ? p[1] - node.max[1] : 0;
  const dz = p[2] < node.min[2] ? node.min[2] - p[2] : p[2] > node.max[2] ? p[2] - node.max[2] : 0;
  return dx * dx + dy * dy + dz * dz;
}
function nearestMesh(p) {
  let best = Infinity, nx = 0, ny = 0, nz = 0;
  const stack = [bvh];
  while (stack.length) {
    const n = stack.pop();
    if (boxD2(n, p) >= best) continue;
    if (n.leaf) {
      for (const t of n.leaf) {
        const h = pointTriangle(p, t);
        if (h.d2 < best) { best = h.d2; nx = h.nx; ny = h.ny; nz = h.nz; }
      }
    } else stack.push(n.left, n.right);
  }
  return { d: Math.sqrt(best), nx, ny, nz };
}

// ---- deterministic area-weighted mesh samples ----
const cum = new Float64Array(nt);
let totalArea = 0;
for (let t = 0; t < nt; t++) { totalArea += faceArea[t]; cum[t] = totalArea; }
const sampleV = new Float32Array(MESH_SAMPLES * 3);
let rngState = 0x31415926;
const rng = () => ((rngState = (rngState * 1664525 + 1013904223) >>> 0) / 4294967296);
let cur = 0;
for (let k = 0; k < MESH_SAMPLES; k++) {
  const target = (k + 0.5) / MESH_SAMPLES * totalArea;
  while (cur < nt - 1 && cum[cur] < target) cur++;
  const t = cur;
  let u = rng(), v = rng();
  if (u + v > 1) { u = 1 - u; v = 1 - v; }
  const w = 1 - u - v;
  const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
  for (let j = 0; j < 3; j++) sampleV[k * 3 + j] = V[a + j] * w + V[b + j] * u + V[c + j] * v;
}
// ---- k-d tree over cloud centres for the mesh→cloud direction ----
function buildKd(points, ids, depth = 0) {
  if (ids.length <= 16) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const j of ids) for (let k = 0; k < 3; k++) {
      const v = points[j * 3 + k];
      if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    return { leaf: ids, min: mn, max: mx };
  }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const j of ids) for (let k = 0; k < 3; k++) {
    const v = points[j * 3 + k];
    if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }
  const axis = depth % 3;
  ids.sort((a, b) => points[a * 3 + axis] - points[b * 3 + axis]);
  const mid = ids.length >> 1;
  return { axis, left: buildKd(points, ids.slice(0, mid), depth + 1), right: buildKd(points, ids.slice(mid), depth + 1), min: mn, max: mx };
}
function kdNearest(root, points, x, y, z) {
  let best = Infinity;
  const stack = [(root)];
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

// ---- normalization transform ----
const tdoc = JSON.parse(readFileSync(TRANSFORM, 'utf8').replace(/^[^{]*/, ''));
const T = tdoc.transform_normalized_from_colmap;
const s = Math.hypot(T[0][0], T[1][0], T[2][0]);
const R = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => T[i][j] / s));
const Rt = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => R[j][i]));
function quatFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  if (tr > 0) { const q = Math.sqrt(tr + 1) * 2; return [0.25 * q, (m[2][1] - m[1][2]) / q, (m[0][2] - m[2][0]) / q, (m[1][0] - m[0][1]) / q]; }
  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const q = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; return [(m[2][1] - m[1][2]) / q, 0.25 * q, (m[0][1] + m[1][0]) / q, (m[0][2] + m[2][0]) / q]; }
  if (m[1][1] > m[2][2]) { const q = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; return [(m[0][2] - m[2][0]) / q, (m[0][1] + m[1][0]) / q, 0.25 * q, (m[1][2] + m[2][1]) / q]; }
  const q = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
  return [(m[1][0] - m[0][1]) / q, (m[0][2] + m[2][0]) / q, (m[1][2] + m[2][1]) / q, 0.25 * q];
}
const qc = quatFromMatrix(Rt);
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

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
  for (const p of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
    if (off[p] === undefined) throw new Error(`${path}: missing ${p}`);
  }
  const centers = new Float32Array(n * 3), quats = new Float32Array(n * 4), scales = new Float32Array(n * 3);
  const logS = Math.log(s);
  for (let i = 0; i < n; i++) {
    const o = headEnd + i * rec;
    const x = b.readFloatLE(o + off.x) - T[0][3];
    const y = b.readFloatLE(o + off.y) - T[1][3];
    const z = b.readFloatLE(o + off.z) - T[2][3];
    centers[i * 3] = (Rt[0][0] * x + Rt[0][1] * y + Rt[0][2] * z) / s;
    centers[i * 3 + 1] = (Rt[1][0] * x + Rt[1][1] * y + Rt[1][2] * z) / s;
    centers[i * 3 + 2] = (Rt[2][0] * x + Rt[2][1] * y + Rt[2][2] * z) / s;
    const q = [b.readFloatLE(o + off.rot_0), b.readFloatLE(o + off.rot_1), b.readFloatLE(o + off.rot_2), b.readFloatLE(o + off.rot_3)];
    const r = qmul(qc, q), qn = Math.hypot(...r) || 1;
    for (let k = 0; k < 4; k++) quats[i * 4 + k] = r[k] / qn;
    for (let k = 0; k < 3; k++) scales[i * 3 + k] = Math.exp(b.readFloatLE(o + off[`scale_${k}`]) - logS);
  }
  return { path, bytes: b.length, sha256: sha(b), count: n, centers, quats, scales };
}

function minorAxis(q, s3) {
  const [x, y, z, w] = q;
  const Rm = [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
  const k = s3[0] <= s3[1] && s3[0] <= s3[2] ? 0 : s3[1] <= s3[2] ? 1 : 2;
  return [Rm[k], Rm[3 + k], Rm[6 + k]];
}

function audit(cloud) {
  const kd = buildKd(cloud.centers, Array.from({ length: cloud.count }, (_, i) => i));
  const c2m = [], m2c = [], normals = [];
  const t0 = Date.now();
  for (let i = 0; i < cloud.count; i++) {
    const p = [cloud.centers[i * 3], cloud.centers[i * 3 + 1], cloud.centers[i * 3 + 2]];
    const hit = nearestMesh(p);
    c2m.push(hit.d);
    const nrm = minorAxis(cloud.quats.subarray(i * 4, i * 4 + 4), cloud.scales.subarray(i * 3, i * 3 + 3));
    normals.push(Math.abs(nrm[0] * hit.nx + nrm[1] * hit.ny + nrm[2] * hit.nz));
    if ((i + 1) % 20000 === 0) console.error(`  c2m ${i + 1}/${cloud.count} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  for (let j = 0; j < MESH_SAMPLES; j++) m2c.push(kdNearest(kd, cloud.centers, sampleV[j * 3], sampleV[j * 3 + 1], sampleV[j * 3 + 2]));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(4); };
  const frac = (a, t) => +(a.filter((x) => x <= t).length / a.length).toFixed(4);
  return {
    count: cloud.count,
    cloud_to_mesh: { mean_mm: +(sum(c2m) / c2m.length).toFixed(4), p50_mm: pct(c2m, 0.5), p95_mm: pct(c2m, 0.95), max_mm: +Math.max(...c2m).toFixed(4) },
    mesh_to_cloud: { mean_mm: +(sum(m2c) / m2c.length).toFixed(4), p50_mm: pct(m2c, 0.5), p95_mm: pct(m2c, 0.95), max_mm: +Math.max(...m2c).toFixed(4) },
    fscore: { threshold_mm: 0.5, precision: frac(c2m, 0.5), recall: frac(m2c, 0.5) },
    normal_abs_dot: { mean: +(sum(normals) / normals.length).toFixed(4), p50: pct(normals, 0.5), p10: pct(normals, 0.1) },
  };
}

const out = {
  schema: 'dentsplat-crosscase-geometry-v1',
  generated_at: new Date().toISOString(),
  mesh: { path: MESH, sha256: sha(readFileSync(MESH)), triangles: nt, vertices: nv, role: 'decimated surface that rendered the training views (face count verified against render_meta.json)' },
  normalization: { path: TRANSFORM, source_axis: 'COLMAP world frame (the STL frame the renderer used)', inverse_scale: s, note: 'points and rotations mapped by R^T and translation; scales shifted by -log(s). No viewer-frame R_y(-90) is applied here, so distances are measured in the original STL frame.' },
  methods: {},
  caveat: 'Cloud→mesh is exact point-to-triangle distance against the decimated training mesh. Mesh→cloud uses 120,000 deterministic area-weighted samples of that same mesh. Appearance in training was a synthetic height/facing material rendered from this geometry, not a patient photograph.',
};
for (const c of clouds) {
  const cloud = readPly(c.path);
  out.methods[c.name] = { file: c.path, ...audit(cloud) };
  console.error(`${c.name}: ${cloud.count} splats, c2m mean ${out.methods[c.name].cloud_to_mesh.mean_mm} mm`);
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ out: OUT, methods: Object.fromEntries(Object.entries(out.methods).map(([k, v]) => [k, { count: v.count, c2m: v.cloud_to_mesh, fscore: v.fscore, normal: v.normal_abs_dot.mean }])) }, null, 2));
