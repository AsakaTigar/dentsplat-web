import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type * as THREE from 'three';
import { DentSplatViewer } from './engine/Viewer.ts';
import type { AlphaComposition, BenchResult, ClearanceAudit, ClipAxis, CompressionBenchResult, LabInfo, LabMode, PickerHit, ProbeResult, Stats, ViewPreset } from './engine/Viewer.ts';
import { gaussianPdfAt, isosurfaceAmplitude, type GaussianInspect, type Vec3 } from './engine/gaussian.ts';
import { parseGaussianPly } from './engine/ply.ts';
import { CASES, AUDIT_BASIS, LESION_LABEL } from './data/cases.ts';
import type { CaseSpec, CaseCohort, LayerSpec } from './data/cases.ts';
import { LAYER_RGB } from './engine/dspk.ts';
import Odontogram from './ui/Odontogram.tsx';
import MprQuadView from './ui/MprQuadView.tsx';
import GaussianPlot, { GaussianDensityPlot, ProjectionPlot, ShAppearancePlot } from './ui/GaussianPlot.tsx';
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
  training?: {
    method: string;
    split: { protocol: string; train_images: number; test_images: number };
    steps: number[];
    curve: {
      step: number; source_step: number; train_loss: number | null;
      test_psnr: number; test_ssim: number; test_lpips: number;
      num_gaussians: number; train_sec: number;
    }[];
    final_test_psnr: number; final_test_ssim: number; final_test_lpips: number;
    train_sec: number; num_gaussians: number;
  };
};
type GeometryAudit = {
  source_mesh: { triangles: number; vertices: number; sample_note: string };
  methods: { brush_3dgs: GeometryMethod; surface_sampling: GeometryMethod; gsplat_3dgs?: GeometryMethod; surfel_2dgs?: GeometryMethod };
  training_curves?: Record<string, NonNullable<GeometryMethod['training']>>;
  timeline?: {
    step: number; count: number;
    cloud_to_mesh: { mean_mm: number; p95_mm: number };
    fscore: { precision: number; recall: number };
    normal_abs_dot: { mean: number } | null;
  }[];
  caveat: string;
};

type VectorHudItem = { kind: 'measure' | 'audit'; a: [number, number]; b: [number, number]; label: string; color: string };

