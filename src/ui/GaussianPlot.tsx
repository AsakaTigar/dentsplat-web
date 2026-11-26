import { useEffect, useRef } from 'react';
import type { Vec3 } from '../engine/gaussian.ts';

const COLORS = ['#ef4444', '#22c55e', '#38bdf8'];

export default function GaussianPlot({ sigmas, unit = 'mm' }: { sigmas: Vec3; unit?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = 268, h = 96;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 8, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxSigma = Math.max(...sigmas, 1e-5);
    const xMax = maxSigma * 3;
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    for (let k = 1; k <= 4; k++) {
      const x = padL + plotW * k / 5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    }
    const y0 = padT + plotH;
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(w - padR, y0); ctx.stroke();
    for (let axis = 0; axis < 3; axis++) {
      const sigma = Math.max(1e-5, sigmas[axis]);
      ctx.strokeStyle = COLORS[axis];
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let px = 0; px <= plotW; px += 1) {
        const x = ((px / plotW) * 2 - 1) * xMax;
        const y = Math.exp(-(x * x) / (2 * sigma * sigma));
        const py = padT + plotH * (1 - y);
        if (px === 0) ctx.moveTo(padL + px, py); else ctx.lineTo(padL + px, py);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(148,163,184,0.8)';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.fillText(`x ∈ ±${xMax.toFixed(2)} ${unit} · G(t)=exp(-t²/2σ²)`, padL, h - 3);
  }, [sigmas, unit]);
  return <canvas ref={ref} className="gauss-plot" aria-label="Gaussian decay curves" />;
}
