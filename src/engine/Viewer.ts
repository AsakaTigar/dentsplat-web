import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatLayer } from './SplatLayer.ts';
import { FLAG, decodeSplatCloud, type SplatCloud } from './dspk.ts';
import type { GaussianInspect, Vec3 } from './gaussian.ts';

export type ClipAxis = 'x' | 'y' | 'z' | null;
export type LabMode = 'rgb' | 'ellipsoid' | 'centers' | 'wire' | 'opacity' | 'scale' | 'normal' | 'depth';
export type LabInfo = { mode: LabMode; available: number; rendered: number; truncated: boolean; triangles: number; points: number };
export type ProjectedGaussian = {
  centerPx: [number, number];
  sigmaPx: [number, number];
  angleRad: number;
  depthMm: number;
  viewportPx: [number, number];
};
export type AlphaComposition = {
  targetPx: [number, number];
  coverage: number;
  color: [number, number, number];
  contributors: { index: number; depthMm: number; alpha: number; weight: number; color: [number, number, number] }[];
  neighborhoodMm: number;
};

export type ViewPreset = {
  id: string; label: string; sub?: string;
  theta: number; phi: number; radius: number; target?: [number, number, number]; fov?: number;
};

export type PickerHit = { fdi: number; point: THREE.Vector3; meshName: string } | null;

export type VectorHudEntry = {
  kind: 'measure' | 'audit';
  a: [number, number];
  b: [number, number];
  label: string;
  color: string;
};

type VectorHudSource = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  label: string;
  color: string;
};

export type BenchPair = {
  /** Mean over the whole frame, background included. 999 = bit-identical (PSNR is undefined at MSE 0). */
  psnr: number;
  /** Mean over pixels where at least one side painted: the figure that describes the teeth. */
  psnrInMask: number;
  mae: number;
  /** Fraction of pixels with content in either shot. */
  covered: number;
  identicalFraction: number;
  /** Share of total squared error held by the worst 1% of pixels: ~1 = edges only, ~0.1 = whole surface. */
  errorInTop1Percent: number;
  maxDiff: number;
  meanFull: [number, number, number];
  meanPruned: [number, number, number];
};

export type BenchResult = BenchPair & {
  samples: number;
  /** Full rendered twice through the same target: the determinism control that licenses the headline. */
  control: BenchPair; psnrSelf: number; identicalSelfFraction: number;
};

export type Stats = {
  fps: number; splats: number; visible: number; sortMs: number; frameMs: number;
  bytes: number; gpu: string;
};

export type ClearanceAudit = {
  fdi: number;
  targetLayer: number;
  distance: number;
  toothIndex: number;
  targetIndex: number;
  toothCount: number;
  targetCount: number;
  a: [number, number, number];
  b: [number, number, number];
};

export type CompressionCandidateBench = {
  name: string;
  overall: BenchPair;
  layers: Record<number, BenchPair>;
  clearance_mm: number | null;
  clearance_delta_mm: number | null;
};

export type CompressionBenchResult = {
  size: number;
  views: string[];
  referenceClearance: number | null;
  candidates: CompressionCandidateBench[];
};

export type CaseAsset = {
  fullUrl: string; prunedUrl: string; proxyUrl: string | null;
  fullBytes: number; prunedBytes: number;
  defaultLayerAlpha?: Record<number, number>;
};

export type ProbeResult = {
  error?: string;
  w?: number; h?: number;
  sorted?: boolean;
  drawn?: { calls: number; tris: number };
  glError?: number;
  paintedFraction?: number;
  paintedLowerHalf?: number;
  mean?: [number, number, number];
  peak?: number;
  buf?: Uint8Array;
};

const AXIS_VEC: Record<Exclude<ClipAxis, null>, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

function disposeMaterial(m: THREE.Material | THREE.Material[] | undefined | null) {
  if (!m) return;
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m.dispose();
}

/** Release geometry/material GPU resources of a proxy/wire graph before dropping its group. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose?.();
    disposeMaterial((o as THREE.Mesh).material);
  });
}

type PixelStats = {
  sse: number; ae: number; n: number; sseIn: number; nIn: number; same: number; covered: number; maxDiff: number;
  sumA: [number, number, number]; sumB: [number, number, number]; errors: number[];
};

function comparePixelStats(A: Uint8Array, B: Uint8Array): PixelStats {
  const s: PixelStats = { sse: 0, ae: 0, n: 0, sseIn: 0, nIn: 0, same: 0, covered: 0, maxDiff: 0,
    sumA: [0, 0, 0], sumB: [0, 0, 0], errors: [] };
  for (let i = 0; i < A.length; i += 4) {
    let ink = 0, pse = 0;
    for (let k = 0; k < 3; k++) {
      const a = A[i + k], b = B[i + k], d = a - b, ad = Math.abs(d);
      s.sse += d * d; s.ae += ad; s.n++; pse += d * d;
      s.sumA[k] += a; s.sumB[k] += b;
      if (ad > s.maxDiff) s.maxDiff = ad;
      if (a > 8 || b > 8) ink = 1;
    }
    if (ink) { s.covered++; s.nIn += 3; s.sseIn += pse; }
    s.errors.push(pse);
    if (A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2]) s.same++;
  }
  return s;
}

function addPixelStats(a: PixelStats, b: PixelStats) {
  a.sse += b.sse; a.ae += b.ae; a.n += b.n; a.sseIn += b.sseIn; a.nIn += b.nIn;
  a.same += b.same; a.covered += b.covered; a.maxDiff = Math.max(a.maxDiff, b.maxDiff);
  for (let k = 0; k < 3; k++) { a.sumA[k] += b.sumA[k]; a.sumB[k] += b.sumB[k]; }
  a.errors.push(...b.errors);
}

function finishPixelStats(s: PixelStats): BenchPair {
  const px = s.n / 3;
  const db = (sse: number, n: number) => sse === 0 ? 999 : +(10 * Math.log10(1 / (sse / Math.max(1, n) / 65025))).toFixed(2);
  const errors = [...s.errors].sort((x, y) => y - x);
  const top = errors.slice(0, Math.max(1, Math.round(errors.length / 100))).reduce((a, b) => a + b, 0);
  const mean = (v: [number, number, number]) => v.map((x) => +(x / Math.max(1, px)).toFixed(1)) as [number, number, number];
  return {
    psnr: db(s.sse, s.n), psnrInMask: db(s.sseIn, s.nIn), mae: +(s.ae / Math.max(1, s.n) / 255).toFixed(4),
    covered: +(s.covered / Math.max(1, px)).toFixed(4), identicalFraction: +(s.same / Math.max(1, px)).toFixed(4),
    errorInTop1Percent: +(top / (s.sse || 1)).toFixed(3), maxDiff: s.maxDiff,
    meanFull: mean(s.sumA), meanPruned: mean(s.sumB),
  };
}

function nearestClearance(centers: Float32Array, misc: Uint8Array, count: number, fdi: number, targetLayer: number) {
  const toothIdx: number[] = [], targetIdx: number[] = [];
  for (let i = 0; i < count; i++) {
    if (misc[i * 4 + 1] === fdi) toothIdx.push(i);
    if (misc[i * 4 + 2] === targetLayer) targetIdx.push(i);
  }
  if (!toothIdx.length || !targetIdx.length) return null;
  const cell = 1.0, key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (const j of targetIdx) {
    const k = key(Math.floor(centers[j * 3] / cell), Math.floor(centers[j * 3 + 1] / cell), Math.floor(centers[j * 3 + 2] / cell));
    const a = grid.get(k); if (a) a.push(j); else grid.set(k, [j]);
  }
  let best = Infinity, bestI = -1, bestJ = -1;
  for (const i of toothIdx) {
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    for (let r = 0; r < 64; r++) {
      if (best < Infinity && (r - 1) * cell > best) break;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const a = grid.get(key(cx + dx, cy + dy, cz + dz));
        if (!a) continue;
        for (const j of a) {
          const d2 = (centers[j * 3] - x) ** 2 + (centers[j * 3 + 1] - y) ** 2 + (centers[j * 3 + 2] - z) ** 2;
          if (d2 < best) { best = d2; bestI = i; bestJ = j; }
        }
      }
    }
  }
  if (bestI < 0 || bestJ < 0) return null;
  return {
    distance: Math.sqrt(best), toothIndex: bestI, targetIndex: bestJ, toothCount: toothIdx.length, targetCount: targetIdx.length,
    a: [centers[bestI * 3], centers[bestI * 3 + 1], centers[bestI * 3 + 2]] as [number, number, number],
    b: [centers[bestJ * 3], centers[bestJ * 3 + 1], centers[bestJ * 3 + 2]] as [number, number, number],
  };
}

const FDI_RE = /^FDI_(\d{1,2})(?:\b|_)/;

/**
 * Resolve the tooth id a proxy mesh belongs to. `GLTFLoader` names meshes from the glTF
 * *mesh* entry (`mesh_0` when absent) while node names — where our generator writes
 * `FDI_36` — end up on the Object3D, so walk the ancestor chain before giving up.
 */
function fdiNameOf(obj: THREE.Object3D): string {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const cand = [
      typeof o.userData?.name === 'string' ? o.userData.name : '',
      typeof o.name === 'string' ? o.name : '',
    ];
    for (const c of cand) if (FDI_RE.test(c)) return c;
  }
  return obj.name ?? '';
}

