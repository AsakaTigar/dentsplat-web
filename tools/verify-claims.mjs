// tools/verify-claims.mjs — asserts the sentences in MEASUREMENTS.md, brief/technical-brief.html and the
// 60-second walkthrough's captions against the captured JSON.
//
// A doc that cites numbers drifts from the artefacts it cites. This is the cheap check that keeps them
// locked: every claim in the measurements file that has a machine-readable counterpart is re-derived
// here from tools/out/*.json, and a mismatch fails the run instead of shipping a wrong sentence.
// Since §7, that includes parsing the digest table out of MEASUREMENTS.md and re-hashing the files it
// names; since the Brief and the walkthrough, the same applies to the HTML the PDF is rendered from and
// the frames.json the MP4 is cut from. `node tools/mutate-claims-test.mjs` corrupts one cited value at a
// time in a copy and asserts this script catches each one, so the gate is known to be able to fail.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const J = (p) => JSON.parse(readFileSync(`tools/out/${p}`, 'utf8'));
const fails = [];
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' != ' + JSON.stringify(want)}`);
  if (!ok) fails.push(name);
};
const near = (name, got, want, tol = 0.05) => eq(name, Math.abs(got - want) <= tol, true);

const perf = (f) => J(f).res;
const A = perf('perf-A-full.json'), Ap = perf('perf-A-pruned.json');
const B = perf('perf-B-full.json'), Bp = perf('perf-B-pruned.json');

// §3 tables: row counts, resolution ladder, and the "flat in resolution" reading.
for (const [name, p] of [['A full', A], ['A pruned', Ap], ['B full', B], ['B pruned', Bp]]) {
  eq(`${name} sizes`, p.perf.map((r) => `${r.w}x${r.h}`), ['640x360', '1280x720', '1920x1080', '2560x1440']);
  eq(`${name} glError all zero`, p.perf.every((r) => r.glError === 0), true);
  eq(`${name} one draw call`, [...new Set(p.perf.map((r) => r.drawn.calls))], [1]);
}
const spread = (rows) => +(Math.max(...rows.map((r) => r.netGpuMs)) - Math.min(...rows.map((r) => r.netGpuMs))).toFixed(2);
eq('A full netGpuMs spread <=0.3 ms', spread(A.perf) <= 0.3, true);
eq('B full netGpuMs spread <=0.3 ms', spread(B.perf) <= 0.3, true);
near('A full 640x360 net', A.perf[0].netGpuMs, 2.9);
near('A full 1440p net', A.perf[3].netGpuMs, 2.7);
near('A pruned 720p net', Ap.perf[1].netGpuMs, 0.9);
near('B full 1080p net', B.perf[2].netGpuMs, 1.3);
near('B pruned 360p net', Bp.perf[0].netGpuMs, 0.5);
eq('A full fps range 344-385', [Math.min(...A.perf.map((r) => r.fpsAtThisSize)), Math.max(...A.perf.map((r) => r.fpsAtThisSize))], [344.8, 384.6]);
eq('A full timer starved (got 0)', A.timer.map((t) => t.got), [0, 0, 0, 0]);
eq('A pruned timer answered some', Ap.timer.map((t) => t.got), [7, 9, 5, 4]);
eq('B pruned timer answered some', Bp.timer.map((t) => t.got), [11, 11, 4, 0]);
eq('A full painted ~0.194', A.perf.map((r) => r.paintedFraction), [0.1954, 0.1941, 0.1938, 0.1937]);
eq('A pruned painted ~0.19', Ap.perf.map((r) => r.paintedFraction), [0.1925, 0.1913, 0.1912, 0.1911]);
eq('B full painted ~0.25', B.perf.map((r) => r.paintedFraction), [0.2516, 0.2511, 0.251, 0.2509]);
eq('every sweep says timerSupported true', [A, Ap, B, Bp].map((p) => p.perf.every((r) => r.timerSupported)), [true, true, true, true]);
eq('method string', A.perf[0].method, 'serialised 1x1 readback, sync latency subtracted');
eq('hidden canvas context recorded', [A.canvas.screen, A.canvas.hidden, A.canvas.dpr], [{ h: 1, w: 428 }, true, 1]);

// §4 fidelity tables. Two Scene A captures exist on purpose: `bench-A-final.json` is the retired
// synthetic packet (the 60 s walkthrough still shows that build), `bench-A-poseidon.json` is the real
// intra-oral scan that ships now. Every number below names which asset it belongs to.
const bA = J('bench-A-final.json').res.direct;            // synthetic, retired 2026-11-25
const bAreal = J('bench-A-poseidon.json').res.direct;     // Poseidon3D real scan, shipped
const bB = J('bench-B-dentvoxel.json').res.direct;        // real DentVoxel case, shipped
const bBold = J('bench-B-final.json').res.direct;        // synthetic B, retired with the walkthrough
const bNaive = J('bench-A-full.json').res.direct;
eq('synthetic A (retired) whole-frame PSNR', bA.psnr, 21.82);
eq('synthetic A (retired) in-mask PSNR', bA.psnrInMask, 17.6);
eq('synthetic A (retired) MAE', bA.mae, 0.024);
eq('synthetic A (retired) identical pixels', bA.identicalFraction, 0.6233);
eq('synthetic A (retired) content pixels', bA.covered, 0.3782);
eq('synthetic A (retired) control bit-identical', [bA.psnrSelf, bA.identicalSelfFraction], [999, 1]);
eq('synthetic A (retired) error concentration', bA.errorInTop1Percent, 0.393);
eq('synthetic A (retired) mean colours', [bA.meanFull, bA.meanPruned], [[63, 50, 45.7], [60.5, 49, 44.4]]);
eq('B (DentVoxel) whole-frame PSNR', bB.psnr, 24.25);
eq('B (DentVoxel) in-mask PSNR', bB.psnrInMask, 24.12);
eq('B (DentVoxel) error concentration', bB.errorInTop1Percent, 0.327);
eq('B (DentVoxel) control bit-identical', [bB.psnrSelf, bB.identicalSelfFraction], [999, 1]);
eq('synthetic B (retired) whole-frame PSNR', bBold.psnr, 24.28);
eq('naive A whole-frame (retired comparison)', bNaive.psnr, 17.19);
eq('naive A in-mask (retired comparison)', bNaive.psnrInMask, 12.75);
const naiveDeficitPct = Math.round((1 - bNaive.meanPruned[0] / bNaive.meanFull[0]) * 100);
const compDeficitPct = Math.round((1 - bA.meanPruned[0] / bA.meanFull[0]) * 100);
eq('naive A mean deficit ~14% (retired comparison)', naiveDeficitPct, 14);
eq('compensated A mean deficit ~4% (retired comparison)', compDeficitPct, 4);
eq('gain from compensation (retired synthetic A)', +(bA.psnr - bNaive.psnr).toFixed(2), 4.63);
eq('in-mask gain (retired synthetic A)', +(bA.psnrInMask - bNaive.psnrInMask).toFixed(2), 4.85);

// The numbers that describe what ships today: a real scan, procedural colours.
eq('A (Poseidon3D) whole-frame PSNR', bAreal.psnr, 24.46);
eq('A (Poseidon3D) in-mask PSNR', bAreal.psnrInMask, 20.41);
eq('A (Poseidon3D) MAE', bAreal.mae, 0.0133);
eq('A (Poseidon3D) identical pixels', bAreal.identicalFraction, 0.6143);
eq('A (Poseidon3D) content pixels', bAreal.covered, 0.3934);
eq('A (Poseidon3D) control bit-identical', [bAreal.psnrSelf, bAreal.identicalSelfFraction], [999, 1]);
eq('A (Poseidon3D) error concentration', bAreal.errorInTop1Percent, 0.616);
eq('A (Poseidon3D) mean colours', [bAreal.meanFull, bAreal.meanPruned], [[78.9, 57.5, 56.1], [81.6, 59.7, 58.2]]);
eq('UI row agrees with engine (A)', J('bench-A-final.json').res.agrees, true);
eq('UI row agrees with engine (B)', J('bench-B-final.json').res.agrees, true);
eq('button left idle (A)', J('bench-A-final.json').res.busyAfter, false);

// §4.2 isolation: state restored, and the mask changed (which is why it is not an attribution).
const oA = J('bench-A-opaque.json').res, oB = J('bench-B-opaque.json').res;
eq('A restore matched', oA.restoredMatchesPrev, true);
eq('B restore matched', oB.restoredMatchesPrev, true);
eq('A opaque PSNR', oA.opaqueOnly.psnr, 21.82);
eq('A opaque in-mask', oA.opaqueOnly.psnrInMask, 17.59);
eq('A content unchanged', oA.opaqueOnly.covered, 0.3781);
eq('B opaque whole/in-mask', [oB.opaqueOnly.psnr, oB.opaqueOnly.psnrInMask], [23.43, 19.18]);
eq('B content mask shrank (so not comparable)', oB.opaqueOnly.covered < bB.covered, true);
// The outer file is probe-bench-opaque.js, whose own fetch+hash of the inner probe names
// probe-bench.js -- so the cited pair is (inner = probe-bench, outer = probe-bench-opaque).
eq('probe bytes cited are current', [oA.innerProbeSha.slice(0, 16), J('bench-A-opaque.json').sha.slice(0, 16)],
  ['19adc1c5f63953ca', '051911d09f9d44bb']);

// §5 geometry, straight from the regenerated report.
const rep = JSON.parse(readFileSync('public/assets/report.json', 'utf8')).scenes;
// Scene A now ships the Poseidon3D scan: gap is pruned->full because the two packets are independent
// surface samplings, not a subset relationship.
eq('A gap now', Object.values(rep.sceneA_ios.compression_fidelity_mm).slice(0, 3), [0.178, 0.362, 1.138]);
eq('B gap now', Object.values(rep.sceneB_cbct.compression_fidelity_mm).slice(0, 3), [0.701, 1.342, 2.782]);
eq('ratios match the shipped packets', [rep.sceneA_ios.bytes_ratio, rep.sceneB_cbct.bytes_ratio], [5.86, 3]);
eq('splat counts match the shipped packets', [rep.sceneA_ios.pruned.splats, rep.sceneB_cbct.pruned.splats], [10168, 40924]);
const naiveRep = JSON.parse(readFileSync('tools/out/assets-naive/report.json', 'utf8')).scenes;
eq('A gap naive', Object.values(naiveRep.sceneA_ios.compression_fidelity_mm).slice(0, 3), [0.469, 1.359, 6.556]);
eq('B gap naive', Object.values(naiveRep.sceneB_cbct.compression_fidelity_mm).slice(0, 3), [0.541, 3.389, 6.813]);

// ---------------------------------------------------------------- §7 the offline CBCT route
// The table in §7 is a set of sha256 prefixes and byte counts, which is exactly the kind of thing a
// later rebuild leaves behind. So parse the table out of the document and re-hash the files it names --
// the doc is the input here, not the script, so rewording a row cannot quietly disable its own check.
// MEASUREMENTS_DOC lets a mutation test prove this gate can fail without editing the real file.
const DOC = readFileSync(process.env.MEASUREMENTS_DOC || 'MEASUREMENTS.md', 'utf8');
// Three boundaries, not one: §7's claims are checked inside §7 alone, because the walkthrough section that
// now follows it legitimately contains the string "25 fps" -- and the throughput ban below is exactly the
// kind of gate that turns into a false alarm when its scope quietly grows.
const i7 = DOC.indexOf('## 7. The offline CBCT route');
const i8 = DOC.indexOf('## 8. The 60-second walkthrough');
const i9 = DOC.indexOf('## 9. What this does not prove');
const sec = i7 >= 0 && i8 > i7 ? DOC.slice(i7, i8) : '';
eq('§7 exists between the §7 and §8 headings', sec.length > 1000, true);
// The walkthrough got its own section when the disclaimers were still §8; renumbering is cheap to get
// wrong and this file reads section boundaries by heading text, so both new headings are asserted.
eq('the walkthrough section is §8', i8 >= 0 && i9 > i8, true);
eq('the disclaimers are §9', i9 >= 0, true);

const hex = (buf) => createHash('sha256').update(buf).digest('hex');
const shaOf = (p) => hex(readFileSync(p));
const sizeOf = (p) => statSync(p).size;
const CB = 'tools/out/cbct_route/';
const PACKET = CB + 'sceneB_from_nifti.dspk';
const PLY = CB + 'web_assets/cbct_layers.ply';

let tableRows = 0;
for (const line of sec.split(/\r?\n/)) {
  const cells = line.split('|').map((s) => s.trim());
  if (cells.length !== 5) continue;                       // only the 3-column artefact table
  const pathM = cells[1].match(/`([^`]+)`/);
  if (!pathM) continue;
  const bytesM = cells[2].match(/^([\d,]+)$/);
  const shaM = cells[3].match(/^`([0-9a-f]{16})`$/);
  if (!bytesM || !shaM) continue;
  const file = (pathM[1].startsWith('…/') ? CB + pathM[1].slice(2) : pathM[1]);
  tableRows++;
  if (!existsSync(file)) { eq(`§7 table file exists: ${file}`, false, true); continue; }
  eq(`§7 table bytes for ${file}`, sizeOf(file), Number(bytesM[1].replace(/,/g, '')));
  eq(`§7 table sha for ${file}`, shaOf(file).slice(0, 16), shaM[1]);
}
eq('§7 table parsed enough rows to be worth checking', tableRows >= 8, true);

