#!/usr/bin/env bash
# train_2dgs.sh -- launch the official 2DGS repo (hbb1/2d-gaussian-splatting) on a
# DentSplat case. 2DGS gives cleaner surface normals and burr-free cross-sections,
# which is what you want when slicing the arch to look at interproximal contacts.
#
# Usage:  bash pipeline/train_2dgs.sh <case_dir> [extra train.py args...]
#         CASE=output/case01 ITERATIONS=15000 bash pipeline/train_2dgs.sh output/case01
#
# Output ply lands at <case_dir>/gs2d_model/point_cloud/iteration_<ITERATIONS>/point_cloud.ply
set -euo pipefail

CASE="${1:-${CASE:-}}"
if [[ $# -gt 0 ]]; then shift; fi
if [[ -z "${CASE}" ]]; then
  echo "FATAL: pass a case directory, e.g. bash pipeline/train_2dgs.sh output/case01" >&2
  exit 2
fi

DATA_DIR="${CASE}/colmap_dataset"
MODEL_DIR="${CASE}/gs2d_model"
REPO="${TWODGS_DIR:-$HOME/2d-gaussian-splatting}"
ITERATIONS="${ITERATIONS:-15000}"
SH_DEGREE="${SH_DEGREE:-3}"
RES="${RES_FACTOR:-1}"
LAMBDA_NORMAL="${LAMBDA_NORMAL:-0.05}"
LAMBDA_DIST="${LAMBDA_DISTORTION:-1000}"
DEPTH_RATIO="${DEPTH_RATIO:-0}"
PYTHON="${PYTHON:-python}"

if [[ ! -d "${DATA_DIR}/images" ]]; then
  echo "FATAL: ${DATA_DIR}/images not found. Run dental_pipeline_blender.py first." >&2
  exit 3
fi
if [[ ! -f "${REPO}/train.py" ]]; then
  cat <<EOF
[MISSING] 2DGS repo not found at: ${REPO}
Install with:
    git clone --recursive https://github.com/hbb1/2d-gaussian-splatting.git ~/2d-gaussian-splatting
    conda env create --file ~/2d-gaussian-splatting/environment.yml && conda activate surfel_splatting
    # faster (and the fix for disk-aliasing): git submodule update --remote
    #                     pip install submodules/diff-surfel-rasterization
Or point TWODGS_DIR=/your/path at an existing clone.
EOF
  exit 4
fi
if compgen -G "${MODEL_DIR}/point_cloud/iteration_*/point_cloud.ply" >/dev/null; then
  echo "[SKIP] trained ply already exists under ${MODEL_DIR}/point_cloud/"
  exit 0
fi
mkdir -p "${MODEL_DIR}"

echo "[INFO] 2DGS train: ${DATA_DIR} -> ${MODEL_DIR} (iterations=${ITERATIONS}, sh=${SH_DEGREE})"
echo "[NOTE] Flag names verified against hbb1/2d-gaussian-splatting README:"
echo "       --lambda_normal, --lambda_distortion, --depth_ratio (0 = mean depth)."
echo "[NOTE] No --white_background: our renders are black, matching the dark medical UI."

cd "${REPO}"
set -x
"${PYTHON}" train.py \
  -s "${DATA_DIR}" \
  -m "${MODEL_DIR}" \
  -r "${RES}" \
  --sh_degree "${SH_DEGREE}" \
  --iterations "${ITERATIONS}" \
  --depth_ratio "${DEPTH_RATIO}" \
  --lambda_normal "${LAMBDA_NORMAL}" \
  --lambda_distortion "${LAMBDA_DIST}" \
  "$@"
set +x

PLY="${MODEL_DIR}/point_cloud/iteration_${ITERATIONS}/point_cloud.ply"
echo "[DONE] ${PLY}"
if [[ ! -f "${PLY}" ]]; then
  echo "[WARN] expected ply not found yet; check ${MODEL_DIR}/point_cloud/ for the actual iteration dir."
  ls -1 "${MODEL_DIR}/point_cloud" 2>/dev/null || true
fi
echo "[NEXT] python pipeline/postprocess_dental_gs.py --ply ${PLY} \\"
echo "         --proxy_glb ${CASE}/web_assets/proxy_teeth_combined.glb \\"
echo "         --out_dir ${CASE}/web_assets --max_splats 120000 --sh_degree 1"