export class DentSplatViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Every case-owned object lives here, so a switch can clear the whole case in one place. */
  readonly caseGroup = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  layer: SplatLayer | null = null;
  layerAlt: SplatLayer | null = null;
  proxy: THREE.Group | null = null;
  /** Monotonic token: a late fetch/parse from an older case must never commit. */
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;
  variant: 'full' | 'pruned' = 'full';
  splitCompare = false;
  private _splitRatio = 0.5;
  get splitRatio(): number { return this._splitRatio; }
  set splitRatio(value: number) {
    const ratio = Number(value);
    this._splitRatio = Number.isNaN(ratio) ? 0.5 : Math.min(0.9, Math.max(0.1, ratio));
  }
  measureMode: 'off' | 'measure' | 'pick' = 'pick';
  /** Which case is loaded; set by App on every case switch, read by the HUD and the checks. */
  caseId = 'A2';
  onPick?: (hit: PickerHit) => void;
  onSplatPick?: (index: number | null) => void;
  onStats?: (s: Stats) => void;
  onMeasure?: (m: { mm: number; a: THREE.Vector3; b: THREE.Vector3 } | null) => void;
  selectedTooth = 0;
  clip: { axis: ClipAxis; offset: number; band: number; cap: boolean } = { axis: null, offset: 0, band: 0.9, cap: true };
  private target = new THREE.Vector3(0, 0, 0);
  private theta = 0.42; private phi = 0.32; private radius = 125;
  private goal: { theta: number; phi: number; radius: number; target: THREE.Vector3 } | null = null;
  private raf = 0;
  private clock = new THREE.Clock();
  private fpsEMA = 60;
  private frameEMA = 8;
  private raycaster = new THREE.Raycaster();
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { id: number; moved: number } | null = null;
  private gesture: { mode: 'orbit' | 'pan' | 'zoom'; dist: number } | null = null;
  /** Public for the automated end-to-end check; the tap sequence that fills it is user-driven. */
  measurePts: THREE.Vector3[] = [];
  private measureGroup = new THREE.Group();
  private auditGroup = new THREE.Group();
  private measureHud: VectorHudSource | null = null;
  private auditHud: VectorHudSource | null = null;
  private gizmo = new THREE.Group();
  private labGroup = new THREE.Group();
  private inspectGroup = new THREE.Group();
  private quadGroup = new THREE.Group();
  quadLayers: SplatLayer[] = [];
  quadCompare = false;
  labMode: LabMode = 'rgb';
  labSigma: 1 | 2 | 3 = 1;
  labInfo: LabInfo = { mode: 'rgb', available: 0, rendered: 0, truncated: false, triangles: 0, points: 0 };
  pickGaussians = false;
  /** Isolate the selected Gaussian in the splat raster and the lab overlays. */
  inspectIsolate = false;
  inspectedIndex = -1;
  private wireRoot: THREE.Group | null = null;
  private disposed = false;
  showWire = false;
  autoRotate = true;
  private gpu = 'unknown';

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: true, powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 2000);
    const dbg = this.renderer.getContext().getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      // ANGLE returns e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11
      // vs_5_0 ps_5_0, D3D11)" or, on macOS, "ANGLE (Apple, ANGLE Metal Renderer: Apple M3,
      // Unspecified Version)". A blind slice(0, 42) cut the first one mid-word in the HUD chip. The
      // device name is not always the field after the first comma either -- AMD puts backend noise
      // there ("Advanced Micro Devices, Inc. on Direct3D11 ...") -- so strip the wrapper and the
      // id/backend tokens, drop exact vendor names, and keep the longest remaining fragment.
      const raw = String(this.renderer.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      const inner = raw.replace(/^ANGLE\s*\(/, '').replace(/\)\s*$/, '');
      const metal = /Metal Renderer:\s*(.+?)(?:,|$)/.exec(inner);
      const VENDOR = /^(nvidia|intel|apple|microsoft|amd|advanced micro devices|google inc|img technologies|arm holdings|mesa|vmware|basic render driver)(,?\s*(inc|corp|ltd)\.?)?$/i;
      const parts = inner
        .replace(/\((?:0x|Vendor:)[^)]*\)/g, '')
        .replace(/\s*\b(direct3d\d+|vs_\d+_\d+|ps_\d+_\d+)\b[^,]*/gi, '')
        .split(',').map((x) => x.trim()).filter((x) => x.length > 3 && !/^d3d\d+$/i.test(x));
      const named = parts.filter((x) => !VENDOR.test(x));
      const name = metal ? metal[1] : (named.length ? named : parts).sort((a, b) => b.length - a.length)[0];
      this.gpu = (name || raw).trim().slice(0, 40);
    }
    this.scene.add(this.caseGroup, this.measureGroup, this.auditGroup, this.gizmo, this.labGroup, this.inspectGroup, this.quadGroup);
    this.attachInput();
    this.resize();
    this.loop();
  }

  // ------------------------------------------------------------------ assets

  async loadCase(asset: CaseAsset) {
    // Any earlier request is obsolete the moment a new case is selected. Abort its fetches and make
    // every post-await step check the token: a 3.2 MB CBCT download may return after a 0.8 MB IOS
    // case has already been committed, and it must never overwrite that newer scene.
    const seq = ++this.loadSeq;
    this.loadAbort?.abort();
    const ac = new AbortController();
    this.loadAbort = ac;
    const getBuffer = (url: string) => fetch(url, { signal: ac.signal }).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    try {
      const [fullBuf, prunedBuf, proxyBuf] = await Promise.all([
        getBuffer(asset.fullUrl), getBuffer(asset.prunedUrl),
        asset.proxyUrl ? getBuffer(asset.proxyUrl) : Promise.resolve(null),
      ]);
      if (seq !== this.loadSeq || this.disposed) return;

      const full = decodeSplatCloud(fullBuf);
      const pruned = decodeSplatCloud(prunedBuf);
      if (seq !== this.loadSeq || this.disposed) return;

      let root: THREE.Group | null = null;
      if (proxyBuf) {
        const loader = new GLTFLoader();
        const gltf = await loader.parseAsync(proxyBuf, '');
        if (seq !== this.loadSeq || this.disposed) {
          disposeObject(gltf.scene);
          return;
        }
        root = gltf.scene;
      }

      // Commit only after every download/decode/parse has finished and this is still the newest load.
      this.disposeLayers();
      this.fullBytes = asset.fullBytes;
      this.prunedBytes = asset.prunedBytes;
      this.layer = new SplatLayer(full, { opacityScale: 1 });
      this.layerAlt = new SplatLayer(pruned, { opacityScale: 1 });
      this.layerAlphas = { ...(asset.defaultLayerAlpha ?? {}) };
      for (const l of [this.layer, this.layerAlt]) {
        if (!l) continue;
        l.setLayerAlphas(this.layerAlphas);
        this.caseGroup.add(l.mesh);
      }

      if (root) {
        // Keep the exported graph intact (Blender wraps meshes in nodes carrying the Y-up
        // conversion); hide every mesh and resolve the FDI id by walking ancestors.
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.visible = false;
          m.frustumCulled = false;
          m.userData.name = fdiNameOf(m);
          m.geometry.computeBoundingSphere();
          m.geometry.computeBoundingBox();
        });
        root.updateMatrixWorld(true);
        // Freeze each proxy mesh's world matrix: the jaw transform below is applied as
        // local = parentWorld^-1 * W * world0, so it must always start from the same rest pose instead of
        // accumulating a little rounding on every slider step.
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.userData.world0 = m.matrixWorld.clone();
          m.matrixAutoUpdate = false;
        });
        this.proxy = root;
        this.caseGroup.add(root);
      }
      this.forceSort = true;
      this.applyUniforms();
      this.applyJawToProxy();
    } finally {
      if (this.loadAbort === ac) this.loadAbort = null;
    }
  }

  /** Commit an already-parsed FP32 PLY cloud without inventing a proxy or DSPK round-trip. */
  loadCloud(cloud: SplatCloud, bytes: number) {
    ++this.loadSeq;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.disposeLayers();
    this.layer = new SplatLayer(cloud, { opacityScale: 1 });
    this.layerAlt = null;
    this.variant = 'full';
    this.splitCompare = false;
    this.layerAlphas = {};
    this.fullBytes = bytes;
    this.prunedBytes = bytes;
    this.caseGroup.add(this.layer.mesh);
    this.applyUniforms();
    this.forceSort = true;
    this.labMode = 'rgb';
    this.clearLab();
    this.labGroup.visible = false;
  }

  /** Load four already-quantised packets into the same scene for a 2x2 camera-synced comparison. */
