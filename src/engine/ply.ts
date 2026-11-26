import { LAYER, buildCloud, type SplatCloud } from './dspk.ts';

const SH_C0 = 0.28209479177387814;
const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

type PlyProp = { name: string; type: string; size: number };
type PlyHeader = {
  format: 'ascii' | 'binary_little_endian';
  vertexCount: number;
  props: PlyProp[];
  offsets: Record<string, number>;
  stride: number;
  bodyOffset: number;
};

function readHeader(bytes: Uint8Array): PlyHeader {
  const limit = Math.min(bytes.length, 1 << 20);
  let chars = '';
  let end = -1;
  for (let i = 0; i < limit; i++) {
    chars += String.fromCharCode(bytes[i]);
    if (bytes[i] === 10) {
      const lineStart = chars.lastIndexOf('\n', chars.length - 2) + 1;
      if (chars.slice(lineStart, chars.length - 1).replace(/\r$/, '') === 'end_header') {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('PLY: 找不到 end_header');
  const lines = chars.slice(0, end).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('PLY: 首行不是 ply');
  const fmt = /^format\s+(\S+)\s+1\.0$/.exec(lines[1] ?? '');
  if (!fmt || (fmt[1] !== 'ascii' && fmt[1] !== 'binary_little_endian')) {
    throw new Error(`PLY: 仅支持 ascii 或 binary_little_endian，收到 ${lines[1] ?? '?'}`);
  }
  let vertexCount = -1;
  let inVertex = false;
  const props: PlyProp[] = [];
  for (const line of lines.slice(2)) {
    const tok = line.split(/\s+/);
    if (tok[0] === 'element') {
      inVertex = tok[1] === 'vertex';
      if (inVertex) {
        vertexCount = Number(tok[2]);
        if (!Number.isInteger(vertexCount) || vertexCount < 0) throw new Error('PLY: vertex 数无效');
      }
      continue;
    }
    if (tok[0] === 'property' && inVertex) {
      if (tok[1] === 'list') throw new Error('PLY: vertex 属性不支持 list');
      const size = TYPE_SIZE[tok[1]];
      if (!size) throw new Error(`PLY: 未知标量类型 ${tok[1]}`);
      props.push({ name: tok[2], type: tok[1], size });
    }
  }
  if (!props.length) throw new Error('PLY: 没有 vertex 属性');
  const offsets: Record<string, number> = {};
  let stride = 0;
  for (const p of props) { offsets[p.name] = stride; stride += p.size; }
  return { format: fmt[1] as PlyHeader['format'], vertexCount, props, offsets, stride, bodyOffset: end };
}

export type PlyParseResult = {
  cloud: SplatCloud;
  info: {
    format: string;
    vertexCount: number;
    stride: number;
    fields: string[];
    shDegree: number;
    gaussianFields: boolean;
    colorSource: 'f_dc' | 'rgb';
    scaleDecoded: boolean;
    twoScale2dgs?: boolean;
  };
};

/**
 * Browser-side parser for the two PLY dialects a 3DGS trainer emits:
 *  - binary_little_endian / ascii, scalar vertex properties only
 *  - x y z, f_dc_*, opacity, scale_*, rot_* and optional f_rest_* (SH)
 *  - simple xyz + red/green/blue/alpha point clouds as an explicit isotropic fallback
 *
 * The cloud keeps the original float attributes in `raw`, so the renderer does not
 * quantise them into DSPK only to pretend it is high precision.
 */
export function parseGaussianPly(buffer: ArrayBuffer, fileName = 'local.ply'): PlyParseResult {
  const bytes = new Uint8Array(buffer);
  const h = readHeader(bytes);
  if (!h.vertexCount) throw new Error('PLY: vertexCount = 0');
  const binary = h.format === 'binary_little_endian';
  const body = bytes.subarray(h.bodyOffset);
  const need = h.vertexCount * h.stride;
  if (binary && body.byteLength < need) {
    throw new Error(`PLY: 顶点数据不完整 (有 ${body.byteLength} B, 需要 ${need} B)`);
  }
  const dv = binary ? new DataView(body.buffer, body.byteOffset, body.byteLength) : null;
  const ascii = binary ? null : new TextDecoder('latin1').decode(body).trim().split(/\s+/);

  const has = (name: string) => h.offsets[name] !== undefined;
  const get = (i: number, name: string): number => {
    const o = h.offsets[name];
    if (o === undefined) return NaN;
    if (dv) {
      const p = h.props.find((q) => q.name === name)!;
      const at = i * h.stride + o;
      switch (p.type) {
        case 'float': case 'float32': return dv.getFloat32(at, true);
        case 'double': case 'float64': return dv.getFloat64(at, true);
        case 'uchar': case 'uint8': return dv.getUint8(at);
        case 'char': case 'int8': return dv.getInt8(at);
        case 'ushort': case 'uint16': return dv.getUint16(at, true);
        case 'short': case 'int16': return dv.getInt16(at, true);
        case 'uint': case 'uint32': return dv.getUint32(at, true);
        default: return dv.getInt32(at, true);
      }
    }
    if (!ascii) return NaN;
    return Number(ascii[i * h.props.length + h.props.findIndex((q) => q.name === name)]);
  };

  const n = h.vertexCount;
  const hasDC = has('f_dc_0') && has('f_dc_1') && has('f_dc_2');
  const hasRGB = has('red') && has('green') && has('blue');
  const hasThreeScales = has('scale_0') && has('scale_1') && has('scale_2');
  const hasTwoScales = has('scale_0') && has('scale_1') && !has('scale_2');
  const hasScale = hasThreeScales || hasTwoScales;
  const hasRot = has('rot_0') && has('rot_1') && has('rot_2') && has('rot_3');
  const hasOpacity = has('opacity');
  const hasAlphaByte = has('alpha');
  const restCount = h.props.filter((p) => p.name.startsWith('f_rest_')).length;
  const shDegree = restCount >= 45 ? 3 : restCount >= 24 ? 2 : restCount >= 9 ? 1 : 0;

  const centers = new Float32Array(n * 3);
  const quats = new Float32Array(n * 4);
  const scales = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const alphas = new Float32Array(n);
  const sh1 = shDegree >= 1 ? new Float32Array(n * 9) : null;
  const shRest = restCount > 0 ? new Float32Array(n * restCount) : null;

  let fallbackSigma = 0.2;
  if (!hasScale) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      const v = get(i, ['x', 'y', 'z'][k]);
      if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    fallbackSigma = Math.max(0.05, diag / Math.max(1, Math.cbrt(n)) * 0.35);
  }

  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      centers[i * 3 + k] = finite(get(i, ['x', 'y', 'z'][k]), 0);
      if (hasThreeScales) {
        scales[i * 3 + k] = Math.max(1e-4, finite(Math.exp(get(i, `scale_${k}`)), fallbackSigma));
      } else if (hasTwoScales) {
        const a = Math.max(1e-4, finite(Math.exp(get(i, 'scale_0')), fallbackSigma));
        const b = Math.max(1e-4, finite(Math.exp(get(i, 'scale_1')), fallbackSigma));
        scales[i * 3] = a;
        scales[i * 3 + 1] = b;
        scales[i * 3 + 2] = Math.max(1e-4, Math.min(a, b) * 0.01);
      } else {
        scales[i * 3 + k] = fallbackSigma;
      }
      colors[i * 3 + k] = hasDC
        ? Math.min(1, Math.max(0, 0.5 + SH_C0 * finite(get(i, `f_dc_${k}`), 0)))
        : hasRGB
          ? Math.min(1, Math.max(0, finite(get(i, ['red', 'green', 'blue'][k]), 220) / 255))
          : 0.8;
    }
    const qw = hasRot ? finite(get(i, 'rot_0'), 1) : 1;
    const qx = hasRot ? finite(get(i, 'rot_1'), 0) : 0;
    const qy = hasRot ? finite(get(i, 'rot_2'), 0) : 0;
    const qz = hasRot ? finite(get(i, 'rot_3'), 0) : 0;
    const qn = Math.hypot(qx, qy, qz, qw) || 1;
    quats[i * 4] = qx / qn; quats[i * 4 + 1] = qy / qn;
    quats[i * 4 + 2] = qz / qn; quats[i * 4 + 3] = qw / qn;
    alphas[i] = hasOpacity
      ? 1 / (1 + Math.exp(-finite(get(i, 'opacity'), 6)))
      : hasAlphaByte ? Math.min(1, Math.max(0, finite(get(i, 'alpha'), 255) / 255)) : 1;
    if (shRest) {
      for (let k = 0; k < restCount; k++) shRest[i * restCount + k] = finite(get(i, `f_rest_${k}`), 0);
    }
    if (sh1) for (let k = 0; k < 9; k++) sh1[i * 9 + k] = shRest ? shRest[i * restCount + k] : 0;
  }

  const cloud = buildCloud({
    centers, quats, scales, colors, alphas,
    toothIds: new Uint8Array(n),
    layerIds: new Uint8Array(n).fill(LAYER.other),
    flags: new Uint8Array(n),
    sh1: sh1 ?? undefined,
    meta: {
      name: fileName,
      kind: 'ios',
      unit: 'unknown',
      source: 'local PLY',
      note: hasTwoScales
        ? '官方 2DGS 双切向尺度；第三轴使用 1% viewer-only 薄厚度，未冒充训练出的厚度。'
        : hasScale
          ? '原始 FP32 高斯属性，未经过 DSPK 量化；PLY 无 FDI/解剖层语义。'
          : '简单点云 PLY；无 scale/rot 字段，使用各向同性显示尺度。',
      ply: {
        format: h.format, fields: h.props.map((p) => p.name), stride: h.stride,
        sh_degree: shDegree, gaussian_fields: hasScale && hasRot,
      },
    },
  });
  cloud.raw = {
    centers, quats, scales, colors, alphas, sh1, shRest, shRestCount: restCount, shDegree,
    sourceFormat: hasTwoScales ? '2DGS PLY · FP32 + declared thin axis' : hasScale && hasRot ? '3DGS PLY · FP32' : 'Point PLY · isotropic fallback',
  };
  return {
    cloud,
    info: {
      format: h.format, vertexCount: n, stride: h.stride,
      fields: h.props.map((p) => p.name), shDegree,
      gaussianFields: hasScale && hasRot,
      colorSource: hasDC ? 'f_dc' : 'rgb',
      scaleDecoded: hasScale,
      twoScale2dgs: hasTwoScales,
    },
  };
}
