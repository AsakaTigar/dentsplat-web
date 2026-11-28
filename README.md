<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo.svg" />
    <img src="docs/logo.svg" alt="DentSplat" width="420" height="97" />
  </picture>
</p>

<p align="center">
  Browser-native WebGL2 3D Gaussian Splatting engine and benchmark suite for dental 3D scans and CBCT.
</p>

<p align="center">
  <a href="https://asakatigar.github.io/dentsplat-web/"><strong>Live Demo</strong></a> ·
  <a href="MEASUREMENTS.md"><strong>Measurements</strong></a> ·
  <strong>English</strong> ·
  <a href="README_ZH.md"><strong>中文</strong></a>
</p>

---

## Overview

**DentSplat** packs dental 3D Gaussian Splatting (3DGS / 2DGS) reconstructions and oriented CBCT surfel models into a self-describing binary container (`.dspk`) for zero-install WebGL2 rendering, primitive-level inspection, and reproducible geometry/compression benchmarking.

The live deployment includes 10 public dental assets—6 Brush-trained intraoral scan (IOS) 3DGS scenes, 3 DentVoxel CBCT surfel volumes, and 1 untrained surface-sampling baseline—evaluated under a shared coordinate frame and camera rig.

## Features

* **WebGL2 EWA Renderer & Gaussian Lab**: Eight shading and diagnostic views—RGB, covariance ellipsoids (`1σ / 2σ / 3σ` from `Σ = R diag(s²) Rᵀ`), centers, wireframe, opacity, scale, estimated normals, and depth.
* **Gaussian Inspector & Live Editing**: Pick any individual Gaussian to inspect `μ`, `σ`, quaternion, opacity, DC color, SH coefficients, covariance matrix, and principal axes; edit parameters interactively and export the modified cloud back to standard 3DGS `.ply`.
* **Native FP32 PLY Import**: Load binary or ASCII 3DGS `.ply` files directly in the browser on an unquantized FP32 shader path, with GPU vertex-texture evaluation for `l=2 / l=3` SH3 bands and lossless export.
* **Multi-Method Synchronized Comparison**: Side-by-side split view (Case 01 vs. Case 10) and a 2×2 synchronized-camera viewport comparing **gsplat 3DGS MCMC**, **gsplat 2DGS**, **Brush 3DGS**, and **Surface Sampling**, plus a Surface-Aligned Disks geometric baseline.
* **Training Timeline**: Step through 7 real reconstruction stages from an independent Brush run—COLMAP sparse initialization (`25,000` pts) through `1k / 2k / 3k / 5k / 10k / 15k` checkpoints (`25,581 → 28,694` splats)—with dual-viewport comparison against the final model.
* **Compression & Dental Views**: Iso-byte `10×` Uniform vs. Anatomy-Aware CBCT pruning, live browser pixel-readback PSNR/MAE, `160×140×128` linked CBCT MPR slices, FDI tooth chart, cross-section clipping, and clearance measurement.

## Benchmarks

All quantitative evaluations are reproducible and recorded with source checksums in [`MEASUREMENTS.md`](MEASUREMENTS.md) and [`public/assets/geometry_metrics.json`](public/assets/geometry_metrics.json).

### Multi-Method Reconstruction (`Poseidon3D case 000125`)

| Method | # Gaussians | SH | Test PSNR (dB) | SSIM | LPIPS | Cloud→Mesh Mean (mm) | P95 (mm) | F@0.5 mm (P / R) |
| :--- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **Brush 3DGS** (15k steps) | 28,691 | SH1 | — | — | — | **0.168** | **0.469** | **95.9% / 94.7%** |
| **gsplat 3DGS MCMC** (15k steps) | 80,000 | SH0* | **38.54** | **0.9855** | **0.02245** | 0.370 | 1.544 | 79.2% / 76.5% |
| **gsplat 2DGS** (15k steps) | 24,198 | SH0* | 38.48 | 0.9842 | 0.02340 | 0.416 | 1.643 | 72.9% / 65.0% |
| **Surface Sampling** (0.35 mm, untrained) | 59,808 | SH0 | — | — | — | 0.0002 | 0.0004 | 100.0% / 99.97% |

> **Protocol notes:** Multi-view IOS training uses 120 Blender renders from the ground-truth scan (`105 train / 15 test` held-out split for gsplat 3DGS and 2DGS; Brush CLI does not emit validation logs). Cloud→mesh uses exact point-to-triangle BVH distance; mesh→cloud recall uses 120k deterministic area-weighted surface samples. Methods differ in primitive count and SH degree (web exports marked `*` are packed at SH0; DSPK carries DC + `l=1`). Desktop timing was measured on RTX 5070 Ti / Chromium.

### Compression & Timeline Summary

