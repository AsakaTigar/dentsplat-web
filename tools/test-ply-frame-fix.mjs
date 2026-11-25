/** Regression for the COLMAP -> DentSplat frame fix. The oracle is the transform itself, not a
 *  hand-written expectation: R_y(-90): (x,y,z) -> (-z,y,x), q' = q_R q, and the l=1 colour field
 *  the shader evaluates -- dot((-d.y, d.z, -d.x), (c0, c1, c2)) -- must be unchanged when the
 *  scene and the view direction are rotated together. That pins (c0,c1,c2) -> (c0,-c2,c1). */
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
  // Same formula as src/engine/shaders.ts: dir = (-d.y, d.z, -d.x), colour = dot(dir, c).
  const evalSH = (c, d) => -c[0] * d[1] + c[1] * d[2] - c[2] * d[0];
  const rotateDir = (d) => [-d[2], d[1], d[0]];   // R_y(-90) applied to the view direction
  const dirs = [[0.3, -0.7, 0.64], [-0.8, 0.1, 0.59], [0.55, 0.83, -0.1], [0, 0, 1], [1, 0, 0]];
  const shOk = [0, 1, 2].every((c) => {
    const cin = [1, 2, 3];
    const cout = [get(`f_rest_${c * 3}`), get(`f_rest_${c * 3 + 1}`), get(`f_rest_${c * 3 + 2}`)];
    return dirs.every((d) => Math.abs(evalSH(cout, rotateDir(d)) - evalSH(cin, d)) < 1e-5);
  });
  const checks = [
    ['position', near(get('x'), -3) && near(get('y'), 2) && near(get('z'), 1)],
    ['quaternion', near(get('rot_0'), s) && near(get('rot_1'), 0) && near(get('rot_2'), -s) && near(get('rot_3'), 0)],
    ['scale unchanged', near(get('scale_0'), 0.2) && near(get('scale_1'), 0.3) && near(get('scale_2'), 0.04)],
    ['SH1 field invariant under the rotation', shOk],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
