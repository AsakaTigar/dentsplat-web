/**
 * tools/pick_dentvoxel_case.mjs — choose the DentVoxel case whose canal runs closest to a third molar.
 *
 * All 100 label volumes are ~0.8 MB while each image is ~87 MB, so the labels are downloaded first
 * (one range request each, reusing the central directory once), decoded in-process, and scored. The
 * winner's image is then the only large download.
 *
 *   node tools/pick_dentvoxel_case.mjs --url <zip> [--top 10] [--cache tools/out/data/dv]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url');
const TOP = Number(arg('--top', 10));
const CACHE = arg('--cache', 'tools/out/data/dv');
if (!URL_) { console.error('usage: --url <zip>'); process.exit(2); }
mkdirSync(CACHE, { recursive: true });

const NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const curl = (args) => execFileSync('curl', ['-sS', '-L', '--fail', ...args], { maxBuffer: 128 << 20 });
const range = (a, b) => {
  const buf = curl(['-r', `${a}-${b}`, URL_]);
  if (buf.length !== b - a + 1) throw new Error(`range ${a}-${b} -> ${buf.length} bytes`);
  return buf;
};

// central directory
const headText = curl(['-r', '0-0', '-D', '-', '-o', NULL, URL_]).toString('latin1');
const size = Number(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headText)?.[1] ?? 0);
const tailLen = Math.min(size, 131072);
const tail = range(size - tailLen, size - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
if (eocd < 0) throw new Error('no EOCD');
let cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
if (cdSize === 0xffffffff || cdOff === 0xffffffff) {
  const loc = eocd - 20;
  const z64off = Number(tail.readBigUInt64LE(loc + 8));
  const z64 = range(z64off, z64off + 55);
  cdSize = Number(z64.readBigUInt64LE(40));
  cdOff = Number(z64.readBigUInt64LE(48));
}
const cd = range(cdOff, cdOff + cdSize - 1);
const entries = [];
for (let p = 0; p + 46 <= cd.length;) {
  if (cd.readUInt32LE(p) !== 0x02014b50) break;
  const method = cd.readUInt16LE(p + 10);
  let compSize = cd.readUInt32LE(p + 20), uncompSize = cd.readUInt32LE(p + 24);
  const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), comLen = cd.readUInt16LE(p + 32);
  let lho = cd.readUInt32LE(p + 42);
  const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
  let e = p + 46 + nameLen;
  const extraEnd = e + extraLen;
  while (e + 4 <= extraEnd) {
    const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
    if (id === 0x0001) {
      let q = e + 4;
      if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
    }
    e += 4 + len;
  }
  entries.push({ name, method, compSize, uncompSize, lho });
  p += 46 + nameLen + extraLen + comLen;
}

/** One range fetch of the whole member record (local header + name/extra + data), then inflate. */
const fetchMember = (en) => {
  const raw = range(en.lho, en.lho + 30 + 512 + en.compSize - 1);
  if (raw.readUInt32LE(0) !== 0x04034b50) throw new Error(`${en.name}: bad local header`);
  const nameLen = raw.readUInt16LE(26), extraLen = raw.readUInt16LE(28);
  const data = raw.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + en.compSize);
  return en.method === 0 ? data : zlib.inflateRawSync(data);
};

const readNifti = (buf) => {
  const b = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const dim = []; for (let i = 0; i < 4; i++) dim.push(b.readInt16LE(40 + i * 2));
  const pix = []; for (let i = 1; i < 4; i++) pix.push(b.readFloatLE(76 + i * 4));
  const dt = b.readInt16LE(70);
  const off = Math.max(352, b.readFloatLE(108)) | 0;
  const n = dim[1] * dim[2] * dim[3];
  const T = { 2: [Uint8Array, 1], 4: [Int16Array, 2] }[dt];
  if (!T) throw new Error(`datatype ${dt}`);
  const Ctor = T[0];
  const arr = new Ctor(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + n * T[1]));
  return { raw: arr, nx: dim[1], ny: dim[2], nz: dim[3], pix };
};

const files = entries.filter((e) => /\/label\/label\d+\.nii\.gz$/.test(e.name));
console.error(`# ${files.length} label volumes`);

const results = [];
let done = 0;
const queue = [...files];
const worker = async () => {
  for (;;) {
    const en = queue.shift();
    if (!en) return;
    const id = /label(\d+)\.nii\.gz$/.exec(en.name)[1];
    const cachePath = join(CACHE, `label${id}.nii.gz`);
    try {
      if (!existsSync(cachePath)) writeFileSync(cachePath, fetchMember(en));
      const { raw, nx, ny, nz, pix } = readNifti(readFileSync(cachePath));
      const cnt = new Map(), sum = new Map();
      for (let k = 0; k < raw.length; k++) {
        const v = raw[k];
        if (!v) continue;
        cnt.set(v, (cnt.get(v) ?? 0) + 1);
        const s = sum.get(v) ?? [0, 0, 0];
        s[0] += k % nx; s[1] += Math.floor(k / nx) % ny; s[2] += Math.floor(k / (nx * ny));
        sum.set(v, s);
      }
      const cen = (v) => { const s = sum.get(v), c = cnt.get(v); return s ? [s[0] / c * pix[0], s[1] / c * pix[1], s[2] / c * pix[2]] : null; };
      const fdis = [26, 34].filter((v) => cnt.has(v));            // labels 26/34 are FDI 38/48
      const canals = [35, 36].filter((v) => cnt.has(v));
      let best = null;
      for (const t of fdis) for (const c of canals) {
        const a = cen(t), b = cen(c);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (!best || d < best.mm) best = { tooth: t, canal: c, mm: +d.toFixed(1) };
      }
      results.push({ id, fdis, canals, best, labels: cnt.size });
    } catch (err) {
      console.error(`! ${id}: ${String(err).slice(0, 120)}`);
    } finally {
      done++;
      if (done % 10 === 0) console.error(`# ${done}/${files.length}`);
    }
  }
};
await Promise.all(Array.from({ length: 4 }, worker));

const ranked = results.filter((r) => r.fdis.length && r.canals.length).sort((a, b) => (a.best?.mm ?? 1e9) - (b.best?.mm ?? 1e9));
console.log(JSON.stringify({
  scanned: results.length,
  with_third_molar_and_canal: ranked.length,
  top: ranked.slice(0, TOP).map((r) => ({ id: r.id, mm: r.best?.mm, tooth_label: r.best?.tooth, canal_label: r.best?.canal, fdis: r.fdis, canals: r.canals, labels: r.labels })),
}, null, 1));
