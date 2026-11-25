/**
 * tools/label-transfer.mjs — give a trained Scene A PLY the FDI/layer labels of the sampled packet.
 *
 * Training optimises positions/opacities/rotations/scales/colour; it does not know which tooth each
 * Gaussian belongs to. The anatomy is the same real Poseidon3D arch, so each trained centroid takes
 * the label of the nearest labelled sample within --max-mm. Anything further away (floaters in the
 * background, or a splat the optimiser moved off the surface) gets 0 / 0 rather than an invented id.
 *
 *   node tools/label-transfer.mjs --trained tools/out/case125/brush_run/caseA_15000.ply \
 *        --labels public/assets/sceneA_poseidon_full.dspk --out-dir tools/out/case125/trained
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const TRAINED = arg('--trained'), LABELS = arg('--labels'), OUT = arg('--out-dir');
const MAX_MM = Number(arg('--max-mm', 0.6));
if (!TRAINED || !LABELS || !OUT) { console.error('usage: --trained x.ply --labels y.dspk --out-dir dir'); process.exit(2); }

// --- labelled reference packet (DSPK positions + fdi/layer bytes)
const buf = readFileSync(LABELS);
if (buf.readUInt32LE(0) !== 0x4b505344) throw new Error('labels: not a DSPK file');
const stride = buf.readUInt8(7), count = buf.readUInt32LE(8);
const bmin = [buf.readFloatLE(12), buf.readFloatLE(16), buf.readFloatLE(20)];
const bmax = [buf.readFloatLE(24), buf.readFloatLE(28), buf.readFloatLE(32)];
const base = 128 + buf.readUInt32LE(44);
const P = new Float32Array(count * 3), F = new Uint8Array(count), L = new Uint8Array(count);
for (let i = 0; i < count; i++) {
  const o = base + i * stride;
  for (let k = 0; k < 3; k++) {
    const t = buf.readUInt16LE(o + k * 2) / 65535;
    P[i * 3 + k] = bmin[k] + t * (bmax[k] - bmin[k]);
  }
  F[i] = buf.readUInt8(o + 17);
  L[i] = buf.readUInt8(o + 18);
}

// --- trained PLY positions (binary little endian, x/y/z floats; order from the header)
const ply = readFileSync(TRAINED);
const text = ply.subarray(0, 4096).toString('latin1');
const headEnd = text.indexOf('end_header\n') + 'end_header\n'.length;
const n = Number((text.match(/element vertex (\d+)/) || [])[1]);
const props = [...text.matchAll(/^property float (\w+)/gm)].map((m) => m[1]);
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const rec = props.length * 4;
const Q = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  const o = headEnd + i * rec;
  Q[i * 3] = ply.readFloatLE(o + off.x);
  Q[i * 3 + 1] = ply.readFloatLE(o + off.y);
  Q[i * 3 + 2] = ply.readFloatLE(o + off.z);
}

// spatial hash over the labelled samples, cell = max-mm
const cell = Math.max(MAX_MM, 0.3);
const key = (x, y, z) => x + ',' + y + ',' + z;
const grid = new Map();
for (let i = 0; i < count; i++) {
  const k = key(Math.floor(P[i * 3] / cell), Math.floor(P[i * 3 + 1] / cell), Math.floor(P[i * 3 + 2] / cell));
  const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
}
const fdi = new Uint8Array(n), layer = new Uint8Array(n);
let hit = 0;
for (let i = 0; i < n; i++) {
  const x = Q[i * 3], y = Q[i * 3 + 1], z = Q[i * 3 + 2];
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
  let best = MAX_MM * MAX_MM, bj = -1;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const a = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue;
    for (const j of a) {
      const ddx = P[j * 3] - x, ddy = P[j * 3 + 1] - y, ddz = P[j * 3 + 2] - z;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < best) { best = d2; bj = j; }
    }
  }
  if (bj >= 0) { fdi[i] = F[bj]; layer[i] = L[bj]; hit++; }
}

mkdirSync(OUT, { recursive: true });
const fdiPath = join(OUT, 'fdi_labels.bin'), layerPath = join(OUT, 'layer_labels.bin');
writeFileSync(fdiPath, Buffer.from(fdi));
writeFileSync(layerPath, Buffer.from(layer));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const man = {
  generator: 'tools/label-transfer.mjs',
  order: 'writer order of the trained PLY, no permutation',
  ply: { file: TRAINED, sha256: sha(ply), count: n },
  files: {
    'fdi_labels.bin': { sha256: sha(Buffer.from(fdi)), count: n },
    'layer_labels.bin': { sha256: sha(Buffer.from(layer)), count: n },
  },
  transferred: hit,
  max_mm: MAX_MM,
  reference: LABELS,
};
writeFileSync(join(OUT, 'labels_manifest.json'), JSON.stringify(man, null, 2) + '\n');
console.log(JSON.stringify({ trained: TRAINED, splats: n, transferred: hit, pct: +(100 * hit / n).toFixed(1),
  fdi_nonzero: fdi.filter((v) => v > 0).length, out: OUT }, null, 1));