* **10× Iso-Byte CBCT Pruning (`DentVoxel case 0095`, 11,100 splats / 322 KB)**: Uniform pruning achieves `22.28 dB` overall; Anatomy-Aware allocation trades global PSNR (`19.75 dB`) to lift the mandibular canal (L4) from `27.63 dB → 35.84 dB` and reduce FDI 48–L4 clearance drift from `0.724 mm → 0.427 mm`.
* **3× IOS Decimation (`Case A · Trained`)**: `28,691 → 9,564` splats (`278 KB`), browser readback PSNR `31.04 dB` (full frame) / `26.37 dB` (masked).
* **Brush Checkpoint Trajectory (`1k → 15k`, independent run)**: Cloud→mesh mean shifts `0.078 → 0.166 mm`, F@0.5 mm `99.8/96.2% → 95.6/94.8%`, and normal consistency `0.613 → 0.606` as splat count grows (`25,581 → 28,694`).

## Quick Start

```bash
npm ci
npm run dev           # Local dev server at http://localhost:5177
npm run build         # Production bundle -> dist/
npm run check         # Container round-trip, label sync, metric verification, tsc
npm run test:pipeline # 46 offline CPU pipeline assertions
```

To test the production build locally with GitHub Pages subpath semantics before pushing:

```bash
node tools/serve-subpath.mjs --port 5288 --prefix dentsplat-web
```

GitHub Pages deploys automatically from `main` via `.github/workflows/deploy.yml` into the `gh-pages` branch.

## Custom CBCT Pipeline

If you have your own labeled CBCT volume in nnU-Net NIfTI layout (`<case>.nii.gz` + `<case>_0000.nii.gz`, e.g., ToothFairy2/3):

```bash
# 1. Extract multi-layer point cloud and per-point FDI / anatomy labels
python pipeline/toothfairy2_to_layers.py \
  --case_dir raw/<case> --out_dir output/<case>/web_assets \
  --schema tf3 --spacing_mm 0.8 --surface_only 1

# 2. Generate invisible per-tooth convex hull proxy aligned to the splat frame
python pipeline/cbct_proxy.py \
  --labels_nii raw/<case>/<case>.nii.gz \
  --frame_json output/<case>/frame_cbct.json \
  --meta_json output/<case>/web_assets/tooth_meta_cbct.json \
  --out output/<case>/web_assets/proxy_B.glb

# 3. Pack into DSPK and validate proxy structure
node tools/ply2dspk.ts \
  --in output/<case>/web_assets/cbct_layers.ply \
  --fdi output/<case>/web_assets/fdi_labels.bin \
  --layer output/<case>/web_assets/layer_labels.bin \
  --manifest output/<case>/web_assets/labels_manifest.json \
  --out public/assets/sceneB_from_nifti.dspk \
  --meta-out public/assets/meta_B.json --kind cbct --name sceneB

node tools/check-glb.mjs output/<case>/web_assets/proxy_B.glb --min-teeth 26
```

## Repository Layout

```text
src/engine/        DSPK container codec, WebGL2 EWA shaders, radix/counting sorter, viewer & picking
src/ui/            FDI tooth chart, Gaussian Inspector, MPR views, and workspace UI
pipeline/          Python offline preprocessing (CBCT -> oriented surfels / layers + proxy GLB)
tools/             DSPK packers, browser probe, metric audits, and regression tests
brief/             One-page technical brief & walkthrough capture scripts
docs/              Logo and technical documentation assets
MEASUREMENTS.md    Full benchmark tables, file hashes, and evaluation methodology
```

## Datasets & Acknowledgments

This repository distributes derived `.dspk` / `.glb` display assets and evaluation metadata only; raw patient NIfTI volumes and source scans are not included.

* **Poseidon3D** (`case 000125`, Kubik & Španěl, [Zenodo 15608906](https://zenodo.org/records/15608906)) — CC BY 4.0. Used for intraoral scan geometry and per-face FDI labels.
* **DentVoxel v4** (`case 0095`, [Figshare 31239889](https://figshare.com/articles/dataset/DentVoxel_a_fully_annotated_dental_CBCT_dataset_with_38_instance_anatomical_structures/31239889)) — CC BY 4.0. Used to generate oriented CBCT surfel layers (`pipeline/cbct_surfel.py`) and MPR slices.
* **Teeth3DS+** ([OSF `xctdy`](https://osf.io/xctdy/)) — CC BY-NC-ND 4.0. Supported locally via `tools/obj_labels_to_assets.mjs` (gitignored, not redistributed).
* **ToothFairy3 / ODIN2025** — CC BY-NC-SA 4.0. Supported via `pipeline/toothfairy2_to_layers.py` for users with dataset access.

> *Disclaimer: DentSplat is an academic research and visualization prototype, not a medical device. Measurements and views are not intended for clinical diagnosis.*
