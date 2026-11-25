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
type SceneReport = { full: Report; pruned: Report; bytes_ratio: number; proxy: { bytes: number; kb: number; nodes: number; triangles: number };
  compression_fidelity_mm: Record<string, number | string>; metrics: Record<string, number | number[]> };
type MetaFile = { unit: string; kind: string; bbox_min: number[]; bbox_max: number[]; teeth: Record<string, ToothMeta>; metrics: Record<string, number | number[]> };

const fmtMB = (b: number) => (b / 1048576).toFixed(2);
const fmtInt = (n: number) => n.toLocaleString('en-US');

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DentSplatViewer | null>(null);

  const [caseId, setCaseId] = useState<'A' | 'B'>('A');
  const spec = useMemo(() => CASES.find((c) => c.id === caseId) as CaseSpec, [caseId]);

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
    // Scriptable handle: used by the automated visual check and the 60-second demo capture.
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
      // Read-only introspection used by the automated end-to-end check (see tools/verify-ui.mjs).
      caseId: () => v.caseId,
      /** Throughput at a stated resolution: the only FPS number that is meaningful in a hidden
       *  automation window, where the live canvas is 428x1 and its frame delta measures nothing.
       *  Carries its own measurement definition (method, submit/drain controls) in the payload. */
      perf: (w?: number, h?: number, iters?: number) => v.perfProbe(w ?? 1280, h ?? 720, iters ?? 25),
      /** Async sibling of perf(): hardware GL timer, which is the number a reviewer should quote. */
      perfTimer: (w?: number, h?: number, iters?: number) => v.perfTimerProbe(w ?? 1280, h ?? 720, iters ?? 20),
      /** The Full-vs-Pruned pixel comparison behind the compression card. Exposed next to the button
       *  so a capture run can prove the number in the DOM is the number the engine returned. */
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
          // centre of the local box, taken to world by hand so this hook needs no THREE import
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
      // A hidden automation tab reports a 0-height layout; pin the box so resize() is meaningful.
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
        setLoading(true); setErr(null); setBench(null);
        const [rep, mf] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/report.json`).then((r) => r.json()),
          fetch(spec.metaUrl).then((r) => r.json()),
        ]);
        const scene: SceneReport = caseId === 'A' ? rep.scenes.sceneA_ios : rep.scenes.sceneB_cbct;
        v.caseId = caseId;
        const defaults: Record<number, number> = {};
        for (const l of spec.layers) defaults[l.id] = l.alpha;
        await v.loadCase({          fullUrl: spec.fullUrl, prunedUrl: spec.prunedUrl, proxyUrl: spec.proxyUrl,
          fullBytes: scene.full.bytes, prunedBytes: scene.pruned.bytes, defaultLayerAlpha: defaults,
        });
        if (dead) return;
        setReport(scene);
        setMeta(mf as MetaFile);
        setAlphas(defaults);
        setSelected(0); setProbe(null); setHidden([]); setIsolate(false); setMeasures([]);
        v.clearMeasure();
        setActivePreset('frontal');
        v.flyTo(spec.presets[0]);
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
    viewerRef.current?.set({ jawGap: jaw, opacity, showLesions, hiddenTeeth: hidden, isolateTooth: isolate,
      clip: { axis: clipAxis, offset: flip ? -clipOffset : clipOffset, band: clipBand, cap } });
  }, [jaw, opacity, showLesions, hidden, isolate, clipAxis, clipOffset, clipBand, cap, flip]);
  useEffect(() => { viewerRef.current?.setVariant(variant, split); }, [variant, split]);
  useEffect(() => { viewerRef.current?.setWireframe(wire); }, [wire]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.measureMode = mode; }, [mode]);
  useEffect(() => { if (viewerRef.current) viewerRef.current.autoRotate = spin; }, [spin]);
  useEffect(() => { viewerRef.current?.select(selected, { pulse: selected > 0 }); }, [selected]);

  // ---------------------------------------------------------------- derived

  const clipRange = useMemo(() => {
    const b = meta?.bbox_min, t = meta?.bbox_max;
    if (!b || !t) return [-40, 40] as [number, number];
    const i = clipAxis === 'x' ? 0 : clipAxis === 'y' ? 1 : 2;
    return [Math.floor(b[i]) - 2, Math.ceil(t[i]) + 2] as [number, number];
  }, [meta, clipAxis]);

  const tooth = selected ? meta?.teeth?.[`FDI_${selected}`] : undefined;
  const lesion = tooth?.lesion ? LESION_LABEL[tooth.lesion] : undefined;
  const ian = meta?.metrics?.ian_48_min_mm;
  const ratio = report ? (report.full.bytes / Math.max(1, report.pruned.bytes)) : 0;

  const goPreset = useCallback((p: ViewPreset) => {
    setActivePreset(p.id);
    viewerRef.current?.flyTo(p);
  }, []);

  const moneyShot = useCallback(() => {
    const v = viewerRef.current;
    if (!v || caseId !== 'B') return;
    setSelected(48);
    setAlphas((a) => ({ ...a, 3: 0.16, 1: 0.85, 6: 1, 4: 1, 7: 0.12 }));
    setClipAxis('x'); setFlip(false); setClipOffset(-14); setClipBand(1.4); setCap(true);
    const p = spec.presets.find((x) => x.id === 'ian') ?? spec.presets[1];
    goPreset(p);
  }, [caseId, goPreset, spec]);

  const runBench = useCallback(async () => {
    const v = viewerRef.current;
    if (!v) return;
    setBenching(true);
    try {
      // Two frames of settling so the comparison does not race a half-updated sort. On a visible
      // screen rAF is the right wait, but in a hidden or minimised window rAF never fires AND Chrome
      // freezes background timers, so neither a rAF nor a setTimeout fallback can be relied on -- the
      // first two drafts both stranded this button on "回读像素中…" (and the audit card's PSNR on
      // 待测) exactly when an automated capture, or a demo with the tab in the background, runs it.
      // Viewer.pump() renders frames synchronously off the rAF loop, so it is the hidden-window path.
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
    a.download = `dentsplat_case${caseId}_${Date.now()}.png`;
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
        <div className="brand"><b>DENTSPLAT</b><span>口腔 3DGS 临床原型 · browser-native</span></div>
        <div className="seg">
          {CASES.map((c) => (
            <button key={c.id} type="button" className={caseId === c.id ? 'on' : ''} onClick={() => setCaseId(c.id)}
              title={`${c.dataset} · ${c.license}`}>
              {c.nav} · {c.modality.split(' ')[0]}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: '#7c8ca8', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {spec.title}
        </div>
        <div className="spacer" />
        <div className="seg">
          <button type="button" className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}>牙位拾取</button>
          <button type="button" className={mode === 'measure' ? 'on' : ''} onClick={() => setMode('measure')}>mm 测量</button>
        </div>
        <button type="button" className={'btn' + (spin ? ' on' : '')} onClick={() => setSpin((s) => !s)}>自转</button>
        <button type="button" className="btn" onClick={shoot}>截图</button>
        {/* Scene A is a real intra-oral scan (Poseidon3D, CC BY 4.0) whose colours are procedural
            because the STL carries no texture; Scene B is still synthetic. One badge that says which,
            rather than a single label that is wrong for one of the two. */}
        <span className={'badge' + (report ? '' : ' mode')}>
          {caseId === 'A' ? 'REAL SCAN · CC BY 4.0' : 'REAL CBCT · CC BY 4.0'}
        </span>
      </header>

      <div className={'main' + (collapsed ? ' collapsed' : '')}>
        <div className={'stage' + (mode === 'pick' ? ' pick' : '')} ref={stageRef}>
          <canvas id="gl" ref={canvasRef} />
          <div className="vignette" />

          <div className="hud">
            <div className="row"><span>FPS</span><b className={stats.fps >= 55 ? 'good' : stats.fps < 30 ? 'bad' : ''}>{stats.fps}</b></div>
            <div className="row"><span>splats</span><b>{fmtInt(stats.splats)}</b></div>
            <div className="row"><span>drawn</span><b>{fmtInt(stats.visible)}</b></div>
            <div className="row"><span>sort</span><b>{stats.sortMs.toFixed(2)} ms</b></div>
            <div className="row"><span>frame</span><b>{stats.frameMs.toFixed(2)} ms</b></div>
            <div className="row"><span>payload</span><b>{fmtMB(stats.bytes)} MB</b></div>
            <div className="row"><span>vs Full</span><b>{variant === 'pruned' || split ? ratio.toFixed(2) + ' : 1' : '1.00 : 1'}</b></div>
            <div className="gpu">{stats.gpu}</div>
          </div>

          <div className="tag">
            <span className="badge mode">{spec.modality} · 1 unit = 1 mm · Y-up</span>
            {selected > 0 && <span className="badge mode">FDI {selected} {lesion ? '· ' + lesion.cn : ''}</span>}
            {probe && <span className="badge mode">x {probe.mm[0]} · y {probe.mm[1]} · z {probe.mm[2]} mm</span>}
          </div>

          {split && <><div className="split-rule" /><span className="split-label l">FULL {fmtInt(report?.full.splats ?? 0)}</span>
            <span className="split-label r">PRUNED {fmtInt(report?.pruned.splats ?? 0)}</span></>}

          {measures.length > 0 && (
            <div className="readout">
              {measures.slice(-3).map((m, i) => (
                <div className="chip" key={`${m}-${i}`}><span>segment</span><b>{m.toFixed(2)} mm</b>
                  <span className="x" onClick={() => setMeasures((list) => list.filter((_, j) => j !== list.lastIndexOf(m)))}>✕</span></div>
              ))}
            </div>
          )}

          <div className="toolbar">
            {spec.presets.map((p) => (
              <button key={p.id} type="button" className={'preset' + (activePreset === p.id ? ' on' : '')} onClick={() => goPreset(p)}>
                <i>{p.label}</i><u>{p.sub}</u>
              </button>
            ))}
            {caseId === 'B' && <><span className="tool-sep" />
              <button type="button" className="btn warn" onClick={moneyShot} title="48 牙根与下牙槽神经管的最小距离">48–IAN .money shot</button></>}
            <span className="tool-sep" />
            <button type="button" className={'btn' + (wire ? ' on' : '')} onClick={() => setWire((w) => !w)}
              title="叠加隐形代理网格线框：线框若逐颗贴合 3DGS，即证明语义索引零误差">对齐校验线框</button>
            <div className="seg">
              <button type="button" className={variant === 'full' && !split ? 'on' : ''} onClick={() => { setVariant('full'); setSplit(false); }}>Full</button>
              <button type="button" className={variant === 'pruned' && !split ? 'on' : ''} onClick={() => { setVariant('pruned'); setSplit(false); }}>Pruned</button>
              <button type="button" className={split ? 'on' : ''} onClick={() => setSplit((s) => !s)}>Split</button>
            </div>
          </div>

          {loading && <div className="loading"><b>DENTSPLAT</b><span>解码 DSPK · 上传 splat 顶点缓冲 · 解析牙列语义…</span></div>}
          {err && <div className="err"><div>加载失败：{err}<br /><code>npm run gen</code> 先产出 public/assets/*.dspk</div></div>}
        </div>

        <button type="button" className="collapse-tab" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '◀ 临床面板' : '▶ 收起'}
        </button>

        <aside className="side">
          <div className="side-inner">

            <section className="sec">
              <h3>Case · 数据来源<span className="n">{spec.modality}</span></h3>
              <div className="bd">
                <div className="kv">
                  <dt>dataset</dt><dd>{spec.dataset}</dd>
                  <dt>licence</dt><dd>{spec.license}</dd>
                  <dt>splats</dt><dd>{fmtInt((variant === 'pruned' ? report?.pruned.splats : report?.full.splats) ?? 0)}
                    <span className="u"> × {variant === 'pruned' ? report?.pruned.bytes_per_splat : report?.full.bytes_per_splat} B</span></dd>
                  <dt>proxy</dt><dd>{report ? (report.proxy.triangles / 1000).toFixed(1) + 'k tri · ' + report.proxy.kb.toFixed(0) + ' KB (invisible)' : '—'}</dd>
                </div>
                <p className="hintline">{spec.blurb}</p>
                <p className="hintline" style={{ color: '#9fb6d2' }}>{spec.moneyShot}</p>
              </div>
            </section>

            <section className="sec">
              <h3>牙位图 FDI<span className="n">点击联动 3D</span></h3>
              <div className="bd">
                <Odontogram teeth={meta?.teeth ?? {}} selected={selected} hidden={hidden}
                  onSelect={(f) => { setSelected(f); if (f) viewerRef.current?.focusTooth(f); }}
                  onToggleHide={toggleHide} />
                <div className="swatches">
                  <button type="button" className={'sw' + (isolate ? ' on' : '')} onClick={() => setIsolate((i) => !i)}>
                    <i style={{ background: '#38bdf8' }} />隔离当前牙位</button>
                  <button type="button" className="sw" onClick={() => { setHidden([]); setIsolate(false); }}>全部显示</button>
                  <button type="button" className={'sw' + (showLesions ? ' on' : '')} onClick={() => setShowLesions((s) => !s)}>
                    <i style={{ background: '#e2565f' }} />病灶着色</button>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>咬合与分层</h3>
              <div className="bd">
                <div className="field">
                  <div className="lab">下颌开口度<em>interincisal</em><b>{jaw.toFixed(0)} mm</b></div>
                  <input type="range" min={0} max={45} step={1} value={jaw}
                    onChange={(e) => setJaw(Number(e.target.value))} />
                  <div className="swatches">
                    {[0, 12, 25, 40].map((v) => (
                      <button type="button" key={v} className={'sw' + (jaw === v ? ' on' : '')} onClick={() => setJaw(v)}>
                        {v === 0 ? '闭口' : `${v} mm`}</button>
                    ))}
                  </div>
                  <div className="hintline">下颌 splat 绕髁突铰链轴旋转并叠加下滑道移动，不是整体平移。</div>
                </div>
                {spec.layers.map((l) => (
                  <div className="field" key={l.id}>
                    <div className="lab"><i style={{ width: 9, height: 9, borderRadius: 3, background: l.color, display: 'inline-block' }} />
                      {l.cn}<em>{l.en} · L{l.id}</em><b>{Math.round(alphaOf(l.id) * 100)}%</b></div>
                    <input type="range" min={0} max={1} step={0.01} value={alphaOf(l.id)}
                      onChange={(e) => setAlphas((a) => ({ ...a, [l.id]: Number(e.target.value) }))} />
                  </div>
                ))}
                <div className="field">
                  <div className="lab">整体不透明度<em>uOpacityScale</em><b>{Math.round(opacity * 100)}%</b></div>
                  <input type="range" min={0.25} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>实时剖切<span className="n">shader-level</span></h3>
              <div className="bd">
                <div className="swatches">
                  {([['x', 'X 冠状'], ['y', 'Y 水平'], ['z', 'Z 矢状'], [null, '关闭']] as [ClipAxis, string][]).map(([a, nm]) => (
                    <button type="button" key={String(a)} className={'sw' + (clipAxis === a ? ' on' : '')}
                      onClick={() => { setClipAxis(a); if (a && clipAxis !== a) setClipOffset(0); }}>{nm}</button>
                  ))}
                  <button type="button" className={'sw' + (flip ? ' on' : '')} onClick={() => setFlip((f) => !f)}>反向</button>
                </div>
                <div className="field">
                  <div className="lab">剖切位置<em>n·p {'>'} offset 保留</em><b>{clipOffset.toFixed(1)} mm</b></div>
                  <input type="range" min={clipRange[0]} max={clipRange[1]} step={0.5} value={clipOffset} disabled={!clipAxis}
                    onChange={(e) => setClipOffset(Number(e.target.value))} />
                </div>
                <div className="field">
                  <div className="lab">断面带宽<em>uClipBand</em><b>{clipBand.toFixed(2)} mm</b></div>
                  <input type="range" min={0} max={4} step={0.05} value={clipBand} disabled={!clipAxis}
                    onChange={(e) => setClipBand(Number(e.target.value))} />
                  <div className="swatches">
                    <button type="button" className={'sw' + (cap ? ' on' : '')} onClick={() => setCap((c) => !c)}>
                      <i style={{ background: '#bfe6ff' }} />断面实体化 cap</button>
                    <span className="hintline" style={{ alignSelf: 'center' }}>
                      cap 把带内 splat 吸附并压平到平面上，按层重染牙本质/髓腔色 —— 网格渲染做不到的 3DGS 特性。</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>牙位级证据审计<span className="n">evidence audit</span></h3>
              <div className="bd">
                <div className="kv">
                  <dt>FDI</dt><dd>{selected > 0 ? selected : '— 未选择'}</dd>
                  <dt>quadrant</dt><dd>{tooth ? `${tooth.arch} · ${tooth.side} · pos ${tooth.pos}` : '—'}</dd>
                  <dt>centroid</dt><dd>{tooth?.centroid_mm ? tooth.centroid_mm.map((n) => n.toFixed(1)).join(', ') + ' mm' : '—'}</dd>
                  <dt>finding</dt><dd>{lesion ? `${lesion.cn} · ${lesion.en}` : 'no lesion flagged'}</dd>
                  <dt>grade</dt><dd>{lesion?.code ?? '—'}</dd>
                </div>
                {caseId === 'B' && (
                  <div className="lesion-list">
                    <div className={'lesion' + (selected === 48 ? ' on' : '')} onClick={() => { setSelected(48); viewerRef.current?.focusTooth(48); }}>
                      <span className="fdi">48</span>
                      <span className="nm">近中阻生智齿<small>mesioangular · 牙根与神经管关系</small></span>
                      <span className="cd">{typeof ian === 'number' ? 'IAN ' + ian.toFixed(2) + ' mm' : 'TBD'}</span>
                    </div>
                  </div>
                )}
                <div className="lesion-list">
                  {Object.entries(LESION_LABEL).filter(([k]) => Object.values(meta?.teeth ?? {}).some((t) => t.lesion === k)).map(([k, v]) => {
                    const owner = Object.values(meta?.teeth ?? {}).find((t) => t.lesion === k);
                    if (!owner) return null;
                    return (
                      <div key={k} className={'lesion' + (selected === owner.fdi ? ' on' : '')}
                        onClick={() => { setSelected(owner.fdi); viewerRef.current?.focusTooth(owner.fdi); }}>
                        <span className="fdi">{owner.fdi}</span>
                        <span className="nm">{v.cn}<small>{v.en}</small></span>
                        <span className="cd">{v.code}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="audit">
                  {AUDIT_BASIS.map((a) => (
                    <div className="it" key={a.k}>
                      <div><b>{a.k}</b><em style={{ fontStyle: 'normal', color: '#5f7794', fontSize: 10.5 }}>{a.en}</em>
                        <span>{a.k === '压缩证据' ? <em className={'pill ' + (bench ? '' : 'tbd')}>{bench ? `PSNR ${bench.psnr} dB（掩膜内 ${bench.psnrInMask}）` : '待测'}</em>
                          : <em className="pill">已实现</em>}</span></div>
                      <p>{a.detail}</p>
                      <p style={{ color: '#6f8aa8' }}>{a.evidence}</p>
                    </div>
                  ))}
                  <div className="it">
                    <div><b>数据真实性</b><em style={{ fontStyle: 'normal', color: '#5f7794', fontSize: 10.5 }}>asset provenance</em>
                      <span><em className="pill tbd">synthetic</em></span></div>
                    <p>当前 splat 由解剖度量模型程序化生成，用于验证渲染链与交互；口径、牙位、距离均取自真实统计，纹理与病灶位置为合成。</p>
                    <p style={{ color: '#6f8aa8' }}>替换真实数据无需改前端：<code>pipeline/run_case.sh</code> 产出同契约的 PLY + FDI/layer 标签，<code>tools/ply2dspk.ts</code> 转成 .dspk 覆盖同名文件即可。</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="sec">
              <h3>压缩保真<span className="n">Full vs Pruned</span></h3>
              <div className="bd">
                <div className="kv">
                  <dt>full</dt><dd>{report ? `${fmtInt(report.full.splats)} splats · ${fmtMB(report.full.bytes)} MB · SH${report.full.sh_degree}` : '—'}</dd>
                  <dt>pruned</dt><dd>{report ? `${fmtInt(report.pruned.splats)} splats · ${fmtMB(report.pruned.bytes)} MB · SH${report.pruned.sh_degree}` : '—'}</dd>
                  <dt>ratio</dt><dd>{ratio ? ratio.toFixed(2) + '× smaller' : '—'}</dd>
                  <dt>coverage gap</dt><dd>{report ? String(report.compression_fidelity_mm.coverage_gap_mean) + ' mm mean' : '—'}
                    <span className="u">{report ? ` · p95 ${report.compression_fidelity_mm.coverage_gap_p95} mm` : ''}</span></dd>
                  <dt>live PSNR</dt><dd>{bench ? `${bench.psnr} dB · 掩膜内 ${bench.psnrInMask} dB · MAE ${bench.mae}` : '—'}
                    <span className="u">{bench ? ` · ${Math.round(bench.identicalFraction * 100)}% 像素逐位相同 · 同资产重渲对照 ${bench.psnrSelf === 999 ? '逐位一致' : bench.psnrSelf + ' dB'} · 误差 top1% 占 ${Math.round(bench.errorInTop1Percent * 100)}%` : ''}</span></dd>
                </div>
                <div className="swatches">
                  <button type="button" className="btn mini" onClick={runBench} disabled={benching || !report}>
                    {benching ? '回读像素中…' : '跑一次 bench(384²)'}</button>
                  <button type="button" className={'btn mini' + (split ? ' on' : '')} onClick={() => setSplit((s) => !s)}>同帧分屏</button>
                </div>
                <p className="hintline">coverage gap 是「被剔除 splat 到保留集」的最近邻距离，衡量几何损失；PSNR/MAE 由浏览器分别渲染 Full 与 Pruned 后逐像素回读，两个指标口径不同，不互相替代。整帧 PSNR 含背景（背景逐位相同，会抬高数值），掩膜内只统计至少一侧画出了内容的像素，是更严格的口径。bench 时三次回读：Full、Pruned、再 Full —— 第三次是同资产重渲对照，逐位一致即说明读数不是排序或回读噪声。误差 top1% 接近 100% 表示差异集中在轮廓/边缘（覆盖问题），低则说明整个表面都有色差（颜色/α 问题）。sheen 在 bench 期间两侧同时关闭：Pruned 无 SH1 本来就不受 sheen 影响，开着会把功能开关算到压缩头上。窗口隐藏时 rAF 与定时器都被 Chrome 冻结，按钮走同步 pump 路径，所以后台标签页也能出数。</p>
              </div>
            </section>

            <section className="sec">
              <h3>mm 级测量<span className="n">proxy raycast</span></h3>
              <div className="bd">
                <div className="swatches">
                  <button type="button" className={'btn mini' + (mode === 'measure' ? ' on' : '')} onClick={() => setMode(mode === 'measure' ? 'pick' : 'measure')}>
                    {mode === 'measure' ? '测量中：连点两点' : '进入测量'}</button>
                  <button type="button" className="btn mini" onClick={() => { setMeasures([]); viewerRef.current?.clearMeasure(); }}>清空</button>
                </div>
                {measures.length > 0 ? (
                  <div className="mlist">
                    {measures.map((m, i) => <div className="m" key={i}><span>segment {i + 1}</span><b>{m.toFixed(2)} mm</b></div>)}
                  </div>
                ) : <p className="hintline">拾取点来自隐形代理网格的射线交点（真实 mm 表面坐标），因此与 splat 中心不重合的误差不会出现。</p>}
              </div>
            </section>

            <footer className="foot">
              <b>坐标系契约</b>：1 unit = 1 mm，Y-up，牙合平面 ∥ XZ，上颌 +Y，唇侧 +Z，放射学约定（患者右 = −X）。
              splat 语义（FDI / layer / jaw flag）编码在每个 splat 自己的字节里，剔除与压缩不会造成标签错位。<br />
              渲染器为手写 WebGL2 splatting（<code>src/engine/shaders.ts</code>），未使用任何现成 3DGS 库。
            </footer>
          </div>
        </aside>
      </div>
    </div>
  );
}
