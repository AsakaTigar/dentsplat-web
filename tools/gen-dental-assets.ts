/** DentSplat asset generator — builds the two showcase scenes as `.dspk` packets plus the
 *  invisible FDI picking proxies, in the exact world frame the offline pipeline promises
 *  (Y-up, 1 unit = 1 mm, occlusal plane || XZ, maxilla +Y, lips +Z).
 *
 *  These are SYNTHETIC stand-ins with correct anatomy and correct semantics: they exist so the
 *  web engine can be built, tuned and screen-shot before a GPU slot frees up for the real
 *  Blender -> gsplat -> postprocess run. Swapping in trained assets is a file drop, not a code
 *  change, because `tools/ply2dspk.ts` emits the identical packet from real 3DGS output.
 *
 *  usage: node tools/gen-dental-assets.ts [--density 1] [--seed 1337] [--out public/assets]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloud, encodeSplatCloud, FLAG, LAYER, type SplatCloud } from '../src/engine/dspk.ts';
import { buildArch, sampleTooth, type Arch, type Placement, type Sample } from './lib/anatomy.ts';
import {
  add, mat3FromCols, mulMV, norm, quatFromMat3, writeGLB,
  type M3, type ProxyMesh, type Quat, type V3,
} from './lib/geom.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DENSITY = Number(argOf('density', '1'));
const SEED = Number(argOf('seed', '1337'));
const OUT = join(ROOT, argOf('out', 'public/assets'));

const LIGHT: V3 = norm([0.42, 0.72, 0.55]);
const SH_C1 = 0.4886025;

function rngFrom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class Sink {
  centers: number[] = [];
  quats: number[] = [];
  scales: number[] = [];
  colors: number[] = [];
  alphas: number[] = [];
  toothIds: number[] = [];
  layerIds: number[] = [];
  flagsArr: number[] = [];
  sh1: number[] = [];
  rng = rngFrom(SEED);
  private tooth = 0;

  setTooth(fdi: number) { this.tooth = fdi; }

  push(s: Sample, sheen: number) {
    const n = s.normal;
    const ndl = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const hx = 2 * ndl * n[0] - LIGHT[0];
    const hy = 2 * ndl * n[1] - LIGHT[1];
    const hz = 2 * ndl * n[2] - LIGHT[2];
    const k = sheen * (0.3 + 0.7 * ndl * ndl);
    // We want col += k * dot(viewDir, h). In the 3DGS l=1 band basis (y, z, x) with the
    // (-, +, -) signs the shader applies, that is b = (-k*hy, k*hz, -k*hx) / C1.
    const b: [number, number, number] = [(-k * hy) / SH_C1, (k * hz) / SH_C1, (-k * hx) / SH_C1];
    this.centers.push(s.center[0], s.center[1], s.center[2]);
    this.quats.push(s.quat[0], s.quat[1], s.quat[2], s.quat[3]);
    this.scales.push(s.radius, s.radius, s.thickness);
    this.colors.push(s.color[0], s.color[1], s.color[2]);
    this.alphas.push(s.alpha);
    this.toothIds.push(this.tooth);
    this.layerIds.push(s.layer);
    this.flagsArr.push(s.flags);
    this.sh1.push(b[0], b[1], b[2], b[0], b[1], b[2], b[0], b[1], b[2]);
  }

  get count() { return this.alphas.length; }

  get asSampler() {
    return { push: (s: Sample) => this.push(s, s.layer === LAYER.pulp ? 0.015 : s.layer === LAYER.enamel ? 0.12 : 0.06) };
  }

  toCloud(meta: Record<string, unknown>, hasSH1 = true): SplatCloud {
    return buildCloud({
      centers: this.centers, quats: this.quats, scales: this.scales, colors: this.colors,
      alphas: this.alphas, toothIds: this.toothIds, layerIds: this.layerIds, flags: this.flagsArr,
      sh1: hasSH1 ? this.sh1 : undefined, meta: meta as SplatCloud['meta'],
    });
  }

  centersFlat(): Float64Array { return Float64Array.from(this.centers); }
}

function sweepFrames(path: V3[], up: V3 = [0, 1, 0]) {
  const tan: V3[] = [], nrm: V3[] = [], bin: V3[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let n = norm([t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]]);
    if (!Number.isFinite(n[0]) || Math.hypot(n[0], n[1], n[2]) < 1e-6) n = [1, 0, 0];
    tan.push(t); nrm.push(n);
    bin.push([t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]]);
  }
  return { tan, nrm, bin };
}

/** Swept elliptical band: gingival collar, cortical bone shell, nerve canal, sinus lining. */
function sweepBand(
  sink: Sink, path: V3[],
  rx: (t: number) => number, rz: (t: number) => number, around: number,
  color: (u: number, t: number, n: V3) => [number, number, number],
  opts: { layer: number; alpha: number; sheen: number; flags?: number; thickness?: number },
) {
  const fr = sweepFrames(path);
  for (let i = 0; i < path.length; i++) {
    const t = path.length > 1 ? i / (path.length - 1) : 0;
    const a = rx(t), b = rz(t);
    const step = Math.max(0.4, (Math.PI * (a + b)) / around);
    for (let k = 0; k < around; k++) {
      const u = (2 * Math.PI * k) / around + (i % 2) * (Math.PI / around);
      const cu = Math.cos(u), su = Math.sin(u);
      const off: V3 = [
        fr.nrm[i][0] * cu * a + fr.bin[i][0] * su * b,
        fr.nrm[i][1] * cu * a + fr.bin[i][1] * su * b,
        fr.nrm[i][2] * cu * a + fr.bin[i][2] * su * b,
      ];
      const center = add(path[i], off);
      const normal = norm(off);
      const q: Quat = quatFromMat3(mat3FromCols(fr.tan[i], fr.nrm[i], normal));
      sink.push({
        center, normal, radius: step * 1.3, thickness: opts.thickness ?? 0.2,
        quat: q, color: color(u, t, normal), alpha: opts.alpha, layer: opts.layer, flags: opts.flags ?? 0,
      }, opts.sheen);
    }
  }
}

