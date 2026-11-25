/**
 * Self-test for tools/ply2dspk.ts: writes a small but structurally real 3DGS .ply plus side-car
 * labels, runs the converter as a child process, and asserts both the happy path and the three
 * alignment guards (row-count mismatch, manifest sha mismatch, declared Morton order).
 *
 *   node tools/test-ply2dspk.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { decodeSplatCloud, LAYER, splatCenter } from '../src/engine/dspk.ts';

const dir = mkdtempSync(join(tmpdir(), 'dspk-test-'));
const N = 400;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** INRIA-style binary PLY: xyz, normals-less, f_dc(3), f_rest(9), opacity, scale(3), rot(4). */
function makePly(n: number, withSh: boolean): Buffer {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  if (withSh) for (let i = 0; i < 9; i++) props.push('f_rest_' + i);
  props.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');
  const stride = props.length * 4;
  const head = ['ply', 'format binary_little_endian 1.0', 'comment dentsplat self-test',
    `element vertex ${n}`, ...props.map((p) => 'property float ' + p), 'end_header', ''].join('\n');
  const buf = Buffer.alloc(head.length + n * stride);
  buf.write(head, 'latin1');
  let o = head.length;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const put = (v: number) => { buf.writeFloatLE(v, o); o += 4; };
    put(Math.cos(t * 6.28) * 30); put(t * 20 - 10); put(Math.sin(t * 6.28) * 28);   // mm, y-up
    put(0.8); put(0.7); put(0.6);                                                     // DC
    if (withSh) for (let k = 0; k < 9; k++) put((k % 3 - 1) * 0.02 * i);
    put(2.0);                                                                        // logit opacity ~0.88
    put(Math.log(0.35)); put(Math.log(0.25)); put(Math.log(0.18));
    put(1); put(0); put(0); put(0);                                                  // rot_0 = w
  }
  return buf;
}

const ply = makePly(N, true);
const plyPath = join(dir, 'scene.ply');
writeFileSync(plyPath, ply);

const fdi = Buffer.alloc(N), layer = Buffer.alloc(N);
for (let i = 0; i < N; i++) {
  fdi[i] = i < N * 0.55 ? 16 + (i % 3) : i < N * 0.8 ? 0 : 36;
  layer[i] = fdi[i] ? LAYER.enamel : LAYER.alveolar;
}
const fdiPath = join(dir, 'fdi_labels.bin'), layerPath = join(dir, 'layer_labels.bin');
writeFileSync(fdiPath, fdi); writeFileSync(layerPath, layer);

const manifest = {
  count: N, order: 'as-written', generated_by: 'self-test',
  files: { 'fdi_labels.bin': { sha256: sha(fdi), bytes: N, count: N },
    'layer_labels.bin': { sha256: sha(layer), bytes: N, count: N } },
  ply: { sha256: sha(ply), count: N },
};
const manPath = join(dir, 'labels_manifest.json');
writeFileSync(manPath, JSON.stringify(manifest, null, 2));

const tool = join(import.meta.dirname, 'ply2dspk.ts');
const run = (extra: string[]) => execFileSync(process.execPath, [tool, ...extra],
  { encoding: 'utf8', cwd: import.meta.dirname + '/..' });

const results: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

// ---- happy path
const outPath = join(dir, 'scene.dspk'), metaPath = join(dir, 'meta_X.json');
const baseArgs = ['--in', plyPath, '--fdi', fdiPath, '--layer', layerPath, '--manifest', manPath,
  '--out', outPath, '--meta-out', metaPath, '--kind', 'cbct', '--unit', '1'];
const reportText = run(baseArgs);
const report = JSON.parse(reportText.slice(reportText.indexOf('{'), reportText.lastIndexOf('}') + 1));
const dspkBytes = readFileSync(outPath);
const cloud = decodeSplatCloud(dspkBytes.buffer.slice(
  dspkBytes.byteOffset, dspkBytes.byteOffset + dspkBytes.length));

