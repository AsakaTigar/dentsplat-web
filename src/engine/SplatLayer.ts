import * as THREE from 'three';
import { SPLAT_FRAGMENT, SPLAT_VERTEX } from './shaders.ts';
import { LAYER, type SplatCloud } from './dspk.ts';
import { principalAxes, covarianceOf, quatToMat3, type GaussianInspect, type GaussianState, type Quat, type Vec3 } from './gaussian.ts';

const BINS = 1 << 14;

/** Far-to-near counting sort of splat centres for one view direction.
 *  Returns the number of splats in front of the near plane. */
export class SplatSorter {
  private counts = new Int32Array(BINS + 1);
  private order: Uint32Array;
  constructor(public count: number) {
    this.order = new Uint32Array(count);
  }
  get lastOrder() { return this.order; }

  sort(centers: Float32Array, m: Float32Array, margin = 400): number {
    const n = this.count;
    const counts = this.counts;
    const order = this.order;
    counts.fill(0);
    const e0 = m[0], e1 = m[1], e2 = m[2], e3 = m[3];
    let dMin = Infinity; let dMax = -Infinity;
    const depths = this.depths.length >= n ? this.depths : (this.depths = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const d = -(e0 * centers[i * 3] + e1 * centers[i * 3 + 1] + e2 * centers[i * 3 + 2] + e3);
      depths[i] = d;
      if (d < 0.02 || d > margin) { counts[0]++; continue; }
      const b = 1 + Math.min(BINS - 1, Math.floor((d / margin) * (BINS - 1)));
      counts[b]++;
    }
    // running start offsets for descending depth (draw far first)
    let acc = 0;
    for (let b = BINS; b >= 1; b--) {
      const c = counts[b];
      counts[b] = acc;
      acc += c;
    }
    const visible = acc;
    for (let i = 0; i < n; i++) {
      const d = depths[i];
      if (d < 0.02 || d > margin) continue;
      const b = 1 + Math.min(BINS - 1, Math.floor((d / margin) * (BINS - 1)));
      order[counts[b]++] = i;
    }
    return visible;
  }
  private depths = new Float32Array(0);
}

export type LayerStats = { splats: number; visible: number; sortMs: number; bytes: number };

export class SplatLayer {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly centers: Float32Array;
  private sorter: SplatSorter;
  private indexAttr: THREE.BufferAttribute;
  private lastKey = '';
  private lastSort = 0;
  private sh3Tex: THREE.DataTexture | null = null;
  visible = 0;
  forceDirty = true;

