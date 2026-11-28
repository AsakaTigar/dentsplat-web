async () => {
  const mt = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  const settle = async (n) => { for (let i = 0; i < n; i++) { await mt(); D.pump(6); } };
  const D = window.DentSplat;
  if (!D) return { fatal: 'no handle' };
  if (!D.perf) return { fatal: 'build has no perf handle -- rebuild and hard-reload' };

  // Context that makes the numbers interpretable later: the automation window is hidden and its
  // live canvas is 428x1, so the HUD's fps/frameMs describe that degenerate buffer, not a real
  // screen. perfProbe renders offscreen at a declared size and times the frame several ways.
  const canvas = { screen: D.screen(), dpr: window.devicePixelRatio, hidden: document.hidden,
                   visState: document.visibilityState, hud: D.stats() };

  // Let the case load land before timing anything: the dspk fetch and the first sort are part of
  // what is being measured, but a half-initialised layer is not.
  await settle(10);
  const st = D.selfTest();

  const sizes = [[640, 360], [1280, 720], [1920, 1080], [2560, 1440]];
  const clickVariant = (label) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    if (!btn) return false;
    btn.click();
    return true;
  };
  // One call does one variant's sweep. The caller sets window.__perfMode to 'full' or 'pruned' and
  // reads window.__perfOut back at the end.
  const mode = window.__perfMode === 'pruned' ? 'pruned' : 'full';
  const out = (window.__perfOut = window.__perfOut || { rows: [], timer: [], meta: { canvas, caseId: D.caseId() } });
  if (mode === 'pruned') {
    if (!clickVariant('Pruned')) return { fatal: 'no Pruned control in the DOM' };
    await settle(8);
  } else if (window.__perfMode === 'full') {
    clickVariant('Full');
    await settle(6);
  }
  const rows = sizes.map(([w, h]) => ({ tag: mode, ...D.perf(w, h, w >= 1920 ? 10 : 20) }));
  out.rows.push(...rows);
  if (!rows.some((r) => r.variant === mode)) return { fatal: `viewer.variant is "${rows[0].variant}", asked for ${mode}`, rows };
  const timer = [];
  for (const [w, h] of sizes) timer.push({ tag: mode, ...(await D.perfTimer(w, h, w >= 1920 ? 10 : 20)) });
  out.timer.push(...timer);

  return {
    caseId: D.caseId(),
    mode,
    variantNow: rows[0].variant,
    canvas: out.meta.canvas,
    gpu: rows[0].gpu,
    selfTest: { box: st.box && st.box.lit, splat: st.splat && st.splat.lit,
                splatMid: st.splat && st.splat.mid, errors: [st.splat && st.splat.e0, st.splat && st.splat.e1, st.splat && st.splat.e2] },
    definition: 'perf(): gpuMs = a render serialised by a 1x1 readback; syncOnlyMs = the same readbacks with no ' +
                'render, i.e. the IPC floor; netGpuMs = gpuMs.p50 - syncOnlyMs.p50, the figure to quote. ' +
                'finishMs = the loop closed with gl.finish(); submitMs = the batch with no sync; drainMs = the ' +
                'finish after that batch -- finishMs ~= submitMs is what proves finish() is not a GPU sync here. ' +
                'sortMs = one CPU counting-sort pass; readbackFullMs = the w x h transfer behind paintedFraction ' +
                'and is not a frame time. timer[] = hardware EXT_disjoint_timer_query_webgl2 over the same pass, ' +
                'with got/unavailable/disjoint reported so a starved query set cannot read as fast.',
    perf: rows,
    timer,
  };
}
