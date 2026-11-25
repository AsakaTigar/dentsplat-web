/**
 * ply2dspk — turn a trained 3D Gaussian Splatting .ply (+ side-car semantic labels) into the
 * DentSplat container, with the alignment checks that make the labels trustworthy.
 *
 *   node tools/ply2dspk.ts --in out/sceneA.ply --fdi out/fdi_labels.bin \
 *        --layer out/layer_labels.bin --manifest out/labels_manifest.json \
 *        --out public/assets/sceneA_full.dspk --meta-out public/assets/meta_A.json \
 *        --kind ios --case A
 *
 * Why the checks exist: .ksplat / .spz writers Morton-reorder splats, and a per-vertex label
 * array written from the *original* order then silently mislabels every tooth. So this tool
 * refuses to guess: it requires the label row count to equal the PLY vertex count, verifies each
 * side-car against labels_manifest.json (sha256 + count + declared order), and reports the FDI
 * histogram so a shuffled label file is visible in the output rather than in the render.
 *
 * It accepts both PLY dialects the repo produces. A trained 3DGS .ply carries f_dc_, opacity,
 * scale_ and rot_ bands, so colour, alpha, splat size and orientation are all read. A segmentation-
 * sampled cloud (pipeline/toothfairy2_to_layers.py) carries red/green/blue/alpha and no Gaussian
 * parameters; there the splat size is derived from the lattice pitch the converter recorded in
 * labels_manifest.json (`spacing_mm`, overridable with --point-mm) and the report's `appearance` and
 * `encoded` blocks say in words which channels were read and which were synthesised.
 *
 * Nothing else here is invented: geometry, colour and opacity come from the .ply; FDI/layer come from
 * the side-cars; only the jaw flag and the derived tooth centroids are computed (from FDI ranges,
 * which is a documented rule, not a guess).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloud, encodeSplatCloud, LAYER, FLAG, type SplatMeta } from '../src/engine/dspk.ts';

const SH_C0 = 0.28209479177387814;

// The meta blob is embedded in the container, so whatever gets recorded here changes the asset's
// bytes. Absolute paths did exactly that: the same packet built by hand and by
// tools/verify_cbct_route.py differed by 260 bytes of C:\Users\...\ prefix and looked "stale".
// Repo-relative forward-slash paths are what a reader wants and what makes the sha comparable.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const disp = (p: string): string => {
  const r = relative(REPO, resolve(p)).split(sep).join('/');
  return r && !r.startsWith('../') ? r : resolve(p).split(sep).join('/');
};

type Args = Record<string, string | number | boolean>;
function argv(): Args {
  const out: Args = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const nx = a[i + 1];
    if (nx === undefined || nx.startsWith('--')) { out[k] = true; continue; }
    out[k] = /^-?\d+(\.\d+)?$/.test(nx) ? Number(nx) : nx;
    i++;
  }
  return out;
}

// ------------------------------------------------------------------ PLY reader

type PlyProp = { name: string; type: string; size: number };
const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

function readPly(buf: Buffer) {
  const headEnd = buf.indexOf('end_header\n');
  if (headEnd < 0) throw new Error('not a PLY: no end_header');
  const head = buf.subarray(0, headEnd + 11).toString('latin1');
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('not a PLY');
  const format = lines[1];
  if (!/^format (binary_little_endian|ascii) 1\.0$/.test(format)) {
    throw new Error('unsupported PLY format: ' + format + ' (need binary_little_endian or ascii)');
  }
  let vertexCount = -1;
  const props: PlyProp[] = [];
  let inVertex = false;
  for (const l of lines.slice(2)) {
    if (l.startsWith('comment')) continue;
    if (l.startsWith('element')) { inVertex = l.split(/\s+/)[1] === 'vertex'; if (inVertex) vertexCount = Number(l.split(/\s+/)[2]); continue; }
    if (l.startsWith('property') && inVertex) {
      const t = l.split(/\s+/);
      if (t[1] === 'list') throw new Error('list properties are not supported in a splat PLY');
      props.push({ name: t[2], type: t[1], size: TYPE_SIZE[t[1]] ?? 0 });
    }
    if (l.startsWith('end_header')) break;
  }
  if (vertexCount < 0) throw new Error('PLY header has no vertex element');
  if (props.some((p) => p.size === 0)) throw new Error('PLY has an unknown scalar type');

  const stride = props.reduce((s, p) => s + p.size, 0);
  const offsets: Record<string, number> = {};
  { let o = 0; for (const p of props) { offsets[p.name] = o; o += p.size; } }

  // `format` still carries the leading keyword ("format binary_little_endian 1.0"), so test the body
  const binary = format.includes('binary');
  const body = buf.subarray(headEnd + 11);
  if (binary && body.length !== vertexCount * stride) {
    throw new Error(`PLY body size mismatch: expected ${vertexCount * stride} B for ${vertexCount} ` +
      `vertices at stride ${stride}, got ${body.length} B`);
  }
  const dv = binary ? new DataView(body.buffer, body.byteOffset, body.length) : null;
  const asciiRows = binary ? null : body.toString('latin1').trim().split(/\s+/);
  const get = (i: number, name: string): number => {
    const o = offsets[name];
    if (o === undefined) return NaN;
    if (dv) {
      const p = props.find((q) => q.name === name)!;
      switch (p.type) {
        case 'float': case 'float32': return dv.getFloat32(i * stride + o, true);
        case 'double': case 'float64': return dv.getFloat64(i * stride + o, true);
        case 'uchar': case 'uint8': return dv.getUint8(i * stride + o);
        case 'char': case 'int8': return dv.getInt8(i * stride + o);
        case 'ushort': case 'uint16': return dv.getUint16(i * stride + o, true);
        case 'short': case 'int16': return dv.getInt16(i * stride + o, true);
        case 'uint': case 'uint32': return dv.getUint32(i * stride + o, true);
        default: return dv.getInt32(i * stride + o, true);
      }
    }
    return Number(asciiRows![i * props.length + props.findIndex((q) => q.name === name)]);
  };
  return { vertexCount, props, offsets, get, format, stride, version: lines[1] };
}

// ------------------------------------------------------------------ side-cars

function sha(b: Buffer) { return createHash('sha256').update(b).digest('hex'); }

type Manifest = {
  count?: number; order?: string; generated_by?: string;
  /** toothfairy2_to_layers.py records the lattice pitch it sampled at. */
  spacing_mm?: number; surface_only?: boolean;
  files?: Record<string, { sha256?: string; bytes?: number; count?: number }>;
  ply?: { sha256?: string; count?: number };
};

