# DentSplat offline pipeline — NOTES

Everything here is **offline data generation only**. The web app owns `.dspk`; this directory
never writes into `src/`, `tools/`, `public/` or `package.json`.

```
pipeline/
  dental_lib.py               shared transforms / frame cache / meta merge (no bpy, no trimesh)
  dental_pipeline_blender.py  3DTeethSeg mesh -> renders + COLMAP + proxy GLB + meta   [needs Blender]
  postprocess_dental_gs.py    trained .ply -> pruned .ply + fdi/layer labels + manifest
  toothfairy2_to_layers.py    CBCT .nii.gz -> cbct_layers.ply + meta + labels           [no GPU]
  train_gsplat.sh             gsplat MCMC launcher
  train_2dgs.sh               2DGS launcher
  run_case.sh                 end-to-end orchestration for one case
  requirements.txt            system Python deps
```

---

## 0. Setup

```bash
python -m pip install -r pipeline/requirements.txt      # numpy scipy trimesh plyfile nibabel
blender --version                                       # 3.6 LTS or 4.x, must be on PATH
```

`dental_pipeline_blender.py` runs inside Blender's bundled Python and imports only stdlib +
numpy + `bpy`, so it needs nothing from `requirements.txt`. The other three scripts run under
your **system** Python.

There is deliberately **no** import of `torch`, `open3d`, `pyvista`, `matplotlib` or any custom
module in these files.

---

## 1. Scene A — surface meshes (3DTeethSeg / Teeth3DS style), full chain

```bash
bash pipeline/run_case.sh caseA \
  --upper-obj data/upper.obj --upper-json data/upper.json \
  --lower-obj data/lower.obj --lower-json data/lower.json \
  --views 120 --res 1024 --samples 48 --seed 1337
```

Stages, all idempotent (re-running skips completed work; `--force` redoes):

| stage | what it does | outputs |
|---|---|---|
| `[1/4]` | Blender Cycles orbit render + COLMAP text dataset + decimated proxy | `output/caseA/colmap_dataset/{images/*.png, sparse/0/{cameras,images,points3D}.txt}`, `web_assets/proxy_teeth_combined.glb`, `web_assets/tooth_meta_combined.json`, `frame.json` |
| `[2/4]` | training via `train_gsplat.sh` (or `--train 2dgs`) | `output/caseA/gs_model/ply/point_cloud_14999.ply` |
| `[3/4]` | prune + FDI/layer binding + alignment verification | `web_assets/{dental_pruned.ply, fdi_labels.bin, layer_labels.bin, labels_manifest.json}` |
| `[4/4]` | prints the converter hand-off line | — |

If you have no GPU yet, still get valid web assets from the mesh alone:

```bash
bash pipeline/run_case.sh caseA --upper-obj ... --upper-json ... --copy-proxy-only
```

This writes a synthetic-but-spec-correct `dental_pruned.ply` straight from the proxy surface
(marked `"synthetic_placeholder": true` in the manifest) so the renderer has something to load
before training finishes.

### Expected wall-clock (rough, measured ranges not promises)

| step | RTX 4080 (16 GB) | notes |
|---|---|---|
| 120 views @ 1024², 48 spp, GPU | 15–45 min | CPU fallback is ~10× slower; script prints which device it got |
| gsplat MCMC 15 000 steps, cap 150 k | 20–40 min | needs ≥ 8 GB VRAM at cap 150 k |
| postprocess | 10–60 s | KD-tree bind dominates |
| CBCT route | 1–5 min/volume | CPU only, no training |

GPU requirement: training needs CUDA (OptiX preferred). Rendering runs on CPU but slowly.
The CBCT route needs **no GPU at all**.

---

## 2. Scene B — CBCT, no training

```bash
bash pipeline/run_case.sh cbct01 \
  --cbct-labels ToothFairy2/predictions/case.nii.gz \
  --cbct-image  ToothFairy2/raw/case_0000.nii.gz
```

Produces `web_assets/cbct_layers.ply` (plain binary PLY: x,y,z,red,green,blue,alpha,fdi,layer),
`tooth_meta_cbct.json` with a `"layer"` per FDI, plus `fdi_labels.bin`, `layer_labels.bin`,
`labels_manifest.json`. Omit `--cbct-image` and the orchestrator passes `--flat_colour`, so you get
fixed tints instead of HU windowing and no intensity volume is needed. Loadable directly by
`trimesh.load`.