// Row 5 of that table ("the bytes the page actually hashed") is not a disk path -- it is what the
// browser fetched, so it has to agree with both the served capture and the file on disk.
const NP = JSON.parse(readFileSync('captures/nifti_page.json', 'utf8'));
const R = NP.out.res;
eq('§7 the page hashed the packet that is on disk',
  [R.asset.bytes, R.asset.sha256], [sizeOf(PACKET), shaOf(PACKET).slice(0, 32)]);
// The capture pins the code it ran, the same way §1's captures do.
eq('§7 capture pins probe-nifti.js', [NP.out.probeSha256, NP.out.probeBytes],
  [shaOf('tools/probe-nifti.js').slice(0, 32), sizeOf('tools/probe-nifti.js')]);
eq('§7 capture pins probe-nifti-launch.js', [NP.launcherSha256, NP.launcherBytes],
  [shaOf('tools/probe-nifti-launch.js').slice(0, 32), sizeOf('tools/probe-nifti-launch.js')]);
// An artefact name that cites someone else's digest is worse than no name: it misleads the next audit.
const shot = 'captures/sceneB_nifti_118058fc_640x397.png';
eq('§7 screenshot name carries the packet digest it depicts',
  shot.match(/nifti_([0-9a-f]{8})_/)[1], shaOf(PACKET).slice(0, 8));