  constructor(public cloud: SplatCloud, opts: { opacityScale?: number } = {}) {
    const n = cloud.count;
    const raw = cloud.raw;
    this.centers = new Float32Array(n * 3);
    const aCenter = new Float32Array(n * 4 * 3);
    const aRot = new Uint8Array(n * 4 * 4);
    const aScale = new Uint8Array(n * 4 * 3);
    const aColor = new Uint8Array(n * 4 * 3);
    const aMisc = new Uint8Array(n * 4 * 4);
    const aSH1 = new Int8Array(n * 4 * 9);
    const aRotF = raw ? new Float32Array(n * 4 * 4) : null;
    const aScaleAlphaF = raw ? new Float32Array(n * 4 * 4) : null;
    const aColorF = raw ? new Float32Array(n * 4 * 3) : null;
    const aSH1F = raw?.sh1 ? new Float32Array(n * 4 * 9) : null;

    const { bboxMin, bboxMax, pos, rot, scale, color, misc, hasSH1, sh1 } = cloud;
    const span = [bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]];
    for (let i = 0; i < n; i++) {
      const cx = raw ? raw.centers[i * 3] : bboxMin[0] + (pos[i * 3] / 65535) * span[0];
      const cy = raw ? raw.centers[i * 3 + 1] : bboxMin[1] + (pos[i * 3 + 1] / 65535) * span[1];
      const cz = raw ? raw.centers[i * 3 + 2] : bboxMin[2] + (pos[i * 3 + 2] / 65535) * span[2];
      this.centers[i * 3] = cx; this.centers[i * 3 + 1] = cy; this.centers[i * 3 + 2] = cz;
      const v = i * 4;
      for (let k = 0; k < 4; k++) {
        aCenter[(v + k) * 3] = cx; aCenter[(v + k) * 3 + 1] = cy; aCenter[(v + k) * 3 + 2] = cz;
        aRot[(v + k) * 4] = rot[i * 4]; aRot[(v + k) * 4 + 1] = rot[i * 4 + 1];
        aRot[(v + k) * 4 + 2] = rot[i * 4 + 2]; aRot[(v + k) * 4 + 3] = rot[i * 4 + 3];
        for (let c = 0; c < 3; c++) {
          aScale[(v + k) * 3 + c] = scale[i * 3 + c];
          aColor[(v + k) * 3 + c] = color[i * 3 + c];
          if (aScaleAlphaF && raw) aScaleAlphaF[(v + k) * 4 + c] = raw.scales[i * 3 + c];
          if (aColorF && raw) aColorF[(v + k) * 3 + c] = raw.colors[i * 3 + c];
        }
        if (aRotF && raw) {
          for (let c = 0; c < 4; c++) aRotF[(v + k) * 4 + c] = raw.quats[i * 4 + c];
        }
        if (aScaleAlphaF && raw) aScaleAlphaF[(v + k) * 4 + 3] = raw.alphas[i];
        for (let c = 0; c < 4; c++) aMisc[(v + k) * 4 + c] = misc[i * 4 + c];
        if (hasSH1 && sh1) for (let c = 0; c < 9; c++) aSH1[(v + k) * 9 + c] = sh1[i * 9 + c];
        if (aSH1F && raw?.sh1) for (let c = 0; c < 9; c++) aSH1F[(v + k) * 9 + c] = raw.sh1[i * 9 + c];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
    geo.setAttribute('aMisc', new THREE.BufferAttribute(aMisc, 4));
    if (raw) {
      geo.setAttribute('aRotF', new THREE.BufferAttribute(aRotF!, 4));
      geo.setAttribute('aScaleAlphaF', new THREE.BufferAttribute(aScaleAlphaF!, 4));
      geo.setAttribute('aColorF', new THREE.BufferAttribute(aColorF!, 3));
      if (aSH1F) geo.setAttribute('aSH1F', new THREE.BufferAttribute(aSH1F, 9));
    } else {
      geo.setAttribute('aRot', new THREE.BufferAttribute(aRot, 4, true));
      geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
      // mat3 in the shader = 3 attribute locations of vec3 over the same 9-byte record, so the
      // vertex count stays n*4 like every other plane (itemSize 3 here would silently give count n*12)
      geo.setAttribute('aSH1', new THREE.BufferAttribute(aSH1, 9));
    }

    const index = new Uint32Array(n * 6);
    this.indexAttr = new THREE.BufferAttribute(index, 1);
    geo.setIndex(this.indexAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e4);
    this.geometry = geo;

    if (raw?.shRest && raw.shRestCount >= 45) {
      const width = 1024, texels = 12;
      const height = Math.max(1, Math.ceil(n * texels / width));
      const data = new Float32Array(width * height * 4);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 45; k++) {
          const idx = i * texels + (k >> 2);
          data[idx * 4 + (k & 3)] = raw.shRest[i * raw.shRestCount + k];
        }
      }
      this.sh3Tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
      this.sh3Tex.minFilter = THREE.NearestFilter;
      this.sh3Tex.magFilter = THREE.NearestFilter;
      this.sh3Tex.generateMipmaps = false;
      this.sh3Tex.needsUpdate = true;
    }

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: raw ? { RAW_PLY: 1, ...(this.sh3Tex ? { SH3: 1 } : {}) } : {},
      vertexShader: SPLAT_VERTEX,
      fragmentShader: SPLAT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      // the fragment stage writes premultiplied colour, so the alpha channel needs its own
      // equation or a composited overlay gets double-multiplied
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      side: THREE.DoubleSide,
      uniforms: {
        uViewportPx: { value: new THREE.Vector2(1, 1) },
        uScaleRange: { value: new THREE.Vector2(cloud.scaleLogMin, cloud.scaleLogMax - cloud.scaleLogMin) },
        uSH1Scale: { value: 1 / 64 },
        uSigmas: { value: 2.6 },
        uJawGap: { value: 0 },
        uSheen: { value: hasSH1 ? 1 : 0 },
        uExposure: { value: 1.06 },
        uSelectedTooth: { value: 0 },
        uPulseTooth: { value: 0 },
        uPulse: { value: 0 },
        uHiddenLo: { value: 0 },
        uHiddenHi: { value: 0 },
        uClipCount: { value: 0 },
        uClipPlanes: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uClipBand: { value: 0.9 },
        uCapEnable: { value: 1 },
        uLayerAlpha: { value: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
        uCapTint: { value: new THREE.Color(0.72, 0.6, 0.46) },
        uHighlight: { value: new THREE.Color(0x38bdf8) },
        uLesionColor: { value: new THREE.Color(0xf97316) },
        uOpacityScale: { value: opts.opacityScale ?? 1 },
        uDebug: { value: 0 },
        uVisMode: { value: 0 },
        uOutline: { value: 0.9 },
        uShowLesions: { value: 1 },
        uInspectIndex: { value: -1 },
        uInspectOnly: { value: 0 },
        uSHTex: { value: this.sh3Tex },
        uSHTexWidth: { value: 1024 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.matrixAutoUpdate = false;
    this.sorter = new SplatSorter(n);
    this.visible = n;
  }

  get u() { return this.material.uniforms; }

  setLayerAlpha(name: number, v: number) {
    const arr = this.u.uLayerAlpha.value as number[];
    arr[name] = v;
  }
  setLayerAlphas(map: Record<number, number>) {
    const arr = this.u.uLayerAlpha.value as number[];
    for (const [k, v] of Object.entries(map)) arr[Number(k)] = v;
  }
  setHidden(fdis: Iterable<number>) {
    let lo = 0, hi = 0;
    for (const f of fdis) {
      if (f <= 0) continue;
      if (f < 32) lo |= 1 << (f & 31); else hi |= 1 << (f - 32);
    }
    this.u.uHiddenLo.value = lo >>> 0;
    this.u.uHiddenHi.value = hi >>> 0;
  }
  setClipPlanes(planes: THREE.Vector4[], band: number, cap: boolean) {
    const arr = this.u.uClipPlanes.value as THREE.Vector4[];
    for (let i = 0; i < 4; i++) {
      if (i < planes.length) arr[i].copy(planes[i]);
    }
    this.u.uClipCount.value = Math.min(4, planes.length);
    this.u.uClipBand.value = band;
    this.u.uCapEnable.value = cap ? 1 : 0;
    this.forceDirty = true;
  }
  setSelected(fdi: number, pulse = 0) {
    this.u.uSelectedTooth.value = fdi;
    this.u.uPulse.value = pulse;
  }
  setPulse(fdi: number, pulse: number) {
    this.u.uPulseTooth.value = fdi;
    this.u.uPulse.value = pulse;
  }

  stateOf(i: number): GaussianState | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const c = this.cloud, raw = c.raw;
    const center: Vec3 = [this.centers[i * 3], this.centers[i * 3 + 1], this.centers[i * 3 + 2]];
    let quat: [number, number, number, number];
    let scales: Vec3;
    let alpha: number;
    let color: Vec3;
    if (raw) {
      quat = [raw.quats[i * 4], raw.quats[i * 4 + 1], raw.quats[i * 4 + 2], raw.quats[i * 4 + 3]];
      scales = [raw.scales[i * 3], raw.scales[i * 3 + 1], raw.scales[i * 3 + 2]];
      alpha = raw.alphas[i];
      color = [raw.colors[i * 3], raw.colors[i * 3 + 1], raw.colors[i * 3 + 2]];
    } else {
      quat = [
        c.rot[i * 4] / 255 * 2 - 1, c.rot[i * 4 + 1] / 255 * 2 - 1,
        c.rot[i * 4 + 2] / 255 * 2 - 1, c.rot[i * 4 + 3] / 255 * 2 - 1,
      ];
      const ls = c.scaleLogMax - c.scaleLogMin;
      scales = [0, 1, 2].map((k) => Math.exp(c.scaleLogMin + (c.scale[i * 3 + k] / 255) * ls)) as Vec3;
      alpha = c.misc[i * 4] / 255;
      color = [c.color[i * 3] / 255, c.color[i * 3 + 1] / 255, c.color[i * 3 + 2] / 255];
    }
    const qn = Math.hypot(...quat) || 1;
    quat = quat.map((q) => q / qn) as [number, number, number, number];
    const sh1 = raw?.sh1
      ? Array.from(raw.sh1.subarray(i * 9, i * 9 + 9))
      : c.sh1 ? Array.from(c.sh1.subarray(i * 9, i * 9 + 9), (v) => v / 64) : null;
    const shRestCount = raw?.shRestCount ?? 0;
    const shRest = raw?.shRest
      ? Array.from(raw.shRest.subarray(i * shRestCount, i * shRestCount + shRestCount))
      : null;
    return {
      index: i, center, scales, quat, alpha, color,
      fdi: c.misc[i * 4 + 1], layer: c.misc[i * 4 + 2],
      sh1, shRest, shRestCount, shDegree: raw?.shDegree ?? (c.hasSH1 ? 1 : 0),
      precision: raw ? 'fp32' : 'dspk-8bit',
    };
  }

  inspect(i: number): GaussianInspect | null {
    const s = this.stateOf(i);
    if (!s) return null;
    return {
      ...s,
      covariance: covarianceOf(s.scales, s.quat),
      rotation: quatToMat3(s.quat),
      axes: principalAxes(s.scales, s.quat),
    };
  }

  setSplatPosition(i: number, center: Vec3): Vec3 | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const c = this.cloud;
    let actual: Vec3;
    if (c.raw) {
      actual = [...center] as Vec3;
      for (let k = 0; k < 3; k++) c.raw.centers[i * 3 + k] = actual[k];
    } else {
      const span = [c.bboxMax[0] - c.bboxMin[0], c.bboxMax[1] - c.bboxMin[1], c.bboxMax[2] - c.bboxMin[2]];
      const bytes = center.map((v, k) => Math.round(Math.min(1, Math.max(0, (v - c.bboxMin[k]) / Math.max(1e-6, span[k]))) * 65535));
      actual = bytes.map((b, k) => c.bboxMin[k] + (b / 65535) * span[k]) as Vec3;
      for (let k = 0; k < 3; k++) c.pos[i * 3 + k] = bytes[k];
    }
    for (let k = 0; k < 3; k++) this.centers[i * 3 + k] = actual[k];
    const attr = this.geometry.getAttribute('aCenter') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let v = 0; v < 4; v++) for (let k = 0; k < 3; k++) arr[(i * 4 + v) * 3 + k] = actual[k];
    attr.needsUpdate = true;
    return actual;
  }

  setSplatColor(i: number, color: Vec3): Vec3 | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const next = color.map((v) => Math.min(1, Math.max(0, v))) as Vec3;
    const c = this.cloud;
    if (c.raw) {
      for (let k = 0; k < 3; k++) c.raw.colors[i * 3 + k] = next[k];
      const f = this.geometry.getAttribute('aColorF') as THREE.BufferAttribute;
      for (let v = 0; v < 4; v++) for (let k = 0; k < 3; k++) (f.array as Float32Array)[(i * 4 + v) * 3 + k] = next[k];
      f.needsUpdate = true;
      return next;
    }
    const bytes = next.map((v) => Math.round(v * 255));
    for (let k = 0; k < 3; k++) c.color[i * 3 + k] = bytes[k];
    const f = this.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    for (let v = 0; v < 4; v++) for (let k = 0; k < 3; k++) (f.array as Uint8Array)[(i * 4 + v) * 3 + k] = bytes[k];
    f.needsUpdate = true;
    return next;
  }

  setSplatRotation(i: number, quat: Quat): Quat | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const qn = Math.hypot(...quat) || 1;
    const n: Quat = [quat[0] / qn, quat[1] / qn, quat[2] / qn, quat[3] / qn];
    const c = this.cloud;
    let actual = n;
    if (c.raw) {
      for (let k = 0; k < 4; k++) c.raw.quats[i * 4 + k] = n[k];
      const f = this.geometry.getAttribute('aRotF') as THREE.BufferAttribute;
      for (let v = 0; v < 4; v++) for (let k = 0; k < 4; k++) (f.array as Float32Array)[(i * 4 + v) * 4 + k] = n[k];
      f.needsUpdate = true;
    } else {
      const bytes = n.map((q) => Math.min(255, Math.max(0, Math.round((q * 0.5 + 0.5) * 255))));
      actual = bytes.map((b) => b / 255 * 2 - 1) as Quat;
      const an = Math.hypot(...actual) || 1;
      actual = actual.map((q) => q / an) as Quat;
      for (let k = 0; k < 4; k++) c.rot[i * 4 + k] = bytes[k];
      const f = this.geometry.getAttribute('aRot') as THREE.BufferAttribute;
      for (let v = 0; v < 4; v++) for (let k = 0; k < 4; k++) (f.array as Uint8Array)[(i * 4 + v) * 4 + k] = bytes[k];
      f.needsUpdate = true;
    }
    return actual;
  }

  setSplatScale(i: number, scales: Vec3): Vec3 | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const next = scales.map((s) => Math.min(5, Math.max(1e-4, s))) as Vec3;
    const c = this.cloud;
    if (c.raw) {
      for (let k = 0; k < 3; k++) c.raw.scales[i * 3 + k] = next[k];
      const f = this.geometry.getAttribute('aScaleAlphaF') as THREE.BufferAttribute;
      const arr = f.array as Float32Array;
      for (let k = 0; k < 4; k++) for (let a = 0; a < 3; a++) arr[(i * 4 + k) * 4 + a] = next[k];
      f.needsUpdate = true;
      return next;
    }
    const ls = Math.max(1e-6, c.scaleLogMax - c.scaleLogMin);
    const bytes = next.map((s) => Math.min(255, Math.max(0, Math.round((Math.log(s) - c.scaleLogMin) / ls * 255))));
    const actual = bytes.map((b) => Math.exp(c.scaleLogMin + b / 255 * ls)) as Vec3;
    for (let k = 0; k < 3; k++) c.scale[i * 3 + k] = bytes[k];
    const attr = this.geometry.getAttribute('aScale') as THREE.BufferAttribute;
    const arr = attr.array as Uint8Array;
    for (let k = 0; k < 4; k++) for (let a = 0; a < 3; a++) arr[(i * 4 + k) * 3 + a] = bytes[a];
    attr.needsUpdate = true;
    return actual;
  }

  setSplatOpacity(i: number, alpha: number): number | null {
    if (i < 0 || i >= this.cloud.count) return null;
    const a = Math.min(1, Math.max(0, alpha));
    const c = this.cloud;
    if (c.raw) {
      c.raw.alphas[i] = a;
      const f = this.geometry.getAttribute('aScaleAlphaF') as THREE.BufferAttribute;
      for (let k = 0; k < 4; k++) (f.array as Float32Array)[(i * 4 + k) * 4 + 3] = a;
      f.needsUpdate = true;
    }
    const byte = Math.round(a * 255);
    c.misc[i * 4] = byte;
    const attr = this.geometry.getAttribute('aMisc') as THREE.BufferAttribute;
    const arr = attr.array as Uint8Array;
    for (let k = 0; k < 4; k++) arr[(i * 4 + k) * 4] = byte;
    attr.needsUpdate = true;
    return c.raw ? a : byte / 255;
  }

  setInspect(i: number, only = false) {
    this.u.uInspectIndex.value = i;
    this.u.uInspectOnly.value = only ? 1 : 0;
  }

  /** Binary 3DGS PLY with the current (possibly edited) values. */
  exportPly(): ArrayBuffer {
    const n = this.cloud.count, c = this.cloud, raw = c.raw;
    const restCount = raw?.shRest ? raw.shRestCount : c.hasSH1 ? 9 : 0;
    const header = [
      'ply', 'format binary_little_endian 1.0',
      `comment DentSplat Lab export - ${raw ? 'FP32 source attributes' : 'DSPK quantized attributes'} - SH_rest ${restCount}`,
      `element vertex ${n}`,
      ...['f_dc_0', 'f_dc_1', 'f_dc_2'],
      ...Array.from({ length: restCount }, (_, i) => `f_rest_${i}`),
      'opacity',
      ...['rot_0', 'rot_1', 'rot_2', 'rot_3'],
      ...['scale_0', 'scale_1', 'scale_2'],
      ...['x', 'y', 'z'],
    ];
    const head = `${header.slice(0, 4).join('\n')}\n${header.slice(4).map((x) => `property float ${x}`).join('\n')}\nend_header\n`;
    const headBytes = new TextEncoder().encode(head);
    const stride = (3 + restCount + 1 + 4 + 3 + 3) * 4;
    const out = new ArrayBuffer(headBytes.length + n * stride);
    new Uint8Array(out).set(headBytes);
    const dv = new DataView(out);
    const SH_C0 = 0.28209479177387814;
    const ls = Math.max(1e-6, c.scaleLogMax - c.scaleLogMin);
    for (let i = 0; i < n; i++) {
      let o = headBytes.length + i * stride;
      const r = raw;
      const col = r ? [r.colors[i * 3], r.colors[i * 3 + 1], r.colors[i * 3 + 2]]
        : [c.color[i * 3] / 255, c.color[i * 3 + 1] / 255, c.color[i * 3 + 2] / 255];
      for (let k = 0; k < 3; k++) { dv.setFloat32(o, (col[k] - 0.5) / SH_C0, true); o += 4; }
      for (let k = 0; k < restCount; k++) {
        const v = r?.shRest ? r.shRest[i * restCount + k] : c.sh1 && k < 9 ? c.sh1[i * 9 + k] / 64 : 0;
        dv.setFloat32(o, v, true); o += 4;
      }
      const a = Math.min(1 - 1e-6, Math.max(1e-6, r ? r.alphas[i] : c.misc[i * 4] / 255));
      dv.setFloat32(o, Math.log(a / (1 - a)), true); o += 4;
      let qx: number, qy: number, qz: number, qw: number;
      if (r) {
        qx = r.quats[i * 4]; qy = r.quats[i * 4 + 1]; qz = r.quats[i * 4 + 2]; qw = r.quats[i * 4 + 3];
      } else {
        qx = c.rot[i * 4] / 255 * 2 - 1; qy = c.rot[i * 4 + 1] / 255 * 2 - 1;
        qz = c.rot[i * 4 + 2] / 255 * 2 - 1; qw = c.rot[i * 4 + 3] / 255 * 2 - 1;
      }
      const qn = Math.hypot(qx, qy, qz, qw) || 1;
      dv.setFloat32(o, qw / qn, true); dv.setFloat32(o + 4, qx / qn, true);
      dv.setFloat32(o + 8, qy / qn, true); dv.setFloat32(o + 12, qz / qn, true); o += 16;
      for (let k = 0; k < 3; k++) {
        const s = r ? r.scales[i * 3 + k] : Math.exp(c.scaleLogMin + c.scale[i * 3 + k] / 255 * ls);
        dv.setFloat32(o, Math.log(Math.max(1e-6, s)), true); o += 4;
      }
      dv.setFloat32(o, this.centers[i * 3], true);
      dv.setFloat32(o + 4, this.centers[i * 3 + 1], true);
      dv.setFloat32(o + 8, this.centers[i * 3 + 2], true);
    }
    return out;
  }

  /** Re-sort only when the camera basis actually changed. */
  update(view: THREE.Matrix4, viewportPx: THREE.Vector2, force = false) {
    this.u.uViewportPx.value.copy(viewportPx);
    const e = view.elements;
    // Three.js Matrix4.elements is column-major: row 2 of the view matrix, i.e. the camera-space Z
    // axis and its translation, is (e[2], e[6], e[10], e[14]). The old code read column 2 plus the
    // row-2 translation, which only agrees with the truth when the rotation is diagonal -- i.e. in
    // the frontal preset -- and reverses depth as soon as the view turns.
    const key = `${e[2].toFixed(3)},${e[6].toFixed(3)},${e[10].toFixed(3)},${e[14].toFixed(2)}`;
    if (!force && key === this.lastKey) return false;
    this.lastKey = key;
    const m = this.tmpM.length === 4 ? this.tmpM : (this.tmpM = new Float32Array(4));
    m[0] = e[2]; m[1] = e[6]; m[2] = e[10]; m[3] = e[14];
    const t0 = performance.now();
    const visible = this.sorter.sort(this.centers, m);
    const order = this.sorter.lastOrder;
    const idx = this.indexAttr.array as Uint32Array;
    for (let k = 0; k < visible; k++) {
      const base = order[k] * 4;
      const o = k * 6;
      idx[o] = base; idx[o + 1] = base + 1; idx[o + 2] = base + 2;
      idx[o + 3] = base; idx[o + 4] = base + 2; idx[o + 5] = base + 3;
    }
    this.indexAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, visible * 6);
    this.visible = visible;
    this.lastSort = performance.now() - t0;
    return true;
  }
  private tmpM = new Float32Array(4);
  get sortMs() { return this.lastSort; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.sh3Tex?.dispose();
    this.sh3Tex = null;
  }
}

export const DEFAULT_LAYER_ALPHA: Record<number, number> = {
  [LAYER.gingiva]: 1, [LAYER.enamel]: 1, [LAYER.root]: 1, [LAYER.alveolar]: 1,
  [LAYER.nerve]: 1, [LAYER.other]: 1, [LAYER.pulp]: 1, [LAYER.sinus]: 1, [LAYER.restoration]: 1,
};
