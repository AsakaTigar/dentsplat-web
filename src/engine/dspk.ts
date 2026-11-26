/**
 * DentSplat Packet (DSPK) v1 — a purpose-built, in-band-semantic container for
 * browser-resident 3D Gaussian Splatting of dental scenes.
 *
 * Why another container when .ply / .ksplat / .spz exist:
 *  1. Every public web splat packer (ksplat, spz) Morton-orders splats for GPU cache
 *     locality, which silently invalidates any side-car label array indexed by row.
 *     Here the per-splat semantics (FDI tooth id, anatomical layer, jaw flags) live in
 *     the same plane stream as the geometry, in the same order, so alignment is
 *     structural rather than assumed.
 *  2. Attributes are quantised to exactly the budget a dental arcade needs:
 *     16-bit position inside a millimetre bbox, 8-bit unit quaternion, 8-bit log-scale,
 *     8-bit DC colour + 6-bit-sign SH1, i.e. 29 B/splat with view-dependent lighting,
 *     20 B/splat without it (the "pruned / SH0" transport variant used for the
 *     bandwidth comparison slider).
 *
 * Layout (little-endian):
 *   [0,128)      fixed header
 *   [128,128+M)  UTF-8 JSON metadata (length in header)
 *   then attribute planes, count*stride each, in this order:
 *     pos      u16 x3   (bbox-normalised, decode by lerp)
 *     rot      u8  x4   (snorm -1..1, renormalised on decode)
 *     scale    u8  x3   (log-space lerp between scaleLogMin/Max)
 *     color    u8  x3   (linear display colour from SH DC term)
 *     misc     u8  x4   (alpha, toothId, layerId, flags)
 *     sh1      i8  x9   (optional; coefficient * 64)
 */

export const DSPK_MAGIC = 0x4b505344; // 'DSPK' as LE u32
export const DSPK_HEADER_BYTES = 128;
export const DSPK_FLAG_HAS_SH1 = 1;
export const DSPK_STRIDE_BASE = 20;
export const DSPK_STRIDE_SH1 = 29;

/** Anatomical / material layer codes. Kept byte-identical to pipeline LAYER_CODES. */
export const LAYER = {
  gingiva: 0,
  enamel: 1,
  root: 2,
  alveolar: 3,
  nerve: 4,
  other: 5,
  pulp: 6,
  sinus: 7,
  restoration: 8,
} as const;
export type LayerName = keyof typeof LAYER;

export const FLAG = {
  upperJaw: 1,
  lowerJaw: 2,
  lesion: 4,
  impacted: 8,
  cutCapEligible: 16,
} as const;

export const LAYER_RGB: Record<number, [number, number, number]> = {
  [LAYER.gingiva]: [198, 108, 112],
  [LAYER.enamel]: [238, 232, 216],
  [LAYER.root]: [226, 214, 190],
  [LAYER.alveolar]: [206, 196, 176],
  [LAYER.nerve]: [250, 204, 60],
  [LAYER.other]: [150, 150, 150],
  [LAYER.pulp]: [226, 86, 96],
  [LAYER.sinus]: [120, 160, 210],
  [LAYER.restoration]: [186, 196, 206],
};

export type SplatMeta = {
  name?: string;
  kind?: 'ios' | 'cbct';
  unit?: string;
  /** FDI -> display/clinical data, injected by the generator or by ply2dspk. */
  teeth?: Record<string, { fdi: number; arch?: string; centroid_mm?: number[]; layer?: string }>;
  metrics?: Record<string, number | string>;
  [k: string]: unknown;
};

/** Float attributes retained only when the source itself is float (an imported 3DGS PLY).
 *  DSPK packets leave this undefined: decoding their bytes into floats would invent precision. */
export type RawSplatData = {
  centers: Float32Array;
  quats: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
  sh1: Float32Array | null;
  shDegree: number;
  sourceFormat: string;
};

