// tools/ffmpeg-drawtext-probe.mjs — why brief/demo/build.mjs writes fontfile='C\:/…' and not 'C:/…'.
//
// ffmpeg's filtergraph parser splits options on ':', which collides with a Windows drive letter, and the
// two obvious workarounds behave differently: a bare backslash-escape fails ("No option name near
// '/Windows/…'"), quoting alone fails too, and only `'C\:/path'` parses. That is not worth rediscovering
// mid-render, and it is not worth trusting from a comment either, so this script tries each form against
// the installed binary and reports which ones ffmpeg accepts. Re-run after any ffmpeg upgrade.
//
//   node tools/ffmpeg-drawtext-probe.mjs
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAP = 'probe-caption.txt';                    // relative on purpose: an absolute path is the bug
writeFileSync(`${HERE}/${CAP}`, 'hello 测试 — probe caption', 'utf8');

const variants = {
  'A: no drawtext': 'scale=1280:720,format=yuv420p',
  'B: fontfile backslash-colon': `drawtext=fontfile=C\\:/Windows/Fonts/msyh.ttc:textfile=${CAP}:x=10:y=10`,
  'C: fontfile quoted + escaped': `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile=${CAP}:x=10:y=10`,
  'D: no fontfile': `drawtext=textfile=${CAP}:x=10:y=10`,
  'E: box with @alpha': `drawtext=textfile=${CAP}:box=1:boxcolor=0x0B0F17@0.80:x=10:y=10`,
  'F: zoompan then drawtext': `zoompan=z='min(1+0.0006*on,1.08)':d=1:s=1280x720:fps=25,drawtext=textfile=${CAP}:x=10:y=10`,
  'G: fontfile quoted, bare colon': `drawtext=fontfile='C:/Windows/Fonts/msyh.ttc':textfile=${CAP}:x=10:y=10`,
  'H: the chain build.mjs actually uses': 'scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,'
    + 'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0B0F17,'
    + "zoompan=z='min(1+0.0006*on,1.08)':d=1:s=1280x720:fps=25,"
    + `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile=${CAP}:fontsize=27:line_spacing=9:`
    + 'fontcolor=0xE6EEF8:x=46:y=h-118:box=1:boxcolor=0x0B0F17@0.80:boxborderw=15,format=yuv420p',
};

const ids = Object.keys(variants).map((k) => k[0]);
const results = {};
for (const [k, vf] of Object.entries(variants)) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=black:s=1280x720:d=1', '-vf', vf, '-f', 'null', '-'], { encoding: 'utf8', cwd: HERE });
  results[k[0]] = r.status === 0;
  const detail = r.status ? ['', r.stderr.trim().split('\n').join('\n     ').slice(0, 360)].join('     ') : '';
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${k}${detail}`);
}
rmSync(`${HERE}/${CAP}`, { force: true });

// The expected outcome is specific, not "some pass": every form the demo build depends on must parse, and
// exactly the two wrong workarounds must not. If nothing fails, ffmpeg changed how it quotes; if H fails,
// build.mjs is broken again. Either way this probe -- not a botched render -- is what should say so.
const mustPass = ['A', 'C', 'D', 'E', 'F', 'H'];
const mustFail = ['B', 'G'];
const wrong = [...mustPass.filter((v) => !results[v]), ...mustFail.filter((v) => results[v])];
const acc = ids.filter((v) => results[v]).join('/'), rej = ids.filter((v) => !results[v]).join('/');
console.log(wrong.length ? `\nUNEXPECTED (accepted ${acc}, rejected ${rej}) -- fix brief/demo/build.mjs`
  : `\nas expected: ${acc} accepted, ${rej} rejected -- the quote plus the escape are both required`);
process.exit(wrong.length ? 1 : 0);
