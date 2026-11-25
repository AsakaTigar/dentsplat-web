/**
 * tools/stl_to_obj_labels.mjs — weld a triangle-soup STL into an OBJ + per-vertex label JSON that
 * pipeline/dental_pipeline_blender.py already understands (Teeth3DS-style).
 *
 * The Poseidon3D scan is an ASCII STL (no shared vertices) plus per-face region ids. Blender needs
 * shared vertices to decimate and to bind labels, so this welds by rounded position and assigns each
 * welded vertex the majority FDI of the faces that touch it (0 = gingiva/background).
 *
 *   node tools/stl_to_obj_labels.mjs --stl case.stl --fdi ...QUADRANT_NUMBERING....pkl \
 *        --out-obj case.obj --out-json case.json --jaw lower
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STL = arg('--stl'), PKL = arg('--fdi'), OUT_OBJ = arg('--out-obj'), OUT_JSON = arg('--out-json');
const JAW = arg('--jaw', 'lower'), KEY = Number(arg('--weld', 0.001));
if (!STL || !PKL || !OUT_OBJ || !OUT_JSON) {
  console.error('usage: --stl X.stl --fdi Y.pkl --out-obj A.obj --out-json A.json [--jaw lower] [--weld 0.001]');
  process.exit(2);
}

// minimal pickle reader for the int list (same subset as tools/pickle_ints.mjs)
function unpickle(buf) {
  const stack = []; const memo = new Map(); let mark = null; let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error('truncated'); };
  for (;;) {
    need(1); const op = buf[i++];
    switch (op) {
      case 0x80: need(1); i += 1; break;
      case 0x95: need(8); i += 8; break;
      case 0x2e: return stack.pop();
      case 0x28: mark = stack.length; break;
      case 0x5d: case 0x29: stack.push([]); break;
      case 0x71: need(1); memo.set(buf[i], stack[stack.length - 1]); i += 1; break;
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break;
      case 0x68: need(1); stack.push(memo.get(buf[i])); i += 1; break;
      case 0x4b: need(1); stack.push(buf[i]); i += 1; break;
      case 0x4d: need(2); stack.push(buf.readUInt16LE(i)); i += 2; break;
      case 0x4a: need(4); stack.push(buf.readInt32LE(i)); i += 4; break;
      case 0x8a: { need(1); const n = buf[i]; i += 1; need(n); let v = 0; for (let k = 0; k < n; k++) v += buf[i + k] * 2 ** (8 * k); i += n; stack.push(v); break; }
      case 0x74: case 0x6c: { const it = stack.splice(mark); mark = null; stack.push(it); break; }
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

const text = readFileSync(STL, 'utf8');
if (!/^\s*solid/.test(text.slice(0, 40))) throw new Error('expected an ASCII STL');
const raw = [];
for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) raw.push(+m[1], +m[2], +m[3]);
const nTri = raw.length / 9;
const faceLabel = unpickle(readFileSync(PKL));
if (!Array.isArray(faceLabel) || faceLabel.length !== nTri) throw new Error('label count != triangle count');

// weld
const map = new Map();
const verts = [];
const idx = new Int32Array(nTri * 3);
const votes = new Map();                      // vertex index -> Map(fdi -> count)
for (let t = 0; t < nTri; t++) {
  const fdi = faceLabel[t] > 0 ? faceLabel[t] : 0;
  for (let v = 0; v < 3; v++) {
    const x = raw[t * 9 + v * 3], y = raw[t * 9 + v * 3 + 1], z = raw[t * 9 + v * 3 + 2];
    const key = `${Math.round(x / KEY)},${Math.round(y / KEY)},${Math.round(z / KEY)}`;
    let vi = map.get(key);
    if (vi === undefined) { vi = verts.length / 3; map.set(key, vi); verts.push(x, y, z); votes.set(vi, new Map()); }
    idx[t * 3 + v] = vi;
    const m = votes.get(vi); m.set(fdi, (m.get(fdi) ?? 0) + 1);
  }
}
const nV = verts.length / 3;
const labels = new Uint8Array(nV), instances = new Uint8Array(nV);
let boundary = 0;
for (const [vi, m] of votes) {
  let best = 0, bestN = -1, total = 0;
  for (const [fdi, n] of m) { total += n; if (n > bestN || (n === bestN && fdi > best)) { best = fdi; bestN = n; } }
  labels[vi] = best;
  if (m.size > 1 && best === 0) boundary++;
}
// instance id: 1..n over distinct FDI, indexed by FDI order
const fdis = [...new Set(labels)].filter(Boolean).sort((a, b) => a - b);
const inst = new Map(fdis.map((f, i) => [f, i + 1]));
for (let i = 0; i < nV; i++) instances[i] = inst.get(labels[i]) ?? 0;

const obj = ['# welded from ' + STL.split(/[\\/]/).pop() + ` (${nTri} triangles -> ${nV} vertices)`,
  ...Array.from({ length: nV }, (_, i) => `v ${verts[i * 3].toFixed(6)} ${verts[i * 3 + 1].toFixed(6)} ${verts[i * 3 + 2].toFixed(6)}`),
  ...Array.from({ length: nTri }, (_, t) => `f ${idx[t * 3] + 1} ${idx[t * 3 + 1] + 1} ${idx[t * 3 + 2] + 1}`),
].join('\n') + '\n';
writeFileSync(OUT_OBJ, obj);
writeFileSync(OUT_JSON, JSON.stringify({ id_patient: STL.split(/[\\/]/).pop().replace(/\..*/, ''),
  jaw: JAW, labels: Array.from(labels), instances: Array.from(instances) }));
const hist = new Map();
for (const f of labels) hist.set(f, (hist.get(f) ?? 0) + 1);
console.log(JSON.stringify({
  triangles: nTri, vertices: nV, weld_key_mm: KEY, fdi: fdis,
  vertices_per_fdi: Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0])),
  boundary_vertices_left_unlabelled: boundary,
  obj_bytes: createHash('sha256').update(obj).digest('hex').slice(0, 16),
}, null, 2));