// The manifest is the pipeline's own claim about its output; re-derive it rather than trusting it.
const MAN = JSON.parse(readFileSync(CB + 'web_assets/labels_manifest.json', 'utf8'));
eq('§7 manifest still describes the PLY',
  [MAN.n_splats, MAN.ply_bytes, MAN.ply_sha256],
  [R.after.splats, sizeOf(PLY), shaOf(PLY)]);
eq('§7 label bins still row-aligned',
  [sizeOf(CB + 'web_assets/fdi_labels.bin'), sizeOf(CB + 'web_assets/layer_labels.bin')],
  [R.after.splats, R.after.splats]);

// The prose numbers, re-derived from the capture and then required verbatim in the document.
const says = (s) => eq(`§7 doc states "${s}"`, sec.includes(s), true);
eq('§7 container shape', [R.after.splats, R.after.stride, R.after.hasSH1, R.after.scaleMm[0]],
  [87405, 20, false, 0.6]);
says('87,405 splats, stride 20');
eq('§7 distinct ids and colours', [R.container.distinct_fdi, R.container.distinct_colors], [32, 542]);
says('542 distinct colours');
says('32 distinct FDI ids');
const hist = Object.fromEntries(Object.entries(R.container.layer_hist)
  .map(([k, v]) => [k.split(':')[0], v]));
