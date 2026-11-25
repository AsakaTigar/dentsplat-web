/**
 * brief/build-pdf.selftest.mjs — the negative control for the one-page gate.
 *
 * build-pdf.mjs fails when the brief overflows; a check nobody has seen fire is not a check. So this
 * renders two PDFs into tools/out: the real brief (must be 1 page, exit 0) and the same HTML with a
 * 300 mm filler block before </body> (must be >1 page, exit 1). If the second one comes back "ok",
 * the page counter is reading something that is not the page tree.
 *
 *   node brief/build-pdf.selftest.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tmp = join(root, 'tools', 'out', 'brief-selftest');
mkdirSync(tmp, { recursive: true });

const html = readFileSync(join(here, 'technical-brief.html'), 'utf8');
const tall = join(tmp, 'overflow.html');
writeFileSync(tall, html.replace('</body>', '<div style="height:300mm"></div></body>'), 'utf8');

const run = (src, out) => spawnSync(process.execPath,
  [join(here, 'build-pdf.mjs'), '--html', src, '--out', out], { cwd: root, encoding: 'utf8' });

const good = run(join(here, 'technical-brief.html'), join(tmp, 'brief.pdf'));
const bad = run(tall, join(tmp, 'overflow.pdf'));

const pages = (s) => Math.max(...[...s.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => +m[1]));
const lines = (r) => r.stdout.split(/\r?\n/).filter((l) => /^(pages|ok|FAIL|note)/.test(l)).join(' | ');

let fails = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' != ' + JSON.stringify(want)}`);
  if (!ok) fails++;
};

eq('real brief exits 0', good.status, 0);
eq('real brief is one page', pages(readFileSync(join(tmp, 'brief.pdf'))), 1);
eq('overflowing brief exits non-zero', bad.status, 1);
eq('overflow really produced extra pages', pages(readFileSync(join(tmp, 'overflow.pdf'))) > 1, true);
console.log('   brief    : ' + lines(good));
console.log('   overflow : ' + lines(bad));
console.log(fails ? `\n${fails} problem(s) with the one-page gate` : '\nthe one-page gate fires when it should and not when it should not');
process.exit(fails ? 1 : 0);
