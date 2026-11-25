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
  hu_window: [number, number];
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
        if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 DecompressionStream("gzip")');
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

type SliceProps = {
  plane: MprPlane;
  volume: MprVolume;
  cursor: Mm3;
  maskVisible: boolean;
  onCursorChange: (mm: Mm3) => void;
};

const PLANES: Record<MprPlane, { label: string; fixed: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2; fixedName: string }> = {
  axial: { label: 'AXIAL', fixed: 1, u: 0, v: 2, fixedName: 'Y' },
  coronal: { label: 'CORONAL', fixed: 2, u: 0, v: 1, fixedName: 'Z' },
  sagittal: { label: 'SAGITTAL', fixed: 0, u: 2, v: 1, fixedName: 'X' },
};

function MprSlice({ plane, volume, cursor, maskVisible, onCursorChange }: SliceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const { meta } = volume;
  const spec = PLANES[plane];
  const [nx, ny, nz] = meta.dims;
  const dims = [nx, ny, nz];
  const w = dims[spec.u], h = dims[spec.v];
  const index = (x: number, y: number, z: number) => (x * ny + y) * nz + z;
  const fixedIndex = clamp(Math.round((cursor[spec.fixed] - meta.bbox_min_mm[spec.fixed]) / meta.spacing_mm[spec.fixed]), 0, dims[spec.fixed] - 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const colors: Record<number, [number, number, number, number]> = {
      1: [144, 238, 144, 0.34],
      2: [206, 196, 176, 0.12],
      3: [250, 255, 80, 0.62],
      4: [120, 180, 255, 0.44],
    };
    for (let row = 0; row < h; row++) {
      const vi = h - 1 - row; // radiological convention: +Y/+Z points up on screen
      for (let col = 0; col < w; col++) {
        const p = [0, 0, 0];
        p[spec.u] = col;
        p[spec.v] = vi;
        p[spec.fixed] = fixedIndex;
        const i = index(p[0], p[1], p[2]);
        const g = volume.hu[i];
        let r = g, gr = g, b = g;
        if (maskVisible) {
          const c = colors[volume.mask[i]];
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
    const ui = clamp(Math.round((cursor[spec.u] - meta.bbox_min_mm[spec.u]) / meta.spacing_mm[spec.u]), 0, w - 1);
    const vi = clamp(Math.round((cursor[spec.v] - meta.bbox_min_mm[spec.v]) / meta.spacing_mm[spec.v]), 0, h - 1);
    const crossRow = h - 1 - vi;
    ctx.save();
    ctx.strokeStyle = '#a3e635';
    ctx.lineWidth = 1.4;
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 2;
    ctx.beginPath();
    ctx.moveTo(0, crossRow + 0.5); ctx.lineTo(w, crossRow + 0.5);
    ctx.moveTo(ui + 0.5, 0); ctx.lineTo(ui + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = '#f97316';
    ctx.beginPath(); ctx.arc(ui + 0.5, crossRow + 0.5, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }, [cursor, fixedIndex, h, index, maskVisible, meta, spec, volume, w]);

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
        <span>{spec.fixedName} {coord(cursor[spec.fixed])}</span>
      </div>
      <canvas
        ref={canvasRef}
        data-mpr-canvas={plane}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
        onPointerMove={(e) => { if (dragging.current) move(e); }}
        onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onWheel={(e) => {
          e.preventDefault();
          const d = Math.sign(e.deltaY);
          const next: Mm3 = [...cursor];
          next[spec.fixed] = meta.bbox_min_mm[spec.fixed] + clamp(fixedIndex + d, 0, dims[spec.fixed] - 1) * meta.spacing_mm[spec.fixed];
          onCursorChange(next);
        }}
      />
      <div className="mpr-slice-foot">滚轮翻片 · 拖动十字线</div>
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
  useEffect(() => {
    let dead = false;
    void loadVolume(`${import.meta.env.BASE_URL}assets/case0095_mpr.vol.gz`).then((v) => {
      if (!dead) setVolume(v);
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
        <b>MPR · 原始 CBCT</b>
        <span>{volume ? `${volume.meta.dims.join('×')} · ${volume.meta.spacing_mm.map((x) => x.toFixed(2)).join('/')} mm` : 'decompressing…'}</span>
        <label><input type="checkbox" checked={maskVisible} onChange={(e) => onMaskVisibleChange(e.target.checked)} />语义掩码</label>
      </div>
      {volume ? (
        <div className="mpr-slice-grid">
          {(['axial', 'coronal', 'sagittal'] as MprPlane[]).map((p) => (
            <MprSlice key={p} plane={p} volume={volume} cursor={cursorMm} maskVisible={maskVisible} onCursorChange={change} />
          ))}
        </div>
      ) : (
        <div className={'mpr-status' + (error ? ' err' : '')}>{error ? `MPR 加载失败：${error}` : '正在解压真实 CBCT 体数据…'}</div>
      )}
    </div>
  );
}