eq('§7 layer hist', hist, { 1: 16064, 3: 59316, 4: 1293, 6: 2276, 7: 8074, 8: 382 });
says('1:16064 · 3:59316 · 4:1293 · 6:2276 · 7:8074 · 8:382');
const lit = Object.fromEntries(Object.entries(R.byLayer).map(([k, v]) => [k.split(':')[0], v.lit]));
eq('§7 every layer paints alone', lit, { 1: 6423, 3: 10579, 4: 760, 6: 3404, 7: 1271, 8: 408 });
says('enamel 6,423 px, alveolar 10,579, nerve 760, pulp 3,404, sinus 1,271, restoration 408');
eq('§7 no glError, one draw call per layer',
  Object.values(R.byLayer).every((v) => v.glError === 0 && v.drawn.calls === 1), true);
eq('§7 row arithmetic is self-consistent', [
  R.orientation.meanRow.nerve < 174 / 2, R.orientation.halves.nerve[1],
  R.orientation.meanRow.sinus > 174 / 2, R.orientation.halves.sinus[0],
  R.orientation.buf.h], [true, 0, true, 0, 174]);
says('row 55.9 (span 40–82');
says('120.8 (span 107–134');
eq('§7 all five container checks true', Object.values(R.container.checks).filter(Boolean).length, 5);
eq('§7 no pruned twin for this route', R.after.altSplats, R.after.splats);
says('altSplats == splats == 87,405');
says('46/46');
says('23/23');
says('33,785 splats');
// §9 disclaims throughput; §7 is allowed exactly one number that looks like a timing, and it is a load
// measurement the capture actually reports -- so pin it, and still fail if a frame claim sneaks in. The
// scope is `sec` (all of §7, none of §8), which is why the section boundaries above are asserted.
eq('§7 takes no throughput claim', /sortMs|\bfps\b/.test(sec), false);
eq('§7 load figure matches the capture', R.loadMs, 134.2);
says('134.2 ms');
says('no throughput claim comes from this capture');

