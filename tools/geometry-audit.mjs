/**
 * Geometry audit for the same-source Poseidon3D 000125 comparison.
 *
 * Inputs are the actual exported mesh and the two shipped DSPK packets. The mesh is used as
 * a vertex sample (95,324 welded vertices); this is NOT an exact point-to-triangle distance.
 * We label the metric accordingly so a Chamfer/F-score figure is never quoted as if it were
 * computed against a dense area-weighted surface.
 *
 *   node tools/geometry-audit.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const OBJ = 'D:/Aodou/.cache/tmp/poseidon/obj/000125_lower.obj';
const MESH_SOURCE = 'D:/Aodou/.cache/tmp/poseidon/c125/000125_MODEL_mandible.stl';
const TRAINED = 'public/assets/sceneA_trained_full.dspk';
const SAMPLED = 'public/assets/sceneA_poseidon_full.dspk';
const TRAINED_RAW = 'tools/out/case125/brush_run/caseA_15000.ply';
const SAMPLED_RAW = 'tools/out/poseidon/poseidon125_full.ply';
const OUT = 'public/assets/geometry_metrics.json';
const UP = 2, FWD = 0, SIDE = 1, SIGN = 1;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const objBuf = readFileSync(OBJ);
const text = objBuf.toString('utf8');
const verts = [];
const faces = [];
for (const line of text.split('\n')) {
  if (line.startsWith('v ')) {
    const p = line.slice(2).trim().split(/\s+/).map(Number);
    verts.push(p[0], p[1], p[2]);
  } else if (line.startsWith('f ')) {
    const ids = line.slice(2).trim().split(/\s+/).map((s) => Number(s.split('/')[0]) - 1);
    if (ids.length >= 3) for (let k = 1; k + 1 < ids.length; k++) faces.push(ids[0], ids[k], ids[k + 1]);
  }
}
const nv = verts.length / 3, nt = faces.length / 3;
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
  mn[k] = Math.min(mn[k], verts[i * 3 + k]); mx[k] = Math.max(mx[k], verts[i * 3 + k]);
}
const cent = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
const toApp = (x, y, z) => {
  const p = [x, y, z];
  return [p[SIDE] - cent[SIDE], p[UP] - cent[UP], SIGN * (p[FWD] - cent[FWD])];
};
const V = new Float32Array(nv * 3);
for (let i = 0; i < nv; i++) {
  const p = toApp(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
  V[i * 3] = p[0]; V[i * 3 + 1] = p[1]; V[i * 3 + 2] = p[2];
}
const N = new Float32Array(nv * 3);
for (let t = 0; t < nt; t++) {
  const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
}
for (let i = 0; i < nv; i++) {
  const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
  N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
}

function readDspk(path) {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== 0x4b505344) throw new Error(`${path}: not DSPK`);
  const stride = b[7], count = b.readUInt32LE(8);
  const bboxMin = [b.readFloatLE(12), b.readFloatLE(16), b.readFloatLE(20)];
  const bboxMax = [b.readFloatLE(24), b.readFloatLE(28), b.readFloatLE(32)];
  const logMin = b.readFloatLE(36), logMax = b.readFloatLE(40);
  const metaLen = b.readUInt32LE(44), base = 128 + metaLen;
  if (b.length !== base + count * stride) throw new Error(`${path}: size mismatch`);
  const span = bboxMax.map((v, k) => v - bboxMin[k]);
  const centers = new Float32Array(count * 3), quats = new Float32Array(count * 4), scales = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let k = 0; k < 3; k++) {
      centers[i * 3 + k] = bboxMin[k] + (b.readUInt16LE(o + k * 2) / 65535) * span[k];
      quats[i * 4 + k] = b.readUInt8(o + 6 + k) / 255 * 2 - 1;
      scales[i * 3 + k] = Math.exp(logMin + (b.readUInt8(o + 10 + k) / 255) * (logMax - logMin));
    }
    quats[i * 4 + 3] = b.readUInt8(o + 9) / 255 * 2 - 1;
    const qn = Math.hypot(quats[i * 4], quats[i * 4 + 1], quats[i * 4 + 2], quats[i * 4 + 3]) || 1;
    for (let k = 0; k < 4; k++) quats[i * 4 + k] /= qn;
  }
  return { path, bytes: b.length, sha256: sha(b), count, centers, quats, scales };
}

function readPlyCloud(path, rotateYM90 = false) {
  const b = readFileSync(path);
  const head = b.subarray(0, 65536).toString('latin1');
  const marker = 'end_header\n';
  const headEnd = head.indexOf(marker) + marker.length;
  if (headEnd <= 0) throw new Error(`${path}: no end_header`);
  const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
  const sizeOf = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, double: 8 };
  const props = [...head.matchAll(/^property\s+(\w+)\s+(\w+)/gm)].map((m) => ({ type: m[1], name: m[2] }));
  const off = {};
  let rec = 0;
  for (const p of props) { off[p.name] = rec; rec += sizeOf[p.type] ?? 0; }
  if (!rec) throw new Error(`${path}: no scalar properties`);
  if (b.length !== headEnd + n * rec) throw new Error(`${path}: size mismatch`);
  const centers = new Float32Array(n * 3);
  const hasRot = off.rot_0 !== undefined;
  const hasScale = off.scale_0 !== undefined;
  const quats = hasRot ? new Float32Array(n * 4) : null;
  const scales = hasScale ? new Float32Array(n * 3) : null;
  const s = Math.SQRT1_2;
  for (let i = 0; i < n; i++) {
    const o = headEnd + i * rec;
    let x = b.readFloatLE(o + off.x), y = b.readFloatLE(o + off.y), z = b.readFloatLE(o + off.z);
    if (rotateYM90) { const t = x; x = -z; z = t; }
    centers[i * 3] = x; centers[i * 3 + 1] = y; centers[i * 3 + 2] = z;
    if (quats) {
      const w = b.readFloatLE(o + off.rot_0), qx = b.readFloatLE(o + off.rot_1);
      const qy = b.readFloatLE(o + off.rot_2), qz = b.readFloatLE(o + off.rot_3);
      let nw = w, nx = qx, ny = qy, nz = qz;
      if (rotateYM90) { nw = s * (w + qy); nx = s * (qx - qz); ny = s * (qy - w); nz = s * (qz + qx); }
      const qn = Math.hypot(nw, nx, ny, nz) || 1;
      quats[i * 4] = nx / qn; quats[i * 4 + 1] = ny / qn; quats[i * 4 + 2] = nz / qn; quats[i * 4 + 3] = nw / qn;
    }
    if (scales) for (let k = 0; k < 3; k++) scales[i * 3 + k] = Math.exp(b.readFloatLE(o + off['scale_' + k]));
  }
  return { path, bytes: b.length, sha256: sha(b), count: n, centers, quats, scales };
}

function minorAxis(q, s) {
  const [x, y, z, w] = q;
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
  const k = s[0] <= s[1] && s[0] <= s[2] ? 0 : s[1] <= s[2] ? 1 : 2;
  return [R[k], R[3 + k], R[6 + k]];
}

function makeGrid(points, cell) {
  const map = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    const cx = Math.floor(points[i] / cell), cy = Math.floor(points[i + 1] / cell), cz = Math.floor(points[i + 2] / cell);
    const k = key(cx, cy, cz);
    const arr = map.get(k); if (arr) arr.push(i / 3); else map.set(k, [i / 3]);
    mn[0] = Math.min(mn[0], cx); mn[1] = Math.min(mn[1], cy); mn[2] = Math.min(mn[2], cz);
    mx[0] = Math.max(mx[0], cx); mx[1] = Math.max(mx[1], cy); mx[2] = Math.max(mx[2], cz);
  }
  return {
    nearest(x, y, z) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let best = Infinity, bestIdx = -1;
      for (let r = 0; r < 64; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const arr = map.get(key(cx + dx, cy + dy, cz + dz));
          if (!arr) continue;
          for (const j of arr) {
            const d2 = (points[j * 3] - x) ** 2 + (points[j * 3 + 1] - y) ** 2 + (points[j * 3 + 2] - z) ** 2;
            if (d2 < best) { best = d2; bestIdx = j; }
          }
        }
        if (bestIdx >= 0 && Math.sqrt(best) <= r * cell) break;
      }
      return { d: Math.sqrt(best), i: bestIdx };
    },
  };
}

const meshGrid = makeGrid(V, 0.9);
function audit(cloud) {
  const g = makeGrid(cloud.centers, 0.9);
  const c2m = [], m2c = [], normals = [];
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.centers[i * 3], y = cloud.centers[i * 3 + 1], z = cloud.centers[i * 3 + 2];
    const hit = meshGrid.nearest(x, y, z);
    c2m.push(hit.d);
    if (hit.i >= 0 && cloud.quats && cloud.scales) {
      const n = minorAxis(cloud.quats.subarray(i * 4, i * 4 + 4), cloud.scales.subarray(i * 3, i * 3 + 3));
      const nm = [N[hit.i * 3], N[hit.i * 3 + 1], N[hit.i * 3 + 2]];
      normals.push(Math.abs(n[0] * nm[0] + n[1] * nm[1] + n[2] * nm[2]));
    }
  }
  for (let j = 0; j < nv; j++) {
    const hit = g.nearest(V[j * 3], V[j * 3 + 1], V[j * 3 + 2]);
    m2c.push(hit.d);
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(4); };
  const frac = (a, t) => +(a.filter((x) => x <= t).length / a.length).toFixed(4);
  return {
    count: cloud.count,
    cloud_to_mesh: { mean_mm: +(sum(c2m) / c2m.length).toFixed(4), p50_mm: pct(c2m, 0.5), p95_mm: pct(c2m, 0.95), max_mm: +Math.max(...c2m).toFixed(4) },
    mesh_to_cloud: { mean_mm: +(sum(m2c) / m2c.length).toFixed(4), p50_mm: pct(m2c, 0.5), p95_mm: pct(m2c, 0.95), max_mm: +Math.max(...m2c).toFixed(4) },
    fscore: { threshold_mm: 0.5, precision: frac(c2m, 0.5), recall: frac(m2c, 0.5) },
    normal_abs_dot: normals.length
      ? { mean: +(sum(normals) / normals.length).toFixed(4), p50: pct(normals, 0.5), p10: pct(normals, 0.1) }
      : null,
  };
}

const trained = readDspk(TRAINED);
const sampled = readDspk(SAMPLED);
const trainedRaw = readPlyCloud(TRAINED_RAW, true);
const sampledRaw = readPlyCloud(SAMPLED_RAW, false);
const out = {
  schema: 'dentsplat-geometry-audit-v1',
  generated_at: new Date().toISOString(),
  source_mesh: {
    path: MESH_SOURCE,
    obj_cache: OBJ,
    triangles: nt,
    vertices: nv,
    sha256_obj: sha(objBuf),
    frame: { upAxisInSource: UP, anteriorAxis: FWD, anteriorSideAxis: SIDE, anteriorSign: SIGN, toApp: '[side-centre, up-centre, sign*(fwd-centre)]' },
    sample_note: 'distances are to 95,324 welded mesh vertices, not exact point-to-triangle distance',
  },
  methods: {
    brush_3dgs: { file: TRAINED, ...audit(trained), raw_ply: { file: TRAINED_RAW, frame: 'R_y(-90) into viewer frame', ...audit(trainedRaw) } },
    surface_sampling: { file: SAMPLED, ...audit(sampled), raw_ply: { file: SAMPLED_RAW, frame: 'already in viewer frame', ...audit(sampledRaw) } },
  },
  caveat: 'Mesh vertices are a sampled surface, so F-score@0.5mm is a point-set approximation. Normal consistency uses the ellipsoid minor axis as an estimated normal. DSPK and raw FP32 rows share the same mesh query, so their difference isolates transport precision rather than reconstruction quality.',
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));