export type SplatCloud = {
  count: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  scaleLogMin: number;
  scaleLogMax: number;
  hasSH1: boolean;
  pos: Uint16Array;
  rot: Uint8Array;
  scale: Uint8Array;
  color: Uint8Array;
  misc: Uint8Array;
  sh1: Int8Array | null;
  meta: SplatMeta;
  raw?: RawSplatData;
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function encodeSplatCloud(c: SplatCloud): ArrayBuffer {
  const stride = c.hasSH1 ? DSPK_STRIDE_SH1 : DSPK_STRIDE_BASE;
  const metaBytes = new TextEncoder().encode(JSON.stringify(c.meta ?? {}));
  const n = c.count;
  const buf = new ArrayBuffer(DSPK_HEADER_BYTES + metaBytes.length + n * stride);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(0, DSPK_MAGIC, true);
  dv.setUint8(4, 1);
  dv.setUint8(5, c.hasSH1 ? DSPK_FLAG_HAS_SH1 : 0);
  dv.setUint8(6, c.hasSH1 ? 1 : 0);
  dv.setUint8(7, stride);
  dv.setUint32(8, n, true);
  for (let i = 0; i < 3; i++) {
    dv.setFloat32(12 + i * 4, c.bboxMin[i], true);
    dv.setFloat32(24 + i * 4, c.bboxMax[i], true);
  }
  dv.setFloat32(36, c.scaleLogMin, true);
  dv.setFloat32(40, c.scaleLogMax, true);
  dv.setUint32(44, metaBytes.length, true);
  const name = (c.meta?.name ?? 'dent').slice(0, 63);
  for (let i = 0; i < 64; i++) u8[48 + i] = i < name.length ? name.charCodeAt(i) : 0;
  dv.setUint32(112, c.meta?.kind === 'cbct' ? 1 : 0, true);
  u8.set(metaBytes, DSPK_HEADER_BYTES);

  let o = DSPK_HEADER_BYTES + metaBytes.length;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) dv.setUint16(o + k * 2, c.pos[i * 3 + k], true);
    for (let k = 0; k < 4; k++) u8[o + 6 + k] = c.rot[i * 4 + k];
    for (let k = 0; k < 3; k++) u8[o + 10 + k] = c.scale[i * 3 + k];
    for (let k = 0; k < 3; k++) u8[o + 13 + k] = c.color[i * 3 + k];
    for (let k = 0; k < 4; k++) u8[o + 16 + k] = c.misc[i * 4 + k];
    if (c.hasSH1 && c.sh1) for (let k = 0; k < 9; k++) u8[o + 20 + k] = c.sh1[i * 9 + k] & 0xff;
    o += stride;
  }
  return buf;
}

export function decodeSplatCloud(buf: ArrayBuffer): SplatCloud {
  const dv = new DataView(buf);
  if (dv.byteLength < DSPK_HEADER_BYTES) throw new Error('DSPK: buffer shorter than header');
  if (dv.getUint32(0, true) !== DSPK_MAGIC) throw new Error('DSPK: bad magic');
  const version = dv.getUint8(4);
  if (version !== 1) throw new Error(`DSPK: unsupported version ${version}`);
  const hasSH1 = (dv.getUint8(5) & DSPK_FLAG_HAS_SH1) !== 0;
  const stride = dv.getUint8(7);
  const count = dv.getUint32(8, true);
  const bboxMin = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)] as [number, number, number];
  const bboxMax = [dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)] as [number, number, number];
  const scaleLogMin = dv.getFloat32(36, true);
  const scaleLogMax = dv.getFloat32(40, true);
  const metaLen = dv.getUint32(44, true);
  const kindIsCbct = dv.getUint32(112, true) === 1;
  const nameBytes = new Uint8Array(buf, 48, 64);
  let name = '';
  for (let i = 0; i < 64 && nameBytes[i]; i++) name += String.fromCharCode(nameBytes[i]);
  const expect = DSPK_HEADER_BYTES + metaLen + count * stride;
  if (dv.byteLength < expect) {
    throw new Error(`DSPK: truncated payload (have ${dv.byteLength}, need ${expect})`);
  }
  let meta: SplatMeta = {};
  try {
    meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, DSPK_HEADER_BYTES, metaLen))) as SplatMeta;
  } catch {
    meta = {};
  }
  if (!meta.kind) meta.kind = kindIsCbct ? 'cbct' : 'ios';
  if (!meta.name) meta.name = name;

  const pos = new Uint16Array(count * 3);
  const rot = new Uint8Array(count * 4);
  const scale = new Uint8Array(count * 3);
  const color = new Uint8Array(count * 3);
  const misc = new Uint8Array(count * 4);
  const sh1 = hasSH1 ? new Int8Array(count * 9) : null;

  const base = DSPK_HEADER_BYTES + metaLen;
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    const u8p = new Uint8Array(buf, o, stride);
    pos[i * 3] = u8p[0] | (u8p[1] << 8);
    pos[i * 3 + 1] = u8p[2] | (u8p[3] << 8);
    pos[i * 3 + 2] = u8p[4] | (u8p[5] << 8);
    for (let k = 0; k < 4; k++) rot[i * 4 + k] = u8p[6 + k];
    for (let k = 0; k < 3; k++) scale[i * 3 + k] = u8p[10 + k];
    for (let k = 0; k < 3; k++) color[i * 3 + k] = u8p[13 + k];
    for (let k = 0; k < 4; k++) misc[i * 4 + k] = u8p[16 + k];
    if (sh1) for (let k = 0; k < 9; k++) sh1[i * 9 + k] = u8p[20 + k] << 24 >> 24;
  }
  return { count, bboxMin, bboxMax, scaleLogMin, scaleLogMax, hasSH1, pos, rot, scale, color, misc, sh1, meta };
}

