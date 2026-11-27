# DentSplat — measured evidence

Everything below was computed on this machine by the commands in §1. Nothing here is an estimate, a
literature value, or a placeholder: where a number could not be obtained it is written as *not
obtained* rather than guessed.

> **2026-11-25, Scene A asset swap.** The shipped Scene A packets are now built from a real intra-oral
> scan (Poseidon3D case 000125, Kubik & Španěl, Zenodo 15608906, CC BY 4.0) by
> `tools/poseidon_to_assets.mjs`: 59,808 / 10,168 splats, 1,196,970 / 204,174 B (5.86×), whole-frame /
> in-mask PSNR 24.46 / 20.41 dB, coverage 0.178 / 0.362 / 1.138 mm. That gap is measured pruned→full
> because the two packets are independent surface samplings rather than a subset. Colours are
> procedural — the STL carries no texture — so what is real here is geometry and tooth semantics.
> Rows below marked "synthetic (retired)" describe the previous asset and are kept only as that record.

> **2026-11-25, renderer fixes.** Four bugs in the shader/sort path were fixed — quaternion decode
> missing the [0,1]->[-1,1] remap, depth sort reading a column instead of a row of the view matrix, a
> Jacobian whose diagonal columns disagreed in sign with its shear column, and the splat scale using
> CSS pixels instead of the drawing-buffer size. Every PSNR number above was re-measured afterwards
> (bench-A-poseidon.json, bench-B-final.json); Scene B's content fraction rose to 87.9% because the
> corrected rotations make its anisotropic bone splats face the camera. The opaque-column entry comes
> from a capture taken before the fixes and is labelled as such. Both shipped scenes now come from real public datasets — Poseidon3D intra-oral scan (CC BY 4.0) and
DentVoxel patient CBCT case 0095 (CC BY 4.0) — with procedurally coloured appearance. These figures
therefore quantify the **renderer and the codec on real geometry**, and still not a *trained* 3DGS (§9).

## 1. Provenance