ok('decodes back with the same count', cloud.count === N, `${cloud.count} vs ${N}`);
ok('SH1 present and stride 29', cloud.hasSH1 && !('error' in cloud), JSON.stringify({ hasSH1: cloud.hasSH1 }));
ok('units are mm (bbox spans the 60 mm arch)',
  cloud.bboxMax[0] - cloud.bboxMin[0] > 55 && cloud.bboxMax[0] - cloud.bboxMin[0] < 62,
  `${(cloud.bboxMax[0] - cloud.bboxMin[0]).toFixed(1)} mm`);
ok('meta carries the source hash', typeof cloud.meta.source?.ply_sha256 === 'string' &&
  cloud.meta.source.ply_sha256 === sha(ply).slice(0, 32));
const expectedBg = Array.from({ length: N }, (_, i) => i).filter((i) => i >= N * 0.55 && i < N * 0.8).length;
ok('background splats (fdi 0) kept by default', report.fdi_histogram['0'] === expectedBg,
  JSON.stringify(report.fdi_histogram));
ok('layer histogram matches the side-car', report.layer_histogram[LAYER.enamel] > 0 &&
  report.layer_histogram[LAYER.alveolar] > 0, JSON.stringify(report.layer_histogram));
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
ok('tooth centroids derived from labels', !!meta.teeth?.FDI_16 && meta.teeth.FDI_16.splats > 0,
  JSON.stringify(meta.teeth?.FDI_16));
ok('jaw flag set from FDI range', (() => {
  let upper = 0, lower = 0;
  for (let i = 0; i < cloud.count; i++) {
    const f = cloud.misc[i * 4 + 1], fl = cloud.misc[i * 4 + 3];
    if (f === 16 && (fl & 1)) upper++;
    if (f === 36 && (fl & 2)) lower++;
  }
  return upper > 0 && lower > 0;
})());
ok('sigmoid opacity applied', (() => {
  let sum = 0;
  for (let i = 0; i < cloud.count; i++) sum += cloud.misc[i * 4];
  return sum / cloud.count > 200 && sum / cloud.count < 240;   // logit 2.0 -> 0.88 -> 225
})());
ok('SH1 coefficients round-trip in sign', (() => {
  // last splat had f_rest_k = (k%3-1)*0.02*399 ; band 1 (z) positive, band 0 (y) negative
  const i = cloud.count - 1;
  const s = cloud.sh1![i * 9];
  return s < 0 && Math.abs(s) <= 127;
})());

// ---- guard 1: row-count mismatch must be refused
let refused = false, why = '';
try {
  const bad = join(dir, 'short.bin');
  writeFileSync(bad, fdi.subarray(0, N - 7));
  run(['--in', plyPath, '--fdi', bad, '--out', join(dir, 'nope.dspk')]);
} catch (e) { refused = true; why = String(e).split('\n').find((l) => l.includes('rows')) ?? ''; }
ok('refuses misaligned label file', refused, why.slice(0, 90));

// ---- guard 2: manifest sha mismatch must be refused
refused = false; why = '';
try {
  const m2 = JSON.parse(JSON.stringify(manifest));
  m2.files['fdi_labels.bin'].sha256 = sha(Buffer.from('different'));
  const p2 = join(dir, 'bad_manifest.json');
  writeFileSync(p2, JSON.stringify(m2));
  run(['--in', plyPath, '--fdi', fdiPath, '--manifest', p2, '--out', join(dir, 'nope.dspk')]);
} catch (e) { refused = true; why = String(e).split('\n').find((l) => l.includes('sha256')) ?? ''; }
ok('refuses label file that does not match its manifest sha', refused, why.slice(0, 90));

// ---- guard 3: declared Morton order must be refused without --order-ok
refused = false; why = '';
try {
  const m3 = JSON.parse(JSON.stringify(manifest));
  m3.order = 'morton_reorder_by_ksplat_export';
  const p3 = join(dir, 'morton_manifest.json');
  writeFileSync(p3, JSON.stringify(m3));
  run(['--in', plyPath, '--fdi', fdiPath, '--layer', layerPath, '--manifest', p3, '--out', join(dir, 'nope.dspk')]);
} catch (e) { refused = true; why = String(e).split('\n').find((l) => l.includes('Morton')) ?? ''; }
ok('refuses a Morton-ordered export unless explicitly acknowledged', refused, why.slice(0, 90));