// ---------------------------------------------------------------- the one-page Brief (brief/technical-brief.html)
// The PDF the lab gets is rendered from this HTML, so it is held to the same standard as the markdown:
// every figure in it must exist in the artefacts. Tags are stripped first because the numbers sit inside
// <b>/<code> spans, and whitespace is collapsed so line wrapping in the source cannot hide a mismatch.
// BRIEF_DOC is the hook mutate-claims-test.mjs uses to prove this block can fail without touching the real file.
const BRIEF = readFileSync(process.env.BRIEF_DOC || 'brief/technical-brief.html', 'utf8').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const briefSays = (s) => eq(`brief states "${s}"`, BRIEF.includes(s), true);
const A_full = rep.sceneA_ios.full, A_p = rep.sceneA_ios.pruned;
const B_full = rep.sceneB_cbct.full, B_p = rep.sceneB_cbct.pruned;
// (A and B higher up are the *perf captures*; the ratios live in report.json -- do not conflate them.)
const ratioA = rep.sceneA_ios.bytes_ratio, ratioB = rep.sceneB_cbct.bytes_ratio;
briefSays(`${A_full.bytes.toLocaleString('en-US')} → ${A_p.bytes.toLocaleString('en-US')} B（${ratioA.toFixed(2)}×）`);
briefSays(`${B_full.bytes.toLocaleString('en-US')} → ${B_p.bytes.toLocaleString('en-US')} B（${ratioB.toFixed(2)}×）`);
briefSays(`${A_full.splats.toLocaleString('en-US')} → ${A_p.splats.toLocaleString('en-US')}`);
briefSays(`${B_full.splats.toLocaleString('en-US')} → ${B_p.splats.toLocaleString('en-US')}`);
briefSays(`${bAreal.psnr.toFixed(2)} / ${bAreal.psnrInMask.toFixed(2)} dB`);
// The naive-vs-compensated row was removed from the brief with the synthetic asset it described.
briefSays(`${bB.psnr.toFixed(2)} / ${bB.psnrInMask.toFixed(2)} dB`);
const gA = Object.values(rep.sceneA_ios.compression_fidelity_mm), gB = Object.values(rep.sceneB_cbct.compression_fidelity_mm);
briefSays(`${gA[0]} / ${gA[1]} / ${gA[2]} mm`);
briefSays(`${gB[0]} / ${gB[1]} / ${gB[2]} mm`);
briefSays(`${R.after.splats.toLocaleString('en-US')} splats / ${R.after.scaleMm[0]} mm`);
briefSays(sizeOf(PACKET).toLocaleString('en-US') + ' B');
briefSays(shaOf(PACKET).slice(0, 8));
briefSays(`${R.loadMs} ms`);
// Claims the brief must NOT make, because there is no artefact behind them yet.
const forbidden = ['临床验证通过', 'diagnostic accuracy', '真实患者数据', '低端显卡实测', '138 项 ok'];
eq('brief makes no unbacked claim', forbidden.filter((s) => BRIEF.includes(s)), []);
eq('brief still carries the synthetic badge', /SYNTHETIC PREVIEW/.test(BRIEF), true);
eq('brief points at MEASUREMENTS.md for provenance', /MEASUREMENTS\.md/.test(BRIEF), true);
// The verified object is the HTML, but the thing people read is the PDF made from it -- so if a rendered
// copy sits in the usual delivery folder, it must not be older than the source it is supposed to show.
const PDF = join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads',
  'DentSplat-Technical-Brief-20261125.pdf');
