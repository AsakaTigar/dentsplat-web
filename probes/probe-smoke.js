async () => {
  // Yield with MessageChannel, not setTimeout: background/hidden tabs clamp timers to ~1 s, and
  // one yield is not enough for React 19 to flush the effects a case switch schedules.
  const mt = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  const flush = async (n, frames) => { for (let i = 0; i < n; i++) { await mt(); if (frames) window.DentSplat.pump(frames); } };
  const D = window.DentSplat;
  if (!D) return { fatal: 'no window.DentSplat handle in this build' };
  const out = { handleKeys: Object.keys(D).sort() };
  await flush(8, 4);
  const gl = D.gl();
  const hud = () => [...document.querySelectorAll('.hud, [data-hud]')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || null;

  out.caseId = D.caseId();
  out.stats = D.stats();
  out.screen = D.screen();
  out.glError = gl.getError();
  out.hudBeforeFlush = hud();
  await flush(6, 20);
  out.hudAfterFlush = hud();
  out.truthCount = D.truth().length;
  out.badge = (() => { const n = [...document.querySelectorAll('*')].find((e) => /SYNTHETIC/i.test(e.textContent || '') && e.children.length === 0); return n ? n.textContent.trim() : null; })();

  const l = D.layer();
  out.layer = l ? { cloud: !!l.cloud, material: !!l.material, program: !!(l.material && l.material.program), uniforms: Object.keys(l.material ? l.material.uniforms : {}).sort() } : null;
  const u = D.uniforms();
  out.uniformValues = { uJawGap: u.uJawGap, uClipCount: u.uClipCount, uCapEnable: u.uCapEnable, uClipBand: u.uClipBand, uLayerAlpha: u.uLayerAlpha, uHiddenLo: u.uHiddenLo, uHiddenHi: u.uHiddenHi, uSheen: u.uSheen };

  out.selfTest = D.selfTest();

  const t0 = performance.now();
  D.pump(120);
  out.pump120Ms = +(performance.now() - t0).toFixed(1);
  out.statsAfterPump = D.stats();
  out.glErrorAfter = gl.getError();
  return out;
}
