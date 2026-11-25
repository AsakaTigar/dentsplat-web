/**
 * tools/nifti_stats.mjs — header + label histogram of a .nii/.nii.gz, in Node, no nibabel.
 *
 * Used to pick a DentVoxel case before downloading its ~87 MB image: the label volume alone says
 * which FDI teeth and which canals are present, and where they sit in millimetres.
 *
 *   node tools/nifti_stats.mjs case.nii.gz
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/nifti_stats.mjs <file.nii[.gz]>'); process.exit(2); }
let buf = readFileSync(file);
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);

const sizeofHdr = buf.readInt32LE(0);
if (sizeofHdr !== 348 && sizeofHdr !== 540) throw new Error(`unexpected sizeof_hdr ${sizeofHdr}`);
const dim = []; for (let i = 0; i < 8; i++) dim.push(buf.readInt16LE(40 + i * 2));
const datatype = buf.readInt16LE(70);
const bitpix = buf.readInt16LE(72);
const pix = []; for (let i = 0; i < 8; i++) pix.push(+buf.readFloatLE(76 + i * 4).toFixed(4));
const voxOffset = Math.max(352, buf.readFloatLE(108));
const slope = buf.readFloatLE(112) || 1, inter = buf.readFloatLE(116) || 0;
const qform = buf.readInt16LE(252), sform = buf.readInt16LE(254);

const TYPES = { 2: [Uint8Array, 1], 4: [Int16Array, 2], 8: [Int32Array, 4], 16: [Float32Array, 4], 512: [Uint16Array, 2], 768: [Uint32Array, 4] };
const [Ctor, bytes] = TYPES[datatype] ?? [];
if (!Ctor) throw new Error(`unsupported datatype ${datatype}`);

const nx = dim[1], ny = dim[2], nz = dim[3];
const n = nx * ny * nz;
const raw = new Ctor(buf.buffer.slice(buf.byteOffset + voxOffset, buf.byteOffset + voxOffset + n * bytes));
console.log(JSON.stringify({ file, dims: [nx, ny, nz], spacing_mm: [pix[1], pix[2], pix[3]], datatype, bitpix, slope, inter, vox_offset: voxOffset, qform, sform }));

const counts = new Map();
const sums = new Map();
for (let k = 0; k < n; k++) {
  const v = raw[k] === 0 || slope === 1 ? raw[k] : Math.round(raw[k] * slope + inter);
  if (v === 0) continue;
  counts.set(v, (counts.get(v) ?? 0) + 1);
  const s = sums.get(v) ?? [0, 0, 0];
  s[0] += k % nx; s[1] += Math.floor(k / nx) % ny; s[2] += Math.floor(k / (nx * ny));
  sums.set(v, s);
}
const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => {
  const s = sums.get(v);
  const mm = [s[0] / c * pix[1], s[1] / c * pix[2], s[2] / c * pix[3]].map((x) => +x.toFixed(1));
  return { label: v, voxels: c, centroid_mm: mm };
});
console.log(JSON.stringify({ labels: rows }, null, 0));
