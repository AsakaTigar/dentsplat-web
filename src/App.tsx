import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { DentSplatViewer } from './engine/Viewer.ts';
import type { BenchResult, ClearanceAudit, ClipAxis, CompressionBenchResult, LabInfo, LabMode, PickerHit, ProbeResult, Stats, ViewPreset } from './engine/Viewer.ts';
import type { GaussianInspect, Vec3 } from './engine/gaussian.ts';
import { parseGaussianPly } from './engine/ply.ts';
import { CASES, AUDIT_BASIS, LESION_LABEL } from './data/cases.ts';
import type { CaseSpec, CaseCohort, LayerSpec } from './data/cases.ts';
import { LAYER_RGB } from './engine/dspk.ts';
import Odontogram from './ui/Odontogram.tsx';
import MprQuadView from './ui/MprQuadView.tsx';
import GaussianPlot, { ProjectionPlot, ShAppearancePlot } from './ui/GaussianPlot.tsx';
import type { Mm3 } from './ui/MprQuadView.tsx';
import type { ToothMeta } from './ui/Odontogram.tsx';

type Report = {
  splats: number; bytes: number; mb: number; sh_degree: number; bytes_per_splat: number;
};
type SceneReport = {
  full: Report; pruned: Report; bytes_ratio: number;
  proxy: { bytes: number; kb: number; nodes: number; triangles: number };
  compression_fidelity_mm: Record<string, number | string>;
  metrics: Record<string, number | number[]>;
  training?: { tool?: string; steps?: number; views?: number; sh_degree?: number; labels?: string };
  source_note?: string;
};
type AblationPacket = Report & {
  file: string; sha256: string; method: string;
  layer_counts: Record<number, number>; layer_retention: Record<number, number>;
};
type CompressionAblation = {
  source_scene: string;
  base: { file: string; bytes: number; splats: number; sha256: string };
  uniform: AblationPacket;
  anatomy: AblationPacket;
};
type AuditClaim = {
  id: string;
  tooth: number;
  layer: number;
  title: string;
  claim: string;
  claimed: number;
  result?: ClearanceAudit | null;
  status?: 'pending' | 'verified' | 'hallucination';
};
type MetaFile = {
  unit: string; kind: string; bbox_min?: number[]; bbox_max?: number[];
  teeth: Record<string, ToothMeta>;
  metrics?: Record<string, number | number[]>;
};

type GeometryMethod = {
  file?: string;
  frame?: string;
  count: number;
  cloud_to_mesh: { mean_mm: number; p50_mm: number; p95_mm: number; max_mm: number };
  mesh_to_cloud: { mean_mm: number; p50_mm: number; p95_mm: number; max_mm: number };
  fscore: { threshold_mm: number; precision: number; recall: number };
  normal_abs_dot: { mean: number; p50: number; p10: number } | null;
  raw_ply?: GeometryMethod;
};
type GeometryAudit = {
  source_mesh: { triangles: number; vertices: number; sample_note: string };
  methods: { brush_3dgs: GeometryMethod; surface_sampling: GeometryMethod };
  timeline?: {
    step: number; count: number;
    cloud_to_mesh: { mean_mm: number; p95_mm: number };
    fscore: { precision: number; recall: number };
    normal_abs_dot: { mean: number } | null;
  }[];
  caveat: string;
};

type TimelineStep = {
  step: number; file: string; bytes: number; splats: number; sha256: string;
  source_ply: string; psnr_db: number | null; loss: number | null;
};
type TimelineManifest = {
  schema: string; case: string;
  training: { tool: string; views: number; steps: number; sh_degree: number; export_every: number; independent_rerun: boolean; note: string };
  metrics_note: string;
  steps: TimelineStep[];
};

type RailTab = 'findings' | 'lab' | 'methods' | 'recon' | 'layers' | 'slice' | 'audit' | 'source';

const LAB_MODES: { id: LabMode; label: string; note: string }[] = [
  { id: 'rgb', label: 'RGB', note: 'EWA 高斯光栅化最终图像' },
  { id: 'ellipsoid', label: 'Ellipsoids', note: '真实协方差 1σ 椭球表面' },
  { id: 'centers', label: 'Centers', note: '高斯中心点云' },
  { id: 'wire', label: 'Wireframe', note: '1σ 椭球线框' },
  { id: 'opacity', label: 'Opacity', note: '逐高斯不透明度图' },
  { id: 'scale', label: 'Scale', note: '逐高斯尺度图' },
  { id: 'normal', label: 'Normal', note: '椭球最小主轴近似法线' },
  { id: 'depth', label: 'Depth', note: '相机空间深度图' },
];

type EvidenceFinding = {
  id: string;
  fdi: number;
  title: string;
  subtitle: string;
  status: 'verified' | 'caution' | 'info';
  metric: string;
  evidence: string;
  action: () => void;
};