**The schema default is `tf3`** — the 77-class ToothFairy3 release (532 volumes, ODIN2025 at
MICCAI 2025), not the older 44-class one. That buys the two layers the interaction design depends
on: `pulp` = root canals, ids **111–148 = FDI + 100**, so a tooth's misc byte and its canal's misc
byte are the same number and click-to-highlight-a-root needs no extra side-car; and `nerve` widens
from the two IAN ids (3,4) to include the incisive (103,104) and lingual (105) canals, which is what
makes "拉动滑块看阻生智齿牙根是否压迫 IAN 神经管" measurable rather than decorative. `--schema tf2`
restores the old behaviour where 8/9/10 ride inside `teeth` with `fdi 0`.

Six layers are emitted by default: `alveolar teeth nerve pulp restoration sinus` (`--layers` to
subset; `other`/pharynx is deliberately off). Note that `run_case.sh` does **not** forward
`--schema` or `--layers` — it uses both defaults. To change either, call the converter directly:

```bash
python pipeline/toothfairy2_to_layers.py \
  --labels_nii ToothFairy3/case.nii.gz --image_nii ToothFairy3/case_0000.nii.gz \
  --out_dir output/cbct01/web_assets --schema tf3 --layers alveolar,teeth,nerve,pulp
```

The tooth band has no code of its own in the byte layout and borrows the `enamel` slot (code 1),
which is the slot the viewer's 牙体/牙根 slider listens on; see §3.

---

## 3. Output contract (what your converter may rely on)

Coordinate system for **every** artefact: right-handed **Y-up**, 1 unit = **1 mm**, arch centred
on the origin, occlusal plane parallel to XZ, upper jaw at **+Y**, lips at **+Z**.

* `colmap_dataset/sparse/0/images.txt` — standard COLMAP **world-to-camera**, `QW QX QY QZ TX TY TZ`,
  PINHOLE 1024×1024, in that same Y-up mm frame.
* `proxy_teeth_<mode>.glb` — one node per tooth named exactly `FDI_<n>` (11–18, 21–28, 31–38,
  41–48), gingiva nodes `GINGIVA_upper` / `GINGIVA_lower`, no materials, decimated.
* `tooth_meta_<mode>.json` — `unit`, `coordinate_system`, `arch_extent_mm`, and per tooth
  `fdi`, `arch`, `centroid_mm`, `bbox_min_mm`, `bbox_max_mm`, `n_vertices` (+ `layer` for CBCT).
* `dental_pruned.ply` — **binary_little_endian**, canonical 3DGS order
  `x y z | f_dc_0..2 | normals_0..2 | opacity | scale_0..2 (log) | rot_0..3 (w,x,y,z)` then
  `f_rest_*` truncated to `--sh_degree`. Band-0 encoding is the official
  `rgb = 0.5 + C0·f_dc`, `C0 = 0.5/√π`.
* `fdi_labels.bin` / `layer_labels.bin` — `uint8[N]`, **row-aligned with the PLY after pruning**.
  `labels_manifest.json` records `n_splats`, `ply_sha256`, `ply_bytes`, cardinalities and counts,
  and the writer re-reads the PLY from disk and asserts the row count and coordinates match the
  label arrays before exiting. Verify against the sha256 rather than trusting it.

Layer codes, byte-identical to `LAYER` in `src/engine/dspk.ts` and asserted by
`npm run test:labels` (`tools/test-label-sync.mjs`):
`0` gingiva · `1` enamel/crown · `2` root/dentine · `3` alveolar bone · `4` IAN · `5` other/unknown
· `6` pulp · `7` sinus · `8` restoration.
`postprocess_dental_gs.py` writes 0–5; the CBCT route additionally writes 6–8. CBCT layer names in
meta are strings (`alveolar | teeth | nerve | pulp | restoration | sinus`), mapped to those codes in
the bin, with `teeth → 1` by the `EMIT_CODES` alias described above. The web viewer indexes
`uLayerAlpha` by these numbers, so a drift between the two tables recolours anatomy instead of
failing — hence the check, which runs in Node precisely because Python may be unavailable.

