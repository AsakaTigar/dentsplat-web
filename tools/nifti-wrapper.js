async () => {
  // tools/nifti-wrapper.js — the ONE expression the automation bridge sends to the page.
  // Everything with logic in it lives in probe-nifti-launch.js and probe-nifti.js, both of which
  // tools/probe-nifti.selftest.mjs executes against a mock first; this line only fetches, digests
  // and evals. The digest is returned so the record names the launcher bytes that actually ran.
  const r = await fetch('/probes/probe-nifti-launch.js', { cache: 'no-store' });
  if (!r.ok) return { fatal: 'launcher not served', status: r.status };
  const s = await r.text();
  const enc = new TextEncoder().encode(s);                 // bytes, not UTF-16 char count
  const dg = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(dg)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = await eval(s);
  return { launcherSha256: hex.slice(0, 32), launcherBytes: enc.length, out };
}
