#!/usr/bin/env node
/** Add the untrained zero-thickness axis required by the three-scale viewer container. */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), OUT = arg('--out'), factor = Number(arg('--thin-factor', 0.01));
if (!IN || !OUT) throw new Error('usage: --in 2dgs.ply --out 3scale.ply [--thin-factor 0.01]');

const b = readFileSync(IN);
const head = b.subarray(0, 65536).toString('latin1');
const marker = 'end_header\n';
const headEnd = head.indexOf(marker) + marker.length;
if (headEnd <= 0) throw new Error('no end_header');
const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
const props = [...head.matchAll(/^property float (\w+)/gm)].map((m) => m[1]);
if (!props.includes('scale_0') || !props.includes('scale_1') || props.includes('scale_2')) {
  throw new Error('expected a 2DGS PLY with scale_0 and scale_1 but no scale_2');
}
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const rec = props.length * 4;
if (b.length !== headEnd + n * rec) throw new Error('size mismatch');
const outProps = [...props];
outProps.splice(outProps.indexOf('scale_1') + 1, 0, 'scale_2');
let header = head.slice(0, headEnd).replace('property float scale_1\n', 'property float scale_1\nproperty float scale_2\n');
header = header.replace(marker, `comment 2DGS two-scale disk; scale_2=log(min(exp(scale_0),exp(scale_1))*${factor}) is a declared viewer-only thinness\n${marker}`);
const out = Buffer.allocUnsafe(header.length + n * outProps.length * 4);
out.write(header, 0, 'latin1');
const outOff = Object.fromEntries(outProps.map((p, i) => [p, i * 4]));
const dstRec = outProps.length * 4;
for (let i = 0; i < n; i++) {
  const o = headEnd + i * rec, d = header.length + i * dstRec;
  const a = Math.exp(b.readFloatLE(o + off.scale_0));
  const c = Math.exp(b.readFloatLE(o + off.scale_1));
  for (const p of props) out.writeFloatLE(b.readFloatLE(o + off[p]), d + outOff[p]);
  out.writeFloatLE(Math.log(Math.max(1e-6, Math.min(a, c) * factor)), d + outOff.scale_2);
}
writeFileSync(OUT, out);
console.log(JSON.stringify({ in: IN, out: OUT, splats: n, thin_factor: factor }));
