# CBCT-route evidence — provenance of the files in this directory

Registered artefacts (2026-11-25):

- `sceneB_nifti_118058fc_640x397.png` — 75,333 B, sha256 `0dcd45953ff0171b…`
- `nifti_page.json` — the probe payload the page returned, `ranAt 2026-11-24T20:33:31.187Z`
- `nifti_png.json` — the same probe's `window.__niftiPng`, dumped at `2026-11-24T20:33:43.613Z`

## What the image is

The NIfTI→layers→DSPK chain's output, rendered by the app's own WebGL2 splat pass and read back by
`tools/probe-nifti.js`. Frontal preset (`theta 0, phi 9`), 640×397 px, all nine layer alphas at the
probe's test map, jaw gap 0. It is a **synthetic** CBCT volume: `tools/make_tf3_fixture.py` paints an
analytically labelled arcade (seed 7, `case.nii.gz` sha256 `9362debe82000281…`) rather than reading a
patient, so nothing here is clinical data and the SYNTHETIC badge stays on the UI for the same reason.

## Byte-level chain

| step | file | bytes | sha256 (first 16) |
|---|---|---|---|
| fixture | `tools/out/cbct_route/case.nii.gz` | — | `9362debe82000281` |
| converter | `tools/out/cbct_route/web_assets/cbct_layers.ply` | 1,573,603 | `b6f6e7d20b35690e` |
| container | `tools/out/cbct_route/sceneB_from_nifti.dspk` | 1,748,976 | `118058fc20aaec00` |
| page fetch | same bytes, fetched by the probe | 1,748,976 | `118058fc20aaec00` |
| code that ran | `tools/probe-nifti.js` | 12,134 | `1bd02bda25db5dea` |
| code that ran | `tools/probe-nifti-launch.js` | 2,689 | `cf13f7c913ed81ee` |

87,405 splats, stride 20, SH degree 0, 0.6 mm isotropic (lattice pitch 1.0 mm × 0.6), 32 distinct FDI
ids, 542 distinct colours, layer bytes {1:16064, 3:59316, 4:1293, 6:2276, 7:8074, 8:382}.

`node tools/nifti-report.mjs` re-derives every row of that table from disk and from the served URLs
and exits non-zero if the page's self-reported digests do not match. It exited 0 on this capture (all
three files matched disk, and the pixel/row statistics were internally consistent); the packet is
normally removed from `dist/assets/` afterwards, which the tool reports as "nothing served -- wire
check skipped" rather than as a failure.

## What the probe measured, and what it does not

Measured in the page, from the decoded container and the framebuffer:

- all 32 FDI ids present; upper mean Y +20.4 vs lower −23.5; incisors forward of molars; the
  patient's right quadrants at −X; sinus (layer 7) above nerve (layer 4)
- every probed layer paints when lit alone: enamel 6,423 px, alveolar 10,579, nerve 760, pulp 3,404,
  sinus 1,271, restoration 408 — each with `glError 0` and one draw call
- row convention: nerve mean row 55.9 (rows 40–82), sinus mean row 120.8 (rows 107–134) in a 174-row
  buffer, so higher model Y → higher buffer row → **buffer row 0 is the bottom scanline** (GL), and
  the arch is upright
- the alpha map the probe installed was handed back (`alphasRestored: true`)

Not measured here: no clinical accuracy claim, no occlusal/panoramic view, no IAN compression demo
(the fixture's canal does not approach any root), no timing claim (this ran in a hidden automation
window with a 428×1 canvas; `pump()` drove the frames). The PNG is the offscreen probe render, not a
screenshot of the visible UI.

## Reproduce

```
npm run test:pipeline        # fixture -> converter -> container, 46 checks, rebuilds the .dspk
cp tools/out/cbct_route/sceneB_from_nifti.dspk dist/assets/
cp tools/probe-nifti.js tools/probe-nifti-launch.js dist/probes/
npm run selftest:nifti       # 23 mock checks incl. FLIP_ROWS and SCRAMBLE negative controls
# then send tools/nifti-wrapper.js verbatim to the page (browser-use evaluate_script, filePath=
# captures/nifti_page.json), dump window.__niftiPng to captures/nifti_png.json, and
node tools/nifti-report.mjs  # reconcile digests + verdicts against disk
node tools/cap2png.mjs captures/nifti_png.json captures
rm dist/assets/sceneB_from_nifti.dspk dist/probes/probe-nifti*.js   # keep the shipped bundle clean
```

`tools/out/stale/shot_stale_7c574d2a.png` is the same view of the earlier, pre-fix packet (33,785
splats). It is kept outside this directory because its sha no longer corresponds to anything the
current pipeline produces.