### 3.1 Prune recipe — match this when you convert real data

The shipped `.dspk` packets were produced by the **coverage-aware** pruner in
`tools/gen-dental-assets.ts`, not by dropping low-opacity splats: voxel cells are binary-searched to
hit the budget, one representative survives per cell, and that splat's radii are dilated by
`√(splat count it stands for)`, capped at ×1.8 and encoded as the u8 byte delta
`255·ln(gain)/(scaleLogMax−scaleLogMin)` (those two header fields hold **natural** logs). The
thickness axis takes half the delta so splats do not puff out of the surface. Positions stay a
subset of the originals, so `kept_subset_of_original` remains true and the chamfer/coverage numbers
stay comparable. The recipe is embedded in each packet's meta under `metrics.prune`
(`strategy, cell_mm, dilate_cap, alpha_comp, dilated_splats, mean_gain`) — read it back with
`node tools/sha-assets.mjs`.

Measured, not assumed: naive top-score pruning at the same budget scored **17.19 dB whole-frame /
12.75 in-mask** with a 14 % luminance loss, versus **21.82 / 17.60 dB** for this recipe (MEASUREMENTS.md §4.1).
Alpha compensation (`ALPHA_COMP`, env `DENTSPLAT_ALPHA=0.6`) was tested and **rejected** — it bought
nothing (21.81→21.72 dB) while lifting a 0.24-alpha sinusoidal splat to ≈0.47, i.e. it fakes density.
Reproduce either variant: `DENTSPLAT_PRUNE=nocomp` or `DENTSPLAT_ALPHA=0.6` before `npm run gen`.
The pipeline side now implements the same recipe: `postprocess_dental_gs.py --topk_strategy` defaults
to **`coverage`**, with `--dilate_cap` (default 1.8) and `--alpha_comp` (default 0.0 — off, because
the ablation above rejected it; the switch stays so the ablation is reproducible). `_coverage_thin`
binary-searches the cell size to hit the budget, keeps one representative per occupied cell, records
`stands_for` per survivor and dilates by `min(--dilate_cap, √stands_for)`, exactly as the TypeScript
generator does; positions are never moved, so `kept_subset_of_original` still holds and the geometry
metrics stay comparable. The recipe used is written into the run manifest under `prune`
(`strategy, cell_mm, dilate_cap, alpha_comp, dilated_splats, mean_gain`), so a converted model states
its own settings instead of relying on the reader assuming the default. `spatial` (fixed `--voxel_mm`,
no dilation) and `importance` remain available as the two naive baselines.

One bug found while wiring the strategies together, recorded because it was silent rather than loud:
`_spatial_thin` returns indices into the **filtered** array, and the caller used them against the
full array. Every FDI label was then shifted by however many splats `--min_opacity` and the distance
filters had dropped — no exception, no NaN, just a cloud whose teeth were labelled with their
neighbours' ids. The remap through `valid_idx` is at `postprocess_dental_gs.py:404`, and the
label-vs-geometry cross-checks in `tools/verify_cbct_route.py` are the guard that would catch a
regression of the same shape. Neither route has yet been executed against a *real* trained `.ply` —
see §7.

---

## 4. Verified dataset conventions (with sources)

**Teeth3DS / 3DTeethSeg24 per-vertex JSON** — the annotation file lists one integer per OBJ
vertex, in OBJ vertex order, with `0` = gingiva/soft tissue and the rest being FDI numbers.
Source: <https://arxiv.org/abs/2210.06094> (Teeth3DS paper, "segmentation labels … 0 for gums
and the remaining following the FDI notation"). Because labels are **per-vertex**, face labels are
derived by majority vote over the triangle's vertices, requiring ≥2 agreeing non-zero labels;
otherwise the face becomes gingiva. This is documented in `load_obj_strict`.

**ToothFairy2 / ToothFairy24 42-class nnU-Net scheme** — read directly from the released label
file, cross-checked against the challenge page:
<https://github.com/AImageLab-zip/ToothFairy2-Benchmark/blob/main/dataset.json> and
<https://ditto.ing.unimore.it/toothfairy2/>.

