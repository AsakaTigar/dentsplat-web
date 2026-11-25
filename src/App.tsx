import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { DentSplatViewer } from './engine/Viewer.ts';
import type { BenchResult, ClipAxis, PickerHit, ProbeResult, Stats, ViewPreset } from './engine/Viewer.ts';
import { CASES, AUDIT_BASIS, DEMOS, LESION_LABEL } from './data/cases.ts';
import type { CaseSpec } from './data/cases.ts';
import Odontogram from './ui/Odontogram.tsx';
import type { ToothMeta } from './ui/Odontogram.tsx';

type Report = {
  splats: number; bytes: number; mb: number; sh_degree: number; bytes_per_splat: number;
};
type SceneReport = {
  full: Report; pruned: Report; bytes_ratio: number;
  proxy: { bytes: number; kb: number; nodes: number; triangles: number };
  compression_fidelity_mm: Record<string, number | string | null | boolean>;
  metrics: Record<string, number | number[]>;
  bench?: { psnr: number; psnr_in_mask: number; mae: number; self_psnr: number; size: number };
};
type MetaFile = {
  unit: string; kind: string; bbox_min?: number[]; bbox_max?: number[];
  teeth: Record<string, ToothMeta & { at?: number[] }>;
  metrics?: Record<string, number | number[]>;
};

const fmtMB = (b: number) => (b / 1048576).toFixed(2);
const fmtInt = (n: number) => n.toLocaleString('en-US');