async loadQuadComparison(items: { name: string; url: string; bytes: number }[]) {
    if (items.length !== 4) throw new Error('quad comparison needs exactly four items');
    const seq = ++this.loadSeq;
    this.loadAbort?.abort();
    const ac = new AbortController();
    this.loadAbort = ac;
    const fetchOne = (url: string) => fetch(url, { signal: ac.signal }).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    try {
      const bufs = await Promise.all(items.map((x) => fetchOne(x.url)));
      if (seq !== this.loadSeq || this.disposed) return null;
      const clouds = bufs.map((b) => decodeSplatCloud(b));
      this.disposeLayers();
      this.quadLayers = clouds.map((c) => new SplatLayer(c, { opacityScale: 1 }));
      this.layerAlphas = {};
      for (const l of this.quadLayers) {
        l.setLayerAlphas(this.layerAlphas);
        this.quadGroup.add(l.mesh);
      }
      this.quadCompare = true;
      this.layer = null;
      this.layerAlt = null;
      this.proxy = null;
      this.fullBytes = items.reduce((s, x) => s + x.bytes, 0);
      this.prunedBytes = this.fullBytes;
      this.applyUniforms();
      this.forceSort = true;
      this.fitQuadComparison();
      return this.quadLayers.map((l, i) => ({ name: items[i].name, splats: l.cloud.count, bytes: items[i].bytes }));
    } finally {
      if (this.loadAbort === ac) this.loadAbort = null;
    }
  }

  clearQuadCompare() {
    for (const l of this.quadLayers) l.dispose();
    this.quadLayers = [];
    for (const child of [...this.quadGroup.children]) {
      this.quadGroup.remove(child);
      disposeObject(child);
    }
    this.quadCompare = false;
    this.forceSort = true;
  }

  /** Centre every comparison tile on the union bounds and fit the full dental arch. */
  fitQuadComparison() {
    if (!this.quadCompare || !this.quadLayers.length) return;
    const bounds = new THREE.Box3();
    for (const l of this.quadLayers) {
      bounds.expandByPoint(new THREE.Vector3(...l.cloud.bboxMin));
      bounds.expandByPoint(new THREE.Vector3(...l.cloud.bboxMax));
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const r = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const aspect = Math.max(0.25, (r.x / 2) / Math.max(1, r.y / 2));
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const limitingFov = Math.min(vFov, hFov);
    const radius = Math.max(50, sphere.radius / Math.sin(limitingFov / 2) * 1.12);
    this.target.copy(sphere.center);
    this.theta = 0;
    this.phi = 0.12;
    this.radius = radius;
    this.goal = null;
    this.camera.position.set(
      this.target.x + this.radius * Math.sin(this.theta) * Math.cos(this.phi),
      this.target.y + this.radius * Math.sin(this.phi),
      this.target.z + this.radius * Math.cos(this.theta) * Math.cos(this.phi),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Screen-space anatomical axes and an exact 10 mm scale for the PACS viewport guide. */
  getViewportGuide() {
    const [w, h] = this.canvasSize();
    const inv = this.camera.quaternion.clone().invert();
    const axes: { label: string; x: number; y: number }[] = [];
    const directions: [string, [number, number, number]][] = [
      ['R', [-1, 0, 0]], ['L', [1, 0, 0]],
      ['I', [0, -1, 0]], ['S', [0, 1, 0]],
      ['P', [0, 0, -1]], ['A', [0, 0, 1]],
    ];
    for (const [label, dir] of directions) {
      const v = new THREE.Vector3(...dir).applyQuaternion(inv);
      axes.push({ label, x: 36 + v.x * 22, y: 36 - v.y * 22 });
    }
    // Depth labels can nearly coincide in a frontal view; separate them without changing axis direction.
    for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) {
      const a = axes[i], b = axes[j];
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
      if (d >= 9) continue;
      const ux = d > 0.1 ? dx / d : 0, uy = d > 0.1 ? dy / d : (a.y < b.y ? -1 : 1);
      const push = (9 - d) / 2;
      a.x += ux * push; a.y += uy * push;
      b.x -= ux * push; b.y -= uy * push;
    }
    const pixelsPerMm = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * Math.max(1, this.radius));
    return { axes, scalePx: pixelsPerMm * 10 };
  }

  private disposeLayers() {
    this.clearQuadCompare();
    const splatMeshes = new Set<THREE.Object3D>();
    if (this.layer) splatMeshes.add(this.layer.mesh);
    if (this.layerAlt) splatMeshes.add(this.layerAlt.mesh);
    for (const l of [this.layer, this.layerAlt]) l?.dispose();
    this.clearWire();
    this.clearLab();
    this.clearInspect();
    this.labGroup.visible = false;
    this.showWire = false;

    // Everything case-owned is under caseGroup. SplatLayer.dispose() has already released the two
    // splat meshes; dispose the proxy/wire geometry and drop every remaining child in one sweep.
    for (const child of [...this.caseGroup.children]) {
      if (splatMeshes.has(child)) continue;
      disposeObject(child);
    }
    this.caseGroup.clear();
    this.layer = null; this.layerAlt = null; this.proxy = null;
    this.clearAudit();
    this.clearMeasure();
  }

  // ------------------------------------------------------------------ input

  private attachInput() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      // A synthetic PointerEvent (automated capture, scripted taps) has no live pointer, so
      // setPointerCapture throws InvalidPointerId and would swallow the whole gesture state.
      try { c.setPointerCapture(e.pointerId); } catch { /* not a trusted pointer id */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.press = { id: e.pointerId, moved: 0 };
      if (this.pointers.size === 2) {
        const p = [...this.pointers.values()];
        this.gesture = { mode: 'zoom', dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
      } else {
        this.gesture = { mode: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', dist: 0 };
      }
      this.autoRotate = false;
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev || !this.gesture) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.press?.id === e.pointerId) this.press.moved += Math.abs(dx) + Math.abs(dy);
      if (this.gesture.mode === 'orbit') {
        this.theta -= dx * 0.006;
        this.phi = Math.max(-1.5, Math.min(1.5, this.phi + dy * 0.005));
        this.goal = null;
      } else if (this.gesture.mode === 'pan') {
        const s = this.radius * 0.0016;
        const right = new THREE.Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
        const up = new THREE.Vector3(0, 1, 0);
        this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
        this.goal = null;
      } else if (this.pointers.size === 2) {
        const p = [...this.pointers.values()];
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        this.radius = Math.max(28, Math.min(420, this.radius * (this.gesture.dist / Math.max(1, d))));
        this.gesture.dist = d;
        this.goal = null;
      }
    });
    const end = (e: PointerEvent, isTapCandidate: boolean) => {
      const wasPress = this.press?.id === e.pointerId;
      const moved = this.press?.moved ?? 0;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.gesture = null;
      if (wasPress) this.press = null;
      if (isTapCandidate && wasPress && moved < 5) this.tap(e);
    };
    c.addEventListener('pointerup', (e) => end(e, true));
    c.addEventListener('pointercancel', (e) => end(e, false));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = Math.max(24, Math.min(460, this.radius * (1 + Math.sign(e.deltaY) * 0.08)));
      this.goal = null;
      this.autoRotate = false;
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // Double-click locks the orbit centre onto the surface point under the cursor and pulls in to a
    // micro-distance. The single-click path is untouched, so tooth picking and measurement still work.
    c.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY);
      const p = hit?.point ?? this.pickSplatCenter(e.clientX, e.clientY);
      if (!p) return;
      this.goal = { theta: this.theta, phi: this.phi, radius: Math.max(26, Math.min(this.radius, 65)), target: p.clone() };
      this.autoRotate = false;
    });
    // R recentres: the same target the frontal preset starts from, without hunting for the button.
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'r' || e.key === 'R') {
        this.goal = { theta: 0, phi: 9 * Math.PI / 180, radius: 178, target: new THREE.Vector3(0, 0, 0) };
        this.autoRotate = false;
      }
    });
  }

  private tap(e: PointerEvent) {
    if (this.pickGaussians && this.measureMode !== 'measure') {
      const index = this.pickSplatIndex(e.clientX, e.clientY);
      this.onSplatPick?.(index);
      return;
    }
    const hit = this.pick(e.clientX, e.clientY);
    if (this.measureMode === 'measure') {
      const p = hit?.point ?? this.pickSplatCenter(e.clientX, e.clientY);
      if (p) {
        this.measurePts.push(p.clone());
        if (this.measurePts.length >= 2) {
          const a = this.measurePts[this.measurePts.length - 2];
          const b = this.measurePts[this.measurePts.length - 1];
          this.drawMeasure(a, b);
          this.onMeasure?.({ mm: a.distanceTo(b), a: a.clone(), b: b.clone() });
        }
      }
      return;
    }
    this.onPick?.(hit);
  }

  private ndc(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  private fdiHidden(fdi: number) {
    if (fdi <= 0) return false;
    if (this.isolateTooth && this.selectedTooth > 0) return fdi !== this.selectedTooth;
    return this.hiddenTeeth.includes(fdi);
  }

  private pointPassesClip(p: THREE.Vector3, planes: THREE.Vector4[]) {
    for (const pl of planes) if (pl.x * p.x + pl.y * p.y + pl.z * p.z - pl.w < -1e-4) return false;
    return true;
  }

  /** World-space splat centre after the same jaw kinematics used by SPLAT_VERTEX. */
  private splatWorld(layer: SplatLayer, i: number, out: THREE.Vector3) {
    out.set(layer.centers[i * 3], layer.centers[i * 3 + 1], layer.centers[i * 3 + 2]);
    const flags = layer.cloud.misc[i * 4 + 3];
    if ((flags & FLAG.lowerJaw) && this.jawGap > 0.001) {
      const th = 2 * Math.asin(Math.min(0.8, this.jawGap / (2 * 66)));
      const sn = Math.sin(th), cs = Math.cos(th), glide = Math.max(0, this.jawGap - 20) * 0.30;
      const x = out.x, y = out.y + 14, z = out.z + 34;
      out.set(x, -14 + y * cs - z * sn - glide, -34 + y * sn + z * cs - glide * 0.45);
    } else if ((flags & FLAG.upperJaw) && this.jawGap > 0.001) {
      out.y += Math.min(1.2, this.jawGap * 0.02);
    }
    return out;
  }

  /** Raycast against the invisible FDI proxy: exact tooth id + exact mm surface point. */
  pick(clientX: number, clientY: number): PickerHit {
    if (!this.proxy) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObjects(this.proxy.children, true);
    const planes = this.clipPlanes();
    for (const h of hits) {
      const name = fdiNameOf(h.object);
      const m = /^FDI_(\d+)/.exec(name);
      const fdi = m ? Number(m[1]) : 0;
      if (this.fdiHidden(fdi) || !this.pointPassesClip(h.point, planes)) continue;
      return { fdi, point: h.point.clone(), meshName: name };
    }
    return null;
  }

  /** Screen-space 1-sigma projection of one Gaussian, using the live camera matrices. */
  projectedGaussian(index: number): ProjectedGaussian | null {
    const layer = this.primaryLayer();
    const state = layer?.inspect(index);
    if (!layer || !state) return null;
    const cam = new THREE.Vector3(...state.center).applyMatrix4(this.camera.matrixWorldInverse);
    if (cam.z > -0.05) return null;
    const rb = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, rb.x), h = Math.max(1, rb.y);
    const e = this.camera.matrixWorldInverse.elements;
    // V * C * V^T, computed directly (V is a rotation).
    const C = state.covariance;
    const V = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    const tmp = new Array(9).fill(0), cv = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) tmp[i * 3 + j] += V[i * 3 + k] * C[k * 3 + j];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) cv[i * 3 + j] += tmp[i * 3 + k] * V[j * 3 + k];
    const fx = 0.5 * w * this.camera.projectionMatrix.elements[0];
    const fy = 0.5 * h * this.camera.projectionMatrix.elements[5];
    const z = -cam.z, z2 = z * z;
    const J = [fx / z, 0, fx * cam.x / z2, 0, fy / z, fy * cam.y / z2, 0, 0, 0];
    const jc = new Array(9).fill(0), c2 = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) jc[i * 3 + j] += J[i * 3 + k] * cv[k * 3 + j];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) c2[i * 3 + j] += jc[i * 3 + k] * J[j * 3 + k];
    const a = c2[0] + 0.32, b = c2[1], c = c2[4] + 0.32;
    const mid = 0.5 * (a + c), disc = Math.sqrt(Math.max(1e-6, mid * mid - (a * c - b * b)));
    const l1 = Math.max(1e-5, mid + disc), l2 = Math.max(1e-5, mid - disc);
    const ax = Math.abs(b) > 1e-9 ? new THREE.Vector2(b, l1 - a).normalize() : new THREE.Vector2(1, 0);
    const center = new THREE.Vector3(...state.center).project(this.camera);
    return {
      centerPx: [(center.x * 0.5 + 0.5) * w, (-center.y * 0.5 + 0.5) * h],
      sigmaPx: [Math.sqrt(l1), Math.sqrt(l2)],
      angleRad: Math.atan2(ax.y, ax.x),
      depthMm: z,
      viewportPx: [w, h],
    };
  }

  /** Local alpha compositing at the selected Gaussian's projected pixel.
   *  Candidates are true scene splats within a 3D neighbourhood, projected with EWA covariance. */
  alphaComposition(index: number, radiusMm = 6): AlphaComposition | null {
    const layer = this.primaryLayer();
    const base = layer?.stateOf(index);
    const target = this.projectedGaussian(index);
    if (!layer || !base || !target) return null;
    const [tx, ty] = target.centerPx;
    const planes = this.clipPlanes();
    const rows: { index: number; depthMm: number; alpha: number; weight: number; color: [number, number, number] }[] = [];
    for (let i = 0; i < layer.cloud.count; i++) {
      const dx = layer.centers[i * 3] - base.center[0];
      const dy = layer.centers[i * 3 + 1] - base.center[1];
      const dz = layer.centers[i * 3 + 2] - base.center[2];
      if (dx * dx + dy * dy + dz * dz > radiusMm * radiusMm) continue;
      if (this.fdiHidden(layer.cloud.misc[i * 4 + 1]) || (this.layerAlphas[layer.cloud.misc[i * 4 + 2]] ?? 1) <= 0.001) continue;
      const w = new THREE.Vector3(layer.centers[i * 3], layer.centers[i * 3 + 1], layer.centers[i * 3 + 2]);
      if (!this.pointPassesClip(w, planes)) continue;
      const p = this.projectedGaussian(i);
      if (!p) continue;
      const c = Math.cos(p.angleRad), s = Math.sin(p.angleRad);
      const px = p.centerPx[0] - tx, py = p.centerPx[1] - ty;
      const u = c * px + s * py, v = -s * px + c * py;
      const r2 = (u / p.sigmaPx[0]) ** 2 + (v / p.sigmaPx[1]) ** 2;
      if (r2 > 18) continue;
      const st = layer.stateOf(i)!;
      const alpha = st.alpha * (this.layerAlphas[st.layer] ?? 1);
      if (alpha <= 0.001) continue;
      rows.push({ index: i, depthMm: p.depthMm, alpha, weight: alpha * Math.exp(-0.5 * r2), color: st.color as [number, number, number] });
    }
    rows.sort((a, b) => b.depthMm - a.depthMm);
    let T = 1;
    const C = [0, 0, 0];
    for (const r of rows) {
      const a = Math.min(1, Math.max(0, r.weight));
      C[0] += r.color[0] * a * T; C[1] += r.color[1] * a * T; C[2] += r.color[2] * a * T;
      T *= 1 - a;
    }
    const coverage = 1 - T;
    return {
      targetPx: [tx, ty], coverage,
      color: coverage > 1e-5 ? [C[0] / coverage, C[1] / coverage, C[2] / coverage] : [0, 0, 0],
      contributors: [...rows].sort((a, b) => b.weight - a.weight).slice(0, 8),
      neighborhoodMm: radiusMm,
    };
  }

  /** Nearest visible Gaussian centre in screen space, with depth as the tie-breaker. */
  pickSplatIndex(clientX: number, clientY: number): number | null {
    const l = this.activeLayer();
    if (!l) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const v = new THREE.Vector3(), world = new THREE.Vector3();
    let bestD = 12, bestDepth = Infinity, out: number | null = null;
    const proj = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const planes = this.clipPlanes();
    for (let i = 0; i < l.cloud.count; i++) {
      const fdi = l.cloud.misc[i * 4 + 1], layer = l.cloud.misc[i * 4 + 2];
      if (this.fdiHidden(fdi) || (this.layerAlphas[layer] ?? 1) <= 0.001) continue;
      if (this.inspectIsolate && this.inspectedIndex >= 0 && i !== this.inspectedIndex) continue;
      this.splatWorld(l, i, world);
      if (!this.pointPassesClip(world, planes)) continue;
      v.copy(world).applyMatrix4(proj);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < 12 && (v.z < bestDepth - 0.025 || (Math.abs(v.z - bestDepth) <= 0.025 && d < bestD))) {
        bestD = d; bestDepth = v.z; out = i;
      }
    }
    return out;
  }

  /** Fallback for local/no-proxy packets: nearest visible splat centre, with depth ordering. */
  pickSplatCenter(clientX: number, clientY: number): THREE.Vector3 | null {
    const l = this.activeLayer();
    if (!l) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const v = new THREE.Vector3(), world = new THREE.Vector3();
    let bestD = 14, bestDepth = Infinity, out: THREE.Vector3 | null = null;
    const proj = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const planes = this.clipPlanes();
    for (let i = 0; i < l.cloud.count; i++) {
      const fdi = l.cloud.misc[i * 4 + 1], layer = l.cloud.misc[i * 4 + 2];
      if (this.fdiHidden(fdi) || (this.layerAlphas[layer] ?? 1) <= 0.001) continue;
      this.splatWorld(l, i, world);
      if (!this.pointPassesClip(world, planes)) continue;
      v.copy(world).applyMatrix4(proj);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < 14 && (v.z < bestDepth - 0.25 || (Math.abs(v.z - bestDepth) <= 0.25 && d < bestD))) {
        bestD = d; bestDepth = v.z; out = world.clone();
      }
    }
    return out;
  }

  private drawMeasure(a: THREE.Vector3, b: THREE.Vector3) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x7dd3fc }));
    this.measureHud = { a: a.clone(), b: b.clone(), label: `${a.distanceTo(b).toFixed(1)} mm`, color: '#7dd3fc' };
    this.measureGroup.add(line);
  }

  private makeLabel(text: string) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(6,12,20,0.78)';
    ctx.strokeStyle = 'rgba(125,211,252,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(4, 10, 248, 44, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e2f3ff';
    ctx.font = '600 30px ui-sans-serif, system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(16, 4, 1);
    return spr;
  }

  clearMeasure() {
    for (const o of [...this.measureGroup.children]) {
      this.measureGroup.remove(o);
      disposeObject(o);
    }
    this.measurePts = [];
    this.measureHud = null;
  }

  /** Nearest splat-centre clearance; this is not a root-apex surface distance. */
  auditClearance(fdi: number, targetLayer: number): ClearanceAudit | null {
    const layer = this.layer;
    if (!layer) return null;
    const r = nearestClearance(layer.centers, layer.cloud.misc, layer.cloud.count, fdi, targetLayer);
    return r ? { fdi, targetLayer, ...r } : null;
  }

  /** Draw the audited closest pair and fly to it; never derives the verdict from this drawing. */
  showClearanceAudit(audit: ClearanceAudit) {
    this.clearAudit();
    const a = new THREE.Vector3(...audit.a), b = new THREE.Vector3(...audit.b);
    const mid = a.clone().lerp(b, 0.5), dir = b.clone().sub(a);
    const len = dir.length();
    if (len > 1e-5) {
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, len, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      cyl.position.copy(mid);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      cyl.renderOrder = 950;
      this.auditGroup.add(cyl);
    }
    for (const [p, color] of [[a, 0xf97316], [b, 0x22d3ee]] as const) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      dot.position.copy(p);
      dot.renderOrder = 960;
      this.auditGroup.add(dot);
    }
    this.auditHud = { a: a.clone(), b: b.clone(), label: `${audit.distance.toFixed(2)} mm`, color: '#22d3ee' };
    this.autoRotate = false;
    this.goal = { theta: -0.9, phi: -0.18, radius: Math.max(28, 64), target: mid };
  }

  clearAudit() {
    for (const o of [...this.auditGroup.children]) {
      this.auditGroup.remove(o);
      disposeObject(o);
    }
    this.auditHud = null;
  }

  /** Project the latest measurement/audit pair for a crisp DOM/SVG overlay, in CSS pixels. */
  getVectorHud(): VectorHudEntry[] {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    this.camera.updateMatrixWorld();
    const project = (point: THREE.Vector3): [number, number] | null => {
      const inCamera = point.clone().applyMatrix4(this.camera.matrixWorldInverse);
      if (inCamera.z >= -this.camera.near) return null;
      const p = point.clone().project(this.camera);
      if (p.z < -1 || p.z > 1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) return null;
      return [(p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height];
    };
    const out: VectorHudEntry[] = [];
    for (const [kind, source] of [['measure', this.measureHud], ['audit', this.auditHud]] as const) {
      if (!source) continue;
      const a = project(source.a), b = project(source.b);
      if (a && b) out.push({ kind, a, b, label: source.label, color: source.color });
    }
    return out;
  }

  // ------------------------------------------------------------------ state

  activeLayer(): SplatLayer | null { return this.quadCompare && this.quadLayers.length ? this.quadLayers[0] : (this.variant === 'full' ? this.layer : this.layerAlt); }
  primaryLayer(): SplatLayer | null { return this.quadCompare && this.quadLayers.length ? this.quadLayers[0] : this.layer; }

  applyUniforms() {
    const layers = [this.layer, this.layerAlt, ...this.quadLayers];
    for (const l of layers) {
      if (!l) continue;
      l.setSelected(this.selectedTooth);
      l.u.uJawGap.value = this.jawGap;
      l.u.uSheen.value = this.sheen * (l.cloud.hasSH1 ? 1 : 0);
      l.u.uOutline.value = this.outline;
      l.u.uShowLesions.value = this.showLesions ? 1 : 0;
      l.u.uOpacityScale.value = this.opacity;
      l.u.uVisMode.value = this.labUniformMode();
      l.u.uInspectIndex.value = this.inspectedIndex;
      l.u.uInspectOnly.value = this.inspectIsolate ? 1 : 0;
      l.setClipPlanes(this.clipPlanes(), this.clip.band, this.clip.cap);
    }
    this.updateGizmo();
  }

  jawGap = 0; sheen = 1; outline = 0.45; showLesions = true; opacity = 1; isolateTooth = false;
  hiddenTeeth: number[] = [];
  visMode: 0 | 1 = 0;
  /** Per-anatomical-layer transparency (the four CBCT sliders live here). */
  layerAlphas: Record<number, number> = {};

  /** Highlight one FDI tooth (also used by the 2D odontogram). */
  select(fdi: number, opts: { pulse?: boolean } = {}) {
    this.selectedTooth = fdi;
    this.applyUniforms();
    if (opts.pulse !== false) {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 620);
        const pulse = Math.sin(k * Math.PI) * (1 - k * 0.35);
        for (const l of [this.layer, this.layerAlt]) { l?.setPulse(fdi, pulse); l?.setSelected(fdi); }
        if (k < 1 && !this.disposed) requestAnimationFrame(step);
        else for (const l of [this.layer, this.layerAlt]) l?.setPulse(fdi, 0);
      };
      requestAnimationFrame(step);
    }
    if (this.isolateTooth) this.set({});
  }

  setLayerAlpha(id: number, v: number) {    this.layerAlphas[id] = v;
    for (const l of [this.layer, this.layerAlt, ...this.quadLayers]) l?.setLayerAlpha(id, v);
  }

  setLayerAlphaMap(map: Record<number, number>) {
    this.layerAlphas = { ...map };
    for (const l of [this.layer, this.layerAlt, ...this.quadLayers]) l?.setLayerAlphas(this.layerAlphas);
  }

  set(patch: Partial<Pick<DentSplatViewer, 'jawGap' | 'sheen' | 'outline' | 'showLesions' | 'opacity' | 'isolateTooth' | 'hiddenTeeth'> & { clip: DentSplatViewer['clip'] }>) {
    Object.assign(this, patch);
    if (patch.clip) this.clip = patch.clip;
    // The hinge moves splats in depth, so the bucket order has to be rebuilt.
    if (patch.jawGap !== undefined) { this.forceSort = true; this.applyJawToProxy(); }
    if (patch.hiddenTeeth || patch.isolateTooth !== undefined) {
      const hidden = this.isolateTooth && this.selectedTooth ? this.allFdIs().filter((f) => f !== this.selectedTooth) : this.hiddenTeeth;
      for (const l of [this.layer, this.layerAlt]) l?.setHidden(hidden);
    }
    this.applyUniforms();
    if (this.geometricMode() && (patch.clip || patch.jawGap !== undefined || patch.hiddenTeeth || patch.isolateTooth !== undefined)) {
      this.setLabMode(this.labMode);
    }
  }

  /**
   * Move the invisible proxy with the same jaw kinematics the shader applies to the splats. Without
   * this the mandible visibly opens while every click and every millimetre measurement still lands on
   * the closed rest pose. rh and the hinge are copied from SPLAT_VERTEX (rh = 66 mm, hinge = (0,-14,-34)).
   */
  private applyJawToProxy() {
    if (!this.proxy) return;
    const gap = this.jawGap;
    const th = gap > 0.001 ? 2 * Math.asin(Math.min(0.8, gap / (2 * 66))) : 0;
    const glide = Math.max(0, gap - 20) * 0.30;
    const hinge = new THREE.Vector3(0, -14, -34);
    const W = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    this.proxy.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.parent) return;
      const fdi = Number(/^FDI_(\d+)/.exec(fdiNameOf(m))?.[1] ?? 0);
      const world0 = m.userData.world0 as THREE.Matrix4 | undefined;
      if (!fdi || !world0) return;
      if (fdi >= 30) {
        // W = T(hinge) * T(glide) * Rx(th) * T(-hinge); the two translations commute, so the shader's
        // order (rotate about the hinge, then glide) is preserved.
        W.makeTranslation(hinge.x, hinge.y, hinge.z);
        tmp.makeTranslation(0, -glide, -glide * 0.45); W.multiply(tmp);
        tmp.makeRotationX(th); W.multiply(tmp);
        tmp.makeTranslation(-hinge.x, -hinge.y, -hinge.z); W.multiply(tmp);
      } else {
        W.makeTranslation(0, Math.min(1.2, gap * 0.02), 0);
      }
      m.matrix.copy(m.parent!.matrixWorld.clone().invert().multiply(W).multiply(world0));
    });
    this.proxy.updateMatrixWorld(true);
  }

  private allFdIs(): number[] {
    const s = new Set<number>();
    this.proxy?.traverse((o) => {
      const m = /^FDI_(\d+)/.exec(fdiNameOf(o));
      if (m) s.add(Number(m[1]));
    });
    return [...s].sort((a, b) => a - b);
  }

  clipPlanes(): THREE.Vector4[] {
    if (!this.clip.axis) return [];
    const n = AXIS_VEC[this.clip.axis];
    return [new THREE.Vector4(n.x, n.y, n.z, this.clip.offset)];
  }

  private updateGizmo() {
    for (const o of [...this.gizmo.children]) {
      this.gizmo.remove(o);
      (o as THREE.Mesh).geometry?.dispose?.();
      disposeMaterial((o as THREE.Mesh).material);
    }
    if (!this.clip.axis) return;
    const n = AXIS_VEC[this.clip.axis];
    const geo = new THREE.PlaneGeometry(150, 120);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    plane.position.copy(n).multiplyScalar(this.clip.offset);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.55 }),
    );
    edges.quaternion.copy(plane.quaternion);
    edges.position.copy(plane.position);
    this.gizmo.add(plane, edges);
  }

  setVariant(v: 'full' | 'pruned', split = this.splitCompare) {
    this.variant = v;
    this.splitCompare = split;
  }

  setVisMode(v: 0 | 1) {
    this.visMode = v;
    this.applyLabUniforms();
  }

  private labUniformMode(): number {
    if (this.labMode === 'opacity') return 2;
    if (this.labMode === 'scale') return 3;
    if (this.labMode === 'normal') return 4;
    if (this.labMode === 'depth') return 5;
    return this.visMode;
  }

  private applyLabUniforms() {
    const vm = this.labUniformMode();
    for (const l of [this.layer, this.layerAlt]) if (l) l.u.uVisMode.value = vm;
  }

  private geometricMode(): boolean {
    return this.labMode === 'ellipsoid' || this.labMode === 'centers' || this.labMode === 'wire';
  }

  private splatQuat(layer: SplatLayer, i: number, out: THREE.Quaternion): void {
    const c = layer.cloud;
    if (c.raw) {
      out.set(c.raw.quats[i * 4], c.raw.quats[i * 4 + 1], c.raw.quats[i * 4 + 2], c.raw.quats[i * 4 + 3]);
    } else {
      out.set(
        c.rot[i * 4] / 255 * 2 - 1, c.rot[i * 4 + 1] / 255 * 2 - 1,
        c.rot[i * 4 + 2] / 255 * 2 - 1, c.rot[i * 4 + 3] / 255 * 2 - 1,
      );
    }
    out.normalize();
    if (this.jawGap > 0.001 && (c.misc[i * 4 + 3] & FLAG.lowerJaw)) {
      const th = 2 * Math.asin(Math.min(0.8, this.jawGap / (2 * 66)));
      const qJaw = new THREE.Quaternion(Math.sin(th / 2), 0, 0, Math.cos(th / 2));
      out.premultiply(qJaw);
    }
  }

  private splatSigma(layer: SplatLayer, i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = layer.cloud;
    if (c.raw) {
      return out.set(c.raw.scales[i * 3], c.raw.scales[i * 3 + 1], c.raw.scales[i * 3 + 2]);
    }
    const ls = c.scaleLogMax - c.scaleLogMin;
    return out.set(
      Math.exp(c.scaleLogMin + (c.scale[i * 3] / 255) * ls),
      Math.exp(c.scaleLogMin + (c.scale[i * 3 + 1] / 255) * ls),
      Math.exp(c.scaleLogMin + (c.scale[i * 3 + 2] / 255) * ls),
    );
  }

  private splatAlpha(layer: SplatLayer, i: number): number {
    const c = layer.cloud;
    return c.raw ? c.raw.alphas[i] : c.misc[i * 4] / 255;
  }

  private splatColor(layer: SplatLayer, i: number, out: THREE.Color): THREE.Color {
    const c = layer.cloud;
    if (c.raw) return out.setRGB(c.raw.colors[i * 3], c.raw.colors[i * 3 + 1], c.raw.colors[i * 3 + 2]);
    return out.setRGB(c.color[i * 3] / 255, c.color[i * 3 + 1] / 255, c.color[i * 3 + 2] / 255);
  }

  private visibleSplat(layer: SplatLayer, i: number, world: THREE.Vector3, planes: THREE.Vector4[]): boolean {
    const c = layer.cloud;
    const fdi = c.misc[i * 4 + 1], ly = c.misc[i * 4 + 2];
    if (this.fdiHidden(fdi) || (this.layerAlphas[ly] ?? 1) <= 0.001) return false;
    if (this.inspectIsolate && this.inspectedIndex >= 0 && i !== this.inspectedIndex) return false;
    this.splatWorld(layer, i, world);
    return this.pointPassesClip(world, planes);
  }

  clearLab() {
    for (const o of [...this.labGroup.children]) {
      this.labGroup.remove(o);
      disposeObject(o);
    }
    this.labInfo = { mode: this.labMode, available: this.activeLayer()?.cloud.count ?? 0, rendered: 0, truncated: false, triangles: 0, points: 0 };
  }

  /** Build the current geometry representation from the actual centres, quaternions and scales. */
  setLabMode(mode: LabMode): LabInfo {
    this.labMode = mode;
    this.clearLab();
    this.labGroup.visible = this.geometricMode();
    for (const l of [this.layer, this.layerAlt]) l?.mesh && (l.mesh.visible = !this.geometricMode());
    this.applyLabUniforms();
    const l = this.activeLayer();
    if (!l) return this.labInfo;
    if (!this.geometricMode()) {
      this.labInfo = { mode, available: l.cloud.count, rendered: 0, truncated: false, triangles: 0, points: 0 };
      this.forceSort = true;
      return this.labInfo;
    }

    const planes = this.clipPlanes();
    const world = new THREE.Vector3();
    const cap = mode === 'ellipsoid' ? 30000 : mode === 'wire' ? 20000 : Infinity;
    const stride = Number.isFinite(cap) ? Math.max(1, Math.ceil(l.cloud.count / cap)) : 1;
    const keep: number[] = [];
    for (let i = 0; i < l.cloud.count; i += stride) {
      if (this.visibleSplat(l, i, world, planes)) keep.push(i);
    }
    this.labInfo = {
      mode, available: l.cloud.count, rendered: keep.length,
      truncated: stride > 1,
      triangles: 0, points: 0,
    };

    if (mode === 'centers') {
      const pos = new Float32Array(keep.length * 3), col = new Float32Array(keep.length * 3);
      const c = new THREE.Color();
      for (let k = 0; k < keep.length; k++) {
        const i = keep[k];
        this.splatWorld(l, i, world);
        pos[k * 3] = world.x; pos[k * 3 + 1] = world.y; pos[k * 3 + 2] = world.z;
        this.splatColor(l, i, c);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.PointsMaterial({
        size: 0.32, sizeAttenuation: true, vertexColors: true, transparent: true,
        opacity: 0.95, depthTest: true, depthWrite: false,
      });
      const points = new THREE.Points(g, m);
      points.frustumCulled = false;
      points.renderOrder = 20;
      this.labGroup.add(points);
      this.labInfo.points = keep.length;
      return this.labInfo;
    }

    const geo = new THREE.IcosahedronGeometry(1, mode === 'ellipsoid' ? 1 : 0);
    const mat = mode === 'wire'
      ? new THREE.MeshBasicMaterial({ color: 0x7dd3fc, wireframe: true, transparent: true, opacity: 0.52, depthWrite: false })
      : new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, keep.length));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k];
      this.splatWorld(l, i, p);
      this.splatQuat(l, i, q);
      this.splatSigma(l, i, s).multiplyScalar(this.labSigma);
      mtx.compose(p, q, s);
      mesh.setMatrixAt(k, mtx);
      if (mode === 'ellipsoid') {
        this.splatColor(l, i, c).multiplyScalar(1.15);
        mesh.setColorAt(k, c);
      }
    }
    mesh.count = keep.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    this.labGroup.add(mesh);
    const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    this.labInfo.triangles = Math.round(tris * keep.length);
    return this.labInfo;
  }

  setLabSigma(sigma: 1 | 2 | 3): LabInfo {
    this.labSigma = sigma;
    if (this.inspectedIndex >= 0) {
      const state = this.primaryLayer()?.inspect(this.inspectedIndex);
      if (state) this.drawInspectMarker(this.primaryLayer()!, this.inspectedIndex, state);
    }
    if (this.geometricMode()) return this.setLabMode(this.labMode);
    return this.labInfo;
  }

  private clearInspect() {
    for (const o of [...this.inspectGroup.children]) {
      this.inspectGroup.remove(o);
      disposeObject(o);
    }
    for (const l of [this.layer, this.layerAlt]) l?.setInspect(-1, false);
    this.inspectedIndex = -1;
    this.inspectIsolate = false;
  }

  private drawInspectMarker(layer: SplatLayer, i: number, state: GaussianInspect) {
    for (const o of [...this.inspectGroup.children]) {
      this.inspectGroup.remove(o);
      disposeObject(o);
    }
    const p = new THREE.Vector3(...state.center);
    const q = new THREE.Quaternion(...state.quat);
    const s = new THREE.Vector3(...state.scales).multiplyScalar(this.labSigma);
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(...state.color), transparent: true,
        opacity: Math.max(0.08, Math.min(0.42, state.alpha * 0.32)),
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    shell.position.copy(p); shell.quaternion.copy(q); shell.scale.copy(s);
    shell.renderOrder = 968;
    this.inspectGroup.add(shell);
    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    wire.position.copy(p); wire.quaternion.copy(q); wire.scale.copy(s).multiplyScalar(1.025);
    wire.renderOrder = 970;
    this.inspectGroup.add(wire);
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.06, Math.min(0.42, Math.max(...state.scales) * 0.08)), 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 1 }),
    );
    center.position.copy(p); center.renderOrder = 972;
    this.inspectGroup.add(center);
    const axisColors = [0xef4444, 0x22c55e, 0x3b82f6];
    for (let k = 0; k < 3; k++) {
      const dir = new THREE.Vector3(...state.axes.directions[k]);
      const len = Math.max(0.12, state.axes.sigmas[k] * this.labSigma * 1.35);
      const head = Math.max(0.04, len * 0.08);
      for (const sign of [1, -1]) {
        const arrow = new THREE.ArrowHelper(dir.clone().multiplyScalar(sign), p, len, axisColors[k], head, head * 0.55);
        const lineMat = arrow.line.material as THREE.LineBasicMaterial;
        const coneMat = arrow.cone.material as THREE.MeshBasicMaterial;
        lineMat.depthTest = false;
        lineMat.transparent = true;
        lineMat.opacity = 0.9;
        coneMat.depthTest = false;
        coneMat.transparent = true;
        coneMat.opacity = 0.9;
        arrow.renderOrder = 971;
        this.inspectGroup.add(arrow);
      }
    }
    const label = this.makeLabel(`#${i} · ${this.labSigma}σ`);
    label.position.copy(p).add(new THREE.Vector3(0, Math.max(1.5, s.x * 1.5), 0));
    label.renderOrder = 1000;
    this.inspectGroup.add(label);
  }

  selectGaussian(index: number, opts: { focus?: boolean; isolate?: boolean } = {}): GaussianInspect | null {
    const layer = this.primaryLayer();
    if (!layer) return null;
    const state = layer.inspect(index);
    if (!state) return null;
    this.inspectedIndex = index;
    this.inspectIsolate = opts.isolate ?? this.inspectIsolate;
    for (const l of [this.layer, this.layerAlt]) l?.setInspect(index, this.inspectIsolate);
    this.drawInspectMarker(layer, index, state);
    if (this.geometricMode()) this.setLabMode(this.labMode);
    if (opts.focus) {
      this.autoRotate = false;
      const r = Math.max(28, Math.min(90, Math.max(...state.scales) * 12 + 18));
      this.goal = { theta: this.theta, phi: this.phi, radius: r, target: new THREE.Vector3(...state.center) };
    }
    return state;
  }

  setGaussianPosition(index: number, center: Vec3): GaussianInspect | null {
    const layer = this.primaryLayer();
    const actual = layer?.setSplatPosition(index, center);
    if (!layer || !actual) return null;
    const state = layer.inspect(index);
    if (state) this.drawInspectMarker(layer, index, state);
    if (this.geometricMode()) this.setLabMode(this.labMode);
    this.forceSort = true;
    return state;
  }

  setGaussianColor(index: number, color: Vec3): GaussianInspect | null {
    const layer = this.primaryLayer();
    const actual = layer?.setSplatColor(index, color);
    if (!layer || !actual) return null;
    const state = layer.inspect(index);
    if (state) this.drawInspectMarker(layer, index, state);
    return state;
  }

  setGaussianRotation(index: number, quat: [number, number, number, number]): GaussianInspect | null {
    const layer = this.primaryLayer();
    const actual = layer?.setSplatRotation(index, quat);
    if (!layer || !actual) return null;
    const state = layer.inspect(index);
    if (state) this.drawInspectMarker(layer, index, state);
    if (this.geometricMode()) this.setLabMode(this.labMode);
    return state;
  }

  setGaussianScale(index: number, scales: Vec3): GaussianInspect | null {
    const layer = this.primaryLayer();
    const actual = layer?.setSplatScale(index, scales);
    if (!layer || !actual) return null;
    const state = layer.inspect(index);
    if (state) this.drawInspectMarker(layer, index, state);
    if (this.geometricMode()) this.setLabMode(this.labMode);
    return state;
  }

  setGaussianOpacity(index: number, alpha: number): GaussianInspect | null {
    const layer = this.primaryLayer();
    const actual = layer?.setSplatOpacity(index, alpha);
    if (!layer || actual == null) return null;
    const state = layer.inspect(index);
    if (state) this.drawInspectMarker(layer, index, state);
    return state;
  }

  setGaussianIsolate(on: boolean) {
    this.inspectIsolate = on;
    for (const l of [this.layer, this.layerAlt]) l?.setInspect(this.inspectedIndex, on);
    if (this.geometricMode()) this.setLabMode(this.labMode);
    else this.forceSort = true;
  }

  exportPly(): { buffer: ArrayBuffer; name: string; precision: 'fp32' | 'dspk-8bit' } | null {
    const layer = this.primaryLayer();
    if (!layer) return null;
    return {
      buffer: layer.exportPly(),
      name: `dentsplat_${this.caseId}_${layer.cloud.count}_${layer.cloud.raw ? 'fp32' : 'dspk'}.ply`,
      precision: layer.cloud.raw ? 'fp32' : 'dspk-8bit',
    };
  }

  clearGaussianSelection() {
    this.clearInspect();
    if (this.geometricMode()) this.setLabMode(this.labMode);
    else this.forceSort = true;
  }

  setWireframe(on: boolean) {
    this.showWire = on;
    this.clearWire();
    if (!on || !this.proxy) return;
    const root = new THREE.Group();
    this.proxy.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const ls = new THREE.LineSegments(
        new THREE.EdgesGeometry(m.geometry, 24),
        new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45, depthTest: false }),
      );
      // Freeze the mesh's absolute transform: the wireframe must land on the splats
      // tooth-for-tooth, otherwise the alignment check proves nothing.
      m.updateWorldMatrix(true, false);
      ls.matrixAutoUpdate = false;
      ls.matrix.copy(m.matrixWorld);
      ls.renderOrder = 900;
      root.add(ls);
    });
    this.wireRoot = root;
    this.caseGroup.add(root);
  }

  private clearWire() {
    const root = this.wireRoot;
    if (!root) return;
    disposeObject(root);
    root.removeFromParent();
    this.wireRoot = null;
  }

  focus(target: [number, number, number], radius: number) {
    this.goal = {
      theta: this.theta, phi: this.phi, radius, target: new THREE.Vector3(...target),
    };
  }

  flyTo(p: ViewPreset) {
    this.goal = {
      theta: (p.theta * Math.PI) / 180, phi: (p.phi * Math.PI) / 180, radius: p.radius,
      target: new THREE.Vector3(...(p.target ?? [0, 0, 0])),
    };
    if (p.fov !== undefined) { this.camera.fov = p.fov; this.camera.updateProjectionMatrix(); }
    this.autoRotate = false;
  }

  /** Proxy mesh for one FDI tooth, whatever node nesting the exporter produced. */
  proxyMesh(fdi: number): THREE.Mesh | null {
    let out: THREE.Mesh | null = null;
    this.proxy?.traverse((o) => {
      if (out) return;
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const id = /^FDI_(\d+)/.exec(fdiNameOf(m));
      if (id && Number(id[1]) === fdi) out = m;
    });
    return out;
  }

  toothBox(fdi: number): THREE.Box3 | null {
    const mesh = this.proxyMesh(fdi);
    if (!mesh) return null;
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return null;
    return new THREE.Box3().copy(bb).applyMatrix4(mesh.matrixWorld);
  }

  focusTooth(fdi: number) {
    const box = this.toothBox(fdi);
    if (!box) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.goal = { theta: this.theta, phi: this.phi, radius: Math.max(26, size * 3.4), target: c };
  }

  // ------------------------------------------------------------------ render

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.frame();
  };

  /**
   * One frame, decoupled from requestAnimationFrame so a hidden/zero-size tab can still be
   * benchmarked deterministically (rAF does not fire there at all).
   */
  frame(dt = Math.min(0.05, this.clock.getDelta())) {
    const t0 = performance.now();
    if (this.autoRotate) this.theta += dt * 0.12;
    if (this.goal) {
      const k = 1 - Math.pow(0.0015, dt);
      this.theta += (this.goal.theta - this.theta) * k;
      this.phi += (this.goal.phi - this.phi) * k;
      this.radius += (this.goal.radius - this.radius) * k;
      this.target.lerp(this.goal.target, k);
      if (Math.abs(this.goal.radius - this.radius) < 0.05 && this.target.distanceTo(this.goal.target) < 0.05) this.goal = null;
    }
    const pos = new THREE.Vector3(
      this.target.x + this.radius * Math.sin(this.theta) * Math.cos(this.phi),
      this.target.y + this.radius * Math.sin(this.phi),
      this.target.z + this.radius * Math.cos(this.theta) * Math.cos(this.phi),
    );
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();

    // The splat quad is sized in 'pixels of the render target', so this must be the DRAWING BUFFER
    // size, not the CSS size: on a 2x display getSize() would halve every splat and the AA term.
    const r = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const vp = new THREE.Vector2(r.x, r.y);
    const view = this.camera.matrixWorldInverse;
    if (this.quadCompare) {
      const fw = Math.floor(r.x / 2), fh = Math.floor(r.y / 2);
      const qvp = new THREE.Vector2(fw, fh);
      for (const l of this.quadLayers) { (l.u.uViewportPx.value as THREE.Vector2).set(fw, fh); l.update(view, qvp, this.forceSort); }
      this.forceSort = false;
      this.renderQuad(r, fw, fh);
    } else {
      if (this.splitCompare) {
        this.layer?.update(view, vp, this.forceSort);
        this.layerAlt?.update(view, vp, this.forceSort);
      } else {
        this.activeLayer()?.update(view, vp, this.forceSort);
      }
      this.forceSort = false;

      if (this.splitCompare) {
        // Two independent viewports, identical camera and projection, different packets.
        const fw = Math.floor(r.x * this.splitRatio);
        this.camera.aspect = fw / r.y; this.camera.updateProjectionMatrix();
        this.renderer.setScissorTest(true);
        this.renderer.setViewport(0, 0, fw, r.y);
        this.renderer.setScissor(0, 0, fw, r.y);
        this.renderOne(this.layer);
        this.renderer.setViewport(fw, 0, r.x - fw, r.y);
        this.renderer.setScissor(fw, 0, r.x - fw, r.y);
        this.renderOne(this.layerAlt);
        this.renderer.setScissorTest(false);
        this.renderer.setViewport(0, 0, r.x, r.y);
        this.camera.aspect = r.x / r.y; this.camera.updateProjectionMatrix();
      } else {
        this.renderOne(null);
      }
    }

    const ms = performance.now() - t0;
    this.frameEMA = this.frameEMA * 0.9 + ms * 0.1;
    this.fpsEMA = this.fpsEMA * 0.92 + (dt > 0 ? 1 / dt : 60) * 0.08;
    this.maybeEmitStats();
    return ms;
  }

  /** The HUD is a wall-clock sample, not a per-frame one; 250 ms keeps React out of the hot path. */
  private maybeEmitStats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStats <= 250) return;
    this.lastStats = now;
    const l = this.activeLayer();
    this.onStats?.({
      fps: Math.round(this.fpsEMA), splats: l?.cloud.count ?? 0, visible: l?.visible ?? 0,
      sortMs: +(l?.sortMs ?? 0).toFixed(2), frameMs: +this.frameEMA.toFixed(2),
      bytes: this.variant === 'full' ? this.fullBytes : this.prunedBytes, gpu: this.gpu,
    });
  }

  /**
   * Drive frames without requestAnimationFrame. A hidden tab throttles rAF to zero, so this is
   * the only honest way to measure sustained cost there; on a visible tab it is what the
   * demo-video capture uses to render deterministic frames.
   */
  pump(n = 60) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.frame(1 / 60);
    const wall = performance.now() - t0;
    // A hidden tab never reaches this gate on wall clock, so the HUD would describe a state that
    // is several interactions old. Pumped frames are deterministic: publish them.
    this.maybeEmitStats(true);
    return { frames: n, wallMs: +wall.toFixed(1), perFrameMs: +(wall / n).toFixed(2), stats: this.statsSnapshot() };
  }
  private forceSort = true;
  private lastStats = 0;
  fullBytes = 0; prunedBytes = 0;

  private renderQuad(r: THREE.Vector2, fw: number, fh: number) {
    const saved = [this.caseGroup.visible, this.labGroup.visible, this.measureGroup.visible, this.auditGroup.visible, this.gizmo.visible, this.inspectGroup.visible];
    this.caseGroup.visible = false; this.labGroup.visible = false; this.measureGroup.visible = false;
    this.auditGroup.visible = false; this.gizmo.visible = false; this.inspectGroup.visible = false;
    this.camera.aspect = fw / fh; this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(true);
    const pos = [[0, r.y - fh], [fw, r.y - fh], [0, 0], [fw, 0]];
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < this.quadLayers.length; i++) this.quadLayers[i].mesh.visible = i === k;
      const [x, y] = pos[k];
      this.renderer.setViewport(x, y, fw, fh);
      this.renderer.setScissor(x, y, fw, fh);
      this.renderer.render(this.scene, this.camera);
    }
    for (const l of this.quadLayers) l.mesh.visible = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, r.x, r.y);
    this.camera.aspect = r.x / r.y; this.camera.updateProjectionMatrix();
    [this.caseGroup.visible, this.labGroup.visible, this.measureGroup.visible, this.auditGroup.visible, this.gizmo.visible, this.inspectGroup.visible] = saved;
  }

  private renderOne(only: SplatLayer | null) {
    const showSplat = !this.geometricMode();
    if (only) {
      const a = this.layer!, b = this.layerAlt!;
      a.mesh.visible = showSplat && a === only;
      b.mesh.visible = showSplat && b === only;
      this.renderer.render(this.scene, this.camera);
      a.mesh.visible = showSplat; b.mesh.visible = showSplat;
    } else {
      const l = this.activeLayer();
      if (this.layer) this.layer.mesh.visible = showSplat && l === this.layer;
      if (this.layerAlt) this.layerAlt.mesh.visible = showSplat && l === this.layerAlt;
      this.renderer.render(this.scene, this.camera);
      if (this.layer) this.layer.mesh.visible = showSplat;
      if (this.layerAlt) this.layerAlt.mesh.visible = showSplat;
    }
  }

  /**
   * Measure true PSNR between the full and pruned packets at the current camera.
   *
   * Two things make this number defensible rather than decorative:
   *  - sheen is forced to 0 for both passes. It is a view-dependent term the shader only applies
   *    where SH1 exists (`uSheen * (hasSH1 ? 1 : 0)`), so leaving it on would bill a feature toggle
   *    to the compression and understate fidelity for a reason that has nothing to do with bits.
   *  - the whole-frame PSNR is reported next to the masked one and the bit-identical fraction. Most
   *    of the frame is background where the two renders agree exactly, so the global number is
   *    diluted by pixels that carry no information about the splats; `psnrInMask` answers "how close
   *    are the teeth", which is the question a reviewer actually asks. Quoting either alone is
   *    misleading, so the UI shows both.
   */
  async bench(size = 384): Promise<BenchResult> {
    if (!this.layer || !this.layerAlt) {
      const empty: BenchPair = { psnr: 0, psnrInMask: 0, mae: 0, covered: 0, identicalFraction: 0,
        errorInTop1Percent: 0, maxDiff: 0, meanFull: [0, 0, 0], meanPruned: [0, 0, 0] };
      return { ...empty, samples: 0, control: { ...empty }, psnrSelf: 0, identicalSelfFraction: 0 };
    }
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 0 });
    const prevAspect = this.camera.aspect;
    const prevBg = this.scene.background;
    const prevSheen = [this.layer.u.uSheen.value, this.layerAlt.u.uSheen.value] as number[];
    this.scene.background = new THREE.Color(0x000000);
    this.camera.aspect = 1; this.camera.updateProjectionMatrix();
    const shots: Uint8Array[] = [];
    // The third pass re-renders the FULL packet. Same asset, same camera, same target: whatever
    // error that pair shows is readback/sort nondeterminism, not compression, and it is the control
    // that licenses quoting the first pair at all.
    for (const l of [this.layer, this.layerAlt, this.layer]) {
      this.layer!.mesh.visible = l === this.layer;
      this.layerAlt!.mesh.visible = l === this.layerAlt;
      l!.u.uViewportPx.value.set(size, size);
      l!.u.uSheen.value = 0;
      l!.update(this.camera.matrixWorldInverse, new THREE.Vector2(size, size), true);
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      const buf = new Uint8Array(size * size * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      shots.push(buf);
    }
    this.scene.background = prevBg;
    this.camera.aspect = prevAspect; this.camera.updateProjectionMatrix();
    this.layer.u.uSheen.value = prevSheen[0];
    this.layerAlt.u.uSheen.value = prevSheen[1];
    rt.dispose();
    const pair = (A: Uint8Array, B: Uint8Array) => {
      let se = 0, ae = 0, n = 0, seIn = 0, nIn = 0, same = 0, covered = 0, max = 0;
      const per: number[] = [];
      for (let i = 0; i < A.length; i += 4) {
        let ink = 0, pse = 0;
        for (let k = 0; k < 3; k++) {
          const a = A[i + k], b = B[i + k];
          const d = a - b, ad = d < 0 ? -d : d;
          se += d * d; ae += ad; n++; pse += d * d;
          if (ad > max) max = ad;
          if (a > 8 || b > 8) ink = 1;
        }
        if (ink) { covered++; nIn += 3; seIn += pse; }
        per.push(pse);
        if (A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2]) same++;
      }
      // Concentration: how much of the total squared error lives in the worst 1% of pixels. ~1 means
      // a handful of silhouette/edge pixels disagree (a geometry-coverage story); ~0.05 means the
      // whole surface disagrees (a colour/alpha story). Different diagnoses, different fixes.
      per.sort((x, y) => y - x);
      const total = se || 1;
      const top = per.slice(0, Math.max(1, Math.round(per.length / 100))).reduce((s, x) => s + x, 0);
      const mean = (X: Uint8Array) => { let r = 0, g = 0, bl = 0; for (let i = 0; i < X.length; i += 4) { r += X[i]; g += X[i + 1]; bl += X[i + 2]; } const px = X.length / 4; return [r, g, bl].map((v) => +(v / px).toFixed(1)) as [number, number, number]; };
      // 999 is the "bit-identical" sentinel: PSNR is undefined at MSE 0 and JSON cannot carry Infinity.
      const db = (sse: number, sn: number) => (sse === 0 ? 999 : +(10 * Math.log10(1 / (sse / Math.max(1, sn) / 65025))).toFixed(2));
      return {
        psnr: db(se, n),
        psnrInMask: db(seIn, nIn),
        mae: +(ae / Math.max(1, n) / 255).toFixed(4),
        covered: +(covered / (A.length / 4)).toFixed(4),
        identicalFraction: +(same / (A.length / 4)).toFixed(4),
        errorInTop1Percent: +(top / total).toFixed(3),
        maxDiff: max,
        meanFull: mean(A), meanPruned: mean(B),
      };
    };
    const head = pair(shots[0], shots[1]);
    const control = pair(shots[0], shots[2]);
    this.forceSort = true;
    return { ...head, samples: shots[0].length / 4 * 3, control,
      psnrSelf: control.psnr, identicalSelfFraction: control.identicalFraction };
  }

  /** Compare each equal-budget candidate against the same Full reference over fixed views/layers. */
  async benchCompression(
    referenceUrl: string,
    candidates: { name: string; cloud: SplatCloud }[],
    views: ViewPreset[],
    fdi = 48,
    targetLayer = 4,
    size = 256,
  ): Promise<CompressionBenchResult> {
    const refRes = await fetch(referenceUrl);
    if (!refRes.ok) throw new Error(`Full reference HTTP ${refRes.status}`);
    const refLayer = new SplatLayer(decodeSplatCloud(await refRes.arrayBuffer()), { opacityScale: 1 });
    const candLayers = candidates.map((c) => ({ name: c.name, layer: new SplatLayer(c.cloud, { opacityScale: 1 }) }));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 0 });
    const prevPos = this.camera.position.clone(), prevQuat = this.camera.quaternion.clone(), prevAspect = this.camera.aspect;
    const prevTarget = this.renderer.getRenderTarget(), prevViewport = this.renderer.getViewport(new THREE.Vector4());
    const prevScissor = this.renderer.getScissor(new THREE.Vector4()), prevScissorTest = this.renderer.getScissorTest();
    const prevClear = this.renderer.getClearColor(new THREE.Color()), prevAlpha = this.renderer.getClearAlpha();
    const overall = new Map<string, PixelStats | null>();
    const perLayer = new Map<string, Map<number, PixelStats | null>>();
    for (const c of candLayers) { overall.set(c.name, null); perLayer.set(c.name, new Map()); }
    const layerIds = [1, 3, 4, 7];
    const alphasFor = (only: number | null) => {
      const a = Array(9).fill(0) as number[];
      if (only == null) a.fill(1); else a[only] = 1;
      return Object.fromEntries(a.map((v, i) => [i, v]));
    };
    const shot = (layer: SplatLayer, only: number | null) => {
      layer.setLayerAlphas(alphasFor(only));
      layer.u.uSheen.value = 0; layer.u.uJawGap.value = 0; layer.u.uClipCount.value = 0;
      layer.u.uVisMode.value = 0; layer.u.uSelectedTooth.value = 0; layer.u.uPulseTooth.value = 0; layer.u.uPulse.value = 0;
      layer.u.uHiddenLo.value = 0; layer.u.uHiddenHi.value = 0; layer.u.uShowLesions.value = 0;
      layer.u.uOpacityScale.value = 1; layer.u.uDebug.value = 0;
      layer.u.uViewportPx.value.set(size, size);
      layer.update(this.camera.matrixWorldInverse, new THREE.Vector2(size, size), true);
      layer.mesh.visible = true; scene.add(layer.mesh);
      this.renderer.setRenderTarget(rt); this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, size, size);
      this.renderer.setClearColor(0x000000, 1); this.renderer.clear();
      this.renderer.render(scene, this.camera);
      scene.remove(layer.mesh);
      const buf = new Uint8Array(size * size * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      return buf;
    };
    try {
      this.camera.aspect = 1; this.camera.updateProjectionMatrix();
      for (const view of views) {
        const theta = view.theta * Math.PI / 180, phi = view.phi * Math.PI / 180;
        const target = new THREE.Vector3(...(view.target ?? [0, 0, 0]));
        this.camera.position.set(
          target.x + view.radius * Math.sin(theta) * Math.cos(phi),
          target.y + view.radius * Math.sin(phi),
          target.z + view.radius * Math.cos(theta) * Math.cos(phi),
        );
        this.camera.lookAt(target); this.camera.updateMatrixWorld();
        for (const only of [null, ...layerIds]) {
          const ref = shot(refLayer, only);
          for (const c of candLayers) {
            const stats = comparePixelStats(ref, shot(c.layer, only));
            if (only == null) {
              const old = overall.get(c.name); overall.set(c.name, old ? (addPixelStats(old, stats), old) : stats);
            } else {
              const map = perLayer.get(c.name)!;
              const old = map.get(only); map.set(only, old ? (addPixelStats(old, stats), old) : stats);
            }
          }
        }
      }
    } finally {
      refLayer.dispose(); for (const c of candLayers) c.layer.dispose(); rt.dispose();
      this.camera.position.copy(prevPos); this.camera.quaternion.copy(prevQuat); this.camera.aspect = prevAspect; this.camera.updateProjectionMatrix();
      this.renderer.setRenderTarget(prevTarget); this.renderer.setViewport(prevViewport); this.renderer.setScissor(prevScissor);
      this.renderer.setScissorTest(prevScissorTest); this.renderer.setClearColor(prevClear, prevAlpha);
      this.forceSort = true;
    }
    const refClear = nearestClearance(refLayer.centers, refLayer.cloud.misc, refLayer.cloud.count, fdi, targetLayer);
    return {
      size, views: views.map((v) => v.id), referenceClearance: refClear?.distance ?? null,
      candidates: candLayers.map((c) => {
        const clear = nearestClearance(c.layer.centers, c.layer.cloud.misc, c.layer.cloud.count, fdi, targetLayer);
        const layers: Record<number, BenchPair> = {};
        for (const id of layerIds) {
          const s = perLayer.get(c.name)!.get(id);
          if (s) layers[id] = finishPixelStats(s);
        }
        return {
          name: c.name, overall: finishPixelStats(overall.get(c.name)!),
          layers, clearance_mm: clear?.distance ?? null,
          clearance_delta_mm: clear && refClear ? +(clear.distance - refClear.distance).toFixed(4) : null,
        };
      }),
    };
  }

  /** Shader bisection harness (see uDebug in shaders.ts). 0 = production path. */
  setDebug(n: number) {
    for (const l of [this.layer, this.layerAlt]) if (l) l.u.uDebug.value = n;
    this.forceSort = true;
  }

  /** Diagnostic harness for automated verification: separates "render-target + readback works",
   * "splat pass rasterises", and "the blend state is what hides it" into three comparable shots.
   */
  selfTest() {
    const w = 96, h = 96;
    const rt = new THREE.WebGLRenderTarget(w, h);
    const b = new Uint8Array(w * h * 4);
    const gl = this.renderer.getContext();
    // The offscreen pass is square; the live camera is not. On an automation window the canvas is
    // 428x1, so camera.aspect is 428 and a 96x96 target then frames nothing -- selfTest reported
    // "lit: 0" for a perfectly healthy renderer. Own the aspect (and the scissor) for the duration
    // of the test and restore both, exactly like renderProbe does.
    const prevAspect = this.camera.aspect;
    const prevScissor = this.renderer.getScissorTest();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(false);
    const shot = (name: string) => {
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 1);
      const e0 = gl.getError();
      this.renderer.render(this.scene, this.camera);
      const calls = this.renderer.info.render.calls;
      const e1 = gl.getError();
      this.renderer.setRenderTarget(null);
      this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
      const e2 = gl.getError();
      let lit = 0;
      for (let i = 0; i < w * h; i++) if (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2] > 40) lit++;
      const c = ((h >> 1) * w + (w >> 1)) * 4;
      return { name, calls, lit, e0, e1, e2, mid: [b[c], b[c + 1], b[c + 2], b[c + 3]] };
    };
    const splat = this.layer;
    const res: Record<string, unknown> = {};
    if (!splat) return { error: 'no layer loaded' };
    const prevVis = splat.mesh.visible;
    const box = new THREE.Mesh(new THREE.BoxGeometry(70, 70, 70), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    splat.mesh.visible = false;
    this.scene.add(box);
    res.box = shot('box');
    this.scene.remove(box);
    box.geometry.dispose();
    (box.material as THREE.Material).dispose();
    splat.mesh.visible = true;
    res.splat = shot('splat');
    const m = splat.material;
    const prevBlend = m.blending;
    m.blending = THREE.NormalBlending;
    m.needsUpdate = true;
    res.splatNormalBlend = shot('splat-normal');
    m.blending = prevBlend;
    m.needsUpdate = true;
    splat.mesh.visible = prevVis;
    rt.dispose();
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(prevScissor);
    res.state = {
      transparent: m.transparent, depthTest: m.depthTest, depthWrite: m.depthWrite, side: m.side,
      blending: prevBlend, glslVersion: m.glslVersion, drawRange: m && splat.geometry.drawRange.count,
      indexType: (splat.geometry.index as THREE.BufferAttribute).array?.constructor.name,
      attrs: Object.keys(splat.geometry.attributes),
    };
    return res;
  }

  /** Same payload as the onStats callback, on demand. */
  statsSnapshot(): Stats {
    const l = this.activeLayer();
    return {
      fps: Math.round(this.fpsEMA), splats: l?.cloud.count ?? 0, visible: l?.visible ?? 0,
      sortMs: +(l?.sortMs ?? 0).toFixed(2), frameMs: +this.frameEMA.toFixed(2),
      bytes: this.variant === 'full' ? this.fullBytes : this.prunedBytes, gpu: this.gpu,
    };
  }

  /** Drawing-buffer size in device pixels. */
  canvasSize(): [number, number] {
    const s = this.renderer.getSize(new THREE.Vector2());
    return [Math.round(s.x), Math.round(s.y)];
  }

  snapshot() {
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Offscreen render + raw pixel statistics. Returns numbers computed from the actual RGBA
   * buffer, so a broken encode path cannot hide a black frame.
   */
  renderProbe(size = 640): ProbeResult {
    const active = this.activeLayer();
    if (!active) return { error: 'no layer' };
    const w = size, h = Math.round(size * 0.62);
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
    const prevAspect = this.camera.aspect;
    const prevVis: [boolean, boolean] = [this.layer?.mesh.visible ?? false, this.layerAlt?.mesh.visible ?? false];
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.layer) this.layer.mesh.visible = this.layer === active;
    if (this.layerAlt) this.layerAlt.mesh.visible = this.layerAlt === active;
    // Split comparison has to be honoured offscreen too, otherwise a captured "split" frame is
    // really a single-packet frame and the compression slide would be illustrating nothing.
    const split = this.splitCompare && !!this.layer && !!this.layerAlt;
    const splitWidth = Math.floor(w * this.splitRatio);
    const vp = split ? new THREE.Vector2(splitWidth, h) : new THREE.Vector2(w, h);
    let sorted: boolean;
    if (split) {
      for (const l of [this.layer!, this.layerAlt!]) (l.u.uViewportPx.value as THREE.Vector2).set(splitWidth, h);
      this.layer!.update(this.camera.matrixWorldInverse, vp, true);
      this.layerAlt!.update(this.camera.matrixWorldInverse, vp, true);
      sorted = true;
    } else {
      (active.u.uViewportPx.value as THREE.Vector2).set(w, h);
      sorted = active.update(this.camera.matrixWorldInverse, vp, true);
    }
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x070b12, 1);
    if (split) {
      this.camera.aspect = splitWidth / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, splitWidth, h);
      this.renderer.setScissor(0, 0, splitWidth, h);
      this.renderOne(this.layer);
      this.renderer.setViewport(splitWidth, 0, w - splitWidth, h);
      this.renderer.setScissor(splitWidth, 0, w - splitWidth, h);
      this.renderOne(this.layerAlt);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, w, h);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    const info = { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles };
    const gl = this.renderer.getContext();
    this.renderer.setRenderTarget(null);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const glError = gl.getError();
    rt.dispose();
    this.renderer.setClearColor(prevClear, prevAlpha);
    if (this.layer) this.layer.mesh.visible = prevVis[0];
    if (this.layerAlt) this.layerAlt.mesh.visible = prevVis[1];
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.forceSort = true;

    let painted = 0, peak = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < w * h; i++) {
      const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
      const l = (r + g + b) / 3;
      sr += r; sg += g; sb += b;
      if (l > peak) peak = l;
      if (l > 34) painted++;
    }
    // GL origin is bottom-left, so sample the lower half too: a flipped-camera bug shows up as
    // content living in only one band.
    let lower = 0;
    for (let i = Math.floor(w * h / 2); i < w * h; i++) if ((buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3 > 34) lower++;

    return {
      w, h, sorted, drawn: { ...info }, glError,
      paintedFraction: +(painted / (w * h)).toFixed(4),
      paintedLowerHalf: lower,
      mean: [+(sr / (w * h)).toFixed(1), +(sg / (w * h)).toFixed(1), +(sb / (w * h)).toFixed(1)],
      peak: +peak.toFixed(1),
      buf,
    };
  }

  /**
   * GPU cost of the splat pass at a fixed resolution, measured offscreen. The headline (gpuMs /
   * netGpuMs) is a render serialised by a 1x1 readback with the readback's own latency subtracted,
   * because the cheap instrument lies here: a per-frame gl.finish() returned 0.0-0.1 ms for 88,918
   * splats at 1440p -- identical to the submit-only control -- so finish() reports when commands
   * were forwarded, not when the GPU finished. The hardware timer lives in perfTimerProbe(), which
   * must be async. syncConfirmed is false when the surviving figure is indistinguishable from
   * submission cost, in which case fpsAtThisSize stays null.
   *
   * Why this exists: on an automation window the canvas is 428x1, so the HUD's wall-clock frame
   * delta measures ~400 pixels of fill and says nothing about throughput. This measures the thing
   * the 60 FPS claim is actually about -- N splats rasterised into W x H, GPU-complete, per frame --
   * and reports the CPU sort separately, because those are two different deployment budgets.
   */
  perfProbe(w = 1280, h = 720, iters = 25) {
    const active = this.activeLayer();
    if (!active) return { error: 'no layer' };
    const gl = this.renderer.getContext();
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
    const prevAspect = this.camera.aspect;
    const prevVis: [boolean, boolean] = [this.layer?.mesh.visible ?? false, this.layerAlt?.mesh.visible ?? false];
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    const prevScissor = this.renderer.getScissorTest();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(false);
    if (this.layer) this.layer.mesh.visible = this.layer === active;
    if (this.layerAlt) this.layerAlt.mesh.visible = this.layerAlt === active;
    (active.u.uViewportPx.value as THREE.Vector2).set(w, h);
    const vp = new THREE.Vector2(w, h);
    const tSort = performance.now();
    active.update(this.camera.matrixWorldInverse, vp, true);
    const sortMs = +(performance.now() - tSort).toFixed(2);

    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x070b12, 1);
    const one = () => this.renderer.render(this.scene, this.camera);

    // Three independent instruments, because the cheap one lies. On Chromium/ANGLE a per-frame
    // gl.finish() came back in 0.0-0.1 ms for 88,918 splats at 1440p -- indistinguishable from the
    // submit-only control -- i.e. finish() returns once the commands are forwarded, not once the
    // GPU is done. So: (1) a real GL timer query where the browser exposes one, (2) a serialised
    // 1x1 readback, which cannot be answered before the pixel exists and yet costs nothing to
    // transfer, and (3) the finish() loop plus the submit/drain controls that expose (3) as bogus.
    // The hardware timer, when the browser has it, is read by perfTimerProbe() -- NOT here. An
    // earlier draft of this function polled QUERY_RESULT_AVAILABLE in a busy loop and burned 2 s
    // per call returning nothing: Chromium delivers the result on its own task queue, so a
    // synchronous spin on the main thread starves the very ack it is waiting for. The extension
    // being present is therefore not enough; the read has to be async.
    const timerSupported = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const tiny = new Uint8Array(4);
    const serial: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      one();
      this.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, tiny);
      serial.push(+(performance.now() - t0).toFixed(3));
    }
    // Control -- the same 1x1 readbacks with no render in front of them. A readback is only a
    // measurement instrument if its round-trip latency is known separately; on this driver the
    // floor of the serial loop is ~3 ms of IPC for a frame that costs a fraction of that, and
    // reporting the raw figure as "GPU time" would be 3x dishonest in the safe direction.
    const syncOnly: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      this.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, tiny);
      syncOnly.push(+(performance.now() - t0).toFixed(3));
    }
    const gpu: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      one();
      gl.finish();
      gpu.push(+(performance.now() - t0).toFixed(3));
    }
    // Control -- identical batch with no sync at all: pure CPU submission cost. If the finish() loop
    // matches it, that loop measured queueing rather than rasterisation, and the honest reading is
    // "GPU cost unmeasured", not "60 FPS with 10x headroom".
    const tSub = performance.now();
    for (let i = 0; i < iters; i++) one();
    const submitMs = +((performance.now() - tSub) / iters).toFixed(3);
    const tDrain = performance.now();
    gl.finish();
    const drainMs = +(performance.now() - tDrain).toFixed(3);
    const drawn = { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles };
    const glError = gl.getError();
    this.renderer.setRenderTarget(null);
    // One full readback of the SAME configuration that was timed, so paintedFraction cannot
    // describe a frame the timings did not measure. Timed separately: this transfer is huge.
    const tRb = performance.now();
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const readbackFullMs = +(performance.now() - tRb).toFixed(3);
    let painted = 0;
    for (let i = 0; i < w * h; i++) if ((buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3 > 34) painted++;

    const stat = (arr: number[]) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const g = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(3);
      return { n: s.length, min: g(0), p50: g(0.5), p95: g(0.95), max: g(1) };
    };
    const finishMs = stat(gpu);
    const serialMs = stat(serial);
    const syncOnlyMs = stat(syncOnly);
    // The headline is the serialised readback: it cannot be satisfied by a queue. Its own latency
    // floor is then removed, so the figure that reaches a brief is rasterisation, not IPC.
    const gpuMs = serialMs;
    const method = 'serialised 1x1 readback, sync latency subtracted';
    const netMs = gpuMs && syncOnlyMs ? +(Math.max(0, gpuMs.p50 - syncOnlyMs.p50)).toFixed(3) : null;
    const syncConfirmed = !!gpuMs && gpuMs.p50 > Math.max(0.2, submitMs * 2);
    // A net figure under 0.2 ms is inside the resolution of this method (and can mean the
    // no-render control skipped a sync the render case paid for). Refuse to turn that into an
    // FPS headline; hand the reader the instrument that can answer it instead.
    const publishable = syncConfirmed && netMs !== null && netMs >= 0.2;

    rt.dispose();
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setScissorTest(prevScissor);
    if (this.layer) this.layer.mesh.visible = prevVis[0];
    if (this.layerAlt) this.layerAlt.mesh.visible = prevVis[1];
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.forceSort = true;
    return {
      w, h, iters, splats: active.cloud.count, visible: active.visible,
      variant: this.variant, sortMs,
      gpuMs, method, timerSupported, serialMs, syncOnlyMs, finishMs,
      submitMs, drainMs, readbackFullMs, syncConfirmed, netGpuMs: netMs,
      fpsAtThisSize: publishable && netMs !== null ? +(1000 / netMs).toFixed(1) : null,
      fpsBasis: publishable ? 'netGpuMs = serialMs.p50 - syncOnlyMs.p50'
        : syncConfirmed ? 'below the readback floor -- use perfTimerProbe' : 'sync not confirmed',
      drawn, paintedFraction: +(painted / (w * h)).toFixed(4), glError,
      gpu: this.gpu,
    };
  }

  /**
   * Hardware timing of the same pass with EXT_disjoint_timer_query_webgl2, which is the only figure
   * here that is unambiguously time-spent-on-the-GPU (no submission, no IPC). It has to be async:
   * the result arrives on the browser's task queue, so the synchronous spin in the first draft
   * returned nothing after 2 s even with the extension present. Yields go through MessageChannel
   * rather than requestAnimationFrame because this window is hidden and rAF does not fire.
   */
  async perfTimerProbe(w = 1280, h = 720, iters = 20) {
    const active = this.activeLayer();
    if (!active) return { error: 'no layer' };
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };
    const gl2 = gl as WebGL2RenderingContext;
    const yieldTask = () => new Promise<void>((res) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => res();
      ch.port2.postMessage(0);
    });

    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
    const prevAspect = this.camera.aspect;
    const prevVis: [boolean, boolean] = [this.layer?.mesh.visible ?? false, this.layerAlt?.mesh.visible ?? false];
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    const prevScissor = this.renderer.getScissorTest();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setScissorTest(false);
    if (this.layer) this.layer.mesh.visible = this.layer === active;
    if (this.layerAlt) this.layerAlt.mesh.visible = this.layerAlt === active;
    (active.u.uViewportPx.value as THREE.Vector2).set(w, h);
    const vp = new THREE.Vector2(w, h);
    const tSort = performance.now();
    active.update(this.camera.matrixWorldInverse, vp, true);
    const sortMs = +(performance.now() - tSort).toFixed(2);

    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x070b12, 1);
    const qs: WebGLQuery[] = [];
    for (let i = 0; i < iters; i++) {
      const q = gl2.createQuery();
      if (!q) break;
      gl2.beginQuery(ext.TIME_ELAPSED_EXT, q);
      this.renderer.render(this.scene, this.camera);
      gl2.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
      await yieldTask();
    }
    const samples: number[] = [];
    let disjoint = 0, unavailable = 0;
    for (const q of qs) {
      let got = false;
      for (let spin = 0; spin < 60; spin++) {
        if (gl2.getQueryParameter(q, gl2.QUERY_RESULT_AVAILABLE)) { got = true; break; }
        await yieldTask();
      }
      if (!got) { unavailable++; gl2.deleteQuery(q); continue; }
      if (gl2.getQueryParameter(q, gl2.QUERY_RESULT) === null || gl.getParameter(ext.DISJOINT_EXT)) disjoint++;
      samples.push(+(Number(gl2.getQueryParameter(q, gl2.QUERY_RESULT)) / 1e6).toFixed(3));
      gl2.deleteQuery(q);
    }
    const drawn = { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles };
    const glError = gl.getError();
    this.renderer.setRenderTarget(null);
    rt.dispose();
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setScissorTest(prevScissor);
    if (this.layer) this.layer.mesh.visible = prevVis[0];
    if (this.layerAlt) this.layerAlt.mesh.visible = prevVis[1];
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.forceSort = true;

    const sorted = [...samples].sort((a, b) => a - b);
    const g = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))].toFixed(3);
    return {
      w, h, iters, asked: iters, got: samples.length, unavailable, disjoint,
      splats: active.cloud.count, visible: active.visible, variant: this.variant, sortMs,
      gpuMs: sorted.length ? { n: sorted.length, min: g(0), p50: g(0.5), p95: g(0.95), max: g(1) } : null,
      fpsAtThisSize: sorted.length ? +(1000 / Math.max(0.05, g(0.5))).toFixed(1) : null,
      method: 'EXT_disjoint_timer_query_webgl2', drawn, glError, gpu: this.gpu,
    };
  }

  /** Offscreen PNG of the current view. Works with a zero-size or hidden canvas, which is what
   *  makes automated visual verification (and the demo-video capture) possible at all. */
  renderToDataURL(size = 760): string | null {
    const probe = this.renderProbe(size);
    if (!probe.buf || !probe.w || !probe.h) return null;
    const { buf, w, h } = probe;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    // The render target holds LINEAR values; the on-screen pass does the sRGB encode in the
    // output pass, so a captured PNG has to do it too or every shot reads as near-black.
    const enc = (v: number) => {
      const x = v / 255;
      return Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
    };
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w * 4;   // GL origin is bottom-left
      for (let x = 0; x < w; x++) {
        const s = src + x * 4, t = dst + x * 4;
        img.data[t] = enc(buf[s]); img.data[t + 1] = enc(buf[s + 1]); img.data[t + 2] = enc(buf[s + 2]);
        img.data[t + 3] = buf[s + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    this.loadSeq++;
    this.loadAbort?.abort();
    this.loadAbort = null;
    cancelAnimationFrame(this.raf);
    this.disposeLayers();
    this.renderer.dispose();
  }
}
