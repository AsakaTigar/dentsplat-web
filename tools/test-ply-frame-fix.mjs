/** Regression for the COLMAP -> DentSplat frame fix. The oracle is the transform itself:
 *  R_y(-90): (x,y,z) -> (-z,y,x), q' = q_R q, and l=1 (y,z,x) -> (y,x,-z). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'dentsplat-frame-'));
const input = join(dir, 'in.ply'), output = join(dir, 'out.ply');
const props = ['f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`),
  'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'x', 'y', 'z'];
const header = ['ply', 'format binary_little_endian 1.0', 'element vertex 1',
  ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
const body = Buffer.alloc(props.length * 4);
const put = (name, value) => body.writeFloatLE(value, props.indexOf(name) * 4);
put('x', 1); put('y', 2); put('z', 3);
put('rot_0', 1); put('rot_1', 0); put('rot_2', 0); put('rot_3', 0);
put('scale_0', 0.2); put('scale_1', 0.3); put('scale_2', 0.04);
for (let c = 0; c < 3; c++) {
  put(`f_rest_${c * 3}`, 1); put(`f_rest_${c * 3 + 1}`, 2); put(`f_rest_${c * 3 + 2}`, 3);
}
writeFileSync(input, Buffer.concat([Buffer.from(header), body]));
try {
  execFileSync(process.execPath, [join(root, 'tools', 'ply-frame-fix.mjs'), '--in', input, '--out', output]);
  const got = readFileSync(output);
  const start = got.indexOf('end_header\n') + 'end_header\n'.length;
  const get = (name) => got.readFloatLE(start + props.indexOf(name) * 4);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const s = Math.SQRT1_2;
  const checks = [
    ['position', near(get('x'), -3) && near(get('y'), 2) && near(get('z'), 1)],
    ['quaternion', near(get('rot_0'), s) && near(get('rot_1'), 0) && near(get('rot_2'), -s) && near(get('rot_3'), 0)],
    ['scale unchanged', near(get('scale_0'), 0.2) && near(get('scale_1'), 0.3) && near(get('scale_2'), 0.04)],
    ['SH1 mapping', [0, 1, 2].every((c) => near(get(`f_rest_${c * 3}`), 1)
      && near(get(`f_rest_${c * 3 + 1}`), 3) && near(get(`f_rest_${c * 3 + 2}`), -2))],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
