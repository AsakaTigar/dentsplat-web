/**
 * tools/obj_labels_to_assets.mjs — Teeth3DS+-style OBJ + per-vertex JSON labels into the pipeline's
 * PLY + label side-cars + pickable proxy. Research Mode only: Teeth3DS+ is CC BY-NC-ND, so anything
 * this produces stays out of `public/` and out of the repository.
 *
 * The OBJ carries vertex colours (uniform grey in the samples) and no normals; labels arrive as
 * {"labels": [FDI per vertex], "instances": [...], "jaw": "upper"}. Frame is derived the same way as
 * the Poseidon route: thinnest axis up, and the arch's own centrals define +Z.
 *
 *   node tools/obj_labels_to_assets.mjs --obj case_upper.obj --labels case_upper.json \
 *        --out-dir tools/out/research --step 0.35 --pruned-step 0.85 --name t3ds_sample
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { Vector3 } from 'three';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const OBJ = arg('--obj'), LAB = arg('--labels'), OUT = arg('--out-dir', 'tools/out/research');
const STEP = Number(arg('--step', 0.35)), PSTEP = Number(arg('--pruned-step', 0.85));
const NAME = arg('--name', 'objcase');
if (!OBJ || !LAB) { console.error('usage: --obj X.obj --labels Y.json [--out-dir d]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const objText = readFileSync(OBJ, 'utf8');
const verts = [], cols = [];
for (const line of objText.split(/\r?\n/)) {
  if (line.startsWith('v ')) {
    const p = line.trim().split(/\s+/);
    verts.push(+p[1], +p[2], +p[3]);
    cols.push(p.length >= 7 ? [+p[4], +p[5], +p[6]] : [0.5, 0.5, 0.5]);
  }
}
const tris = [];
for (const line of objText.split(/\r?\n/)) {
  if (!line.startsWith('f ')) continue;
  const f = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t.split('/')[0], 10) - 1);
  for (let k = 1; k + 1 < f.length; k++) tris.push(f[0], f[k], f[k + 1]);   // fan
}
const nV = verts.length / 3, nTri = tris.length / 3;
const labelDoc = JSON.parse(readFileSync(LAB, 'utf8'));
const lab = labelDoc.labels ?? labelDoc.points ?? labelDoc.per_point_labels ?? labelDoc.vertex_labels;
if (!Array.isArray(lab) || lab.length !== nV) throw new Error(`labels ${lab?.length} != vertices ${nV}`);
const jawLabel = String(labelDoc.jaw ?? '').toLowerCase();
console.log(`obj: ${nV} vertices, ${nTri} triangles, jaw=${jawLabel || '?'}`);
const uniformGrey = cols.every((c) => Math.abs(c[0] - 0.5) < 1e-3 && Math.abs(c[1] - 0.5) < 1e-3);
if (uniformGrey) console.log('note: OBJ carries a uniform grey vertex colour -- appearance will be procedural');

// frame: thinnest axis up; centrals (11/21 for an upper jaw, 31/41 lower) define +Z
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nV; i++) for (let a = 0; a < 3; a++) {
  if (verts[i * 3 + a] < mn[a]) mn[a] = verts[i * 3 + a];
  if (verts[i * 3 + a] > mx[a]) mx[a] = verts[i * 3 + a];
}
const ext = [0, 1, 2].map((a) => mx[a] - mn[a]);
const up = ext.indexOf(Math.min(...ext));
const horiz = [0, 1, 2].filter((a) => a !== up);
const centroidOf = (fdi) => {
  let s = [0, 0, 0], n = 0;
  for (let i = 0; i < nV; i++) if (lab[i] === fdi) { s[0] += verts[i * 3]; s[1] += verts[i * 3 + 1]; s[2] += verts[i * 3 + 2]; n++; }
  return n ? s.map((v) => v / n) : null;
};
const antFdis = jawLabel === 'lower' ? [31, 41] : [11, 21];
const cents = antFdis.map(centroidOf).filter(Boolean);
if (!cents.length) throw new Error(`neither FDI ${antFdis.join('/')} present -- cannot orient the arch`);
const ant = [0, 1, 2].map((a) => cents.reduce((s, c) => s + c[a], 0) / cents.length);
const cent = [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
const fwd = horiz[0], sign = ant[fwd] - cent[fwd] >= 0 ? 1 : -1, side = horiz[1];
const toApp = (x, y, z) => { const p = [x, y, z]; return [p[side] - cent[side], p[up] - cent[up], sign * (p[fwd] - cent[fwd])]; };

const rng = (() => { let s = 0x1234567; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const sample = (step) => {
  const P = [], F = [], L = [], C = [];
  const gingiva = [198, 108, 112], enamel = [238, 232, 216];
  for (let t = 0; t < nTri; t++) {
    const ia = tris[t * 3], ib = tris[t * 3 + 1], ic = tris[t * 3 + 2];
    const ax = verts[ia * 3], ay = verts[ia * 3 + 1], az = verts[ia * 3 + 2];
    const bx = verts[ib * 3], by = verts[ib * 3 + 1], bz = verts[ib * 3 + 2];
    const cx = verts[ic * 3], cy = verts[ic * 3 + 1], cz = verts[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    const expect = area / (step * step);
    let n = Math.floor(expect); if (rng() < expect - n) n += 1;
    const fdi = lab[ia] || lab[ib] || lab[ic] || 0;
    const base = fdi ? enamel : gingiva;
    for (let k = 0; k < n; k++) {
      let r1 = rng(), r2 = rng();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const w0 = 1 - r1 - r2;
      const p = toApp(ax * w0 + bx * r1 + cx * r2, ay * w0 + by * r1 + cy * r2, az * w0 + bz * r1 + cz * r2);
      P.push(p[0], p[1], p[2]); F.push(fdi); L.push(fdi ? 1 : 0);
      const shade = 1 - 0.10 * Math.max(0, Math.min(1, (p[1] + 10) / 30));
      C.push(Math.round(base[0] * shade), Math.round(base[1] * shade), Math.round(base[2] * shade));
    }
  }
  return { P: Float32Array.from(P), F: Uint8Array.from(F), L: Uint8Array.from(L), C: Uint8Array.from(C) };
};

const writePly = (path, s, step) => {
  const n = s.F.length;
  const head = ['ply', 'format binary_little_endian 1.0',
    `comment Teeth3DS+ style OBJ surface-sampled at ${step} mm, ${NAME}`, 'comment frame: millimetre, Y up, +Z anterior',
    `element vertex ${n}`, 'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha',
    'end_header', ''].join('\n');
  const buf = Buffer.alloc(head.length + n * 16);
  buf.write(head, 'latin1');
  let o = head.length;
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(s.P[i * 3], o); buf.writeFloatLE(s.P[i * 3 + 1], o + 4); buf.writeFloatLE(s.P[i * 3 + 2], o + 8);
    buf[o + 12] = s.C[i * 3]; buf[o + 13] = s.C[i * 3 + 1]; buf[o + 14] = s.C[i * 3 + 2]; buf[o + 15] = 245;
    o += 16;
  }
  writeFileSync(path, buf);
  return { path, bytes: buf.length, count: n, sha: createHash('sha256').update(buf).digest('hex') };
};

function hullOf(s, fdi) {
  const pts = [];
  for (let i = 0; i < s.F.length; i++) if (s.F[i] === fdi) pts.push(new Vector3(s.P[i * 3], s.P[i * 3 + 1], s.P[i * 3 + 2]));
  if (pts.length < 8) return null;
  const h = new ConvexHull().setFromPoints(pts);
  const pos = [], idx = [], map = new Map();
  for (const f of h.faces) {
    let e = f.edge; const tri = [];
    do {
      const v = e.head().point; const key = `${v.x},${v.y},${v.z}`;
      if (!map.has(key)) { map.set(key, pos.length / 3); pos.push(v.x, v.y, v.z); }
      tri.push(map.get(key)); e = e.next;
    } while (e !== f.edge);
    for (let k = 1; k + 1 < tri.length; k++) idx.push(tri[0], tri[k], tri[k + 1]);
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

function writeGlb(path, parts) {
  const chunks = [], views = [], acc = [], meshes = [], nodes = [];
  let off = 0;
  const add = (b, target) => {
    const pad = (4 - (b.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target });
    chunks.push(b, Buffer.alloc(pad)); off += b.length + pad; return views.length - 1;
  };
  for (const [fdi, g] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
    const pv = add(Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength), 34962);
    const iv = add(Buffer.from(g.idx.buffer, g.idx.byteOffset, g.idx.byteLength), 34963);
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) for (let a = 0; a < 3; a++) {
      if (g.pos[i + a] < mins[a]) mins[a] = g.pos[i + a];
      if (g.pos[i + a] > maxs[a]) maxs[a] = g.pos[i + a];
    }
    acc.push({ bufferView: pv, componentType: 5126, count: g.pos.length / 3, type: 'VEC3', min: mins, max: maxs });
    const pa = acc.length - 1;
    acc.push({ bufferView: iv, componentType: 5125, count: g.idx.length, type: 'SCALAR' });
    meshes.push({ name: `FDI_${fdi}`, primitives: [{ attributes: { POSITION: pa }, indices: acc.length - 1, mode: 4 }] });
    nodes.push({ name: `FDI_${fdi}`, mesh: meshes.length - 1 });
  }
  const gltf = { asset: { version: '2.0', generator: 'dentsplat obj_labels_to_assets.mjs' }, scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors: acc, bufferViews: views,
    buffers: [{ byteLength: off }] };
  let js = Buffer.from(JSON.stringify(gltf), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + js.length); out.writeUInt32LE(0x004e4942, 24 + js.length); bin.copy(out, 28 + js.length);
  writeFileSync(path, out);
  return { path, bytes: total, teeth: nodes.length };
}

const full = sample(STEP), pruned = sample(PSTEP);
const plyA = writePly(join(OUT, `${NAME}_full.ply`), full, STEP);
const plyB = writePly(join(OUT, `${NAME}_pruned.ply`), pruned, PSTEP);
for (const [tag, s] of [['full', full], ['pruned', pruned]]) {
  writeFileSync(join(OUT, `${NAME}_${tag}_fdi.bin`), s.F);
  writeFileSync(join(OUT, `${NAME}_${tag}_layer.bin`), s.L);
}
const fdiSet = [...new Set(full.F)].filter(Boolean).sort((a, b) => a - b);
const parts = new Map();
for (const f of fdiSet) { const h = hullOf(full, f); if (h) parts.set(f, h); }
const glb = writeGlb(join(OUT, `${NAME}_proxy.glb`), parts);
const summary = { name: NAME, license: 'Teeth3DS+ CC BY-NC-ND 4.0 -- research use only, do not publish',
  obj: { vertices: nV, triangles: nTri, jaw: jawLabel }, frame: { up, fwd, sign, ext: ext.map((v) => +v.toFixed(1)) },
  fdi: fdiSet, full: { count: full.F.length, ply: plyA }, pruned: { count: pruned.F.length, ply: plyB }, proxy: glb };
writeFileSync(join(OUT, `${NAME}_summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