```
0 background          1 Lower Jawbone    2 Upper Jawbone
3 Left IAC (nerve)    4 Right IAC        5 Left maxillary sinus
6 Right maxillary sinus  7 Pharynx
8 Bridge  9 Crown  10 Implant
11-18 / 21-28 / 31-38 / 41-48  FDI teeth      19,20,29,30,39,40 declared "NA"
```

Mapping used by default: `alveolar = {1,2}`, `teeth = {11..48} ∪ {8,9,10}`, `nerve = {3,4}`.
Sinuses and pharynx are **not** emitted by default (`--layers` to add them).

**Honest caveat:** ToothFairy2 assigns *one* label per tooth covering crown **and** root together.
It cannot separate enamel from dentine, so the CBCT `teeth` layer is coronal+radicular. A real
split needs ToothFairy3 or intra-mask HU thresholding. Overridable wholesale via `--label_map`
(e.g. `--label_map "1=alveolar,2=alveolar,3=nerve,4=nerve,11-18=teeth"`).

**Trainer flags** were checked against the upstream sources, not guessed:
* gsplat `examples/simple_trainer.py`, `mcmc` subcommand (tyro): `--data_dir`, `--result_dir`,
  `--data_factor`, `--max_steps`, `--sh_degree`, `--init_opa`, `--save_ply`, `--ply_steps`,
  `--test_every`, `--normalize_world_space`, `--strategy.cap_max`.
  Note: in some pinned builds `cap_max` is a constructor arg, so if tyro rejects
  `--strategy.cap_max`, edit `MCMCStrategy(cap_max=…)` in the trainer instead — the script says
  so inline. <https://github.com/nerfstudio-project/gsplat>
* 2DGS README: `-s`, `-m`, `-r`, `--iterations`, `--sh_degree`, `--lambda_normal`,
  `--depth_ratio` ("0 for mean depth and 1 for median depth, 0 works for most cases"), and
  **`--lambda_distortion`** — the draft's `--lambda_dist` does not exist.
  <https://github.com/hbb1/2d-gaussian-splatting>

**Coordinate frames** — verified three independent ways (determinant, equivalence to
`export_yup=True`, and a concrete test camera) rather than assumed:

```
M_G_FROM_B     = [[1,0,0],[0,0,1],[0,-1,0]]    Blender Z-up -> glTF Y-up, det = +1
S_CBL_FROM_CCV = diag(1,-1,-1)                 OpenCV -> Blender camera axes, det = +1
```

Full proof is in the `dental_lib.py` module docstring. The Blender script additionally asserts
`det(R_w2c) == +1` for **every** view at runtime and cross-checks the pose derived from the scene
camera against the analytic look-at construction, raising if they disagree by >1e-4. Quaternions
are converted with a numpy eigendecomposition, **not** `mathutils.Matrix(...).to_quaternion()`,
because feeding a 3×3 nested list through Blender's Matrix constructor across 3.6/4.x is fragile
and its component order is easy to invert silently.

---

## 5. Multi-run consistency (the open/close slider)

`--mode upper` and `--mode lower` runs **must** share one centring or the two arches will not
mesh. `frame.json` in the case dir caches the centre, arch extent and input fingerprints
(`schema_version: 2`). Consequences, all intentional:

* second run reuses the cached centre;
* missing file → the first run must be `--mode combined` or you get a loud error;
* cached centre ≠ recomputed centre → hard failure telling you to delete `frame.json`;
* differing inputs → warning, because the extents drifted.

Merge metadata from separate arch passes with:

```bash
python pipeline/postprocess_dental_gs.py --merge_meta \
  output/caseA/web_assets/tooth_meta_upper.json \
  output/caseA/web_assets/tooth_meta_lower.json \
  --out_dir output/caseA/web_assets
```

It errors on any key collision instead of silently overwriting tooth `FDI_16`.

---

## 6. Hand-off to your converter

`run_case.sh` ends by printing exactly one `[NEXT]` line with the flag set you specified; nothing
here implements `.dspk`.

```
[NEXT] node tools/ply2dspk.mjs output/<case>/web_assets/dental_pruned.ply --labels output/<case>/web_assets/fdi_labels.bin --layer-labels output/<case>/web_assets/layer_labels.bin --meta output/<case>/web_assets/tooth_meta_combined.json --out public/assets/sceneA.dspk
```

