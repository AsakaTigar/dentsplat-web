/**
 * brief/demo/card-fit.selftest.mjs — proves the fit-marker check in build.mjs can actually fail.
 *
 * build.mjs refuses a card screenshot whose bottom edge does not show the 10 px marker bar, because a
 * footer pushed below the 720 px fold is otherwise invisible until someone watches the video. That is
 * only a gate if the sample goes the other way when the layout really does overflow -- so here the same
 * screenshot path runs twice: once on the shipped card, once on a copy with a 400 px filler injected.
 * The real card must show the bar, the bloated copy must not, and a build that passes both legs is a
 * broken check, not a lucky one.
 *
 *   node brief/demo/card-fit.selftest.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const W = 1280, H = 720;
const WORK = join(root, 'tools', 'out', 'demo-fit-selftest');
mkdirSync(WORK, { recursive: true });

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!EDGE) { console.error('no Chromium-family browser found to screenshot with'); process.exit(2); }

const shot = (htmlPath, outPng) => {
  const r = spawnSync(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--virtual-time-budget=3000', `--screenshot=${outPng}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(outPng)) throw new Error(`screenshot failed for ${htmlPath}: ${r.status}`);
  return outPng;
};
const bottomAverage = (p) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', p, '-vf', `crop=${W}:6:0:${H - 6},scale=1:1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`cannot sample the bottom edge of ${p}`);
  return [...r.stdout.subarray(0, 3)];
};
const fits = (p) => { const rgb = bottomAverage(p); return [FIT(rgb), rgb.join(',')]; };
const FIT = ([r, g, b]) => g > 120 && r < 120;

let bad = 0;
for (const card of ['title-card.html', 'end-card.html']) {
  const src = readFileSync(join(here, card), 'utf8');
  if (!/fitbar/.test(src)) { console.log(`FAIL ${card} has no .fitbar element -- the gate has nothing to read`); bad++; continue; }

  const ok = shot(join(here, card), join(WORK, `${card}-real.png`));
  const [realPasses, realRgb] = fits(ok);
  console.log(`${realPasses ? 'ok  ' : 'FAIL'} ${card} as shipped shows the fit marker (rgb ${realRgb})`);
  if (!realPasses) bad++;

  const bloated = join(WORK, `${card}-over.html`);
  writeFileSync(bloated, src.replace('</div></body>', '<div style="height:400px;flex:none"></div></div></body>'), 'utf8');
  const clipped = shot(bloated, join(WORK, `${card}-over.png`));
  const [overPasses, overRgb] = fits(clipped);
  console.log(`${!overPasses ? 'ok  ' : 'FAIL'} ${card} + 400px filler hides the fit marker (rgb ${overRgb}) `
    + `-- the check must fire here`);
  if (overPasses) bad++;
}

rmSync(WORK, { recursive: true, force: true });
console.log(bad ? `\n${bad} problem(s): the fit-marker gate is not trustworthy`
  : '\nthe bottom-edge sample distinguishes a fitting card from an overflowing one');
process.exit(bad ? 1 : 0);
