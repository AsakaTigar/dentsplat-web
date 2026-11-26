/**
 * Mesh-aligned disk baseline.
 *
 * Takes the existing 0.35 mm Poseidon3D surface sample (same centres, colours and FDI as Case 10),
 * replaces only its isotropic covariance with a flat disk whose local +Z follows the source mesh
 * normal, and writes a DSPK. This is a representation baseline, NOT 2DGS training.
 *
 *   node tools/build-disk-baseline.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCloud, encodeSplatCloud, FLAG, LAYER } from '../src/engine/dspk.ts';

const OBJ = 'D:/Aodou/.cache/tmp/poseidon/obj/000125_lower.obj';
const PLY = 'tools/out/poseidon/poseidon125_full.ply';
const FDI = 'tools/out/poseidon/poseidon125_full_fdi.bin';
const LAYER_BIN = 'tools/out/poseidon/poseidon125_full_layer.bin';
const OUT = 'public/assets/sceneA_disks_full.dspk';
const META = 'public/assets/sceneA_disks.json';
const TANGENT = 0.30, THICK = 0.03;

// ---- source mesh normals in viewer frame ----
const objText = readFileSync(OBJ, 'utf8');
const verts = []; const faces = [];
for (const line of objText.split('\n')) {
  if (line.startsWith('v ')) { const p = line.slice(2).trim().split(/\s+/).map(Number); verts.push(p[0], p[1], p[2]); }
  else if (line.startsWith('f ')) { const ids = line.slice(2).trim().split(/\s+/).map((s) => Number(s.split('/')[0]) - 1); for (let k = 1; k + 1 < ids.length; k++) faces.push(ids[0], ids[k], ids[k + 1]); }
}
const nv = verts.length / 3;
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], verts[i * 3 + k]); mx[k] = Math.max(mx[k], verts[i * 3 + k]); }
const cent = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
const toAppP = (x, y, z) => [y - cent[1], z - cent[2], x - cent[0]];
const V = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
for (let i = 0; i < nv; i++) { const p = toAppP(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]); V[i * 3] = p[0]; V[i * 3 + 1] = p[1]; V[i * 3 + 2] = p[2]; }
for (let t = 0; t < faces.length; t += 3) {
  const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
}
for (let i = 0; i < nv; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
const cell = 0.8, grid = new Map();
for (let i = 0; i < nv; i++) { const k = `${Math.floor(V[i * 3] / cell)},${Math.floor(V[i * 3 + 1] / cell)},${Math.floor(V[i * 3 + 2] / cell)}`; const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]); }
function nearestNormal(x, y, z) {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
  let best = Infinity, bi = -1;
  for (let r = 0; r < 64; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!arr) continue;
      for (const j of arr) { const d2 = (V[j * 3] - x) ** 2 + (V[j * 3 + 1] - y) ** 2 + (V[j * 3 + 2] - z) ** 2; if (d2 < best) { best = d2; bi = j; } }
    }
    if (bi >= 0 && Math.sqrt(best) <= r * cell) break;
  }
  return bi >= 0 ? [N[bi * 3], N[bi * 3 + 1], N[bi * 3 + 2]] : [0, 0, 1];
}

// ---- sampled centres / colours, same rows as the side-cars ----
const pb = readFileSync(PLY);
const head = pb.subarray(0, 4096).toString('latin1');
const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
const headEnd = head.indexOf('end_header\n') + 11;
const stride = 16;
if (pb.length !== headEnd + n * stride) throw new Error('sample PLY size mismatch');
const fdi = readFileSync(FDI), layers = readFileSync(LAYER_BIN);
if (fdi.length !== n || layers.length !== n) throw new Error('side-car length mismatch');

const centers = new Float64Array(n * 3), quats = new Float64Array(n * 4), scales = new Float64Array(n * 3);
const colors = new Float64Array(n * 3), alphas = new Float64Array(n);
const tooth = new Uint8Array(n), layer = new Uint8Array(n), flags = new Uint8Array(n);
let normalSum = 0;
for (let i = 0; i < n; i++) {
  const o = headEnd + i * stride;
  const x = pb.readFloatLE(o), y = pb.readFloatLE(o + 4), z = pb.readFloatLE(o + 8);
  centers[i * 3] = x; centers[i * 3 + 1] = y; centers[i * 3 + 2] = z;
  const nrm = nearestNormal(x, y, z);
  normalSum += Math.hypot(nrm[0], nrm[1], nrm[2]);
  // shortest rotation from local +Z to the surface normal
  let ax = -nrm[1], ay = nrm[0], az = 0;
  let al = Math.hypot(ax, ay, az);
  let angle = Math.acos(Math.max(-1, Math.min(1, nrm[2])));
  if (al < 1e-7) { ax = 1; ay = 0; az = 0; al = 1; if (nrm[2] > 0) angle = 0; }
  const sh = Math.sin(angle / 2);
  quats[i * 4] = ax / al * sh; quats[i * 4 + 1] = ay / al * sh; quats[i * 4 + 2] = az / al * sh;
  quats[i * 4 + 3] = Math.cos(angle / 2);
  scales[i * 3] = TANGENT; scales[i * 3 + 1] = TANGENT; scales[i * 3 + 2] = THICK;
  colors[i * 3] = pb[o + 12] / 255; colors[i * 3 + 1] = pb[o + 13] / 255; colors[i * 3 + 2] = pb[o + 14] / 255;
  alphas[i] = pb[o + 15] / 255;
  tooth[i] = fdi[i];
  layer[i] = Math.min(8, layers[i]);
  flags[i] = (fdi[i] >= 11 && fdi[i] <= 28) ? FLAG.upperJaw : FLAG.lowerJaw;
  if (fdi[i] === 0) flags[i] = FLAG.lowerJaw;
}
const meta = {
  name: 'Poseidon3D 000125 · surface-aligned disks',
  kind: 'ios', unit: 'mm', coordinate_system: 'glTF_Y_up',
  source: { sample: PLY, mesh: 'Poseidon3D 000125 mandible', fdi: FDI, layer: LAYER_BIN, row_order: 'same as poseidon125_full.ply' },
  provenance: 'mesh-derived covariance baseline; same centres/colour/FDI as the 0.35 mm sample, only the covariance is replaced by a flat disk aligned to the source mesh normal. This is NOT 2DGS training.',
  method: { type: 'surface-aligned-disks', tangent_sigma_mm: TANGENT, normal_sigma_mm: THICK, trained: false },
};
const cloud = buildCloud({ centers, quats, scales, colors, alphas, toothIds: tooth, layerIds: layer, flags, meta });
const bytes = encodeSplatCloud(cloud);
writeFileSync(OUT, new Uint8Array(bytes));
const out = {
  schema: 'dentsplat-representation-baseline-v1',
  file: OUT.replace('public/assets/', ''), bytes: bytes.byteLength, splats: n,
  sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
  method: 'mesh-derived surface-aligned flat disks', tangent_sigma_mm: TANGENT, normal_sigma_mm: THICK,
  source: { sample: PLY, mesh: 'Poseidon3D 000125 mandible', fdi_sidecar: FDI, layer_sidecar: LAYER_BIN },
  note: 'Same centres/colours/FDI as Case 10; only covariance is changed. Not a 2DGS implementation.',
};
writeFileSync(META, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));