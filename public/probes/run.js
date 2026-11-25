// public/probes/run.js — job runner for the recorded measurement sweeps.
//
// Lives with the shipped assets on purpose: the page fetches this file, hashes it, and prints the
// digest with every capture, so a screenshot of a number can be traced back to the exact bytes that
// produced it. Jobs are [caseId, variant] pairs queued in window.__jobs; one call drains one job.
window.__dentsplatRunner = async (kind) => {
  const mt = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  const D = window.DentSplat;
  if (!D) return { fatal: 'no DentSplat handle -- hard-reload the page' };
  const job = (window.__jobs || []).shift();
  if (!job) return { fatal: 'job queue empty', remaining: (window.__jobs || []).length };
  // The handle exposes viewer (the object) and layer (a getter *function*); D.layerAlt does not exist,
  // so a readiness test written as `D.layer && D.layerAlt` is permanently false. Ask the viewer.
  const V = D.viewer;
  const [caseId, mode] = job;
  const clickText = (t) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(t));
    if (b) b.click();
    return !!b;
  };
  const waitReady = async (limit) => {
    for (let i = 0; i < limit; i++) { await mt(); D.pump(2); if (V?.layer && V?.layerAlt && D.caseId() === caseId) return true; }
    return false;
  };
  if (D.caseId() !== caseId && !clickText('Case ' + caseId)) return { fatal: 'no Case ' + caseId + ' button', job };
  if (!(await waitReady(900))) return { fatal: 'case never became ready', job, stats: D.stats() };

  const r = await fetch('/probes/probe-' + kind + '.js', { cache: 'no-store' });
  if (!r.ok) return { fatal: 'probe not served', status: r.status, job };
  const src = await r.text();
  const dg = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
  const sha = [...new Uint8Array(dg)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const dspk = performance.getEntriesByType('resource').filter((e) => e.name.endsWith('.dspk'))
    .map((e) => `${e.name.split('/').pop()}=${e.encodedBodySize}`);

  if (kind === 'perf') { window.__perfMode = mode; window.__perfOut = undefined; }
  const t0 = Date.now();
  const res = await eval('(' + src + ')')();
  return {
    job, kind, sha, wallMs: Date.now() - t0,
    bundle: performance.getEntriesByType('resource').filter((e) => /index-.*\.js/.test(e.name)).map((e) => e.name.split('/').pop()),
    dspk, ua: navigator.userAgent.slice(0, 90), res,
  };
};
