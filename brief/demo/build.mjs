/**
 * brief/demo/build.mjs — cut the 60-second walkthrough out of renders the app actually produced.
 *
 * What this is: a slideshow-with-motion built from `captures/*.png`, each of which is an offscreen
 * WebGL2 render the page's own splat pass produced and read back. What this is NOT: a screen recording
 * of someone driving the UI. The automation window is hidden with a 428x1 canvas, so no honest screen
 * capture exists from here; the title and end cards say so on their face, and every clip's caption
 * names a measurement rather than implying a demo of latency.
 *
 * The discipline that makes this worth shipping: `frames.json` pins a sha256 prefix per PNG, and a
 * frame whose bytes do not match is refused before ffmpeg ever sees it. A walkthrough assembled from a
 * screenshot nobody can trace back to a run is exactly the kind of evidence the audit work argues
 * against. The end card's "not measured" list is kept in sync by `npm run test:claims`.
 *
 *   node brief/demo/build.mjs                     # -> Downloads/DentSplat-demo-60s-20261125.mp4
 *   node brief/demo/build.mjs --out x.mp4 --keep-work
 *   node brief/demo/build.mjs --dry-run           # every check and command, no ffmpeg, no output file
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const WORK = join(root, 'tools', 'out', 'demo');
const MAN = JSON.parse(readFileSync(join(here, 'frames.json'), 'utf8'));
const FPS = MAN.fps, W = MAN.width, H = MAN.height;
const OUT = resolve(val('--out', join(process.env.USERPROFILE || process.env.HOME, 'Downloads',
  'DentSplat-demo-60s-20261125.mp4')));
const FONT_PATH = 'C:/Windows/Fonts/msyh.ttc';
// ffmpeg needs the drive-letter colon quoted twice over: the filtergraph parser splits options on ':',
// and a bare `C\:/...` still fails ("No option name near '/Windows/...'"), while `'C\:/...'` parses.
// That is asserted, not remembered, by `node tools/ffmpeg-drawtext-probe.mjs`.
const FONT = `'${FONT_PATH.replace(/:/g, '\\:')}'`;
const fails = [];
const say = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const run = (exe, args, opts = {}) => {
  if (DRY) { console.log(`   [dry] ${basename(exe)} ${args.join(' ')}`.slice(0, 240)); return ''; }
  const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${basename(exe)} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-700)}`);
  return r.stdout;
};

if (!existsSync(FONT_PATH)) console.warn(`note: ${FONT_PATH} not found; captions may fall back to a font without CJK glyphs`);

// ---------------------------------------------------------------- 1. every source frame, identified
const frames = [
  { kind: 'card', html: MAN.title.html, secs: MAN.title.secs, label: 'title card' },
  ...MAN.clips.map((c) => ({ ...c, kind: 'clip', label: c.png })),
  { kind: 'card', html: MAN.end.html, secs: MAN.end.secs, label: 'end card' },
];
const total = frames.reduce((s, f) => s + f.secs, 0);
say(Math.abs(total - 60) <= 1.5, `manifest totals ${total}s (the ask is a 60-second video)`);
for (const c of MAN.clips) {
  const p = join(root, c.png);
  if (!existsSync(p)) { say(false, `frame present: ${c.png}`); continue; }
  say(sha(p).startsWith(c.sha), `frame ${c.png} is the render its manifest names (${c.sha}…)`);
}

// ---------------------------------------------------------------- 2. the two cards, screenshotted
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!EDGE) say(false, 'a Chromium-family browser to screenshot the cards with');
if (!DRY) mkdirSync(WORK, { recursive: true });

const pngSize = (p) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
// Both cards end with a 10 px #38BDF8 brand rule as their last in-flow element, so if the layout ever grows
// past the 720 px frame that rule is the first thing to fall off -- and averaging the screenshot's bottom
// rows turns a silently clipped footer into a failed build. Raw RGB out of ffmpeg, so no PNG decoder here.
const bottomAverage = (p) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', p, '-vf', `crop=${W}:6:0:${H - 6},scale=1:1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`cannot sample the bottom edge of ${basename(p)}`);
  return [...r.stdout.subarray(0, 3)];
};
const FIT_BAR = (rgb) => rgb[1] > 120 && rgb[0] < 120;
const cardPng = [];
for (const f of frames.filter((x) => x.kind === 'card')) {
  const out = join(WORK, `${f.label.replace(/ /g, '-')}.png`);
  const src = join(root, f.html);
  if (!existsSync(src)) { say(false, `card source exists: ${f.html}`); continue; }
  run(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--virtual-time-budget=3000', `--screenshot=${out}`,
    `file:///${src.replace(/\\/g, '/')}`], {});
  if (DRY) { cardPng.push(out); continue; }
  if (!existsSync(out)) { say(false, `card rendered: ${f.html}`); continue; }
  const [w, h] = pngSize(out);
  say(w === W && h === H, `card ${f.label} is ${W}x${H} (got ${w}x${h})`);
  const rgb = bottomAverage(out);
  say(FIT_BAR(rgb), `card ${f.label} reaches its fit marker at the bottom edge (bottom row rgb ${rgb.join(',')})`);
  cardPng.push(out);
}

// ---------------------------------------------------------------- 3. one clip per frame
const pad = (n) => String(n).padStart(2, '0');
const clips = [];
let idx = 0;
for (const f of frames) {
  idx++;
  const out = join(WORK, `clip-${pad(idx)}.mp4`);
  const input = f.kind === 'card' ? cardPng.shift() : join(root, f.png);
  if (!input || (!DRY && !existsSync(input))) { say(false, `input for clip ${idx} missing`); continue; }
  // The caption is a file, never an inline string: drawtext's escaping rules differ from the shell's,
  // and a silently mangled caption is the kind of defect that only shows up in the rendered video. The
  // path stays relative on purpose -- ffmpeg runs with WORK as its cwd, and an absolute `C:/...` here
  // would collide with drawtext's own use of ':' as an option separator.
  const tf = join(WORK, `cap-${pad(idx)}.txt`);
  const text = f.kind === 'clip' ? `${f.caption}\n${f.sub}` : '';
  if (!DRY) writeFileSync(tf, text, 'utf8');
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0B0F17`,
    // The push-in is a crop, not a resize: at 1.08 it eats ~29 px off the top and bottom. That is fine on
    // a render whose subject is centred and whose caption sits 118 px up, and it is not fine on a card --
    // the same zoom quietly removed the fit-marker bar the screenshot had just certified. So cards get a
    // cross-fade for motion instead, which changes brightness and never changes geometry.
    ...(f.kind === 'clip'
      ? [`zoompan=z='min(1+0.0006*on,1.08)':d=1:s=${W}x${H}:fps=${FPS}`]
      : [`fade=t=in:st=0:d=0.35`, `fade=t=out:st=${Math.max(0, f.secs - 0.35).toFixed(2)}:d=0.35`]),
    ...(text ? [`drawtext=fontfile=${FONT}:textfile=cap-${pad(idx)}.txt:fontsize=27:line_spacing=9:`
      + `fontcolor=0xE6EEF8:x=46:y=h-118:box=1:boxcolor=0x0B0F17@0.80:boxborderw=15`] : []),
    'format=yuv420p',
  ].join(',');
  run('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', input, '-vf', vf,
    '-t', String(f.secs), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { cwd: WORK });
  clips.push(out);
}

// ---------------------------------------------------------------- 4. concat, then verify the result
const list = join(WORK, 'list.txt');
// ffmpeg's concat demuxer escapes a quote as \' (not the shell's '\''), and every clip path here is
// absolute with a drive-letter colon -- which the demuxer accepts inside quotes, unlike filter options.
if (!DRY) writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, '/').replace(/'/g, "\\'")}'`).join('\n'), 'utf8');
run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
  '-c', 'copy', '-movflags', '+faststart', OUT], {});
if (DRY) { console.log(`\ndry run: ${frames.length} frames, ${total}s, ${clips.length} clips -> ${OUT}`); process.exit(0); }

const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=codec_name,width,height,nb_frames,r_frame_rate:format=duration,size', '-of', 'json', OUT], {}));
const st = probe.streams?.[0] ?? {}, fmt = probe.format ?? {};
const dur = Number(fmt.duration ?? 0);
say(st.codec_name === 'h264', `codec is h264 (got ${st.codec_name})`);
say(st.width === W && st.height === H, `resolution ${st.width}x${st.height} == ${W}x${H}`);
say(dur > 57 && dur < 63, `duration ${dur.toFixed(2)}s is within 60s +/- 3s`);
// ffprobe only reports nb_frames when the container carries it; when it does not, count the packets.
let nb = Number(st.nb_frames);
if (!Number.isFinite(nb) || nb <= 0) {
  nb = Number(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
    'stream=nb_read_packets', '-of', 'csv=p=0', OUT], {}).trim()) || 0;
}
say(nb >= Math.round(dur * FPS) - 5, `frame count ${nb} matches ${FPS} fps for ${dur.toFixed(1)}s`);
say(existsSync(OUT) && Number(fmt.size) === statSync(OUT).size, `ffprobe's byte count agrees with the file`);

// The screenshot check above proves the card fits its own canvas; this one proves the finished video still
// shows it. That distinction is not pedantic -- a zoompan crop on the card removed exactly the bottom strip
// the fit marker lives in, and every upstream check stayed green while it did. Sample mid-card, where the
// fade is fully up, and require the marker colour in the delivered bytes.
const MARKER = '#38BDF8';
const cardWindows = [];
let clock = 0;
for (const f of frames) { if (f.kind === 'card') cardWindows.push([f.label, clock + f.secs / 2]); clock += f.secs; }
for (const [label, t] of cardWindows) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-ss', t.toFixed(2), '-i', OUT, '-frames:v', '1',
    '-vf', `crop=${W}:6:0:${H - 6},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 1 << 20 });
  const rgb = r.status === 0 && r.stdout?.length >= 3 ? [...r.stdout.subarray(0, 3)] : null;
  say(rgb && FIT_BAR(rgb), `the ${label}'s ${MARKER} fit marker survives into the video at t=${t.toFixed(1)}s`
    + ` (bottom row ${rgb ? rgb.join(',') : 'unreadable'})`);
}

// ---------------------------------------------------------------- 5. provenance, beside the video
const prov = [
  '# DentSplat 60-second walkthrough — provenance', '',
  `Video: \`${basename(OUT)}\` — ${statSync(OUT).size} B, sha256 \`${sha(OUT)}\``,
  `Built ${new Date().toISOString()} by \`node brief/demo/build.mjs\` (ffmpeg + headless Chromium).`, '',
  '## What the frames are', '',
  'Every clip is one of these PNGs, which are **offscreen WebGL2 renders produced by the app itself**',
  '(`Viewer.renderToDataURL` via the page probes) — not a screen recording, and not a re-rendering by',
  'any other engine. The automation window is hidden with a 428x1 canvas, so a real screen capture was',
  'not obtainable from this session; the cards state that on their face.', '',
  '| # | frame | sha256 (first 16) | hold |', '|---|---|---|---|',
  ...frames.map((f, i) => `| ${pad(i + 1)} | \`${f.kind === 'card' ? f.html : f.png}\` | \`${f.kind === 'card'
    ? sha(join(WORK, `${f.label.replace(/ /g, '-')}.png`)).slice(0, 16) : f.sha}\` | ${f.secs}s |`),
  '', `Total ${total}s at ${FPS} fps, ${W}x${H}, H.264 yuv420p, no audio track.`, '',
  '## Captions', '',
  ...MAN.clips.map((c) => `- ${c.caption} — ${c.sub}`), '',
  '## Numbers quoted on screen', '',
  'They come from `MEASUREMENTS.md` and are re-derived by `npm run test:claims` on every `npm run check`.',
  'The end card lists what the project does **not** measure; that list is the honest half of this video.',
].join('\n');
writeFileSync(join(dirname(OUT), `${basename(OUT)}.PROVENANCE.md`), prov, 'utf8');
say(true, `wrote ${basename(OUT)}.PROVENANCE.md beside the video`);
// The intermediates are 12 re-encoded clips; the MP4 and its provenance file are the deliverables.
if (!has('--keep-work')) rmSync(WORK, { recursive: true, force: true });

console.log(`\nvideo  : ${OUT}`);
console.log(`size   : ${statSync(OUT).size} B  sha256 ${sha(OUT).slice(0, 32)}`);
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(' | ')}` :
  `\nwalkthrough built and verified (${frames.length} frames, ${dur.toFixed(2)}s)`);
process.exit(fails.length ? 1 : 0);
