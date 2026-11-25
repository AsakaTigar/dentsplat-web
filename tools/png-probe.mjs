// Decodes a PNG produced by the in-page offscreen probe (window.DentSplat.png) and reports
// whether the splat pass actually painted: coverage, mean colour, and per-region statistics.
// Usage: node tools/png-probe.cjs <file.png|file.json> [cropX cropY cropW cropH]
import fs from 'node:fs';
import zlib from 'node:zlib';

const arg = process.argv[2];
if (!arg) { console.error('usage: node tools/png-probe.cjs <png|json>'); process.exit(2); }

let buf;
if (arg.endsWith('.json')) {
  const j = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const url = j.png || (j.result && j.result.png);
  if (!url) { console.error('no .png data URL in json'); process.exit(2); }
  buf = Buffer.from(url.split(',')[1], 'base64');
  fs.writeFileSync(arg.replace(/\.json$/, '.png'), buf);
} else {
  buf = fs.readFileSync(arg);
}

if (buf.toString('ascii', 1, 4) !== 'PNG') { console.error('not a PNG'); process.exit(2); }
const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
const bitDepth = buf[24], colorType = buf[25];
if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
  console.error(`unsupported colour type ${colorType} / depth ${bitDepth}`);
  process.exit(2);
}
const bpp = colorType === 6 ? 4 : 3;
const idat = [];
let off = 8;
while (off + 8 <= buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
  off += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = w * bpp;
const px = Buffer.alloc(h * stride);
let p = 0;
for (let y = 0; y < h; y++) {
  const f = raw[p++];
  const row = y * stride, above = row - stride;
  for (let x = 0; x < stride; x++) {
    const v = raw[p + x];
    const a = x >= bpp ? px[row + x - bpp] : 0;
    const b = y > 0 ? px[above + x] : 0;
    const c = x >= bpp && y > 0 ? px[above + x - bpp] : 0;
    let val;
    if (f === 0) val = v;
    else if (f === 1) val = v + a;
    else if (f === 2) val = v + ((a + b) >> 1);
    else if (f === 3) val = v + ((a + b) >> 1);
    else {
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    px[row + x] = val & 0xff;
  }
  p += stride;
}

function stats(x0, y0, x1, y1) {
  let painted = 0, n = 0;
  let sr = 0, sg = 0, sb = 0, maxL = 0;
  const hue = { warm: 0, cool: 0, yellow: 0, red: 0 };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * stride + x * bpp;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = (r + g + b) / 3;
      n++;
      sr += r; sg += g; sb += b;
      if (l > maxL) maxL = l;
      if (l > 34) {
        painted++;
        if (r > 200 && g > 180 && b > 150) hue.warm++;        // enamel / dentine
        else if (b > r) hue.cool++;                            // blue UI light
        else if (r > 180 && g > 150 && b < 120) hue.yellow++;  // nerve canal
        else if (r > 140 && g < 110 && b < 120) hue.red++;      // pulp / lesion
      }
    }
  }
  return {
    box: [x0, y0, x1 - x0, y1 - y0],
    paintedFraction: +(painted / n).toFixed(4),
    mean: [+(sr / n).toFixed(1), +(sg / n).toFixed(1), +(sb / n).toFixed(1)],
    peak: +maxL.toFixed(1),
    hue,
  };
}

console.log(JSON.stringify({
  file: arg, width: w, height: h, colorType,
  whole: stats(0, 0, w, h),
  centre: stats(Math.floor(w * 0.28), Math.floor(h * 0.18), Math.floor(w * 0.72), Math.floor(h * 0.82)),
}, null, 1));