if (existsSync(PDF)) {
  eq('the rendered PDF is not older than the brief source',
    statSync(PDF).mtimeMs >= statSync('brief/technical-brief.html').mtimeMs, true);
} else {
  console.log(`note : no rendered PDF at ${PDF} -- run \`npm run brief\` before sending it`);
}

// ---------------------------------------------------------------- the 60-second walkthrough (brief/demo/)
// A video is the deliverable most likely to be watched and least likely to be re-read, so the two things
// burned into it -- the caption on each clip and the numbers on the end card -- get the same treatment as
// the brief. Plus one check the brief does not need: every frame must be the render its manifest names,
// because a walkthrough assembled from a screenshot nobody can trace back to a run is the exact failure
// mode the audit work argues against. DEMO_MANIFEST / DEMO_END_DOC are the mutation-test hooks.
const FRAMES = JSON.parse(readFileSync(process.env.DEMO_MANIFEST || 'brief/demo/frames.json', 'utf8'));
const demoLen = [FRAMES.title.secs, ...FRAMES.clips.map((c) => c.secs), FRAMES.end.secs]
  .reduce((a, b) => a + b, 0);
eq('demo walkthrough length', demoLen, 60);
eq('demo walkthrough frames at its own fps', demoLen * FRAMES.fps, 1500);
eq('demo clips are the renders their manifest pins',
  FRAMES.clips.map((c) => (existsSync(c.png) ? shaOf(c.png).slice(0, 16) : 'MISSING')),
  FRAMES.clips.map((c) => c.sha));
