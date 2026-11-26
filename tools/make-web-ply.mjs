#!/usr/bin/env node
/** Create a bounded, reproducible web PLY: top-opacity subset and SH0 only. */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), OUT = arg('--out'), max = Number(arg('--max', Infinity));
if (!IN || !OUT) throw new Error('usage: --in viewer.ply --out web.ply [--max 250000]');
const b = readFileSync(IN);
const head = b.subarray(0, 65536).toString('latin1');
const marker = 'end_header\n';
const headEnd = head.indexOf(marker) + marker.length;
if (headEnd <= 0) throw new Error('no end_header');
const n = Number((head.match(/element vertex (\d+)/) || [])[1]);
const props = [...head.matchAll(/^property float (\w+)/gm)].map((m) => m[1]);
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const rec = props.length * 4;
if (b.length !== headEnd + n * rec) throw new Error('size mismatch');
if (off.opacity === undefined) throw new Error('missing opacity');
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
let keep = Array.from({ length: n }, (_, i) => i);
if (keep.length > max) {
  keep.sort((i, j) => sigmoid(b.readFloatLE(headEnd + j * rec + off.opacity)) - sigmoid(b.readFloatLE(headEnd + i * rec + off.opacity)) || i - j);
  keep = keep.slice(0, max);
}
const outProps = props.filter((p) => !p.startsWith('f_rest_'));
const outOff = Object.fromEntries(outProps.map((p, i) => [p, i * 4]));
let header = head.slice(0, headEnd);
for (const p of props) if (p.startsWith('f_rest_')) header = header.replace(`property float ${p}\n`, '');
header = header.replace(`element vertex ${n}\n`, `element vertex ${keep.length}\n`);
header = header.replace(marker, `comment web export: top-opacity ${keep.length}/${n}; SH0 only; full PLY remains the audit source\n${marker}`);
const dstRec = outProps.length * 4;
const out = Buffer.allocUnsafe(header.length + keep.length * dstRec);
out.write(header, 0, 'latin1');
for (let k = 0; k < keep.length; k++) {
  const o = headEnd + keep[k] * rec, d = header.length + k * dstRec;
  for (const p of outProps) out.writeFloatLE(b.readFloatLE(o + off[p]), d + outOff[p]);
}
writeFileSync(OUT, out);
console.log(JSON.stringify({ in: IN, out: OUT, source_splats: n, web_splats: keep.length, sh_degree: 0, selection: 'descending sigmoid(opacity), index tie-break' }));