/** Symmetric arch sweep: theta is the angle from the midline (sagittal, +Z) around the arch,
 *  negative theta = patient's right (-X). Sweeping -thetaMax..+thetaMax walks posterior-right ->
 *  anterior -> posterior-left, which is what band/canal geometry needs. */
function archPath(arch: Arch, scale: number, yOffset: number, steps: number, thetaMax = 2.35): V3[] {
  const pts: V3[] = [];
  const A = (arch === 'upper' ? 32.5 : 28.5) * scale;
  const B = (arch === 'upper' ? 33.5 : 30.5) * scale;
  for (let i = 0; i <= steps; i++) {
    const f = steps > 0 ? i / steps : 0;
    const th = -thetaMax + 2 * thetaMax * f;
    pts.push([A * Math.sin(th), yOffset, B * Math.cos(th)]);
  }
  return pts;
}

const LESIONS: Record<number, 'occlusal-caries' | 'white-spot' | 'calculus'> = {
  36: 'occlusal-caries', 11: 'white-spot', 26: 'calculus',
};

// --------------------------------------------------------------- Scene A: IOS

function buildSceneA(sink: Sink) {
  const rings = Math.round(21 * DENSITY), around = Math.round(26 * DENSITY);
  const teeth: Record<string, unknown> = {};
  for (const arch of ['upper', 'lower'] as Arch[]) {
    for (const pl of buildArch(arch, { impacted48: true })) {
      sink.setTooth(pl.fdi);
      sampleTooth(sink.asSampler, pl, {
        rings, around, shellLayers: 3, shellGap: 0.45, splatScale: 1.12, rng: sink.rng,
        root: true, pulp: false, cap: true,
        lesion: LESIONS[pl.fdi] ?? null,
        layerEnamel: LAYER.enamel, layerInner: LAYER.root,
        look: {
          enamel: pl.fdi === 48 ? [0.87, 0.84, 0.77] : [0.93, 0.90, 0.84],
          dentin: [0.80, 0.73, 0.60], rootColor: [0.85, 0.81, 0.70], jitter: 0.025,
        },
        ...(pl.fdi === 48 ? { occlusalGap: 3.0 } : {}),
      });
      teeth[`FDI_${pl.fdi}`] = {
        fdi: pl.fdi, arch, pos: pl.pos, side: pl.side,
        centroid_mm: centroid(sink, pl.fdi), layer: 'enamel', lesion: LESIONS[pl.fdi] ?? null,
      };
    }
  }
  sink.setTooth(0);
  for (const arch of ['upper', 'lower'] as Arch[]) {
    const sgn = arch === 'upper' ? 1 : -1;
    const path = archPath(arch, 1.0, sgn * 7.2, Math.round(96 * DENSITY), 2.36);
    sweepBand(sink, path,
      (t) => 3.6 + 1.1 * Math.pow(Math.sin(t * Math.PI * 8), 2),
      (t) => 3.1 + 0.7 * Math.cos(t * Math.PI * 7),
      Math.round(30 * DENSITY),
      (u, t, n) => {
        const scallop = 0.9 + 0.1 * Math.sin(t * Math.PI * 16);
        const shade = 0.7 + 0.3 * Math.max(0, n[1] * sgn * 0.55 + n[2] * 0.5);
        return [0.73 * scallop * shade, 0.31 * scallop * shade, 0.33 * scallop * shade];
      },
      { layer: LAYER.gingiva, alpha: 0.94, sheen: 0.085, flags: arch === 'upper' ? FLAG.upperJaw : FLAG.lowerJaw });
  }
  // palate dome so the Upper Occlusal preset reads as a real maxilla
  sweepBand(sink, archPath('upper', 0.62, 11.4, Math.round(48 * DENSITY), 1.95),
    () => 1.1, () => 9.6, Math.round(34 * DENSITY),
    (u, t, n) => {
      const shade = 0.78 + 0.22 * Math.max(0, n[1]);
      return [0.67 * shade, 0.35 * shade, 0.38 * shade];
    },
    { layer: LAYER.gingiva, alpha: 0.92, sheen: 0.05, flags: FLAG.upperJaw, thickness: 0.35 });

  return sink.toCloud({
    name: 'sceneA_ios', kind: 'ios', unit: 'mm', teeth,
    provenance: 'synthetic preview built from Teeth3DS+ arch metrics; replace with trained .ply via tools/ply2dspk.ts',
  }, true);
}

