/**
 * tools/coverage-gap.mjs — how far the pruned cloud's points sit from the full cloud's surface.
 *
 * The Scene B pipeline measures this on a pruned *subset* (removed splats -> nearest retained one).
 * A real scan converted by tools/poseidon_to_assets.mjs resamples both packets independently, so the
 * pruned packet is not a subset and that definition would read zero. Here the distance is pruned ->
 * full, over every pruned point, which is the quantity the compression card actually wants: how much
 * surface the smaller packet fails to cover.
 *
 *   node tools/coverage-gap.mjs --full A.ply --pruned B.ply [--cell 2]
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FULL = arg('--full'), PRUNED = arg('--pruned');
const CELL = Number(arg('--cell', 2));
if (!FULL || !PRUNED) { console.error('usage: node tools/coverage-gap.mjs --full A.ply --pruned B.ply'); process.exit(2); }

/** Binary little-endian PLY with x,y,z float + rgba/uchar (the layout poseidon_to_assets.mjs writes). */
function readXyz(path) {
  const buf = readFileSync(path);
  const headEnd = buf.indexOf('end_header');
  if (headEnd < 0) throw new Error(`${path}: no end_header`);
  const head = buf.subarray(0, headEnd).toString('latin1');
  const n = Number(/element vertex (\d+)/.exec(head)?.[1]);
  const stride = 3 * 4 + 4;
  let o = headEnd + 'end_header'.length;
  while (buf[o] === 0x0a || buf[o] === 0x0d) o++;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = buf.readFloatLE(o); out[i * 3 + 1] = buf.readFloatLE(o + 4); out[i * 3 + 2] = buf.readFloatLE(o + 8);
    o += stride;
  }
  return out;
}

const full = readXyz(FULL);
const pruned = readXyz(PRUNED);
const key = (x, y, z) => `${x},${y},${z}`;
const grid = new Map();
for (let i = 0; i < full.length / 3; i++) {
  const k = key(Math.floor(full[i * 3] / CELL), Math.floor(full[i * 3 + 1] / CELL), Math.floor(full[i * 3 + 2] / CELL));
  const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
}

const dists = [];
let missed = 0;
for (let i = 0; i < pruned.length / 3; i++) {
  const x = pruned[i * 3], y = pruned[i * 3 + 1], z = pruned[i * 3 + 2];
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
  let best = Infinity;
  for (let r = 0; r <= 3 && !Number.isFinite(best); r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;   // shell only
      const a = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!a) continue;
      for (const j of a) {
        const d = Math.hypot(full[j * 3] - x, full[j * 3 + 1] - y, full[j * 3 + 2] - z);
        if (d < best) best = d;
      }
    }
  }
  if (Number.isFinite(best)) dists.push(best); else missed++;
}
dists.sort((a, b) => a - b);
const q = (p) => dists[Math.min(dists.length - 1, Math.floor(p * dists.length))];
const mean = dists.reduce((s, d) => s + d, 0) / Math.max(1, dists.length);
console.log(JSON.stringify({
  full_points: full.length / 3, pruned_points: pruned.length / 3, cell_mm: CELL,
  sampled: dists.length, missed,
  coverage_gap_mean: +mean.toFixed(3), coverage_gap_p95: +q(0.95).toFixed(3),
  coverage_gap_max: +dists[dists.length - 1].toFixed(3),
  definition: 'nearest distance from every pruned point to the full cloud (pruned is not a subset)',
}, null, 2));
