// tools/probe-nifti.js — render-and-measure probe for a packet produced by the REAL chain
// (CBCT NIfTI -> toothfairy2_to_layers.py -> cbct_layers.ply -> tools/ply2dspk.ts), not by the
// synthetic generator. The page fetches this file, hashes it and prints the digest with the result,
// so every number below is traceable to these exact bytes.
//
// Input: window.__nifti = { full, pruned?, proxy, bytes?, shot? }   (proxy is mandatory: Viewer
// .loadCase always fetches one, even though the invisible mesh never reaches this probe's pixels).
//
// What it proves, and how:
//   1. LOAD     — the container decodes in the page: splat count, stride, bbox, scale range.
//   2. PROVENANCE — sha256 of the bytes the browser actually fetched, so a screenshot names the file.
//   3. SEMANTICS — the layer byte survives encode/decode: a per-code histogram taken straight out of
//      the decoded misc plane, plus per-code mean millimetres via the shader's own bbox-lerp. These
//      must equal the numbers tools/dspk-head.ts prints from the same file on disk.
//   4. ISOLATION — each layer code, alone, paints pixels of its own. That is what makes the
//      transparency sliders show anatomy instead of one grey blob.
//   5. ORIENTATION — measured, not asserted. Two layers whose model-space Y means differ a lot
//      (sinus above nerve) are rendered alone, and the mean *buffer row* of their lit pixels is
//      compared. That decides whether GL's bottom-left origin is what the pixels do here, and whether
//      the arch is upright, without trusting any comment in the source.
//   6. PICTURE — a PNG for the demo reel, in window.__niftiPng.
//
// It restores the alpha map it touched and returns the values it restored to, so a probe run cannot
// leave the page in a state that the next measurement silently inherits.
async () => {
  const D = window.DentSplat;
  if (!D) return { fatal: 'no DentSplat handle -- hard-reload the page' };
  const V = D.viewer;
  const o = window.__nifti || {};
  if (!o.full) return { fatal: 'window.__nifti.full missing' };
  if (!V || typeof V.loadCase !== 'function') return { fatal: 'viewer has no loadCase' };

  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const prevAlphas = { ...(V.layerAlphas || {}) };
  const out = { before: { caseId: V.caseId, splats: V.statsSnapshot().splats, variant: V.variant } };

  // 2: hash what the server actually sends. Doing it here (not on disk) is the only way to know the
  // bytes that produced these pixels are the bytes tools/dspk-head.ts described.
  try {
    const r = await fetch(o.full, { cache: 'no-store' });
    const ab = await r.arrayBuffer();
    out.asset = { url: o.full, status: r.status, bytes: ab.byteLength,
                  // content-length is the wire's own statement of the size. The launcher used to
                  // hardcode an expected byte count here; that constant went stale the first time the
                  // packet was rebuilt, which is exactly the failure a decorative number invites.
                  content_length: Number(r.headers.get('content-length') ?? 0) || null,
                  declared_bytes: o.bytes || null,
                  sha256: hex(await crypto.subtle.digest('SHA-256', ab)).slice(0, 32) };
  } catch (e) { out.asset = { url: o.full, error: String(e) }; }

  // 1: load it.
  const t0 = performance.now();
  await V.loadCase({
    fullUrl: o.full, prunedUrl: o.pruned || o.full, proxyUrl: o.proxy,
    fullBytes: o.bytes || 0, prunedBytes: o.bytes || 0,
  });
  out.loadMs = +(performance.now() - t0).toFixed(1);
  V.pump(4);
  const c = V.layer && V.layer.cloud;
  if (!c) return Object.assign(out, { fatal: 'no cloud after loadCase' });
  const st = V.statsSnapshot();
  out.after = {
    caseId: V.caseId, splats: c.count, altSplats: (V.layerAlt && V.layerAlt.cloud) ? V.layerAlt.cloud.count : 0,
    hasSH1: !!c.hasSH1, stride: c.hasSH1 ? 29 : 20, sortMs: st.sortMs,
    bbox: [c.bboxMin.slice(), c.bboxMax.slice()],
    extentMm: [0, 1, 2].map((k) => +(c.bboxMax[k] - c.bboxMin[k]).toFixed(2)),
    scaleMm: [+Math.exp(c.scaleLogMin).toFixed(3), +Math.exp(c.scaleLogMax).toFixed(3)],
    metaKind: c.meta ? c.meta.kind : null, frame: c.meta ? c.meta.coordinate_system : null,
    appearance: c.meta && c.meta.source ? c.meta.source.appearance : null,
  };

  // 3: semantics read back out of the decoded planes. mm() is the shader's own decode
  // (dspk.splatCenter): bboxMin + pos/65535*(bboxMax-bboxMin). misc = [alpha, FDI, layer, flags].
  const mm = (i, k) => c.bboxMin[k] + (c.pos[i * 3 + k] / 65535) * (c.bboxMax[k] - c.bboxMin[k]);
  const layerHist = {}, layerGeo = {}, fdiHist = {};
  let alphaMin = 255, alphaMax = 0, colorSet = new Set();
  for (let i = 0; i < c.count; i++) {
    const a = c.misc[i * 4], f = c.misc[i * 4 + 1], l = c.misc[i * 4 + 2];
    layerHist[l] = (layerHist[l] || 0) + 1;
    fdiHist[f] = (fdiHist[f] || 0) + 1;
    if (a < alphaMin) alphaMin = a; if (a > alphaMax) alphaMax = a;
    colorSet.add((c.color[i * 3] << 16) | (c.color[i * 3 + 1] << 8) | c.color[i * 3 + 2]);
    const g = layerGeo[l] || (layerGeo[l] = { n: 0, x: 0, y: 0, z: 0, y0: 1e9, y1: -1e9 });
    const y = mm(i, 1);
    g.n++; g.x += mm(i, 0); g.y += y; g.z += mm(i, 2);
    if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
  }
  const r2 = (v) => +v.toFixed(2);
  const geo = (g) => g && { n: g.n, mean: [r2(g.x / g.n), r2(g.y / g.n), r2(g.z / g.n)],
                            yRange: [r2(g.y0), r2(g.y1)] };
  const NAMES = { 0: 'gingiva', 1: 'enamel/teeth', 2: 'root', 3: 'alveolar', 4: 'nerve',
                  5: 'other', 6: 'pulp', 7: 'sinus', 8: 'restoration' };
  out.container = {
    layer_hist: Object.fromEntries(Object.keys(layerHist).sort().map((k) => [k + ':' + NAMES[k], layerHist[k]])),
    layer_geometry: Object.fromEntries(Object.keys(layerGeo).sort().map((k) => [k + ':' + NAMES[k], geo(layerGeo[k])])),
    teeth: (function () {
      const agg = (pred) => {
        let n = 0, x = 0, y = 0, z = 0, ids = 0;
        for (let i = 0; i < c.count; i++) {
          const f = c.misc[i * 4 + 1];
          if (!pred(f)) continue;
          ids += 1; n += 1; x += mm(i, 0); y += mm(i, 1); z += mm(i, 2);
        }
        return { teeth: ids, splats: n, mean: n ? [r2(x / n), r2(y / n), r2(z / n)] : null };
      };
      return {
        upper: agg((f) => f >= 11 && f <= 28), lower: agg((f) => f >= 31 && f <= 48),
        right: agg((f) => f > 0 && (f < 20 || f >= 40)), left: agg((f) => f >= 20 && f < 40),
        incisors: agg((f) => [11, 12, 21, 22, 31, 32, 41, 42].includes(f)),
        molars: agg((f) => [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48].includes(f)),
      };
    })(),
    distinct_fdi: Object.keys(fdiHist).filter((k) => Number(k) > 0).length,
    fdi_ids: Object.keys(fdiHist).map(Number).filter((f) => f > 0).sort((a, b) => a - b),
    alpha_byte: [alphaMin, alphaMax], distinct_colors: colorSet.size,
  };
  const C = out.container;
  C.checks = {
    all_32_teeth: C.distinct_fdi === 32,
    upper_above_lower: !!(C.teeth.upper.mean && C.teeth.lower.mean && C.teeth.upper.mean[1] > C.teeth.lower.mean[1]),
    incisors_forward: !!(C.teeth.incisors.mean && C.teeth.molars.mean && C.teeth.incisors.mean[2] > C.teeth.molars.mean[2]),
    right_side_at_minus_x: !!(C.teeth.right.mean && C.teeth.left.mean && C.teeth.right.mean[0] < C.teeth.left.mean[0]),
    sinus_above_nerve: !!(geo(layerGeo[7]) && geo(layerGeo[4]) && layerGeo[7].y / layerGeo[7].n > layerGeo[4].y / layerGeo[4].n),
  };

  // 5b needs a known view. Frontal (theta 0, phi 9, the engine's own "zheng zhong yao he wei") with a
  // radius that fits this cloud, so the answer does not depend on whatever orbit the page was left in.
  const diag = Math.hypot(c.bboxMax[0] - c.bboxMin[0], c.bboxMax[1] - c.bboxMin[1], c.bboxMax[2] - c.bboxMin[2]);
  V.flyTo({ id: 'probe-frontal', label: 'probe', theta: 0, phi: 9, radius: Math.max(60, diag * 1.6),
            target: [(c.bboxMin[0] + c.bboxMax[0]) / 2, (c.bboxMin[1] + c.bboxMax[1]) / 2,
                     (c.bboxMin[2] + c.bboxMax[2]) / 2] });
  V.pump(90);

  // 4 + 5a: pixels. Buffer row 0 is whatever it is; the sinus/nerve pair below decides, and meanRow is
  // reported raw so the reasoning can be re-done from the numbers.
  const lit = (p) => {
    if (!p || p.error || !p.buf) return { error: (p && p.error) || 'no buffer', lit: 0 };
    const b = p.buf, w = p.w | 0, h = p.h | 0, n = w * h;
    let l = 0, srow = 0, sr = 0, sg = 0, sb = 0, rmin = 1e9, rmax = -1;
    const half = new Int32Array(2);
    for (let i = 0; i < n; i++) {
      const v = (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2]) / 3;
      sr += b[i * 4]; sg += b[i * 4 + 1]; sb += b[i * 4 + 2];
      if (v > 24) {
        l++;
        const row = (i - (i % w)) / w;          // integer row, written without |0 so it can be checked
        srow += row;
        if (row < rmin) rmin = row;
        if (row > rmax) rmax = row;
        half[row < h / 2 ? 0 : 1]++;
      }
    }
    return { lit: l, frac: +(l / n).toFixed(4), paintedFraction: p.paintedFraction, peak: p.peak,
             // w/h travel with the row statistics: meanRow and the two half-counts are only
             // interpretable against h, and which half a layer lands in is the evidence for the
             // row-convention verdict below. Without them a reader has to take my arithmetic on trust.
             // rmin/rmax pin the span: a mean outside [rmin,rmax] would mean this loop is lying.
             w, h, rowSpan: l ? [rmin, rmax] : null,
             meanRow: l ? +(srow / l).toFixed(1) : null,
             rowsLow: half[0], rowsHigh: half[1],
             mean: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
             drawn: p.drawn, glError: p.glError, sorted: p.sorted };
  };
  const ALL = { 0: 0, 1: 1, 2: 0, 3: 1, 4: 1, 5: 0, 6: 1, 7: 1, 8: 1 };
  const only = (code) => { const m = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }; m[code] = 1; return m; };
  V.setLayerAlphaMap(ALL);
  V.pump(3);
  out.allLayers = lit(V.renderProbe(360));
  out.byLayer = {};
  for (const code of [1, 3, 4, 6, 7, 8]) {
    V.setLayerAlphaMap(only(code));
    V.pump(2);
    out.byLayer[code + ':' + NAMES[code]] = lit(V.renderProbe(280));
  }

  // 5b: bind model Y to buffer row using the two layers that are furthest apart in Y.
  const a = out.byLayer['7:sinus'], b = out.byLayer['4:nerve'];
  out.orientation = { modelMeanY: { sinus: geo(layerGeo[7]).mean[1], nerve: geo(layerGeo[4]).mean[1] },
                      meanRow: { sinus: a.meanRow, nerve: b.meanRow },
                      rowsDrawn: { sinus: a.lit, nerve: b.lit },
                      // [lit in rows [0,h/2), lit in rows [h/2,h)] -- the bucket pair is an
                      // independent read of the same fact meanRow encodes, so a reader can check
                      // the arithmetic instead of accepting the sentence.
                      halves: { sinus: [a.rowsLow, a.rowsHigh], nerve: [b.rowsLow, b.rowsHigh] },
                      buf: { w: a.w, h: a.h } };
  if (a.meanRow != null && b.meanRow != null && layerGeo[7] && layerGeo[4]) {
    const modelSays = layerGeo[7].y / layerGeo[7].n > layerGeo[4].y / layerGeo[4].n;
    const pixelSays = a.meanRow > b.meanRow;
    out.orientation.row0_is = (modelSays === pixelSays)
      ? 'bottom scanline (GL convention; higher model Y -> higher buffer row)'
      : 'top scanline (higher model Y -> lower buffer row)';
    out.orientation.arch_upright = modelSays === pixelSays;
  } else {
    out.orientation.row0_is = 'undetermined -- sinus or nerve painted nothing';
    out.orientation.arch_upright = null;
  }

  // Restore what the probe touched, then prove it.
  V.setLayerAlphaMap(prevAlphas);
  V.pump(2);
  out.alphasRestored = JSON.stringify(V.layerAlphas) === JSON.stringify(prevAlphas);
  out.alphasNow = V.layerAlphas;

  // 6: the picture, with everything visible.
  const url = V.renderToDataURL(o.shot || 560);
  out.pngChars = url ? url.length : 0;
  window.__niftiPng = url || null;
  return out;
}