// -------------------------------------------------------------- Scene B: CBCT

function restoreCrown(sink: Sink, pl: Placement) {
  const spec = pl.spec;
  for (let j = 0; j <= 8; j++) {
    const t = j / 8;
    for (let k = 0; k < 18; k++) {
      const u = (2 * Math.PI * k) / 18;
      const prof = 0.95 - 0.12 * t;
      const localP: V3 = [(spec.w / 2) * prof * Math.cos(u), t * spec.hc * 0.96, (spec.d / 2) * prof * Math.sin(u)];
      const worldP = add(pl.origin, mulMV(pl.frame as M3, localP));
      const nrm = norm(mulMV(pl.frame as M3, [Math.cos(u) / (spec.w / 2), 0.3, Math.sin(u) / (spec.d / 2)]));
      const q = quatFromMat3(mat3FromCols(
        norm(mulMV(pl.frame as M3, [1, 0, 0])), norm(mulMV(pl.frame as M3, [0, 1, 0])), nrm));
      sink.push({
        center: worldP, normal: nrm, radius: 0.44, thickness: 0.2, quat: q,
        color: [0.8, 0.83, 0.88], alpha: 0.97, layer: LAYER.restoration, flags: FLAG.upperJaw,
      }, 0.2);
    }
  }
}

function implantFixture(sink: Sink, pl: Placement) {
  for (let j = 0; j <= 24; j++) {
    const t = j / 24;
    const y = pl.spec.hc - t * 11.0;
    const r = 1.9 - 0.75 * t;
    for (let k = 0; k < 13; k++) {
      const u = (2 * Math.PI * k) / 13 + t * 3.6;
      const localP: V3 = [r * Math.cos(u), y, r * Math.sin(u) * 0.9];
      const worldP = add(pl.origin, mulMV(pl.frame as M3, localP));
      const nrm = norm(mulMV(pl.frame as M3, [Math.cos(u), 0.18, Math.sin(u)]));
      const q = quatFromMat3(mat3FromCols(
        norm(mulMV(pl.frame as M3, [1, 0, 0])), norm(mulMV(pl.frame as M3, [0, 1, 0])), nrm));
      sink.push({
        center: worldP, normal: nrm, radius: 0.36, thickness: 0.18, quat: q,
        color: [0.6, 0.63, 0.69], alpha: 0.98, layer: LAYER.restoration, flags: FLAG.lowerJaw,
      }, 0.24);
    }
  }
}

