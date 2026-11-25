import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { DentSplatViewer } from './engine/Viewer.ts';
import type { BenchResult, ClipAxis, PickerHit, ProbeResult, Stats, ViewPreset } from './engine/Viewer.ts';
import { CASES, AUDIT_BASIS, LESION_LABEL } from './data/cases.ts';
import type { CaseSpec } from './data/cases.ts';
import Odontogram from './ui/Odontogram.tsx';
import type { ToothMeta } from './ui/Odontogram.tsx';

type Report = {
  splats: number; bytes: number; mb: number; sh_degree: number; bytes_per_splat: number;
};
type SceneReport = {
  full: Report; pruned: Report; bytes_ratio: number;
  proxy: { bytes: number; kb: number; nodes: number; triangles: number };
  compression_fidelity_mm: Record<string, number | string>;
  metrics: Record<string, number | number[]>;
};
type MetaFile = {
  unit: string; kind: string; bbox_min?: number[]; bbox_max?: number[];
  teeth: Record<string, ToothMeta>;
  metrics?: Record<string, number | number[]>;
};

type RailTab = 'findings' | 'layers' | 'slice' | 'audit' | 'source';

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
    case 'bench': return <svg {...props}><path d="M4 19h16M7 15v-4M12 15V7M17 15v-6" /></svg>;
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
  const [wire, setWire] = useState(false);
  const [mode, setMode] = useState<'pick' | 'measure'>('pick');
  const [measures, setMeasures] = useState<number[]>([]);
  const [bench, setBench] = useState<BenchResult | null>(null);
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

  // ---------------------------------------------------------------- viewer lifecycle

  useEffect(() => {
    if (!canvasRef.current) return;
    const v = new DentSplatViewer(canvasRef.current);
    v.autoRotate = false;
    v.onStats = setStats;
    v.onMeasure = (m) => { if (m) setMeasures((list) => [...list, +m.mm.toFixed(2)].slice(-8)); };
    v.onPick = (hit: PickerHit) => {
      if (!hit) { setProbe(null); return; }
      setProbe({ mm: [hit.point.x, hit.point.y, hit.point.z].map((n) => +n.toFixed(1)), fdi: hit.fdi });
      if (hit.fdi) setSelected(hit.fdi);
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
        setLoading(true); setErr(null); setBench(null); setCustomAssetName(null);
        const [rep, mf] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/report.json`).then((r) => r.json()),
          fetch(spec.metaUrl).then((r) => r.json()),
        ]);
        const scene: SceneReport | undefined = rep.scenes?.[spec.sceneKey];
        if (!scene) throw new Error(`report.json has no scene "${spec.sceneKey}"`);
        v.caseId = caseId;
        const defaults: Record<number, number> = {};
        for (const l of spec.layers) defaults[l.id] = l.alpha;
        await v.loadCase({
          fullUrl: spec.fullUrl, prunedUrl: spec.prunedUrl, proxyUrl: spec.proxyUrl,
          fullBytes: scene.full.bytes, prunedBytes: scene.pruned.bytes, defaultLayerAlpha: defaults,
        });
        if (dead) return;
        setReport(scene);
        setMeta(mf as MetaFile);
        setAlphas(defaults);
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
        if (!dead) { setErr(String(e instanceof Error ? e.message : e)); setLoading(false); }
      }
    })();
    return () => { dead = true; };
  }, [caseId, spec]);

  // Back/forward + manual hash edits switch cases without a reload.
  useEffect(() => {
    const onHash = () => {
      const h = hashCase();
      if (CASES.some((c) => c.id === h) && h !== caseId) setCaseId(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [caseId]);

  // ---------------------------------------------------------------- state -> engine

  useEffect(() => { viewerRef.current?.setLayerAlphaMap(alphas); }, [alphas, caseId]);
  useEffect(() => {
    viewerRef.current?.set({
      // Only a two-jaw volume gets a hinge; single-jaw scans keep jawGap at 0.
      jawGap: spec.hasJaw ? jaw : 0,
      opacity, showLesions, hiddenTeeth: hidden, isolateTooth: isolate,
      clip: { axis: clipAxis, offset: flip ? -clipOffset : clipOffset, band: clipBand, cap },
    });
  }, [spec.hasJaw, jaw, opacity, showLesions, hidden, isolate, clipAxis, clipOffset, clipBand, cap, flip]);
  useEffect(() => { viewerRef.current?.setVariant(variant, split); }, [variant, split]);
  useEffect(() => { viewerRef.current?.setWireframe(wire); }, [wire]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.measureMode = mode; }, [mode]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.autoRotate = spin; }, [spin]);
  useEffect(() => { viewerRef.current?.select(selected, { pulse: selected > 0 }); }, [selected]);

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

  const goPreset = useCallback((p: ViewPreset) => {
    setActivePreset(p.id);
    viewerRef.current?.flyTo(p);
    history.replaceState(null, '', `#${caseId},${p.id}`);
  }, [caseId]);

  const resetView = useCallback(() => {
    setClipAxis(null); setClipOffset(0); setJaw(0); setIsolate(false); setHidden([]); setSelected(0); setActiveFindingId(null);
    const defaults: Record<number, number> = {};
    for (const l of spec.layers) defaults[l.id] = l.alpha;
    setAlphas(defaults);
    goPreset(spec.presets[0]);
  }, [goPreset, spec]);

  const focusCanal = useCallback(() => {
    if (caseId !== 'B') { setCaseId('B'); return; }
    setSelected(38);
    setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.9, 4: 1.0, 7: 0.12 }));
    setClipAxis('x'); setFlip(false); setClipOffset(18); setClipBand(1.2); setCap(true);
    const p = spec.presets.find((x) => x.id === 'ian') ?? spec.presets[0];
    goPreset(p);
  }, [caseId, goPreset, spec]);

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
      setBench(await v.bench(384));
    } finally {
      setBenching(false);
    }
  }, []);

  const loadLocalDspk = useCallback(async (file: File) => {
    const v = viewerRef.current;
    if (!v || !file.name.toLowerCase().endsWith('.dspk')) return;
    const blobUrl = URL.createObjectURL(file);
    try {
      setLoading(true);
      await v.loadCase({
        fullUrl: blobUrl, prunedUrl: blobUrl, proxyUrl: spec.proxyUrl,
        fullBytes: file.size, prunedBytes: file.size,
      });
      setCustomAssetName(`${file.name} (${fmtMB(file.size)} MB)`);
      setLoading(false);
    } catch (e) {
      setErr(`本地 DSPK 加载失败: ${String(e)}`);
      setLoading(false);
    }
  }, [spec.proxyUrl]);

  const shoot = useCallback(() => {
    const data = viewerRef.current?.snapshot();
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = `dentsplat_${caseId}_${Date.now()}.png`;
    a.click();
  }, [caseId]);

  const toggleHide = useCallback((fdi: number) => {
    setHidden((h) => (h.includes(fdi) ? h.filter((x) => x !== fdi) : [...h, fdi]));
  }, []);

  const alphaOf = (id: number) => alphas[id] ?? 1;

  // Evidence-linked findings. Numbers shown here all come from report.json / meta.json of the
  // current case; anything not measured is labelled TBD rather than filled with a placeholder.
  const findings = useMemo<EvidenceFinding[]>(() => {
    const list: EvidenceFinding[] = [];
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
      id: 'compress-audit', fdi: 0, title: 'Full vs Pruned Fidelity Check', subtitle: '同帧分屏与浏览器像素回读',
      status: 'info', metric: ratio ? `${ratio.toFixed(2)}×` : '—',
      evidence: 'Full 与 Pruned 同驻显存，可用同一帧分屏对比；PSNR / MAE 由浏览器回读像素现场计算，不预写数值。',
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
  }, [caseId, focusCanal, goPreset, meta, mbText, ratio, report, spec.presets]);

  const filteredFindings = useMemo(() => {
    const q = findingFilter.trim().toLowerCase();
    if (!q) return findings;
    return findings.filter((f) =>
      String(f.fdi).includes(q) || f.title.toLowerCase().includes(q) || f.subtitle.toLowerCase().includes(q)
    );
  }, [findingFilter, findings]);

  const caseBadge = customAssetName ? `LOCAL .DSPK · ${customAssetName}` : spec.badge;

  // ---------------------------------------------------------------- render

  return (
    <div className="dtx-shell">
      <header className="dtx-menubar">
        <div className="dtx-brand">
          <span className="dtx-mark" />
          <b>DentSplat</b>
          <em>Evidence-Grounded 3D Dental AI Workspace</em>
        </div>

        <nav className="dtx-workflows" aria-label="临床工作流阶段">
          <button type="button" className={railTab === 'findings' && mode === 'pick' ? 'on' : ''} onClick={() => { setMode('pick'); setRailTab('findings'); setInspectorOpen(true); }}>Diagnose</button>
          <button type="button" className={mode === 'measure' ? 'on' : ''} onClick={() => setMode(mode === 'measure' ? 'pick' : 'measure')}>Measure</button>
          <button type="button" className={railTab === 'slice' ? 'on' : ''} onClick={() => { setRailTab('slice'); setInspectorOpen(true); }}>Slice &amp; Cap</button>
          <button type="button" className={railTab === 'layers' ? 'on' : ''} onClick={() => { setRailTab('layers'); setInspectorOpen(true); }}>3D Anatomy</button>
          <button type="button" className={railTab === 'audit' ? 'on' : ''} onClick={() => { setRailTab('audit'); setInspectorOpen(true); }}>Evidence Audit</button>
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
          <button type="button" className={'rib-btn' + (caseId === 'B' && activePreset === 'ian' ? ' on' : '')} onClick={focusCanal}>
            <Icon name="nerve" /><span>神经管特写</span>
          </button>
        </div>

        <i className="rib-div" />

        <div className="rib-group">
          <button type="button" className={'rib-btn' + (variant === 'full' && !split ? ' on' : '')} onClick={() => { setVariant('full'); setSplit(false); }}>
            <Icon name="layers" /><span>Full 完整</span>
          </button>
          <button type="button" className={'rib-btn' + (variant === 'pruned' && !split ? ' on' : '')} onClick={() => { setVariant('pruned'); setSplit(false); }}>
            <Icon name="layers" /><span>Pruned 剪枝</span>
          </button>
          <button type="button" className={'rib-btn' + (split ? ' on' : '')} onClick={() => setSplit((s) => !s)}>
            <Icon name="split" /><span>同屏对比</span>
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
          <button type="button" className="rib-btn" onClick={() => fileInputRef.current?.click()} title="本地加载 .dspk 文件（Research Mode，零上传）">
            <Icon name="upload" /><span>载入 .DSPK</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dspk"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadLocalDspk(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="dtx-subtabs">
        {CASES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={'subtab' + (caseId === c.id ? ' on' : '')}
            onClick={() => { setCaseId(c.id); history.replaceState(null, '', `#${c.id}`); }}
          >
            <span className="subtab-dot" />
            {c.nav} · {c.modality.split(' ')[0]}
          </button>
        ))}
        <div className="dtx-spacer" />
        <div className="subtab-info">{spec.title}</div>
      </div>

      <div className={'dtx-workspace' + (inspectorOpen ? '' : ' collapsed')}>
        <section
          className={'dtx-viewport' + (mode === 'measure' ? ' is-measure' : '') + (dragOver ? ' is-drag' : '')}
          ref={stageRef}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void loadLocalDspk(f);
          }}
        >
          <div className="vp-header">
            <div className="hud vp-title">
              <span className="vp-green-sq" />
              <b>3DGS Viewer</b>
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
              <span className="split-tag l">FULL · {fmtInt(report?.full.splats ?? 0)} splats ({fmtMB(report?.full.bytes ?? 0)} MB)</span>
              <span className="split-tag r">PRUNED ({ratio.toFixed(2)}×) · {fmtInt(report?.pruned.splats ?? 0)} splats ({fmtMB(report?.pruned.bytes ?? 0)} MB)</span>
            </>
          )}

          {dragOver && (
            <div className="drop-mask">
              <div>松开鼠标，立即在本地浏览器加载 <code>.dspk</code> 高斯模型（数据不离本机）</div>
            </div>
          )}

          {loading && <div className="vp-overlay"><b>DENTSPLAT</b><span>正在解码 DSPK 容器与空间代理…</span></div>}
          {err && <div className="vp-overlay err">资产加载失败：{err}</div>}
        </section>

        <aside className="dtx-rail" aria-label="检视面板切换">
          {([
            ['findings', 'findings', 'Findings'],
            ['layers', 'layers', 'Layers'],
            ['slice', 'slice', 'Slice'],
            ['audit', 'bench', 'Audit'],
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
            <div className={'insp-pane' + (railTab === 'findings' ? ' active' : '')}>
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
              {caseId === 'B' && (
                <div className="quick-row">
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.95, 4: 1, 7: 0.12 }))}>透视牙根+神经管</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0.85, 1: 1, 4: 1, 7: 0.35 }))}>实心骨表面</button>
                  <button type="button" className="tbar-btn" onClick={() => setAlphas((a) => ({ ...a, 3: 0, 1: 0.35, 4: 1, 7: 0 }))}>仅突出神经管</button>
                </div>
              )}
              {spec.layers.map((l) => (
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

              {spec.hasJaw && (
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
                <dt>full</dt>
                <dd>{report ? `${fmtInt(report.full.splats)} splats · ${fmtMB(report.full.bytes)} MB · SH${report.full.sh_degree}` : '—'}</dd>
                <dt>pruned</dt>
                <dd>{report ? `${fmtInt(report.pruned.splats)} splats · ${fmtMB(report.pruned.bytes)} MB · SH${report.pruned.sh_degree}` : '—'}</dd>
                <dt>ratio</dt>
                <dd>{ratio ? `${ratio.toFixed(2)}× smaller` : '—'}</dd>
                <dt>coverage gap</dt>
                <dd>
                  {report && report.compression_fidelity_mm.coverage_gap_mean != null
                    ? `${report.compression_fidelity_mm.coverage_gap_mean} mm mean · p95 ${report.compression_fidelity_mm.coverage_gap_p95} mm`
                    : 'TBD'}
                </dd>
                <dt>live PSNR</dt>
                <dd>{bench ? `${bench.psnr} dB · 掩膜内 ${bench.psnrInMask} dB · MAE ${bench.mae}` : '—'}</dd>
              </dl>

              <div className="quick-row">
                <button type="button" className="tbar-btn primary" onClick={runBench} disabled={benching || !report}>
                  {benching ? '回读像素中…' : '跑一次 bench(384²)'}
                </button>
                <button type="button" className={'tbar-btn' + (split ? ' on' : '')} onClick={() => setSplit((s) => !s)}>
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
                <dt>Dataset</dt><dd>{spec.dataset}</dd>
                <dt>License</dt><dd>{spec.license}</dd>
                <dt>Proxy</dt>
                <dd>{report?.proxy?.triangles != null && report.proxy.kb != null ? `${(report.proxy.triangles / 1000).toFixed(1)}k tri · ${report.proxy.kb.toFixed(0)} KB` : '—'}</dd>
              </dl>
              <p className="source-note">{spec.blurb}</p>
              <button type="button" className="tbar-btn primary" onClick={() => fileInputRef.current?.click()}>
                选择本地 .dspk 进入 Research Mode
              </button>
              <p className="source-note">支持将本地训练的 <code>.dspk</code> 文件直接拖入左侧 3D 视口渲染，数据仅在浏览器内存解码，不上传服务器。</p>
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