function VectorHudOverlay({ viewerRef }: { viewerRef: RefObject<DentSplatViewer | null> }) {
  const [items, setItems] = useState<VectorHudItem[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    let raf = 0, last = 0;
    const tick = (t: number) => {
      if (t - last > 45) {
        last = t;
        setItems(viewerRef.current?.getVectorHud() ?? []);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewerRef]);
  return (
    <svg ref={svgRef} className="vector-hud" aria-hidden="true">
      {items.map((h, i) => {
        const mx = (h.a[0] + h.b[0]) / 2, my = (h.a[1] + h.b[1]) / 2;
        const lx = Math.max(54, Math.min(mx + 34, (svgRef.current?.clientWidth ?? 800) - 54));
        const ly = Math.max(42, Math.min(my - 26, (svgRef.current?.clientHeight ?? 600) - 42));
        return (
          <g key={`${h.kind}-${i}`} className="vector-hud-item">
            <line x1={h.a[0]} y1={h.a[1]} x2={h.b[0]} y2={h.b[1]} stroke={h.color} strokeWidth="1.5" />
            <line x1={mx} y1={my} x2={lx} y2={ly} stroke={h.color} strokeWidth="1" opacity=".75" />
            <circle cx={h.a[0]} cy={h.a[1]} r="3.5" fill="none" stroke={h.color} strokeWidth="1.5" />
            <circle cx={h.b[0]} cy={h.b[1]} r="3.5" fill="none" stroke={h.color} strokeWidth="1.5" />
            <rect x={lx - 42} y={ly - 13} width="84" height="26" rx="8" className="vector-hud-pill" />
            <text x={lx} y={ly + 4} textAnchor="middle" fill="#eaf6fb">{h.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function ViewportGuides({ viewerRef, visible }: { viewerRef: RefObject<DentSplatViewer | null>; visible: boolean }) {
  const [guide, setGuide] = useState<{ axes: { label: string; x: number; y: number }[]; scalePx: number }>({ axes: [], scalePx: 60 });
  useEffect(() => {
    if (!visible) return;
    let raf = 0, last = 0;
    const tick = (t: number) => {
      if (t - last > 45) { last = t; setGuide(viewerRef.current?.getViewportGuide() ?? { axes: [], scalePx: 60 }); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewerRef, visible]);
  if (!visible) return null;
  const axisClass = (label: string) => label === 'L' || label === 'R' ? 'axis-x' : label === 'S' || label === 'I' ? 'axis-y' : 'axis-z';
  return (
    <div className="viewport-guides" aria-hidden="true">
      <div className="physical-scale" style={{ '--scale-width': `${guide.scalePx}px` } as React.CSSProperties}><span>10 mm</span><i /></div>
      <svg className="orientation-gizmo" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="27" />
        {guide.axes.map((a) => <line key={a.label} x1="36" y1="36" x2={a.x} y2={a.y} className={axisClass(a.label)} />)}
        {guide.axes.map((a) => <text key={a.label} x={a.x} y={a.y}>{a.label}</text>)}
      </svg>
    </div>
  );
}

function SplitWipe({ viewerRef, ratio, onRatio }: { viewerRef: RefObject<DentSplatViewer | null>; ratio: number; onRatio: (v: number) => void }) {
  const drag = useRef(false);
  useEffect(() => { if (viewerRef.current) viewerRef.current.splitRatio = ratio; }, [ratio, viewerRef]);
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    onRatio(Math.max(0.1, Math.min(0.9, (e.clientX - r.left) / r.width)));
  };
  return (
    <div className="split-wipe" onPointerMove={move} onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}>
      <div className="split-wipe-line" style={{ left: `${ratio * 100}%` }} />
      <button
        type="button"
        className="split-wipe-handle"
        style={{ left: `${ratio * 100}%` }}
        aria-label="Drag to adjust split ratio"
        onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
      >◂ ▸</button>
    </div>
  );
}

type TimelineStep = {
  step: number; file: string; bytes: number; splats: number; sha256: string;
  source_ply: string; psnr_db: number | null; loss: number | null;
  sh_degree?: number; kind?: string; note?: string;
};
type TimelineManifest = {
  schema: string; case: string;
  training: { tool: string; views: number; steps: number; sh_degree: number; export_every: number; independent_rerun: boolean; note: string };
  metrics_note: string;
  steps: TimelineStep[];
};
type DiskBaseline = {
  schema: string; file: string; bytes: number; splats: number;
  tangent_sigma_mm: number; normal_sigma_mm: number; note: string;
};

type RailTab = 'findings' | 'lab' | 'methods' | 'recon' | 'layers' | 'slice' | 'audit' | 'source';

const LAB_MODES: { id: LabMode; label: string; note: string }[] = [
  { id: 'rgb', label: 'RGB', note: 'Final EWA Gaussian rasterisation' },
  { id: 'ellipsoid', label: 'Ellipsoids', note: 'True-covariance 1σ surfaces' },
  { id: 'centers', label: 'Centers', note: 'Gaussian center point cloud' },
  { id: 'wire', label: 'Wireframe', note: '1σ ellipsoid wireframes' },
  { id: 'opacity', label: 'Opacity', note: 'Per-Gaussian opacity map' },
  { id: 'scale', label: 'Scale', note: 'Per-Gaussian scale map' },
  { id: 'normal', label: 'Normal', note: 'Approximate normals from ellipsoid minor axes' },
  { id: 'depth', label: 'Depth', note: 'Camera-space depth map' },
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
  { id: 'all', label: 'All 10 cases' },
  { id: 'ios', label: 'IOS 3DGS' },
  { id: 'cbct', label: 'CBCT surfels' },
];

const LOCAL_LAYER_NAMES: Record<number, string> = {
  0: 'Gingiva / Background', 1: 'Teeth / Enamel', 2: 'Roots / Dentine', 3: 'Alveolar Bone',
  4: 'IAN Canal', 5: 'Other Tissue', 6: 'Pulp', 7: 'Maxillary Sinus', 8: 'Restoration',
};

// Deliberately simulated VLM prose. The numeric verdict is never read from this table: it is
// recomputed from the loaded 3DGS centres at click time.
const AUDIT_CLAIMS: AuditClaim[] = [
  {
    id: 'vlm-38', tooth: 38, layer: 4, title: 'Mandibular left third molar / IAN',
    claim: 'Simulated VLM: #38 root apex–to–IAN canal minimum center distance ≈ 0.06 mm.', claimed: 0.06,
  },
  {
    id: 'vlm-48-true', tooth: 48, layer: 4, title: 'Mandibular right third molar / IAN',
    claim: 'Simulated VLM: #48 root apex–to–IAN canal minimum center distance ≈ 0.18 mm.', claimed: 0.18,
  },
  {
    id: 'vlm-48-hallucination', tooth: 48, layer: 4, title: 'Mandibular right third molar / hallucination check',
    claim: 'Simulated VLM: The #48 root apex is only 1.10 mm from the canal, implying an extremely high risk of nerve injury.', claimed: 1.10,
  },
];

function parseFdiInfo(fdi: number, raw?: ToothMeta) {
  if (!fdi) return null;
  const q = Math.floor(fdi / 10);
  const pos = raw?.pos ?? (fdi % 10);
  const arch = raw?.arch === 'lower' ? 'Lower' : raw?.arch === 'upper' ? 'Upper' : raw?.arch ?? (q === 1 || q === 2 ? 'Upper' : 'Lower');
  const side = raw?.side ?? (q === 1 || q === 4 ? 'Right' : 'Left');
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
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [workMode, setWorkMode] = useState<'clinic' | 'research'>('clinic');
  const [clinicWorkflow, setClinicWorkflow] = useState<'3d' | 'mpr' | 'measure' | 'verify'>('3d');
  const [caseMenuOpen, setCaseMenuOpen] = useState(false);
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
  const isDiskMethod = customAssetName === 'method:disks';
  const gaussUnit = isPlyLocal ? 'PLY u' : 'mm';
  const [labMode, setLabMode] = useState<LabMode>('rgb');
  const [labSigma, setLabSigma] = useState<1 | 2 | 3>(1);
  const [labInfo, setLabInfo] = useState<LabInfo | null>(null);
  const [gaussian, setGaussian] = useState<GaussianInspect | null>(null);
  const [gaussOriginal, setGaussOriginal] = useState<GaussianInspect | null>(null);
  const [gaussIndexInput, setGaussIndexInput] = useState('0');
  const [alphaMix, setAlphaMix] = useState<AlphaComposition | null>(null);
  const [gaussIsolate, setGaussIsolate] = useState(false);
  const [plyNote, setPlyNote] = useState<string | null>(null);

  // 10-case cohort selector (right inspector)
  const [cohort, setCohort] = useState<'all' | CaseCohort>('all');
  const [pickerOpen, setPickerOpen] = useState(true);
  const [caseQuery, setCaseQuery] = useState('');
  const [allScenes, setAllScenes] = useState<Record<string, SceneReport>>({});
  const [geometryAudit, setGeometryAudit] = useState<GeometryAudit | null>(null);
  const [timeline, setTimeline] = useState<TimelineManifest | null>(null);
  const [diskBaseline, setDiskBaseline] = useState<DiskBaseline | null>(null);
  const [timelineStep, setTimelineStep] = useState<number | null>(null);
  const [timelineCompare, setTimelineCompare] = useState(false);
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [timelinePlay, setTimelinePlay] = useState(false);
  const [quadMode, setQuadMode] = useState(false);
  const [quadItems, setQuadItems] = useState<{ name: string; splats: number; bytes: number }[]>([]);
  const isQuad = quadMode;

  const switchCase = useCallback((id: string) => {
    setQuadMode(false);
    setQuadItems([]);
    viewerRef.current?.clearQuadCompare();
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
    setTimelinePlay(false);
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
        setAlphaMix(null);
        return;
      }
      const info = v.selectGaussian(index);
      setGaussian(info);
      setGaussOriginal(info);
      setGaussIndexInput(String(index));
      setAlphaMix(null);
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
      editGaussianColor: (index: number, color: Vec3) => v.setGaussianColor(index, color),
      editGaussianRotation: (index: number, quat: [number, number, number, number]) => v.setGaussianRotation(index, quat),
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
        const [rep, mf, cov] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/report.json`).then((r) => r.json()),
          fetch(spec.metaUrl).then((r) => r.json()),
          fetch(`${import.meta.env.BASE_URL}assets/compression_coverage.json`).then((r) => r.json()),
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
            proxy: source.proxy,
            compression_fidelity_mm: {
              coverage_gap_mean: cov.uniform.mean_mm,
              coverage_gap_p95: cov.uniform.p95_mm,
              uniform_coverage_gap_mean: cov.uniform.mean_mm,
              uniform_coverage_gap_p95: cov.uniform.p95_mm,
              anatomy_coverage_gap_mean: cov.anatomy.mean_mm,
              anatomy_coverage_gap_p95: cov.anatomy.p95_mm,
              definition: cov.definition,
            },
            metrics: source.metrics ?? {},
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
        const preset = want ?? spec.presets[0];
        const viewPreset = useTenX ? { ...preset, radius: Math.max(190, preset.radius) } : preset;
        setActivePreset(preset.id);
        v.flyTo(viewPreset);
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
        setGaussian(null); setGaussOriginal(null); setGaussIsolate(false); setPlyNote(null); setTimelineStep(null); setTimelineCompare(false); setTimelinePlay(false);
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
    if (!quadMode || railTab === 'methods') return;
    viewerRef.current?.clearQuadCompare();
    setQuadMode(false); setQuadItems([]);
    switchCase('A2');
  }, [quadMode, railTab, switchCase]);

  useEffect(() => {
    let dead = false;
    fetch(`${import.meta.env.BASE_URL}assets/geometry_metrics.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (!dead && (x?.schema === 'dentsplat-geometry-audit-v1' || x?.schema === 'dentsplat-geometry-audit-v2')) setGeometryAudit(x as GeometryAudit); })
      .catch(() => {});
    fetch(`${import.meta.env.BASE_URL}assets/timeline/timeline.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (!dead && x?.schema === 'dentsplat-timeline-v1') setTimeline(x as TimelineManifest); })
      .catch(() => {});
    fetch(`${import.meta.env.BASE_URL}assets/sceneA_disks.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (!dead && x?.schema === 'dentsplat-representation-baseline-v1') setDiskBaseline(x as DiskBaseline); })
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
    // Four-way comparison uses the local-asset guard to protect its render loop,
    // but it must still be able to transition back into the packaged Case B ablation.
    if (isLocal && customAssetName !== 'quad:4') return;
    setQuadMode(false); setQuadItems([]); viewerRef.current?.clearQuadCompare();
    setCustomAssetName(null);
    setLabMode('rgb'); setMethodCompare(false); setGaussian(null); setGaussOriginal(null); setGaussIsolate(false);
    viewerRef.current?.clearGaussianSelection();
    if (caseId !== 'B') {
      switchCase('B');
      setTenX(true); setSplit(true); setVariant('full'); setBench(null); setCompressionBench(null);
      return;
    }
    const next = !tenX;
    if (next) { setMprOn(false); history.replaceState(null, '', '#B'); }
    setTenX(next); setSplit(next); setVariant('full'); setBench(null); setCompressionBench(null);
    setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
    viewerRef.current?.clearAudit();
  }, [caseId, customAssetName, isLocal, switchCase, tenX]);

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
      setGaussian(null); setGaussOriginal(null); setGaussIsolate(false); setPlyNote(null); setTimelineStep(null); setTimelineCompare(false); setTimelinePlay(false);
      setAuditClaims(AUDIT_CLAIMS.map((c) => ({ ...c, status: 'pending' as const })));
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      const head = new DataView(await file.arrayBuffer());
      if (head.getUint32(0, true) !== 0x4b505344) throw new Error('Not a valid DSPK file');
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
      setErr(`Local DSPK load failed: ${String(e)}`);
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
      setPlyNote(`${info.gaussianFields ? 'FP32 3DGS PLY' : 'Point PLY'} · ${info.format} · SH${info.shDegree} · ${info.fields.length} fields · no FDI/anatomical semantics`);
      setCustomAssetName(file.name);
      setLabMode('centers');
      setRailTab('lab');
      setInspectorOpen(true);
      history.replaceState(null, '', '#LOCAL');
      setLoading(false);
    } catch (e) {
      setErr(`Local PLY load failed: ${String(e)}`);
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
      setErr(`Sample PLY load failed: ${String(e)}`);
      setLoading(false);
    }
  }, [loadLocalPly]);

  const loadDiskBaseline = useCallback(async () => {
    const v = viewerRef.current;
    if (!v || !diskBaseline) return;
    setLoading(true); setErr(null);
    setTenX(false); setSplit(false); setMprOn(false); setVariant('full'); setBench(null); setCompressionBench(null);
    setMethodCompare(false); setTimelineStep(null); setTimelineCompare(false); setTimelinePlay(false);
    setGaussian(null); setGaussOriginal(null); setGaussIsolate(false); setAlphaMix(null);
    v.clearGaussianSelection();
    try {
      const url = `${import.meta.env.BASE_URL}assets/${diskBaseline.file}`;
      v.caseId = 'DISKS';
      await v.loadCase({ fullUrl: url, prunedUrl: url, proxyUrl: null, fullBytes: diskBaseline.bytes, prunedBytes: diskBaseline.bytes });
      const cloud = v.layer?.cloud;
      const layerCounts: Record<number, number> = {};
      const sums: Record<number, [number, number, number, number]> = {};
      for (let i = 0; i < (cloud?.count ?? 0); i++) {
        const f = cloud!.misc[i * 4 + 1], ly = cloud!.misc[i * 4 + 2];
        layerCounts[ly] = (layerCounts[ly] ?? 0) + 1;
        if (!f) continue;
        const s = sums[f] ?? (sums[f] = [0, 0, 0, 0]);
        s[0] += v.layer!.centers[i * 3]; s[1] += v.layer!.centers[i * 3 + 1]; s[2] += v.layer!.centers[i * 3 + 2]; s[3]++;
      }
      const teeth: Record<string, ToothMeta> = {};
      for (const [fs, s] of Object.entries(sums)) {
        const f = Number(fs);
        const q = Math.floor(f / 10);
        teeth[`FDI_${f}`] = { fdi: f, arch: f < 30 ? 'upper' : 'lower', side: q === 1 || q === 4 ? 'Right' : 'Left', pos: f % 10, at: [s[0] / s[3], s[1] / s[3], s[2] / s[3]], centroid_mm: [s[0] / s[3], s[1] / s[3], s[2] / s[3]] };
      }
      setReport({
        full: { splats: diskBaseline.splats, bytes: diskBaseline.bytes, mb: +(diskBaseline.bytes / 1048576).toFixed(2), sh_degree: 0, bytes_per_splat: 20 },
        pruned: { splats: diskBaseline.splats, bytes: diskBaseline.bytes, mb: +(diskBaseline.bytes / 1048576).toFixed(2), sh_degree: 0, bytes_per_splat: 20 },
        bytes_ratio: 1, proxy: { bytes: 0, kb: 0, nodes: 0, triangles: 0 }, compression_fidelity_mm: {}, metrics: {},
      });
      setMeta({ unit: 'mm', kind: 'disks', teeth, metrics: {}, bbox_min: cloud ? [...cloud.bboxMin] : undefined, bbox_max: cloud ? [...cloud.bboxMax] : undefined });
      setLocalLayerIds(Object.keys(layerCounts).map(Number).sort((a, b) => a - b));
      setAlphas(Object.fromEntries(Object.keys(layerCounts).map((k) => [Number(k), 1])));
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      setCustomAssetName('method:disks');
      setRailTab('methods'); setInspectorOpen(true); setPickerOpen(false);
      setLabMode('rgb');
      history.replaceState(null, '', '#METHODS');
      setLoading(false);
    } catch (e) {
      setErr(`Disk baseline load failed: ${String(e)}`);
      setLoading(false);
    }
  }, [diskBaseline]);

  const loadMethodDspk = useCallback(async (method: 'gsplat' | '2dgs') => {
    const v = viewerRef.current;
    if (!v) return;
    const spec = method === 'gsplat'
      ? { file: 'sceneA_gsplat_web.dspk', bytes: 1600829, splats: 80000, label: 'gsplat 3DGS' }
      : { file: 'sceneA_2dgs_web.dspk', bytes: 484775, splats: 24198, label: '2DGS' };
    setLoading(true); setErr(null);
    setQuadMode(false); setQuadItems([]); v.clearQuadCompare();
    setTenX(false); setSplit(false); setMprOn(false); setMethodCompare(false); setVariant('full');
    setBench(null); setCompressionBench(null);
    setTimelineStep(null); setTimelineCompare(false); setTimelinePlay(false);
    setGaussian(null); setGaussOriginal(null); setAlphaMix(null);
    v.clearGaussianSelection();
    try {
      const url = `${import.meta.env.BASE_URL}assets/${spec.file}`;
      v.caseId = method === 'gsplat' ? 'METHOD_3DGS' : 'METHOD_2DGS';
      await v.loadCase({ fullUrl: url, prunedUrl: url, proxyUrl: null, fullBytes: spec.bytes, prunedBytes: spec.bytes });
      const cloud = v.layer?.cloud;
      const layerCounts: Record<number, number> = {};
      const sums: Record<number, [number, number, number, number]> = {};
      for (let i = 0; i < (cloud?.count ?? 0); i++) {
        const f = cloud!.misc[i * 4 + 1], ly = cloud!.misc[i * 4 + 2];
        layerCounts[ly] = (layerCounts[ly] ?? 0) + 1;
        if (!f) continue;
        const s = sums[f] ?? (sums[f] = [0, 0, 0, 0]);
        s[0] += v.layer!.centers[i * 3]; s[1] += v.layer!.centers[i * 3 + 1]; s[2] += v.layer!.centers[i * 3 + 2]; s[3]++;
      }
      const teeth: Record<string, ToothMeta> = {};
      for (const [fs, s] of Object.entries(sums)) {
        const f = Number(fs), q = Math.floor(f / 10);
        teeth[`FDI_${f}`] = { fdi: f, arch: f < 30 ? 'upper' : 'lower', side: q === 1 || q === 4 ? 'Right' : 'Left', pos: f % 10, at: [s[0] / s[3], s[1] / s[3], s[2] / s[3]], centroid_mm: [s[0] / s[3], s[1] / s[3], s[2] / s[3]] };
      }
      setReport({
        full: { splats: spec.splats, bytes: spec.bytes, mb: +(spec.bytes / 1048576).toFixed(2), sh_degree: 0, bytes_per_splat: 20 },
        pruned: { splats: spec.splats, bytes: spec.bytes, mb: +(spec.bytes / 1048576).toFixed(2), sh_degree: 0, bytes_per_splat: 20 },
        bytes_ratio: 1, proxy: { bytes: 0, kb: 0, nodes: 0, triangles: 0 }, compression_fidelity_mm: {}, metrics: {},
      });
      setMeta({ unit: 'mm', kind: `method:${method}`, teeth, metrics: {}, bbox_min: cloud ? [...cloud.bboxMin] : undefined, bbox_max: cloud ? [...cloud.bboxMax] : undefined });
      setLocalLayerIds(Object.keys(layerCounts).map(Number).sort((a, b) => a - b));
      setAlphas(Object.fromEntries(Object.keys(layerCounts).map((k) => [Number(k), 1])));
      setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null); setActiveFindingId(null);
      setCustomAssetName(`method:${method}`);
      setRailTab('methods'); setInspectorOpen(true); setPickerOpen(false);
      setLabMode('rgb');
      history.replaceState(null, '', `#METHOD_${method.toUpperCase()}`);
      setLoading(false);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') { setLoading(false); return; }
      setErr(`Failed to load ${spec.label}: ${String(e)}`);
      setLoading(false);
    }
  }, []);

  const startQuadCompare = useCallback(async () => {
    const v = viewerRef.current;
    if (!v) return;
    const a2 = CASES.find((c) => c.id === 'A2'), a = CASES.find((c) => c.id === 'A');
    if (!a2 || !a) return;
    setLoading(true); setErr(null);
    setQuadMode(false); setQuadItems([]);
    setTenX(false); setSplit(false); setMprOn(false); setMethodCompare(false);
    setTimelineStep(null); setTimelineCompare(false); setTimelinePlay(false);
    setGaussian(null); setGaussOriginal(null); setAlphaMix(null);
    v.clearGaussianSelection();
    try {
      v.caseId = 'QUAD';
      const items = await v.loadQuadComparison([
        { name: 'gsplat 3DGS', url: `${import.meta.env.BASE_URL}assets/sceneA_gsplat_web.dspk`, bytes: 1600829 },
        { name: '2DGS', url: `${import.meta.env.BASE_URL}assets/sceneA_2dgs_web.dspk`, bytes: 484775 },
        { name: 'Brush 3DGS', url: a2.fullUrl, bytes: allScenes.sceneA_trained?.full.bytes ?? 832835 },
        { name: 'Surface Sampling', url: a.fullUrl, bytes: allScenes.sceneA_ios?.full.bytes ?? 1196970 },
      ]);
      if (!items) return;
      setQuadItems(items);
      setQuadMode(true);
      setCustomAssetName('quad:4');
      setMeta({ unit: 'mm', kind: 'quad', teeth: {}, metrics: {} });
      setReport(null);
      setAlphas({}); setLocalLayerIds([]); setSelected(0); setHidden([]); setIsolate(false); setMeasures([]); setProbe(null);
      setRailTab('methods'); setInspectorOpen(true); setPickerOpen(false);
      setLabMode('rgb');
      setLoading(false);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') { setLoading(false); return; }
      setErr(`Failed to load four-way comparison: ${String(e)}`);
      setLoading(false);
    }
  }, [allScenes]);

  const exitQuadCompare = useCallback(() => {
    viewerRef.current?.clearQuadCompare();
    setQuadMode(false); setQuadItems([]);
    switchCase('A2');
  }, [switchCase]);

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
        mb: +(step.bytes / 1048576).toFixed(2), sh_degree: step.sh_degree ?? 1,
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
      setErr(`Failed to load timeline checkpoint: ${String(e)}`);
      setLoading(false);
    } finally {
      setTimelineBusy(false);
    }
  }, [allScenes, timelineBusy, timelineCompare]);

  useEffect(() => {
    if (!timelinePlay) return;
    if (railTab !== 'recon' || !timeline) { setTimelinePlay(false); return; }
    if (timelineBusy) return;
    const idx = timeline.steps.findIndex((s) => s.step === timelineStep);
    const next = idx < 0 ? timeline.steps[0] : timeline.steps[idx + 1];
    if (!next) { setTimelinePlay(false); return; }
    const timer = window.setTimeout(() => { void loadTimelineStep(next); }, 1200);
    return () => window.clearTimeout(timer);
  }, [timelinePlay, timeline, timelineStep, timelineBusy, railTab, loadTimelineStep]);

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

  const selectGaussianByIndex = useCallback((rawIndex: string) => {
    const v = viewerRef.current;
    const index = Number(rawIndex);
    if (!v || !Number.isInteger(index) || index < 0) return;
    const info = v.selectGaussian(index, { focus: true });
    if (!info) return;
    setGaussian(info);
    setGaussOriginal(info);
    setGaussIndexInput(String(index));
    setAlphaMix(null);
    setRailTab('lab');
    setInspectorOpen(true);
  }, []);

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

  const editGaussRotation = useCallback((axis: 0 | 1 | 2 | 3, value: number) => {
    const v = viewerRef.current;
    if (!v || !gaussian) return;
    const next = [...gaussian.quat] as [number, number, number, number];
    next[axis] = value;
    const info = v.setGaussianRotation(gaussian.index, next);
    if (info) setGaussian(info);
  }, [gaussian]);

  const editGaussColor = useCallback((axis: 0 | 1 | 2, value: number) => {
    const v = viewerRef.current;
    if (!v || !gaussian) return;
    const next = [...gaussian.color] as Vec3;
    next[axis] = value;
    const info = v.setGaussianColor(gaussian.index, next);
    if (info) setGaussian(info);
  }, [gaussian]);

  const resetGaussian = useCallback(() => {
    const v = viewerRef.current;
    if (!v || !gaussian || !gaussOriginal) return;
    v.setGaussianPosition(gaussian.index, gaussOriginal.center);
    v.setGaussianRotation(gaussian.index, gaussOriginal.quat);
    v.setGaussianScale(gaussian.index, gaussOriginal.scales);
    v.setGaussianColor(gaussian.index, gaussOriginal.color);
    const info = v.setGaussianOpacity(gaussian.index, gaussOriginal.alpha);
    if (info) setGaussian(info);
  }, [gaussian, gaussOriginal]);

  const shoot = useCallback((size?: number) => {
    const data = size ? viewerRef.current?.renderToDataURL(size) : viewerRef.current?.snapshot();
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = `dentsplat_${caseId}_${size ? `${size}px` : 'view'}_${Date.now()}.png`;
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
  // current case; anything not measured is shown as an em dash rather than filled with a placeholder.
  const findings = useMemo<EvidenceFinding[]>(() => {
    const list: EvidenceFinding[] = [];
    if (isLocal) {
      return [{
        id: 'local-preview', fdi: 0, title: 'Local DSPK Preview', subtitle: 'Independent preview · no prior case proxy or metadata',
        status: 'info', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
        evidence: 'Only Gaussians and embedded semantics from the file are loaded. Prior case proxies, tooth metadata, MPR, findings and measurements are cleared. Per-tooth picking is available only when FDI labels are present and visible.',
        action: () => setRailTab('source'),
      }];
    }
    if (caseId === 'B') {
      const ian = typeof report?.metrics?.ian_48_min_mm === 'number' ? report.metrics.ian_48_min_mm : null;
      list.push(
        {
          id: 'ian-38', fdi: 38, title: 'Mandibular Canal Proximity', subtitle: 'Spatial relationship of third molars 38/48 to the IAN canal',
          status: 'caution', metric: ian != null ? `IAN ${ian.toFixed(2)} mm` : 'IAN —',
          evidence: 'Measured directly from the 0.3 mm voxel segmentation of DentVoxel v4 case 0095 (not a diagnostic conclusion). Select to open canal transparency and a coronal section.',
          action: () => focusCanal(),
        },
        {
          id: 'surfel-budget', fdi: 46, title: 'Anatomy-Aware Surfel Budget', subtitle: 'Independent coding of alveolar bone, teeth/roots, nerve canal and maxillary sinus',
          status: 'verified', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
          evidence: 'Each of the four isosurfaces generates normal-aligned surfel Gaussians. Layer codes are stored in DSPK misc bytes; layer opacity is controlled in real time by uLayerAlpha.',
          action: () => { setSelected(46); viewerRef.current?.focusTooth(46); },
        },
        {
          id: 'sinus-floor', fdi: 16, title: 'Maxillary Sinus Floor Context', subtitle: 'Maxillary posterior root apices adjacent to the sinus floor',
          status: 'info', metric: 'Layer L7',
          evidence: 'The maxillary sinus (L7) and alveolar bone (L3) are coded independently. Reduce bone opacity to inspect the risk of maxillary molar root penetration into the sinus.',
          action: () => { setSelected(16); setAlphas((a) => ({ ...a, 3: 0.18, 7: 0.55 })); viewerRef.current?.focusTooth(16); },
        },
        {
          id: 'cbct-clip', fdi: 36, title: 'GLSL Section Cap Cross-Section', subtitle: 'Capped cross-sections through solid 3D Gaussians',
          status: 'verified', metric: 'GLSL Cap',
          evidence: 'Within a narrow band at the clipping plane, the vertex shader flattens Gaussians and recolours them by tissue layer, avoiding the hollow-shell artefact of mesh clipping.',
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
          id: 'ian-layer', fdi: canalTooth, title: 'IAN Canal Layer', subtitle: 'Spatial relationship of the IAN canal and posterior root apices',
          status: ian != null ? 'caution' : 'info',
          metric: ian != null ? `IAN ${ian.toFixed(2)} mm` : 'Layer L4',
          evidence: ian != null
            ? `${spec.dataset}, reconstructed from 0.3 mm labelled voxels. This reading is the nearest distance between surfel Gaussian centers, not a root-apex–to–canal surface distance. Source voxels are approximately 0.3 mm; segmentation and sampling uncertainties are not included. Two decimal places do not imply 0.01 mm accuracy, and this is not a diagnosis.`
            : `${spec.dataset}, reconstructed from 0.3 mm labelled voxels. The canal and teeth are independently layer-coded; reduce bone opacity in Layers to inspect them directly.`,
          action: () => focusCanal(),
        },
        {
          id: 'sinus-layer', fdi: sinusTooth, title: 'Maxillary Sinus Context', subtitle: 'Maxillary sinus floor and adjacent posterior root apices',
          status: 'info', metric: 'Layer L7',
          evidence: 'The maxillary sinus (L7) and alveolar bone (L3) are independently layer-coded. Adjust opacity to inspect posterior root apices relative to the sinus floor; no unmeasured distances are prepopulated.',
          action: () => { setSelected(sinusTooth); setAlphas((a) => ({ ...a, 3: 0.18, 7: 0.55 })); if (sinusTooth) viewerRef.current?.focusTooth(sinusTooth); },
        },
        {
          id: 'cbct-labels', fdi: 0, title: 'Voxel-Read FDI Binding', subtitle: 'Per-Gaussian FDI labels read directly from 0.3 mm annotations',
          status: 'verified', metric: meta ? `${Object.keys(meta.teeth ?? {}).length} FDI` : '—',
          evidence: 'FDI labels are not inferred from position: each surfel Gaussian reads the DentVoxel segmentation label just inside the surface. Sidecar files are checked by row count and SHA before being written to DSPK.',
          action: () => setRailTab('source'),
        },
      );
    } else if (caseId === 'C05' || caseId === 'C06' || caseId === 'C07') {
      const firstTooth = Object.values(meta?.teeth ?? {}).map((t) => t.fdi).find((f) => f > 0) ?? 0;
      list.push(
        {
          id: 'independent-scan', fdi: firstTooth, title: 'Independent Patient Scan', subtitle: 'Independent patient · 120 views / 15,000 Brush steps',
          status: 'verified', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
          evidence: `${spec.dataset}; shares no geometry with Cases 01/02. Highlights and gingival detail come from Blender renders of the real intraoral scan mesh, not generative completion.`,
          action: () => { if (firstTooth) { setSelected(firstTooth); viewerRef.current?.focusTooth(firstTooth); } },
        },
        {
          id: 'transferred-labels', fdi: 0, title: 'Cross-Packet FDI Transfer', subtitle: 'Nearest-neighbour transfer from the same-source 0.35 mm sampling packet to trained Gaussians',
          status: 'info', metric: meta ? `${Object.keys(meta.teeth ?? {}).length} FDI` : '—',
          evidence: 'Transfer radius: 1.0 mm. Gaussians beyond the radius retain FDI 0 rather than being assigned a tooth. The transfer records the reference packet and per-row SHA for verification.',
          action: () => setRailTab('source'),
        },
      );
      if (caseId === 'C05') list.push({
        id: 'c05-label-qa', fdi: 0, title: 'Partial FDI Transfer · Geometry QA', subtitle: 'Low label coverage reflects trained-surface deviation, not a coordinate-frame error',
        status: 'caution', metric: '26.7% ≤ 1 mm',
        evidence: 'Median nearest-neighbour distance in the reference sample: 0.187 mm. Train/reference bounding-box centers and scale differ by <0.1 mm; the best full-yaw alignment is only 2.5°. Mismatch is regional: 91.14% of FDI 33 reference points lie within 1 mm of training points, versus 0% for 42/43. This is a regional Brush surface deviation, not an insufficient nearest-neighbour radius. The conservative 1 mm transfer is retained; unmatched splats keep FDI 0.',
        action: () => setRailTab('source'),
      });
    } else if (caseId === 'A') {
      list.push({
        id: 'sampled-baseline', fdi: 0, title: 'Untrained Surface Baseline', subtitle: '0.35 mm sampling packet from the same 000125 scan · SH0',
        status: 'info', metric: report ? `${fmtInt(report.full.splats)} splats` : '—',
        evidence: 'From the same source as Case 01 but not Brush-optimised. Compare edge sharpness, occlusion and highlights before and after training using the same camera and proxy coordinate frame.',
        action: () => switchCase('A2'),
      });
    } else if (caseId === 'A2' && meta?.teeth?.FDI_46) {
      list.push(
        {
          id: 'fdi-46', fdi: 46, title: 'First Molar Occlusal Morphology', subtitle: 'Fissures and cusp highlights of the mandibular right first molar',
          status: 'verified', metric: mbText,
          evidence: 'The real Poseidon3D intraoral scan was rendered from 120 views and trained with Brush for 15,000 steps. FDI labels were transferred by nearest neighbour, with 99.5% matched within 1.0 mm.',
          action: () => { setSelected(46); viewerRef.current?.focusTooth(46); },
        },
        {
          id: 'fdi-36', fdi: 36, title: 'Contralateral Molar Alignment', subtitle: 'Alignment check for the invisible proxy mesh of the mandibular left first molar',
          status: 'verified', metric: 'Proxy mesh',
          evidence: 'Picking and millimetre measurements use the same invisible proxy mesh coordinate frame (1 unit = 1 mm). Enable the wireframe to visually verify 3DGS alignment with ground truth.',
          action: () => { setSelected(36); setWire(true); viewerRef.current?.focusTooth(36); },
        },
        {
          id: 'fdi-41', fdi: 41, title: 'Anterior Incisal Arch Orientation', subtitle: 'Mandibular central incisor edges in the standard orthonormal frame',
          status: 'verified', metric: '+Z Anterior',
          evidence: 'Labial +Z, patient right −X and maxillary +Y keep preset views and the odontogram consistent across cases.',
          action: () => { setSelected(41); viewerRef.current?.focusTooth(41); },
        },
      );
    } else if (caseId === 'U') {
      list.push(
        {
          id: 'palatal-vault', fdi: 0, title: 'Palatal Vault & Rugae', subtitle: 'Maxillary scan with the complete palatal vault and rugae',
          status: 'verified', metric: '120 views',
          evidence: 'The Poseidon3D maxillary case (annotation ortho23) was independently rendered from 120 views and trained; it shares no geometry with the mandibular Case 01. Select to return to the palatal inferior view.',
          action: () => goPreset(spec.presets.find((p) => p.id === 'upper') ?? spec.presets[0]),
        },
        {
          id: 'upper-labels', fdi: 0, title: 'No FDI side-car (by design)', subtitle: 'Per-Gaussian tooth labels were not transferred in this conversion',
          status: 'caution', metric: 'FDI 0',
          evidence: 'No per-Gaussian tooth labels were written for the maxillary or restoration cases in this round, so the odontogram is empty. Geometry, colour and transparent-layer data are complete.',
          action: () => setRailTab('source'),
        },
      );
    } else if (caseId === 'P') {
      list.push(
        {
          id: 'restorations', fdi: 0, title: 'Twelve Fixed Restorations', subtitle: '7 all-ceramic crowns + 5 scan bodies (ProsthoObjects3D 608)',
          status: 'verified', metric: '12 units',
          evidence: 'Manufacturer JSON bounding boxes and clinical CSV tooth annotations define the alignment proxy. The DSPK itself has no per-Gaussian labels in this round.',
          action: () => setRailTab('source'),
        },
        {
          id: 'ceramic-highlight', fdi: 0, title: 'View-Dependent Ceramic Highlight', subtitle: 'View-dependent highlights on ceramic and metal',
          status: 'info', metric: 'SH1',
          evidence: 'Blender rendered 120 views with ceramic/metal materials; Brush trained with SH1. Enable auto-rotation to observe highlights moving across the surface.',
          action: () => setSpin(true),
        },
      );
    }
    list.push({
      id: 'compress-audit', fdi: 0,
      title: tenX ? 'Uniform vs Anatomy-Aware 10×' : 'Full vs Pruned Fidelity Check',
      subtitle: tenX ? 'Anatomy-aware ablation at an equal byte budget' : 'Same-frame split with live browser pixel readback',
      status: 'info', metric: tenX ? 'EQUAL BYTES' : ratio ? `${ratio.toFixed(2)}×` : '—',
      evidence: tenX
        ? 'Both sides contain 11,100 splats / 322,708 B. Uniform retains every 10th splat; Anatomy-Aware retains L4 3,000, L1 7,200, L3 650 and L7 250, exceeding Uniform for both teeth and nerve canal while compensating tangential scale by each layer retention factor. PSNR / MAE remain live browser pixel readbacks.'
        : 'Full and Pruned reside together in GPU memory for same-frame split comparison. PSNR / MAE are calculated live from browser-read pixels; no values are prepopulated.',
      action: () => { setSplit(true); setRailTab('audit'); },
    });

    Object.values(meta?.teeth ?? {}).forEach((t) => {
      if (t.lesion && LESION_LABEL[t.lesion]) {
        const l = LESION_LABEL[t.lesion];
        list.push({
          id: `lesion-${t.fdi}`, fdi: t.fdi, title: l.en, subtitle: `FDI #${t.fdi} lesion region`,
          status: 'caution', metric: l.code,
          evidence: 'Tooth-level lesion markers are linked to the 3D shader highlight channel and controlled by the visibility toggle.',
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

  const caseBadge = isQuad ? 'QUAD COMPARISON · SAME CAMERA · 4 REAL REPRESENTATIONS' : isTimeline ? `TIMELINE · STEP ${timelineStep ?? '—'}` : isDiskMethod ? 'METHOD BASELINE · SURFACE-ALIGNED DISKS' : customAssetName ? `LOCAL ${isPlyLocal ? 'FP32 PLY' : '.DSPK'} · ${customAssetName}` : tenX ? '10× COMPRESSION ABLATION · CASE 03' : mprOn ? 'DTX MPR · CASE 03 · RAW CBCT' : spec.badge;

  // ---------------------------------------------------------------- render

  return (
    <div className="dtx-shell">
      <header className="clinic-topbar">
        <div className="clinic-brand"><span className="clinic-brand-mark" /><b>DentSplat</b></div>

        <div className="case-switcher">
          <button type="button" className="case-switcher-trigger" aria-expanded={caseMenuOpen} onClick={() => setCaseMenuOpen((v) => !v)}>
            <span>{spec.code} · {spec.cohort === 'cbct' ? 'CBCT 0.3 mm' : 'IOS'} · {spec.cohort === 'cbct' ? 'Full Arch' : 'Intra-oral Scan'}</span>
            <i>{caseMenuOpen ? '−' : '+'}</i>
          </button>
          {caseMenuOpen && (
            <div className="case-menu">
              <input autoFocus value={caseQuery} onChange={(e) => setCaseQuery(e.target.value)} placeholder="Search cases / modalities" />
              <div className="case-menu-list">
                {CASES.filter((c) => `${c.code} ${c.title} ${c.cohort}`.toLowerCase().includes(caseQuery.toLowerCase())).map((c) => (
                  <button key={c.id} type="button" className={caseId === c.id ? 'on' : ''} onClick={() => { switchCase(c.id); setCaseMenuOpen(false); setCaseQuery(''); }}>
                    <b>{c.code}</b><span>{c.title}</span><small>{c.cohort === 'cbct' ? 'CBCT' : 'IOS'}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <nav className="clinic-workflows" aria-label={workMode === 'clinic' ? 'Clinical workflow' : 'Research workflow'}>
          {workMode === 'clinic' ? (
            <>
              <button type="button" className={clinicWorkflow === '3d' ? 'on' : ''} onClick={() => { setClinicWorkflow('3d'); setMprOn(false); setMode('pick'); setRailTab('findings'); setInspectorOpen(true); }}>3D View</button>
              <button type="button" className={clinicWorkflow === 'mpr' ? 'on' : ''} onClick={() => { setClinicWorkflow('mpr'); if (!mprOn) toggleMpr(); }}>MPR</button>
              <button type="button" className={clinicWorkflow === 'measure' ? 'on' : ''} onClick={() => { setClinicWorkflow('measure'); setMprOn(false); setMode('measure'); setRailTab('findings'); setInspectorOpen(true); }}>Measure</button>
              <button type="button" className={clinicWorkflow === 'verify' ? 'on' : ''} onClick={() => { setClinicWorkflow('verify'); if (caseId !== 'B') switchCase('B'); setMprOn(false); setMode('pick'); setRailTab('findings'); setInspectorOpen(true); }}>Verify</button>
            </>
          ) : (
            <>
              <button type="button" className={isQuad ? 'on' : ''} onClick={() => void startQuadCompare()}>4-Way Compare</button>
              <button type="button" className={tenX ? 'on' : ''} onClick={toggleTenX}>10× Compression</button>
              <button type="button" className={railTab === 'methods' ? 'on' : ''} onClick={() => { setRailTab('methods'); setInspectorOpen(true); }}>Training Curves</button>
              <button type="button" className={railTab === 'lab' ? 'on' : ''} onClick={() => { setRailTab('lab'); setInspectorOpen(true); if (labMode === 'rgb') changeLabMode('centers'); }}>Inspector</button>
            </>
          )}
        </nav>

        <div className="clinic-top-actions">
          <div className="work-mode-switch" aria-label="Workspace mode">
            <button type="button" className={workMode === 'clinic' ? 'on' : ''} onClick={() => { setWorkMode('clinic'); setClinicWorkflow('3d'); setMode('pick'); setMprOn(false); setTenX(false); setSplit(false); setMethodCompare(false); setQuadMode(false); setQuadItems([]); viewerRef.current?.clearQuadCompare(); setHeatmap(false); setSpin(false); setVariant('full'); setRailTab('findings'); setInspectorOpen(true); }}>Clinic</button>
            <button type="button" className={workMode === 'research' ? 'on' : ''} onClick={() => { setWorkMode('research'); setRailTab('methods'); setInspectorOpen(true); }}>Research</button>
          </div>
          <button type="button" className="top-export" onClick={() => shoot()} title="Export current view"><Icon name="camera" /><span>Export</span></button>
        </div>
      </header>

      {workMode === 'research' && (
        <div className="research-toolbar">
          <button type="button" className={variant === 'full' && !split ? 'on' : ''} disabled={tenX || methodCompare} onClick={() => { setVariant('full'); setSplit(false); }}>Full</button>
          <button type="button" className={variant === 'pruned' && !split ? 'on' : ''} disabled={tenX || methodCompare} onClick={() => { setVariant('pruned'); setSplit(false); }}>Pruned</button>
          <button type="button" className={split ? 'on' : ''} disabled={tenX || methodCompare} onClick={() => setSplit((s) => !s)}>Split</button>
          <button type="button" className={tenX ? 'on' : ''} disabled={isLocal} onClick={toggleTenX}>10× Budget Allocation</button>
          <button type="button" className={heatmap ? 'on' : ''} onClick={() => setHeatmap((h) => !h)}>Anatomical Weight Map</button>
          <button type="button" onClick={runBench} disabled={benching || !report}>{benching ? 'Measuring…' : 'Pixel Readback'}</button>
          <i />
          <button type="button" className={spin ? 'on' : ''} onClick={() => setSpin((s) => !s)}>Auto Rotate</button>
          <button type="button" onClick={resetView}>Reset</button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>Load PLY / DSPK</button>
          <input ref={fileInputRef} type="file" accept=".dspk,.ply" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadLocalFile(f); e.target.value = ''; }} />
        </div>
      )}

      <div className={'dtx-workspace work-' + workMode + (inspectorOpen ? '' : ' collapsed')}>
        {workMode === 'research' && (
        <aside className="dtx-scene" aria-label="Scene tree">
          <div className="scene-head"><span>SCENE TREE</span><b>{isLocal ? 'LOCAL' : spec.code.replace('Case ', 'C')}</b></div>
          <div className="scene-scroll">
            <div className="scene-group">DATASET</div>
            <div className="scene-root" title={isLocal ? customAssetName ?? '' : spec.title}>
              <i className="scene-dot live" />
              <b>{isQuad ? '4-representation comparison' : isLocal ? (customAssetName ?? 'LOCAL') : spec.shortTitle}</b>
              <small>{isQuad ? '4 real assets · one camera' : report ? `${fmtInt(report.full.splats)} splats · ${fmtMB(report.full.bytes)} MB` : 'loading…'}</small>
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
              <i className="scene-branch" /><span><b>DSPK Full</b><small>{isQuad ? 'see quad labels' : `${fmtInt(report?.full.splats ?? 0)} splats`}</small></span>
            </button>
            <button type="button" className={'scene-node' + (variant === 'pruned' && !split ? ' on' : '')} disabled={tenX} onClick={() => { setVariant('pruned'); setSplit(false); }}>
              <i className="scene-branch" /><span><b>DSPK Pruned</b><small>{isQuad ? 'see quad labels' : `${fmtInt(report?.pruned.splats ?? 0)} splats`}</small></span>
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
              <i className="scene-branch" /><span><b>IAN Canal View</b><small>inferior alveolar nerve</small></span>
            </button>
          </div>
        </aside>
        )}

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
              <b>{isQuad ? 'Quad Comparison' : mprOn ? 'MPR' : railTab === 'lab' ? 'Gaussian Inspector' : railTab === 'methods' ? 'Method Comparison' : railTab === 'recon' ? 'Reconstruction Timeline' : '3D View'}</b>
              {workMode === 'research' && <>
                <span className="vp-sep">|</span>
                <span className="vp-stat"><b className={stats.fps >= 55 ? 'ok' : ''}>{stats.fps}</b> FPS</span>
                <span className="vp-stat">{fmtInt(stats.splats)} splats</span>
                <span className="vp-stat">{fmtMB(stats.bytes)} MB</span>
                <span className="vp-stat muted">{stats.gpu}</span>
              </>}
            </div>

            {workMode === 'research' && <div className="vp-presets">
              {spec.presets.map((p) => (
                <button key={p.id} type="button" className={activePreset === p.id ? 'on' : ''} onClick={() => goPreset(p)}>{p.label}</button>
              ))}
            </div>}
          </div>

          {workMode === 'research' && (railTab === 'lab' || labMode !== 'rgb') && (
            <div className="lab-modebar" aria-label="Gaussian rendering modes">
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
          <VectorHudOverlay viewerRef={viewerRef} />
          <ViewportGuides viewerRef={viewerRef} visible={!isQuad} />

          {workMode === 'clinic' && !mprOn && (
            <div className="clinic-toolbar">
              <button type="button" className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}><Icon name="pick" />Pick</button>
              <button type="button" className={mode === 'measure' ? 'on' : ''} onClick={() => setMode('measure')}><Icon name="measure" />Measure</button>
              <button type="button" className={clipAxis ? 'on' : ''} onClick={() => { setClipAxis(clipAxis ? null : 'x'); setRailTab('slice'); }}><Icon name="slice" />Section</button>
              <select value={activePreset} onChange={(e) => { const p = spec.presets.find((x) => x.id === e.target.value); if (p) goPreset(p); }} aria-label="View presets">
                {spec.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button type="button" className={wire ? 'on' : ''} onClick={() => setWire((w) => !w)}><Icon name="wire" />Wire</button>
              <button type="button" onClick={resetView}><Icon name="reset" />Reset</button>
            </div>
          )}

          {isQuad && (
            <div className="quad-overlay">
              {quadItems.map((q) => (
                <div className="quad-label" key={q.name}>
                  <b>{q.name}</b>
                  <small>{fmtInt(q.splats)} splats · {fmtMB(q.bytes)} MB</small>
                </div>
              ))}
              <button type="button" className="quad-exit" onClick={exitQuadCompare}>Exit four-way view</button>
            </div>
          )}

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
                <button type="button" className="m-clear" onClick={() => { setMeasures([]); viewerRef.current?.clearMeasure(); }}>Clear</button>
              </div>
            )}
          </div>

          {(split || tenX || methodCompare || timelineCompare) && (
            <>
              <SplitWipe viewerRef={viewerRef} ratio={splitRatio} onRatio={setSplitRatio} />
              <span className="split-tag l">
                {isTimeline && timelineCompare
                  ? `BRUSH CHECKPOINT ${timelineStep ?? '—'}`
                  : methodCompare
                    ? 'BRUSH 3DGS'
                    : tenX ? 'UNIFORM 10×' : 'FULL'}
              </span>
              <span className="split-tag r">
                {isTimeline && timelineCompare
                  ? 'PUBLISHED FINAL'
                  : methodCompare
                    ? 'SURFACE SAMPLING'
                    : tenX ? 'ANATOMY-AWARE 10×' : 'PRUNED'}
              </span>
            </>
          )}

          {dragOver && (
            <div className="drop-mask">
              <div>Drop to load <code>.ply</code> / <code>.dspk</code> Gaussian models locally in the browser. Data stays on this device.</div>
            </div>
          )}

          {workMode === 'research' && heatmap && (
            <div className="heatmap-legend">
              <b>CLINICAL IMPORTANCE</b>
              <span><i style={{ background: '#ff3b30' }} />L4 IAN canal</span>
              <span><i style={{ background: '#f59e0b' }} />L1 Teeth</span>
              <span><i style={{ background: '#2563eb' }} />L3 Alveolar bone</span>
              <span><i style={{ background: '#38bdf8' }} />L7 Maxillary sinus</span>
            </div>
          )}

          {loading && <div className="vp-overlay"><b>DENTSPLAT</b><span>Decoding DSPK container and spatial proxy…</span></div>}
          {err && <div className="vp-overlay err">Asset load failed: {err}</div>}
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

        {workMode === 'research' && (
        <aside className="dtx-rail" aria-label="Inspector panel switcher">
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
        )}

        <aside className="dtx-inspector">
          {workMode === 'clinic' && (
            <div className="clinic-inspector-tabs">
              <button type="button" className={railTab === 'findings' ? 'on' : ''} onClick={() => setRailTab('findings')}>Findings</button>
              <button type="button" className={railTab === 'layers' ? 'on' : ''} onClick={() => setRailTab('layers')}>Layers</button>
              <button type="button" className={railTab === 'slice' ? 'on' : ''} onClick={() => setRailTab('slice')}>Slice</button>
            </div>
          )}
          <div className="insp-odontogram">
            <Odontogram
              teeth={meta?.teeth ?? {}}
              selected={selected}
              hidden={hidden}
              onSelect={(f) => { setSelected(f); if (f) viewerRef.current?.focusTooth(f); }}
              onToggleHide={toggleHide}
            />
            <div className="insp-tooth-bar">
              <button type="button" className={'tbar-btn' + (isolate ? ' on' : '')} onClick={() => setIsolate((i) => !i)}>Isolate tooth</button>
              <button type="button" className="tbar-btn" onClick={() => { setHidden([]); setIsolate(false); }}>Show full arch</button>
              <button type="button" className={'tbar-btn' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}>Alignment wireframe</button>
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
                    placeholder="Search case number / name / modality…"
                    value={caseQuery}
                    onChange={(e) => setCaseQuery(e.target.value)}
                  />
                  <div className="case-list" role="listbox" aria-label="Select 3DGS case">
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
                              {sc ? ` · ${fmtInt(sc.full.splats)} splats · ${fmtMB(sc.full.bytes)} MB` : ' · metrics —'}
                            </small>
                          </span>
                          <span className={'cr-tag ' + cls}>{c.tag}</span>
                        </button>
                      );
                    })}
                    {pickerCases.length === 0 && <div className="case-empty">No matching cases</div>}
                  </div>
                </>
              )}
            </div>

            <div className={'insp-pane' + (railTab === 'recon' ? ' active' : '')}>
              <div className="sec-head"><span>RECONSTRUCTION TIMELINE</span><b>Case 01 · real artifacts only</b></div>
              <p className="method-intro">Shows only stage artefacts that exist in the repository and can be reloaded. Missing stages and training curves are marked explicitly; illustrative curves are not used to fill gaps.</p>

              <div className="sec-head"><span>BRUSH CHECKPOINTS · LIVE LOAD</span><b>{timeline ? `${timeline.steps.length} steps` : 'loading…'}</b></div>
              {timeline ? (
                <>
                  <div className="quick-row">
                    <button
                      type="button"
                      className={'tbar-btn' + (timelinePlay ? ' on' : '')}
                      disabled={timelineBusy}
                      onClick={() => setTimelinePlay((p) => !p)}
                    >
                      {timelinePlay ? 'Pause sequence' : 'Play training sequence'}
                    </button>
                    <span className="timeline-hint">1.2 s / step · real checkpoint</span>
                  </div>
                  <div className="recon-checkpoints">
                    {timeline.steps.map((s) => (
                      <button
                        key={s.step}
                        type="button"
                        disabled={timelineBusy}
                        className={timelineStep === s.step && (customAssetName === `timeline:${s.step}` || customAssetName === `timeline:${s.step}:vs-final`) ? 'on' : ''}
                        onClick={() => void loadTimelineStep(s)}
                      >
                        <b>{s.step === 0 ? 'S0' : fmtInt(s.step)}</b>
                        <small>{s.step === 0 ? 'COLMAP' : `${fmtInt(s.splats)} splats`}</small>
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
                    Compare with the published final in two viewports (checkpoint left / final right)
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
                            <em>{s.step === 0 ? 'S0' : `${s.step / 1000}k`}</em>
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
                        <div className="sec-head"><span>CHECKPOINT GEOMETRY</span><b>exact triangle distance</b></div>
                        <div className="timeline-metrics">
                          <span><b>cloud→mesh mean</b><em>{first.cloud_to_mesh.mean_mm.toFixed(3)} → {last.cloud_to_mesh.mean_mm.toFixed(3)} mm</em></span>
                          <span><b>F@0.5 precision</b><em>{(first.fscore.precision * 100).toFixed(1)} → {(last.fscore.precision * 100).toFixed(1)}%</em></span>
                          <span><b>F@0.5 recall</b><em>{(first.fscore.recall * 100).toFixed(1)} → {(last.fscore.recall * 100).toFixed(1)}%</em></span>
                          <span><b>normal |n·n|</b><em>{first.normal_abs_dot?.mean.toFixed(3) ?? '—'} → {last.normal_abs_dot?.mean.toFixed(3) ?? '—'}</em></span>
                        </div>
                        <p className="source-note timeline-warning">In this independent rerun, Gaussian counts increase, but cloud-to-mesh mean and F-score precision worsen while recall rises slightly: more Gaussians do not imply centers closer to the mesh. The trainer did not output loss/PSNR, so no causal conclusion about rendering quality is made. Values are recomputed from the actual checkpoint at each step without point filtering.</p>
                      </>
                    );
                  })()}
                </>
              ) : <p className="source-note">timeline.json has not loaded.</p>}

              <ol className="recon-steps">
                <li className="done">
                  <i>01</i>
                  <div><b>{allScenes.sceneA_trained?.training?.views ?? 120} Blender views</b><span>Poseidon3D 000125 intraoral scan mesh → Cycles renders used as training input.</span></div>
                </li>
                <li className="done">
                  <i>02</i>
                  <div><b>Surface Sampling · {fmtInt(allScenes.sceneA_ios?.full.splats ?? 59808)} splats</b><span>Same-source 0.35 mm sampling baseline · SH0 · unoptimised.</span></div>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A')}>Load</button>
                </li>
                <li className="done">
                  <i>03</i>
                  <div><b>{allScenes.sceneA_trained?.training?.tool ?? 'Brush v0.3.0'} · {fmtInt(allScenes.sceneA_trained?.training?.steps ?? 15000)} steps</b><span>{fmtInt(allScenes.sceneA_trained?.full.splats ?? 28691)} anisotropic Gaussians · SH{allScenes.sceneA_trained?.full.sh_degree ?? 1} · 99.5% of labels transferred within 1 mm.</span></div>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A2')}>Load</button>
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
                  <div><b>Loss / PSNR curves</b><span>Real Gaussian checkpoints from 1k–15k were exported through an independent rerun, but the trainer produced no usable loss rows; no fabricated loss curve is shown.</span></div>
                </li>
              </ol>
              <div className="quick-row">
                <button type="button" className="tbar-btn primary" onClick={startMethodCompare}>Sampling ↔ Training split view</button>
                <button type="button" className="tbar-btn" onClick={() => changeLabMode('ellipsoid')}>View 1σ ellipsoids</button>
              </div>
              <p className="source-note">The timeline traces the actual Case 01 artefact chain: input views, untrained sampling, the Brush-trained result and two DSPK packages. It does not claim to reproduce every optimisation step.</p>
            </div>

            <div className={'insp-pane' + (railTab === 'methods' ? ' active' : '')}>
              <div className="sec-head"><span>METHOD REGISTRY</span><b>evidence, not labels</b></div>
              <p className="method-intro">Only methods with real training/export assets are marked AVAILABLE. Switching web display modes is not an implementation of 2DGS, Mip-Splatting or R²-Gaussian.</p>
              <div className="method-list">
                <div className="method-row ok">
                  <div><b>Surface Sampling</b><small>0.35 mm surface sampling · SH0</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A')}>Case 10</button>
                </div>
                <div className="method-row ok">
                  <div><b>Surface-Aligned Disks</b><small>Mesh-derived covariance baseline · not 2DGS · SH0</small></div>
                  <span>BASELINE</span>
                  <button type="button" className="tbar-btn" onClick={() => void loadDiskBaseline()} disabled={!diskBaseline}>{diskBaseline ? 'Load' : '…'}</button>
                </div>
                <div className="method-row ok">
                  <div><b>Brush 3DGS</b><small>15,000 steps · anisotropic 3DGS · SH1</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('A2')}>Case 01</button>
                </div>
                <div className="method-row ok">
                  <div><b>CBCT Oriented Surfel</b><small>Segmentation volume → marching-cubes oriented surfels</small></div>
                  <span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => switchCase('B')}>Case 03</button>
                </div>
                <div className="method-row ok">
                  <div><b>Vanilla 3DGS</b><small>gsplat 1.6.0 MCMC · RTX 5070 Ti · 15k · 80k cap · SH0 web export</small></div><span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => void loadMethodDspk('gsplat')}>Load</button>
                </div>
                <div className="method-row">
                  <div><b>Mip-Splatting</b><small>Anti-aliasing / multi-scale rendering</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row ok">
                  <div><b>2DGS</b><small>24,198 splats · gsplat 1.6.0 surfel · RTX 5070 Ti · 15k · depth+normal+dist · SH0 web export</small></div><span>AVAILABLE</span>
                  <button type="button" className="tbar-btn" onClick={() => void loadMethodDspk('2dgs')}>Load</button>
                </div>
                <div className="method-row">
                  <div><b>SuGaR</b><small>Surface-aligned Gaussians and mesh extraction</small></div><span>NOT TRAINED</span>
                </div>
                <div className="method-row">
                  <div><b>R²-Gaussian</b><small>X-ray projection geometry reconstruction</small></div><span>UNAVAILABLE</span>
                </div>
              </div>
              <button type="button" className="tbar-btn primary method-compare-btn" onClick={startMethodCompare}>
                Same-source split: Surface Sampling ↔ Brush 3DGS
              </button>
              <button type="button" className="tbar-btn method-compare-btn" onClick={() => void startQuadCompare()}>
                Synchronised four-way comparison: 3DGS / 2DGS / Brush / Sampling
              </button>
              <p className="source-note">All four viewports share one camera. The 3DGS and 2DGS web assets are full 15k-step outputs trained locally on an RTX 5070 Ti, packaged with SH0 truncation. The exact geometry audit uses the same full PLY files; web-truncated appearance is not treated as a training metric.</p>
              <p className="source-note">Cases 01 and 10 come from the same Poseidon3D 000125 intraoral scan. Brush-trained output (28,691 Gaussians) is on the left; the untrained sampling baseline (59,808 Gaussians) is on the right. Both viewports share camera, coordinate frame and time.</p>
              {methodCompare && <div className="method-live">METHOD COMPARISON ACTIVE · split camera locked · Brush left / Sampling right</div>}

              <div className="sec-head"><span>GEOMETRY AUDIT · CASE 01</span><b>point→triangle · 120k surface samples</b></div>
              {geometryAudit ? (
                <>
                  <div className="geom-audit">
                    <div className="ga-head"><span>method</span><span>cloud→mesh</span><span>F@0.5</span><span>|n·n|</span></div>
                    {([
                      ['Brush · DSPK', geometryAudit.methods.brush_3dgs],
                      ['Brush · FP32', geometryAudit.methods.brush_3dgs.raw_ply],
                      ['Sampling · DSPK', geometryAudit.methods.surface_sampling],
                      ['Sampling · FP32', geometryAudit.methods.surface_sampling.raw_ply],
                      ['gsplat 3DGS · full PLY', geometryAudit.methods.gsplat_3dgs],
                      ['2DGS · full PLY', geometryAudit.methods.surfel_2dgs],
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
                    {geometryAudit.source_mesh.triangles.toLocaleString()} triangles · cloud→mesh uses exact point-to-triangle distances and reports mean / p95; mesh→cloud uses 120,000 area-weighted surface samples; F@0.5 reports precision / recall.
                    FP32→DSPK cloud→mesh mean difference: Brush {Math.abs(geometryAudit.methods.brush_3dgs.raw_ply!.cloud_to_mesh.mean_mm - geometryAudit.methods.brush_3dgs.cloud_to_mesh.mean_mm).toFixed(4)} mm,
                    Sampling {Math.abs(geometryAudit.methods.surface_sampling.raw_ply!.cloud_to_mesh.mean_mm - geometryAudit.methods.surface_sampling.cloud_to_mesh.mean_mm).toFixed(4)} mm.
                    {' '}{geometryAudit.caveat}
                  </p>
                </>
              ) : <p className="source-note">geometry_metrics.json has not loaded or is unavailable.</p>}

              {geometryAudit?.training_curves && (
                <div className="training-curves">
                  <div className="sec-head"><span>REAL TRAINING CURVES</span><b>105 train / 15 test</b></div>
                  {Object.entries(geometryAudit.training_curves).map(([key, t]) => (
                    <div className="tc-method" key={key}>
                      <div className="tc-head">
                        <b>{key === '3dgs-gsplat-mcmc' ? 'gsplat 3DGS · MCMC' : '2DGS · surfel'}</b>
                        <span>{t.train_sec.toFixed(1)} s · {fmtInt(t.num_gaussians)} Gaussians</span>
                      </div>
                      <div className="tc-bars" aria-label="held-out PSNR curve">
                        {t.curve.map((p) => (
                          <span key={p.step} title={`${p.step}: ${p.test_psnr.toFixed(3)} dB`} style={{ width: `${Math.max(8, (p.test_psnr - 30) * 10)}%` }} />
                        ))}
                      </div>
                      <div className="tc-grid">
                        {t.curve.map((p) => (
                          <div className="tc-row" key={p.step}>
                            <b>{p.step / 1000}k</b>
                            <span>loss {p.train_loss === null ? '—' : p.train_loss.toFixed(5)}</span>
                            <span>PSNR {p.test_psnr.toFixed(2)}</span>
                            <span>SSIM {p.test_ssim.toFixed(4)}</span>
                            <span>LPIPS {p.test_lpips.toFixed(4)}</span>
                            <span>{fmtInt(p.num_gaussians)} GS</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="source-note">Both curves use the same held-out set (every 8th image after COLMAP filename sorting); the final 3DGS point is step 14999, labelled as 15k. LPIPS uses the torchmetrics VGG convention.</p>
                </div>
              )}

              <div className="method-caveat">R²-Gaussian requires X-ray projections and imaging geometry; current CBCT segmentation volumes are not a substitute. The project does not provide fabricated cross-method results.</div>
            </div>

            <div className={'insp-pane' + (railTab === 'lab' ? ' active' : '')}>
              <div className="sec-head">
                <span>GAUSSIAN INSPECTOR</span>
                <b>{gaussian ? `#${gaussian.index}` : 'CLICK A GAUSSIAN'}</b>
              </div>
              {!gaussian ? (
                <div className="lab-empty">
                  <p>Current mode: <b>{LAB_MODES.find((m) => m.id === labMode)?.label ?? labMode}</b></p>
                  <p>Click any Gaussian center in the viewport to inspect its μ, σ, quaternion, rotation matrix, opacity, full SH coefficients, covariance and 3D probability density. You can also locate a Gaussian by index.</p>
                  <div className="gauss-index-picker">
                    <input
                      type="number" min={0} max={Math.max(0, stats.splats - 1)} step={1}
                      value={gaussIndexInput}
                      onChange={(e) => setGaussIndexInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') selectGaussianByIndex(gaussIndexInput); }}
                      aria-label="Gaussian index"
                    />
                    <button type="button" className="tbar-btn" onClick={() => selectGaussianByIndex(gaussIndexInput)}>Locate Gaussian</button>
                  </div>
                  <p className="muted">Ellipsoid mode uses the true 3×3 covariance. Normal mode shows the ellipsoid minor axis, not a mesh surface normal. The 1σ/2σ/3σ controls change the selected Gaussian isosurface.</p>
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
                  <div className="sec-head"><span>3D PROBABILITY DENSITY</span><b>{labSigma}σ isosurface</b></div>
                  <GaussianDensityPlot center={gaussian.center} covariance={gaussian.covariance} axes={gaussian.axes} alpha={gaussian.alpha} unit={gaussUnit} />
                  <p className="source-note">
                    G(x)=α·exp(−½·(x−μ)ᵀΣ⁻¹(x−μ)); normalised PDF peak: {gaussianPdfAt(gaussian.center, gaussian.center, gaussian.covariance).toExponential(2)} {gaussUnit}⁻³.
                    The current {labSigma}σ isosurface amplitude is {isosurfaceAmplitude(gaussian.alpha, labSigma).toFixed(4)}. The heatmap is an analytic slice through the first two principal-axis planes, not a finite-difference approximation.
                  </p>
                  <div className="sec-head"><span>SCREEN-SPACE PROJECTION</span><b>live camera</b></div>
                  <ProjectionPlot viewer={viewerRef.current} index={gaussian.index} />
                  <div className="quick-row">
                    <button
                      type="button"
                      className="tbar-btn"
                      onClick={() => setAlphaMix(viewerRef.current?.alphaComposition(gaussian.index, 6) ?? null)}
                    >
                      Analyse pixel blending
                    </button>
                    <span className="timeline-hint">6 mm neighbourhood in the actual scene</span>
                  </div>
                  {alphaMix && (
                    <>
                      <div className="alpha-summary">
                        <i style={{ background: `rgb(${alphaMix.color.map((v) => Math.round(v * 255)).join(',')})` }} />
                        <span>Pixel coverage α <b>{(alphaMix.coverage * 100).toFixed(1)}%</b> · top {alphaMix.contributors.length} contributors</span>
                      </div>
                      <div className="alpha-list">
                        {alphaMix.contributors.map((c) => (
                          <div key={c.index}>
                            <span>#{c.index}</span>
                            <span>z {c.depthMm.toFixed(1)} mm</span>
                            <span>α {c.alpha.toFixed(3)}</span>
                            <b>{(c.weight * 100).toFixed(1)}%</b>
                          </div>
                        ))}
                      </div>
                      <p className="source-note">Local composition snapshot: candidates are actual Gaussians within a 6 mm object-space neighbourhood, accumulated back-to-front using the current camera EWA projection and depth. This is not full-ray voxel traversal; recalculate after moving the camera.</p>
                    </>
                  )}
                  {gaussian.shDegree > 1 && (
                    <p className="source-note">This file contains SH{gaussian.shDegree} fields; import/export preserves all f_rest coefficients.{gaussian.shDegree === 3
                      ? ' FP32 PLY l=2/l=3 coefficients are evaluated on the GPU via vertex textures; DSPK packages still carry only DC+l=1.'
                      : ' The current GPU evaluates only DC+l=1; l=2 coefficients are retained but not rendered separately.'}</p>
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
                  {(['R', 'G', 'B'] as const).map((name, axis) => (
                    <div className="ctrl-item" key={`c${axis}`}>
                      <div className="ctrl-label"><span>DC {name}</span><b>{gaussian.color[axis].toFixed(3)}</b></div>
                      <input type="range" min={0} max={1} step={0.005} value={gaussian.color[axis]} onChange={(e) => editGaussColor(axis as 0 | 1 | 2, Number(e.target.value))} />
                    </div>
                  ))}

                  <div className="sec-head"><span>ROTATION QUATERNION</span><b>normalised on edit</b></div>
                  {([3, 0, 1, 2] as const).map((axis) => (
                    <div className="ctrl-item" key={`q${axis}`}>
                      <div className="ctrl-label">
                        <span>{['W', 'X', 'Y', 'Z'][axis === 3 ? 0 : axis + 1]}</span>
                        <b>{gaussian.quat[axis].toFixed(3)}</b>
                      </div>
                      <input type="range" min={-1} max={1} step={0.01} value={gaussian.quat[axis]} onChange={(e) => editGaussRotation(axis, Number(e.target.value))} />
                    </div>
                  ))}

                  <div className="sec-head"><span>ROTATION MATRIX R</span><b>from quaternion</b></div>
                  <div className="cov-grid rotation-grid">
                    {[0, 1, 2].map((r) => [0, 1, 2].map((c) => (
                      <span key={`${r}-${c}`} className={r === c ? 'diag' : ''}>{gaussian.rotation[r * 3 + c].toFixed(4)}</span>
                    )))}
                  </div>

                  <div className="sec-head"><span>COVARIANCE Σ ({isPlyLocal ? 'u²' : 'mm²'})</span></div>
                  <div className="cov-grid">
                    {[0, 1, 2].map((r) => [0, 1, 2].map((c) => (
                      <span key={`${r}-${c}`} className={r === c ? 'diag' : ''}>{gaussian.covariance[r * 3 + c].toExponential(2)}</span>
                    )))}
                  </div>
                  <div className="eig-list">
                    {gaussian.axes.eigenvalues.map((lambda, i) => (
                      <span key={i}><i className={`axis-dot a${i}`} />λ{i + 1} = {lambda.toExponential(2)} · σ = {gaussian.axes.sigmas[i].toFixed(4)} {gaussUnit}</span>
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
                  {gaussian.shRest && gaussian.shRestCount > 0 ? (
                    <details className="sh-details" open={gaussian.shDegree > 1}>
                      <summary>Full SH coefficients · degree {gaussian.shDegree} · {gaussian.shRestCount} values</summary>
                      <div className="sh-coeff-grid">
                        {([1, 2, 3] as const).filter((degree) => {
                          const width = degree * 2 + 1;
                          const start = degree === 1 ? 0 : degree === 2 ? 9 : 33;
                          return start + 3 * width <= gaussian.shRestCount;
                        }).map((degree) => {
                          const width = degree * 2 + 1;
                          const start = degree === 1 ? 0 : degree === 2 ? 9 : 33;
                          return (
                            <div className="sh-degree" key={degree}>
                              <b>l={degree} · {width} coefficients / channel</b>
                              {['R', 'G', 'B'].map((channel, c) => (
                                <div key={channel}>
                                  <span>{channel}</span>
                                  <code>{gaussian.shRest!.slice(start + c * width, start + (c + 1) * width).map((v) => v.toFixed(4)).join(', ')}</code>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                      <p className="source-note">Coefficients are shown in the original PLY channel-major order; l=2/l=3 are retained in FP32 raw data, while the current web renderer evaluates only DC+l=1.</p>
                    </details>
                  ) : (
                    <p className="source-note">The current DSPK carries only DC+l=1; full l=2/l=3 coefficients are unavailable and are not replaced with fabricated zeros.</p>
                  )}

                  <div className="gauss-index-picker selected-index-picker">
                    <input
                      type="number" min={0} max={Math.max(0, stats.splats - 1)} step={1}
                      value={gaussIndexInput}
                      onChange={(e) => setGaussIndexInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') selectGaussianByIndex(gaussIndexInput); }}
                      aria-label="Selected Gaussian index"
                    />
                    <button type="button" className="tbar-btn" onClick={() => selectGaussianByIndex(gaussIndexInput)}>Locate by index</button>
                  </div>

                  <div className="quick-row gauss-actions">
                    <button type="button" className="tbar-btn" onClick={() => viewerRef.current?.selectGaussian(gaussian.index, { focus: true })}>Focus</button>
                    <button type="button" className={'tbar-btn' + (gaussIsolate ? ' on' : '')} onClick={() => setGaussIsolate((x) => !x)}>{gaussIsolate ? 'Exit isolation' : 'Isolate Gaussian'}</button>
                    <button type="button" className="tbar-btn" onClick={resetGaussian} disabled={!gaussOriginal}>Reset</button>
                    <button type="button" className="tbar-btn" onClick={exportPly}>Export PLY</button>
                  </div>
                  <p className="source-note">
                    DSPK editing is limited by 16-bit position and 8-bit log-scale quantisation. The interface shows the actual values written back; FP32 PLY retains the original floating-point values.
                    {isPlyLocal && ' PLY does not declare a length unit; values are shown in original PLY units (u), without automatic conversion to mm.'}
                  </p>
                </>
              )}
              {plyNote && <p className="source-note ply-note">{plyNote}</p>}
              <div className="lab-footnote">
                <b>{LAB_MODES.find((m) => m.id === labMode)?.label}</b> · {LAB_MODES.find((m) => m.id === labMode)?.note}
                {labInfo?.truncated && <span> · Geometry modes use reproducible sampling; the displayed count is the actual rendered number</span>}
              </div>
            </div>

            <div className={'insp-pane' + (railTab === 'findings' ? ' active' : '')}>
              {caseId === 'B' && (
                <div className="evidence-auditor">
                  <div className="auditor-head">
                    <span><Icon name="audit" />REPORT VERIFICATION</span>
                    <b>Clinical Review</b>
                  </div>
                  <p>Simulated Dental VLM report. Select Verify Measurements to recalculate the minimum FDI-to-canal center distance live from the current complete DSPK point cloud. Tolerance: 0.30 mm; verdicts are not prepopulated.</p>
                  <button type="button" className="tbar-btn primary audit-run" disabled={auditing || tenX} onClick={runGeometricAudit}>
                    {auditing ? 'Scanning 3D point pairs…' : 'Verify Measurements'}
                  </button>
                  {tenX && <div className="auditor-note">10× comparison is active. Exit it to audit all 111,000 complete surfel Gaussians.</div>}
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
                          <span className="audit-claim-top"><b>{c.title}</b><em>{!r ? 'PENDING' : c.status === 'verified' ? 'VERIFIED' : 'DISCREPANCY FLAGGED'}</em></span>
                          <span className="audit-claim-text">{c.claim}</span>
                          {r && (
                            <span className="audit-claim-result">
                              3DGS measurement {r.distance.toFixed(2)} mm · Δ {delta!.toFixed(2)} mm<br />
                              Evidence statement: FDI #{c.tooth} → L4 minimum surfel-center distance = {r.distance.toFixed(2)} mm (source voxels approximately 0.3 mm; not a root-apex surface distance; not a clinical diagnosis).
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
                placeholder="Filter by FDI number or finding (e.g. 38, 46, IAN)…"
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
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.95, 4: 1, 7: 0.12 }))}>Root / IAN transparency</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.85, 1: 1, 4: 1, 7: 0.35 }))}>Solid bone surface</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0, 1: 0.35, 4: 1, 7: 0 }))}>IAN canal only</button>
                </div>
              )}
              {displayLayers.map((l) => (
                <div className="ctrl-item" key={l.id}>
                  <div className="ctrl-label">
                    <span><i className="color-sq" style={{ background: l.color }} />{l.en}</span>
                    <b>{Math.round(alphaOf(l.id) * 100)}%</b>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.01} value={alphaOf(l.id)}
                    onChange={(e) => setAlphas((a) => ({ ...a, [l.id]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <div className="ctrl-item">
                <div className="ctrl-label"><span>Global opacity</span><b>{Math.round(opacity * 100)}%</b></div>
                <input type="range" min={0.25} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              </div>
            </div>

            <div className={'insp-pane' + (railTab === 'slice' ? ' active' : '')}>
              <div className="sec-head"><span>SHADER-LEVEL CLIPPING PLANE</span></div>
              <div className="quick-row">
                {([['x', 'Coronal X'], ['y', 'Horizontal Y'], ['z', 'Sagittal Z'], [null, 'Off']] as [ClipAxis, string][]).map(([a, nm]) => (
                  <button
                    key={String(a)}
                    type="button"
                    className={'tbar-btn' + (clipAxis === a ? ' on' : '')}
                    onClick={() => { setClipAxis(a); if (a && clipAxis !== a) setClipOffset(0); }}
                  >
                    {nm}
                  </button>
                ))}
                <button type="button" className={'tbar-btn' + (flip ? ' on' : '')} onClick={() => setFlip((f) => !f)}>Flip</button>
              </div>
              <div className="ctrl-item">
                <div className="ctrl-label"><span>Section offset</span><b>{clipOffset.toFixed(1)} mm</b></div>
                <input type="range" min={clipRange[0]} max={clipRange[1]} step={0.5} value={clipOffset} disabled={!clipAxis} onChange={(e) => setClipOffset(Number(e.target.value))} />
              </div>
              <div className="ctrl-item">
                <div className="ctrl-label"><span>Section cap bandwidth</span><b>{clipBand.toFixed(2)} mm</b></div>
                <input type="range" min={0} max={4} step={0.05} value={clipBand} disabled={!clipAxis} onChange={(e) => setClipBand(Number(e.target.value))} />
              </div>
              <label className="insp-toggle-row">
                <span>Solid section cap</span>
                <input type="checkbox" checked={cap} onChange={(e) => setCap(e.target.checked)} />
              </label>

              {!isLocal && spec.hasJaw && (
                <>
                  <div className="sec-head" style={{ marginTop: 10 }}><span>MANDIBULAR HINGE MOTION</span></div>
                  <div className="ctrl-item">
                    <div className="ctrl-label"><span>Mandibular opening (condylar hinge)</span><b>{jaw.toFixed(0)} mm</b></div>
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
                <dt>{tenX ? 'coverage holes (Full→10×)' : 'coverage gap'}</dt>
                <dd>
                  {!report ? '—' : tenX
                    ? `Uniform ${Number(report.compression_fidelity_mm.uniform_coverage_gap_mean).toFixed(3)} / p95 ${Number(report.compression_fidelity_mm.uniform_coverage_gap_p95).toFixed(3)} mm · Anatomy ${Number(report.compression_fidelity_mm.anatomy_coverage_gap_mean).toFixed(3)} / p95 ${Number(report.compression_fidelity_mm.anatomy_coverage_gap_p95).toFixed(3)} mm`
                    : report.compression_fidelity_mm.coverage_gap_mean != null
                      ? `${report.compression_fidelity_mm.coverage_gap_mean} mm mean · p95 ${report.compression_fidelity_mm.coverage_gap_p95} mm`
                      : '—'}
                </dd>
                <dt>live PSNR</dt>
                <dd>{bench ? `${bench.psnr} dB · in-mask ${bench.psnrInMask} dB · MAE ${bench.mae}` : '—'}</dd>
              </dl>

              {tenX && ablation && (
                <div className="ablation-stats">
                  <div><b>UNIFORM 10×</b><span>L4 800 · L1 6,500 · L3 3,000 · L7 800</span></div>
                  <div><b>ANATOMY-AWARE 10×</b><span>L4 3,000 · L1 7,200 · L3 650 · L7 250</span></div>
                  <small>L1/L4 both exceed Uniform; L3+L7 total 900. Tangential scales are compensated by √k for each layer; normal thickness is unchanged.</small>
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
                  <small>Full-reference FDI48–L4 = {compressionBench.referenceClearance?.toFixed(3) ?? '—'} mm. All PSNR/MAE values use the same Full reference, fixed views and isolated single-layer renders; clearance remains a surfel-center geometric measurement.</small>
                </div>
              )}

              <div className="quick-row">
                <button type="button" className="tbar-btn primary" onClick={runBench} disabled={benching || !report}>
                  {benching ? 'Reading pixels…' : tenX ? 'Recompute against Full' : 'Run bench (384²)'}
                </button>
                <button type="button" className={'tbar-btn' + (split ? ' on' : '')} disabled={tenX} onClick={() => setSplit((s) => !s)}>
                  Same-frame split
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
              <p className="source-note">{isQuad
                ? 'Synchronised four-way comparison of COLMAP sparse points, Brush 3DGS, Surface Sampling and Mesh-Aligned Disks. Four real assets share one camera; these are not 2DGS/Mip-Splatting training results.'
                : isTimeline
                  ? `Real Brush rerun checkpoint · step ${timelineStep ?? '—'}. This independent rerun demonstrates the training process; the checkpoint has no FDI/layer labels and does not inherit the published Case 01 proxy or report.`
                : isDiskMethod
                  ? 'Representation baseline: uses the exact same 0.35 mm sampling centers, colours and FDI labels as Case 10, replacing only covariance with flat disks aligned to source-mesh normals (tangential 0.30 mm, normal 0.03 mm). This is not a 2DGS algorithm and has no training process.'
                  : isPlyLocal
                  ? 'Local FP32 PLY preview: positions, scales, rotations, colours and opacity come directly from PLY floating-point fields without DSPK 8-bit quantisation. No tooth/anatomical semantics are inherited.'
                  : isLocal
                    ? "Independent local preview: uses only geometry and semantics embedded in the DSPK. Original case proxies, tooth metadata, MPR and reports are not inherited. Single-tooth tools depend on the actual FDI content of the file."
                    : spec.blurb}</p>
              <button type="button" className="tbar-btn primary" onClick={() => fileInputRef.current?.click()}>
                Select local .ply / .dspk to open Lab
              </button>
              <button type="button" className="tbar-btn" onClick={loadSamplePly}>Load sample FP32 PLY (Case 05, Brush)</button>
              <p className="source-note">Supports binary/ascii 3DGS <code>.ply</code> and quantised <code>.dspk</code>. Files are decoded only in browser memory and are not uploaded. PLY coordinate frames are not implicitly redirected; if orientation appears incorrect, check the trainer's export coordinates.</p>
            </div>
          </div>
        </aside>
      </div>

      <footer className="dtx-statusbar">
        <span>{workMode === 'clinic' ? '1 unit = 1 mm · 0.3 mm ISO · Medical Coordinate Frame' : 'Drag: Orbit · Right-Drag: Pan · Scroll: Zoom · Double-Click: Focus · R: Reset'}</span>
        <span className="dtx-spacer" />
        {workMode === 'research' && <span>Sort {stats.sortMs.toFixed(2)} ms · {fmtInt(stats.splats)} splats · {stats.gpu}</span>}
      </footer>
    </div>
  );
}