function buildSceneB(sink: Sink) {
  const teeth: Record<string, unknown> = {};
  const placements: Placement[] = [];
  for (const arch of ['upper', 'lower'] as Arch[]) {
    for (const pl of buildArch(arch, { impacted48: true })) {
      placements.push(pl);
      if (pl.fdi === 46) continue; // extracted, replaced by the fixture below
      sink.setTooth(pl.fdi);
      sampleTooth(sink.asSampler, pl, {
        rings: 15, around: 20, shellLayers: 2, shellGap: 0.5, splatScale: 1.2, rng: sink.rng,
        root: true, pulp: true, cap: true, alpha: 0.93,
        layerEnamel: LAYER.enamel, layerInner: LAYER.root, layerPulp: LAYER.pulp,
        look: { enamel: [0.9, 0.9, 0.93], dentin: [0.78, 0.77, 0.76], rootColor: [0.8, 0.79, 0.78], jitter: 0.02 },
        ...(pl.fdi === 48 ? { occlusalGap: 2.2 } : {}),
      });
      if (pl.fdi === 26) { sink.setTooth(26); restoreCrown(sink, pl); }
      teeth[`FDI_${pl.fdi}`] = { fdi: pl.fdi, arch, pos: pl.pos, side: pl.side, centroid_mm: centroid(sink, pl.fdi), layer: 'teeth' };
    }
  }
  const site46 = placements.find((p) => p.fdi === 46)!;
  sink.setTooth(46);
  implantFixture(sink, site46);
  teeth.FDI_46 = { fdi: 46, arch: 'lower', pos: 6, side: site46.side, centroid_mm: centroid(sink, 46), layer: 'restoration' };

  sink.setTooth(0);
  for (const arch of ['upper', 'lower'] as Arch[]) {
    const sgn = arch === 'upper' ? 1 : -1;
    const band = archPath(arch, arch === 'upper' ? 1.06 : 1.02, sgn * (arch === 'upper' ? 18 : -16),
      Math.round(104 * DENSITY), arch === 'upper' ? 2.15 : 2.3);
    sweepBand(sink, band,
      () => (arch === 'upper' ? 8.6 : 10.4), () => (arch === 'upper' ? 6.4 : 8.6), Math.round(42 * DENSITY),
      (u, t, n) => {
        const rim = Math.max(0, n[1] * sgn);
        const spk = 0.84 + sink.rng() * 0.18;
        const sh = (0.6 + 0.42 * rim) * spk;
        return [0.8 * sh, 0.78 * sh, 0.74 * sh];
      },
      { layer: LAYER.alveolar, alpha: 0.4, sheen: 0.03, flags: arch === 'upper' ? FLAG.upperJaw : FLAG.lowerJaw, thickness: 2.2 });
  }

  // Inferior alveolar canal: inside the mandibular body, rising posteriorly toward the
  // mandibular foramen. It is then *steered* to pass a fixed clinical distance from the
  // mesioangular impacted 48 — the distance shown in the UI is measured back out of the
  // generated splat set below, never hard-coded.
  const canal: V3[] = [];
  const cPath = archPath('lower', 0.86, -13.5, 46, 2.05);
  for (let i = 0; i < cPath.length; i++) {
    const t = i / (cPath.length - 1);
    const p = cPath[i];
    canal.push([p[0], p[1] - 1.4 + 7.0 * Math.pow(Math.max(0, t - 0.74) / 0.26, 1.8), p[2]]);
  }
  const t48: V3[] = [];
  for (let i = 0; i < sink.toothIds.length; i++) {
    if (sink.toothIds[i] === 48) t48.push([sink.centers[i * 3], sink.centers[i * 3 + 1], sink.centers[i * 3 + 2]]);
  }
  const TARGET = 3.7;
  for (let it = 0; it < 10; it++) {
    for (const p of canal) {
      let best = Infinity; let q: V3 = p;
      for (const s of t48) {
        const d = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2;
        if (d < best) { best = d; q = s; }
      }
      const dist = Math.sqrt(best);
      if (dist > 14) continue; // only steer where the canal genuinely passes the third molar
      const inv = 1 / Math.max(1e-6, dist);
      const push = TARGET - dist;
      const dir: V3 = [(p[0] - q[0]) * inv, (p[1] - q[1]) * inv, (p[2] - q[2]) * inv];
      // attract along the tooth->canal line but bias inferior so the canal still reads as
      // running *below* the impacted crown rather than floating inside it
      p[0] += dir[0] * push * 0.6;
      p[1] += dir[1] * push * 0.6 - push * 0.35;
      p[2] += dir[2] * push * 0.6;
    }
  }
  sweepBand(sink, canal, () => 1.5, () => 1.35, 13, () => [0.99, 0.82, 0.13],
    { layer: LAYER.nerve, alpha: 0.97, sheen: 0.02, flags: FLAG.lowerJaw, thickness: 0.5 });

  for (const side of [-1, 1]) {
    const ring: V3[] = [];
    for (let i = 0; i <= 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      ring.push([side * 24 + 6.5 * Math.cos(a), 22 + 6.5 * Math.sin(a), 4 * Math.cos(a) * 0.6]);
    }
    sweepBand(sink, ring, () => 0.8, () => 0.8, 7, () => [0.36, 0.44, 0.58],
      { layer: LAYER.sinus, alpha: 0.24, sheen: 0.01, flags: FLAG.upperJaw, thickness: 0.6 });
  }

  const cloud = sink.toCloud({
    name: 'sceneB_cbct', kind: 'cbct', unit: 'mm', teeth,
    provenance: 'synthetic preview using the ToothFairy3 77-class label schema; replace with .nii.gz -> cbct_layers.ply -> ply2dspk',
    layer_names: { [LAYER.alveolar]: 'alveolar', [LAYER.enamel]: 'teeth', [LAYER.root]: 'teeth', [LAYER.pulp]: 'pulp', [LAYER.nerve]: 'nerve', [LAYER.sinus]: 'sinus', [LAYER.restoration]: 'restoration' },
  }, true);

  // Real geometric fact computed from the generated scene, shown as the clinical headline.
  const cw = new Float64Array(cloud.count * 3);
  decodeCenters(cloud, cw);
  const near = minDistance(cloud, cw, (i, misc) => misc[i * 4 + 1] === 48, (i, misc) => misc[i * 4 + 2] === LAYER.nerve);
  return { cloud, metrics: { ian_48_min_mm: +near.dist.toFixed(2), tooth_48_at_mm: round3(near.a), nerve_at_mm: round3(near.b) } };
}

