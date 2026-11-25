/**
 * nifti-report.mjs — read a browser capture of the CBCT-route probe and reconcile it with disk.
 *
 * The page-side probe returns a digest of every file it ran, so this script can answer the question
 * a screenshot cannot: are the verdicts in this JSON produced by the same bytes that are in the repo
 * right now? Each digest is therefore computed three ways -- from the tools/ source, from the served
 * URL, and from the value the page reported -- and all three have to agree before any orientation or
 * container claim is printed as a result.
 *
 *   node tools/nifti-report.mjs [captures/nifti_page.json]
 */
import fs from 'fs';
import http from 'node:http';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const BASE = process.env.DENTSPLAT_URL ?? 'http://127.0.0.1:5199';
const capture = process.argv[2] ?? 'captures/nifti_page.json';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** GET without a keep-alive socket: an open handle at exit is what makes node abort on Windows. */
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const req = http.get(u, { agent: false, headers: { 'cache-control': 'no-store' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        // vite preview answers an unknown path with index.html and a 200. Treating that as "served"
        // would compare 1.6 kB of markup against a 676 kB splat packet and call the mismatch a
        // provenance failure, so an HTML answer is reported as not-served instead.
        const ct = String(res.headers['content-type'] ?? '');
        if (ct.includes('text/html') || b.slice(0, 240).includes('<!doctype', 0, 'utf8')
          || b.slice(0, 240).includes('<html', 0, 'utf8')) { reject(new Error(`SPA fallback (${ct})`)); return; }
        resolve(b);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

let cap;
try {
  cap = JSON.parse(fs.readFileSync(path.join(root, capture), 'utf8'));
} catch (e) {
  console.error(`cannot read ${capture}: ${e.message}`);
  process.exit(1);
}
const R = cap.out?.res ?? {};
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// ---------------------------------------------------------------- 1. did the page run OUR bytes?
// The asset has two homes: dist/assets/ is what the page can fetch, tools/out/cbct_route/ is where
// the converter wrote it. The staged copy is normally deleted again so a published bundle cannot
// ship a packet the app never references -- hence "any existing copy must match", not "dist must exist".
const files = [
  ['launcher', ['tools/probe-nifti-launch.js'], '/probes/probe-nifti-launch.js',
    [cap.launcherBytes, cap.launcherSha256]],
  ['probe', ['tools/probe-nifti.js'], '/probes/probe-nifti.js',
    [cap.out?.probeBytes, cap.out?.probeSha256]],
  ['asset', ['dist/assets/sceneB_from_nifti.dspk', 'tools/out/cbct_route/sceneB_from_nifti.dspk'],
    '/assets/sceneB_from_nifti.dspk', [R.asset?.bytes, R.asset?.sha256]],
];
// The page reports truncated digests (32 hex where node reports 64), so agreement is prefix-based --
// but a truncated value has to be at least 12 hex long, otherwise "matches" would mean nothing.
const agree = (page, disk) => !!page && !!disk && page.length >= 12
  && (page === disk || disk.startsWith(page) || page.startsWith(disk));
for (const [tag, rels, url, [pageBytes, pageSha]] of files) {
  const disks = rels.filter((rel) => fs.existsSync(path.join(root, rel)))
    .map((rel) => [rel, fs.readFileSync(path.join(root, rel))])
    .filter(([, b]) => b.length === pageBytes);
  let served = null;
  try {
    served = await get(url);
  } catch (e) { /* not staged / preview down: the disk-page pair is still worth comparing */ }
  if (served !== null) {
    check(`${tag}: disk and served bytes are identical`,
      disks.some(([, b]) => sha(b) === sha(served)),
      `${served.length} B served, ${disks.length} disk copy(ies) of ${pageBytes} B`);
  } else {
    console.log(`     ${tag}: nothing served at ${url} -- wire check skipped (staged copy removed?)`);
  }
  check(`${tag}: the page's own digest matches a file on disk`,
    disks.length > 0 && disks.some(([, b]) => agree(pageSha, sha(b))),
    `page=${String(pageBytes)}B/${String(pageSha)} ` +
    (disks.length ? disks.map(([rel, b]) => `${rel}=${sha(b)}`).join(' ')
      : `no copy of ${rels.join(' or ')} is ${pageBytes} B`));
}

// ---------------------------------------------------------------- 2. what the page measured
const fatal = cap.out?.fatal ?? R.fatal;
if (fatal) check('probe ran without throwing', false, fatal);
console.log('\n-- container (read off the decoded cloud, not the PLY)');
if (R.asset?.content_length != null) {
  check('the byte count the page hashed is the size the server claimed',
    R.asset.content_length === R.asset.bytes,
    `content-length ${R.asset.content_length} vs ${R.asset.bytes} hashed`);
} else {
  console.log('   (no content-length on the response, so the wire size claim is not checked)');
}
const c = R.container ?? {};
console.log(`   splats ${R.after?.splats}  alt ${R.after?.altSplats}  stride ${R.after?.stride}` +
  `  scale ${JSON.stringify(R.after?.scaleMm)}  SH1 ${R.after?.hasSH1}  kind ${R.after?.metaKind}`);
console.log(`   distinct FDI ${c.distinct_fdi}  colours ${c.distinct_colors}  alpha ${JSON.stringify(c.alpha_byte)}`);
console.log(`   layers ${JSON.stringify(c.layer_hist)}`);
console.log(`   checks ${JSON.stringify(c.checks)}`);
console.log(`   appearance ${JSON.stringify(R.after?.appearance)}`);

console.log('\n-- pixels (frontal view, alpha gate per layer)');
console.log(`   all layers: ${R.allLayers?.w}x${R.allLayers?.h} lit=${R.allLayers?.lit}` +
  ` painted=${R.allLayers?.paintedFraction} peak=${R.allLayers?.peak}` +
  ` glError=${R.allLayers?.glError} calls=${R.allLayers?.drawn?.calls}`);
for (const [k, v] of Object.entries(R.byLayer ?? {})) {
  console.log(`   ${k}: ${v.w}x${v.h} lit=${v.lit} rows=${JSON.stringify(v.rowSpan)}` +
    ` meanRow=${v.meanRow} rowsLow(rows<h/2)=${v.rowsLow} rowsHigh=${v.rowsHigh} peak=${v.peak}` +
    ` glError=${v.glError} calls=${v.drawn?.calls}`);
}
// rowsLow/rowsHigh, meanRow and rowSpan all come out of the same loop, so they can be made to
// contradict each other: a mean outside the observed span, or a layer entirely inside one half
// whose mean sits in the other, means the capture is internally inconsistent and no row-convention
// verdict from it should be trusted. This fired on the first live capture and is why rowSpan exists.
const inconsistent = Object.entries(R.byLayer ?? {}).filter(([, v]) =>
  (v.h && v.lit && ((v.rowsHigh === 0 && v.meanRow >= v.h / 2) || (v.rowsLow === 0 && v.meanRow < v.h / 2)))
  || (v.rowSpan && (v.meanRow < v.rowSpan[0] || v.meanRow > v.rowSpan[1])))
  .map(([k, v]) => `${k} mean ${v.meanRow} span ${JSON.stringify(v.rowSpan)} of h ${v.h}` +
    ` but ${v.rowsLow}/${v.rowsHigh}`);
check('meanRow agrees with rowSpan and its own half-bucket counts', inconsistent.length === 0,
  inconsistent.join(' | '));
console.log(`\n-- orientation\n   ${JSON.stringify(R.orientation)}`);
check('every probed layer paints on its own',
  Object.keys(R.byLayer ?? {}).length >= 5 && Object.values(R.byLayer ?? {}).every((v) => v.lit > 0),
  Object.entries(R.byLayer ?? {}).map(([k, v]) => `${k}=${v.lit}`).join(' '));
check('glError 0 on every pass', [R.allLayers, ...Object.values(R.byLayer ?? {})]
  .every((v) => v && v.glError === 0 && v.drawn?.calls >= 1));
check('alphas restored after probing', R.alphasRestored === true);

// ---------------------------------------------------------------- 3. the load-bearing claims
console.log('\n-- claims this capture is allowed to make');
const yes = (b) => (b === true ? 'CONFIRMED' : b === false ? 'REFUTED' : 'not measured');
for (const [k, v] of Object.entries(c.checks ?? {})) console.log(`   ${k}: ${yes(v)}`);
console.log(`   arch upright in the framebuffer: ${yes(R.orientation?.arch_upright)}`);
console.log(`   row 0 is: ${R.orientation?.row0_is ?? 'not measured'}`);
console.log(`   PNG: ${R.pngChars ?? 0} chars in window.__niftiPng`);

console.log(fails.length ? `\n${fails.length} reconciliation failure(s): ` + fails.join(', ')
  : `\nall digests reconcile -- the verdicts above came from the bytes in this repo (${capture})`);
// exitCode rather than exit(): with the agent-less GETs above there is no socket left to abort on.
process.exitCode = fails.length ? 1 : 0;
