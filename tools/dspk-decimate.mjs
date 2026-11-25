/**
 * tools/dspk-decimate.mjs — every Nth splat, with the tangential axes scaled by sqrt(N).
 *
 * The .dspk format stores one fixed-width record per splat, so a decimation that keeps every Nth
 * record (written interleaved by layer/FDI) is deterministic and unbiased across the anatomy, unlike
 * truncating the file at a byte budget (which drops every layer after the first N records). Scaling
 * s1 and s2 by sqrt(N) keeps the covered area constant: N times fewer disks, each sqrt(N) wider.
 * s3 (the surfel thickness) is left alone, so the shell does not get thicker.
 *
 *   node tools/dspk-decimate.mjs --in public/assets/sceneB_surfel_full.dspk --every 3 \
 *        --out public/assets/sceneB_dentvoxel_pruned.dspk
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in'), OUT = arg('--out');
const EVERY = Number(arg('--every', 3));
if (!IN || !OUT) { console.error('usage: --in <full.dspk> --out <pruned.dspk> [--every 3]'); process.exit(2); }
if (!(EVERY >= 2)) { console.error('--every must be >= 2'); process.exit(2); }

const buf = readFileSync(IN);
if (buf.readUInt32LE(0) !== 0x4b505344) throw new Error('not a DSPK file');
const stride = buf.readUInt8(7);
const count = buf.readUInt32LE(8);
const logMin = buf.readFloatLE(36), logMax = buf.readFloatLE(40);
const metaLen = buf.readUInt32LE(44);
const base = 128 + metaLen;
if (buf.length < base + count * stride) throw new Error('truncated DSPK');

const keep = [];
for (let i = 0; i < count; i += EVERY) keep.push(i);
const n = keep.length;

// decode -> widen the two tangential axes -> find the new global log range -> re-encode
const scales = new Float32Array(n * 3);
let lo = Infinity, hi = -Infinity;
for (let k = 0; k < n; k++) {
  const o = base + keep[k] * stride;
  for (let a = 0; a < 3; a++) {
    const t = buf.readUInt8(o + 10 + a) / 255;
    let s = Math.exp(logMin + t * (logMax - logMin));
    if (a < 2) s *= Math.sqrt(EVERY);
    scales[k * 3 + a] = s;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
}
const newLogMin = Math.log(lo), newLogMax = Math.log(hi);
const span = Math.max(1e-6, newLogMax - newLogMin);

const metaBytes = buf.subarray(128, base);
const out = Buffer.alloc(128 + metaBytes.length + n * stride);
buf.copy(out, 0, 0, 128);
out.writeUInt32LE(n, 8);
out.writeFloatLE(newLogMin, 36);
out.writeFloatLE(newLogMax, 40);
metaBytes.copy(out, 128);
for (let k = 0; k < n; k++) {
  const src = base + keep[k] * stride;
  const dst = 128 + metaBytes.length + k * stride;
  buf.copy(out, dst, src, src + stride);
  for (let a = 0; a < 3; a++) {
    const t = (Math.log(scales[k * 3 + a]) - newLogMin) / span;
    out.writeUInt8(Math.round(Math.max(0, Math.min(1, t)) * 255), dst + 10 + a);
  }
}
writeFileSync(OUT, out);
console.log(JSON.stringify({ in: IN, out: OUT, every: EVERY, count_in: count, count_out: n,
  bytes: out.length, logMin: newLogMin, logMax: newLogMax }));