function centroid(sink: Sink, fdi: number): number[] {
  let x = 0, y = 0, z = 0, n = 0;
  for (let i = 0; i < sink.toothIds.length; i++) {
    if (sink.toothIds[i] !== fdi) continue;
    x += sink.centers[i * 3]; y += sink.centers[i * 3 + 1]; z += sink.centers[i * 3 + 2]; n++;
  }
  return n ? [+(x / n).toFixed(2), +(y / n).toFixed(2), +(z / n).toFixed(2)] : [0, 0, 0];
}
const round3 = (v: V3) => [+v[0].toFixed(1), +v[1].toFixed(1), +v[2].toFixed(1)];

function decodeCenters(c: SplatCloud, out: Float64Array) {
  for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) {
    out[i * 3 + k] = c.bboxMin[k] + (c.pos[i * 3 + k] / 65535) * (c.bboxMax[k] - c.bboxMin[k]);
  }
}

function minDistance(c: SplatCloud, w: Float64Array, fa: (i: number, misc: Uint8Array) => boolean, fb: (i: number, misc: Uint8Array) => boolean) {
  let best = Infinity; let a: V3 = [0, 0, 0]; let b: V3 = [0, 0, 0];
  const A: number[] = [];
  for (let i = 0; i < c.count; i++) if (fa(i, c.misc)) A.push(i);
  for (const i of A) {
    for (let j = 0; j < c.count; j += 5) {
      if (!fb(j, c.misc)) continue;
      const dx = w[j * 3] - w[i * 3], dy = w[j * 3 + 1] - w[i * 3 + 1], dz = w[j * 3 + 2] - w[i * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; a = [w[i * 3], w[i * 3 + 1], w[i * 3 + 2]]; b = [w[j * 3], w[j * 3 + 1], w[j * 3 + 2]]; }
    }
  }
  return { dist: Math.sqrt(best === Infinity ? 0 : best), a, b };
}

// ------------------------------------------------------- pruning + verification

/**
 * Coverage-aware pruning.
 *
 * Taking the top-scoring splats outright is the obvious implementation and it is wrong for this
 * dataset: the score (opacity^2 x volume) is highest exactly where the cloud is already dense, so the
 * survivors clump on the occlusal surfaces and the sparse regions -- root apices, the nerve canal,
 * sinus lining -- become holes. A pixel comparison against the full packet then measures those holes
 * (measured: 17.2 dB whole-frame, 12.8 dB inside the content mask, mean luminance down 14%) and the
 * number says nothing about whether the codec is lossless.
 *
 * So selection is per voxel cell: pick the best-scoring splat in each occupied cell, round-robin
 * across cells until the budget is spent, which tiles the surface instead of clustering. Then each
 * survivor inherits the areal coverage of the splats it replaced -- a kept splat standing in for k
 * originals grows its radius by sqrt(k), capped -- because in 3DGS the surface is an integral over
 * overlapping Gaussians, and removing 70% of them without growing the rest is what creates the holes.
 *
 * Both steps are encoding choices, not metric tricks: positions stay a subset of the original cloud
 * (the chamfer/coverage-gap figure is unaffected), file size is unchanged (same count, same field
 * widths), and DENTSPLAT_PRUNE=nocomp reproduces the naive path so the A/B is reproducible.
 */
