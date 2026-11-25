async () => {
  const mt = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  const settle = async (n) => { for (let i = 0; i < n; i++) { await mt(); D.pump(3); } };
  const D = window.DentSplat;
  if (!D) return { fatal: 'no handle' };
  const V = D.viewer;
  if (!V || typeof V.setLayerAlphaMap !== 'function') return { fatal: 'viewer has no setLayerAlphaMap' };

  // Which part of the fidelity gap belongs to the codec and which part belongs to the translucent
  // shells? The synthetic packets stack enamel over dentine over pulp over a 0.24-alpha sinus lining
  // and a 0.4-alpha alveolar shell; a ray through that crosses many layers, so dropping 66% of the
  // splats changes accumulated transmittance even when every survivor is bit-identical. A real IOS
  // capture (Case A's source modality) is an opaque surface and does not have that term.
  //
  // So: hide the sub-surface layers for BOTH variants through the same uLayerAlpha uniform the sliders
  // use, re-measure, and restore. Comparing opaque-only Full vs Pruned is the number that transfers to
  // an IOS dataset; the difference between it and the all-layers number is the synthetic-stacking tax.
  const LAYER = { gingiva: 0, enamel: 1, root: 2, alveolar: 3, nerve: 4, other: 5, pulp: 6, sinus: 7, restoration: 8 };
  const OPAQUE = { [LAYER.gingiva]: 1, [LAYER.enamel]: 1, [LAYER.root]: 1, [LAYER.restoration]: 1,
    [LAYER.alveolar]: 0, [LAYER.nerve]: 0, [LAYER.other]: 0, [LAYER.pulp]: 0, [LAYER.sinus]: 0 };
  const prev = { ...(V.layerAlphas ?? {}) };
  const readRow = (label) => {
    const dt = [...document.querySelectorAll('dt')].find((n) => (n.textContent || '').trim().toLowerCase() === label);
    return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent.trim() : null;
  };
  const benchBtn = () => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').toLowerCase().includes('bench'));

  V.setLayerAlphaMap(OPAQUE);
  await settle(6);
  const src = await (await fetch('/probes/probe-bench.js', { cache: 'no-store' })).text();
  const dg = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
  const inner = await eval('(' + src + ')')();
  const opaque = inner.direct;
  V.setLayerAlphaMap(prev);
  await settle(4);
  const restored = { ...(V.layerAlphas ?? {}) };
  return {
    caseId: D.caseId(),
    innerProbeSha: [...new Uint8Array(dg)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    layersHidden: Object.entries(OPAQUE).filter(([, v]) => v === 0).map(([k]) => k),
    opaqueOnly: opaque ? { psnr: opaque.psnr, psnrInMask: opaque.psnrInMask, mae: opaque.mae,
      covered: opaque.covered, identicalFraction: opaque.identicalFraction, psnrSelf: opaque.psnrSelf } : null,
    allLayers: inner.after,
    // NOTE: `inner.after` is the DOM row of *this* run, i.e. also measured under the isolation map.
    // It is kept because it must equal opaqueOnly as rendered text (UI/engine agreement is checked by
    // probe-bench.js), not because it is an all-layers baseline -- the all-layers baseline is
    // tools/out/bench-<case>-final.json, and the two are not directly comparable because changing the
    // layer map changes which pixels are "in mask".
    rowAfterRestore: readRow('live psnr'),
    buttonLabel: benchBtn() ? benchBtn().textContent : null,
    restoredMatchesPrev: JSON.stringify(restored) === JSON.stringify(prev),
  };
}
