/**
 * tools/ziprange.mjs — list or extract one member of a remote ZIP using HTTP ranges.
 *
 * DentVoxel ships one 8.8 GB zip on figshare but only one case is needed. A zip's central
 * directory is at the end and each member's bytes are addressable, so two small range requests plus
 * the member's own range are enough — no 8.8 GB download. Handles Zip64, stored and deflate members,
 * and verifies CRC32 before writing.
 *
 *   node tools/ziprange.mjs --url <zip-url> --list
 *   node tools/ziprange.mjs --url <zip-url> --get "data/case1/image.nii.gz" --out tools/out/x.nii.gz
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url');
const LIST = argv.includes('--list');
const GET = arg('--get');
const OUT = arg('--out');
if (!URL_) { console.error('usage: --url <zip> [--list | --get name --out path]'); process.exit(2); }

// This shell reaches figshare through an HTTP proxy that Node's fetch was not using, and figshare
// 302s to a presigned R2 URL that expires in ten seconds. curl is configured for that proxy and
// follows the redirect immediately, so the network side shells out and the zip parsing stays here.
const curl = (args) => execFileSync('curl', ['-sS', '-L', '--fail', '--retry', '5', '--retry-all-errors', '--retry-delay', '2', ...args], { maxBuffer: 256 << 20 });

const range = (a, b) => {
  const buf = curl(['-r', `${a}-${b}`, URL_]);
  if (buf.length !== b - a + 1) {
    throw new Error(`range ${a}-${b} returned ${buf.length} bytes -- the server ignored Range`);
  }
  return buf;
};

// figshare answers HEAD without a length, so probe with a one-byte range and read Content-Range.
const NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';   // native curl does not know /dev/null
const headText = curl(['-r', '0-0', '-D', '-', '-o', NULL, URL_]).toString('latin1');
const cr = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headText);
const size = cr ? Number(cr[1]) : 0;
if (!Number.isFinite(size) || size <= 0) throw new Error('no Content-Range total from the probe');
console.error(`# remote zip: ${size} bytes`);

// ---- EOCD (and Zip64 when present)
const tailLen = Math.min(size, 131072);
const tail = await range(size - tailLen, size - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
if (eocd < 0) throw new Error('no EOCD signature in the last 128 KiB');
let count = tail.readUInt16LE(eocd + 10);
let cdSize = tail.readUInt32LE(eocd + 12);
let cdOff = tail.readUInt32LE(eocd + 16);
if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
  const loc = eocd - 20;
  if (tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('Zip64 EOCD locator missing');
  const z64 = await range(Number(tail.readBigUInt64LE(loc + 8)), Number(tail.readBigUInt64LE(loc + 8)) + 55);
  if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('Zip64 EOCD signature missing');
  count = Number(z64.readBigUInt64LE(32));
  cdSize = Number(z64.readBigUInt64LE(40));
  cdOff = Number(z64.readBigUInt64LE(48));
}
console.error(`# central directory: ${count} entries, ${cdSize} bytes at ${cdOff}`);
const cd = await range(cdOff, cdOff + cdSize - 1);

const entries = [];
for (let p = 0; p + 46 <= cd.length;) {
  if (cd.readUInt32LE(p) !== 0x02014b50) break;
  const method = cd.readUInt16LE(p + 10);
  const crc = cd.readUInt32LE(p + 16);
  let compSize = cd.readUInt32LE(p + 20);
  let uncompSize = cd.readUInt32LE(p + 24);
  const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), comLen = cd.readUInt16LE(p + 32);
  let lho = cd.readUInt32LE(p + 42);
  const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
  let e = p + 46 + nameLen;
  const extraEnd = e + extraLen;
  while (e + 4 <= extraEnd) {
    const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
    if (id === 0x0001) {                       // Zip64 extended information
      let q = e + 4;
      if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
    }
    e += 4 + len;
  }
  entries.push({ name, crc, method, compSize, uncompSize, lho });
  p += 46 + nameLen + extraLen + comLen;
}

if (LIST) {
  for (const en of entries) console.log(`${String(en.uncompSize).padStart(12)} ${en.compSize.toString().padStart(12)} m${en.method} ${en.name}`);
  console.error(`# ${entries.length} entries`);
  process.exit(0);
}

const hit = entries.filter((en) => en.name === GET || en.name.replace(/\\/g, '/') === GET.replace(/\\/g, '/'));
if (hit.length !== 1) {
  console.error(hit.length ? `# ${hit.length} entries match; be more specific` : `# no entry named ${GET}`);
  process.exit(3);
}
const en = hit[0];
if (!OUT) { console.error('--out is required with --get'); process.exit(2); }

const lh = await range(en.lho, en.lho + 29);
if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header signature');
const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
const dataStart = en.lho + 30 + nameLen + extraLen;
console.error(`# fetching ${en.compSize} compressed bytes for ${en.name}`);
const raw = await range(dataStart, dataStart + en.compSize - 1);
const data = en.method === 0 ? raw : zlib.inflateRawSync(raw);
if (data.length !== en.uncompSize) throw new Error(`inflated ${data.length}, expected ${en.uncompSize}`);

// CRC32 for the integrity claim
const table = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
let crc = -1;
for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
const got = (crc ^ -1) >>> 0;
const enCrc = en.crc;
console.error(`# crc32 ${got.toString(16)} (zip says ${enCrc.toString(16)})`);
if (got !== enCrc) throw new Error('CRC32 mismatch -- refusing to write');

mkdirSync(dirname(OUT), { recursive: true });
if (data.length > 64 * 1024 * 1024) {
  await pipeline(Readable.from(data), createWriteStream(OUT));
} else {
  writeFileSync(OUT, data);
}
console.log(JSON.stringify({ entry: en.name, bytes: data.length, crc32: got.toString(16), out: OUT }));
