/**
 * tools/poseidon_to_assets.mjs — a real intra-oral scan (Poseidon3D, CC BY 4.0) into the pipeline's
 * PLY + label side-cars + pickable proxy, in the app's millimetre Y-up frame.
 *
 * Why a separate entry point: pipeline/run_case.sh starts from Teeth3DS OBJ+JSON and a Blender render
 * pass, neither of which this dataset has. Poseidon3D ships one ASCII STL per jaw plus per-face region
 * ids in a pickle; this reads exactly those, samples the surface at a stated pitch, and hands the rest
 * of the chain (ply2dspk, the app) the format it already knows.
 *
 *   node tools/poseidon_to_assets.mjs --stl case.stl --fdi ...QUADRANT_NUMBERING....pkl \
 *        --out-dir tools/out/poseidon --step 0.35 --pruned-step 0.85 --name poseidon125
 *
 * Rotation is derived, not assumed: the thinnest axis becomes +Y (up), and the sign of the remaining
 * horizontal axis is chosen so the FDI 31/41 centrals sit at +Z (the app puts the lips there). The
 * script refuses a scan whose 31/41 are missing or whose extents do not look like a dental arch.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { Vector3 } from 'three';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STL = arg('--stl'), FDI_PKL = arg('--fdi'), OUT = arg('--out-dir', 'tools/out/poseidon');
const STEP = Number(arg('--step', 0.35)), PSTEP = Number(arg('--pruned-step', 0.85));
const NAME = arg('--name', 'poseidon');
if (!STL || !FDI_PKL) { console.error('usage: --stl X.stl --fdi Y.pkl [--out-dir d] [--step 0.35]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- pickle (int list only)
// pickle_ints.mjs is a CLI; re-implement the tiny reader here so this tool owns its dependencies.
function unpickle(buf) {
  const stack = []; const memo = new Map(); let mark = null; let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error(`truncated at ${i}`); };
  for (;;) {
    need(1); const op = buf[i++];
    switch (op) {
      case 0x80: need(1); i += 1; break;
      case 0x95: need(8); i += 8; break;
      case 0x2e: return stack.pop();
      case 0x28: mark = stack.length; break;
      case 0x5d: stack.push([]); break;
      case 0x29: stack.push([]); break;
      case 0x71: need(1); memo.set(buf[i], stack[stack.length - 1]); i += 1; break;
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break;
      case 0x68: need(1); stack.push(memo.get(buf[i])); i += 1; break;
      case 0x4b: need(1); stack.push(buf[i]); i += 1; break;
      case 0x4d: need(2); stack.push(buf.readUInt16LE(i)); i += 2; break;
      case 0x4a: need(4); stack.push(buf.readInt32LE(i)); i += 4; break;
      case 0x8a: { need(1); const n = buf[i]; i += 1; need(n); let v = 0; for (let k = 0; k < n; k++) v += buf[i + k] * 2 ** (8 * k); i += n; stack.push(v); break; }
      case 0x74: { const it = stack.splice(mark); mark = null; stack.push(it); break; }
      case 0x6c: { const it = stack.splice(mark); mark = null; stack.push(it); break; }
      case 0x65: { const it = stack.splice(mark); mark = null; const t = stack.pop(); t.push(...it); stack.push(t); break; }
      case 0x85: { const a = stack.pop(); stack.push([a]); break; }
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }
      case 0x47: need(8); stack.push(buf.readDoubleBE(i)); i += 8; break;
      case 0x4e: stack.push(null); break;
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x58: { need(4); const n = buf.readUInt32LE(i); i += 4; need(n); stack.push(buf.toString('utf8', i, i + n)); i += n; break; }
      case 0x8c: { need(1); const n = buf[i]; i += 1; need(n); stack.push(buf.toString('utf8', i, i + n)); i += n; break; }
      case 0x62: stack.pop(); break;
      default: throw new Error(`unsupported pickle opcode 0x${op.toString(16)} at ${i - 1}`);
    }
  }
}

// ---------------------------------------------------------------- STL + labels
const stlText = readFileSync(STL, 'utf8');
if (!/^\s*solid/.test(stlText.slice(0, 40))) throw new Error('expected an ASCII STL (binary STL would need a different reader)');
const verts = [];
for (const m of stlText.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) verts.push(+m[1], +m[2], +m[3]);
const nTri = verts.length / 9;
const labels = unpickle(readFileSync(FDI_PKL));
if (!Array.isArray(labels) || labels.length !== nTri) {
  throw new Error(`label count ${labels?.length} != triangle count ${nTri} -- wrong file for this mesh?`);
}
const fdiSet = [...new Set(labels)].filter((v) => v > 0).sort((a, b) => a - b);
const hist = new Map(); for (const v of labels) hist.set(v, (hist.get(v) ?? 0) + 1);

// ---------------------------------------------------------------- frame: thinnest axis up, 31/41 to +Z
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let k = 0; k < verts.length; k += 3) for (let a = 0; a < 3; a++) {
  if (verts[k + a] < mn[a]) mn[a] = verts[k + a];
  if (verts[k + a] > mx[a]) mx[a] = verts[k + a];
}
const ext = [0, 1, 2].map((a) => mx[a] - mn[a]);
const up = ext.indexOf(Math.min(...ext));
const horiz = [0, 1, 2].filter((a) => a !== up);
if (ext[up] > 35) throw new Error(`thinnest extent is ${ext[up].toFixed(1)} mm -- not an arch scan?`);
const cent = [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
const centroidOf = (fdi) => {
  let x = 0, y = 0, z = 0, n = 0;
  for (let t = 0; t < nTri; t++) if (labels[t] === fdi) {
    for (let v = 0; v < 3; v++) { x += verts[t * 9 + v * 3]; y += verts[t * 9 + v * 3 + 1]; z += verts[t * 9 + v * 3 + 2]; n++; }
  }
  return n ? [x / n, y / n, z / n] : null;
};
const c31 = centroidOf(31), c41 = centroidOf(41);
if (!c31 || !c41) throw new Error('FDI 31 and 41 must both be present to orient the arch (they set +Z)');
const ant = [0, 1, 2].map((a) => (c31[a] + c41[a]) / 2);
const fwd = horiz[0];
const sign = ant[fwd] - cent[fwd] >= 0 ? 1 : -1;
const side = horiz[1];
// (x,y,z)_stl -> (X,Y,Z)_app:  X = side axis, Y = up, Z = sign*fwd
const toApp = (x, y, z) => {
  const p = [x, y, z];
  return [p[side] - cent[side], p[up] - cent[up], sign * (p[fwd] - cent[fwd])];
};

// ---------------------------------------------------------------- sampling
const rng = (() => { let s = 0x9e3779b9; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const sample = (step) => {
  const P = [], F = [], L = [], C = [];
  const gingiva = [198, 108, 112], enamel = [238, 232, 216];
  for (let t = 0; t < nTri; t++) {
    const ax = verts[t * 9], ay = verts[t * 9 + 1], az = verts[t * 9 + 2];
    const bx = verts[t * 9 + 3], by = verts[t * 9 + 4], bz = verts[t * 9 + 5];
    const cx = verts[t * 9 + 6], cy = verts[t * 9 + 7], cz = verts[t * 9 + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    // Poisson-ish acceptance instead of max(1, ...): forcing at least one sample per triangle makes
    // the point count follow the tessellation (190k) rather than the requested pitch, and then the
    // "pruned" packet comes out the same size as the full one.
    const expect = area / (step * step);
    let n = Math.floor(expect);
    if (rng() < expect - n) n += 1;
    const fdi = labels[t] > 0 ? labels[t] : 0;
    const layer = fdi ? 1 : 0;
    const base = fdi ? enamel : gingiva;
    const jitter = fdi ? (fdi * 37) % 9 - 4 : 0;
    for (let k = 0; k < n; k++) {
      let r1 = rng(), r2 = rng();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const w0 = 1 - r1 - r2, w1 = r1, w2 = r2;
      const p = toApp(ax * w0 + bx * w1 + cx * w2, ay * w0 + by * w1 + cy * w2, az * w0 + bz * w1 + cz * w2);
      P.push(p[0], p[1], p[2]);
      F.push(fdi); L.push(layer);
      const shade = 1 - 0.10 * Math.max(0, Math.min(1, (p[1] + 10) / 30));   // slight occlusal-to-gingival falloff
      C.push(
        Math.max(0, Math.min(255, Math.round(base[0] * shade) + jitter)),
        Math.max(0, Math.min(255, Math.round(base[1] * shade) + jitter)),
        Math.max(0, Math.min(255, Math.round(base[2] * shade) + jitter)),
      );
    }
  }
  return { P: Float32Array.from(P), F: Uint8Array.from(F), L: Uint8Array.from(L), C: Uint8Array.from(C) };
};

const writePly = (path, s, step) => {
  const n = s.F.length;
  const head = ['ply', 'format binary_little_endian 1.0',
    `comment Poseidon3D real intra-oral scan, surface-sampled at ${step} mm, ${NAME}`, 'comment frame: millimetre, Y up, +Z anterior',
    `element vertex ${n}`,
    'property float x', 'property float y', 'property float z',
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

// ---------------------------------------------------------------- proxy GLB (one hull per FDI)
function hullOf(s, fdi) {
  const pts = [];
  for (let i = 0; i < s.F.length; i++) if (s.F[i] === fdi) pts.push(new Vector3(s.P[i * 3], s.P[i * 3 + 1], s.P[i * 3 + 2]));
  if (pts.length < 8) return null;
  const h = new ConvexHull().setFromPoints(pts);
  const pos = [], idx = [];
  const faces = h.faces;
  const map = new Map();
  for (const f of faces) {
    let e = f.edge;
    const tri = [];
    do {
      const v = e.head().point;
      const key = `${v.x},${v.y},${v.z}`;
      if (!map.has(key)) { map.set(key, pos.length / 3); pos.push(v.x, v.y, v.z); }
      tri.push(map.get(key));
      e = e.next;
    } while (e !== f.edge);
    if (tri.length === 3) idx.push(...tri);
    else for (let k = 1; k + 1 < tri.length; k++) idx.push(tri[0], tri[k], tri[k + 1]);
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
    acc.push({ bufferView: pv, componentType: 5126, count: g.pos.length / 3, type: 'VEC3',
      min: [Math.min(...g.pos.filter((_, i) => i % 3 === 0)), Math.min(...g.pos.filter((_, i) => i % 3 === 1)), Math.min(...g.pos.filter((_, i) => i % 3 === 2))],
      max: [Math.max(...g.pos.filter((_, i) => i % 3 === 0)), Math.max(...g.pos.filter((_, i) => i % 3 === 1)), Math.max(...g.pos.filter((_, i) => i % 3 === 2))] });
    const pa = acc.length - 1;
    acc.push({ bufferView: iv, componentType: 5125, count: g.idx.length, type: 'SCALAR' });
    meshes.push({ name: `FDI_${fdi}`, primitives: [{ attributes: { POSITION: pa }, indices: acc.length - 1, mode: 4 }] });
    nodes.push({ name: `FDI_${fdi}`, mesh: meshes.length - 1 });
  }
  const gltf = { asset: { version: '2.0', generator: 'dentsplat poseidon_to_assets.mjs' }, scene: 0,
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

// ---------------------------------------------------------------- run
const full = sample(STEP), pruned = sample(PSTEP);
const plyA = writePly(join(OUT, `${NAME}_full.ply`), full, STEP);
const plyB = writePly(join(OUT, `${NAME}_pruned.ply`), pruned, PSTEP);
const bins = {};
for (const [tag, s] of [['full', full], ['pruned', pruned]]) {
  writeFileSync(join(OUT, `${NAME}_${tag}_fdi.bin`), s.F);
  writeFileSync(join(OUT, `${NAME}_${tag}_layer.bin`), s.L);
  bins[tag] = { fdi: createHash('sha256').update(s.F).digest('hex'), layer: createHash('sha256').update(s.L).digest('hex') };
}
const proxyParts = new Map();
for (const fdi of fdiSet) { const h = hullOf(full, fdi); if (h) proxyParts.set(fdi, h); }
const glb = writeGlb(join(OUT, `${NAME}_proxy.glb`), proxyParts);

const bbox = (s) => {
  const mn2 = [Infinity, Infinity, Infinity], mx2 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.P.length; i += 3) for (let a = 0; a < 3; a++) {
    if (s.P[i + a] < mn2[a]) mn2[a] = s.P[i + a];
    if (s.P[i + a] > mx2[a]) mx2[a] = s.P[i + a];
  }
  return { min: mn2.map((v) => +v.toFixed(2)), max: mx2.map((v) => +v.toFixed(2)) };
};
const summary = {
  name: NAME, source: { stl: STL, fdi: FDI_PKL, triangles: nTri },
  frame: { upAxisInSource: up, anteriorAxis: fwd, anteriorSign: sign, extent_mm: ext.map((v) => +v.toFixed(1)) },
  fdi: fdiSet, fdi_face_counts: Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0])),
  full: { count: full.F.length, bbox: bbox(full), ply: plyA },
  pruned: { count: pruned.F.length, bbox: bbox(pruned), ply: plyB },
  proxy: glb, labels: bins,
};
writeFileSync(join(OUT, `${NAME}_summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