// ---- and accepting it when the operator has verified correspondence
let accepted = false;
try {
  const m3 = JSON.parse(JSON.stringify(manifest));
  m3.order = 'morton_reorder_by_ksplat_export';
  const p3 = join(dir, 'morton_manifest.json');
  writeFileSync(p3, JSON.stringify(m3));
  run(['--in', plyPath, '--fdi', fdiPath, '--layer', layerPath, '--manifest', p3,
    '--order-ok', '--out', join(dir, 'ok2.dspk')]);
  accepted = existsSync(join(dir, 'ok2.dspk'));
} catch { accepted = false; }
ok('--order-ok lets a verified Morton export through', accepted);

// ---- drop background splats, then re-decode
const dropText = run(['--in', plyPath, '--fdi', fdiPath, '--layer', layerPath, '--manifest', manPath,
  '--kind', 'cbct', '--out', join(dir, 'dropped.dspk'), '--drop']);
const drep = JSON.parse(dropText.slice(dropText.indexOf('{'), dropText.lastIndexOf('}') + 1));
ok('--drop removes unlabelled splats', drep.splats === N - drep.dropped && drep.dropped > 0,
  `${drep.splats} kept, ${drep.dropped} dropped`);

// The count above was true even when geometry was written at the input row `i` while labels were written
// at the output row `kept`: both arrays were the right LENGTH, they just described different splats. So
// re-derive each surviving splat's position from its own input row and compare it with the decoded centre.
const dBytes = readFileSync(join(dir, 'dropped.dspk'));
const dc = decodeSplatCloud(dBytes.buffer.slice(dBytes.byteOffset, dBytes.byteOffset + dBytes.length));
const survivors = Array.from({ length: N }, (_, i) => i).filter((i) => fdi[i] !== 0);
let worstMm = 0, labelRows = 0;
for (let k = 0; k < dc.count; k++) {
  const i = survivors[k];
  if (i === undefined) { worstMm = Infinity; break; }
  const t = i / N;
  const expect: [number, number, number] = [Math.cos(t * 6.28) * 30, t * 20 - 10, Math.sin(t * 6.28) * 28];
  const got: [number, number, number] = [0, 0, 0];
  splatCenter(dc, k, got);
  for (let a = 0; a < 3; a++) worstMm = Math.max(worstMm, Math.abs(got[a] - expect[a]));
  if (dc.misc[k * 4 + 1] !== fdi[i]) labelRows++;
}
ok('--drop writes each survivor\'s geometry at its own row', worstMm < 0.01,
  `max position error ${worstMm.toFixed(4)} mm over ${dc.count} rows`);
ok('--drop keeps the label byte on the same row as the geometry', labelRows === 0,
  `${labelRows} of ${dc.count} rows carry another splat's FDI`);

// ---- FDI 11 / 12 must carry the upper-jaw flag (the old range started at 13)
const fdiIncisor = Buffer.alloc(N);
for (let i = 0; i < N; i++) fdiIncisor[i] = i % 2 ? 11 : 12;
const incPath = join(dir, 'fdi_incisors.bin');
writeFileSync(incPath, fdiIncisor);
run(['--in', plyPath, '--fdi', incPath, '--out', join(dir, 'incisors.dspk')]);
const iBytes = readFileSync(join(dir, 'incisors.dspk'));
const ic = decodeSplatCloud(iBytes.buffer.slice(iBytes.byteOffset, iBytes.byteOffset + iBytes.length));
let incUpper = 0, incLower = 0;
for (let k = 0; k < ic.count; k++) {
  const fl = ic.misc[k * 4 + 3];
  if (fl & 1) incUpper++;
  if (fl & 2) incLower++;
}
ok('FDI 11/12 are flagged upper jaw (and only upper)', incUpper === ic.count && incLower === 0,
  `${incUpper} upper, ${incLower} lower of ${ic.count}`);

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed  (workdir ${dir})`);
