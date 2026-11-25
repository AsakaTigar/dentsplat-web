/**
 * tools/ply-frame-fix.mjs — rotate a Brush/COLMAP 3DGS PLY into the DentSplat viewer frame.
 *
 * The Blender -> COLMAP export keeps COLMAP's world convention; the sampled packets use the
 * project's glTF Y-up rule. Comparing principal axes of the trained model and the sampled Scene A
 * packet shows the trained cloud is the sampled one rotated -90 deg about Y:
 *
 *   x' = -z,  y' = y,  z' =  x        (R_y(-90), det = +1, no mirror)
 *
 * Positions take R; orientations take q' = q_R (x) q with q_R = (s, 0, -s, 0), s = sqrt(1/2).
 * The l=1 band is not rotated here (it is zeroed) — a wrong-direction sheen is worse than none,
 * and the trained colours are dominated by SH0 anyway.
 *
 *   node tools/ply-frame-fix.mjs --in caseA_15000.ply --out caseA_15000_viewer.ply
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), OUT = arg('--out');
if (!IN || !OUT) { console.error('usage: --in a.ply --out b.ply'); process.exit(2); }

const buf = readFileSync(IN);
const text = buf.subarray(0, 8192).toString('latin1');
const marker = 'end_header\n';
const headEnd = text.indexOf(marker) + marker.length;
const n = Number((text.match(/element vertex (\d+)/) || [])[1]);
const props = [...text.matchAll(/^property float (\w+)/gm)].map((m) => m[1]);
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const rec = props.length * 4;
if (buf.length !== headEnd + n * rec) throw new Error('size mismatch');

const out = Buffer.from(buf);
const s = Math.SQRT1_2;
for (let i = 0; i < n; i++) {
  const o = headEnd + i * rec;
  const x = buf.readFloatLE(o + off.x), y = buf.readFloatLE(o + off.y), z = buf.readFloatLE(o + off.z);
  out.writeFloatLE(-z, o + off.x);
  out.writeFloatLE(y, o + off.y);
  out.writeFloatLE(x, o + off.z);
  const w = buf.readFloatLE(o + off.rot_0), qx = buf.readFloatLE(o + off.rot_1);
  const qy = buf.readFloatLE(o + off.rot_2), qz = buf.readFloatLE(o + off.rot_3);
  const nw = s * (w + qy), nx = s * (qx - qz), ny = s * (qy - w), nz = s * (qz + qx);
  const ln = Math.hypot(nw, nx, ny, nz) || 1;
  out.writeFloatLE(nw / ln, o + off.rot_0);
  out.writeFloatLE(nx / ln, o + off.rot_1);
  out.writeFloatLE(ny / ln, o + off.rot_2);
  out.writeFloatLE(nz / ln, o + off.rot_3);
  for (let k = 0; k < 9; k++) out.writeFloatLE(0, o + off['f_rest_' + k]);
}
const headText = text.slice(0, headEnd).replace(marker,
  'comment rotated +90 deg about Y into the viewer frame; f_rest zeroed (see tools/ply-frame-fix.mjs)\n' + marker);
writeFileSync(OUT, Buffer.concat([Buffer.from(headText, 'latin1'), out.subarray(headEnd)]));
console.log(JSON.stringify({ in: IN, out: OUT, splats: n }));