// The two surfaces are checked separately on purpose. Concatenating them would let a wrong number in a
// burned-in caption pass because the same number also appears on the end card -- which is exactly how the
// first version of this block survived a mutation test.
const flat = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const CAPS = flat(FRAMES.clips.map((c) => `${c.caption} ${c.sub}`).join(' | '));
const CARD = flat(readFileSync(process.env.DEMO_END_DOC || 'brief/demo/end-card.html', 'utf8'));
const capSays = (s) => eq(`demo caption "${s}"`, CAPS.includes(s), true);
const cardSays = (s) => eq(`demo end card "${s}"`, CARD.includes(s), true);
const DEMO = `${CAPS} ${CARD}`;
capSays('88,918 splats');   // the walkthrough's own build; report.json now describes the real scan
// "2.58 MB" on the caption is decimal MB of the retired packet (2,582,852 B), the way file sizes are
// quoted to a viewer; the 2.46 MiB reading would be the wrong number to derive.
capSays('2.58 MB');
// The walkthrough predates the asset swap and still shows the synthetic build; its captions are
// checked against that build's capture, not against the current one.
// The walkthrough was cut before the asset swap, so its numbers are pinned to the synthetic build
// explicitly instead of following report.json.
const ratioA_video = 4.24, gA_video = [0.314, 0.691, 4.796];
const ratioB_video = 3.43, gB_video = [0.349, 0.946, 1.297];
capSays(`${ratioA_video}× 体积 · 整帧 ${bA.psnr.toFixed(2)} dB / 掩膜内 ${bA.psnrInMask.toFixed(2)} dB`);
capSays(`覆盖间隙 ${gB_video[1]} mm`);
capSays(`${R.after.splats.toLocaleString('en-US')} splats`);
cardSays(`${ratioA_video}× / ${ratioB_video}×`);
cardSays(`${bA.psnr.toFixed(2)} / ${bA.psnrInMask.toFixed(2)} dB`);
// The end card belongs to the walkthrough's build (pre-fix renderer), so it is pinned rather than
// following bench-B-final.json.
cardSays('25.10 / 22.03 dB');
cardSays(`+${(bA.psnr - bNaive.psnr).toFixed(2)} / +${(bA.psnrInMask - bNaive.psnrInMask).toFixed(2)} dB`);
cardSays(`${gA_video[0]} / ${gA_video[1]} mm`);
cardSays(`${gB_video[0]} / ${gB_video[1]} mm`);
const nets = [A, Ap, B, Bp].flatMap((p) => p.perf.map((r) => r.netGpuMs));
cardSays(`${Math.min(...nets).toFixed(1)}–${Math.max(...nets).toFixed(1)} ms`);
cardSays(`${naiveDeficitPct}% → ${compDeficitPct}%`);
// "46 项断言" is a claim about the test suite rather than a measurement, so it is checked against the
// document that records the suite's result instead of against a capture.
eq('demo echoes the assertion count §7 records', [sec.includes('46/46'), DEMO.includes('46 项断言')], [true, true]);
eq('demo end card makes no unbacked claim', forbidden.filter((s) => DEMO.includes(s)), []);
eq('demo end card keeps the not-measured column', DEMO.includes('尚未测量'), true);
eq('demo title card states the frames are renders, not a screen recording',
  readFileSync(process.env.DEMO_TITLE_DOC || 'brief/demo/title-card.html', 'utf8').includes('非实时录屏'), true);
// The video itself, when it has been cut: the manifest's own arithmetic, re-derived from the delivered file.
const VIDEO = join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads',
  'DentSplat-demo-60s-20261125.mp4');
if (existsSync(VIDEO)) {
  eq('the delivered walkthrough is not older than its manifest',
    statSync(VIDEO).mtimeMs >= statSync('brief/demo/frames.json').mtimeMs, true);
  eq('the walkthrough has its provenance file beside it', existsSync(`${VIDEO}.PROVENANCE.md`), true);
} else {
  console.log(`note : no walkthrough at ${VIDEO} -- run \`npm run demo\` before sending it`);
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}`
  : '\nall MEASUREMENTS.md, brief/ and demo/ claims re-derived from the captures');

process.exit(fails.length ? 1 : 0);