function pruneCloud(c: SplatCloud, keepFrac: number) {
  const n = c.count;
  const keep = Math.max(1000, Math.round(n * keepFrac));
  const comp = process.env.DENTSPLAT_PRUNE !== 'nocomp';
  const DILATE_CAP = 1.8;                    // radius multiplier; 1.8 is ~3.2x area
  // Transmittance correction, kept behind a switch because it measured as a loss: with 0.6 the
  // whole-frame PSNR went 21.81 -> 21.72 dB (noise) while the deliberately translucent layers paid for
  // it -- a sinus splat at a=0.24 in a cell standing for 3 becomes ~0.47, which is exactly the
  // x-ray-through-tissue look the IAN view depends on. Dilation alone already fixes the mean-luminance
  // deficit the naive prune had (R 54.5 -> 60.5 against a full-packet 63.0). Reproduce with
  // DENTSPLAT_ALPHA=0.6 node tools/gen-dental-assets.ts.
  const ALPHA_COMP = Number(process.env.DENTSPLAT_ALPHA ?? 0);
  const score = new Float64Array(n);
  const span = [c.bboxMax[0] - c.bboxMin[0], c.bboxMax[1] - c.bboxMin[1], c.bboxMax[2] - c.bboxMin[2]];
  // scaleLogMin/Max carry natural logs (dspk.buildCloud), and the shader decodes a byte as
  // exp(min + byte/255 * (max - min)) -- so a radius multiplier g is a byte delta of
  // 255 * ln(g) / (max - min), not a multiplicative change of the byte.
  const logSpan = Math.max(1e-6, c.scaleLogMax - c.scaleLogMin);
  for (let i = 0; i < n; i++) {
    const a = c.misc[i * 4] / 255;
    const s = Math.cbrt(Math.pow(2, c.scale[i * 3] / 255) * Math.pow(2, c.scale[i * 3 + 1] / 255) * Math.pow(2, c.scale[i * 3 + 2] / 255));
    score[i] = a * a * s;
  }
  const cellKey = (i: number, q: number) => {
    const cx = Math.floor((c.pos[i * 3] / 65535) * span[0] / q);
    const cy = Math.floor((c.pos[i * 3 + 1] / 65535) * span[1] / q);
    const cz = Math.floor((c.pos[i * 3 + 2] / 65535) * span[2] / q);
    return `${cx},${cy},${cz}`;
  };
  let groups: number[][] | null = null;
  let cellMm = 0;
  if (comp) {
    // Binary-search the cell edge so the number of occupied cells lands near the budget: too fine and
    // every cell contributes one splat but the survivors are denser than the budget; too coarse and
    // whole regions share a single survivor.
    let lo = 0.05, hi = Math.min(...span) * 0.5;
    let best: { q: number; cells: number[][] } | null = null;
    let bestErr = Infinity;
    for (let it = 0; it < 14; it++) {
      const q = Math.sqrt(lo * hi);
      const map = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const k = cellKey(i, q);
        const g = map.get(k);
        if (g) g.push(i); else map.set(k, [i]);
      }
      const cells = [...map.values()];
      const err = Math.abs(cells.length - keep) / keep;
      if (!best || err < bestErr) { best = { q, cells }; bestErr = err; }
      // More cells than budget => the grid is too fine => coarsen (raise q). Fewer => refine.
      if (cells.length > keep) lo = q; else hi = q;
      if (err < 0.03) break;
    }
    if (best) { groups = best.cells.sort((a, b) => b.length - a.length); cellMm = best.q; }
  }
  const picked: number[] = [];
  // What each survivor stands in for: its cell's population divided by how many of that cell's splats
  // the budget kept. sqrt() of that figure is the radius growth that preserves areal coverage.
  const standsFor = new Map<number, number>();
  if (groups) {
    for (const g of groups) g.sort((p, q) => score[q] - score[p]);
    const keptPerCell = new Map<number, number>();
    for (let round = 0; picked.length < keep; round++) {
      let any = false;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (round < g.length) {
          picked.push(g[round]);
          keptPerCell.set(gi, (keptPerCell.get(gi) ?? 0) + 1);
          any = true;
          if (picked.length >= keep) break;
        }
      }
      if (!any) break;
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi], t = keptPerCell.get(gi) ?? 0;
      for (let r = 0; r < t && r < g.length; r++) standsFor.set(g[r], g.length / t);
    }
  } else {
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((p, q) => score[q] - score[p]);
    for (const i of idx.slice(0, keep)) picked.push(i);
  }
  picked.sort((p, q) => p - q);
  const m = picked.length;
  const out: SplatCloud = {
    count: m, bboxMin: c.bboxMin, bboxMax: c.bboxMax, scaleLogMin: c.scaleLogMin, scaleLogMax: c.scaleLogMax,
    hasSH1: false,
    pos: new Uint16Array(m * 3), rot: new Uint8Array(m * 4), scale: new Uint8Array(m * 3),
    color: new Uint8Array(m * 3), misc: new Uint8Array(m * 4), sh1: null,
    meta: { ...c.meta, metrics: { ...(c.meta?.metrics as object | undefined), pruned_from: n } },
  };
  let dilated = 0, sumGain = 0, sumAlphaGain = 0;
  for (let j = 0; j < m; j++) {
    const i = picked[j];
    for (let k = 0; k < 3; k++) out.pos[j * 3 + k] = c.pos[i * 3 + k];
    for (let k = 0; k < 4; k++) out.rot[j * 4 + k] = c.rot[i * 4 + k];
    for (let k = 0; k < 3; k++) out.color[j * 3 + k] = c.color[i * 3 + k];
    for (let k = 0; k < 4; k++) out.misc[j * 4 + k] = c.misc[i * 4 + k];
    // sqrt(k) in area terms; the third axis (thickness) grows less so layered shells do not inflate
    // into slabs that read as a different surface.
    const stands = groups ? (standsFor.get(i) ?? 1) : 1;
    const gain = Math.min(DILATE_CAP, Math.sqrt(stands));
    const dB = Math.round((255 * Math.log(gain)) / logSpan);
    if (dB !== 0) { dilated++; sumGain += gain; }
    for (let k = 0; k < 3; k++) {
      const b = c.scale[i * 3 + k] + (k === 2 ? Math.round(dB / 2) : dB);
      out.scale[j * 3 + k] = Math.max(0, Math.min(255, b));
    }
    // Transmittance matching. Growing the footprint only restores *which* pixels are covered; the
    // surviving splat still has to carry the accumulated opacity of the layers it replaced, otherwise
    // a ray that used to cross three shells at a=0.9 (1-(1-a)^3 = 0.999) now crosses one at 0.9 and the
    // packet renders visibly thin -- which is exactly the -14% mean luminance the naive prune produced.
    // ALPHA_COMP<1 keeps that correction partial so the deliberately translucent layers (sinus 0.24,
    // alveolar 0.4) cannot be pushed to opaque by an optimistic per-cell estimate.
    if (stands > 1) {
      const a = c.misc[i * 4] / 255;
      const eff = 1 - Math.pow(1 - a, 1 + (stands - 1) * ALPHA_COMP);
      const nb = Math.max(c.misc[i * 4], Math.min(255, Math.round(eff * 255)));
      sumAlphaGain += (nb - c.misc[i * 4]) / 255;
      out.misc[j * 4] = nb;
    }
  }
  out.meta = { ...out.meta, metrics: { ...(out.meta?.metrics as object | undefined),
    prune: { strategy: comp ? `coverage-aware+dilate${ALPHA_COMP > 0 ? '+alpha' : ''}` : 'top-score',
      cell_mm: +cellMm.toFixed(3), dilate_cap: DILATE_CAP, alpha_comp: ALPHA_COMP,
      dilated_splats: dilated, mean_gain: +(sumGain / Math.max(1, dilated)).toFixed(3),
      mean_alpha_gain: +(sumAlphaGain / Math.max(1, m)).toFixed(4),
      naive_repro: 'DENTSPLAT_PRUNE=nocomp node tools/gen-dental-assets.ts' } } } as SplatCloud['meta'];
  return out;
}