---

## 7. What is NOT verified

1b. **Blender render: executed once, on a real scan, and it needed four fixes.** On 2026-11-25
   `dental_pipeline_blender.py` ran end to end for the first time (Blender 4.5.9 LTS, RTX 5070 Ti,
   OptiX) on the Poseidon3D mandible converted by `tools/stl_to_obj_labels.mjs`: 120 views at
   1024²/48 spp, COLMAP sparse text, proxy GLB and tooth meta. Four bugs had to be fixed first —
   `rotation_to_quaternion_wxyz` unpacked four numbers from a 3-vector (pinned now by
   `pipeline/test_camera_math.py`); the camera was driven by `to_track_quat` while `images.txt` came
   from `look_at_world_to_camera`, a 180° roll apart at steep elevations; render paths were relative
   and resolved against "//"; and (in the web renderer, not Blender) the quaternion attribute was
   normalised without the [0,1]→[-1,1] remap. **gsplat training has still never run** — torch is
   installed on the V100 and `pipeline/bootstrap_gsplat.sh` prepares gsplat, but the jump host kept
   shedding the session before the example trainer started.

Stated plainly so nothing fails mysteriously on your machine:

1. **Python: executed, but only on synthetic fixtures.** The interpreter claim above was true in
   November 2026 and is now superseded: `python` on PATH is still broken, but a working CPython
   3.12 venv exists at `/tmp/dspy` (numpy, scipy, plyfile, nibabel), and `npm run test:pipeline`
   drives the CBCT route through it — `tools/make_tf3_fixture.py` writes an analytically labelled
   volume, `pipeline/toothfairy2_to_layers.py` converts it, and
   `tools/verify_cbct_route.py` re-derives 46 checks from the files on disk (row alignment, the
   layer byte, the FDI+100 round trip, the Y-up mm frame signs, the manifest's own sha, colour
   windowing, plus repeatability of the converter and byte-identity of the rebuilt `.dspk`).
   That rebuilt container — `tools/out/cbct_route/sceneB_from_nifti.dspk`, sha `118058fc20aaec00…` —
   has also been loaded in the browser and read back pixel-wise; the digests and the verdicts are
   registered in `MEASUREMENTS.md` §7, and `npm run test:claims` re-hashes every file that section
   names on each `npm run check`.
   What is still **not** executed: `postprocess_dental_gs.py` against a real trained `.ply`
   (the coverage pruner has only been exercised by the Node-side tests and by reading),
   `dental_pipeline_blender.py` (updated 2026-11-25: it has now run — see item 1b below, which also
   records the four bugs its first run exposed), and the Scene A `run_case.sh` chain
   end to end. `npm run pycheck` only compiles them. Expect first-run fixes there.
2. **Blender version drift.** Principled BSDF input names changed between 3.6 and 4.x
   (`Specular` → `Specular IOR Level`, etc.). Every property write is wrapped in try/except with
   a fallback, and modifier application uses `temp_override` with a select+active fallback. If
   your Blender build renames something again, the script degrades with a warning rather than dying.
3. **3DTeethSeg JSON field name.** `load_fdi_labels` accepts `labels`, and falls back to
   `points` / `per_point_labels` / `vertex_labels` with a warning, then hard-checks that the array
   length equals the number of `v` lines in the OBJ. If your release nests labels differently, the
   loader will tell you the keys it actually found rather than guessing.
4. **OBJ texture/normal index independence.** Face tokens `v/vt/vn` are parsed by taking the
   vertex component only, so `vt`/`vn` never shift vertex indices; negative indices resolve as
   `len(verts)+i`. Assumes the shipped OBJs carry no polygonal faces beyond triangles/quads after
   fan triangulation.
5. **`--min_face_per_tooth` default of 24** is an engineering guess for "tiny sliver", not a
   value from the literature. Tune per dataset.
6. **gsplat output path** (`result_dir/ply/point_cloud_<step>.ply`) follows the current example
   script; `run_case.sh` therefore globs both `gs_model/ply/*.ply` and
   `gs_model/point_cloud/iteration_*/point_cloud.ply` and uses the newest.
7. **Wall-clock numbers in §1** are typical ranges for comparable scenes, not measurements of
   this code on your hardware.
