/** Dental anatomy model: arch layout, per-FDI crown/root metrics, and an analytic
 *  crown/root surface that both the Gaussian sampler and the invisible picking proxy
 *  are generated FROM, so the two can never drift apart.
 *
 *  World frame (identical to the offline pipeline contract):
 *    Y-up, 1 unit = 1 mm, occlusal plane parallel to XZ, maxilla at +Y, lips at +Z.
 *    Radiological convention: patient's right is -X, so Q1/Q4 (upper/lower right) sit at x<0.
 *
 *  Crown metrics are the mean permanent-tooth mesiodistal / buccolingual widths and
 *  crown+root lengths from standard dental anatomy tables (Wheeler's / Constantines &
 *  Ford 2013 aggregate), rounded to 0.1 mm. They are an anatomical prior, not a
 *  measurement of any real patient case.
 */

import {
  add, mat3FromCols, mulMV, norm, quatAxisAngle, quatFromMat3, rotX, rotZ,
  type M3, type Quat, type V3,
} from './geom.ts';

export type Arch = 'upper' | 'lower';

export type ToothSpec = {
  /** mesiodistal width (mm) */ w: number;
  /** buccolingual depth (mm) */ d: number;
  /** cervix-to-occlusal crown height (mm) */ hc: number;
  /** cervix-to-apex root length (mm) */ hr: number;
  cuspCount: number;
  rootCount: number;
  /** labiolingual crown tipping about the mesiodistal axis, degrees */ tip: number;
  /** mesiodistal inclination, degrees */ rot: number;
  /** roundedness of the cross-section (2 = ellipse, >2 = rounded box) */ p: number;
};

// FDI position index 1..8 from the midline: central, lateral, canine, PM1, PM2, M1, M2, M3.
const UPPER: ToothSpec[] = [
  { w: 8.5, d: 7.1, hc: 10.5, hr: 13.0, cuspCount: 0, rootCount: 1, tip: 12, rot: 4, p: 2.4 },
  { w: 6.5, d: 6.3, hc: 9.0, hr: 13.0, cuspCount: 0, rootCount: 1, tip: 10, rot: 2, p: 2.4 },
  { w: 7.5, d: 8.0, hc: 10.0, hr: 17.0, cuspCount: 1, rootCount: 1, tip: 8, rot: -2, p: 2.6 },
  { w: 7.0, d: 7.2, hc: 8.5, hr: 14.0, cuspCount: 2, rootCount: 2, tip: 2, rot: -4, p: 3.0 },
  { w: 6.5, d: 7.3, hc: 8.5, hr: 14.5, cuspCount: 2, rootCount: 3, tip: 1, rot: -6, p: 3.0 },
  { w: 10.0, d: 11.3, hc: 7.5, hr: 12.0, cuspCount: 4, rootCount: 3, tip: 0, rot: -8, p: 3.4 },
  { w: 9.5, d: 10.3, hc: 7.0, hr: 11.5, cuspCount: 4, rootCount: 3, tip: -1, rot: -10, p: 3.4 },
  { w: 9.0, d: 9.8, hc: 6.8, hr: 11.0, cuspCount: 3, rootCount: 3, tip: -2, rot: -12, p: 3.4 },
];
const LOWER: ToothSpec[] = [
  { w: 5.2, d: 6.0, hc: 9.0, hr: 12.5, cuspCount: 0, rootCount: 1, tip: -6, rot: -3, p: 2.4 },
  { w: 6.0, d: 6.6, hc: 9.5, hr: 12.5, cuspCount: 0, rootCount: 1, tip: -5, rot: -2, p: 2.4 },
  { w: 6.8, d: 7.5, hc: 10.5, hr: 15.0, cuspCount: 1, rootCount: 1, tip: -4, rot: 0, p: 2.6 },
  { w: 7.0, d: 7.7, hc: 8.5, hr: 13.5, cuspCount: 2, rootCount: 2, tip: -2, rot: 2, p: 3.0 },
  { w: 7.2, d: 8.0, hc: 8.0, hr: 14.0, cuspCount: 2, rootCount: 2, tip: -1, rot: 3, p: 3.0 },
  { w: 11.0, d: 10.4, hc: 7.5, hr: 13.5, cuspCount: 5, rootCount: 2, tip: 0, rot: 4, p: 3.4 },
  { w: 10.5, d: 10.0, hc: 7.3, hr: 13.0, cuspCount: 5, rootCount: 2, tip: 0, rot: 5, p: 3.4 },
  { w: 10.0, d: 9.5, hc: 7.0, hr: 12.5, cuspCount: 4, rootCount: 2, tip: 1, rot: 6, p: 3.4 },
];

