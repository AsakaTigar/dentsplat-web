/**
 * dspk-head.ts — read a .dspk back from disk and print what the GPU would actually see.
 *
 * This exists so the browser probe has something independent to be checked against. The container is
 * the only representation that is common to the Python pipeline and the renderer: PLY order is upstream
 * of it, screen pixels are downstream of it. If the layer histogram decoded here equals the histogram
 * printed by tools/ply2dspk.ts AND equals the histogram measured in the page, then the semantics rode
 * through the encode/decode round trip intact — which is the claim the whole "per-layer transparency"
 * demo rests on.
 *
 *   node tools/dspk-head.ts --in public/assets/sceneA_full.dspk
 *   node tools/dspk-head.ts --in dist/assets/sceneB_from_nifti.dspk --fdi 16
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeSplatCloud, strideOf, bytesOf, LAYER, FLAG } from '../src/engine/dspk.ts';

const A: Record<string, string | number | boolean> = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2), nx = a[i + 1];
    if (nx === undefined || nx.startsWith('--')) { A[k] = true; continue; }
    A[k] = /^-?\d+(\.\d+)?$/.test(nx) ? Number(nx) : nx;
    i++;
  }
}
const inPath = String(A.in ?? '');
if (!inPath) { console.error('usage: node tools/dspk-head.ts --in <file.dspk> [--fdi N]'); process.exit(2); }

const buf = readFileSync(inPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const c = decodeSplatCloud(ab);

// Same bbox-lerp the vertex shader uses (dspk.splatCenter), stated here so a reader can check the
// probe's arithmetic against the one function the renderer trusts.
const mm = (i: number, k: number) =>
  c.bboxMin[k] + (c.pos[i * 3 + k] / 65535) * (c.bboxMax[k] - c.bboxMin[k]);

const layerHist: Record<number, number> = {};
const fdiHist: Record<number, number> = {};
const flagHist: Record<string, number> = { upper: 0, lower: 0, cutCap: 0, none: 0 };
const alpha: { min: number; max: number; sum: number } = { min: 255, max: 0, sum: 0 };
type Acc = { n: number; x: number; y: number; z: number; y0: number; y1: number };
const perLayer: Record<number, Acc> = {};
const perFdi: Record<number, Acc> = {};
const bump = (o: Record<number, Acc>, k: number, i: number) => {
  const a = o[k] ?? (o[k] = { n: 0, x: 0, y: 0, z: 0, y0: Infinity, y1: -Infinity });
  const y = mm(i, 1);
  a.n++; a.x += mm(i, 0); a.y += y; a.z += mm(i, 2);
  if (y < a.y0) a.y0 = y; if (y > a.y1) a.y1 = y;
};
const rnd = (v: number) => +v.toFixed(2);
const summary = (a: Acc | undefined) => a && ({
  n: a.n, mean: [rnd(a.x / a.n), rnd(a.y / a.n), rnd(a.z / a.n)], yRange: [rnd(a.y0), rnd(a.y1)],
});

for (let i = 0; i < c.count; i++) {
  const ly = c.misc[i * 4 + 2], f = c.misc[i * 4 + 1], fl = c.misc[i * 4 + 3], al = c.misc[i * 4];
  layerHist[ly] = (layerHist[ly] || 0) + 1;
  fdiHist[f] = (fdiHist[f] || 0) + 1;
  alpha.min = Math.min(alpha.min, al); alpha.max = Math.max(alpha.max, al); alpha.sum += al;
  if (fl & FLAG.upperJaw) flagHist.upper++; else if (fl & FLAG.lowerJaw) flagHist.lower++; else flagHist.none++;
  if (fl & FLAG.cutCapEligible) flagHist.cutCap++;
  bump(perLayer, ly, i);
  if (f) bump(perFdi, f, i);
}

const NAME: Record<number, string> = Object.fromEntries(
  Object.entries(LAYER).map(([k, v]) => [v as number, k]));

const report = {
  file: inPath,
  bytes_on_disk: buf.length,
  sha256: createHash('sha256').update(buf).digest('hex').slice(0, 32),
  header: { splats: c.count, stride: strideOf(c), expected_bytes: bytesOf(c), hasSH1: c.hasSH1,
    sh1_rows: c.sh1 ? c.sh1.length / 9 : 0 },
  bbox_mm: [[rnd(c.bboxMin[0]), rnd(c.bboxMin[1]), rnd(c.bboxMin[2])],
            [rnd(c.bboxMax[0]), rnd(c.bboxMax[1]), rnd(c.bboxMax[2])]],
  extent_mm: [rnd(c.bboxMax[0] - c.bboxMin[0]), rnd(c.bboxMax[1] - c.bboxMin[1]), rnd(c.bboxMax[2] - c.bboxMin[2])],
  scale_log: [c.scaleLogMin, c.scaleLogMax],
  meta: { name: c.meta?.name, kind: c.meta?.kind, unit: c.meta?.unit, cs: c.meta?.coordinate_system,
    provenance: c.meta?.provenance, source: c.meta?.source, generated: c.meta?.generated },
  alpha_byte: { min: alpha.min, max: alpha.max, mean: +(alpha.sum / c.count).toFixed(1) },
  flags: flagHist,
  layer_hist: Object.fromEntries(Object.entries(layerHist)
    .sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([k, v]) => [`${k}:${NAME[+k] ?? '?'}:${(c.meta?.layerNames?.[(+k)] ?? '')}`, v])),
  layer_geometry: Object.fromEntries(Object.entries(perLayer)
    .sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([k, a]) => [`${k}:${NAME[+k] ?? '?'}`, summary(a)])),
  distinct_fdi: Object.keys(perFdi).length,
  fdi_hist: fdiHist,
};

const want = A.fdi !== undefined ? perFdi[Number(A.fdi)] : undefined;
if (want) report['fdi_' + A.fdi] = summary(want);
// Upper jaw must sit above lower jaw in +Y, incisors in front of molars in +Z, and the patient's
// right side (FDI quadrants 1 and 4) on -X: three signs the whole clinical narrative (and the clip
// plane presets) depend on. Aggregated over FDI ranges rather than quadrant-by-quadrant so one
// missing tooth cannot turn a correct packet into a false alarm — and printed with the group sizes
// so a genuinely missing quadrant is still visible.
const qOf = (f: number) => Math.floor(f / 10);
const agg = (pred: (f: number) => boolean) => {
  let n = 0, x = 0, y = 0, z = 0, ids = 0;
  for (const [k, a] of Object.entries(perFdi)) {
    const f = Number(k);
    if (!pred(f)) continue;
    ids++; n += a.n; x += a.x; y += a.y; z += a.z;
  }
  return { teeth: ids, splats: n, mean: n ? [rnd(x / n), rnd(y / n), rnd(z / n)] : null };
};
const upper = agg((f) => f >= 11 && f <= 28), lower = agg((f) => f >= 31 && f <= 48);
const right = agg((f) => f > 0 && (qOf(f) === 1 || qOf(f) === 4));
const left = agg((f) => f > 0 && (qOf(f) === 2 || qOf(f) === 3));
const inc = agg((f) => [11, 12, 21, 22, 31, 32, 41, 42].includes(f));
const mol = agg((f) => [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48].includes(f));
const s7 = perLayer[LAYER.sinus], s4 = perLayer[LAYER.nerve];
report.frame_checks = {
  teeth_quadrants_present: [1, 2, 3, 4].filter((q) =>
    Object.keys(perFdi).some((k) => qOf(Number(k)) === q)).length,
  groups: { upper, lower, patient_right: right, patient_left: left, incisors: inc, molars: mol,
    sinus: summary(s7), nerve: summary(s4) },
  upper_above_lower: !!(upper.mean && lower.mean && upper.mean[1] > lower.mean[1]),
  incisors_forward_of_molars: !!(inc.mean && mol.mean && inc.mean[2] > mol.mean[2]),
  right_side_at_minus_x: !!(right.mean && left.mean && right.mean[0] < left.mean[0]),
  sinus_above_nerve: !!(s7 && s4 && s7.y / s7.n > s4.y / s4.n),
  pulp_inside_teeth: (() => {
    // Every pulp id is FDI+100, so its centroid must sit where that tooth's centroid sits. This is
    // the check that makes "root-canal highlighting is free" a fact rather than a claim.
    const pairs = Object.keys(perFdi).map(Number).filter((f) => f > 100).map((p) => {
      const t = perFdi[p - 100]; return t ? Math.hypot(perFdi[p].x / perFdi[p].n - t.x / t.n,
        perFdi[p].y / perFdi[p].n - t.y / t.n, perFdi[p].z / perFdi[p].n - t.z / t.n) : null;
    }).filter((v): v is number => v !== null);
    return { n: pairs.length, max_mm: pairs.length ? +Math.max(...pairs).toFixed(2) : null };
  })(),
};
if (A.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(JSON.stringify({ ...report, fdi_hist: undefined, layer_geometry: undefined,
    quadrants: undefined }, (k, v) => v === undefined ? undefined : v, 2));
  console.log('\nlayer_geometry', JSON.stringify(report.layer_geometry, null, 2));
  console.log('\nfdi_hist', JSON.stringify(fdiHist));
  console.log('\nframe_checks', JSON.stringify(report.frame_checks, null, 2));
  console.log('\nFDI list', Object.keys(fdiHist).map(Number).filter((f) => f > 0).sort((a, b) => a - b).join(','));
}