const fmtMB = (b: number) => (b / 1048576).toFixed(2);
const fmtInt = (n: number) => n.toLocaleString('en-US');
const hashCase = () => location.hash.replace(/^#/, '').split(/[,/]/)[0];

const COHORT_TABS: { id: 'all' | CaseCohort; label: string }[] = [
  { id: 'all', label: '全部 10 例' },
  { id: 'ios', label: 'IOS 3DGS' },
  { id: 'cbct', label: 'CBCT 贴面' },
];

const LOCAL_LAYER_NAMES: Record<number, string> = {
  0: '牙龈 / 背景', 1: '牙体 / 釉质', 2: '牙根 / 牙本质', 3: '牙槽骨',
  4: '下颌神经管', 5: '其他组织', 6: '牙髓', 7: '上颌窦', 8: '修复体',
};

// Deliberately simulated VLM prose. The numeric verdict is never read from this table: it is
// recomputed from the loaded 3DGS centres at click time.
const AUDIT_CLAIMS: AuditClaim[] = [
  {
    id: 'vlm-38', tooth: 38, layer: 4, title: '左下第三磨牙 / IAN',
    claim: 'VLM：#38 根尖至下牙槽神经管最小中心距约 0.06 mm。', claimed: 0.06,
  },
  {
    id: 'vlm-48-true', tooth: 48, layer: 4, title: '右下第三磨牙 / IAN',
    claim: 'VLM：#48 根尖至下牙槽神经管最小中心距约 0.18 mm。', claimed: 0.18,
  },
  {
    id: 'vlm-48-hallucination', tooth: 48, layer: 4, title: '右下第三磨牙 / 幻觉陷阱',
    claim: 'VLM：#48 根尖距神经管仅 1.10 mm，因此存在极高神经损伤风险。', claimed: 1.10,
  },
];

function parseFdiInfo(fdi: number, raw?: ToothMeta) {
  if (!fdi) return null;
  const q = Math.floor(fdi / 10);
  const pos = raw?.pos ?? (fdi % 10);
  const arch = raw?.arch === 'lower' ? 'Lower (下颌)' : raw?.arch === 'upper' ? 'Upper (上颌)' : raw?.arch ?? (q === 1 || q === 2 ? 'Upper (上颌)' : 'Lower (下颌)');
  const side = raw?.side ?? (q === 1 || q === 4 ? 'Right (右)' : 'Left (左)');
  const coords = raw?.centroid_mm ?? raw?.at;
  return { arch, side, pos, coords };
}

/** Minimal linear clinical icon set (no third-party icon dependency). */
function Icon({ name }: { name: string }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'pick': return <svg {...props}><path d="M4 4l7 16 2.5-6.5L20 11z" /></svg>;
    case 'measure': return <svg {...props}><path d="M3 17L17 3l4 4L7 21H3v-4z" /><path d="M12 8l2 2M9 11l2 2M15 5l2 2" /></svg>;
    case 'slice': return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="2" x2="12" y2="22" strokeDasharray="2.5 2.5" /></svg>;
    case 'cap': return <svg {...props}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5L12 12l8-4.5M12 12v9" /></svg>;
    case 'nerve': return <svg {...props}><path d="M4 17c4 0 5-4 8-5s5-1 8-6" /><circle cx="19" cy="6" r="2" /></svg>;
    case 'layers': return <svg {...props}><polygon points="12 3 21 8 12 13 3 8 12 3" /><polyline points="3 12.5 12 17.5 21 12.5" /><polyline points="3 16.5 12 21.5 21 16.5" /></svg>;
    case 'wire': return <svg {...props}><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><line x1="3" y1="12" x2="21" y2="12" /></svg>;
    case 'split': return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="4" x2="12" y2="20" /></svg>;
    case 'audit': return <svg {...props}><path d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'heat': return <svg {...props}><path d="M12 3v10M12 17v4M3 12h10M17 12h4" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'bench': return <svg {...props}><path d="M4 19h16M7 15v-4M12 15V7M17 15v-6" /></svg>;
    case 'gaussian': return <svg {...props}><ellipse cx="12" cy="12" rx="9" ry="5.2" transform="rotate(-28 12 12)" /><ellipse cx="12" cy="12" rx="4.8" ry="9" transform="rotate(-28 12 12)" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /></svg>;
    case 'camera': return <svg {...props}><path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13.5" r="3" /></svg>;
    case 'upload': return <svg {...props}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>;
    case 'reset': return <svg {...props}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><polyline points="3 3 3 8 8 8" /></svg>;
    case 'findings': return <svg {...props}><path d="M9 11l2 2 4-4" /><rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="17" x2="16" y2="17" /></svg>;
    case 'source': return <svg {...props}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>;
    default: return <svg {...props}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DentSplatViewer | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Deep links (#A2/#U/#B/#P) resolve before the first load; fall back to the trained lower jaw.
  const [caseId, setCaseId] = useState<string>(() => {
    const h = hashCase();
    return CASES.some((c) => c.id === h) ? h : (CASES.some((c) => c.id === 'A2') ? 'A2' : CASES[0].id);
  });
  const spec = useMemo(() => (CASES.find((c) => c.id === caseId) ?? CASES[0]) as CaseSpec, [caseId]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<SceneReport | null>(null);
  const [ablation, setAblation] = useState<CompressionAblation | null>(null);
  const [meta, setMeta] = useState<MetaFile | null>(null);
  const [stats, setStats] = useState<Stats>({ fps: 0, splats: 0, visible: 0, sortMs: 0, frameMs: 0, bytes: 0, gpu: '—' });

  const [selected, setSelected] = useState(0);
  const [probe, setProbe] = useState<{ mm: number[]; fdi: number } | null>(null);
  const [hidden, setHidden] = useState<number[]>([]);
  const [isolate, setIsolate] = useState(false);
  const [jaw, setJaw] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [showLesions, setShowLesions] = useState(true);
  const [clipAxis, setClipAxis] = useState<ClipAxis>(null);
  const [clipOffset, setClipOffset] = useState(0);
  const [clipBand, setClipBand] = useState(1.1);
  const [cap, setCap] = useState(true);
  const [flip, setFlip] = useState(false);
  const [alphas, setAlphas] = useState<Record<number, number>>({});
  const [variant, setVariant] = useState<'full' | 'pruned'>('full');
  const [split, setSplit] = useState(false);
  const [methodCompare, setMethodCompare] = useState(false);
  const [tenX, setTenX] = useState(false);
  const [heatmap, setHeatmap] = useState(false);
  const [mprOn, setMprOn] = useState(false);
  const [mprMask, setMprMask] = useState(true);
  const [cursorMm, setCursorMm] = useState<Mm3>([0, 0, 0]);
  const skipSelectedCursor = useRef(false);
  const [auditClaims, setAuditClaims] = useState<AuditClaim[]>(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
  const [auditing, setAuditing] = useState(false);
  const [wire, setWire] = useState(false);
  const [mode, setMode] = useState<'pick' | 'measure'>('pick');
  const [measures, setMeasures] = useState<number[]>([]);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [compressionBench, setCompressionBench] = useState<CompressionBenchResult | null>(null);
  const [benching, setBenching] = useState(false);
  const [activePreset, setActivePreset] = useState('frontal');
  const [spin, setSpin] = useState(false);

  // DTX workbench navigation state
  const [railTab, setRailTab] = useState<RailTab>('findings');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [findingFilter, setFindingFilter] = useState('');
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [customAssetName, setCustomAssetName] = useState<string | null>(null);
  const [localLayerIds, setLocalLayerIds] = useState<number[]>([]);
  const [localEpoch, setLocalEpoch] = useState(0);
  const isLocal = !!customAssetName;
  const isPlyLocal = !!customAssetName?.toLowerCase().endsWith('.ply');
  const isTimeline = !!customAssetName?.startsWith('timeline:');
  const gaussUnit = isPlyLocal ? 'PLY u' : 'mm';
  const [labMode, setLabMode] = useState<LabMode>('rgb');
  const [labSigma, setLabSigma] = useState<1 | 2 | 3>(1);
  const [labInfo, setLabInfo] = useState<LabInfo | null>(null);
  const [gaussian, setGaussian] = useState<GaussianInspect | null>(null);
  const [gaussOriginal, setGaussOriginal] = useState<GaussianInspect | null>(null);
  const [gaussIsolate, setGaussIsolate] = useState(false);
  const [plyNote, setPlyNote] = useState<string | null>(null);

  // 10-case cohort selector (right inspector)
  const [cohort, setCohort] = useState<'all' | CaseCohort>('all');
  const [pickerOpen, setPickerOpen] = useState(true);
  const [caseQuery, setCaseQuery] = useState('');
  const [allScenes, setAllScenes] = useState<Record<string, SceneReport>>({});
  const [geometryAudit, setGeometryAudit] = useState<GeometryAudit | null>(null);
  const [timeline, setTimeline] = useState<TimelineManifest | null>(null);
  const [timelineStep, setTimelineStep] = useState<number | null>(null);
  const [timelineCompare, setTimelineCompare] = useState(false);
  const [timelineBusy, setTimelineBusy] = useState(false);

  const switchCase = useCallback((id: string) => {
    setCaseId(id);
    setCustomAssetName(null);
    if (isLocal) setLocalEpoch((e) => e + 1);
    setTenX(false);
    setSplit(false);
    setMethodCompare(false);
    setMprOn(false);
    setGaussian(null);
    setGaussOriginal(null);
    setGaussIsolate(false);
    setPlyNote(null);
    setTimelineStep(null);
    setTimelineCompare(false);
    setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
    viewerRef.current?.clearAudit();
    viewerRef.current?.clearGaussianSelection();
    history.replaceState(null, '', `#${id}`);
  }, [isLocal]);

  // ---------------------------------------------------------------- viewer lifecycle

  useEffect(() => {
    if (!canvasRef.current) return;
    const v = new DentSplatViewer(canvasRef.current);
    v.autoRotate = false;
    v.onStats = setStats;
    v.onMeasure = (m) => { if (m) setMeasures((list) => [...list, +m.mm.toFixed(2)].slice(-8)); };
    v.onPick = (hit: PickerHit) => {
      if (!hit) { setProbe(null); return; }
      const mm: Mm3 = [hit.point.x, hit.point.y, hit.point.z];
      setProbe({ mm: mm.map((n) => +n.toFixed(1)), fdi: hit.fdi });
      skipSelectedCursor.current = true;
      setCursorMm(mm);
      if (hit.fdi) setSelected(hit.fdi);
    };
    v.onSplatPick = (index: number | null) => {
      if (index == null) {
        v.clearGaussianSelection();
        setGaussian(null);
        setGaussOriginal(null);
        return;
      }
      const info = v.selectGaussian(index);
      setGaussian(info);
      setGaussOriginal(info);
      setRailTab('lab');
      setInspectorOpen(true);
    };
    viewerRef.current = v;

    // Full probe surface kept intact for automated verification.
    (window as unknown as { DentSplat: unknown }).DentSplat = {
      viewer: v,
      png: (size?: number) => v.renderToDataURL(size ?? 760),
      stats: () => v.statsSnapshot(),
      pump: (n?: number) => v.pump(n ?? 60),
      selfTest: () => v.selfTest(),
      debugShot: (m: number, size = 480) => {
        v.setDebug(m);
        const p: ProbeResult = v.renderProbe(size);
        v.setDebug(0);
        const b = p.buf;
        if (!b || !p.w || !p.h) return { mode: m, error: 'no buffer' };
        let lit = 0, max = 0;
        for (let i = 0; i < p.w * p.h; i++) {
          const l = (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2]) / 3;
          if (l > 20) lit++;
          if (l > max) max = l;
        }
        return { mode: m, lit, frac: +(lit / (p.w * p.h)).toFixed(4), max, glError: p.glError, drawn: p.drawn };
      },
      probe: (size?: number) => {
        const p = v.renderProbe(size ?? 640);
        if (!p.buf) return p;
        const b = p.buf;
        let maxA = 0;
        for (let i = 3; i < b.length; i += 4) if (b[i] > maxA) maxA = b[i];
        const { buf, ...rest } = p;
        void buf;
        return { ...rest, maxAlpha: maxA, head: Array.from(b.subarray(0, 32)) };
      },
      caseId: () => v.caseId,
      perf: (w?: number, h?: number, iters?: number) => v.perfProbe(w ?? 1280, h ?? 720, iters ?? 25),
      perfTimer: (w?: number, h?: number, iters?: number) => v.perfTimerProbe(w ?? 1280, h ?? 720, iters ?? 20),
      bench: (size?: number) => v.bench(size ?? 384),
      gl: () => v.renderer.getContext(),
      layer: () => v.layer,
      uniforms: () => {
        const u = v.layer?.u ?? {};
        const flat: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(u)) flat[k] = (x as { value?: unknown })?.value;
        return flat;
      },
      truth: () => {
        const rows: { name: string; centre: number[]; distOrigin: number }[] = [];
        v.proxy?.updateMatrixWorld(true);
        v.proxy?.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!(m as unknown as { isMesh?: boolean }).isMesh || !/^FDI_\d+/.test(m.name)) return;
          m.geometry.computeBoundingBox();
          const bb = m.geometry.boundingBox!;
          const x = (bb.min.x + bb.max.x) / 2, y = (bb.min.y + bb.max.y) / 2, z = (bb.min.z + bb.max.z) / 2;
          const e = m.matrixWorld.elements;
          const c = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14]];
          rows.push({ name: m.name, centre: c.map((n) => +n.toFixed(2)), distOrigin: +Math.hypot(c[0], c[1], c[2]).toFixed(2) });
        });
        return rows;
      },
      measurePts: () => v.measurePts.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]),
      pickAt: (clientX: number, clientY: number) => v.pick(clientX, clientY),
      pickSplatAt: (clientX: number, clientY: number) => v.pickSplatIndex(clientX, clientY),
      lab: (mode: LabMode) => v.setLabMode(mode),
      labSigma: (n: 1 | 2 | 3) => v.setLabSigma(n),
      labInfo: () => v.labInfo,
      selectGaussian: (index: number, focus = false) => v.selectGaussian(index, { focus }),
      gaussian: () => (v.inspectedIndex >= 0 ? v.primaryLayer()?.inspect(v.inspectedIndex) ?? null : null),
      editGaussianPosition: (index: number, center: Vec3) => v.setGaussianPosition(index, center),
      editGaussianScale: (index: number, scales: Vec3) => v.setGaussianScale(index, scales),
      editGaussianOpacity: (index: number, alpha: number) => v.setGaussianOpacity(index, alpha),
      screen: () => {
        const r = v.canvasSize();
        return { w: r[0], h: r[1] };
      },
      project: (mm: number[]) => {
        const r = v.canvasSize();
        v.camera.updateMatrixWorld();
        const e = v.camera.matrixWorldInverse.elements, p = v.camera.projectionMatrix.elements;
        const [x, y, z] = mm;
        const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const vz = e[2] * x + e[6] * y + e[10] * z + e[14], vw = e[3] * x + e[7] * y + e[11] * z + e[15];
        const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
        const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
        const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw || 1;
        return [Math.round(((cx / cw + 1) / 2) * r[0]), Math.round(((1 - (cy / cw + 1) / 2)) * r[1])];
      },
      forceLayout: (w = 1280, h = 800) => {
        for (const sel of ['html', 'body', '#root', '.dtx-shell']) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) { el.style.width = `${w}px`; el.style.height = `${h}px`; }
        }
        v.resize();
        return [v.canvasSize()];
      },
    };

    const ro = new ResizeObserver(() => v.resize());
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener('resize', () => v.resize());
    return () => { ro.disconnect(); v.dispose(); viewerRef.current = null; };
  }, []);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    let dead = false;
    (async () => {
      try {
        setLoading(true); setErr(null); setBench(null); setCompressionBench(null); setCustomAssetName(null); setLocalLayerIds([]);
        const [rep, mf] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/report.json`).then((r) => r.json()),
          fetch(spec.metaUrl).then((r) => r.json()),
        ]);
        const useTenX = tenX && caseId === 'B';
        const useMethodCompare = methodCompare && caseId === 'A2';
        const ablation = rep.compression_ablation as CompressionAblation | undefined;
        let scene: SceneReport;
        let fullUrl = spec.fullUrl, prunedUrl = spec.prunedUrl;
        if (useMethodCompare) {
          const trained = rep.scenes?.sceneA_trained as SceneReport | undefined;
          const sampled = rep.scenes?.sceneA_ios as SceneReport | undefined;
          const sampleCase = CASES.find((c) => c.id === 'A');
          if (!trained || !sampled || !sampleCase) throw new Error('report.json lacks the same-source sampled baseline');
          scene = {
            ...trained, pruned: sampled.full,
            bytes_ratio: +(trained.full.bytes / Math.max(1, sampled.full.bytes)).toFixed(2),
          };
          fullUrl = spec.fullUrl;
          prunedUrl = sampleCase.fullUrl;
        } else if (useTenX) {
          if (!ablation?.uniform || !ablation?.anatomy) throw new Error('report.json has no 10x compression ablation');
          const source = rep.scenes?.sceneB_cbct as SceneReport | undefined;
          if (!source) throw new Error('report.json has no source scene "sceneB_cbct"');
          const abUrl = (file: string) => `${import.meta.env.BASE_URL}assets/${file.split('/').pop()}`;
          scene = {
            full: ablation.uniform, pruned: ablation.anatomy, bytes_ratio: 1,
            proxy: source.proxy, compression_fidelity_mm: {}, metrics: source.metrics ?? {},
          };
          fullUrl = abUrl(ablation.uniform.file);
          prunedUrl = abUrl(ablation.anatomy.file);
        } else {
          scene = rep.scenes?.[spec.sceneKey];
          if (!scene) throw new Error(`report.json has no scene "${spec.sceneKey}"`);
        }
        // A newer case may have been selected while these JSON fetches were in flight. Starting
        // loadCase now would increment the viewer's sequence and abort that newer request.
        if (dead) return;
        v.caseId = caseId;
        const defaults: Record<number, number> = {};
        for (const l of spec.layers) defaults[l.id] = l.alpha;
        await v.loadCase({
          fullUrl, prunedUrl, proxyUrl: spec.proxyUrl,
          fullBytes: scene.full.bytes, prunedBytes: scene.pruned.bytes, defaultLayerAlpha: defaults,
        });
        if (dead) return;
        setReport(scene);
        setAblation(ablation ?? null);
        setAllScenes((rep.scenes ?? {}) as Record<string, SceneReport>);
        setMeta(mf as MetaFile);
        setAlphas(defaults);
        setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
        if (useTenX || useMethodCompare) { setSplit(true); setVariant('full'); }
        if (useMethodCompare) setRailTab('methods');
        // Reset jaw / clipping on every switch: single-jaw scans have no hinge.
        setJaw(0); setClipAxis(null); setClipOffset(0);
        setSelected(0); setActiveFindingId(null); setProbe(null); setHidden([]); setIsolate(false); setMeasures([]);
        v.clearMeasure();

        const [hCase, hPreset] = location.hash.replace(/^#/, '').split(/[,/]/);
        if (CASES.some((c) => c.id === hCase) && hCase !== caseId) { setCaseId(hCase); return; }
        const want = spec.presets.find((p) => p.id === hPreset);
        setActivePreset(want ? want.id : spec.presets[0].id);
        v.flyTo(want ?? spec.presets[0]);
        setLoading(false);
      } catch (e) {
        // A newer case selection aborts the previous DSPK/proxy fetches; that is expected, not an
        // asset failure, so do not paint the red error overlay for it.
        if ((e as { name?: string })?.name === 'AbortError') return;
        if (!dead) { setErr(String(e instanceof Error ? e.message : e)); setLoading(false); }
      }
    })();
    return () => { dead = true; };
  }, [caseId, spec, tenX, methodCompare, localEpoch]);

  // Back/forward + manual hash edits switch cases without a reload.
  useEffect(() => {
    const onHash = () => {
      const h = hashCase();
      if (CASES.some((c) => c.id === h) && h !== caseId) {
        setCaseId(h); setCustomAssetName(null); if (isLocal) setLocalEpoch((e) => e + 1); setTenX(false); setSplit(false); setMprOn(false);
        setGaussian(null); setGaussOriginal(null); setGaussIsolate(false); setPlyNote(null); setTimelineStep(null); setTimelineCompare(false);
        setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
        viewerRef.current?.clearAudit();
        viewerRef.current?.clearGaussianSelection();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [caseId, isLocal]);

  // ---------------------------------------------------------------- state -> engine

  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !report) return;
    v.setLabSigma(labSigma);
    setLabInfo(v.setLabMode(labMode));
  }, [labMode, labSigma, report, tenX, localEpoch]);

  useEffect(() => {
    const v = viewerRef.current;
    if (v) v.pickGaussians = railTab === 'lab';
    if (railTab === 'lab') setPickerOpen(false);
    else setLabMode('rgb');
  }, [railTab, labMode]);

  useEffect(() => {
    viewerRef.current?.setGaussianIsolate(gaussIsolate);
  }, [gaussIsolate]);

  useEffect(() => {
    let dead = false;
    fetch(`${import.meta.env.BASE_URL}assets/geometry_metrics.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (!dead && x?.schema === 'dentsplat-geometry-audit-v1') setGeometryAudit(x as GeometryAudit); })
      .catch(() => {});
    fetch(`${import.meta.env.BASE_URL}assets/timeline/timeline.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (!dead && x?.schema === 'dentsplat-timeline-v1') setTimeline(x as TimelineManifest); })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => { viewerRef.current?.setLayerAlphaMap(alphas); }, [alphas, caseId]);
  useEffect(() => {
    viewerRef.current?.set({
      // Only a two-jaw volume gets a hinge; single-jaw scans keep jawGap at 0.
      jawGap: !isLocal && spec.hasJaw ? jaw : 0,
      opacity, showLesions, hiddenTeeth: hidden, isolateTooth: isolate,
      clip: { axis: clipAxis, offset: flip ? -clipOffset : clipOffset, band: clipBand, cap },
    });
  }, [!isLocal, spec.hasJaw, jaw, opacity, showLesions, hidden, isolate, clipAxis, clipOffset, clipBand, cap, flip]);
  useEffect(() => { viewerRef.current?.setVariant(variant, split); }, [variant, split]);
  useEffect(() => { if (methodCompare && !split) setSplit(true); }, [methodCompare, split]);
  useEffect(() => { if (methodCompare && railTab !== 'methods') setMethodCompare(false); }, [methodCompare, railTab]);
  useEffect(() => { viewerRef.current?.setVisMode(heatmap ? 1 : 0); }, [heatmap, caseId, tenX]);
  useEffect(() => { viewerRef.current?.setWireframe(wire); }, [wire]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.measureMode = mode; }, [mode]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.autoRotate = spin; }, [spin]);
  useEffect(() => { viewerRef.current?.select(selected, { pulse: selected > 0 }); }, [selected]);
  useEffect(() => {
    if (!mprOn) return;
    const raf = requestAnimationFrame(() => viewerRef.current?.resize());
    return () => cancelAnimationFrame(raf);
  }, [mprOn]);
  useEffect(() => {
    if (!mprOn || selected <= 0) return;
    if (skipSelectedCursor.current) { skipSelectedCursor.current = false; return; }
    const t = meta?.teeth?.[`FDI_${selected}`];
    const c = t?.centroid_mm ?? t?.at;
    if (c && c.length === 3) setCursorMm([c[0], c[1], c[2]]);
  }, [selected, mprOn, meta]);

  // ---------------------------------------------------------------- derived & actions

  const clipRange = useMemo(() => {
    const b = meta?.bbox_min, t = meta?.bbox_max;
    if (!b || !t) return [-48, 48] as [number, number];
    const i = clipAxis === 'x' ? 0 : clipAxis === 'y' ? 1 : 2;
    return [Math.floor(b[i]) - 2, Math.ceil(t[i]) + 2] as [number, number];
  }, [meta, clipAxis]);

  const rawTooth = selected ? meta?.teeth?.[`FDI_${selected}`] : undefined;
  const fdiInfo = useMemo(() => parseFdiInfo(selected, rawTooth), [selected, rawTooth]);
  const ratio = report ? (report.full.bytes / Math.max(1, report.pruned.bytes)) : 0;
  const mbText = report ? `${fmtMB(report.full.bytes)} MB` : '—';
  const displayLayers: LayerSpec[] = isLocal
    ? localLayerIds.map((id) => ({
      id, key: `local-${id}`, cn: LOCAL_LAYER_NAMES[id] ?? `Layer ${id}`, en: `Layer ${id}`,
      color: `rgb(${(LAYER_RGB[id] ?? [160, 160, 160]).join(',')})`, alpha: 1,
    }))
    : spec.layers;

  const goPreset = useCallback((p: ViewPreset) => {
    setActivePreset(p.id);
    viewerRef.current?.flyTo(p);
    history.replaceState(null, '', `#${caseId},${p.id}`);
  }, [caseId]);

  const resetView = useCallback(() => {
    setClipAxis(null); setClipOffset(0); setJaw(0); setIsolate(false); setHidden([]); setSelected(0); setActiveFindingId(null);
    const defaults: Record<number, number> = {};
    for (const l of displayLayers) defaults[l.id] = l.alpha;
    setAlphas(defaults);
    viewerRef.current?.clearAudit();
    goPreset(spec.presets[0]);
  }, [displayLayers, goPreset, spec.presets]);

  const focusCanal = useCallback(() => {
    if (spec.cohort !== 'cbct') {
      const first = CASES.find((c) => c.cohort === 'cbct');
      if (first) switchCase(first.id);
      return;
    }
    const canalTooth = [38, 48, 37, 47, 36, 46, 35, 45, 34, 44].find((f) => meta?.teeth?.[`FDI_${f}`]) ?? 0;
    setSelected(canalTooth);
    setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.9, 4: 1.0, 7: 0.12 }));
    setClipAxis('x'); setFlip(false); setClipOffset(18); setClipBand(1.2); setCap(true);
    const p = spec.presets.find((x) => x.id === 'ian') ?? spec.presets[0];
    goPreset(p);
  }, [goPreset, meta, spec, switchCase]);

  const runBench = useCallback(async () => {
    const v = viewerRef.current;
    if (!v) return;
    setBenching(true);
    setRailTab('audit');
    try {
      if (document.visibilityState === 'visible') {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      } else {
        v.pump(2);
        await Promise.resolve();
      }
      if (tenX && ablation && v.layer && v.layerAlt) {
        setBench(null);
        const views = spec.presets.filter((p) => ['frontal', 'left', 'right', 'ian'].includes(p.id));
        setCompressionBench(await v.benchCompression(
          spec.fullUrl,
          [{ name: 'Uniform 10×', cloud: v.layer.cloud }, { name: 'Anatomy-Aware 10×', cloud: v.layerAlt.cloud }],
          views.length ? views : spec.presets.slice(0, 4), 48, 4, 256,
        ));
      } else {
        setCompressionBench(null);
        setBench(await v.bench(384));
      }
    } finally {
      setBenching(false);
    }
  }, [ablation, spec, tenX]);

  const toggleTenX = useCallback(() => {
    if (isLocal) return;
    setLabMode('rgb'); setMethodCompare(false); setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
    viewerRef.current?.clearGaussianSelection();
    if (caseId !== 'B') {
      switchCase('B');
      setTenX(true); setSplit(true); setVariant('full'); setBench(null); setCompressionBench(null);
      return;
    }
    const next = !tenX;
    if (next) setMprOn(false);
    setTenX(next); setSplit(next); setVariant('full'); setBench(null); setCompressionBench(null);
    setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
    viewerRef.current?.clearAudit();
  }, [caseId, isLocal, switchCase, tenX]);

  const toggleMpr = useCallback(() => {
    if (isLocal) return;
    const next = !mprOn;
    if (next) {
      if (caseId !== 'B') switchCase('B');
      setLabMode('rgb'); setMethodCompare(false); setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
      viewerRef.current?.clearGaussianSelection();
      setTenX(false); setSplit(false); setVariant('full'); setBench(null); setCompressionBench(null);
      setCursorMm([0, 0, 0]);
    }
    setMprOn(next);
    requestAnimationFrame(() => viewerRef.current?.resize());
  }, [caseId, isLocal, mprOn, switchCase]);

  const handleMprCursor = useCallback((mm: Mm3) => {
    setCursorMm(mm);
    if (clipAxis) {
      setFlip(false);
      setClipOffset(mm[clipAxis === 'x' ? 0 : clipAxis === 'y' ? 1 : 2]);
    }
  }, [clipAxis]);

  const runGeometricAudit = useCallback(async () => {
    const v = viewerRef.current;
    if (!v || caseId !== 'B' || tenX) return;
    setAuditing(true); setRailTab('findings'); setHeatmap(false); setIsolate(false); setHidden([]); setSpin(false);
    setClipAxis(null); setJaw(0);
    setAlphas((a) => ({ ...a, 3: 0.12, 1: 0.95, 4: 1.0, 7: 0.08 }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const next = AUDIT_CLAIMS.map((c) => {
      const result = v.auditClearance(c.tooth, c.layer);
      const error = result ? Math.abs(c.claimed - result.distance) : Infinity;
      return { ...c, result, status: result && error < 0.3 ? 'verified' as const : 'hallucination' as const };
    });
    setAuditClaims(next);
    const focus = next.find((c) => c.status === 'hallucination') ?? next[0];
    if (focus?.result) {
      skipSelectedCursor.current = true;
      setCursorMm([(focus.result.a[0] + focus.result.b[0]) / 2, (focus.result.a[1] + focus.result.b[1]) / 2, (focus.result.a[2] + focus.result.b[2]) / 2]);
      setSelected(focus.tooth);
      v.select(focus.tooth);
      v.showClearanceAudit(focus.result);
    }
    setAuditing(false);
  }, [caseId, tenX]);

  const focusAuditClaim = useCallback((claim: AuditClaim) => {
    const v = viewerRef.current;
    if (!v || !claim.result) return;
    skipSelectedCursor.current = true;
    setCursorMm([(claim.result.a[0] + claim.result.b[0]) / 2, (claim.result.a[1] + claim.result.b[1]) / 2, (claim.result.a[2] + claim.result.b[2]) / 2]);
    setSelected(claim.tooth);
    setAlphas((a) => ({ ...a, 3: 0.12, 1: 0.95, 4: 1.0, 7: 0.08 }));
    v.select(claim.tooth);
    v.showClearanceAudit(claim.result);
  }, []);

  const loadLocalDspk = useCallback(async (file: File) => {
    const v = viewerRef.current;
    if (!v || !file.name.toLowerCase().endsWith('.dspk')) return;
    const blobUrl = URL.createObjectURL(file);
    try {
      setLoading(true); setErr(null);
      setTenX(false); setSplit(false); setMprOn(false); setVariant('full'); setBench(null); setCompressionBench(null);
      setGaussian(null); setGaussOriginal(null); setGaussIsolate(false); setPlyNote(null); setTimelineStep(null); setTimelineCompare(false);
      setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      const head = new DataView(await file.arrayBuffer());
      if (head.getUint32(0, true) !== 0x4b505344) throw new Error('不是有效的 DSPK 文件');
      const count = head.getUint32(8, true), shDegree = (head.getUint8(5) & 1) ? 1 : 0;
      v.caseId = 'LOCAL';
      await v.loadCase({
        fullUrl: blobUrl, prunedUrl: blobUrl, proxyUrl: null,
        fullBytes: file.size, prunedBytes: file.size,
      });
      const cloud = v.layer?.cloud;
      const localMeta = (cloud?.meta ?? {}) as unknown as MetaFile;
      const layers: Record<number, number> = {};
      for (let i = 0; i < (cloud?.count ?? 0); i++) layers[cloud!.misc[i * 4 + 2]] = 1;
      setAlphas(layers);
      setLocalLayerIds(Object.keys(layers).map(Number).sort((a, b) => a - b));
      setReport({
        full: { splats: count, bytes: file.size, mb: +(file.size / 1048576).toFixed(2), sh_degree: shDegree, bytes_per_splat: head.getUint8(7) },
        pruned: { splats: count, bytes: file.size, mb: +(file.size / 1048576).toFixed(2), sh_degree: shDegree, bytes_per_splat: head.getUint8(7) },
        bytes_ratio: 1, proxy: { bytes: 0, kb: 0, nodes: 0, triangles: 0 }, compression_fidelity_mm: {}, metrics: {},
      });
      setMeta({
        unit: localMeta.unit ?? 'mm', kind: localMeta.kind ?? 'local', teeth: localMeta.teeth ?? {}, metrics: localMeta.metrics ?? {},
        bbox_min: cloud ? [...cloud.bboxMin] : undefined, bbox_max: cloud ? [...cloud.bboxMax] : undefined,
      });
      setCustomAssetName(file.name);
      history.replaceState(null, '', '#LOCAL');
      setLoading(false);
    } catch (e) {
      setErr(`本地 DSPK 加载失败: ${String(e)}`);
      setLoading(false);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, []);

  const loadLocalPly = useCallback(async (file: File) => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      setLoading(true); setErr(null);
      setTenX(false); setSplit(false); setMprOn(false); setVariant('full'); setBench(null); setCompressionBench(null);
      setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
      setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      const buf = await file.arrayBuffer();
      const { cloud, info } = parseGaussianPly(buf, file.name);
      v.caseId = 'LOCAL';
      v.loadCloud(cloud, file.size);
      const perSplat = +(file.size / Math.max(1, cloud.count)).toFixed(2);
      setReport({
        full: { splats: cloud.count, bytes: file.size, mb: +(file.size / 1048576).toFixed(2), sh_degree: info.shDegree, bytes_per_splat: perSplat },
        pruned: { splats: cloud.count, bytes: file.size, mb: +(file.size / 1048576).toFixed(2), sh_degree: info.shDegree, bytes_per_splat: perSplat },
        bytes_ratio: 1, proxy: { bytes: 0, kb: 0, nodes: 0, triangles: 0 }, compression_fidelity_mm: {}, metrics: {},
      });
      setMeta({
        unit: String(cloud.meta.unit ?? 'unknown'), kind: 'local-ply', teeth: {}, metrics: {},
        bbox_min: [...cloud.bboxMin], bbox_max: [...cloud.bboxMax],
      });
      setAlphas({ 5: 1 });
      setLocalLayerIds([5]);
      setPlyNote(`${info.gaussianFields ? 'FP32 3DGS PLY' : 'Point PLY'} · ${info.format} · SH${info.shDegree} · ${info.fields.length} 字段 · 无 FDI/解剖语义`);
      setCustomAssetName(file.name);
      setLabMode('centers');
      setRailTab('lab');
      setInspectorOpen(true);
      history.replaceState(null, '', '#LOCAL');
      setLoading(false);
    } catch (e) {
      setErr(`本地 PLY 加载失败: ${String(e)}`);
      setLoading(false);
    }
  }, []);

  const loadLocalFile = useCallback(async (file: File) => {
    const n = file.name.toLowerCase();
    if (n.endsWith('.ply')) return loadLocalPly(file);
    return loadLocalDspk(file);
  }, [loadLocalPly, loadLocalDspk]);

  const loadSamplePly = useCallback(async () => {
    try {
      setLoading(true);
      const buf = await fetch(`${import.meta.env.BASE_URL}assets/sample_case05_fp32.ply`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      await loadLocalPly(new File([buf], 'sample_case05_fp32.ply'));
    } catch (e) {
      setErr(`示例 PLY 加载失败: ${String(e)}`);
      setLoading(false);
    }
  }, [loadLocalPly]);

  const loadTimelineStep = useCallback(async (step: TimelineStep, compareFinal = timelineCompare) => {
    const v = viewerRef.current;
    if (!v || timelineBusy) return;
    setTimelineBusy(true); setLoading(true); setErr(null);
    setTenX(false); setMprOn(false); setVariant('full'); setBench(null); setCompressionBench(null);
    setMethodCompare(false); setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
    v.clearGaussianSelection();
    try {
      const url = `${import.meta.env.BASE_URL}assets/${step.file}`;
      const final = allScenes.sceneA_trained?.full;
      const finalSplats = final?.splats ?? 28691;
      const finalBytes = final?.bytes ?? 832835;
      const finalUrl = `${import.meta.env.BASE_URL}assets/sceneA_trained_full.dspk`;
      const base = {
        mb: +(step.bytes / 1048576).toFixed(2), sh_degree: 1,
        bytes_per_splat: +(step.bytes / step.splats).toFixed(2),
      };
      v.caseId = 'TIMELINE';
      await v.loadCase({
        fullUrl: url, prunedUrl: compareFinal ? finalUrl : url, proxyUrl: null,
        fullBytes: step.bytes, prunedBytes: compareFinal ? finalBytes : step.bytes,
      });
      setReport({
        full: { splats: step.splats, bytes: step.bytes, ...base },
        pruned: compareFinal
          ? { splats: finalSplats, bytes: finalBytes, mb: +(finalBytes / 1048576).toFixed(2), sh_degree: 1, bytes_per_splat: 29 }
          : { splats: step.splats, bytes: step.bytes, ...base },
        bytes_ratio: compareFinal ? +(step.bytes / finalBytes).toFixed(2) : 1,
        proxy: { bytes: 0, kb: 0, nodes: 0, triangles: 0 }, compression_fidelity_mm: {}, metrics: {},
      });
      setSplit(compareFinal);
      setTimelineCompare(compareFinal);
      setMeta({ unit: 'mm', kind: 'timeline', teeth: {}, metrics: {} });
      setAlphas({ 0: 1 });
      setLocalLayerIds([0]);
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      setCustomAssetName(`timeline:${step.step}${compareFinal ? ':vs-final' : ''}`);
      setTimelineStep(step.step);
      setRailTab('recon'); setInspectorOpen(true); setPickerOpen(false);
      setLabMode('rgb');
      history.replaceState(null, '', '#TIMELINE');
      setLoading(false);
    } catch (e) {
      setErr(`时间轴 checkpoint 加载失败: ${String(e)}`);
      setLoading(false);
    } finally {
      setTimelineBusy(false);
    }
  }, [allScenes, timelineBusy, timelineCompare]);

  const changeLabMode = useCallback((mode: LabMode) => {
    setLabMode(mode);
    if (mode !== 'rgb') {
      setMethodCompare(false);
      setRailTab('lab');
      setInspectorOpen(true);
    }
  }, []);

  const changeLabSigma = useCallback((sigma: 1 | 2 | 3) => {
    setLabSigma(sigma);
    const info = viewerRef.current?.setLabSigma(sigma);
    if (info) setLabInfo(info);
  }, []);

  const startMethodCompare = useCallback(() => {
    const v = viewerRef.current;
    v?.clearGaussianSelection();
    setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
    setLabMode('rgb');
    if (caseId !== 'A2') switchCase('A2');
    setMethodCompare(true);
    setSplit(true);
    setRailTab('methods');
    setInspectorOpen(true);
    setPickerOpen(false);
  }, [caseId, switchCase]);

  const editGaussScale = useCallback((axis: 0 | 1 | 2, value: number) => {
    const v = viewerRef.current;
    if (!v || !gaussian) return;
    const next = [...gaussian.scales] as Vec3;
    next[axis] = value;
    const info = v.setGaussianScale(gaussian.index, next);
    if (info) setGaussian(info);
  }, [gaussian]);

  const editGaussOpacity = useCallback((value: number) => {
    const v = viewerRef.current;
    if (!v || !gaussian) return;
    const info = v.setGaussianOpacity(gaussian.index, value);
    if (info) setGaussian(info);
  }, [gaussian]);

  const editGaussPosition = useCallback((axis: 0 | 1 | 2, value: number) => {
    const v = viewerRef.current;
    if (!v || !gaussian) return;
    const next = [...gaussian.center] as Vec3;
    next[axis] = value;
    const info = v.setGaussianPosition(gaussian.index, next);
    if (info) setGaussian(info);
  }, [gaussian]);

  const resetGaussian = useCallback(() => {
    const v = viewerRef.current;
    if (!v || !gaussian || !gaussOriginal) return;
    v.setGaussianPosition(gaussian.index, gaussOriginal.center);
    v.setGaussianScale(gaussian.index, gaussOriginal.scales);
    const info = v.setGaussianOpacity(gaussian.index, gaussOriginal.alpha);
    if (info) setGaussian(info);
  }, [gaussian, gaussOriginal]);

  const shoot = useCallback(() => {
    const data = viewerRef.current?.snapshot();
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = `dentsplat_${caseId}_${Date.now()}.png`;
    a.click();
  }, [caseId]);

  const exportPly = useCallback(() => {
    const x = viewerRef.current?.exportPly();
    if (!x) return;
    const blob = new Blob([x.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = x.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const saveReview = useCallback(() => {
    const v = viewerRef.current;
    const record = {
      schema: 'dentsplat-review-v1',
      saved_at: new Date().toISOString(),
      case: isLocal
        ? { mode: isPlyLocal ? 'local-ply' : 'local-dspk', file: customAssetName, proxy: null, ply_note: plyNote }
        : { mode: 'library', id: caseId, code: spec.code, title: spec.title, dataset: spec.dataset, license: spec.license },
      selected_fdi: selected,
      cursor_mm: cursorMm,
      view: { variant, split, ten_x: tenX, heatmap, jaw_mm: jaw, clip: { axis: clipAxis, offset: clipOffset, band: clipBand, cap, flip } },
      lab: {
        mode: labMode,
        render_info: labInfo,
        ply_note: plyNote,
        gaussian: gaussian ? {
          index: gaussian.index, precision: gaussian.precision, fdi: gaussian.fdi, layer: gaussian.layer,
          center_mm: gaussian.center, scales_mm: gaussian.scales, quaternion_xyzw: gaussian.quat,
          opacity: gaussian.alpha, sh_degree: gaussian.shDegree, covariance_mm2: gaussian.covariance,
          principal_sigmas_mm: gaussian.axes.sigmas, principal_directions: gaussian.axes.directions,
        } : null,
      },
      mpr: { enabled: mprOn, mask_visible: mprMask, note: mprOn ? 'Case 0095 lightweight 8-bit preview; not diagnostic-resolution' : null },
      measurements_mm: measures,
      measurement_points_mm: v?.measurePts.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]) ?? [],
      audit: {
        simulated_vlm: true,
        basis: 'nearest splat-centre distance; source voxel about 0.3 mm; not a root-apex surface distance or clinical diagnosis',
        claims: auditClaims.map((c) => ({ id: c.id, tooth: c.tooth, layer: c.layer, claimed_mm: c.claimed, status: c.status,
          measured_mm: c.result?.distance ?? null, point_a_mm: c.result?.a ?? null, point_b_mm: c.result?.b ?? null })),
      },
      compression: { ablation, full_reference_bench: compressionBench },
      geometry_audit: geometryAudit,
      stats: v?.statsSnapshot() ?? null,
    };
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `dentsplat_review_${isLocal ? 'LOCAL' : caseId}_FDI${selected || 'all'}_${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [ablation, auditClaims, cap, caseId, clipAxis, clipBand, clipOffset, compressionBench, cursorMm, customAssetName, flip, gaussOriginal, gaussian, geometryAudit, heatmap, isLocal, jaw, labInfo, labMode, measures, mprMask, mprOn, plyNote, selected, spec, split, tenX, variant]);

  const toggleHide = useCallback((fdi: number) => {
    setHidden((h) => (h.includes(fdi) ? h.filter((x) => x !== fdi) : [...h, fdi]));
  }, []);

  const alphaOf = (id: number) => alphas[id] ?? 1;

  const pickerCases = useMemo(() => {
    const base = cohort === 'all' ? CASES : CASES.filter((c) => c.cohort === cohort);
    const q = caseQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) =>
      [c.code, c.shortTitle, c.modality, c.tag, c.dataset].join(' ').toLowerCase().includes(q),
    );
  }, [cohort, caseQuery]);

  const cohortCounts = useMemo(() => ({
    all: CASES.length,
    ios: CASES.filter((c) => c.cohort === 'ios').length,
    cbct: CASES.filter((c) => c.cohort === 'cbct').length,
  }), []);

  // Evidence-linked findings. Numbers shown here all come from report.json / meta.json of the
  // current case; anything not measured is labelled TBD rather than filled with a placeholder.
  const findings = useMemo<EvidenceFinding[]>(() => {
    const list: EvidenceFinding[] = [];
    if (isLocal) {
      return [{
        id: 'local-preview', fdi: 0, title: 'Local DSPK Preview', subtitle: '独立预览 · 无旧病例代理与元数据',
        status: 'info', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
        evidence: '当前只加载文件本身的高斯与内嵌语义；旧病例 proxy、牙位元数据、MPR、发现列表和测量已清空。逐牙拾取仅在文件包含 FDI 且可见时可用。',
        action: () => setRailTab('source'),
      }];
    }
    if (caseId === 'B') {
      const ian = typeof report?.metrics?.ian_48_min_mm === 'number' ? report.metrics.ian_48_min_mm : null;
      list.push(
        {
          id: 'ian-38', fdi: 38, title: 'Mandibular Canal Proximity', subtitle: '38/48 智齿与下牙槽神经管空间关系',
          status: 'caution', metric: ian != null ? `IAN ${ian.toFixed(2)} mm` : 'IAN TBD',
          evidence: '由 DentVoxel v4 case 0095 的 0.3 mm 体素分割直接量测（非诊断结论）；点击切入神经管透视与冠状剖切。',
          action: () => focusCanal(),
        },
        {
          id: 'surfel-budget', fdi: 46, title: 'Anatomy-Aware Surfel Budget', subtitle: '牙槽骨 / 牙体牙根 / 神经管 / 上颌窦四层独立编码',
          status: 'verified', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
          evidence: '四层等值面各自生成法线对齐贴面高斯，层代码写入 DSPK 的 misc 字节；层透明度由 uLayerAlpha 实时控制。',
          action: () => { setSelected(46); viewerRef.current?.focusTooth(46); },
        },
        {
          id: 'sinus-floor', fdi: 16, title: 'Maxillary Sinus Floor Context', subtitle: '上颌后牙根尖与上颌窦底毗邻',
          status: 'info', metric: 'Layer L7',
          evidence: '上颌窦（L7）与牙槽骨（L3）独立编码，可实时调低骨透明度检查上颌磨牙根尖穿窦风险。',
          action: () => { setSelected(16); setAlphas((a) => ({ ...a, 3: 0.18, 7: 0.55 })); viewerRef.current?.focusTooth(16); },
        },
        {
          id: 'cbct-clip', fdi: 36, title: 'GLSL Section Cap Cross-Section', subtitle: '三维高斯实体断面封顶剖切',
          status: 'verified', metric: 'GLSL Cap',
          evidence: '在 Vertex Shader 将剖切面窄带内高斯吸附压平并按组织层重着色，避免网格剖切的空壳失真。',
          action: () => { setClipAxis('y'); setClipOffset(-2); setCap(true); setRailTab('slice'); },
        },
      );
    } else if (spec.cohort === 'cbct') {
      const firstTooth = Object.values(meta?.teeth ?? {}).map((t) => t.fdi).find((f) => f > 0) ?? 0;
      const sinusTooth = [16, 26, 17, 27, 15, 25].find((f) => meta?.teeth?.[`FDI_${f}`]) ?? firstTooth;
      const canalTooth = [38, 48, 37, 47, 36, 46, 35, 45].find((f) => meta?.teeth?.[`FDI_${f}`]) ?? 0;
      const ian = typeof report?.metrics?.ian_48_min_mm === 'number' ? report.metrics.ian_48_min_mm : null;
      list.push(
        {
          id: 'ian-layer', fdi: canalTooth, title: 'IAN Canal Layer', subtitle: '下牙槽神经管与后牙根尖的空间关系',
          status: ian != null ? 'caution' : 'info',
          metric: ian != null ? `IAN ${ian.toFixed(2)} mm` : 'Layer L4',
          evidence: ian != null
            ? `${spec.dataset} 的 0.3 mm 标注体素重建；该读数是贴面高斯中心之间的最近距离，不是根尖-神经管表面距离。源体素约 0.3 mm，分割与采样不确定性未计入；两位小数不代表 0.01 mm 准确度，也不构成诊断。`
            : `${spec.dataset} 的 0.3 mm 标注体素重建；神经管与牙体分层独立编码，可在 Layers 面板调低骨透明度后直视。`,
          action: () => focusCanal(),
        },
        {
          id: 'sinus-layer', fdi: sinusTooth, title: 'Maxillary Sinus Context', subtitle: '上颌窦底与后牙根尖毗邻区',
          status: 'info', metric: 'Layer L7',
          evidence: '上颌窦（L7）与牙槽骨（L3）分层编码；调节透明度可检查后牙根尖与窦底关系，页面不预写任何未量测的距离。',
          action: () => { setSelected(sinusTooth); setAlphas((a) => ({ ...a, 3: 0.18, 7: 0.55 })); if (sinusTooth) viewerRef.current?.focusTooth(sinusTooth); },
        },
        {
          id: 'cbct-labels', fdi: 0, title: 'Voxel-Read FDI Binding', subtitle: '逐高斯牙位直接回读自 0.3 mm 标注',
          status: 'verified', metric: meta ? `${Object.keys(meta.teeth ?? {}).length} FDI` : '—',
          evidence: 'FDI 不是按位置猜的：每个贴面高斯在表面内侧回读 DentVoxel 分割标签，旁挂文件经行数与 sha 校验后才写入 DSPK。',
          action: () => setRailTab('source'),
        },
      );
    } else if (caseId === 'C05' || caseId === 'C06' || caseId === 'C07') {
      const firstTooth = Object.values(meta?.teeth ?? {}).map((t) => t.fdi).find((f) => f > 0) ?? 0;
      list.push(
        {
          id: 'independent-scan', fdi: firstTooth, title: 'Independent Patient Scan', subtitle: '独立真实个体 · 120 视角 / Brush 15,000 步',
          status: 'verified', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
          evidence: `${spec.dataset}；与 Case 01/02 不共享任何几何。高光与牙龈细节来自真实口扫网格的 Blender 渲染，不是生成式补全。`,
          action: () => { if (firstTooth) { setSelected(firstTooth); viewerRef.current?.focusTooth(firstTooth); } },
        },
        {
          id: 'transferred-labels', fdi: 0, title: 'Cross-Packet FDI Transfer', subtitle: '同源 0.35 mm 采样包 → 训练高斯的最近邻迁移',
          status: 'info', metric: meta ? `${Object.keys(meta.teeth ?? {}).length} FDI` : '—',
          evidence: '迁移半径 1.0 mm；超过半径的高斯保留 0 而不被强行指派牙位。迁移件写明参考包与逐行 sha，可复核。',
          action: () => setRailTab('source'),
        },
      );
      if (caseId === 'C05') list.push({
        id: 'c05-label-qa', fdi: 0, title: 'Partial FDI Transfer · Geometry QA', subtitle: '低命中来自训练表面偏差，不是坐标帧错误',
        status: 'caution', metric: '26.7% ≤ 1 mm',
        evidence: '参考采样中位邻距 0.187 mm；训练/参考 bbox 中心与尺度差 <0.1 mm，全 yaw 扫描最佳仅 2.5°。失配是区域性的：FDI 33 的参考点有 91.14% 落在训练点 1 mm 内，而 42/43 为 0%。这是 Brush 表面区域偏差，不是最近邻半径过小；保留 1 mm 保守迁移，未命中 splat 保持 FDI 0。',
        action: () => setRailTab('source'),
      });
    } else if (caseId === 'A') {
      list.push({
        id: 'sampled-baseline', fdi: 0, title: 'Untrained Surface Baseline', subtitle: '同一 000125 的 0.35 mm 采样包 · SH0',
        status: 'info', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
        evidence: '与 Case 01 同源但未经过 Brush 优化；把训练前后的边缘锐度、遮挡与高光差异放在同一相机和同一代理坐标系下比较。',
        action: () => switchCase('A2'),
      });
    } else if (caseId === 'A2' && meta?.teeth?.FDI_46) {
      list.push(
        {
          id: 'fdi-46', fdi: 46, title: 'First Molar Occlusal Morphology', subtitle: '右下第一磨牙窝沟与牙尖高光重建',
          status: 'verified', metric: mbText,
          evidence: 'Poseidon3D 真实口扫经 120 视角渲染与 Brush 15,000 步训练；FDI 标签最近邻迁移，1.0 mm 内命中 99.5%。',
          action: () => { setSelected(46); viewerRef.current?.focusTooth(46); },
        },
        {
          id: 'fdi-36', fdi: 36, title: 'Contralateral Molar Alignment', subtitle: '左下第一磨牙隐形代理网格对齐校验',
          status: 'verified', metric: '代理网格',
          evidence: '拾取与毫米测距打在同一坐标系的隐形代理网格上（1 unit = 1 mm），开启线框可肉眼核验 3DGS 与真值重合。',
          action: () => { setSelected(36); setWire(true); viewerRef.current?.focusTooth(36); },
        },
        {
          id: 'fdi-41', fdi: 41, title: 'Anterior Incisal Arch Orientation', subtitle: '下颌中切牙切缘与标准正交坐标系',
          status: 'verified', metric: '+Z Anterior',
          evidence: '唇侧锁定 +Z、患者右侧 −X、上颌 +Y，保证跨病例预设视角与牙位图完全一致。',
          action: () => { setSelected(41); viewerRef.current?.focusTooth(41); },
        },
      );
    } else if (caseId === 'U') {
      list.push(
        {
          id: 'palatal-vault', fdi: 0, title: 'Palatal Vault & Rugae', subtitle: '完整腭穹窿与腭皱襞的上颌扫描',
          status: 'verified', metric: '120 views',
          evidence: 'Poseidon3D 上颌病例（标注 ortho23）独立渲染 120 视角并训练；与病例 01 下颌不共享任何几何。点击回到腭侧仰视。',
          action: () => goPreset(spec.presets.find((p) => p.id === 'upper') ?? spec.presets[0]),
        },
        {
          id: 'upper-labels', fdi: 0, title: 'No FDI side-car (by design)', subtitle: '本次转换未迁移逐高斯牙位标签',
          status: 'caution', metric: 'FDI 0',
          evidence: '上颌与修复体两例在本轮未写入逐高斯牙位，因此牙位图为空；几何、颜色与透明层数据完整。',
          action: () => setRailTab('source'),
        },
      );
    } else if (caseId === 'P') {
      list.push(
        {
          id: 'restorations', fdi: 0, title: 'Twelve Fixed Restorations', subtitle: '7 个全瓷冠 + 5 个扫描杆（ProsthoObjects3D 608）',
          status: 'verified', metric: '12 units',
          evidence: '厂商 JSON 包围盒与临床 CSV 牙位标注用于构建对齐代理；DSPK 本身在本轮未附逐高斯标签。',
          action: () => setRailTab('source'),
        },
        {
          id: 'ceramic-highlight', fdi: 0, title: 'View-Dependent Ceramic Highlight', subtitle: '全瓷与金属高光的视角相关变化',
          status: 'info', metric: 'SH1',
          evidence: 'Blender 陶瓷 / 金属材质渲染 120 视角，Brush 以 SH1 训练；开启自动旋转即可观察高光沿表面移动。',
          action: () => setSpin(true),
        },
      );
    }
    list.push({
      id: 'compress-audit', fdi: 0,
      title: tenX ? 'Uniform vs Anatomy-Aware 10×' : 'Full vs Pruned Fidelity Check',
      subtitle: tenX ? '同字节预算的解剖感知消融对决' : '同帧分屏与浏览器像素回读',
      status: 'info', metric: tenX ? 'EQUAL BYTES' : ratio ? `${ratio.toFixed(2)}×` : '—',
      evidence: tenX
        ? '两侧均为 11,100 splats / 322,708 B。Uniform 每 10 取 1；Anatomy-Aware 保留 L4 3,000、L1 7,200、L3 650、L7 250，在牙体与神经管两项同时超过 Uniform，并按各层倍率补偿切向尺度。PSNR / MAE 仍由浏览器实时回读。'
        : 'Full 与 Pruned 同驻显存，可用同一帧分屏对比；PSNR / MAE 由浏览器回读像素现场计算，不预写数值。',
      action: () => { setSplit(true); setRailTab('audit'); },
    });

    Object.values(meta?.teeth ?? {}).forEach((t) => {
      if (t.lesion && LESION_LABEL[t.lesion]) {
        const l = LESION_LABEL[t.lesion];
        list.push({
          id: `lesion-${t.fdi}`, fdi: t.fdi, title: `${l.en} (${l.cn})`, subtitle: `FDI #${t.fdi} 病灶区域`,
          status: 'caution', metric: l.code,
          evidence: '牙位级病灶标记与 3D 着色器高亮通道联动，可在右下角开关控制显隐。',
          action: () => { setSelected(t.fdi); viewerRef.current?.focusTooth(t.fdi); },
        });
      }
    });
    return list;
  }, [caseId, focusCanal, goPreset, isLocal, meta, mbText, ratio, report, spec, switchCase, tenX]);

  const filteredFindings = useMemo(() => {
    const q = findingFilter.trim().toLowerCase();
    if (!q) return findings;
    return findings.filter((f) =>
      String(f.fdi).includes(q) || f.title.toLowerCase().includes(q) || f.subtitle.toLowerCase().includes(q)
    );
  }, [findingFilter, findings]);

  const caseBadge = isTimeline ? `TIMELINE · STEP ${timelineStep ?? '—'}` : customAssetName ? `LOCAL ${isPlyLocal ? 'FP32 PLY' : '.DSPK'} · ${customAssetName}` : tenX ? '10× COMPRESSION ABLATION · CASE 03' : mprOn ? 'DTX MPR · CASE 03 · RAW CBCT' : spec.badge;

  // ---------------------------------------------------------------- render

  return (
    <div className="dtx-shell">
      <header className="dtx-menubar">
        <div className="dtx-brand">
          <span className="dtx-mark" />
          <b>DentSplat Lab</b>
          <em>Dental Gaussian Splatting Lab</em>
        </div>

        <nav className="dtx-workflows" aria-label="Gaussian Splatting 工作区">
          <button type="button" className={railTab === 'lab' ? 'on' : ''} onClick={() => { setRailTab('lab'); setInspectorOpen(true); if (labMode === 'rgb') changeLabMode('centers'); }}>Gaussian Lab</button>
          <button type="button" className={railTab === 'recon' ? 'on' : ''} onClick={() => { setRailTab('recon'); setInspectorOpen(true); setPickerOpen(false); }}>Reconstruction</button>
          <button type="button" className={railTab === 'methods' ? 'on' : ''} onClick={() => { setRailTab('methods'); setInspectorOpen(true); setPickerOpen(false); }}>Methods</button>
          <button type="button" className={railTab === 'findings' && mode === 'pick' ? 'on' : ''} onClick={() => { setMode('pick'); setRailTab('findings'); setInspectorOpen(true); }}>Diagnose</button>
          <button type="button" className={mode === 'measure' ? 'on' : ''} onClick={() => { setMode(mode === 'measure' ? 'pick' : 'measure'); setRailTab('findings'); setInspectorOpen(true); }}>Measure</button>
          <button type="button" className={railTab === 'slice' ? 'on' : ''} onClick={() => { setRailTab('slice'); setInspectorOpen(true); }}>Slice &amp; Cap</button>
          <button type="button" className={railTab === 'layers' ? 'on' : ''} onClick={() => { setRailTab('layers'); setInspectorOpen(true); }}>3D Anatomy</button>
          <button type="button" className={railTab === 'audit' ? 'on' : ''} onClick={() => { setRailTab('audit'); setInspectorOpen(true); }}>Compression</button>
        </nav>

        <div className="dtx-spacer" />
        <span className="dtx-patient-pill">{caseBadge}</span>
      </header>

      <div className="dtx-ribbon">
        <div className="rib-group">
          <button type="button" className={'rib-btn' + (mode === 'pick' ? ' on' : '')} onClick={() => setMode('pick')}>
            <Icon name="pick" /><span>3D 拾取</span>
          </button>
          <button type="button" className={'rib-btn' + (mode === 'measure' ? ' on' : '')} onClick={() => setMode(mode === 'measure' ? 'pick' : 'measure')}>
            <Icon name="measure" /><span>mm 测距</span>
          </button>
          <button type="button" className={'rib-btn' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}>
            <Icon name="wire" /><span>对齐线框</span>
          </button>
        </div>

        <i className="rib-div" />

        <div className="rib-group">
          <button type="button" className={'rib-btn' + (clipAxis !== null ? ' on' : '')} onClick={() => {
            if (clipAxis) setClipAxis(null);
            else { setClipAxis('x'); setClipOffset(0); setRailTab('slice'); setInspectorOpen(true); }
          }}>
            <Icon name="slice" /><span>三轴剖切</span>
          </button>
          <button type="button" className={'rib-btn' + (cap && clipAxis !== null ? ' on' : '')} onClick={() => setCap((c) => !c)}>
            <Icon name="cap" /><span>断面封顶</span>
          </button>
          <button type="button" className={'rib-btn' + (spec.cohort === 'cbct' && activePreset === 'ian' ? ' on' : '')} onClick={focusCanal}>
            <Icon name="nerve" /><span>神经管特写</span>
          </button>
        </div>

        <i className="rib-div" />

        <div className="rib-group">
          <button type="button" className={'rib-btn' + (variant === 'full' && !split ? ' on' : '')} disabled={tenX || methodCompare} onClick={() => { setVariant('full'); setSplit(false); }}>
            <Icon name="layers" /><span>Full 完整</span>
          </button>
          <button type="button" className={'rib-btn' + (variant === 'pruned' && !split ? ' on' : '')} disabled={tenX || methodCompare} onClick={() => { setVariant('pruned'); setSplit(false); }}>
            <Icon name="layers" /><span>Pruned 剪枝</span>
          </button>
          <button type="button" className={'rib-btn' + (split ? ' on' : '')} disabled={tenX || methodCompare} onClick={() => setSplit((s) => !s)}>
            <Icon name="split" /><span>同屏对比</span>
          </button>
          <button
            type="button"
            className={'rib-btn' + (tenX ? ' on' : '')}
            disabled={isLocal}
            title={tenX ? '退出 10× 对决并恢复完整 Case 03' : '自动切换 Case 03 并运行同预算对决'}
            onClick={toggleTenX}
          >
            <Icon name="split" /><span>10× 解剖压缩</span>
          </button>
          <button type="button" className={'rib-btn' + (heatmap ? ' on' : '')} onClick={() => setHeatmap((h) => !h)}>
            <Icon name="heat" /><span>重要性热力图</span>
          </button>
          <button
            type="button"
            className={'rib-btn' + (mprOn ? ' on' : '')}
            disabled={isLocal}
            title={mprOn ? '关闭四视口 MPR' : '自动切换 Case 03 并开启 3DGS + 原始 CBCT 四视口'}
            onClick={toggleMpr}
          >
            <Icon name="slice" /><span>四视口 MPR</span>
          </button>
          <button type="button" className={'rib-btn' + (benching ? ' on' : '')} onClick={runBench} disabled={benching || !report}>
            <Icon name="bench" /><span>{benching ? '审计中…' : 'PSNR 审计'}</span>
          </button>
        </div>

        <i className="rib-div" />

        <div className="rib-group">
          <button type="button" className={'rib-btn' + (spin ? ' on' : '')} onClick={() => setSpin((s) => !s)}>
            <Icon name="reset" /><span>自动旋转</span>
          </button>
          <button type="button" className="rib-btn" onClick={resetView}>
            <Icon name="reset" /><span>重置视图</span>
          </button>
          <button type="button" className="rib-btn" onClick={shoot}>
            <Icon name="camera" /><span>导出影像</span>
          </button>
          <button type="button" className="rib-btn" onClick={saveReview} title="保存病例、牙位、切片坐标、测量与审计结果为 JSON">
            <Icon name="audit" /><span>保存记录</span>
          </button>
          <button type="button" className="rib-btn" onClick={() => fileInputRef.current?.click()} title="本地加载 FP32 .ply 或 .dspk 文件（Research Mode，零上传）">
            <Icon name="upload" /><span>载入 PLY/DSPK</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dspk,.ply"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadLocalFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="dtx-subtabs">
        <div className="cohort-tabs" role="tablist" aria-label="病例类别">
          {COHORT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={cohort === t.id}
              className={'subtab cohort-tab' + (cohort === t.id ? ' on' : '')}
              onClick={() => {
                setCohort(t.id);
                setCaseQuery('');
                setPickerOpen(true);
                if (t.id !== 'all' && spec.cohort !== t.id) {
                  const first = CASES.find((c) => c.cohort === t.id);
                  if (first) switchCase(first.id);
                }
              }}
            >
              <span className="subtab-dot" />
              {t.label}
              {t.id !== 'all' && <small>{cohortCounts[t.id]}</small>}
            </button>
          ))}
        </div>
        <div className="dtx-spacer" />
        <div className="subtab-info">{isTimeline ? `TIMELINE · step ${timelineStep ?? '—'} · ${report ? `${fmtInt(report.full.splats)} splats` : ''}` : isLocal ? `LOCAL ${isPlyLocal ? 'FP32 PLY' : 'DSPK'} · ${customAssetName}` : `${spec.code} · ${spec.title}`}</div>
      </div>

      <div className={'dtx-workspace' + (inspectorOpen ? '' : ' collapsed')}>
        <aside className="dtx-scene" aria-label="场景树">
          <div className="scene-head"><span>SCENE TREE</span><b>{isLocal ? 'LOCAL' : spec.code.replace('Case ', 'C')}</b></div>
          <div className="scene-scroll">
            <div className="scene-group">DATASET</div>
            <div className="scene-root" title={isLocal ? customAssetName ?? '' : spec.title}>
              <i className="scene-dot live" />
              <b>{isLocal ? (customAssetName ?? 'LOCAL') : spec.shortTitle}</b>
              <small>{report ? `${fmtInt(report.full.splats)} splats · ${fmtMB(report.full.bytes)} MB` : 'loading…'}</small>
            </div>

            <div className="scene-group">REPRESENTATIONS</div>
            <button type="button" className={'scene-node' + (!isLocal && caseId === 'A2' ? ' on' : '')} onClick={() => switchCase('A2')}>
              <i className="scene-dot brush" /><span><b>Brush 3DGS</b><small>{fmtInt(allScenes.sceneA_trained?.full.splats ?? 28691)} · SH1</small></span>
            </button>
            <button type="button" className={'scene-node' + (!isLocal && caseId === 'A' ? ' on' : '')} onClick={() => switchCase('A')}>
              <i className="scene-dot sample" /><span><b>Surface Sampling</b><small>{fmtInt(allScenes.sceneA_ios?.full.splats ?? 59808)} · SH0</small></span>
            </button>
            <button type="button" className={'scene-node' + (!isLocal && (caseId === 'B' || caseId === 'C08' || caseId === 'C09') ? ' on' : '')} onClick={() => switchCase('B')}>
              <i className="scene-dot cbct" /><span><b>CBCT Surfel</b><small>Case 03 · 111,000</small></span>
            </button>
            <button type="button" className={'scene-node' + (variant === 'full' && !split ? ' on' : '')} disabled={tenX} onClick={() => { setVariant('full'); setSplit(false); }}>
              <i className="scene-branch" /><span><b>DSPK Full</b><small>{fmtInt(report?.full.splats ?? 0)} splats</small></span>
            </button>
            <button type="button" className={'scene-node' + (variant === 'pruned' && !split ? ' on' : '')} disabled={tenX} onClick={() => { setVariant('pruned'); setSplit(false); }}>
              <i className="scene-branch" /><span><b>DSPK Pruned</b><small>{fmtInt(report?.pruned.splats ?? 0)} splats</small></span>
            </button>
            <button type="button" className={'scene-node' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}>
              <i className="scene-branch" /><span><b>Aligned Mesh Wire</b><small>{wire ? 'visible' : 'hidden'}</small></span>
            </button>

            <div className="scene-group">GAUSSIAN OVERLAYS</div>
            <button type="button" className={'scene-node' + (railTab === 'lab' && labMode === 'centers' ? ' on' : '')} onClick={() => changeLabMode('centers')}>
              <i className="scene-dot center" /><span><b>Centers</b><small>real μ</small></span>
            </button>
            <button type="button" className={'scene-node' + (railTab === 'lab' && labMode === 'ellipsoid' ? ' on' : '')} onClick={() => changeLabMode('ellipsoid')}>
              <i className="scene-dot ellipsoid" /><span><b>Ellipsoids</b><small>{labSigma}σ covariance</small></span>
            </button>
            <button type="button" className={'scene-node' + (railTab === 'lab' && labMode === 'opacity' ? ' on' : '')} onClick={() => changeLabMode('opacity')}>
              <i className="scene-dot opacity" /><span><b>Opacity Map</b><small>per-splat α</small></span>
            </button>

            <div className="scene-group">CLINICAL</div>
            <button type="button" className={'scene-node' + (mprOn ? ' on' : '')} onClick={toggleMpr} disabled={isLocal}>
              <i className="scene-branch" /><span><b>CBCT MPR</b><small>{mprOn ? 'Case 03 active' : 'axial / coronal / sagittal'}</small></span>
            </button>
            <button type="button" className="scene-node" onClick={focusCanal}>
              <i className="scene-branch" /><span><b>IAN Canal Focus</b><small>inferior alveolar nerve</small></span>
            </button>
          </div>
        </aside>

        <section
          className={'dtx-viewport' + (mprOn ? ' mpr-mode' : '') + (mode === 'measure' ? ' is-measure' : '') + (dragOver ? ' is-drag' : '')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void loadLocalFile(f);
          }}
        >
          <div className="viewer-cell" ref={stageRef}>
          <div className="vp-header">
            <div className="hud vp-title">
              <span className="vp-green-sq" />
              <b>{railTab === 'lab' ? 'Gaussian Lab' : railTab === 'methods' ? 'Method Comparison' : railTab === 'recon' ? 'Reconstruction Timeline' : '3DGS Viewer'}</b>
              <span className="vp-sep">|</span>
              <span className="vp-stat"><b className={stats.fps >= 55 ? 'ok' : ''}>{stats.fps}</b> FPS</span>
              <span className="vp-stat">{fmtInt(stats.splats)} splats</span>
              <span className="vp-stat">{fmtMB(stats.bytes)} MB</span>
              <span className="vp-stat muted">{stats.gpu}</span>
            </div>

            <div className="vp-presets">
              {spec.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={activePreset === p.id ? 'on' : ''}
                  onClick={() => goPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {(railTab === 'lab' || labMode !== 'rgb') && (
            <div className="lab-modebar" aria-label="Gaussian 渲染模式">
              <b>GAUSSIAN LAB</b>
              {LAB_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.note}
                  className={labMode === m.id ? 'on' : ''}
                  onClick={() => changeLabMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
              {(labMode === 'ellipsoid' || labMode === 'wire') && (
                <span className="lab-sigmas">
                  {([1, 2, 3] as const).map((n) => (
                    <button key={n} type="button" className={labSigma === n ? 'on' : ''} onClick={() => changeLabSigma(n)}>
                      {n}σ
                    </button>
                  ))}
                </span>
              )}
              {labInfo && labInfo.rendered > 0 && (
                <span className="lab-sample">
                  {labInfo.mode === 'centers' ? 'points' : labInfo.mode === 'ellipsoid' ? 'ellipsoids' : 'wireframes'}{' '}
                  {fmtInt(labInfo.rendered)}/{fmtInt(labInfo.available)}
                  {labInfo.triangles > 0 ? ` · ${fmtInt(labInfo.triangles)} tris` : ''}
                  {labInfo.truncated ? ' · sampled' : ''}
                </span>
              )}
            </div>
          )}

          <canvas id="gl" ref={canvasRef} />

          <div className="vp-corner-bl">
            <div className="vp-coord">
              1 unit = 1 mm · Y-up
              {selected > 0 && <b className="hl-tooth"> · FDI #{selected}</b>}
              {probe && <span> · ({probe.mm[0]}, {probe.mm[1]}, {probe.mm[2]}) mm</span>}
            </div>
            {measures.length > 0 && (
              <div className="vp-measures">
                {measures.slice(-3).map((m, i) => (
                  <span className="m-tag" key={`${m}-${i}`}>
                    L{i + 1}: <b>{m.toFixed(2)} mm</b>
                    <button type="button" onClick={() => setMeasures((l) => l.filter((_, j) => j !== l.lastIndexOf(m)))}>✕</button>
                  </span>
                ))}
                <button type="button" className="m-clear" onClick={() => { setMeasures([]); viewerRef.current?.clearMeasure(); }}>清空</button>
              </div>
            )}
          </div>

          {split && (
            <>
              <div className="split-rule" />
              <span className="split-tag l">
                {isTimeline && timelineCompare
                  ? `BRUSH CHECKPOINT ${timelineStep ?? '—'} · ${fmtInt(report?.full.splats ?? 0)} splats (${fmtMB(report?.full.bytes ?? 0)} MB)`
                  : methodCompare
                    ? `BRUSH 3DGS · ${fmtInt(report?.full.splats ?? 0)} splats (${fmtMB(report?.full.bytes ?? 0)} MB)`
                    : tenX ? `UNIFORM 10× · ${fmtInt(report?.full.splats ?? 0)} splats (${fmtMB(report?.full.bytes ?? 0)} MB)` : `FULL · ${fmtInt(report?.full.splats ?? 0)} splats (${fmtMB(report?.full.bytes ?? 0)} MB)`}
              </span>
              <span className="split-tag r">
                {isTimeline && timelineCompare
                  ? `PUBLISHED FINAL · ${fmtInt(report?.pruned.splats ?? 0)} splats (${fmtMB(report?.pruned.bytes ?? 0)} MB)`
                  : methodCompare
                    ? `SURFACE SAMPLING · ${fmtInt(report?.pruned.splats ?? 0)} splats (${fmtMB(report?.pruned.bytes ?? 0)} MB)`
                    : tenX ? `ANATOMY-AWARE 10× · ${fmtInt(report?.pruned.splats ?? 0)} splats (${fmtMB(report?.pruned.bytes ?? 0)} MB)` : `PRUNED (${ratio.toFixed(2)}×) · ${fmtInt(report?.pruned.splats ?? 0)} splats (${fmtMB(report?.pruned.bytes ?? 0)} MB)`}
              </span>
            </>
          )}

          {dragOver && (
            <div className="drop-mask">
              <div>松开鼠标，立即在本地浏览器加载 <code>.ply</code> / <code>.dspk</code> 高斯模型（数据不离本机）</div>
            </div>
          )}

          {heatmap && (
            <div className="heatmap-legend">
              <b>CLINICAL IMPORTANCE</b>
              <span><i style={{ background: '#ff3b30' }} />L4 神经管</span>
              <span><i style={{ background: '#f59e0b' }} />L1 牙体</span>
              <span><i style={{ background: '#2563eb' }} />L3 牙槽骨</span>
              <span><i style={{ background: '#38bdf8' }} />L7 上颌窦</span>
            </div>
          )}

          {loading && <div className="vp-overlay"><b>DENTSPLAT</b><span>正在解码 DSPK 容器与空间代理…</span></div>}
          {err && <div className="vp-overlay err">资产加载失败：{err}</div>}
          </div>

          {mprOn && (
            <MprQuadView
              cursorMm={cursorMm}
              onCursorChange={handleMprCursor}
              maskVisible={mprMask}
              onMaskVisibleChange={setMprMask}
            />
          )}
        </section>

        <aside className="dtx-rail" aria-label="检视面板切换">
          {([
            ['lab', 'gaussian', 'Gaussian'],
            ['recon', 'source', 'Recon'],
            ['methods', 'bench', 'Methods'],
            ['findings', 'findings', 'Findings'],
            ['layers', 'layers', 'Layers'],
            ['slice', 'slice', 'Slice'],
            ["audit", "bench", "Compress"],
            ['source', 'source', 'Data'],
          ] as [RailTab, string, string][]).map(([id, icon, label]) => (
            <button
              key={id}
              type="button"
              className={'rail-btn' + (inspectorOpen && railTab === id ? ' on' : '')}
              onClick={() => {
                if (inspectorOpen && railTab === id) setInspectorOpen(false);
                else { setRailTab(id); setInspectorOpen(true); }
              }}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </aside>

        <aside className="dtx-inspector">
          <div className="insp-odontogram">
            <Odontogram
              teeth={meta?.teeth ?? {}}
              selected={selected}
              hidden={hidden}
              onSelect={(f) => { setSelected(f); if (f) viewerRef.current?.focusTooth(f); }}
              onToggleHide={toggleHide}
            />
            <div className="insp-tooth-bar">
              <button type="button" className={'tbar-btn' + (isolate ? ' on' : '')} onClick={() => setIsolate((i) => !i)}>隔离单牙</button>
              <button type="button" className="tbar-btn" onClick={() => { setHidden([]); setIsolate(false); }}>显示全口</button>
              <button type="button" className={'tbar-btn' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}>校验线框</button>
            </div>
          </div>

          <div className="insp-scroll">
            <div className={'case-picker' + (pickerOpen ? '' : ' collapsed')}>
              <button
                type="button"
                className="picker-head"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((o) => !o)}
              >
                <span>3DGS CASE COHORT ({CASES.length})</span>
                <span className="picker-head-r">
                  <span className="picker-active-code">{spec.code}</span>
                  <span className="picker-caret">{pickerOpen ? '−' : '+'}</span>
                </span>
              </button>
              {pickerOpen && (
                <>
                  <input
                    type="search"
                    className="case-search"
                    placeholder="搜索病例编号 / 名称 / 模态…"
                    value={caseQuery}
                    onChange={(e) => setCaseQuery(e.target.value)}
                  />
                  <div className="case-list" role="listbox" aria-label="选择 3DGS 病例">
                    {pickerCases.map((c) => {
                      const sc = allScenes[c.sceneKey];
                      const cls = c.tag === 'CBCT Surfel' ? 'cbct' : c.tag === 'Sampled IOS' ? 'base' : 'gs';
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="option"
                          aria-selected={c.id === caseId}
                          className={'case-row' + (c.id === caseId ? ' on' : '')}
                          onClick={() => switchCase(c.id)}
                        >
                          <span className="cr-code">{c.code.replace('Case ', 'C')}</span>
                          <span className="cr-main">
                            <b>{c.shortTitle}</b>
                            <small>
                              {c.modality}
                              {sc ? ` · ${fmtInt(sc.full.splats)} splats · ${fmtMB(sc.full.bytes)} MB` : ' · metrics TBD'}
                            </small>
                          </span>
                          <span className={'cr-tag ' + cls}>{c.tag}</span>
                        </button>
                      );
                    })}
                    {pickerCases.length === 0 && <div className="case-empty">没有匹配的病例</div>}
                  </div>
                </>
              )}
            </div>

            <div className={'insp-pane' + (railTab === 'recon' ? ' active' : '')}>
              <div className="sec-head"><span>RECONSTRUCTION TIMELINE</span><b>Case 01 · real artifacts only</b></div>
              <p className="method-intro">只展示仓库里真实存在、可重新加载的阶段产物。没有保存的阶段与训练曲线会明确标为缺失，不用示意曲线补齐。</p>

              <div className="sec-head"><span>BRUSH CHECKPOINTS · LIVE LOAD</span><b>{timeline ? `${timeline.steps.length} steps` : 'loading…'}</b></div>
              {timeline ? (
                <>
                  <div className="recon-checkpoints">
                    {timeline.steps.map((s) => (
                      <button
                        key={s.step}
                        type="button"
                        disabled={timelineBusy}
                        className={timelineStep === s.step && (customAssetName === `timeline:${s.step}` || customAssetName === `timeline:${s.step}:vs-final`) ? 'on' : ''}
                        onClick={() => void loadTimelineStep(s)}
                      >
                        <b>{fmtInt(s.step)}</b>
                        <small>{fmtInt(s.splats)} splats</small>
                        <small>{fmtMB(s.bytes)} MB</small>
                      </button>
                    ))}
                  </div>
                  <p className="source-note">{timeline.training.note} · {timeline.metrics_note}</p>
                  <label className="timeline-toggle">
                    <input
                      type="checkbox"
                      checked={timelineCompare}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setTimelineCompare(next);
                        const active = timeline.steps.find((s) => s.step === timelineStep);
                        if (active && timelineStep != null) void loadTimelineStep(active, next);
                      }}
                    />
                    与已发布最终模型双视口（左 checkpoint / 右 final）
                  </label>
                  <div className="count-curve" aria-label="Gaussian count by checkpoint">
                    {(() => {
                      const max = Math.max(...timeline.steps.map((s) => s.splats));
                      const min = Math.min(...timeline.steps.map((s) => s.splats));
                      return timeline.steps.map((s) => {
                        const t = max === min ? 0.6 : 0.25 + 0.75 * (s.splats - min) / (max - min);
                        return (
                          <span key={s.step} title={`${s.step.toLocaleString()} steps · ${s.splats.toLocaleString()} splats`}>
                            <i style={{ height: `${Math.round(t * 100)}%` }} />
                            <em>{s.step / 1000}k</em>
                            <small>{fmtInt(s.splats)}</small>
                          </span>
                        );
                      });
                    })()}
                  </div>
                  {geometryAudit?.timeline && geometryAudit.timeline.length > 1 && (() => {
                    const first = geometryAudit.timeline![0], last = geometryAudit.timeline![geometryAudit.timeline!.length - 1];
                    return (
                      <>
                        <div className="sec-head"><span>CHECKPOINT GEOMETRY</span><b>mesh vertex audit</b></div>
                        <div className="timeline-metrics">
                          <span><b>cloud→mesh mean</b><em>{first.cloud_to_mesh.mean_mm.toFixed(3)} → {last.cloud_to_mesh.mean_mm.toFixed(3)} mm</em></span>
                          <span><b>F@0.5 precision</b><em>{(first.fscore.precision * 100).toFixed(1)} → {(last.fscore.precision * 100).toFixed(1)}%</em></span>
                          <span><b>F@0.5 recall</b><em>{(first.fscore.recall * 100).toFixed(1)} → {(last.fscore.recall * 100).toFixed(1)}%</em></span>
                          <span><b>normal |n·n|</b><em>{first.normal_abs_dot?.mean.toFixed(3) ?? '—'} → {last.normal_abs_dot?.mean.toFixed(3) ?? '—'}</em></span>
                        </div>
                        <p className="source-note timeline-warning">这次独立重训的高斯数量持续增加，但中心到网格的 mean 与 F precision 变差、recall 略升：优化目标改善渲染覆盖，不等价于高斯中心更贴网格。曲线按同一步的实际 checkpoint 复算，未做筛点。</p>
                      </>
                    );
                  })()}
                </>
              ) : <p className="source-note">timeline.json 尚未加载。</p>}

              <ol className="recon-steps">
                <li className="done">
                  <i>01</i>
                  <div><b>{allScenes.sceneA_trained?.training?.views ?? 120} 个 Blender 视角</b><span>Poseidon3D 000125 口扫网格 → Cycles 渲染，作为训练输入。</span></div>
                </li>
                <li className="done">
                  <i>02</i>
                  <div><b>Surface Sampling · {fmtInt(allScenes.sceneA_ios?.full.splats ?? 59808)} splats</b><span>0.35 mm 同源采样基线，SH0，未经优化。</span></div>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A')}>加载</button>
                </li>
                <li className="done">
                  <i>03</i>
                  <div><b>{allScenes.sceneA_trained?.training?.tool ?? 'Brush v0.3.0'} · {fmtInt(allScenes.sceneA_trained?.training?.steps ?? 15000)} steps</b><span>{fmtInt(allScenes.sceneA_trained?.full.splats ?? 28691)} 个各向异性高斯 · SH{allScenes.sceneA_trained?.full.sh_degree ?? 1} · 标签迁移 99.5% &lt; 1 mm。</span></div>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A2')}>加载</button>
                </li>
                <li className="done">
                  <i>04</i>
                  <div><b>DSPK Full · {fmtInt(allScenes.sceneA_trained?.full.splats ?? 28691)} splats</b><span>{allScenes.sceneA_trained ? `${fmtMB(allScenes.sceneA_trained.full.bytes)} MB · ${allScenes.sceneA_trained.full.bytes_per_splat} B/splat` : '—'}</span></div>
                </li>
                <li className="done">
                  <i>05</i>
                  <div><b>DSPK Pruned · {fmtInt(allScenes.sceneA_trained?.pruned.splats ?? 9564)} splats</b><span>{allScenes.sceneA_trained ? `${fmtMB(allScenes.sceneA_trained.pruned.bytes)} MB · ${allScenes.sceneA_trained.bytes_ratio.toFixed(2)}× smaller` : '—'}</span></div>
                </li>
                <li className="missing">
                  <i>!</i>
                  <div><b>Loss / PSNR 曲线</b><span>已通过独立重训导出 1k–15k 的真实高斯 checkpoint；但训练器没有输出可用的 loss 行，因此仍不提供伪造的损失曲线。</span></div>
                </li>
              </ol>
              <div className="quick-row">
                <button type="button" className="tbar-btn primary" onClick={startMethodCompare}>采样 ↔ 训练双视口</button>
                <button type="button" className="tbar-btn" onClick={() => changeLabMode('ellipsoid')}>查看 1σ 椭球</button>
              </div>
              <p className="source-note">时间轴描述的是 Case 01 的真实产物链：输入视角、未训练采样、Brush 训练结果与两个 DSPK 传输包。它不声称还原每一步优化过程。</p>
            </div>

            <div className={'insp-pane' + (railTab === 'methods' ? ' active' : '')}>
              <div className="sec-head"><span>METHOD REGISTRY</span><b>evidence, not labels</b></div>
              <p className="method-intro">只有存在真实训练/导出资产的方法才标记为 AVAILABLE。切换网页显示模式不会被算作 2DGS、Mip-Splatting 或 R²-Gaussian 的实现。</p>
              <div className="method-list">
                <div className="method-row ok">
                  <div><b>Surface Sampling</b><small>0.35 mm 表面采样 · SH0</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A')}>Case 10</button>
                </div>
                <div className="method-row ok">
                  <div><b>Brush 3DGS</b><small>15,000 步 · 各向异性 3DGS · SH1</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A2')}>Case 01</button>
                </div>
                <div className="method-row ok">
                  <div><b>CBCT Oriented Surfel</b><small>分割体 → marching-cubes oriented surfels</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('B')}>Case 03</button>
                </div>
                <div className="method-row">
                  <div><b>Vanilla 3DGS</b><small>官方实现独立训练对照</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row">
                  <div><b>Mip-Splatting</b><small>抗混叠 / 多尺度渲染</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row">
                  <div><b>2DGS</b><small>定向二维高斯圆盘 + 法线约束</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row">
                  <div><b>SuGaR</b><small>表面对齐高斯与网格提取</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row">
                  <div><b>R²-Gaussian</b><small>X-ray 投影几何重建</small></div><span>UNAVAILABLE</span>
                </div>
              </div>
              <button type="button" className="tbar-btn primary method-compare-btn" onClick={startMethodCompare}>
                同源双视口：Surface Sampling ↔ Brush 3DGS
              </button>
              <p className="source-note">Case 01 与 Case 10 来自同一 Poseidon3D 000125 口扫；左侧为 Brush 训练版（28,691 高斯），右侧为未训练采样基线（59,808 高斯）。两视口共用相机、坐标架与时间。</p>
              {methodCompare && <div className="method-live">METHOD COMPARISON ACTIVE · split camera locked · 左 Brush / 右 Sampling</div>}

              <div className="sec-head"><span>GEOMETRY AUDIT · CASE 01</span><b>mesh vertex sample</b></div>
              {geometryAudit ? (
                <>
                  <div className="geom-audit">
                    <div className="ga-head"><span>method</span><span>cloud→mesh</span><span>F@0.5</span><span>|n·n|</span></div>
                    {([
                      ['Brush · DSPK', geometryAudit.methods.brush_3dgs],
                      ['Brush · FP32', geometryAudit.methods.brush_3dgs.raw_ply],
                      ['Sampling · DSPK', geometryAudit.methods.surface_sampling],
                      ['Sampling · FP32', geometryAudit.methods.surface_sampling.raw_ply],
                    ] as [string, GeometryMethod | undefined][]).filter((r): r is [string, GeometryMethod] => !!r[1]).map(([name, m]) => (
                      <div className="ga-row" key={name}>
                        <b>{name}</b>
                        <span>{m.cloud_to_mesh.mean_mm.toFixed(3)} / {m.cloud_to_mesh.p95_mm.toFixed(3)} mm</span>
                        <span>{(m.fscore.precision * 100).toFixed(1)} / {(m.fscore.recall * 100).toFixed(1)}%</span>
                        <span>{m.normal_abs_dot ? m.normal_abs_dot.mean.toFixed(3) : '—'}</span>
                      </div>
                    ))}
                  </div>
                  <p className="source-note">
                    {geometryAudit.source_mesh.triangles.toLocaleString()} tri / {geometryAudit.source_mesh.vertices.toLocaleString()} verts · cloud→mesh 显示 mean / p95；F@0.5 为 precision / recall。
                    FP32→DSPK 的 cloud→mesh mean 差：Brush {Math.abs(geometryAudit.methods.brush_3dgs.raw_ply!.cloud_to_mesh.mean_mm - geometryAudit.methods.brush_3dgs.cloud_to_mesh.mean_mm).toFixed(4)} mm，
                    Sampling {Math.abs(geometryAudit.methods.surface_sampling.raw_ply!.cloud_to_mesh.mean_mm - geometryAudit.methods.surface_sampling.cloud_to_mesh.mean_mm).toFixed(4)} mm。
                    {' '}{geometryAudit.caveat}
                  </p>
                </>
              ) : <p className="source-note">geometry_metrics.json 尚未加载或不可用。</p>}

              <div className="method-caveat">R²-Gaussian 需要 X 射线投影及成像几何，当前 CBCT 分割体数据不能替代；项目不提供伪造的跨方法结果。</div>
            </div>

            <div className={'insp-pane' + (railTab === 'lab' ? ' active' : '')}>
              <div className="sec-head">
                <span>GAUSSIAN INSPECTOR</span>
                <b>{gaussian ? `#${gaussian.index}` : 'CLICK A GAUSSIAN'}</b>
              </div>
              {!gaussian ? (
                <div className="lab-empty">
                  <p>当前模式：<b>{LAB_MODES.find((m) => m.id === labMode)?.label ?? labMode}</b></p>
                  <p>在视口点击任意高斯中心，读取它的 μ、σ、四元数、不透明度、协方差与 SH 系数，并可直接拖动参数观察椭球变化。</p>
                  <p className="muted">椭球模式按真实 3×3 协方差构建；法线模式显示椭球最小主轴，不是网格表面法线。</p>
                </div>
              ) : (
                <>
                  <div className="gauss-identity">
                    <span className={`gauss-precision ${gaussian.precision === 'fp32' ? 'raw' : ''}`}>{gaussian.precision === 'fp32' ? 'FP32 RAW' : 'DSPK 8-BIT'}</span>
                    <span>FDI #{gaussian.fdi || '—'}</span>
                    <span>{LOCAL_LAYER_NAMES[gaussian.layer] ?? `Layer ${gaussian.layer}`}</span>
                    <span>SH{gaussian.shDegree}</span>
                  </div>
                  <dl className="kv-mini gauss-kv">
                    <dt>Position μ</dt><dd>{gaussian.center.map((n) => n.toFixed(3)).join(', ')} {gaussUnit}</dd>
                    <dt>Scale σ</dt><dd>{gaussian.scales.map((n) => n.toFixed(4)).join(', ')} {gaussUnit}</dd>
                    <dt>Quaternion</dt><dd>W {gaussian.quat[3].toFixed(3)} · X {gaussian.quat[0].toFixed(3)} · Y {gaussian.quat[1].toFixed(3)} · Z {gaussian.quat[2].toFixed(3)}</dd>
                    <dt>Opacity</dt><dd>{gaussian.alpha.toFixed(3)}</dd>
                    <dt>RGB DC</dt><dd>{gaussian.color.map((n) => n.toFixed(2)).join(' / ')}</dd>
                  </dl>

                  <div className="sec-head"><span>G(t) · PRINCIPAL AXES</span><b>{gaussian.axes.sigmas.map((s) => s.toFixed(3)).join(' / ')} {gaussUnit}</b></div>
                  <GaussianPlot sigmas={gaussian.axes.sigmas} unit={gaussUnit} />
                  <div className="sec-head"><span>SCREEN-SPACE PROJECTION</span><b>live camera</b></div>
                  <ProjectionPlot viewer={viewerRef.current} index={gaussian.index} />
                  {gaussian.shDegree > 1 && (
                    <p className="source-note">该文件含 SH{gaussian.shDegree} 字段；导入/导出会保留全部 f_rest 系数，但当前 GPU 渲染只评估 DC + l=1，l≥2 未渲染，不能据此宣称 SH{gaussian.shDegree} 渲染。</p>
                  )}

                  <div className="sec-head"><span>LIVE EDIT</span><b>writes this Gaussian</b></div>
                  {([0, 1, 2] as const).map((axis) => (
                    <div className="ctrl-item" key={`p${axis}`}>
                      <div className="ctrl-label">
                        <span><i className={`axis-dot a${axis}`} />μ {['X', 'Y', 'Z'][axis]}</span>
                        <b>{gaussian.center[axis].toFixed(3)} {gaussUnit}</b>
                      </div>
                      <input
                        type="range" step={0.01}
                        min={(gaussOriginal?.center[axis] ?? gaussian.center[axis]) - 10}
                        max={(gaussOriginal?.center[axis] ?? gaussian.center[axis]) + 10}
                        value={gaussian.center[axis]}
                        onChange={(e) => editGaussPosition(axis, Number(e.target.value))}
                      />
                    </div>
                  ))}
                  {([0, 1, 2] as const).map((axis) => (
                    <div className="ctrl-item" key={axis}>
                      <div className="ctrl-label">
                        <span><i className={`axis-dot a${axis}`} />σ {['X', 'Y', 'Z'][axis]}</span>
                        <b>{gaussian.scales[axis].toFixed(4)} {gaussUnit}</b>
                      </div>
                      <input
                        type="range" min={0.002} max={2} step={0.001}
                        value={Math.min(2, Math.max(0.002, gaussian.scales[axis]))}
                        onChange={(e) => editGaussScale(axis, Number(e.target.value))}
                      />
                    </div>
                  ))}
                  <div className="ctrl-item">
                    <div className="ctrl-label"><span>Opacity α</span><b>{gaussian.alpha.toFixed(3)}</b></div>
                    <input type="range" min={0} max={1} step={0.005} value={gaussian.alpha} onChange={(e) => editGaussOpacity(Number(e.target.value))} />
                  </div>

                  <div className="sec-head"><span>COVARIANCE Σ ({isPlyLocal ? 'u²' : 'mm²'})</span></div>
                  <div className="cov-grid">
                    {[0, 1, 2].map((r) => [0, 1, 2].map((c) => (
                      <span key={`${r}-${c}`} className={r === c ? 'diag' : ''}>{gaussian.covariance[r * 3 + c].toExponential(2)}</span>
                    )))}
                  </div>
                  <div className="eig-list">
                    {gaussian.axes.sigmas.map((s, i) => (
                      <span key={i}><i className={`axis-dot a${i}`} />λ{i + 1} = {s.toFixed(4)} {gaussUnit}</span>
                    ))}
                  </div>

                  {gaussian.sh1 && (
                    <>
                      <details className="sh-details">
                        <summary>SH1 coefficients ({gaussian.sh1.length})</summary>
                        <code>{gaussian.sh1.map((v) => v.toFixed(3)).join(', ')}</code>
                      </details>
                      <details className="sh-details" open>
                        <summary>SH1 appearance across view directions</summary>
                        <ShAppearancePlot sh1={gaussian.sh1} base={gaussian.color} />
                      </details>
                    </>
                  )}

                  <div className="quick-row gauss-actions">
                    <button type="button" className="tbar-btn" onClick={() => viewerRef.current?.selectGaussian(gaussian.index, { focus: true })}>聚焦</button>
                    <button type="button" className={'tbar-btn' + (gaussIsolate ? ' on' : '')} onClick={() => setGaussIsolate((x) => !x)}>{gaussIsolate ? '退出隔离' : '隔离此高斯'}</button>
                    <button type="button" className="tbar-btn" onClick={resetGaussian} disabled={!gaussOriginal}>重置</button>
                    <button type="button" className="tbar-btn" onClick={exportPly}>导出 PLY</button>
                  </div>
                  <p className="source-note">
                    DSPK 编辑受 16-bit 位置与 8-bit log-scale 量化限制，界面显示的是写回后的实际值；FP32 PLY 保留原始浮点。
                    {isPlyLocal && ' PLY 不声明长度单位，界面以原始 PLY 单位 (u) 显示，未自动换算为 mm。'}
                  </p>
                </>
              )}
              {plyNote && <p className="source-note ply-note">{plyNote}</p>}
              <div className="lab-footnote">
                <b>{LAB_MODES.find((m) => m.id === labMode)?.label}</b> · {LAB_MODES.find((m) => m.id === labMode)?.note}
                {labInfo?.truncated && <span> · 几何模式为可复现抽样，栏内显示真实渲染数量</span>}
              </div>
            </div>

            <div className={'insp-pane' + (railTab === 'findings' ? ' active' : '')}>
              {caseId === 'B' && (
                <div className="evidence-auditor">
                  <div className="auditor-head">
                    <span><Icon name="audit" />AI REPORT AUDIT</span>
                    <b>BIBM × ToothXpert</b>
                  </div>
                  <p>模拟 Dental VLM 报告；点击后从当前完整 DSPK 点云现场复算 FDI→神经管最小中心距。容差 0.30 mm，不预写判定。</p>
                  <button type="button" className="tbar-btn primary audit-run" disabled={auditing || tenX} onClick={runGeometricAudit}>
                    {auditing ? '正在遍历三维点对…' : 'Run 3D Geometric Audit'}
                  </button>
                  {tenX && <div className="auditor-note">当前为 10× 对决。退出对决后，审计会使用 111,000 个完整贴面高斯。</div>}
                  <div className="audit-claims">
                    {auditClaims.map((c) => {
                      const r = c.result;
                      const delta = r ? Math.abs(c.claimed - r.distance) : null;
                      const cls = c.status === 'verified' ? 'verified' : c.status === 'hallucination' ? 'caught' : 'pending';
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={'audit-claim ' + cls}
                          disabled={!r || tenX}
                          onClick={() => focusAuditClaim(c)}
                        >
                          <span className="audit-claim-top"><b>{c.title}</b><em>{!r ? 'PENDING' : c.status === 'verified' ? 'VERIFIED' : 'HALLUCINATION CAUGHT'}</em></span>
                          <span className="audit-claim-text">{c.claim}</span>
                          {r && (
                            <span className="audit-claim-result">
                              3DGS 实测 {r.distance.toFixed(2)} mm · Δ {delta!.toFixed(2)} mm<br />
                              证据绑定句：FDI #{c.tooth} → L4 最小贴面中心距 = {r.distance.toFixed(2)} mm（源体素约 0.3 mm；非根尖表面距离，不构成临床诊断）。
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <input
                type="search"
                className="finding-search"
                placeholder="筛选牙位号或发现 (如 38, 46, IAN)…"
                value={findingFilter}
                onChange={(e) => setFindingFilter(e.target.value)}
              />

              <div className="sec-head">
                <span>EVIDENCE-LINKED FINDINGS ({filteredFindings.length})</span>
              </div>

              <div className="finding-list">
                {filteredFindings.map((f) => {
                  const isOpen = activeFindingId === f.id || (selected > 0 && f.fdi === selected && !activeFindingId);
                  return (
                    <div
                      key={f.id}
                      className={'finding-card ' + f.status + (isOpen ? ' open' : '')}
                      onClick={() => { setActiveFindingId(f.id); f.action(); }}
                    >
                      <div className="fc-row">
                        <span className="fc-fdi">{f.fdi || '—'}</span>
                        <div className="fc-text">
                          <b>{f.title}</b>
                          <small>{f.subtitle}</small>
                        </div>
                        <span className="fc-metric">{f.metric}</span>
                      </div>
                      {isOpen && <p className="fc-evidence">{f.evidence}</p>}
                    </div>
                  );
                })}
              </div>

              {selected > 0 && fdiInfo && (
                <div className="tooth-detail-box">
                  <div className="sec-head"><span>SELECTED TOOTH · FDI #{selected}</span></div>
                  <dl className="kv-mini">
                    <dt>Quadrant</dt><dd>{fdiInfo.arch} · {fdiInfo.side} · #{fdiInfo.pos}</dd>
                    <dt>Centroid</dt><dd>{fdiInfo.coords ? `${fdiInfo.coords.map((n) => n.toFixed(1)).join(', ')} mm` : '—'}</dd>
                  </dl>
                </div>
              )}

              <label className="insp-toggle-row">
                <span>Show/hide lesion overlay</span>
                <input type="checkbox" checked={showLesions} onChange={(e) => setShowLesions(e.target.checked)} />
              </label>
            </div>

            <div className={'insp-pane' + (railTab === 'layers' ? ' active' : '')}>
              <div className="sec-head"><span>ANATOMICAL LAYERS (uLayerAlpha)</span></div>
              {!isLocal && spec.cohort === 'cbct' && (
                <div className="quick-row">
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.95, 4: 1, 7: 0.12 }))}>透视牙根+神经管</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.85, 1: 1, 4: 1, 7: 0.35 }))}>实心骨表面</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0, 1: 0.35, 4: 1, 7: 0 }))}>仅突出神经管</button>
                </div>
              )}
              {displayLayers.map((l) => (
                <div className="ctrl-item" key={l.id}>
                  <div className="ctrl-label">
                    <span><i className="color-sq" style={{ background: l.color }} />{l.cn}</span>
                    <b>{Math.round(alphaOf(l.id) * 100)}%</b>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.01} value={alphaOf(l.id)}
                    onChange={(e) => setAlphas((a) => ({ ...a, [l.id]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <div className="ctrl-item">
                <div className="ctrl-label"><span>全局不透明度</span><b>{Math.round(opacity * 100)}%</b></div>
                <input type="range" min={0.25} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              </div>
            </div>

            <div className={'insp-pane' + (railTab === 'slice' ? ' active' : '')}>
              <div className="sec-head"><span>SHADER-LEVEL CLIPPING PLANE</span></div>
              <div className="quick-row">
                {([['x', '冠状 X'], ['y', '水平 Y'], ['z', '矢状 Z'], [null, '关闭']] as [ClipAxis, string][]).map(([a, nm]) => (
                  <button
                    key={String(a)}
                    type="button"
                    className={'tbar-btn' + (clipAxis === a ? ' on' : '')}
                    onClick={() => { setClipAxis(a); if (a && clipAxis !== a) setClipOffset(0); }}
                  >
                    {nm}
                  </button>
                ))}
                <button type="button" className={'tbar-btn' + (flip ? ' on' : '')} onClick={() => setFlip((f) => !f)}>反向</button>
              </div>
              <div className="ctrl-item">
                <div className="ctrl-label"><span>切面偏移</span><b>{clipOffset.toFixed(1)} mm</b></div>
                <input type="range" min={clipRange[0]} max={clipRange[1]} step={0.5} value={clipOffset} disabled={!clipAxis} onChange={(e) => setClipOffset(Number(e.target.value))} />
              </div>
              <div className="ctrl-item">
                <div className="ctrl-label"><span>断面封顶带宽 (Cap)</span><b>{clipBand.toFixed(2)} mm</b></div>
                <input type="range" min={0} max={4} step={0.05} value={clipBand} disabled={!clipAxis} onChange={(e) => setClipBand(Number(e.target.value))} />
              </div>
              <label className="insp-toggle-row">
                <span>断面实体化封顶 (Section Cap)</span>
                <input type="checkbox" checked={cap} onChange={(e) => setCap(e.target.checked)} />
              </label>

              {!isLocal && spec.hasJaw && (
                <>
                  <div className="sec-head" style={{ marginTop: 10 }}><span>MANDIBULAR HINGE MOTION</span></div>
                  <div className="ctrl-item">
                    <div className="ctrl-label"><span>下颌开口度 (髁突铰链)</span><b>{jaw.toFixed(0)} mm</b></div>
                    <input type="range" min={0} max={45} step={1} value={jaw} onChange={(e) => setJaw(Number(e.target.value))} />
                  </div>
                </>
              )}
            </div>

            <div className={'insp-pane' + (railTab === 'audit' ? ' active' : '')}>
              <div className="sec-head"><span>COMPRESSION &amp; FIDELITY BENCHMARK</span></div>
              <dl className="kv-mini">
                <dt>{tenX ? 'uniform' : 'full'}</dt>
                <dd>{report ? `${fmtInt(report.full.splats)} splats · ${fmtMB(report.full.bytes)} MB · SH${report.full.sh_degree}` : '—'}</dd>
                <dt>{tenX ? 'anatomy' : 'pruned'}</dt>
                <dd>{report ? `${fmtInt(report.pruned.splats)} splats · ${fmtMB(report.pruned.bytes)} MB · SH${report.pruned.sh_degree}` : '—'}</dd>
                <dt>ratio</dt>
                <dd>{tenX ? '1.00× · equal bytes' : ratio ? `${ratio.toFixed(2)}× smaller` : '—'}</dd>
                <dt>coverage gap</dt>
                <dd>
                  {report && report.compression_fidelity_mm.coverage_gap_mean != null
                    ? `${report.compression_fidelity_mm.coverage_gap_mean} mm mean · p95 ${report.compression_fidelity_mm.coverage_gap_p95} mm`
                    : 'TBD'}
                </dd>
                <dt>live PSNR</dt>
                <dd>{bench ? `${bench.psnr} dB · 掩膜内 ${bench.psnrInMask} dB · MAE ${bench.mae}` : '—'}</dd>
              </dl>

              {tenX && ablation && (
                <div className="ablation-stats">
                  <div><b>UNIFORM 10×</b><span>L4 800 · L1 6,500 · L3 3,000 · L7 800</span></div>
                  <div><b>ANATOMY-AWARE 10×</b><span>L4 3,000 · L1 7,200 · L3 650 · L7 250</span></div>
                  <small>L1/L4 均反超 Uniform；L3+L7 合计 900。切向尺度按各层 √k 补偿，法向厚度不变。</small>
                </div>
              )}

              {tenX && compressionBench && (
                <div className="compression-bench">
                  <div className="cb-head"><b>FULL-REFERENCE BENCH</b><span>{compressionBench.views.join(' / ')} · {compressionBench.size}²</span></div>
                  {compressionBench.candidates.map((c) => (
                    <div className="cb-row" key={c.name}>
                      <b>{c.name}</b>
                      <span>Overall {c.overall.psnr} dB · MAE {c.overall.mae}</span>
                      <span>L1 {c.layers[1]?.psnr ?? '—'} dB · L4 {c.layers[4]?.psnr ?? '—'} dB</span>
                      <span>L3 {c.layers[3]?.psnr ?? '—'} dB · L7 {c.layers[7]?.psnr ?? '—'} dB</span>
                      <span>FDI48–L4 {c.clearance_mm?.toFixed(3) ?? '—'} mm · Δ {c.clearance_delta_mm?.toFixed(3) ?? '—'} mm</span>
                    </div>
                  ))}
                  <small>Full 参考 FDI48–L4 = {compressionBench.referenceClearance?.toFixed(3) ?? '—'} mm。所有 PSNR/MAE 均为同一 Full 参考、固定视角与单层隔离渲染；clearance 仍是贴面中心几何量。</small>
                </div>
              )}

              <div className="quick-row">
                <button type="button" className="tbar-btn primary" onClick={runBench} disabled={benching || !report}>
                  {benching ? '回读像素中…' : tenX ? '各自对照 Full 复算' : '跑一次 bench(384²)'}
                </button>
                <button type="button" className={'tbar-btn' + (split ? ' on' : '')} disabled={tenX} onClick={() => setSplit((s) => !s)}>
                  同帧分屏
                </button>
              </div>

              <div className="sec-head" style={{ marginTop: 10 }}><span>VERIFIABLE CONTRACTS</span></div>
              <div className="audit-stack">
                {AUDIT_BASIS.map((a) => (
                  <div className="audit-row" key={a.k}>
                    <div><b>{a.k}</b><span>{a.en}</span></div>
                    <p>{a.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className={'insp-pane' + (railTab === 'source' ? ' active' : '')}>
              <div className="sec-head"><span>DATASET PROVENANCE</span></div>
              <dl className="kv-mini">
                <dt>{isLocal ? 'File' : 'Dataset'}</dt><dd>{isLocal ? customAssetName : spec.dataset}</dd>
                <dt>License</dt><dd>{isLocal ? 'Local file · not asserted' : spec.license}</dd>
                <dt>Proxy</dt>
                <dd>{isLocal ? 'None · splat-only picking' : report?.proxy?.triangles != null && report.proxy.kb != null ? `${(report.proxy.triangles / 1000).toFixed(1)}k tri · ${report.proxy.kb.toFixed(0)} KB` : '—'}</dd>
              </dl>
              <p className="source-note">{isTimeline
                ? `真实 Brush 重训 checkpoint · step ${timelineStep ?? '—'}。该独立重训用于展示训练过程；checkpoint 没有 FDI/层标签，也不继承已发布 Case 01 的 proxy 或报告。`
                : isPlyLocal
                  ? 'FP32 PLY 本地预览：位置、尺度、旋转、颜色与不透明度直接来自 PLY 浮点字段，不经过 DSPK 8-bit 量化，也不继承牙位/解剖语义。'
                  : isLocal
                    ? '独立本地预览：只使用 DSPK 内嵌几何与语义，不继承原病例 proxy、牙位元数据、MPR 或报告。单牙功能按文件实际 FDI 内容开放。'
                    : spec.blurb}</p>
              <button type="button" className="tbar-btn primary" onClick={() => fileInputRef.current?.click()}>
                选择本地 .ply / .dspk 进入 Lab
              </button>
              <button type="button" className="tbar-btn" onClick={loadSamplePly}>加载示例 FP32 PLY（Case 05, Brush）</button>
              <p className="source-note">支持 binary/ascii 3DGS <code>.ply</code> 与量化 <code>.dspk</code>；文件仅在浏览器内存解码，不上传服务器。PLY 坐标架不做隐式重定向，若旋转异常请先核对训练器导出坐标。</p>
            </div>
          </div>
        </aside>
      </div>

      <footer className="dtx-statusbar">
        <span>Drag: Orbit · Right-Drag: Pan · Scroll: Zoom · Double-Click: Focus · R: Reset</span>
        <span className="dtx-spacer" />
        <span>Sort {stats.sortMs.toFixed(2)} ms · Custom WebGL2 EWA Engine · Zero Third-Party Viewer</span>
      </footer>
    </div>
  );
}