export const toothSpec = (arch: Arch, pos: number): ToothSpec => (arch === 'upper' ? UPPER : LOWER)[pos - 1];

export const fdiOf = (arch: Arch, side: 'right' | 'left', pos: number): number => {
  const quadrant = arch === 'upper' ? (side === 'right' ? 1 : 2) : side === 'left' ? 3 : 4;
  return quadrant * 10 + pos;
};

export type Placement = {
  fdi: number;
  arch: Arch;
  pos: number;
  side: 'right' | 'left';
  /** CEJ centre in world mm */
  origin: V3;
  /** columns: [mesiodistal tangent, crown->root axis, buccal radial] */
  frame: M3;
  quat: Quat;
  spec: ToothSpec;
  /** occlusal-plane height of the CEJ (mm) */
  cejY: number;
};

type ArchShape = { A: number; B: number; height: number };
const SHAPE: Record<Arch, ArchShape> = {
  upper: { A: 32.5, B: 33.5, height: 0 },
  lower: { A: 28.5, B: 30.5, height: 0 },
};

function ellipsePoint(shape: ArchShape, phi: number): { p: V3; tan: V3; rad: V3 } {
  const { A, B } = shape;
  const p: V3 = [A * Math.sin(phi), 0, B * Math.cos(phi)];
  const tan = norm([A * Math.cos(phi), 0, -B * Math.sin(phi)]);
  const rad = norm([p[0], 0, p[2] * 0.82 + 4]);
  return { p, tan, rad };
}

/** Walk the arch from the midline, spacing teeth by their real mesiodistal widths. */
export function buildArch(arch: Arch, opts: { skipThirdMolar?: boolean; impacted48?: boolean } = {}): Placement[] {
  const shape = SHAPE[arch];
  const out: Placement[] = [];
  for (const side of ['right', 'left'] as const) {
    const mirror = side === 'right' ? -1 : 1; // patient's right is -X
    let phi = 0.055;
    let prevHalf = 0;
    for (let pos = 1; pos <= 8; pos++) {
      if (opts.skipThirdMolar && pos === 8) continue;
      const spec = toothSpec(arch, pos);
      const half = spec.w / 2;
      const rEst = Math.hypot(shape.A * Math.sin(phi), shape.B * Math.cos(phi)) || shape.A;
      phi += (prevHalf + half) / (rEst * 0.93);
      prevHalf = half;

      const { p, tan } = ellipsePoint(shape, phi);
      const origin: V3 = [mirror * p[0], 0, p[2]];
      const tang = norm([mirror * tan[0], 0, tan[2]]);
      const radial = norm([mirror * p[0], 0, p[2] * 0.86 + 3.5]);
      const up: V3 = arch === 'upper' ? [0, 1, 0] : [0, -1, 0];

      const tip = spec.tip + (opts.impacted48 && pos === 8 && side === 'right' && arch === 'lower' ? -55 : 0);
      let frame = mat3FromCols(tang, up, radial);
      frame = mulFrame(frame, rotX((tip * Math.PI) / 180), rotZ((mirror * spec.rot * Math.PI) / 180));

      const cejY = arch === 'upper' ? spec.hc : -spec.hc;
      out.push({
        fdi: fdiOf(arch, side, pos), arch, pos, side,
        origin: [origin[0], 0, origin[2]],
        frame, quat: quatFromMat3(frame), spec, cejY,
      });
    }
  }
  return out;
}

function mulFrame(f: M3, ...ms: M3[]): M3 {
  let o = f;
  for (const m of ms) {
    o = [
      o[0] * m[0] + o[1] * m[3] + o[2] * m[6], o[0] * m[1] + o[1] * m[4] + o[2] * m[7], o[0] * m[2] + o[1] * m[5] + o[2] * m[8],
      o[3] * m[0] + o[4] * m[3] + o[5] * m[6], o[3] * m[1] + o[4] * m[4] + o[5] * m[7], o[3] * m[2] + o[4] * m[5] + o[5] * m[8],
      o[6] * m[0] + o[7] * m[3] + o[8] * m[6], o[6] * m[1] + o[7] * m[4] + o[8] * m[7], o[6] * m[2] + o[7] * m[5] + o[8] * m[8],
    ];
  }
  return o;
}

