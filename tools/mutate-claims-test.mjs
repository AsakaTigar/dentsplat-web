/**
 * tools/mutate-claims-test.mjs — prove tools/verify-claims.mjs's gates can actually fail.
 *
 * A doc-vs-artefact check that never fires is decoration, so each mutation below breaks exactly one
 * cited value in a throwaway copy of the document that cites it -- MEASUREMENTS.md, the brief HTML, the
 * walkthrough's frames.json and its two cards (the *_DOC hooks make that possible without touching the
 * real files) -- and asserts the verifier (a) exits non-zero and (b) names the row it caught -- not just
 * "something failed". A mutation that produces a pass, or a failure that points at the wrong check,
 * means the gate is not watching what it claims to watch.
 *
 *   node tools/mutate-claims-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SRC = path.join(root, 'MEASUREMENTS.md');
const TMP = path.join(here, 'out', 'mutate-claims');
mkdirSync(TMP, { recursive: true });

// Each case names which document to mutate (see the DOCS table below for the keys: 'meas', 'brief', and
// the three surfaces of the walkthrough), the exact phrase to break, and the check name that must
// surface. The §7 row needles are whole-cell triples on purpose: the packet's sha and byte count also
// appear in the "bytes the page hashed" row, and a needle that matches twice is not a single-row test.
// The 0.946 mm case is deliberately a number that also sits on the end card -- it only fails if the
// verifier reads the caption surface separately from the card surface.
const DSPK_ROW = '`…/sceneB_from_nifti.dspk` | 1,748,976 | `118058fc20aaec00`';
const cases = [
  { doc: 'meas', label: 'packet sha, last hex digit', from: DSPK_ROW,
    to: '`…/sceneB_from_nifti.dspk` | 1,748,976 | `118058fc20aaec01`',
    want: 'sha for tools/out/cbct_route/sceneB_from_nifti.dspk' },
  { doc: 'meas', label: 'packet byte count', from: DSPK_ROW,
    to: '`…/sceneB_from_nifti.dspk` | 1,749,018 | `118058fc20aaec00`',
    want: 'bytes for tools/out/cbct_route/sceneB_from_nifti.dspk' },
  { doc: 'meas', label: 'a probe digest the capture pins', from: '`1bd02bda25db5dea`', to: '`1bd02bda25db5deb`',
    want: 'sha for tools/probe-nifti.js' },
  { doc: 'meas', label: 'the restoration pixel count', from: 'restoration 408', to: 'restoration 488',
    want: '§7 doc states "enamel 6,423' },
  { doc: 'meas', label: 'the layer histogram', from: '3:59316', to: '3:59317',
    want: '§7 doc states "1:16064' },
  { doc: 'meas', label: 'the screenshot name', from: 'sceneB_nifti_118058fc_640x397.png',
    to: 'sceneB_nifti_deadbeef_640x397.png', want: 'table file exists' },
  { doc: 'meas', label: 'the load figure', from: '134.2 ms', to: '124.2 ms',
    want: '§7 doc states "134.2 ms"' },
  { doc: 'brief', label: 'brief pruned-byte count', from: '204,174 B（<b>5.86×</b>）', to: '204,175 B（<b>5.86×</b>）',
    want: 'brief states "1,196,970 → 204,174 B（5.86×）' },
  { doc: 'brief', label: 'brief compression ratio', from: '（<b>5.86×</b>）', to: '（<b>5.85×</b>）',
    want: 'brief states "1,196,970 → 204,174 B（5.86×）' },
  { doc: 'brief', label: 'brief PSNR pair', from: '24.25 / 24.12 dB', to: '24.25 / 24.13 dB',
    want: 'brief states "24.25 / 24.12 dB"' },
  { doc: 'brief', label: 'brief coverage-gap triple', from: '0.701 / <b>1.342</b> / 2.782 mm',
    to: '0.701 / <b>1.324</b> / 2.782 mm', want: 'brief states "0.701 / 1.342 / 2.782 mm"' },
  { doc: 'brief', label: 'brief drops the synthetic badge', from: 'SYNTHETIC PREVIEW', to: 'PRODUCTION READY',
    want: 'brief still carries the synthetic badge' },
  { doc: 'demoMan', label: 'a caption gap the walkthrough burns in', from: '覆盖间隙 0.946 mm',
    to: '覆盖间隙 0.947 mm', want: 'demo caption "覆盖间隙 0.946 mm"' },
  { doc: 'demoMan', label: 'a frame sha the manifest overstates', from: '11eaaba88705df44', to: '11eaaba88705df45',
    want: 'demo clips are the renders their manifest pins' },
  { doc: 'demoMan', label: 'a hold that no longer adds up to 60 s', from: '"secs": 4', to: '"secs": 5',
    want: 'demo walkthrough length' },
  { doc: 'demoEnd', label: 'end-card compression ratio', from: '4.24× / 3.43×', to: '4.24× / 3.44×',
    want: 'demo end card "4.24× / 3.43×"' },
  { doc: 'demoEnd', label: 'end-card GPU span', from: '0.5–2.9 ms', to: '0.5–3.0 ms',
    want: 'demo end card "0.5–2.9 ms"' },
  { doc: 'demoEnd', label: 'end-card loses its not-measured column', from: '尚未测量', to: '已经确认',
    want: 'demo end card keeps the not-measured column' },
  { doc: 'demoEnd', label: 'end-card claims clinical validation', from: '无任何临床诊断验证', to: '临床验证通过',
    want: 'demo end card makes no unbacked claim' },
  { doc: 'demoTitle', label: 'title card claims live screen capture', from: '非实时录屏', to: '实时录屏',
    want: 'demo title card states the frames are renders' },
  // Section boundaries are read from heading text, so a heading that drifts must be caught by name -- and
  // a frame-rate claim smuggled into §7 must be caught even though §8 is allowed to say "25 fps".
  { doc: 'meas', label: 'a throughput claim inside §7', from: '## 7. The offline CBCT route, executed (Scene B)',
    to: '## 7. The offline CBCT route, executed (Scene B)\n\nThe page held a steady 60 fps while loading.\n',
    want: '§7 takes no throughput claim' },
  { doc: 'meas', label: 'the walkthrough heading drifts out of §8', from: '## 8. The 60-second walkthrough',
    to: '## 8. The one-minute walkthrough', want: 'the walkthrough section is §8' },
];

// Every document the gate reads is listed here, so a new citation surface has to be staged for mutation
// testing at the same time it is added to verify-claims.mjs.
const DOCS = {
  meas: { src: SRC, env: 'MEASUREMENTS_DOC', file: 'doc.md' },
  brief: { src: path.join(root, 'brief', 'technical-brief.html'), env: 'BRIEF_DOC', file: 'brief.html' },
  demoMan: { src: path.join(root, 'brief', 'demo', 'frames.json'), env: 'DEMO_MANIFEST', file: 'frames.json' },
  demoEnd: { src: path.join(root, 'brief', 'demo', 'end-card.html'), env: 'DEMO_END_DOC', file: 'end-card.html' },
  demoTitle: { src: path.join(root, 'brief', 'demo', 'title-card.html'), env: 'DEMO_TITLE_DOC', file: 'title-card.html' },
};
const text = {};
for (const [k, d] of Object.entries(DOCS)) text[k] = readFileSync(d.src, 'utf8');

// All documents are always handed over as copies: leaving one pointed at the real file would make the
// "clean" leg and the mutated leg differ in more than the mutation under test.
const staged = {};
for (const [k, d] of Object.entries(DOCS)) {
  staged[k] = path.join(TMP, d.file);
  writeFileSync(staged[k], text[k], 'utf8');
}
const copies = Object.fromEntries(Object.entries(DOCS).map(([k, d]) => [d.env, staged[k]]));

const runVerify = (overrides) => spawnSync(process.execPath, [path.join(here, 'verify-claims.mjs')],
  { cwd: root, encoding: 'utf8', env: { ...process.env, ...overrides } });

let bad = 0;
for (const c of cases) {
  const src = text[c.doc];
  if (!src.includes(c.from)) {
    console.log(`FAIL ${c.label} -- the phrase to mutate is not in ${c.doc}, so this case tests nothing`);
    bad++; continue;
  }
  if (src.split(c.from).length !== 2) {
    console.log(`FAIL ${c.label} -- "${c.from}" occurs ${src.split(c.from).length - 1}×, so mutating it is not a single-value test`);
    bad++; continue;
  }
  writeFileSync(staged[c.doc], src.replace(c.from, c.to), 'utf8');
  const r = runVerify(copies);
  const out = `${r.stdout}${r.stderr}`;
  const named = out.split('\n').find((l) => l.startsWith('FAIL') && l.includes(c.want));
  const caught = r.status === 1 && !!named;
  console.log(`${caught ? 'ok  ' : 'FAIL'} ${c.label}: exit=${r.status} caught="${(named || out.match(/FAILED: .*/)?.[0] || 'nothing').trim()}"`);
  if (!caught) bad++;
  writeFileSync(staged[c.doc], src, 'utf8');          // restore before the next case
}

// ...and the unmutated copies must still pass, or the harness itself is broken.
const clean = runVerify(copies);
console.log(`${clean.status === 0 ? 'ok  ' : 'FAIL'} unmutated copies pass (exit ${clean.status})`);
if (clean.status !== 0) { console.log(clean.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')); bad++; }

if (!process.env.KEEP_MUT_TMP) rmSync(TMP, { recursive: true, force: true });

console.log(bad ? `\n${bad} mutation(s) slipped past verify-claims.mjs` :
  `\nverify-claims.mjs catches all ${cases.length + 1} mutations, across doc, brief and demo (${cases.length + 1}/${cases.length + 1})`);
process.exit(bad ? 1 : 0);

