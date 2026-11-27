import { useEffect, useRef } from 'react';
import { gaussianPdfAt, isosurfaceAmplitude, type GaussianAxes, type Vec3 } from '../engine/gaussian.ts';
import type { DentSplatViewer } from '../engine/Viewer.ts';

const COLORS = ['#ef4444', '#22c55e', '#38bdf8'];

export function ShAppearancePlot({ sh1, base }: { sh1: number[]; base: Vec3 }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = 268, h = 86;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 8, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const SH_C1 = 0.4886025119683723;
    const sample = (deg: number) => {
      const th = deg * Math.PI / 180;
      const v = [Math.sin(th), 0, Math.cos(th)];            // camera -> object reverse direction
      const dir = [v[1], -v[2], v[0]];                      // (-d.y, d.z, -d.x) in the shader
      const out = [0, 0, 0];
      for (let cch = 0; cch < 3; cch++) {
        const k = cch * 3;
        out[cch] = SH_C1 * (dir[0] * sh1[k] + dir[1] * sh1[k + 1] + dir[2] * sh1[k + 2]);
      }
      return out;
    };
    let max = 1e-6;
    for (let deg = 0; deg <= 360; deg += 4) for (const v of sample(deg)) max = Math.max(max, Math.abs(v));
    const y0 = padT + plotH / 2;
    ctx.strokeStyle = 'rgba(148,163,184,0.3)';
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(w - padR, y0); ctx.stroke();
    for (let cch = 0; cch < 3; cch++) {
      ctx.strokeStyle = COLORS[cch];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let px = 0; px <= plotW; px += 1) {
        const deg = px / plotW * 360;
        const v = sample(deg)[cch];
        const py = y0 - (v / max) * (plotH / 2 - 2);
        if (px === 0) ctx.moveTo(padL + px, py); else ctx.lineTo(padL + px, py);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(148,163,184,0.8)';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.fillText(`l=1 ΔRGB · azimuth 0–360° · |Δ|max ${max.toFixed(3)} · base ${base.map((x) => x.toFixed(2)).join('/')}`, padL, h - 3);
  }, [sh1, base]);
  return <canvas ref={ref} className="gauss-plot" aria-label="SH1 appearance across view directions" />;
}

export function ProjectionPlot({ viewer, index }: { viewer: DentSplatViewer | null; index: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !viewer) return;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = 268, h = 112;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const p = viewer.projectedGaussian(index);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      if (!p) {
        ctx.fillStyle = 'rgba(148,163,184,0.75)';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.fillText('Gaussian behind camera / no projection', 9, h / 2);
        return;
      }
      const s = Math.min((w - 18) / p.viewportPx[0], (h - 18) / p.viewportPx[1]);
      const cx = 9 + p.centerPx[0] * s, cy = 9 + p.centerPx[1] * s;
      const ax = Math.max(1.2, p.sigmaPx[0] * s), ay = Math.max(1.2, p.sigmaPx[1] * s);
      if (cx >= 0 && cx <= w && cy >= 0 && cy <= h) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(p.angleRad);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(0, 0, ax, ay, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(148,163,184,0.85)';
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.fillText(`screen 1σ ≈ ${p.sigmaPx[0].toFixed(1)} × ${p.sigmaPx[1].toFixed(1)} px · z ${p.depthMm.toFixed(1)} mm`, 8, h - 6);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [viewer, index]);
  return <canvas ref={ref} className="gauss-plot" aria-label="Live projected Gaussian ellipse" />;
}

export function GaussianDensityPlot({ center, covariance, axes, alpha, unit = 'mm' }: {
  center: Vec3; covariance: number[]; axes: GaussianAxes; alpha: number; unit?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = 268, h = 124;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 8, padB = 18;
    const pw = w - padL - padR, ph = h - padT - padB;
    const maxSigma = Math.max(...axes.sigmas, 1e-5);
    const extent = maxSigma * 3.2;
    const peak = gaussianPdfAt(center, center, covariance);
    const img = ctx.createImageData(Math.round(pw * dpr), Math.round(ph * dpr));
    const iw = img.width, ih = img.height;
    for (let py = 0; py < ih; py++) {
      const v = (1 - 2 * py / (ih - 1)) * extent;
      for (let px = 0; px < iw; px++) {
        const u = (2 * px / (iw - 1) - 1) * extent;
        const m2 = (u / Math.max(1e-6, axes.sigmas[0])) ** 2 + (v / Math.max(1e-6, axes.sigmas[1])) ** 2;
        const f = Math.exp(-0.5 * m2);
        const o = (py * iw + px) * 4;
        img.data[o] = Math.round(8 + 34 * f);
        img.data[o + 1] = Math.round(20 + 190 * f);
        img.data[o + 2] = Math.round(35 + 210 * f);
        img.data[o + 3] = 255;
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, Math.round(padL * dpr), Math.round(padT * dpr));
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    for (const rho of [1, 2, 3]) {
      ctx.beginPath();
      ctx.ellipse(
        padL + pw / 2, padT + ph / 2,
        (axes.sigmas[0] * rho / extent) * pw / 2,
        (axes.sigmas[1] * rho / extent) * ph / 2,
        0, 0, Math.PI * 2,
      );
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = '8px ui-monospace, Menlo, monospace';
      ctx.fillText(`${rho}σ`, padL + pw / 2 + (axes.sigmas[0] * rho / extent) * pw / 2 + 2, padT + ph / 2 - 2);
    }
    ctx.fillStyle = 'rgba(226,232,240,0.9)';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.fillText(`N(μ,Σ) peak ${peak.toExponential(2)} ${unit}⁻³ · α·G(0)=${alpha.toFixed(3)}`, padL, h - 5);
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    ctx.fillText(`1σ shell α=${isosurfaceAmplitude(alpha, 1).toFixed(3)} · 2σ=${isosurfaceAmplitude(alpha, 2).toFixed(3)} · 3σ=${isosurfaceAmplitude(alpha, 3).toFixed(3)}`, padL, h - 16);
  }, [center, covariance, axes, alpha, unit]);
  return <canvas ref={ref} className="gauss-plot" aria-label="3D Gaussian probability density slice and isosurfaces" />;
}

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