/** Crown width profile from the occlusal table (t=0) to the cervix (t=1). */
function crownProfile(t: number): number {
  if (t < 0.32) return 0.86 + (t / 0.32) * 0.14;
  if (t < 0.62) return 1.0;
  return 1.0 - ((t - 0.62) / 0.38) * 0.26;
}
/** Root radius profile from the cervix (t=0) to the apex (t=1). */
function rootProfile(t: number): number {
  return Math.max(0.12, 0.66 * Math.pow(1 - t, 0.72) - 0.06 * t);
}
/** Rounded-square cross-section factor: 1/(|cos|^p + |sin|^p)^(1/p). */
function crossSection(u: number, p: number): number {
  const c = Math.abs(Math.cos(u)), s = Math.abs(Math.sin(u));
  return 1 / Math.max(1e-6, Math.pow(Math.pow(c, p) + Math.pow(s, p), 1 / p));
}

export type Sample = {
  center: V3;
  normal: V3;
  /** tangential splat radius (mm) and thickness (mm) */
  radius: number;
  thickness: number;
  quat: Quat;
  color: [number, number, number];
  alpha: number;
  layer: number;
  flags: number;
};

export type ToothLook = {
  enamel: [number, number, number];
  dentin: [number, number, number];
  rootColor: [number, number, number];
  /** per-splat colour jitter */
  jitter: number;
};

export type SampleSink = { push: (s: Sample) => void };

/**
 * Sample a tooth into tangentially-oriented disc splats.
 * `shellLayers` > 1 insets concentric shells so a clipping plane reveals dentine and
 * pulp instead of a hollow eggshell — the single most convincing detail in a cut view.
 */