/** Decode helper: world-space mm centre of splat i. */
export function splatCenter(c: SplatCloud, i: number, out: [number, number, number]): [number, number, number] {
  for (let k = 0; k < 3; k++) {
    const t = c.pos[i * 3 + k] / 65535;
    out[k] = c.bboxMin[k] + t * (c.bboxMax[k] - c.bboxMin[k]);
  }
  return out;
}

/** Build a SplatCloud from float arrays (used by the generator and by ply2dspk). */
type FloatInput = Float32Array | Float64Array | number[];

export function buildCloud(input: {
  centers: FloatInput;
  quats: FloatInput;
  scales: FloatInput;
  colors: FloatInput;
  alphas: FloatInput;
  toothIds: Uint8Array | number[];
  layerIds: Uint8Array | number[];
  flags: Uint8Array | number[];
  sh1?: FloatInput;
  meta?: SplatMeta;
  scaleRange?: [number, number];
}): SplatCloud {
  const n = input.alphas.length;
  const g = (a: FloatInput | Uint8Array, i: number) => a[i] as number;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = g(input.centers, i * 3), y = g(input.centers, i * 3 + 1), z = g(input.centers, i * 3 + 2);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const pad = 0.5;
  const bboxMin: [number, number, number] = [minX - pad, minY - pad, minZ - pad];
  const bboxMax: [number, number, number] = [maxX + pad, maxY + pad, maxZ + pad];
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < n * 3; i++) {
    const s = Math.max(1e-4, g(input.scales, i));
    if (s < sMin) sMin = s; if (s > sMax) sMax = s;
  }
  if (input.scaleRange) { sMin = input.scaleRange[0]; sMax = input.scaleRange[1]; }
  const logMin = Math.log(sMin), logMax = Math.log(sMax);

  const pos = new Uint16Array(n * 3), rot = new Uint8Array(n * 4), scale = new Uint8Array(n * 3);
  const color = new Uint8Array(n * 3), misc = new Uint8Array(n * 4);
  const hasSH1 = !!input.sh1;
  const sh1 = hasSH1 ? new Int8Array(n * 9) : null;

  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const span = bboxMax[k] - bboxMin[k];
      const t = span > 1e-6 ? (g(input.centers, i * 3 + k) - bboxMin[k]) / span : 0.5;
      pos[i * 3 + k] = clamp(Math.round(t * 65535), 0, 65535);
    }
    let qx = g(input.quats, i * 4), qy = g(input.quats, i * 4 + 1);
    let qz = g(input.quats, i * 4 + 2), qw = g(input.quats, i * 4 + 3);
    const norm = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= norm; qy /= norm; qz /= norm; qw /= norm;
    rot[i * 4] = clamp(Math.round((qx * 0.5 + 0.5) * 255), 0, 255);
    rot[i * 4 + 1] = clamp(Math.round((qy * 0.5 + 0.5) * 255), 0, 255);
    rot[i * 4 + 2] = clamp(Math.round((qz * 0.5 + 0.5) * 255), 0, 255);
    rot[i * 4 + 3] = clamp(Math.round((qw * 0.5 + 0.5) * 255), 0, 255);
    for (let k = 0; k < 3; k++) {
      const ls = Math.log(Math.max(1e-4, g(input.scales, i * 3 + k)));
      const t = (ls - logMin) / Math.max(1e-6, logMax - logMin);
      scale[i * 3 + k] = clamp(Math.round(t * 255), 0, 255);
    }
    for (let k = 0; k < 3; k++) color[i * 3 + k] = clamp(Math.round(g(input.colors, i * 3 + k) * 255), 0, 255);
    misc[i * 4] = clamp(Math.round(g(input.alphas, i) * 255), 0, 255);
    misc[i * 4 + 1] = input.toothIds[i];
    misc[i * 4 + 2] = input.layerIds[i];
    misc[i * 4 + 3] = input.flags[i];
    if (sh1) for (let k = 0; k < 9; k++) sh1[i * 9 + k] = clamp(Math.round(g(input.sh1!, i * 9 + k) * 64), -127, 127);
  }
  return {
    count: n, bboxMin, bboxMax, scaleLogMin: logMin, scaleLogMax: logMax, hasSH1,
    pos, rot, scale, color, misc, sh1, meta: input.meta ?? {},
  };
}

export function strideOf(c: SplatCloud): number {
  return c.hasSH1 ? DSPK_STRIDE_SH1 : DSPK_STRIDE_BASE;
}

export function bytesOf(c: SplatCloud): number {
  return DSPK_HEADER_BYTES + new TextEncoder().encode(JSON.stringify(c.meta ?? {})).length + c.count * strideOf(c);
}
