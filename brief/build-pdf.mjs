/**
 * brief/build-pdf.mjs — render the one-page Technical Brief and *prove* it is one page.
 *
 * "One page" is a requirement, not a style note, so it is checked instead of eyeballed: the PDF is
 * printed by headless Edge (the only renderer on this machine that has the CJK fonts the brief needs),
 * then the page tree is counted out of the bytes. HTML printing spills to a second sheet rather than
 * clipping, so /Count 1 is the whole test -- and if a future edit makes the text overflow, this exits
 * non-zero instead of quietly shipping two pages.
 *
 *   node brief/build-pdf.mjs                       # -> Downloads, the usual delivery location
 *   node brief/build-pdf.mjs --out path/to.pdf
 *   node brief/build-pdf.mjs --keep-overflow       # render anyway, report the page count, exit 0
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const htmlI = argv.indexOf('--html');
const html = resolve(htmlI >= 0 ? argv[htmlI + 1] : join(here, 'technical-brief.html'));
const outI = argv.indexOf('--out');
const OUT = outI >= 0 ? resolve(argv[outI + 1])
  : join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'DentSplat-Technical-Brief-20261125.pdf');
const allowOverflow = argv.includes('--keep-overflow');

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error('FATAL: no Edge or Chrome found at ' + CANDIDATES.join(' | ') +
    '\n  The brief is authored as HTML on purpose, but this machine has no other CJK-capable PDF renderer.');
  process.exit(2);
}

// --no-pdf-header-footer keeps the date/page-number furniture out of the artefact; the virtual time
// budget lets font subsetting finish before the print, otherwise the first render ships fallback glyphs.
execFileSync(exe, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
  '--virtual-time-budget=4000', `--print-to-pdf=${OUT}`, `file:///${html.replace(/\\/g, '/')}`,
], { stdio: ['ignore', 'ignore', 'ignore'] });

if (!existsSync(OUT)) { console.error(`FATAL: renderer produced no file at ${OUT}`); process.exit(2); }
const buf = readFileSync(OUT);
const s = buf.toString('latin1');
const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
const objs = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
const pages = counts.length ? Math.max(...counts) : objs;
const sha = createHash('sha256').update(buf).digest('hex');

console.log(`brief  : ${html}`);
console.log(`pdf    : ${OUT}`);
console.log(`size   : ${statSync(OUT).size} B   sha256 ${sha.slice(0, 32)}`);
console.log(`pages  : /Count ${counts.join(', ') || 'n/a'}  /Type /Page objects ${objs}`);

let bad = 0;
if (pages !== 1) {
  console.error(`${allowOverflow ? 'note' : 'FAIL'}: the brief is ${pages} pages, and "one page" is the requirement`);
  if (!allowOverflow) bad++;
} else console.log('ok   : exactly one page');
// A truncated print is the other way this can be wrong: no content stream means the CSS blew up.
if (!/stream/.test(s)) { console.error('FAIL: no content stream in the PDF -- nothing was drawn'); bad++; }

process.exit(bad ? 1 : 0);
