/**
 * tools/report-add-case.mjs — append/replace one scene entry in public/assets/report.json
 * using only facts read from the shipped files themselves (DSPK header, GLB JSON chunk).
 * Nothing is estimated: missing compression measurements stay empty so the UI prints TBD.
 *
 *   node tools/report-add-case.mjs --scene sceneU_upper \
 *     --full public/assets/scene_upper_full.dspk --pruned public/assets/scene_upper_pruned.dspk \
 *     --proxy public/assets/proxy_U.glb --source "Poseidon3D case 000122 (Zenodo 15608906)" \
 *     --license "CC BY 4.0"
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SCENE = arg('--scene'), FULL = arg('--full'), PRUNED = arg('--pruned'), PROXY = arg('--proxy');
if (!SCENE || !FULL || !PRUNED) { console.error('usage: --scene key --full a.dspk --pruned b.dspk [--proxy p.glb]'); process.exit(2); }

const dspk = (path) => {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x4b505344) throw new Error(`${path}: not DSPK`);
  const version = dv.getUint8(4), flags = dv.getUint8(5), stride = dv.getUint8(7);
  const count = dv.getUint32(8, true), metaLen = dv.getUint32(44, true);
  const expect = 128 + metaLen + count * stride;
  if (buf.byteLength !== expect) throw new Error(`${path}: size ${buf.byteLength} != ${expect}`);
  return { splats: count, bytes: buf.byteLength, sh_degree: flags & 1 ? 1 : 0, bytes_per_splat: stride, version };
};

const glbInfo = (path) => {
  if (!path) return null;
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error(`${path}: not GLB`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.toString('latin1', 16, 20) !== 'JSON') throw new Error(`${path}: first chunk not JSON`);
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  let triangles = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const n = prim.indices != null ? gltf.accessors[prim.indices].count : gltf.accessors[prim.attributes.POSITION].count;
      triangles += Math.floor(n / 3);
    }
  }
  return { bytes: buf.byteLength, kb: +(buf.byteLength / 1024).toFixed(1), nodes: (gltf.nodes ?? []).length, triangles };
};

const full = dspk(FULL), pruned = dspk(PRUNED);
const reportPath = 'public/assets/report.json';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const stamp = new Date().toISOString().slice(0, 10);
report.scenes = report.scenes ?? {};
report.scenes[SCENE] = {
  full: { ...full, mb: +(full.bytes / 1048576).toFixed(2) },
  pruned: { ...pruned, mb: +(pruned.bytes / 1048576).toFixed(2) },
  bytes_ratio: +(full.bytes / Math.max(1, pruned.bytes)).toFixed(2),
  compression_fidelity_mm: {},
  proxy: glbInfo(PROXY) ?? {},
  metrics: {},
  training: {
    tool: 'Brush v0.3.0 (WGPU)',
    steps: 15000,
    views: 120,
    sh_degree: 1,
    render: 'Blender Cycles orbit, 1024 px, 48 spp',
    labels: 'no per-splat FDI side-car in this pass; odontogram intentionally empty',
  },
  provenance: {
    source: arg('--source', ''),
    license: arg('--license', ''),
    added: stamp,
    files: { full: FULL, pruned: PRUNED, proxy: PROXY ?? null },
  },
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ scene: SCENE, full: report.scenes[SCENE].full, pruned: report.scenes[SCENE].pruned, proxy: report.scenes[SCENE].proxy }, null, 1));
