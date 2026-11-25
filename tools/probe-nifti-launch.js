// tools/probe-nifti-launch.js — page-side launcher for the CBCT-route probe.
//
// Same shape as dist/probes/run.js: the automation bridge evaluates ONE trivial wrapper around a
// file fetch, so every non-trivial line lives in a file that (a) has a sha the result prints and
// (b) is executed by tools/probe-nifti.selftest.mjs under the mock before it is ever sent to the
// page. The wrapper is one expression; the launcher does the work.
//
// It sets the job parameters (window.__nifti), loads tools/probe-nifti.js from the served
// directory, hashes the exact bytes it fetched, runs them, and returns the digest next to the
// result so a screenshot can be tied to these bytes.
(async () => {
  const D = window.DentSplat;
  if (!D) return { fatal: 'no DentSplat handle -- hard-reload the page' };
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  window.__nifti = Object.assign({
    full: '/assets/sceneB_from_nifti.dspk',
    pruned: null,                       // one packet only: the CBCT route has no pruned twin yet
    proxy: '/assets/proxy_B.glb',       // loadCase always fetches a proxy; this one is Scene B's mesh
    bytes: 0,                         // no expected size: the probe reports the served byte count and
                                      // content-length, and tools/nifti-report.mjs compares them with disk
    shot: 640,
  }, window.__nifti || {});
  const url = window.__nifti.probe || '/probes/probe-nifti.js';
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return { fatal: 'probe not served', url, status: r.status };
  const src = await r.text();
  const enc = new TextEncoder().encode(src);          // BYTES, not src.length: UTF-16 chars lie
  const out = {
    url, probeBytes: enc.length,
    probeSha256: hex(await crypto.subtle.digest('SHA-256', enc)).slice(0, 32),
    asset: window.__nifti.full,
    caseIdBefore: D.caseId ? D.caseId() : (D.viewer ? D.viewer.caseId : null),
  };
  const t0 = Date.now();
  try {
    const res = await eval('(' + src + ')')();
    out.wallMs = Date.now() - t0;
    out.res = res;
  } catch (e) {
    out.wallMs = Date.now() - t0;
    out.fatal = 'probe threw: ' + String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  }
  out.pngChars = window.__niftiPng ? window.__niftiPng.length : 0;
  out.bundle = performance.getEntriesByType('resource')
    .filter((e) => /index-.*\.js/.test(e.name)).map((e) => e.name.split('/').pop());
  out.dspk = performance.getEntriesByType('resource')
    .filter((e) => e.name.endsWith('.dspk'))
    .map((e) => `${e.name.split('/').pop()}=${e.encodedBodySize}`);
  return out;
})()
