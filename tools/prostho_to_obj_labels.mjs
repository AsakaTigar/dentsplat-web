/**
 * tools/prostho_to_obj_labels.mjs — ProsthoObjects3D scan (Zenodo 18488594) into the Blender pipeline's
 * OBJ + per-vertex FDI JSON.
 *
 * The dataset ships a triangle-soup STL of the whole arch plus, per restoration, an axis-aligned bounding
 * box and a clinical label (Crown / scan body / ... with quadrant and tooth number). There is no per-face
 * segmentation, so the only honest mapping is geometric: a welded vertex inside a restoration's box gets
 * that restoration's FDI; every other vertex is background (0, rendered as gingiva). Boxes can overlap at
 * a contact point, so the smallest containing box wins.
 *
 *   node tools/prostho_to_obj_labels.mjs --stl 608.stl --json 608.json --meta prosth_meta.csv \
 *        --scan 608 --out-obj case_obj.obj --out-json case_obj.json [--jaw upper]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STL = arg('--stl'), JSON_ = arg('--json'), META = arg('--meta'), SCAN = arg('--scan');
const OUT_OBJ = arg('--out-obj'), OUT_JSON = arg('--out-json'), JAW = arg('--jaw', 'upper');
const WELD = Number(arg('--weld', 0.001));
if (!STL || !JSON_ || !META || !SCAN || !OUT_OBJ || !OUT_JSON) {
  console.error('usage: --stl X.stl --json X.json --meta MetaData.csv --scan 608 --out-obj A.obj --out-json A.json');
  process.exit(2);
}

// ---------------------------------------------------------------- CSV: restoration -> FDI
const Q = { UR: 1, UL: 2, LL: 3, LR: 4 };
const byRestoration = new Map();
for (const line of readFileSync(META, 'utf8').split(/\r?\n/)) {
  const cols = line.split(',');
  if (cols[0] === 'Scan ID' || !cols[0]) continue;
  if (cols[0] !== SCAN) continue;
  const q = Q[cols[4]];
  if (!q) continue;
  byRestoration.set(Number(cols[1]), { fdi: q * 10 + Number(cols[5]), cls: cols[2] });
}
const boxes = JSON.parse(readFileSync(JSON_, 'utf8')).restorations.map((r) => {
  const meta = byRestoration.get(r.restoration_number);
  const lo = [r.min_mm.x_min, r.min_mm.y_min, r.min_mm.z_min];
  const hi = [r.max_mm.x_max, r.max_mm.y_max, r.max_mm.z_max];
  return { fdi: meta?.fdi ?? 0, cls: meta?.cls ?? '?', lo, hi,
    vol: (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]) };
}).filter((b) => b.fdi && b.fdi >= 11 && b.fdi <= 28);
if (!boxes.length) { console.error(`no labelled restorations for scan ${SCAN}`); process.exit(2); }

// ---------------------------------------------------------------- binary STL, welded by 1 um
const buf = readFileSync(STL);
const nTri = buf.readUInt32LE(80);
if (buf.length !== 84 + nTri * 50) { console.error(`STL size does not match ${nTri} triangles`); process.exit(2); }
const verts = [], faces = new Int32Array(nTri * 3), index = new Map();
const key = (x, y, z) => `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;
const vid = (x, y, z) => {
  const k = key(x, y, z);
  const hit = index.get(k);
  if (hit !== undefined) return hit;
  const id = verts.length / 3;
  verts.push(x, y, z);
  index.set(k, id);
  return id;
};
for (let i = 0; i < nTri; i++) {
  const o = 84 + i * 50 + 12;
  for (let v = 0; v < 3; v++) {
    const p = o + v * 12;
    faces[i * 3 + v] = vid(buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8));
  }
}
const nv = verts.length / 3;

// ---------------------------------------------------------------- labels: smallest containing box wins
const labels = new Uint8Array(nv);
for (let i = 0; i < nv; i++) {
  const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
  let best = null;
  for (const b of boxes) {
    if (x < b.lo[0] || x > b.hi[0] || y < b.lo[1] || y > b.hi[1] || z < b.lo[2] || z > b.hi[2]) continue;
    if (!best || b.vol < best.vol) best = b;
  }
  labels[i] = best ? best.fdi : 0;
}

// ---------------------------------------------------------------- OBJ + JSON
const out = [];
const f6 = (n) => (Math.round(n * 1e6) / 1e6).toFixed(6);
for (let i = 0; i < nv; i++) out.push(`v ${f6(verts[i * 3])} ${f6(verts[i * 3 + 1])} ${f6(verts[i * 3 + 2])}`);
for (let i = 0; i < nTri; i++) out.push(`f ${faces[i * 3] + 1} ${faces[i * 3 + 1] + 1} ${faces[i * 3 + 2] + 1}`);
writeFileSync(OUT_OBJ, out.join('\n') + '\n');
const hist = {};
for (let i = 0; i < nv; i++) hist[labels[i]] = (hist[labels[i]] || 0) + 1;
writeFileSync(OUT_JSON, JSON.stringify({ id_patient: SCAN, jaw: JAW, labels: Array.from(labels) }));
console.log(JSON.stringify({ stl: STL, triangles: nTri, vertices: nv, restorations: boxes.length,
  fdi: Object.fromEntries(Object.entries(hist).filter(([k]) => k !== '0')), background: hist[0] ?? 0,
  obj_bytes: out.length }));