function checkSideCar(path: string, key: string, n: number, man: Manifest | null, label: string) {
  if (!existsSync(path)) throw new Error(`${label}: missing ${path}`);
  const buf = readFileSync(path);
  if (buf.length !== n) {
    throw new Error(`${label}: ${path} holds ${buf.length} rows but the PLY has ${n} vertices. ` +
      `Refusing to attach misaligned semantics — every tooth id would be wrong.`);
  }
  if (man?.files?.[key]) {
    const want = man.files[key];
    if (want.sha256 && want.sha256 !== sha(buf)) {
      throw new Error(`${label}: sha256 of ${path} is ${sha(buf).slice(0, 16)}…, manifest says ` +
        `${want.sha256.slice(0, 16)}… — the label file is not the one that was written with this PLY.`);
    }
    if (want.count !== undefined && want.count !== n) {
      throw new Error(`${label}: manifest declares ${want.count} rows, PLY has ${n}`);
    }
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

// ------------------------------------------------------------------ main

const A = argv();
const need = (k: string) => { const v = A[k]; if (typeof v !== 'string') throw new Error(`--${k} required`); return v; };

const plyPath = need('in');
const outPath = String(A.out ?? 'public/assets/scene_custom.dspk');
const metaOut = A['meta-out'] ? String(A['meta-out']) : null;
const kind = (A.kind === 'cbct' ? 'cbct' : 'ios') as 'ios' | 'cbct';
const unit = Number(A.unit ?? 1);          // 1 unit = 1 mm after this scale
const axis = String(A.axis ?? 'y-up');     // y-up | z-up (z-up swaps y/z so the arch sits upright)
const sigmoidOpacity = A['raw-opacity'] !== true;
const expScale = A['raw-scale'] !== true;
const negateXY = A['sh1-negate-xy'] === true;
const maxSplats = A['max'] ? Number(A['max']) : Infinity;
const drop = A.drop === true;              // drop splats with no FDI (background / gingiva-only clouds)

const plyBuf = readFileSync(plyPath);
const ply = readPly(plyBuf);
if (A['print-header'] === true) {
  const i = Number(A['print-header-at'] ?? 0);
  console.log(JSON.stringify({ format: ply.format, vertexCount: ply.vertexCount, stride: ply.stride,
    props: ply.props.map((p) => `${p.name}:${p.type}`),
    sample: Object.fromEntries(ply.props.map((p) => [p.name, ply.get(i, p.name)])) }, null, 2));
  process.exit(0);
}
const names = ply.props.map((p) => p.name);
const hasSH1 = names.includes('f_rest_0');
if (!names.includes('x') || !names.includes('y') || !names.includes('z')) {
  throw new Error('PLY has no x/y/z position properties');
}
const shCount = hasSH1 ? names.filter((n) => n.startsWith('f_rest_')).length : 0;
if (hasSH1 && shCount !== 9) throw new Error(`expected 9 f_rest_* bands for l=1, found ${shCount}`);

// Two different inputs legitimately reach this tool. A trained 3DGS .ply carries f_dc_*/opacity/
// scale_*/rot_* and every channel is *measured*. A segmentation-sampled cloud (the CBCT route out of
// toothfairy2_to_layers.py) carries red/green/blue/alpha and no Gaussian parameters at all — there is
// nothing to read for the last two, so they must be *derived and declared*, never defaulted quietly.
// Silently falling back to scale 0.2 mm + sigmoid(NaN) = 0.731 alpha is what made the first CBCT
// packet a uniform grey dot-cloud while the report looked clean, so each channel now records where its
// value came from and the report prints it.
const hasDC = names.includes('f_dc_0');
const hasRGB = names.includes('red') && names.includes('green') && names.includes('blue');
const hasOpacity = names.includes('opacity');
const hasAlphaByte = names.includes('alpha');
const hasScales = names.includes('scale_0');
const hasRot = names.includes('rot_0');

const manPath = A.manifest ? String(A.manifest) : null;
const man: Manifest | null = manPath ? JSON.parse(readFileSync(manPath, 'utf8')) : null;

// Splat size for a scale-less cloud, taken from the producer's own lattice pitch (the converter
// writes spacing_mm into labels_manifest.json) so the number is traceable instead of invented.
const spacingMm = A['point-mm'] !== undefined ? Number(A['point-mm'])
  : (typeof man?.spacing_mm === 'number' ? man.spacing_mm : NaN);
const sigmaFactor = A['point-factor'] !== undefined ? Number(A['point-factor']) : 0.6;
let sigmaMm = NaN;
if (!hasScales) {
  if (!Number.isFinite(spacingMm) || spacingMm <= 0) {
    console.warn('! PLY has no scale_* and no --point-mm / manifest spacing_mm: falling back to a flat');
    console.warn('  0.2 mm splat. Every splat then has the same encoded scale, so the size means nothing');
    console.warn('  and the coverage pruner cannot dilate. Pass --point-mm <lattice pitch>.');
    sigmaMm = 0.2;
  } else {
    sigmaMm = spacingMm * sigmaFactor;
  }
}
const appearance = {
  color: hasDC ? 'f_dc_ bands (trained SH0)' : hasRGB ? 'red/green/blue bytes' : 'flat 0.8 fallback',
  alpha: hasOpacity ? 'sigmoid(opacity)' : hasAlphaByte ? 'alpha byte (linear)' : 'flat 1.0',
  scale: hasScales ? (expScale ? 'exp(scale_ bands)' : 'scale_ bands raw')
    : `synthesised ${sigmaMm.toFixed(3)} mm from lattice pitch ${Number.isFinite(spacingMm) ? spacingMm : 'n/a'} x ${sigmaFactor}`,
  rotation: hasRot ? 'rot_ bands (w,x,y,z -> x,y,z,w)' : 'identity (no rot_ bands in the PLY)',
  sh1: hasSH1 ? 'f_rest_0..8' : 'none (SH degree 0)',
};
if (man?.order && /morton|spatially|sorted/i.test(man.order) && !A['order-ok']) {
  throw new Error(`manifest declares splat order "${man.order}". Side-car labels written in training ` +
    `order would be misaligned by a Morton permutation. Re-export the labels from the same pass that ` +
    `wrote this PLY, or pass --order-ok only if you have verified the correspondence yourself.`);
}
if (man?.ply?.sha256 && man.ply.sha256 !== sha(plyBuf)) {
  console.warn('! PLY sha256 differs from the manifest — labels may describe a different checkpoint.');
}

const fdi = A.fdi ? checkSideCar(String(A.fdi), 'fdi_labels.bin', ply.vertexCount, man, 'FDI labels') : null;
const layer = A.layer ? checkSideCar(String(A.layer), 'layer_labels.bin', ply.vertexCount, man, 'layer labels') : null;
if (!fdi && !layer) {
  console.warn('! no --fdi and no --layer: every splat will be "other" with no tooth id, so the');
  console.warn('  odontogram, per-tooth highlight and measurement will have nothing to bind to.');
}

const n = Math.min(ply.vertexCount, maxSplats);
const centers = new Float64Array(n * 3), quats = new Float64Array(n * 4), scales = new Float64Array(n * 3);
const colors = new Float64Array(n * 3), alphas = new Float64Array(n);
const toothIds = new Uint8Array(n), layerIds = new Uint8Array(n), flags = new Uint8Array(n);
const sh1 = hasSH1 ? new Float64Array(n * 9) : undefined;

const hist: Record<number, number> = {};
const layerHist: Record<number, number> = {};
const centroid: Record<number, [number, number, number, number]> = {}; // fdi -> sum x,y,z,count
let dropped = 0, kept = 0;
let alphaMin = 255, alphaMax = 0;
const colorSet = new Set<number>(), rotSet = new Set<number>();

for (let i = 0; i < n; i++) {
  // The drop test has to run before anything is written, and every output array has to be indexed by the
  // output row `o`, not the input row `i`: with --drop the two diverge from the first filtered splat, so
  // geometry written at `i` and labels written at `kept` would describe different splats. (`sh1`, tooth,
  // layer and flag bytes were already on `kept`; positions, rotations, scales, colours and alphas were not.)
  const f = fdi ? fdi[i] : 0;
  if (drop && f === 0) { dropped++; continue; }
  const o = kept;

  let x = ply.get(i, 'x') * unit, y = ply.get(i, 'y') * unit, z = ply.get(i, 'z') * unit;
  if (axis === 'z-up') { const t = y; y = z; z = -t; }
  if (A['flip-x'] === true) x = -x;
  if (A['flip-z'] === true) z = -z;
  centers[o * 3] = x; centers[o * 3 + 1] = y; centers[o * 3 + 2] = z;

  // quaternion: PLY stores (rot_0=w, rot_1..3 = x,y,z); dspk wants (x,y,z,w). With no rot_* at all the
  // answer is the identity (0,0,0,1) -- the previous default put 1 in the x slot, i.e. a 180 deg roll
  // about X, which is invisible while all three scales are equal and wrong the moment they are not.
  const rw = hasRot ? ply.get(i, 'rot_0') : 1, rx = hasRot ? ply.get(i, 'rot_1') : 0;
  const ry = hasRot ? ply.get(i, 'rot_2') : 0, rz = hasRot ? ply.get(i, 'rot_3') : 0;
  quats[o * 4] = Number.isFinite(rx) ? rx : 0;
  quats[o * 4 + 1] = Number.isFinite(ry) ? ry : 0;
  quats[o * 4 + 2] = Number.isFinite(rz) ? rz : 0;
  quats[o * 4 + 3] = Number.isFinite(rw) ? rw : 1;

  for (let k = 0; k < 3; k++) {
    if (!hasScales) { scales[o * 3 + k] = sigmaMm; continue; }
    const s = ply.get(i, 'scale_' + k);
    scales[o * 3 + k] = Number.isFinite(s) ? (expScale ? Math.exp(s) : s) : 0.2;
  }
  if (A['scale-mult']) for (let k = 0; k < 3; k++) scales[o * 3 + k] *= Number(A['scale-mult']);

  if (hasOpacity) {
    let op = ply.get(i, 'opacity');
    if (!Number.isFinite(op)) op = 1;
    alphas[o] = sigmoidOpacity ? 1 / (1 + Math.exp(-op)) : op;
  } else if (hasAlphaByte) {
    // An 8-bit coverage/alpha channel is already linear 0..1; sigmoid() on it would crush every
    // opaque splat to 0.73 and every transparent one to 0.5.
    const a = ply.get(i, 'alpha');
    alphas[o] = Number.isFinite(a) ? Math.min(1, Math.max(0, a / 255)) : 1;
  } else {
    alphas[o] = 1;
  }

  for (let k = 0; k < 3; k++) {
    if (hasDC) {
      const dc = ply.get(i, 'f_dc_' + k);
      colors[o * 3 + k] = Number.isFinite(dc) ? Math.min(1, Math.max(0, 0.5 + SH_C0 * dc)) : 0.8;
    } else if (hasRGB) {
      const v = ply.get(i, ['red', 'green', 'blue'][k]);
      colors[o * 3 + k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 255)) : 0.8;
    } else {
      colors[o * 3 + k] = 0.8;
    }
  }
  if (sh1) {
    // PLY order is channel-major: R(y,z,x), G(y,z,x), B(y,z,x) — same layout the shader expects.
    for (let c = 0; c < 3; c++) {
      for (let b = 0; b < 3; b++) {
        let v = ply.get(i, 'f_rest_' + (c * 3 + b));
        if (!Number.isFinite(v)) v = 0;
        if (negateXY && b !== 1) v = -v;
        sh1[o * 9 + c * 3 + b] = v;
      }
    }
  }

  // `f` was read at the top of the loop; the row that reaches this point always survives --drop.
  let ly = layer ? layer[i] : (f >= 11 ? LAYER.enamel : kind === 'cbct' ? LAYER.alveolar : LAYER.gingiva);
  if (ly > 8) ly = LAYER.other;

  // Statistics over the splats that actually survive, so `encoded` describes the packet and not the
  // rows that --drop threw away.
  {
    const ab = Math.min(255, Math.max(0, Math.round(alphas[o] * 255)));
    if (ab < alphaMin) alphaMin = ab;
    if (ab > alphaMax) alphaMax = ab;
    colorSet.add((Math.round(colors[o * 3] * 255) << 16) | (Math.round(colors[o * 3 + 1] * 255) << 8) |
      Math.round(colors[o * 3 + 2] * 255));
    rotSet.add((quats[o * 4] << 20) ^ (quats[o * 4 + 1] << 10) ^ quats[o * 4 + 2] ^ (quats[o * 4 + 3] * 4096));
  }
  toothIds[o] = f; layerIds[o] = ly;
  let fl = 0;
  // FDI 11 and 12 are the upper-right central and lateral incisors; the old range started at 13, so on a
  // real Teeth3DS+ scan those two teeth came out with no jaw flag at all (no jaw recoil, wrong arch).
  if (f >= 11 && f <= 18) fl |= FLAG.upperJaw; else if (f >= 21 && f <= 28) fl |= FLAG.upperJaw;
  else if (f >= 31 && f <= 38) fl |= FLAG.lowerJaw; else if (f >= 41 && f <= 48) fl |= FLAG.lowerJaw;
  if (kind === 'cbct') fl |= FLAG.cutCapEligible;
  flags[o] = fl;
  hist[f] = (hist[f] || 0) + 1;
  layerHist[ly] = (layerHist[ly] || 0) + 1;
  const c = centroid[f] ?? (centroid[f] = [0, 0, 0, 0]);
  c[0] += x; c[1] += y; c[2] += z; c[3]++;
  kept++;
}

if (kept === 0) throw new Error('no splats survived the filters');
const view = (a: Float64Array, k: number) => a.subarray(0, kept * k);
const cloud = buildCloud({
  centers: view(centers, 3), quats: view(quats, 4), scales: view(scales, 3),
  colors: view(colors, 3), alphas: view(alphas, 1),
  toothIds: toothIds.subarray(0, kept), layerIds: layerIds.subarray(0, kept), flags: flags.subarray(0, kept),
  sh1: sh1 ? view(sh1, 9) : undefined,
  meta: {
    name: String(A.name ?? disp(outPath).split('/').pop() ?? 'dent'),
    kind, unit: 'mm', coordinate_system: 'glTF_Y_up',
    source: { ply: disp(plyPath), ply_sha256: sha(plyBuf).slice(0, 32), ply_vertices: ply.vertexCount,
      format: ply.format, labels_manifest: manPath ? disp(manPath) : null, order: man?.order ?? 'as-written',
      spacing_mm: Number.isFinite(spacingMm) ? spacingMm : null, appearance },
    // The provenance line has to describe the input that was actually read: labelling a CBCT
    // segmentation cloud as "trained 3DGS splats" would be a false statement inside the asset.
    provenance: String(A.provenance ?? (hasDC
      ? 'trained 3DGS splats + side-car semantics via tools/ply2dspk.ts'
      : 'segmentation-sampled point cloud + side-car semantics via tools/ply2dspk.ts'
        + ' (splat size derived from the sampling pitch, see source.appearance)')),
    // No timestamp here on purpose. This object is embedded in the container, so a wall-clock string
    // would make the asset's sha depend on when it was built -- and then "rebuild it and compare
    // bytes" (check 9 of tools/verify_cbct_route.py) could never pass. conversion.converted_at in the
    // side-car meta json still records the moment; the container records only what the bytes ARE.
    ...(A['keep-converted-at'] ? { converted_at: new Date().toISOString() } : {}),
  } satisfies SplatMeta,
});

const bytes = encodeSplatCloud(cloud);
writeFileSync(outPath, new Uint8Array(bytes));

const teeth: Record<string, unknown> = {};
for (const [f, c] of Object.entries(centroid)) {
  const id = Number(f);
  if (!id || c[3] === 0) continue;
  teeth['FDI_' + id] = { fdi: id, arch: id < 30 ? 'upper' : 'lower',
    at: [+(c[0] / c[3]).toFixed(2), +(c[1] / c[3]).toFixed(2), +(c[2] / c[3]).toFixed(2)],
    splats: c[3] };
}
const report = {
  out: disp(outPath), converted_at: new Date().toISOString(),
  bytes: bytes.byteLength, splats: kept, dropped, sh_degree: hasSH1 ? 1 : 0,
  bytes_per_splat: +(bytes.byteLength / kept).toFixed(2),
  bbox_mm: [cloud.bboxMin, cloud.bboxMax].map((b) => b.map((v) => +v.toFixed(2))),
  // The three numbers that tell you whether the appearance came from the file or from a default:
  // a collapsed scale range or a single colour means the PLY did not carry that channel.
  encoded: { scale_mm: [Math.exp(cloud.scaleLogMin), Math.exp(cloud.scaleLogMax)].map((v) => +v.toFixed(3)),
    alpha_byte: [alphaMin, alphaMax], distinct_colors: colorSet.size,
    distinct_rotations: rotSet.size, input_kind: man?.kind ?? (hasDC ? 'trained_3dgs' : 'point_cloud') },
  appearance,
  fdi_histogram: hist, layer_histogram: layerHist,
  alignment: { ply_vertices: ply.vertexCount, fdi_rows: fdi?.length ?? null, layer_rows: layer?.length ?? null,
    manifest_count: man?.count ?? null, manifest_order: man?.order ?? null,
    ply_sha256: sha(plyBuf).slice(0, 32), manifest_ply_sha256: man?.ply?.sha256?.slice(0, 32) ?? null },
};
if (metaOut) {
  writeFileSync(metaOut, JSON.stringify({ ...cloud.meta, teeth, conversion: report }, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (!metaOut) console.log('(pass --meta-out to also write the tooth-centroid meta json)');
