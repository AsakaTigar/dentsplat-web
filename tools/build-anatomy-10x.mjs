/**
 * Build the two equal-size 10x DentVoxel ablation packets.
 *
 * Uniform: every tenth record, tangential scale * sqrt(10).
 * Anatomy-aware: stratify by anatomical layer, retaining nerve 6000 / teeth 4000 /
 * alveolar bone 800 / maxillary sinus 300, with each layer's tangential scale compensated
 * by sqrt(parent_count / kept_count). Both outputs keep the source bbox, SH1, metadata
 * length and stride, so they occupy exactly the same byte budget.
 *
 *   node tools/build-anatomy-10x.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const IN = 'public/assets/sceneB_dentvoxel_full.dspk';
const OUT_UNIFORM = 'public/assets/sceneB_10x_uniform.dspk';
const OUT_ANATOMY = 'public/assets/sceneB_10x_anatomy.dspk';
const src = readFileSync(IN);
if (src.readUInt32LE(0) !== 0x4b505344) throw new Error('source is not DSPK');
const stride = src.readUInt8(7);
const count = src.readUInt32LE(8, true);
const metaLen = src.readUInt32LE(44, true);
const base = 128 + metaLen;
if (src.length !== base + count * stride) throw new Error('source size mismatch');
if (count !== 111000 || stride !== 29) throw new Error(`expected the 111k SH1 CBCT packet, got count=${count}, stride=${stride}`);
const meta = JSON.parse(src.toString('utf8', 128, base));
const parentSha = createHash('sha256').update(src).digest('hex');

const layerOf = (i) => src.readUInt8(base + i * stride + 18);
const byLayer = new Map();
for (let i = 0; i < count; i++) {
  const l = layerOf(i);
  if (!byLayer.has(l)) byLayer.set(l, []);
  byLayer.get(l).push(i);
}
const hist = {};
for (const [l, a] of byLayer) hist[l] = a.length;
const expected = { 1: 65000, 3: 30000, 4: 8000, 7: 8000 };
for (const [k, v] of Object.entries(expected)) if (hist[k] !== v) throw new Error(`layer ${k}: expected ${v}, got ${hist[k]}`);

const even = (a, n) => Array.from({ length: n }, (_, k) => a[Math.floor(k * a.length / n)]);

const uniform = Array.from({ length: count / 10 }, (_, k) => k * 10);
const anatomy = [
  ...even(byLayer.get(4), 6000),
  ...even(byLayer.get(1), 4000),
  ...even(byLayer.get(3), 800),
  ...even(byLayer.get(7), 300),
];

const writePacket = (outPath, name, keep, method) => {
  if (keep.length !== 11100) throw new Error(`${name}: ${keep.length} records`);
  const n = keep.length;
  const logMin = src.readFloatLE(36), logMax = src.readFloatLE(40);
  const scales = new Float64Array(n * 3);
  let lo = Infinity, hi = -Infinity;
  const layerCounts = {};
  for (let k = 0; k < n; k++) {
    const i = keep[k], o = base + i * stride, layer = layerOf(i);
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
    // Use the requested final layer budget, not the running count, for exact sqrt(k) compensation.
    const wanted = method === 'uniform' ? null : { 4: 6000, 1: 4000, 3: 800, 7: 300 }[layer];
    const decimation = method === 'uniform' ? 10 : hist[layer] / wanted;
    for (let a = 0; a < 3; a++) {
      const t = src.readUInt8(o + 10 + a) / 255;
      const s = Math.exp(logMin + t * (logMax - logMin)) * (a < 2 ? Math.sqrt(decimation) : 1);
      scales[k * 3 + a] = s;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
  }
  const newLogMin = Math.log(lo), newLogMax = Math.log(hi), span = Math.max(1e-6, newLogMax - newLogMin);
  const info = {
    name, kind: meta.kind, unit: meta.unit, coordinate_system: meta.coordinate_system,
    source: { parent: IN, parent_sha256: parentSha, parent_vertices: count },
    compression: {
      method, factor: 10, kept: n, layer_counts: layerCounts,
      layer_retention: method === 'uniform'
        ? Object.fromEntries(Object.entries(hist).map(([l, v]) => [l, v / 10]))
        : { 4: 6000, 1: 4000, 3: 800, 7: 300 },
      tangential_scale: 'sqrt(layer_parent_count / layer_kept_count)', normal_scale: 'unchanged',
    },
  };
  const json = JSON.stringify(info);
  if (json.length > metaLen) throw new Error(`${name}: metadata ${json.length} > ${metaLen}`);
  const metaBytes = Buffer.from(json + ' '.repeat(metaLen - json.length), 'utf8');
  const out = Buffer.alloc(128 + metaLen + n * stride);
  src.copy(out, 0, 0, 128);
  out.writeUInt32LE(n, 8);
  out.writeFloatLE(newLogMin, 36);
  out.writeFloatLE(newLogMax, 40);
  out.writeUInt32LE(metaLen, 44);
  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(out, 48, 0, Math.min(63, nameBytes.length));
  out.fill(0, 48 + Math.min(63, nameBytes.length), 112);
  metaBytes.copy(out, 128);
  for (let k = 0; k < n; k++) {
    const i = keep[k], s = base + i * stride, d = 128 + metaLen + k * stride;
    src.copy(out, d, s, s + stride);
    for (let a = 0; a < 3; a++) {
      const t = (Math.log(scales[k * 3 + a]) - newLogMin) / span;
      out.writeUInt8(Math.round(Math.max(0, Math.min(1, t)) * 255), d + 10 + a);
    }
  }
  writeFileSync(outPath, out);
  return {
    file: outPath, bytes: out.length, splats: n, sh_degree: 1, bytes_per_splat: stride,
    mb: +(out.length / 1048576).toFixed(2), sha256: createHash('sha256').update(out).digest('hex'),
    layer_counts: layerCounts, method, tangential_scale: info.compression.tangential_scale,
  };
};

const uniformInfo = writePacket(OUT_UNIFORM, 'dentvoxel0095-uniform10x', uniform, 'uniform');
const anatomyInfo = writePacket(OUT_ANATOMY, 'dentvoxel0095-anatomy10x', anatomy, 'anatomy-aware');
if (uniformInfo.bytes !== anatomyInfo.bytes) throw new Error('ablation packets are not byte-equal');
console.log(JSON.stringify({ base: { file: IN, bytes: src.length, splats: count, sha256: parentSha }, uniform: uniformInfo, anatomy: anatomyInfo }, null, 1));