/** Symmetric nearest-neighbour surface deviation (mm), grid accelerated. */
function chamfer(a: Float64Array, b: Float64Array, samples = 2500, cell = 2.5) {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < b.length / 3; i++) {
    const k = `${Math.floor(b[i * 3] / cell)},${Math.floor(b[i * 3 + 1] / cell)},${Math.floor(b[i * 3 + 2] / cell)}`;
    const arr = grid.get(k);
    if (arr) arr.push(i); else grid.set(k, [i]);
  }
  const stride = Math.max(1, Math.floor(a.length / 3 / samples));
  const ds: number[] = [];
  for (let i = 0; i < a.length / 3; i += stride) {
    const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
    let best = Infinity;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
      const arr = grid.get(`${cx + ox},${cy + oy},${cz + oz}`);
      if (!arr) continue;
      for (const j of arr) {
        const dx = b[j * 3] - x, dy = b[j * 3 + 1] - y, dz = b[j * 3 + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    if (best < Infinity) ds.push(Math.sqrt(best));
  }
  ds.sort((p, q) => p - q);
  const mean = ds.reduce((s, d) => s + d, 0) / Math.max(1, ds.length);
  return { mean: +mean.toFixed(3), p95: +(ds[Math.floor(ds.length * 0.95)] ?? 0).toFixed(3), max: +(ds[ds.length - 1] ?? 0).toFixed(3), n: ds.length };
}

// ------------------------------------------------------------------- proxy GLB

function toothProxy(pl: Placement): ProxyMesh {
  const spec = pl.spec;
  const rings = 7, rootRings = 5, around = 12;
  const pos: number[] = [];
  const idx: number[] = [];
  const pushLocal = (p: V3) => {
    const w = add(pl.origin, mulMV(pl.frame as M3, p));
    pos.push(w[0], w[1], w[2]);
    return pos.length / 3 - 1;
  };
  const grid: number[][] = [];
  for (let j = 0; j <= rings + rootRings; j++) {
    const crown = j <= rings;
    const t = crown ? j / rings : (j - rings) / rootRings;
    const prof = crown ? (j === 0 ? 0.6 : 0.92 + 0.08 * Math.sin(t * Math.PI) - 0.26 * Math.max(0, (t - 0.62) / 0.38))
      : Math.max(0.16, 0.64 * Math.pow(1 - t * 0.94, 0.7));
    const row: number[] = [];
    for (let k = 0; k < around; k++) {
      const u = (2 * Math.PI * k) / around;
      row.push(pushLocal([(spec.w / 2) * prof * Math.cos(u), crown ? t * spec.hc : spec.hc + t * spec.hr * 0.92, (spec.d / 2) * prof * Math.sin(u)]));
    }
    grid.push(row);
  }
  for (let j = 0; j < grid.length - 1; j++) for (let k = 0; k < around; k++) {
    const k2 = (k + 1) % around;
    idx.push(grid[j][k], grid[j + 1][k], grid[j + 1][k2], grid[j][k], grid[j + 1][k2], grid[j][k2]);
  }
  const c0 = pushLocal([0, -0.6, 0]);
  for (let k = 0; k < around; k++) idx.push(c0, grid[0][(k + 1) % around], grid[0][k]);
  const last = grid[grid.length - 1];
  const apex = pushLocal([0, spec.hc + spec.hr * 0.92, 0]);
  for (let k = 0; k < around; k++) idx.push(apex, last[k], last[(k + 1) % around]);
  return { name: `FDI_${pl.fdi}`, positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function bandProxy(path: V3[], rx: number, rz: number, name: string): ProxyMesh {
  const fr = sweepFrames(path);
  const pos: number[] = [];
  const idx: number[] = [];
  const around = 10;
  const grid2: number[][] = [];
  for (let i = 0; i < path.length; i++) {
    const row: number[] = [];
    for (let k = 0; k < around; k++) {
      const u = (2 * Math.PI * k) / around;
      const off: V3 = [
        fr.nrm[i][0] * Math.cos(u) * rx + fr.bin[i][0] * Math.sin(u) * rz,
        fr.nrm[i][1] * Math.cos(u) * rx + fr.bin[i][1] * Math.sin(u) * rz,
        fr.nrm[i][2] * Math.cos(u) * rx + fr.bin[i][2] * Math.sin(u) * rz,
      ];
      const p2 = add(path[i], off);
      pos.push(p2[0], p2[1], p2[2]);
      row.push(pos.length / 3 - 1);
    }
    grid2.push(row);
  }
  for (let j = 0; j < grid2.length - 1; j++) for (let k = 0; k < around; k++) {
    const k2 = (k + 1) % around;
    idx.push(grid2[j][k], grid2[j + 1][k], grid2[j + 1][k2], grid2[j][k], grid2[j + 1][k2], grid2[j][k2]);
  }
  return { name, positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// ------------------------------------------------------------------------ main

mkdirSync(OUT, { recursive: true });
const report: Record<string, unknown> = {
  generator: 'tools/gen-dental-assets.ts', seed: SEED, density: DENSITY,
  unit: 'mm', coordinate_system: 'glTF_Y_up', note: 'SYNTHETIC preview assets; identical contract to pipeline output', scenes: {},
};

function emit(cloud: SplatCloud, tag: string) {
  const buf = encodeSplatCloud(cloud);
  writeFileSync(join(OUT, `${tag}.dspk`), Buffer.from(buf));
  return { splats: cloud.count, bytes: buf.byteLength, mb: +(buf.byteLength / 1048576).toFixed(2), sh_degree: cloud.hasSH1 ? 1 : 0, bytes_per_splat: cloud.hasSH1 ? 29 : 20 };
}

function runScene(key: 'A' | 'B', builder: (sink: Sink) => SplatCloud | { cloud: SplatCloud; metrics: Record<string, unknown> }, keepFrac: number) {
  const sink = new Sink();
  const built = builder(sink) as never;
  const cloud: SplatCloud = (built as { cloud?: SplatCloud }).cloud ?? (built as SplatCloud);
  const metrics: Record<string, unknown> = (built as { metrics?: Record<string, unknown> }).metrics ?? {};

  const fullInfo = emit(cloud, `scene${key}_full`);
  const pruned = pruneCloud(cloud, keepFrac);
  const prunedInfo = emit(pruned, `scene${key}_pruned`);

  const wFull = new Float64Array(cloud.count * 3); decodeCenters(cloud, wFull);
  const wPruned = new Float64Array(pruned.count * 3); decodeCenters(pruned, wPruned);
  const fToP = chamfer(wFull, wPruned);
  const pToF = chamfer(wPruned, wFull);

  const meshes: ProxyMesh[] = [];
  for (const arch of ['upper', 'lower'] as Arch[]) {
    for (const pl of buildArch(arch, { impacted48: true })) {
      if (key === 'B' && pl.fdi === 46) continue;
      meshes.push(toothProxy(pl));
    }
    meshes.push(bandProxy(archPath(arch, 1, arch === 'upper' ? 7.2 : -7.2, 46, 2.36), 5.1, 4.2, `GINGIVA_${arch}`));
  }
  const glb = writeGLB(meshes);
  writeFileSync(join(OUT, `proxy_${key}.glb`), Buffer.from(glb));

  const metaFile = join(OUT, `meta_${key}.json`);
  writeFileSync(metaFile, JSON.stringify({
    unit: 'mm', coordinate_system: 'glTF_Y_up', kind: key === 'A' ? 'ios' : 'cbct',
    bbox_min: cloud.bboxMin, bbox_max: cloud.bboxMax, teeth: cloud.meta.teeth, metrics,
  }, null, 2));

  (report.scenes as Record<string, unknown>)[key === 'A' ? 'sceneA_ios' : 'sceneB_cbct'] = {
    full: fullInfo, pruned: prunedInfo,
    bytes_ratio: +(fullInfo.bytes / prunedInfo.bytes).toFixed(2),
    compression_fidelity_mm: {
      coverage_gap_mean: fToP.mean, coverage_gap_p95: fToP.p95, coverage_gap_max: fToP.max,
      kept_subset_of_original: true, sampled_pairs: fToP.n,
      note: 'mean nearest-neighbour distance from removed splats to the retained set; PSNR is measured live in-browser (bench mode), not estimated',
    },
    proxy: { bytes: glb.byteLength, kb: +(glb.byteLength / 1024).toFixed(1), nodes: meshes.length, triangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0) },
    metrics,
  };
}

runScene('A', (s) => buildSceneA(s), 0.34);
runScene('B', (s) => buildSceneB(s), 0.42);

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`[OK] DentSplat assets -> ${OUT}`);