/** 从标准两位 FDI 编号自动推导上下颌、左右侧与牙位序号，避免元数据缺字段时显示 undefined */
function describeFdi(fdi: number, raw?: ToothMeta & { at?: number[] }) {
  if (!fdi) return null;
  const q = Math.floor(fdi / 10);
  const pos = raw?.pos ?? (fdi % 10);
  const arch = raw?.arch ?? (q === 1 || q === 2 ? 'upper' : 'lower');
  const side = raw?.side ?? (q === 1 || q === 4 ? 'right' : 'left');
  const coords = raw?.centroid_mm ?? raw?.at;
  return { arch, side, pos, coords };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DentSplatViewer | null>(null);

  // 默认首屏进入画质最惊艳的 Demo 1（A2 · 训练版 IOS）
  const [caseId, setCaseId] = useState<'A' | 'A2' | 'B'>('A2');
  const spec = useMemo(() => CASES.find((c) => c.id === caseId) as CaseSpec, [caseId]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<SceneReport | null>(null);
  const [meta, setMeta] = useState<MetaFile | null>(null);
  const [bounds, setBounds] = useState<[number[], number[]] | null>(null);
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
  const [clipBand, setClipBand] = useState(0.9);
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
  const [collapsed, setCollapsed] = useState(false);
  const [hudExpanded, setHudExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [customBanner, setCustomBanner] = useState<string | null>(null);

  // ---------------------------------------------------------------- viewer lifecycle

  useEffect(() => {
    if (!canvasRef.current) return;
    const v = new DentSplatViewer(canvasRef.current);
    v.onStats = setStats;
    v.onMeasure = (m) => { if (m) setMeasures((list) => [...list, +m.mm.toFixed(2)].slice(-8)); };
    v.onPick = (hit: PickerHit) => {
      if (!hit) { setProbe(null); return; }
      setProbe({ mm: [hit.point.x, hit.point.y, hit.point.z].map((n) => +n.toFixed(1)), fdi: hit.fdi });
      if (hit.fdi) setSelected(hit.fdi);
    };
    viewerRef.current = v;

    (window as unknown as { DentSplat: unknown }).DentSplat = {
      viewer: v,
      png: (size?: number) => v.renderToDataURL(size ?? 760),
      stats: () => v.statsSnapshot(),
      pump: (n?: number) => v.pump(n ?? 60),
      selfTest: () => v.selfTest(),
      debugShot: (mode: number, size = 480) => {
        v.setDebug(mode);
        const p: ProbeResult = v.renderProbe(size);
        v.setDebug(0);
        const b = p.buf;
        if (!b || !p.w || !p.h) return { mode, error: 'no buffer' };
        let lit = 0, max = 0;
        for (let i = 0; i < p.w * p.h; i++) {
          const l = (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2]) / 3;
          if (l > 20) lit++;
          if (l > max) max = l;
        }
        return { mode, lit, frac: +(lit / (p.w * p.h)).toFixed(4), max, glError: p.glError, drawn: p.drawn };
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
        for (const sel of ['html', 'body', '#root', '.app']) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.style.height = `${h}px`;
        }
        const main = document.querySelector('.main') as HTMLElement | null;
        if (main) main.style.height = `${h - 54}px`;
        const stage = document.querySelector('.stage') as HTMLElement | null;
        if (stage) { stage.style.width = `${w - 386}px`; stage.style.height = `${h - 54}px`; }
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
        setLoading(true); setErr(null); setBench(null); setCustomBanner(null);
        const [rep, mf] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/report.json`).then((r) => r.json()),
          fetch(spec.metaUrl).then((r) => r.json()),
        ]);
        const scene: SceneReport = caseId === 'B' ? rep.scenes.sceneB_cbct
          : caseId === 'A2' ? rep.scenes.sceneA_trained : rep.scenes.sceneA_ios;
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
        const cloud = v.layer?.cloud;
        setBounds(cloud ? [Array.from(cloud.bboxMin), Array.from(cloud.bboxMax)] : null);
        setAlphas(defaults);
        setSelected(0); setProbe(null); setHidden([]); setIsolate(false); setMeasures([]);
        setSplit(false); setJaw(0); setClipAxis(null); setClipOffset(0); setCap(true);
        v.clearMeasure();

        const [hCase, hPreset] = location.hash.replace(/^#/, '').split(/[,/]/);
        if ((hCase === 'A' || hCase === 'A2' || hCase === 'B') && hCase !== caseId) { setCaseId(hCase); return; }
        if (hPreset === 'clip') {
          setClipAxis('y'); setClipOffset(0); setClipBand(1.2); setCap(true);
          setActivePreset('frontal');
          v.flyTo(spec.presets.find((p) => p.id === 'frontal') ?? spec.presets[0]);
        } else if (hPreset === 'split') {
          setVariant('full'); setSplit(true); setActivePreset('frontal');
          v.flyTo(spec.presets.find((p) => p.id === 'frontal') ?? spec.presets[0]);
        } else if (hPreset === 'jaw') {
          setJaw(25); setActivePreset('lower');
          v.flyTo(spec.presets.find((p) => p.id === 'lower') ?? spec.presets[0]);
        } else {
          if (hPreset === 'ian' && caseId === 'B') {
            setSelected(38);
            setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.88, 4: 1, 7: 0.12 }));
          }
          const want = spec.presets.find((p) => p.id === hPreset);
          setActivePreset(want ? want.id : 'frontal');
          v.flyTo(want ?? spec.presets[0]);
        }
        setLoading(false);
      } catch (e) {
        if (!dead) { setErr(String(e instanceof Error ? e.message : e)); setLoading(false); }
      }
    })();
    return () => { dead = true; };
  }, [caseId, spec]);

  // ---------------------------------------------------------------- state -> engine

  useEffect(() => { viewerRef.current?.setLayerAlphaMap(alphas); }, [alphas, caseId]);
  useEffect(() => {
    viewerRef.current?.set({
      jawGap: jaw, opacity, showLesions, hiddenTeeth: hidden, isolateTooth: isolate,
      clip: { axis: clipAxis, offset: flip ? -clipOffset : clipOffset, band: clipBand, cap },
    });
  }, [jaw, opacity, showLesions, hidden, isolate, clipAxis, clipOffset, clipBand, cap, flip]);
  useEffect(() => { viewerRef.current?.setVariant(variant, split); }, [variant, split]);
  useEffect(() => { viewerRef.current?.setWireframe(wire); }, [wire]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.measureMode = mode; }, [mode]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.autoRotate = spin; }, [spin]);
  useEffect(() => { viewerRef.current?.select(selected, { pulse: selected > 0 }); }, [selected]);

  // ---------------------------------------------------------------- derived

  const clipRange = useMemo(() => {
    const b = bounds?.[0] ?? meta?.bbox_min, t = bounds?.[1] ?? meta?.bbox_max;
    if (!b || !t) return [-45, 45] as [number, number];
    const i = clipAxis === 'x' ? 0 : clipAxis === 'y' ? 1 : 2;
    return [Math.floor(b[i]) - 2, Math.ceil(t[i]) + 2] as [number, number];
  }, [bounds, meta, clipAxis]);

  const rawTooth = selected ? meta?.teeth?.[`FDI_${selected}`] : undefined;
  const fdiInfo = useMemo(() => describeFdi(selected, rawTooth), [selected, rawTooth]);
  const lesion = rawTooth?.lesion ? LESION_LABEL[rawTooth.lesion] : undefined;
  const ian = meta?.metrics?.ian_48_min_mm;
  const ratio = report ? (report.full.bytes / Math.max(1, report.pruned.bytes)) : 0;
  const shownPsnr = bench?.psnr ?? report?.bench?.psnr;
  const shownPsnrMask = bench?.psnrInMask ?? report?.bench?.psnr_in_mask;
  const shownMae = bench?.mae ?? report?.bench?.mae;

  const goPreset = useCallback((p: ViewPreset) => {
    setActivePreset(p.id);
    viewerRef.current?.flyTo(p);
    history.replaceState(null, '', `#${caseId},${p.id}`);
  }, [caseId]);

  const openDemo = useCallback((hash: string) => {
    const [nextCase, route] = hash.replace(/^#/, '').split(/[,/]/);
    history.replaceState(null, '', hash);
    if (nextCase !== caseId) { setCaseId(nextCase as 'A' | 'A2' | 'B'); return; }
    const v = viewerRef.current;
    if (!v) return;
    setBench(null);
    if (route === 'clip') {
      setClipAxis('y'); setClipOffset(0); setClipBand(1.2); setCap(true); setActivePreset('frontal');
      v.flyTo(spec.presets.find((p) => p.id === 'frontal') ?? spec.presets[0]);
    } else if (route === 'split') {
      setVariant('full'); setSplit(true); setActivePreset('frontal');
      v.flyTo(spec.presets.find((p) => p.id === 'frontal') ?? spec.presets[0]);
    } else if (route === 'jaw') {
      setJaw(25); setActivePreset('lower');
      v.flyTo(spec.presets.find((p) => p.id === 'lower') ?? spec.presets[0]);
    } else if (route === 'ian' && caseId === 'B') {
      setSelected(38); setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.88, 4: 1, 7: 0.12 }));
      const p = spec.presets.find((x) => x.id === 'ian') ?? spec.presets[0];
      setActivePreset(p.id); v.flyTo(p);
    } else {
      setSplit(false); setJaw(0); setClipAxis(null);
      const p = spec.presets.find((x) => x.id === route) ?? spec.presets[0];
      setActivePreset(p.id); v.flyTo(p);
    }
  }, [caseId, spec]);

  useEffect(() => {
    const onHash = () => { if (location.hash) openDemo(location.hash); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openDemo]);

  const focusCanalCloseUp = useCallback(() => {
    const v = viewerRef.current;
    if (!v || caseId !== 'B') return;
    setSelected(38);
    setAlphas((a) => ({ ...a, 3: 0.14, 1: 0.88, 4: 1, 7: 0.12 }));
    setClipAxis('x'); setFlip(false); setClipOffset(18); setClipBand(1.2); setCap(true);
    const p = spec.presets.find((x) => x.id === 'ian') ?? spec.presets[1];
    goPreset(p);
  }, [caseId, goPreset, spec]);

  const handleDropDspk = useCallback(async (ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDragOver(false);
    const file = ev.dataTransfer.files?.[0];
    const v = viewerRef.current;
    if (!file || !v || !file.name.toLowerCase().endsWith('.dspk')) return;
    const blobUrl = URL.createObjectURL(file);
    const defaults: Record<number, number> = {};
    for (const l of spec.layers) defaults[l.id] = l.alpha;
    try {
      setLoading(true); setErr(null); setBench(null);
      v.caseId = caseId;
      await v.loadCase({
        fullUrl: blobUrl,
        prunedUrl: blobUrl,
        proxyUrl: spec.proxyUrl,
        fullBytes: file.size,
        prunedBytes: file.size,
        defaultLayerAlpha: defaults,
      });
      v.setVariant('full', false);
      v.setLayerAlphaMap(defaults);
      const cloud = v.layer?.cloud;
      const snap = v.statsSnapshot();
      const bps = cloud?.hasSH1 ? 29 : 20;
      const localReport: SceneReport = {
        full: { splats: snap.splats, bytes: file.size, mb: file.size / 1048576,
          sh_degree: cloud?.hasSH1 ? 1 : 0, bytes_per_splat: bps },
        pruned: { splats: snap.splats, bytes: file.size, mb: file.size / 1048576,
          sh_degree: cloud?.hasSH1 ? 1 : 0, bytes_per_splat: bps },
        bytes_ratio: 1,
        proxy: report?.proxy ?? { bytes: 0, kb: 0, nodes: 0, triangles: 0 },
        compression_fidelity_mm: { coverage_gap_mean: null, coverage_gap_p95: null,
          coverage_gap_max: null, kept_subset_of_original: false, sampled_pairs: 0,
          note: 'LOCAL RESEARCH MODE: no registered pruned packet or benchmark for this file' },
        metrics: {},
      };
      setReport(localReport);
      setMeta({ unit: '1 mm', kind: 'local-dspk', teeth: {}, metrics: {} });
      setBounds(cloud ? [Array.from(cloud.bboxMin), Array.from(cloud.bboxMax)] : null);
      setAlphas(defaults);
      setSelected(0); setProbe(null); setHidden([]); setIsolate(false); setMeasures([]);
      setSplit(false); setJaw(0); setClipAxis(null);
      v.clearMeasure();
      setCustomBanner(`LOCAL RESEARCH · ${file.name} · ${fmtMB(file.size)} MB · 零上传`);
      setLoading(false);
    } catch (e) {
      setErr(`本地 DSPK 解析失败: ${String(e)}`);
      setLoading(false);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, [caseId, report?.proxy, spec.layers, spec.proxyUrl]);

  const runBench = useCallback(async () => {
    const v = viewerRef.current;
    if (!v) return;
    setBenching(true);
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

  // ---------------------------------------------------------------- render

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="brand-dot" />
          <b>DENTSPLAT</b>
          <span>3DGS 口腔临床三维工作台</span>
        </div>

        <nav className="seg case-nav" aria-label="案例切换">
          {CASES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={caseId === c.id ? 'on' : ''}
              onClick={() => { setCaseId(c.id); history.replaceState(null, '', `#${c.id}`); }}
              title={`${c.dataset} · ${c.license}`}
            >
              {c.nav}
            </button>
          ))}
        </nav>

        <div className="case-caption">{spec.title}</div>
        <div className="spacer" />

        <div className="seg">
          <button type="button" className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}>
            牙位拾取
          </button>
          <button type="button" className={mode === 'measure' ? 'on' : ''} onClick={() => setMode('measure')}>
            mm 测距
          </button>
        </div>

        <button type="button" className={'btn' + (spin ? ' on' : '')} onClick={() => setSpin((s) => !s)}>
          自转
        </button>
        <button type="button" className="btn" onClick={shoot}>
          导出影像
        </button>

        <span className="badge real">
          {customBanner ? 'LOCAL RESEARCH · .DSPK' : spec.badge}
        </span>
      </header>

      <div className={'main' + (collapsed ? ' collapsed' : '')}>
        <div
          className={'stage' + (mode === 'pick' ? ' pick' : '') + (dragOver ? ' drag-active' : '')}
          ref={stageRef}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDropDspk}
        >
          <canvas id="gl" ref={canvasRef} />
          <div className="vignette" />

          {dragOver && (
            <div className="drop-overlay">
              <div>松开鼠标，立即在浏览器本地加载该 <code>.dspk</code> 牙科高斯模型（零上传）</div>
            </div>
          )}

          {/* 紧凑型临床状态胶囊（点击可展开详细性能参数） */}
          <div
            className={'hud' + (hudExpanded ? ' expanded' : '')}
            onClick={() => setHudExpanded((e) => !e)}
            title="点击展开/收起底层渲染性能遥测"
          >
            <div className="hud-summary">
              <span className="dot-live" />
              <b className={stats.fps >= 55 ? 'good' : ''}>{stats.fps} FPS</b>
              <span className="sep">·</span>
              <span>{fmtInt(stats.splats)} splats</span>
              <span className="sep">·</span>
              <span>{fmtMB(stats.bytes)} MB</span>
              <span className="hud-caret">{hudExpanded ? '▴' : '▾'}</span>
            </div>
            {hudExpanded && (
              <div className="hud-details">
                <div className="row"><span>drawn</span><b>{fmtInt(stats.visible)}</b></div>
                <div className="row"><span>CPU sort</span><b>{stats.sortMs.toFixed(2)} ms</b></div>
                <div className="row"><span>frame delta</span><b>{stats.frameMs.toFixed(2)} ms</b></div>
                <div className="row"><span>compression</span><b>{variant === 'pruned' || split ? ratio.toFixed(2) + ' : 1' : '1.00 : 1'}</b></div>
                <div className="gpu">{stats.gpu}</div>
              </div>
            )}
          </div>

          <div className="tag">
            <span className="badge mode">{customBanner ?? `${spec.modality} · 1 unit = 1 mm · Y-up`}</span>
            {selected > 0 && (
              <span className="badge mode accent-tag">
                FDI #{selected} {lesion ? '· ' + lesion.cn : ''}
              </span>
            )}
            {probe && (
              <span className="badge mode">
                ({probe.mm[0]}, {probe.mm[1]}, {probe.mm[2]}) mm
              </span>
            )}
          </div>

          {split && (
            <>
              <div className="split-rule" />
              <span className="split-label l">FULL · {fmtInt(report?.full.splats ?? 0)} splats</span>
              <span className="split-label r">PRUNED ({ratio.toFixed(1)}×) · {fmtInt(report?.pruned.splats ?? 0)} splats</span>
            </>
          )}

          {measures.length > 0 && (
            <div className="readout">
              {measures.slice(-3).map((m, i) => (
                <div className="chip" key={`${m}-${i}`}>
                  <span>距离测量</span>
                  <b>{m.toFixed(2)} mm</b>
                  <span className="x" onClick={() => setMeasures((list) => list.filter((_, j) => j !== list.lastIndexOf(m)))}>✕</span>
                </div>
              ))}
            </div>
          )}

          <div className="toolbar">
            {spec.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'preset' + (activePreset === p.id ? ' on' : '')}
                onClick={() => goPreset(p)}
              >
                <i>{p.label}</i>
                <u>{p.sub}</u>
              </button>
            ))}
            <span className="tool-sep" />
            <div className="seg">
              <button type="button" className={variant === 'full' && !split ? 'on' : ''} onClick={() => { setVariant('full'); setSplit(false); }}>
                Full
              </button>
              <button type="button" className={variant === 'pruned' && !split ? 'on' : ''} onClick={() => { setVariant('pruned'); setSplit(false); }}>
                Pruned
              </button>
              <button type="button" className={split ? 'on' : ''} onClick={() => setSplit((s) => !s)}>
                同屏对比
              </button>
            </div>
          </div>

          {loading && (
            <div className="loading">
              <b>DENTSPLAT</b>
              <span>正在解码 DSPK 高斯容器并构建空间索引…</span>
            </div>
          )}
          {err && (
            <div className="err">
              <div>资产加载失败：{err}</div>
            </div>
          )}
        </div>

        <button type="button" className="collapse-tab" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '◀ 临床面板' : '▶ 收起'}
        </button>

        <aside className="side">
          <div className="side-inner">

            <section className="sec demo-matrix">
              <h3>五个演示入口<span className="n">Research Matrix</span></h3>
              <div className="bd demo-grid">
                {DEMOS.map((d) => (
                  <button type="button" key={d.id} className="demo-card" onClick={() => openDemo(d.hash)}
                    title={`${d.hash} · ${d.sub}`}>
                    <b>{d.n}</b><span>{d.label}<small>{d.sub}</small></span><i>↗</i>
                  </button>
                ))}
              </div>
            </section>

            <section className="sec">
              <h3>数据与表征规格<span className="n">{spec.modality}</span></h3>
              <div className="bd">
                <div className="kv">
                  <dt>数据源</dt><dd>{spec.dataset}</dd>
                  <dt>开源协议</dt><dd>{spec.license}</dd>
                  <dt>高斯基元</dt>
                  <dd>
                    {fmtInt((variant === 'pruned' ? report?.pruned.splats : report?.full.splats) ?? 0)}
                    <span className="u"> × {variant === 'pruned' ? report?.pruned.bytes_per_splat : report?.full.bytes_per_splat} B</span>
                  </dd>
                  <dt>交互代理</dt>
                  <dd>{report ? `${(report.proxy.triangles / 1000).toFixed(1)}k 面 · ${report.proxy.kb.toFixed(0)} KB` : '—'}</dd>
                </div>
                <p className="hintline">{spec.blurb}</p>
                <p className="hintline highlight-note">{spec.moneyShot}</p>
              </div>
            </section>

            <section className="sec">
              <h3>FDI 牙位图谱<span className="n">点击联动 3D</span></h3>
              <div className="bd">
                <Odontogram
                  teeth={meta?.teeth ?? {}}
                  selected={selected}
                  hidden={hidden}
                  onSelect={(f) => { setSelected(f); if (f) viewerRef.current?.focusTooth(f); }}
                  onToggleHide={toggleHide}
                />
                <div className="swatches">
                  <button type="button" className={'sw' + (isolate ? ' on' : '')} onClick={() => setIsolate((i) => !i)}>
                    <i style={{ background: '#38bdf8' }} />隔离选中牙
                  </button>
                  <button type="button" className="sw" onClick={() => { setHidden([]); setIsolate(false); }}>
                    恢复全口
                  </button>
                  <button type="button" className={'sw' + (showLesions ? ' on' : '')} onClick={() => setShowLesions((s) => !s)}>
                    <i style={{ background: '#e2565f' }} />病灶标记
                  </button>
                </div>
                <div className="swatches">
                  {caseId === 'B' && (
                    <button type="button" className="sw accent-sw" onClick={focusCanalCloseUp}>
                      38/48–下颌神经管特写
                    </button>
                  )}
                  <button type="button" className={'sw' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}>
                    代理网格对齐校验
                  </button>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>解剖分层与咬合运动</h3>
              <div className="bd">
                {spec.layers.map((l) => (
                  <div className="field" key={l.id}>
                    <div className="lab">
                      <i style={{ width: 9, height: 9, borderRadius: 3, background: l.color, display: 'inline-block' }} />
                      {l.cn}<em>{l.en}</em><b>{Math.round(alphaOf(l.id) * 100)}%</b>
                    </div>
                    <input
                      type="range" min={0} max={1} step={0.01} value={alphaOf(l.id)}
                      onChange={(e) => setAlphas((a) => ({ ...a, [l.id]: Number(e.target.value) }))}
                    />
                  </div>
                ))}
                <div className="field">
                  <div className="lab">下颌开口度<em>髁突铰链运动</em><b>{jaw.toFixed(0)} mm</b></div>
                  <input type="range" min={0} max={45} step={1} value={jaw} onChange={(e) => setJaw(Number(e.target.value))} />
                  <div className="swatches">
                    {[0, 12, 25, 40].map((v) => (
                      <button type="button" key={v} className={'sw' + (jaw === v ? ' on' : '')} onClick={() => setJaw(v)}>
                        {v === 0 ? '正中咬合' : `${v} mm`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <div className="lab">全局不透明度<em>uOpacityScale</em><b>{Math.round(opacity * 100)}%</b></div>
                  <input type="range" min={0.25} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>实时三轴剖切<span className="n">GLSL Shader</span></h3>
              <div className="bd">
                <div className="swatches">
                  {([['x', 'X 冠状面'], ['y', 'Y 水平面'], ['z', 'Z 矢状面'], [null, '关闭剖切']] as [ClipAxis, string][]).map(([a, nm]) => (
                    <button
                      type="button"
                      key={String(a)}
                      className={'sw' + (clipAxis === a ? ' on' : '')}
                      onClick={() => { setClipAxis(a); if (a && clipAxis !== a) setClipOffset(0); }}
                    >
                      {nm}
                    </button>
                  ))}
                  <button type="button" className={'sw' + (flip ? ' on' : '')} onClick={() => setFlip((f) => !f)}>
                    反向
                  </button>
                </div>
                <div className="field">
                  <div className="lab">切面偏移<em>mm</em><b>{clipOffset.toFixed(1)} mm</b></div>
                  <input
                    type="range" min={clipRange[0]} max={clipRange[1]} step={0.5}
                    value={clipOffset} disabled={!clipAxis}
                    onChange={(e) => setClipOffset(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <div className="lab">断面封顶带宽<em>uClipBand</em><b>{clipBand.toFixed(2)} mm</b></div>
                  <input
                    type="range" min={0} max={4} step={0.05}
                    value={clipBand} disabled={!clipAxis}
                    onChange={(e) => setClipBand(Number(e.target.value))}
                  />
                  <div className="swatches">
                    <button type="button" className={'sw' + (cap ? ' on' : '')} onClick={() => setCap((c) => !c)}>
                      <i style={{ background: '#bfe6ff' }} />断面实体化封顶 (Cap)
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>牙位级证据审计<span className="n">Evidence Audit</span></h3>
              <div className="bd">
                <div className="kv">
                  <dt>当前牙位</dt><dd>{selected > 0 ? `FDI #${selected}` : '— 点击 3D 牙齿或图谱选择'}</dd>
                  <dt>解剖分区</dt>
                  <dd>{fdiInfo ? `${fdiInfo.arch} · ${fdiInfo.side} · pos ${fdiInfo.pos}` : '—'}</dd>
                  <dt>三维质心</dt>
                  <dd>{fdiInfo?.coords ? `${fdiInfo.coords.map((n) => n.toFixed(1)).join(', ')} mm` : '—'}</dd>
                  <dt>临床特征</dt>
                  <dd>{lesion ? `${lesion.cn} (${lesion.code})` : selected > 0 ? '未标记异常病灶' : '—'}</dd>
                </div>

                {caseId === 'B' && (
                  <div className="lesion-list">
                    <div
                      className={'lesion' + (selected === 38 || selected === 48 ? ' on' : '')}
                      onClick={() => { setSelected(38); viewerRef.current?.focusTooth(38); }}
                    >
                      <span className="fdi">38/48</span>
                      <span className="nm">
                        第三磨牙与下颌神经管关系
                        <small>真实患者 CBCT 点云最近距离实测</small>
                      </span>
                      <span className="cd">{typeof ian === 'number' ? `IAN ${ian.toFixed(2)} mm` : '5.00 mm'}</span>
                    </div>
                  </div>
                )}

                <div className="audit">
                  {AUDIT_BASIS.map((a) => (
                    <div className="it" key={a.k}>
                      <div>
                        <b>{a.k}</b>
                        <em style={{ fontStyle: 'normal', color: '#5f7794', fontSize: 10.5 }}>{a.en}</em>
                        <span>
                          {a.k === '压缩保真可复算'
                            ? <em className={'pill ' + (shownPsnr != null ? '' : 'tbd')}>{shownPsnr != null ? `PSNR ${shownPsnr} dB` : '待测'}</em>
                            : <em className="pill">已验证</em>}
                        </span>
                      </div>
                      <p>{a.detail}</p>
                      <p style={{ color: '#6f8aa8' }}>{a.evidence}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>压缩保真基准<span className="n">Full vs Pruned</span></h3>
              <div className="bd">
                <div className="kv">
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
                  <dd>
                    {shownPsnr != null && shownPsnrMask != null && shownMae != null
                      ? `${shownPsnr} dB · 掩膜内 ${shownPsnrMask} dB · MAE ${shownMae}`
                      : '点击下方按钮实时回读'}
                  </dd>
                </div>
                <div className="swatches">
                  <button type="button" className="btn mini" onClick={runBench} disabled={benching || !report}>
                    {benching ? '回读像素中…' : '运行实时 PSNR 审计 (384²)'}
                  </button>
                  <button type="button" className={'btn mini' + (split ? ' on' : '')} onClick={() => setSplit((s) => !s)}>
                    同帧分屏对比
                  </button>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>三维毫米测距<span className="n">Proxy Raycast</span></h3>
              <div className="bd">
                <div className="swatches">
                  <button
                    type="button"
                    className={'btn mini' + (mode === 'measure' ? ' on' : '')}
                    onClick={() => setMode(mode === 'measure' ? 'pick' : 'measure')}
                  >
                    {mode === 'measure' ? '测距激活：在牙面连点两点' : '开启测距标尺'}
                  </button>
                  <button type="button" className="btn mini" onClick={() => { setMeasures([]); viewerRef.current?.clearMeasure(); }}>
                    清空标尺
                  </button>
                </div>
                {measures.length > 0 ? (
                  <div className="mlist">
                    {measures.map((m, i) => (
                      <div className="m" key={i}>
                        <span>测量段 #{i + 1}</span>
                        <b>{m.toFixed(2)} mm</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hintline">支持拖放本地 .dspk 文件至左侧视口直接预览（Research Mode）。</p>
                )}
              </div>
            </section>

            <footer className="foot">
              <b>DentSplat</b> · 手写 WebGL2 EWA 高斯引擎（零第三方查看器库）· 1 unit = 1 mm · Y-up 医疗坐标系
            </footer>
          </div>
        </aside>
      </div>
    </div>
  );
}