| item | value |
| --- | --- |
| capture date | 2026-11-25, timestamps are local UTC+8 (mixed UTC/UTC+8 is how a previous session misread an 8 h gap) |
| GPU | `NVIDIA GeForce RTX 5070 Ti` via ANGLE/D3D11 (`vs_5_0 ps_5_0`), reported by `WEBGL_debug_renderer_info` and parsed by `src/engine/Viewer.ts` |
| browser | Qoder 0.5.18 / Chrome 150.0.7871.250 / Electron 43.8.4, Windows 10.0.26300 x64 |
| window state | **hidden** automation window: canvas 428×1, dpr 1, `document.visibilityState = hidden` |
| bundle | Vite hashes the filenames, so they move whenever `src/` does; the deployed build at the 2026-11-25 Pages cut is `index-Be3AvOjj.js` 913,440 B (gzip 249 kB) + `index-CmGWE3vc.css` 10,860 B, whole `dist/` 6,286,521 B. The 1440p capture session ran `index-DUqMfPP2.js` / 911,891 B — same app, before the Pages subpath and phone-breakpoint changes |
| page build gate | `npm run check` → dspk round-trip, label sync, GPU-name parser, 4 page-probe self-tests, 23 nifti-probe mock checks, `test:claims` (this file, `brief/technical-brief.html` **and the walkthrough's captions and cards** re-derived from the captures and the artefacts on disk), `test:claims:mut` (one cited value corrupted at a time, each caught by the named check), pycheck, `tsc --noEmit`; exit 0 |
| the one-page Brief | `npm run brief` renders `brief/technical-brief.html` to PDF through headless Edge and asserts `/Count 1`; `npm run brief:selftest` proves the gate by rendering a 300 mm-filler variant and requiring it to fail. Output: `local output directory/DentSplat-Technical-Brief-20261125.pdf` |
| the 60-second walkthrough | `npm run demo` cuts `brief/demo/frames.json` — ten renders, each re-hashed before ffmpeg ever sees it — around two headless-Edge cards, then asks ffprobe for the codec, size, duration and frame count of the file it just wrote; `npm run demo:selftest` proves the card-fit gate by injecting a 400 px filler and requiring the bottom-edge marker to disappear. Output: `local output directory/DentSplat-demo-60s-20261125.mp4` beside its `.PROVENANCE.md` (§8) |
| method + core code, one file | `node tools/build-method-doc.mjs` assembles `docs/method-doc.template.md` and 62 source files into `local output directory/DentSplat-方法与核心代码-20261125.md`, each listing carrying its line count and full sha256; `--verify` re-hashes the delivered blocks *and* the working tree (run by `npm run check`), `--selftest` proves both legs fail on tampering and on drift |
| asset digests | `tools/out/PROVENANCE.md` (`node tools/sha-assets.mjs --write`) |
| tooling | `node tools/summarize-perf.mjs tools/out/perf-*.json`, `node tools/summarize-bench.mjs tools/out/bench-*.json` |

Executed probe bytes are pinned by sha256 in every capture file; the page fetches the probe over HTTP
and hashes it before `eval`, so a capture cannot cite a file it did not run.

```
probe-perf.js          44bff418284fdb39bd13bce59a78d09f5f35ff6c872bcbe2b1e1896f258b1533
probe-bench.js         19adc1c5f63953cacae9867ae856d88f5819984250e8662b60a5ae39eb0e33c3
probe-bench-opaque.js  051911d09f9d44bbd0a35279b1684d1f62dfafcb2a6ad843552791cd7462f2c3
probes/run.js          cdd756e6a1ff07757b0a87511a1a6deb76254a8b6c2c88f2a3f05463ce05b2e2
sceneA_full.dspk       4e8ef23429c98e71…   sceneA_pruned.dspk  58f4bdd2ab81f596…
sceneB_full.dspk       ed3ba983eef28fc1…   sceneB_pruned.dspk  987a23900b6b8f92…
```

## 2. Which instrument is believed, and why

Three ways to time a frame were tried; two of them were shown to lie.

**`gl.finish()` does not synchronise here.** A batch of 88,918 splats at 2560×1440 measured
`submitMs` 0.02–0.17 ms and `finishMs` p50 0.0–0.1 ms — i.e. `finish()` returned as soon as the
commands were handed to ANGLE, before the GPU executed them. Chromium's WebGL `finish()` is satisfied
at the command-forwarding boundary. Any FPS derived from it is ~4 orders of magnitude wrong (it
produced `fpsAtThisSize: 1e9` in an early run). The submit/drain control pair is kept inside
`perfProbe()` precisely so a reader can re-derive that conclusion instead of taking it on faith.

**The headline instrument is a serialised 1×1 readback.** `render() → readRenderTargetPixels(rt,0,0,1,1)`
forces the frame to complete before the call returns, and the same readback measured with *no* render
(`syncOnlyMs`) is subtracted, because that readback is dominated by the GPU→CPU IPC latency of the
ANGLE/D3D11 path. `netGpuMs = serialMs.p50 − syncOnlyMs.p50`. `syncConfirmed` and a 0.2 ms floor guard
refuse to publish a number when the subtraction lands under the noise of the instrument itself.

**`EXT_disjoint_timer_query_webgl2` exists but starves in a hidden window.** The extension is present
(`timerSupported: true`) and, when it answers, it agrees with the readback instrument; but a large
share of queries never return (`got 0/20` for both full packets, `4–11/20` for the pruned ones), and a
busy-wait poll makes it worse — the query acknowledgement needs the main-thread task queue that the
spin is occupying, which is what the first synchronous implementation did (2 s per call, no results).
`perfTimerProbe()` therefore yields with `MessageChannel` between iterations and reports
`asked/got/unavailable/disjoint` so a starved query set cannot read as a fast frame.

Corroboration where both instruments answered (pruned variants, 384²-independent):

| case | variant | readback netGpuMs p50 | hardware timer p50 | answered |
| --- | --- | --- | --- | --- |
| A | pruned | 0.7–0.9 ms | 0.70–0.76 ms | 4–9 of 10–20 |
| B | pruned | 0.5–0.7 ms | 0.51–0.53 ms | 4–11 of 10–20 |

The two independent instruments agree inside ~0.1 ms, which is the main reason the throughput claims in
§3 are quotable.

## 3. Throughput

Offscreen target, current camera, GPU-complete per frame, IPC floor subtracted. `sortMs` is the CPU
counting-sort pass and is *not* included in `netGpuMs`.

**Case A — synthetic (retired 2026-11-25), full: 88,918 splats, SH1, 2,582,852 B (29 B/splat)**

| resolution | iters | serialMs p50 (min/p95) | netGpuMs | frame-rate ceiling | sortMs | painted |
| --- | --- | --- | --- | --- | --- | --- |
| 640×360 | 20 | 3.1 (2.8/4.7) | 2.9 | 344.8 fps | 2.1 | 0.1954 |
| 1280×720 | 20 | 3.1 (2.8/3.7) | 2.8 | 357.1 | 2.0 | 0.1941 |
| 1920×1080 | 10 | 3.0 (2.8/3.9) | 2.6 | 384.6 | 2.3 | 0.1938 |
| 2560×1440 | 10 | 3.1 (2.7/4.4) | 2.7 | 370.4 | 2.2 | 0.1937 |

**Case A — synthetic (retired), pruned: 30,232 splats, SH0, 609,126 B (20 B/splat), 4.24× smaller**

| resolution | iters | serialMs p50 (min/p95) | netGpuMs | frame-rate ceiling | sortMs | painted | timer p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 640×360 | 20 | 1.1 (0.9/1.6) | 0.7 | 1428.6 | 1.4 | 0.1925 | 0.76 (7/20) |
| 1280×720 | 20 | 1.2 (1.0/1.4) | 0.9 | 1111.1 | 0.9 | 0.1913 | 0.763 (9/20) |
| 1920×1080 | 10 | 1.1 (0.8/1.4) | 0.9 | 1111.1 | 1.0 | 0.1912 | 0.718 (5/10) |
| 2560×1440 | 10 | 1.0 (0.9/1.2) | 0.8 | 1250.0 | 0.9 | 0.1911 | 0.70 (4/10) |

**Case B — ToothFairy3 CBCT, full: 44,738 splats, SH1, 1,301,244 B**

| resolution | serialMs p50 | netGpuMs | frame-rate ceiling | sortMs | painted |
| --- | --- | --- | --- | --- | --- |
| 640×360 | 1.6 | 1.4 | 714.3 | 1.1 | 0.2516 |
| 1280×720 | 1.5 | 1.3 | 769.2 | 1.0 | 0.2511 |
| 1920×1080 | 1.5 | 1.3 | 769.2 | 1.2 | 0.2510 |
| 2560×1440 | 1.8 | 1.5 | 666.7 | 1.1 | 0.2509 |

**Case B — pruned: 18,790 splats, SH0, 379,898 B, 3.43× smaller**

| resolution | serialMs p50 | netGpuMs | frame-rate ceiling | sortMs | painted | timer p50 |
| --- | --- | --- | --- | --- | --- | --- |
| 640×360 | 0.7 | 0.5 | 2000.0 | 0.4 | 0.2643 | 0.517 (11/20) |
| 1280×720 | 0.8 | 0.5 | 2000.0 | 0.5 | 0.2639 | 0.534 (11/20) |
| 1920×1080 | 1.1 | 0.7 | 1428.6 | 1.1 | 0.2638 | 0.514 (4/10) |
| 2560×1440 | 1.5 | 1.2 | 833.3 | 0.4 | 0.2638 | not obtained (0/10) |

Reading of the shape: cost is **flat in resolution** between 640×360 and 2560×1440 (A full 2.6–2.9 ms,
B full 1.3–1.5 ms) — at these splat counts the pass is bound by vertex work, sort and readback latency,
not fill rate, and `painted` stays ~0.19 (A) / ~0.25 (B) of the buffer. So the ceiling is ~345–385 fps
for the largest packet and >1000 fps for the pruned one on a single draw call, with 1 draw call, 0
GL errors after each pass. Against the 60 fps target the headroom is ~5× at 1440p for Case A full and
~12× for the pruned variant; the CPU sort (0.9–2.3 ms) leaves room for it inside a 16.6 ms budget.

## 4. Visual fidelity of the pruned packet

`Viewer.bench(384)` renders Full and Pruned into the *same* 384² target from the *same* camera and
compares the bytes the browser read back. Three passes are made: Full, Pruned, Full again. Sheen is
forced to 0 on both layers for the duration, because the shader applies it only where SH1 exists
(`uSheen * (hasSH1 ? 1 : 0)`) and leaving it on would charge a feature toggle to the codec.

Two denominators are reported because each is misleading alone: whole-frame includes background, where
the two renders agree exactly and inflate the score; `in-mask` counts only pixels where at least one
variant painted something (`>8/255`), which is the stricter figure.

| capture | whole-frame PSNR | in-mask PSNR | MAE (0–1) | bit-identical pixels | content pixels | control |
| --- | --- | --- | --- | --- | --- | --- |
| synthetic A full-vs-pruned (`bench-A-final.json`, retired) | 21.82 dB | 17.60 dB | 0.0240 | 62.3% | 37.8% | 999 dB / 100% |
| **A (Poseidon3D, shipped)** `bench-A-poseidon.json` | **24.46 dB** | **20.41 dB** | 0.0133 | 61.4% | 39.3% | 999 dB / 100% |
| B full-vs-pruned (`bench-B-final.json`) | 24.28 dB | 23.72 dB | 0.0238 | 11.7% | 87.9% | 999 dB / 100% |

**The control is what makes the number mean something.** Rendering the *same* packet twice through the
same target returned `psnrSelf = 999` (the bit-identical sentinel) and `identicalSelfFraction = 1.0`,
i.e. the readback path and the depth sort are deterministic, so the A/B difference is the packet
difference and not measurement noise. Mean colour agrees to within 2.5/255 per channel (A: [63, 50,
45.7] vs [60.5, 49, 44.4]).

Error concentration (`errorInTop1Percent`, the share of squared error held by the worst 1% of pixels):
0.39 (A) and 0.57 (B). Neither is edge-only, so the residual is spread across the surface — consistent
with survivors being displaced by the coverage gap in §5 rather than a handful of silhouettes.

### 4.1 Pruning strategy A/B (same viewer, same bundle, different encoder)

The first pruning implementation took the top-scoring splats (`opacity² × volume`). That clumps
survivors where the cloud is already dense and holes the sparse regions, and the pixel comparison
measured the holes:

| | whole-frame PSNR | in-mask PSNR | MAE | mean colour (pruned vs full) |
| --- | --- | --- | --- | --- |
| naive top-score, Case A | 17.19 dB | 12.75 dB | 0.0367 | [54.5, 39.6, 37.6] vs [63.4, 50.3, 46.0] → −14% |
| coverage-aware + dilate, Case A | 21.82 dB | 17.60 dB | 0.0240 | [60.5, 49, 44.4] vs [63, 50, 45.7] → −4% |

`DENTSPLAT_PRUNE=nocomp node tools/gen-dental-assets.ts` reproduces the naive row; the naive packets are
kept in `tools/out/assets-naive/` (`sceneA_pruned.dspk` sha256 `bbdc731fdcde60da…`) so the comparison is
between two files, not two descriptions.

The compensation is two encoding-time choices, not runtime magic and not a metric change: survivors are
chosen per occupied voxel cell (cell edge binary-searched so the occupied-cell count lands on the
budget — 0.86 mm for A, 1.239 mm for B) and each survivor's radius grows by √(splats it stands in for),
capped at 1.8×. Positions stay a subset of the original cloud, so `kept_subset_of_original` remains
true and the geometry metric in §5 is unaffected by the dilation. Cost in bytes: nil (608,902 → 609,126
B, the delta is the metadata block that records the recipe inside the `.dspk` itself).

A third candidate — matching accumulated transmittance (`α' = 1−(1−α)^(1+(k−1)γ)`) — was implemented,
measured and **rejected**: at γ=0.6 whole-frame PSNR moved 21.81 → 21.72 dB (noise) while a sinus splat
at α=0.24 standing for 3 layers rose to ≈0.47, which is exactly the translucent look the IAN view
depends on. `DENTSPLAT_ALPHA=0.6` reproduces it; the shipped setting is `alpha_comp: 0`, recorded in the
asset.

### 4.2 Opaque-subset isolation (a negative result, recorded as such)

`probe-bench-opaque.js` hides the sub-surface layers (alveolar, nerve, other, pulp, sinus) through the
same `uLayerAlpha` uniform the sliders drive, re-measures, and restores (`restoredMatchesPrev: true`).

| case | all layers | opaque only |
| --- | --- | --- |
| A (synthetic, retired) | 21.82 / 17.60 dB, 37.8% content | 21.82 / 17.59 dB, 37.8% content |
| B (pre-fix renderer for the opaque column) | 24.28 / 23.72 dB, 87.9% content | 23.43 / 19.18 dB, 37.6% content |

The intent was to separate "codec loss" from "synthetic translucent stacking". It does not, and the
honest conclusion is that it *cannot*: changing the layer map changes which pixels are in the mask, so
the two in-mask PSNRs have different denominators and the −2.9 dB in Case B is a mask effect, not a
fidelity effect. Case A's <0.01 dB change says its removed layers contribute no visible pixels there.
Do not quote §4.2 as an IOS-transferability claim.

## 5. Geometry of the pruned packet

`coverage_gap` is the nearest-neighbour distance from each **removed** splat centre to the retained set,
in millimetres, grid-accelerated, sampled pairs as noted — a real computed chamfer-style statistic from
`tools/gen-dental-assets.ts`, not a configuration value.

| case | strategy | mean | p95 | max | sampled pairs |
| --- | --- | --- | --- | --- | --- |
| A | naive top-score | 0.469 | 1.359 | 6.556 | 2414 |
| A (synthetic, retired) | coverage-aware | **0.314** | **0.691** | 4.796 | 2532 |
| **A (Poseidon3D, shipped)** | resampled 0.35→0.85 mm | **0.178** | **0.362** | 1.138 | 10168 |
| B | naive top-score | 0.541 | 3.389 | 6.813 | 2236 |
| B | coverage-aware | **0.349** | **0.946** | **1.297** | 2632 |

Case B's p95 dropping 3.389 → 0.946 mm is the clinically relevant one: at 0.3 mm voxel size that is the
difference between "the retained set still brackets the IAN canal" and "there is a 3 mm hole in it".

## 6. Interaction paths that were exercised, not assumed

- The compression card's PSNR is produced by the real button, and the probe compares the `<dd>` text
  against the value returned by `DentSplat.bench()` in the same page (`agrees: true` in all captures).
  `settled: "PSNR changed after clicking bench"`, `busyAfter: false`.
- Two deadlocks were found and fixed while getting that to work. `runBench` awaited two
  `requestAnimationFrame`s; a hidden window never fires them **and** Chrome freezes background timers,
  so neither a rAF nor a `setTimeout` fallback is reliable — the button stuck on 回读像素中… and the
  audit pill stuck on 待测. It now takes `Viewer.pump()` (synchronous frames) whenever
  `visibilityState !== 'visible'`, wrapped in `try/finally` so an exception cannot strand the state.
- The synthetic-preview badge, the odontogram/FDI link, clip uniforms and layer alphas are read back
  from the live scene by `probe-smoke.js` (`glError 0`, `selfTest` box 6544 / splat 7296 px lit for A,
  9212 / 9216 for B) rather than inferred from the code path.

## 7. The offline CBCT route, executed (Scene B)

§1–§6 measure the viewer against the packets it ships. This section is the other half of the promise:
that a NIfTI segmentation becomes a loadable `.dspk` using only committed code, with nothing hand-built
in the middle. It ran, and it reproduces byte for byte. The input is still a synthetic fixture volume
rather than a released ToothFairy3 case, so §9.1 still applies.

```
tools/make_tf3_fixture.py             case.nii.gz + case_0000.nii.gz  (analytic tf3 arcade, seed 7)
pipeline/toothfairy2_to_layers.py     --schema tf3, six layers, spacing 1.0 mm, surface_only 0
                                      -> cbct_layers.ply + fdi/layer_labels.bin + meta + manifest
tools/ply2dspk.ts --kind cbct         -> sceneB_from_nifti.dspk
tools/probe-nifti.js (in the page)    -> decode, rasterise one layer at a time, read back pixels
```

| artefact | bytes | sha256 (first 16) |
| --- | --- | --- |
| `tools/out/cbct_route/case.nii.gz` | 33,928 | `9362debe82000281` |
| `tools/out/cbct_route/case_0000.nii.gz` | 361,573 | `9f27c208ea479ebf` |
| `…/web_assets/cbct_layers.ply` | 1,573,603 | `b6f6e7d20b35690e` |
| `…/sceneB_from_nifti.dspk` | 1,748,976 | `118058fc20aaec00` |
| the bytes the page actually hashed | 1,748,976 | `118058fc20aaec00` |
| `tools/probe-nifti.js` | 12,134 | `1bd02bda25db5dea` |
| `tools/probe-nifti-launch.js` | 2,689 | `cf13f7c913ed81ee` |
| `tools/nifti-wrapper.js` | 931 | `bd6a18be9a0ba8e7` |
| `captures/sceneB_nifti_118058fc_640x397.png` | 75,333 | `0dcd45953ff0171b` |

`npm run test:claims` recomputes every row of that table from the files and fails if this document
disagrees with them — including the fifth row, which is the one a doc edit can get wrong silently.

Three gates, from the repo root:

| command | result | what it pins |
| --- | --- | --- |
| `npm run test:pipeline` | 46/46 | re-derives from files on disk: row alignment, the layer byte, the FDI+100 round trip, the Y-up mm signs, the manifest's own sha, HU windowing vs `--flat_colour` — plus converter repeatability and container byte-identity |
| `npm run selftest:nifti` | 23/23 | the page-side probe against a mock rasteriser, **including two negative controls**: `FLIP_ROWS` must make it report the other row convention, `SCRAMBLE` must break the sinus-above-nerve claim |
| `node tools/nifti-report.mjs` | exit 0 | reconciles disk / served / page-reported digests, and re-checks the pixel arithmetic against itself (`meanRow` vs `rowSpan` vs the two half-buckets) |

The container as decoded in the page: 87,405 splats, stride 20, SH degree 0, 0.6 mm isotropic (lattice
pitch 1.0 mm × the 0.6 point factor), bbox 81 × 64 × 78 mm, 32 distinct FDI ids, 542 distinct colours,
layer hist `1:16064 · 3:59316 · 4:1293 · 6:2276 · 7:8074 · 8:382`. Every layer paints on its own —
enamel 6,423 px, alveolar 10,579, nerve 760, pulp 3,404, sinus 1,271, restoration 408, each with
`glError 0` and one draw call — and all five container checks came back true. The row-convention
verdict is the one worth spelling out, because a wrong frame recolours anatomy instead of failing: in a
174-row buffer the nerve band averages row 55.9 (span 40–82, all 760 lit pixels below the midline) while
the sinus averages 120.8 (span 107–134, all 1,271 above). Higher model Y → higher buffer row, so row 0
is the bottom scanline and the arch is upright.

What had to be fixed to get there, recorded because each failure was silent rather than loud:

1. The packet an earlier capture cited (`7c574d2a…`, 33,785 splats) was **stale**. The fixture and the
   converter are deterministic, so the difference was the packet's own age — built before the midline
   fix in `make_tf3_fixture.py`, and nothing on disk said so. Container byte-identity is now one of the
   46 checks, and the superseded screenshot lives in `tools/out/stale/`.
2. Byte-identity then failed on size (+260 B) and after that on 5 bytes near offset 910 at equal
   length: the embedded meta recorded absolute Windows paths (`outPath.split('/')` never splits a
   backslash, so the packet's `name` was a whole path) and carried a `converted_at: new Date()`. Paths
   are repo-relative through a `disp()` helper now, and the timestamp lives only in the side-car report
   (`--keep-converted-at` puts it back if a build ever needs it).
3. The probe's own row arithmetic disagreed with itself — nerve `meanRow 55.9` with zero pixels below
   the midline. `lit()` now returns `rowSpan` and the two half-buckets as independent witnesses, and the
   report fails when they contradict the mean.
4. `vite preview` answers *any* unknown URL with `index.html` and HTTP 200, so a missing asset looks
   like a successful fetch. The report's `get()` rejects HTML bodies; packet identity rides on the
   digest, never on the status code.

**Not established here.** No Scene A stage ran: this machine has no Blender, and
`postprocess_dental_gs.py` has still never seen a real trained `.ply` (§9.1). This route has no pruned
twin — `altSplats == splats == 87,405` — so §4's Full-vs-Pruned comparison does not apply to it. The
fixture's canal does not approach any root, so there is no IAN-compression result to show; that is the
money shot and it remains a TODO, not a measurement. And **no throughput claim comes from this capture**:
the window was hidden and `pump()` drove the frames (§9.3). The one timing it does record is a load
measurement rather than a frame one — 134.2 ms for the page to fetch, decode and upload the 1,748,976 B
packet (`out.res.loadMs`, localhost, warm process) — which says the container is not what would make a
page feel slow, and nothing about frame rate.

## 8. The 60-second walkthrough, cut from the app's own renders

`node brief/demo/build.mjs` (also `npm run demo`) produces `local output directory/DentSplat-demo-60s-20261125.mp4` —
2,489,309 B, sha256 `c4306565710665d3…`, cut at 2026-11-25 08:47 local, which the sidecar
`…mp4.PROVENANCE.md` prints as `2026-11-25T00:47Z`: the same instant, one UTC, one UTC+8 (§1 is local).
Re-cutting changes those bytes, so nothing here gates them; what is gated is what the video *claims*.
This cut replaced the earlier `843e78d9…` one: the Scene A caption said "Teeth3DS+ IOS 表面网格训练出的
3DGS", which overstates a procedurally generated asset, and it now reads "按 Teeth3DS+ 统计生成的合成几何".

| item | value |
| --- | --- |
| shape | 1280×720, 25 fps, H.264 `yuv420p`, no audio; 4 s title card + ten 5 s clips + 6 s end card = 60.00 s, 1500 frames |
| frames | the ten PNGs in `brief/demo/frames.json`, each pinned by a 16-hex sha256 prefix and re-hashed before ffmpeg sees it |
| what they are | offscreen WebGL2 renders the app's own splat pass produced and read back — **not a screen recording**, because the automation window is hidden with a 428×1 canvas and no honest capture of a driven UI exists from this session; the title card says so on its face |
| motion | a ≤1.08× push-in on the renders; the cards get a cross-fade instead, because the push-in is a crop |
| refusal path | a frame whose bytes do not match its manifest, a card that is not exactly 1280×720, a card whose bottom-edge fit marker is missing, `/Count`-style geometry that ffprobe contradicts — each exits non-zero before the file is offered |
| negative control | `npm run demo:selftest` screenshots each card twice, once as shipped and once with a 400 px filler injected, and requires the marker to appear in the first and vanish in the second |
| claims on screen | re-derived by `npm run test:claims` from the same captures as §3–§7: the caption surface and the end-card surface are checked separately, and `test:claims:mut` mutates both |

Two silent failures were caught while building it, and both are now gates rather than lessons:

1. **`drawtext` and the drive letter.** `fontfile=C\:/Windows/Fonts/msyh.ttc` does not parse — ffmpeg
   answers `No option name near '/Windows/…'` — and `fontfile='C:/…'` does not either; only the quoted
   *and* escaped form works. `node tools/ffmpeg-drawtext-probe.mjs` asserts all eight forms against the
   installed binary, so an ffmpeg upgrade that changes the quoting rules fails the probe instead of
   shipping a video with no captions.
2. **The push-in ate the bottom of the cards.** Both cards were authored at 1280×720 but with
   `box-sizing: content-box`, so their padding pushed the footer out of the frame — and the screenshot
   check that only compares IHDR dimensions said nothing. Then the zoom crop removed the last 10 px even
   when the layout was correct. The fix is a brand rule at the foot of each card that doubles as a fit
   marker, sampled from the *finished MP4* rather than from the PNG: `the end card's #38BDF8 fit marker
   survives into the video at t=57.0s`.

The IAN clips carry their own disclaimer in the burned-in caption — `交互可做；是否压迫需真实病例，目前未测`
— which is the §9.1 position, stated where the money shot appears rather than only at the end.

## 9. What this does not prove

1. **Real data, procedural appearance, no training.** Scene A ships a real Poseidon3D intra-oral scan and
   Scene B a real DentVoxel patient CBCT (case 0095, 440×440×344 at 0.3 mm), both CC BY 4.0. What is still
   synthetic is the *appearance*: the STL has no texture and the CBCT colours come from HU windows, so §4
   quantifies the codec and renderer on real geometry, not the fidelity of a trained 3DGS. The synthetic
   packets those sections originally measured are retired and labelled as such. The front of the training
   chain — Blender rendering and `postprocess_dental_gs.py` against a trained `.ply` — has now run once on
   the Poseidon3D mesh (120 views, §7.1b in `pipeline/NOTES.md`), but **gsplat training itself has still
   never completed**, and DentVoxel has no pulp/restoration labels, so those two layers are empty in B.
2. **Absolute frame times exclude compositing and swap.** `netGpuMs` is GPU work per render pass against
   an offscreen target; the page cost of presenting to the screen is not in it. The 16.6 ms budget claim
   in the Brief should be read as "GPU pass + CPU sort leaves ≥5× headroom", not "measured 300 fps".
3. **One GPU, one browser, a hidden window.** Numbers are ANGLE/D3D11 on an RTX 5070 Ti inside Electron.
   The hidden window is why the hardware timer starves (§2) and why the HUD's own `fps/frameMs`
   (0.01–0.7 ms on a 428×1 canvas) must never be quoted.
4. **The GL timer never answered for the full packets** (`0/20`, `0/10`), so A-full 2.6–2.9 ms and
   B-full 1.3–1.5 ms rest on the readback instrument alone.
5. **mm measurement taps the invisible proxy mesh, not splat centroids.** Distances are real millimetres
   on a watertight surface, which is the clinically meaningful referent, but they are *surface* hits; a
   claim about centroid-to-centroid distance would need a different implementation.
6. **No clinical validation.** Nothing here is a diagnostic-accuracy result. `ian_48_min_mm` is a
   geometric distance computed from the packet's own coordinates; after §10 it is the nearest
   splat-centre distance between the FDI-48 surface shell and the canal surface shell (0.16 mm),
   which is not the centroid-to-centroid distance the selection script ranked and is not a
   validated clinical measurement — adjacent segmentation masks can touch.

## 10. Oriented-surfel Scene B rebuild (2026-11-25, later the same day)

The shipped B packet was rebuilt from the same DentVoxel case 0095 label volume, but no longer as
voxel-centre blobs. `pipeline/cbct_surfel.py` runs marching cubes per semantic layer (teeth 11–48,
bone 1/2, canal 3, sinus 5), two Laplacian smoothing passes, vertex normals, a discrete mean-curvature
AO, and area-weighted sampling that is Poisson-thinned (no two centres closer than ~0.62 x spacing)
before choosing the tangential sigma from the measured mean k=6 neighbour distance. Every quaternion
takes local +Z to the interpolated vertex normal and s3 = 0.2 s1, and the packet is SH1 with a baked
three-point key/fill/rim light. FDI labels are read back from the label volume 0.45 mm *inside* the
surface (with a 5x5x5 tooth-only fallback), so the odontogram binds to the real voxel labels instead
of a nearest-centroid guess.

**The audit** (`tools/analyze_gaussians.mjs`; baseline kept at `tools/out/blob_audit_before.json`,
after at `tools/out/blob_audit_after.json`):

| metric | isotropic voxel sample (before) | oriented surfels (after) |
|---|---|---|
| isotropic / disk share | 100 % / 0 % | 0 % / 100 % |
| rho < 0.6 (under-covered) | 49.0 % | 12.1 % |
| rho > 2.0 (over-stacked) | 0 % | 2.7 % |
| layer budget | teeth 21 %, bone 67.3 %, nerve 1.5 %, sinus 10.2 % | teeth 58.6 %, bone 27 %, nerve 7.2 %, sinus 7.2 % |
| per-tooth labels | 32 by pipeline centroid | 32, every splat read from the volume |

The packet is 111,000 splats x 29 B = 3,219,808 B (SH1). The pruned variant keeps every third splat
with the tangential axes scaled by sqrt(3): 37,000 splats, 1,073,808 B, 3.00x. Its coverage gap is
mean 0.602 / p95 1.395 / max 3.701 mm, and the browser read-back bench gives 28.04 dB whole-frame /
27.20 dB in mask (self-render control bit-identical, PSNR 999) — above the isotropic packet's
24.25 / 24.12 dB at the same 3.00x ratio, measured with the same instrument. The bench now runs
over the DevTools protocol in headless Edge (`tools/cdp-bench.mjs`) because the in-app evaluator
refuses calls with side effects; the capture is `tools/out/bench-B-dentvoxel.json` and the sha256 in it
is the shipped file's.

The UI was fixed in the same pass: the bottom toolbar is a single row and reserves its own 54 px strip
so it cannot cover the jaw, the auxiliary toggles moved into the side panel, and the 16-column
odontogram uses minmax(0,1fr) cells with 12 px glyphs so FDI 28/38 are fully visible.

What this still is not: a trained appearance model. The colours are baked, not optimised against
photographs, and the report/README keep the "procedural appearance" wording.

## 11. Scene A trained 3DGS (Brush, local RTX 5070 Ti, 2026-11-25)

The 120 Blender renders that were already on disk (`tools/out/case125/colmap_dataset`, 1024^2,
programmatic enamel/gingiva, no real texture exists) were trained with **Brush v0.3.0**
(`brush-app-x86_64-pc-windows-msvc.zip`, sha256 b68e3e9c…, 158,791,348 B) on the local RTX 5070 Ti:

    brush_app.exe <colmap_dataset> --total-steps 15000 --sh-degree 1 \
        --eval-split-every 10 --eval-every 2000 --export-every 15000 --export-name caseA_{iter}.ply

It finished in ~3 minutes (GPU 77 %, 4.8 GiB), exporting **28,691 anisotropic Gaussians** as a standard
3DGS PLY (92 B/vertex, SH1). Three separate frames had to be reconciled before the model was usable:

1. **Frame.** The export is in COLMAP's handedness; the principal axes of the trained cloud match the
   sampled packet rotated -90 deg about Y (`x' = -z, y' = y, z' = x`, det +1).
   `tools/ply-frame-fix.mjs` applies R and `q' = q_R q` (q_R = (s,0,-s,0)) and zeroes f_rest, because
   a reflection/rotation of the l=1 band cannot be approximated by leaving it untouched.
2. **Labels.** Training does not learn FDI. `tools/label-transfer.mjs` gives every trained centroid the
   label of the nearest sampled splat within 1.0 mm: **99.5 % transferred**, 7,592 splats carry a tooth
   id, the rest are gingiva/soft tissue (layer 0). Splats without a neighbour stay unlabelled.
3. **Budget.** 28,691 x 29 B = 832,829 B (SH1); a 3x decimation (`tools/dspk-decimate.mjs`) gives
   9,564 splats / 278,146 B (2.99x). The decimation gap and a browser PSNR for this packet are **TBD**
   - do not quote numbers for them yet.

Ships as **Case A · Trained** (`#A2`), next to the sampled Case A, with the same proxy and presets. What
this proves: the training chain (Blender -> COLMAP -> Brush -> PLY -> DSPK) runs end-to-end on this
machine and produces an anisotropic, SH1 model that renders through the existing viewer. What it does
not prove: fidelity to the patient — the supervision is 120 renders of the same real scan, not
photographs, and the model has no more geometry than those views contain.
