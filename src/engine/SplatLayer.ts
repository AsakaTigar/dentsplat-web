import * as THREE from 'three';
import { SPLAT_FRAGMENT, SPLAT_VERTEX } from './shaders.ts';
import { LAYER, type SplatCloud } from './dspk.ts';

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
  visible = 0;
  forceDirty = true;

  constructor(public cloud: SplatCloud, opts: { opacityScale?: number } = {}) {
    const n = cloud.count;
    this.centers = new Float32Array(n * 3);
    const aCenter = new Float32Array(n * 4 * 3);
    const aRot = new Uint8Array(n * 4 * 4);
    const aScale = new Uint8Array(n * 4 * 3);
    const aColor = new Uint8Array(n * 4 * 3);
    const aMisc = new Uint8Array(n * 4 * 4);
    const aSH1 = new Int8Array(n * 4 * 9);

    const { bboxMin, bboxMax, pos, rot, scale, color, misc, hasSH1, sh1 } = cloud;
    const span = [bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]];
    for (let i = 0; i < n; i++) {
      const cx = bboxMin[0] + (pos[i * 3] / 65535) * span[0];
      const cy = bboxMin[1] + (pos[i * 3 + 1] / 65535) * span[1];
      const cz = bboxMin[2] + (pos[i * 3 + 2] / 65535) * span[2];
      this.centers[i * 3] = cx; this.centers[i * 3 + 1] = cy; this.centers[i * 3 + 2] = cz;
      const v = i * 4;
      for (let k = 0; k < 4; k++) {
        aCenter[(v + k) * 3] = cx; aCenter[(v + k) * 3 + 1] = cy; aCenter[(v + k) * 3 + 2] = cz;
        aRot[(v + k) * 4] = rot[i * 4]; aRot[(v + k) * 4 + 1] = rot[i * 4 + 1];
        aRot[(v + k) * 4 + 2] = rot[i * 4 + 2]; aRot[(v + k) * 4 + 3] = rot[i * 4 + 3];
        for (let c = 0; c < 3; c++) {
          aScale[(v + k) * 3 + c] = scale[i * 3 + c];
          aColor[(v + k) * 3 + c] = color[i * 3 + c];
        }
        for (let c = 0; c < 4; c++) aMisc[(v + k) * 4 + c] = misc[i * 4 + c];
        if (hasSH1 && sh1) for (let c = 0; c < 9; c++) aSH1[(v + k) * 9 + c] = sh1[i * 9 + c];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
    geo.setAttribute('aRot', new THREE.BufferAttribute(aRot, 4, true));
    geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
    geo.setAttribute('aMisc', new THREE.BufferAttribute(aMisc, 4));
    // mat3 in the shader = 3 attribute locations of vec3 over the same 9-byte record, so the
    // vertex count stays n*4 like every other plane (itemSize 3 here would silently give count n*12)
    geo.setAttribute('aSH1', new THREE.BufferAttribute(aSH1, 9));

    const index = new Uint32Array(n * 6);
    this.indexAttr = new THREE.BufferAttribute(index, 1);
    geo.setIndex(this.indexAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e4);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
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
        uOutline: { value: 0.9 },
        uShowLesions: { value: 1 },
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
  }
}

export const DEFAULT_LAYER_ALPHA: Record<number, number> = {
  [LAYER.gingiva]: 1, [LAYER.enamel]: 1, [LAYER.root]: 1, [LAYER.alveolar]: 1,
  [LAYER.nerve]: 1, [LAYER.other]: 1, [LAYER.pulp]: 1, [LAYER.sinus]: 1, [LAYER.restoration]: 1,
};
