/**
 * tools/check-glb.mjs — structural check for a proxy GLB, so "it has the right size" is never the
 * only thing known about it.
 *
 * The app raycasts the proxy through three's GLTFLoader and resolves teeth by node name (`FDI_<n>`),
 * so a file can be byte-plausible and still be useless: a node without a mesh, an accessor that runs
 * past its bufferView, an index that points past the last vertex. This walks the container and the
 * JSON instead of trusting the writer, and it is what `pipeline/cbct_proxy.py` is verified with
 * before its output is allowed near `public/assets/`.
 *
 *   node tools/check-glb.mjs <file.glb> [--min-teeth 8]
 */
import { readFileSync, statSync } from 'node:fs';

const file = process.argv[2];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MIN_TEETH = arg('--min-teeth', 1);
if (!file) { console.error('usage: node tools/check-glb.mjs <file.glb> [--min-teeth N]'); process.exit(2); }

const buf = readFileSync(file);
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg); };

ok(buf.length === statSync(file).size, `file size ${buf.length} B`);
ok(buf.readUInt32LE(0) === 0x46546c67, 'magic is glTF');
ok(buf.readUInt32LE(4) === 2, `container version ${buf.readUInt32LE(4)}`);
ok(buf.readUInt32LE(8) === buf.length, `declared length ${buf.readUInt32LE(8)} == file length`);

const jsonLen = buf.readUInt32LE(12);
ok(buf.readUInt32LE(16) === 0x4e4f534a, `first chunk is JSON (${jsonLen} B)`);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binOff = 20 + jsonLen;
ok(buf.readUInt32LE(binOff + 4) === 0x004e4942, 'second chunk is BIN');
const binLen = buf.readUInt32LE(binOff);
const bin = buf.subarray(binOff + 8, binOff + 8 + binLen);
ok(binOff + 8 + binLen === buf.length, `BIN chunk ${binLen} B ends at EOF`);

ok(json.asset?.version === '2.0', `asset.version ${json.asset?.version}`);
const nodes = json.nodes ?? [], meshes = json.meshes ?? [], acc = json.accessors ?? [], views = json.bufferViews ?? [];
const named = nodes.filter((n) => /^FDI_\d+$/.test(n.name ?? ''));
ok(named.length >= MIN_TEETH, `${named.length} nodes named FDI_<n> (min ${MIN_TEETH})`);
ok(new Set(named.map((n) => n.name)).size === named.length, 'FDI node names are unique');
ok(named.every((n) => Number(n.mesh) >= 0 && meshes[Number(n.mesh)]), 'every FDI node references a mesh');

let verts = 0, tris = 0, bad = [];
for (const n of named) {
  const prim = meshes[Number(n.mesh)]?.primitives?.[0];
  const pa = acc[prim?.attributes?.POSITION];
  const ia = acc[prim?.indices];
  if (!pa || !ia) { bad.push(`${n.name}: missing POSITION/indices`); continue; }
  const pv = views[pa.bufferView], iv = views[ia.bufferView];
  const pEnd = (pv?.byteOffset ?? 0) + (pv?.byteLength ?? 0);
  const iEnd = (iv?.byteOffset ?? 0) + (iv?.byteLength ?? 0);
  if (pEnd > bin.length || iEnd > bin.length) bad.push(`${n.name}: view past the BIN chunk`);
  if (pv.byteLength < pa.count * 12) bad.push(`${n.name}: POSITION view shorter than count*12`);
  if (iv.byteLength < ia.count * 4) bad.push(`${n.name}: index view shorter than count*4`);
  if (pa.type !== 'VEC3' || pa.componentType !== 5126) bad.push(`${n.name}: POSITION is not float VEC3`);
  if (ia.type !== 'SCALAR' || ia.componentType !== 5125) bad.push(`${n.name}: indices are not uint32`);
  verts += pa.count; tris += ia.count / 3;
  // min/max are mandatory for POSITION and are what a loader uses for culling; check they bracket the data.
  const min = pa.min ?? [], max = pa.max ?? [];
  if (min.length !== 3 || max.length !== 3) bad.push(`${n.name}: POSITION missing min/max`);
  if (min.some((v, k) => !(v <= max[k]))) bad.push(`${n.name}: min is not below max`);
  if (!(max[0] - min[0] > 0.5 && max[1] - min[1] > 0.5 && max[2] - min[2] > 0.5)) bad.push(`${n.name}: suspiciously flat bbox`);
}
ok(bad.length === 0, `per-mesh structure clean${bad.length ? ': ' + bad.slice(0, 4).join(' | ') : ''}`);

// Every index must address a real vertex; sample the first 64 indices per tooth to stay cheap on
// large real proxies while still catching a wrong componentType or a stale count.
let oob = 0;
for (const n of named) {
  const prim = meshes[Number(n.mesh)].primitives[0];
  const pa = acc[prim.attributes.POSITION], ia = acc[prim.indices];
  const start = (views[ia.bufferView].byteOffset ?? 0) + (ia.byteOffset ?? 0);
  const idx = new Uint32Array(bin.buffer, bin.byteOffset + start, Math.min(ia.count, 64));
  for (const v of idx) if (v >= pa.count) oob++;
}
ok(oob === 0, `sampled indices address real vertices (${oob} out of range)`);

console.log(`\n${named.length} teeth, ${verts} vertices, ${tris} triangles, ${buf.length} B`);
console.log(fails.length ? `${fails.length} FAILED` : 'proxy GLB is structurally loadable');
process.exit(fails.length ? 1 : 0);
