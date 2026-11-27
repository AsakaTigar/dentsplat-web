import { useEffect, useRef, useState } from 'react';

export type Mm3 = [number, number, number];
export type MprPlane = 'axial' | 'coronal' | 'sagittal';

export type MprMeta = {
  format: string;
  case: string;
  dims: [number, number, number];
  bbox_min_mm: Mm3;
  bbox_max_mm: Mm3;
  spacing_mm: Mm3;
  hu_window?: [number, number];
  byteOffsets: { hu: number; mask: number };
  byteLengths: { hu: number; mask: number };
  mask: { packed: boolean; bits: 4 };
  validation?: Record<string, number | number[]>;
};

export type MprVolume = { meta: MprMeta; hu: Uint8Array; mask: Uint8Array };

const cache = new Map<string, Promise<MprVolume>>();

async function loadVolume(url: string): Promise<MprVolume> {
  const existing = cache.get(url);
  if (existing) return existing;
  const task = (async () => {
    const [metaRes, gzRes] = await Promise.all([
      fetch(url.replace(/\.vol\.gz$/, '.json')).then((r) => {
        if (!r.ok) throw new Error(`MPR metadata HTTP ${r.status}`);
        return r.json() as Promise<MprMeta>;
      }),
      fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`MPR volume HTTP ${r.status}`);
        // Static hosts often attach Content-Encoding: gzip to a .gz filename. In that case the
        // browser has already inflated the body; only run DecompressionStream when the HTTP
        // layer did not. This keeps the same asset working on Vite preview and GitHub Pages.
        if (r.headers.get('Content-Encoding')?.toLowerCase().includes('gzip')) return r.arrayBuffer();
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support DecompressionStream("gzip")');
        const stream = new Blob([await r.arrayBuffer()]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).arrayBuffer();
      }),
    ]);
    const raw = new Uint8Array(await gzRes);
    const { dims, byteOffsets, byteLengths } = metaRes;
    const n = dims[0] * dims[1] * dims[2];
    if (raw.length < byteOffsets.mask + byteLengths.mask) throw new Error('MPR gzip payload shorter than metadata offsets');
    const hu = raw.slice(byteOffsets.hu, byteOffsets.hu + byteLengths.hu);
    if (hu.length !== n) throw new Error(`MPR HU length ${hu.length} != ${n}`);
    const packed = raw.subarray(byteOffsets.mask, byteOffsets.mask + byteLengths.mask);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = (packed[i >> 1] >> ((i & 1) * 4)) & 0x0f;
    return { meta: metaRes, hu, mask };
  })();
  cache.set(url, task);
  return task;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const coord = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} mm`;

// The packed byte range is stored as [HU min, HU max]. Its width and midpoint are the
// initial DICOM window width and level; the same range is needed to decode a voxel after
// the user adjusts the display window.
const DEFAULT_HU_RANGE: [number, number] = [-500, 2800];
type WindowLevel = { width: number; level: number };
const DEFAULT_WINDOW_LEVEL: WindowLevel = {
  width: DEFAULT_HU_RANGE[1] - DEFAULT_HU_RANGE[0],
  level: (DEFAULT_HU_RANGE[1] + DEFAULT_HU_RANGE[0]) / 2,
};

function storedHuRange(meta: MprMeta): [number, number] {
  const range = meta.hu_window;
  return range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]
    ? range
    : DEFAULT_HU_RANGE;
}

function windowLevelFor(meta: MprMeta): WindowLevel {
  const [min, max] = storedHuRange(meta);
  return { width: max - min, level: (min + max) / 2 };
}

const MASK_COLORS: Record<number, [number, number, number, number]> = {
  1: [128, 151, 139, 0.18], // teeth: muted sage
  2: [160, 151, 134, 0.18], // bone: warm stone
  3: [157, 132, 118, 0.18], // nerve: muted clay
  4: [110, 142, 166, 0.18], // sinus: muted blue
};

type SliceProps = {
  plane: MprPlane;
  volume: MprVolume;
  cursor: Mm3;
  maskVisible: boolean;
  windowLevel: WindowLevel;
  onCursorChange: (mm: Mm3) => void;
  onWindowLevelChange: (next: WindowLevel) => void;
};

const PLANES: Record<MprPlane, { label: string; fixed: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2; fixedName: string }> = {
  axial: { label: 'AXIAL', fixed: 1, u: 0, v: 2, fixedName: 'Y' },
  coronal: { label: 'CORONAL', fixed: 2, u: 0, v: 1, fixedName: 'Z' },
  sagittal: { label: 'SAGITTAL', fixed: 0, u: 2, v: 1, fixedName: 'X' },
};

const ORIENTATION: Record<MprPlane, { top: string; right: string; bottom: string; left: string }> = {
  axial: { top: 'A', right: 'L', bottom: 'P', left: 'R' },
  coronal: { top: 'S', right: 'L', bottom: 'I', left: 'R' },
  sagittal: { top: 'S', right: 'A', bottom: 'I', left: 'P' },
};

type WindowDrag = { pointerId: number; x: number; y: number; width: number; level: number };

function MprSlice({ plane, volume, cursor, maskVisible, windowLevel, onCursorChange, onWindowLevelChange }: SliceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const windowDrag = useRef<WindowDrag | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const { meta } = volume;
  const spec = PLANES[plane];
  const [nx, ny, nz] = meta.dims;
  const dims = [nx, ny, nz];
  const w = dims[spec.u], h = dims[spec.v];
  const index = (x: number, y: number, z: number) => (x * ny + y) * nz + z;
  const fixedIndex = clamp(Math.round((cursor[spec.fixed] - meta.bbox_min_mm[spec.fixed]) / meta.spacing_mm[spec.fixed]), 0, dims[spec.fixed] - 1);
  const ui = clamp(Math.round((cursor[spec.u] - meta.bbox_min_mm[spec.u]) / meta.spacing_mm[spec.u]), 0, w - 1);
  const vi = clamp(Math.round((cursor[spec.v] - meta.bbox_min_mm[spec.v]) / meta.spacing_mm[spec.v]), 0, h - 1);
  const crossRow = h - 1 - vi;
  const crossX = w > 1 ? (ui / (w - 1)) * 100 : 50;
  const crossY = h > 1 ? (crossRow / (h - 1)) * 100 : 50;
  const physicalWidthMm = Math.max(0, meta.bbox_max_mm[spec.u] - meta.bbox_min_mm[spec.u]);
  const scaleWidthPx = physicalWidthMm > 0 ? viewportWidth * (10 / physicalWidthMm) : 0;
  const crosshairStyle = {
    '--mpr-cross-x': `${crossX}%`,
    '--mpr-cross-y': `${crossY}%`,
  } as React.CSSProperties;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setViewportWidth(canvas.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const [storedMin, storedMax] = storedHuRange(meta);
    const storedSpan = storedMax - storedMin;
    const displayMin = windowLevel.level - windowLevel.width / 2;
    const grayLut = new Uint8Array(256);
    for (let q = 0; q < 256; q++) {
      const hu = storedMin + (q / 255) * storedSpan;
      grayLut[q] = Math.round(clamp((hu - displayMin) / windowLevel.width, 0, 1) * 255);
    }
    for (let row = 0; row < h; row++) {
      const vi = h - 1 - row; // radiological convention: +Y/+Z points up on screen
      for (let col = 0; col < w; col++) {
        const p = [0, 0, 0];
        p[spec.u] = col;
        p[spec.v] = vi;
        p[spec.fixed] = fixedIndex;
        const i = index(p[0], p[1], p[2]);
        const g = grayLut[volume.hu[i]];
        let r = g, gr = g, b = g;
        if (maskVisible) {
          const c = MASK_COLORS[volume.mask[i]];
          if (c) {
            r = Math.round(g * (1 - c[3]) + c[0] * c[3]);
            gr = Math.round(g * (1 - c[3]) + c[1] * c[3]);
            b = Math.round(g * (1 - c[3]) + c[2] * c[3]);
          }
        }
        const o = (row * w + col) * 4;
        img.data[o] = r; img.data[o + 1] = gr; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [cursor, fixedIndex, h, index, maskVisible, meta, spec, volume, w, windowLevel]);

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = clamp(Math.round(((e.clientX - r.left) / r.width) * (w - 1)), 0, w - 1);
    const row = clamp(Math.round(((e.clientY - r.top) / r.height) * (h - 1)), 0, h - 1);
    const next: Mm3 = [...cursor];
    next[spec.u] = meta.bbox_min_mm[spec.u] + col * meta.spacing_mm[spec.u];
    next[spec.v] = meta.bbox_min_mm[spec.v] + (h - 1 - row) * meta.spacing_mm[spec.v];
    onCursorChange(next);
  };

  return (
    <div className="mpr-slice" data-plane={plane}>
      <div className="mpr-slice-head">
        <b>{spec.label}</b>
        <span className="mpr-slice-position">{spec.fixedName} {coord(cursor[spec.fixed])}</span>
        <div className="mpr-window-level" title="Right-drag: horizontal adjusts window width; vertical adjusts window level">
          <span>W {Math.round(windowLevel.width)}</span>
          <span>L {Math.round(windowLevel.level)}</span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        data-mpr-canvas={plane}
        onPointerDown={(e) => {
          if (e.button === 2) {
            e.preventDefault();
            windowDrag.current = {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              width: windowLevel.width,
              level: windowLevel.level,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
          if (e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          move(e);
        }}
        onPointerMove={(e) => {
          const drag = windowDrag.current;
          if (drag && drag.pointerId === e.pointerId) {
            const sensitivity = Math.max(1, drag.width / 200);
            onWindowLevelChange({
              width: Math.max(1, drag.width + (e.clientX - drag.x) * sensitivity),
              level: drag.level - (e.clientY - drag.y) * sensitivity,
            });
            return;
          }
          if (dragging.current) move(e);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          windowDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => { dragging.current = false; windowDrag.current = null; }}
        onLostPointerCapture={() => { dragging.current = false; windowDrag.current = null; }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          e.preventDefault();
          const d = Math.sign(e.deltaY);
          const next: Mm3 = [...cursor];
          next[spec.fixed] = meta.bbox_min_mm[spec.fixed] + clamp(fixedIndex + d, 0, dims[spec.fixed] - 1) * meta.spacing_mm[spec.fixed];
          onCursorChange(next);
        }}
      />
      <div className="mpr-crosshair" style={crosshairStyle} aria-hidden="true" />
      <div className="mpr-orientation" aria-hidden="true">
        <span className="mpr-orientation-top">{ORIENTATION[plane].top}</span>
        <span className="mpr-orientation-right">{ORIENTATION[plane].right}</span>
        <span className="mpr-orientation-bottom">{ORIENTATION[plane].bottom}</span>
        <span className="mpr-orientation-left">{ORIENTATION[plane].left}</span>
      </div>
      {scaleWidthPx > 0 && (
        <div className="mpr-scale" style={{ width: `${scaleWidthPx}px` }} role="img" aria-label="10 millimetre scale">
          <span>10 mm</span><i />
        </div>
      )}
      <div className="mpr-slice-foot">Scroll: slices · Left-drag: locate · Right-drag: window</div>
    </div>
  );
}

type Props = {
  cursorMm: Mm3;
  onCursorChange: (mm: Mm3) => void;
  maskVisible: boolean;
  onMaskVisibleChange: (v: boolean) => void;
};

export default function MprQuadView({ cursorMm, onCursorChange, maskVisible, onMaskVisibleChange }: Props) {
  const [volume, setVolume] = useState<MprVolume | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowLevel, setWindowLevel] = useState<WindowLevel>(DEFAULT_WINDOW_LEVEL);
  useEffect(() => {
    let dead = false;
    void loadVolume(`${import.meta.env.BASE_URL}assets/case0095_mpr.vol.gz`).then((v) => {
      if (!dead) {
        setVolume(v);
        setWindowLevel(windowLevelFor(v.meta));
      }
    }).catch((e) => { if (!dead) setError(String(e)); });
    return () => { dead = true; };
  }, []);

  const change = (mm: Mm3) => {
    if (!volume) return;
    const next = mm.map((v, k) => clamp(v, volume.meta.bbox_min_mm[k], volume.meta.bbox_max_mm[k])) as Mm3;
    onCursorChange(next);
  };

  return (
    <div className="mpr-slices" data-mpr-ready={!!volume} data-cursor-mm={cursorMm.map((v) => v.toFixed(3)).join(',')}>
      <div className="mpr-toolbar">
        <b>MPR · RAW CBCT</b>
        <span>{volume ? `${volume.meta.dims.join('×')} · ${volume.meta.spacing_mm.map((x) => x.toFixed(2)).join('/')} mm` : 'Decompressing…'}</span>
        <label><input type="checkbox" checked={maskVisible} onChange={(e) => onMaskVisibleChange(e.target.checked)} />Semantic mask</label>
      </div>
      {volume ? (
        <div className="mpr-slice-grid">
          {(['axial', 'coronal', 'sagittal'] as MprPlane[]).map((p) => (
            <MprSlice
              key={p}
              plane={p}
              volume={volume}
              cursor={cursorMm}
              maskVisible={maskVisible}
              windowLevel={windowLevel}
              onCursorChange={change}
              onWindowLevelChange={setWindowLevel}
            />
          ))}
        </div>
      ) : (
        <div className={'mpr-status' + (error ? ' err' : '')}>{error ? `MPR load failed: ${error}` : 'Decompressing real CBCT volume…'}</div>
      )}
    </div>
  );
}