export function sampleTooth(
  sink: SampleSink,
  pl: Placement,
  opts: {
    rings?: number; around?: number; shellLayers?: number; shellGap?: number;
    splatScale?: number; alpha?: number; look?: ToothLook; rng: () => number;
    root?: boolean; pulp?: boolean; lesion?: 'occlusal-caries' | 'white-spot' | 'calculus' | null;
    layerEnamel?: number; layerRoot?: number; layerPulp?: number; layerInner?: number;
    occlusalGap?: number; cap?: boolean;
  },
): void {
  const spec = pl.spec;
  const rings = opts.rings ?? 15;
  const around = opts.around ?? 22;
  const layers = opts.shellLayers ?? 2;
  const gap = opts.shellGap ?? 0.42;
  const sc = opts.splatScale ?? 1.15;
  const alpha = opts.alpha ?? 0.94;
  const look = opts.look ?? { enamel: [0.93, 0.90, 0.84], dentin: [0.82, 0.74, 0.60], rootColor: [0.86, 0.82, 0.72], jitter: 0.03 };
  const layerEnamel = opts.layerEnamel ?? 1;
  const layerRoot = opts.layerRoot ?? 2;
  const layerPulp = opts.layerPulp ?? 6;
  const rng = opts.rng;
  const jj = look.jitter;
  const arc = (2 * Math.PI) / around;
  const ringStep = spec.hc / Math.max(1, rings - 1);
  const baseScale = Math.max(arc * ((spec.w + spec.d) / 4) * 0.5, ringStep) * sc;

  for (let L = 0; L < layers; L++) {
    const inset = L * gap;
    const wF = Math.max(0.12, 1 - inset / Math.max(spec.w, spec.d) * 1.8);
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const prof = crownProfile(t);
      for (let k = 0; k < around; k++) {
        const u = (2 * Math.PI * k) / around + (j % 2) * (Math.PI / around);
        const cs = crossSection(u, spec.p);
        const hw = (spec.w / 2) * prof * cs * wF;
        const hd = (spec.d / 2) * prof * cs * wF;
        // occlusal topography: cusp ridges rise toward the occlusal surface
        let dy = 0;
        if (spec.cuspCount > 0 && t < 0.34) {
          dy = -0.95 * Math.max(0, Math.cos((spec.cuspCount / 2) * u)) * (1 - t / 0.34);
        } else if (spec.cuspCount === 0 && t < 0.12) {
          dy = -0.4 * (1 - t / 0.12);
        }
        const nx = Math.cos(u) / Math.max(hw, 1e-3);
        const nz = Math.sin(u) / Math.max(hd, 1e-3);
        const nl = Math.hypot(nx, nz, 0.18);
        const localP: V3 = [hw * Math.cos(u), (t * spec.hc + dy) - (opts.occlusalGap ?? 0), hd * Math.sin(u)];
        const localN = norm([nx / nl, 0.18 / nl, nz / nl]);
        const worldP = add(pl.origin, mulMV(pl.frame, localP));
        const worldN = norm(mulMV(pl.frame, localN));
        const spin = rng() * Math.PI;
        const q = quatMulLocal(pl.quat, quatAxisAngle([0, 1, 0], spin));

        let base: [number, number, number] = L === 0 ? look.enamel : look.dentin;
        let flags = 0;
        if (L === 0) {
          const shade = 0.72 + 0.28 * Math.max(0, worldN[2] * 0.6 + worldN[1] * 0.35);
          base = [base[0] * shade, base[1] * shade, base[2] * shade];
          if (spec.cuspCount > 0 && t < 0.2) {
            const pit = Math.abs(Math.sin((spec.cuspCount / 2) * u));
            base = [base[0] * (1 - 0.16 * pit), base[1] * (1 - 0.19 * pit), base[2] * (1 - 0.2 * pit)];
          }
          if (t > 0.8) base = [base[0] * 0.96, base[1] * 0.93, base[2] * 0.87];
        }
        let col: [number, number, number] = [
          base[0] + (rng() - 0.5) * jj, base[1] + (rng() - 0.5) * jj, base[2] + (rng() - 0.5) * jj,
        ];

        if (L === 0 && opts.lesion === 'occlusal-caries' && t < 0.3 && Math.abs(Math.sin((spec.cuspCount / 2 || 1) * u)) > 0.45) {
          col = [0.32 + rng() * 0.07, 0.24 + rng() * 0.05, 0.15 + rng() * 0.04];
          flags |= 4;
        }
        if (L === 0 && opts.lesion === 'white-spot' && t > 0.62 && t < 0.86) {
          col = [0.97, 0.97, 0.95];
          flags |= 4;
        }
        if (L === 0 && opts.lesion === 'calculus' && t > 0.86) {
          col = [0.83, 0.75, 0.47];
          flags |= 4;
        }

        sink.push({
          center: worldP, normal: worldN,
          radius: baseScale * (1 - 0.25 * t) * (0.9 + rng() * 0.2),
          thickness: 0.16 + rng() * 0.05,
          quat: q, color: clamp3(col),
          alpha: L === 0 ? alpha : 0.8,
          layer: L === 0 ? layerEnamel : (opts.layerInner ?? layerEnamel), flags: flags | jawBit(pl.arch),
        });
      }
    }

    // Occlusal table: without this cap the crown is an open tube and the
    // Upper/Lower Occlusal preset views show a hollow shell.
    if (opts.cap !== false) {
      const cRings = 4, cAround = around;
      for (let a = 0; a <= cRings; a++) {
        const rr = a / cRings;
        for (let k = 0; k < cAround; k++) {
          const u = (2 * Math.PI * k) / cAround + (a % 2) * (Math.PI / cAround);
          const cs = crossSection(u, spec.p);
          const hw = (spec.w / 2) * crownProfile(0) * cs * wF * rr;
          const hd = (spec.d / 2) * crownProfile(0) * cs * wF * rr;
          let dy = 0;
          if (spec.cuspCount > 0) dy = -0.95 * Math.max(0, Math.cos((spec.cuspCount / 2) * u));
          const localP: V3 = [hw * Math.cos(u), dy - (opts.occlusalGap ?? 0), hd * Math.sin(u)];
          const worldP = add(pl.origin, mulMV(pl.frame, localP));
          const upSign = archUpSign(pl.arch);
          const col: [number, number, number] = L === 0
            ? [look.enamel[0] * 0.9, look.enamel[1] * 0.88, look.enamel[2] * 0.84]
            : [look.dentin[0] * 0.94, look.dentin[1] * 0.92, look.dentin[2] * 0.9];
          sink.push({
            center: worldP, normal: mulMV(pl.frame, [0, -upSign, 0]),
            radius: baseScale * 0.95, thickness: 0.16,
            quat: quatMulLocal(pl.quat, quatAxisAngle([0, 1, 0], rng() * Math.PI)),
            color: clamp3(col), alpha: L === 0 ? alpha : 0.8,
            layer: L === 0 ? layerEnamel : (opts.layerInner ?? layerEnamel),
            flags: jawBit(pl.arch) | ((opts.lesion === 'occlusal-caries' && L === 0 && rr < 0.6) ? 4 : 0),
          });
        }
      }
    }
  }

  if (opts.root !== false) {
    const rootRings = opts.rings ? Math.max(5, Math.round(rings * 0.6)) : 9;
    const rootAround = Math.max(10, Math.round(around * 0.7));
    const rStep = spec.hr / rootRings;
    const roots = spec.rootCount;
    for (let ri = 0; ri < roots; ri++) {
      const off = roots === 1 ? [0, 0] : [Math.cos((2 * Math.PI * ri) / roots + 0.4) * spec.w * 0.16, Math.sin((2 * Math.PI * ri) / roots + 0.4) * spec.d * 0.16];
      for (let j = 1; j <= rootRings; j++) {
        const t = j / rootRings;
        const prof = rootProfile(t);
        for (let k = 0; k < rootAround; k++) {
          const u = (2 * Math.PI * k) / rootAround + (j % 2) * (Math.PI / rootAround);
          const cs = crossSection(u, spec.p);
          const hw = (spec.w / 2) * prof * cs * 0.9;
          const hd = (spec.d / 2) * prof * cs * 0.9;
          const localP: V3 = [hw * Math.cos(u) + off[0], spec.hc + t * spec.hr, hd * Math.sin(u) + off[1]];
          const localN = norm([Math.cos(u) / Math.max(hw, 1e-3), -0.22, Math.sin(u) / Math.max(hd, 1e-3)]);
          const worldP = add(pl.origin, mulMV(pl.frame, localP));
          const worldN = norm(mulMV(pl.frame, localN));
          const col: [number, number, number] = [
            look.rootColor[0] * (1 - 0.25 * t) + (rng() - 0.5) * jj,
            look.rootColor[1] * (1 - 0.27 * t) + (rng() - 0.5) * jj,
            look.rootColor[2] * (1 - 0.3 * t) + (rng() - 0.5) * jj,
          ];
          sink.push({
            center: worldP, normal: worldN,
            radius: Math.max(rStep, (2 * Math.PI * Math.max(hw, hd)) / rootAround) * sc * 0.55,
            thickness: 0.16,
            quat: quatMulLocal(pl.quat, quatAxisAngle([0, 1, 0], rng() * Math.PI)),
            color: clamp3(col), alpha: 0.9, layer: layerRoot, flags: jawBit(pl.arch),
          });
        }
      }
      void rStep;
    }
  }

  if (opts.pulp) {
    const chamber: V3 = [0, spec.hc * 0.52, 0];
    const p = add(pl.origin, mulMV(pl.frame, chamber));
    for (const d of fibDirs(24)) {
      sink.push({
        center: add(p, mulMV(pl.frame, [d[0] * spec.w * 0.16, d[1] * spec.hc * 0.14, d[2] * spec.d * 0.14])),
        normal: d, radius: 0.42, thickness: 0.2,
        quat: pl.quat, color: [0.86, 0.28, 0.32], alpha: 0.85,
        layer: layerPulp, flags: jawBit(pl.arch),
      });
    }
    for (let ri = 0; ri < spec.rootCount; ri++) {
      for (let j = 1; j <= 7; j++) {
        const t = j / 8;
        const localP: V3 = [0, spec.hc + t * spec.hr * 0.82, 0];
        sink.push({
          center: add(pl.origin, mulMV(pl.frame, localP)),
          normal: [0, 1, 0], radius: 0.3 * (1 - t * 0.6), thickness: 0.16,
          quat: pl.quat, color: [0.82, 0.3, 0.34], alpha: 0.8,
          layer: layerPulp, flags: jawBit(pl.arch),
        });
      }
    }
  }
}

function archUpSign(arch: Arch): number {
  return arch === 'upper' ? 1 : -1;
}

function jawBit(arch: Arch): number {
  return arch === 'upper' ? 1 : 2;
}

/** Quaternion multiply in the tooth's local frame (spin about its own long axis). */
function quatMulLocal(parent: Quat, local: Quat): Quat {
  return [
    parent[3] * local[0] + parent[0] * local[3] + parent[1] * local[2] - parent[2] * local[1],
    parent[3] * local[1] - parent[0] * local[2] + parent[1] * local[3] + parent[2] * local[0],
    parent[3] * local[2] + parent[0] * local[1] - parent[1] * local[0] + parent[2] * local[3],
    parent[3] * local[3] - parent[0] * local[0] - parent[1] * local[1] - parent[2] * local[2],
  ];
}

function clamp3(c: [number, number, number]): [number, number, number] {
  return [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(0, c[1])), Math.min(1, Math.max(0, c[2]))];
}

function fibDirs(n: number): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = ga * i;
    out.push([r * Math.cos(th), z, r * Math.sin(th)]);
  }
  return out;
}

export { crownProfile, crossSection, rootProfile, mulMV, norm, add, quatMulLocal, clamp3, archUpSign };
