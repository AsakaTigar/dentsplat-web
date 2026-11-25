#!/usr/bin/env bash
# train_gsplat.sh -- launch gsplat MCMC training on a DentSplat COLMAP case.
#
# Usage:  bash pipeline/train_gsplat.sh <case_dir> [extra gsplat args...]
#         CASE=output/case01 MAX_STEPS=15000 CAP_MAX=150000 bash pipeline/train_gsplat.sh
#
# Expects <case_dir>/colmap_dataset to exist (produced by dental_pipeline_blender.py).
# Writes <case_dir>/gs_model/ply/point_cloud_<step>.ply, which postprocess_dental_gs.py
# consumes. Requires a CUDA GPU; this script does its best to detect it and otherwise
# prints the exact command for you to run on the GPU box instead of failing silently.
set -euo pipefail

CASE="${1:-${CASE:-}}"
if [[ $# -gt 0 ]]; then shift; fi
if [[ -z "${CASE}" ]]; then
  echo "FATAL: pass a case directory, e.g. bash pipeline/train_gsplat.sh output/case01" >&2
  exit 2
fi

DATA_DIR="${CASE}/colmap_dataset"
RESULT_DIR="${CASE}/gs_model"
GSPLAT_DIR="${GSPLAT_DIR:-$HOME/gsplat}"
TRAINER="${GSPLAT_DIR}/examples/simple_trainer.py"
MAX_STEPS="${MAX_STEPS:-15000}"
CAP_MAX="${CAP_MAX:-150000}"
SH_DEGREE="${SH_DEGREE:-3}"
RES_FACTOR="${RES_FACTOR:-1}"
SEED="${SEED:-1337}"
PYTHON="${PYTHON:-python}"

if [[ ! -d "${DATA_DIR}/images" ]]; then
  echo "FATAL: ${DATA_DIR}/images not found. Run dental_pipeline_blender.py first:" >&2
  echo "  blender --background --python pipeline/dental_pipeline_blender.py -- --out_dir ${CASE} ..." >&2
  exit 3
fi
N_IMG="$(find "${DATA_DIR}/images" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')"
echo "[INFO] case=${CASE} images=${N_IMG} steps=${MAX_STEPS} cap_max=${CAP_MAX} sh=${SH_DEGREE}"

if [[ ! -f "${TRAINER}" ]]; then
  cat <<EOF
[MISSING] gsplat example trainer not found at:
    ${TRAINER}
Set GSPLAT_DIR to your clone, or install with:
    git clone --recursive https://github.com/nerfstudio-project/gsplat.git ~/gsplat
    cd ~/gsplat && ${PYTHON} -m pip install -e . && cd examples && ${PYTHON} -m pip install -r requirements.txt
Then re-run this script.
EOF
  exit 4
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  if ! nvidia-smi -L >/dev/null 2>&1; then
    echo "[WARN] nvidia-smi present but reports no GPU. Training will fail unless CPU fallback is intended."
  else
    echo "[GPU] $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
  fi
else
  echo "[WARN] nvidia-smi not found. gsplat needs CUDA; run this on the GPU machine."
fi

if [[ -f "${RESULT_DIR}/ply/point_cloud_$((MAX_STEPS - 1)).ply" ]] || \
   compgen -G "${RESULT_DIR}/ply/point_cloud_*.ply" >/dev/null; then
  echo "[SKIP] existing ply found in ${RESULT_DIR}/ply -- delete it to retrain."
  exit 0
fi

mkdir -p "${RESULT_DIR}"
cd "$(dirname "${TRAINER}")"

# NOTE on flags: verified against gsplat main's examples/simple_trainer.py Config
# dataclass (tyro subcommand `mcmc`). Field names are exactly:
#   --data-dir --result-dir --data-factor --max-steps --sh-degree --init-opa
#   --save-ply --ply-steps --test-every --normalize-world-space --seed(absent)
#   --strategy (union) -> MCMCStrategy fields: cap_max, noise_lr, min_opacity,
#   refine_start_iter, refine_stop_iter, refine_every
# tyro renders nested strategy fields as --strategy.cap_max when using the union
# subcommand form; if your pinned gsplat build rejects it, drop the flag and edit
# MCMCStrategy(cap_max=...) in simple_trainer.py's configs dict instead.
set -x
"${PYTHON}" simple_trainer.py mcmc \
  --data_dir "${DATA_DIR}" \
  --result_dir "${RESULT_DIR}" \
  --data_factor "${RES_FACTOR}" \
  --max_steps "${MAX_STEPS}" \
  --sh_degree "${SH_DEGREE}" \
  --init_opa 0.5 \
  --save_ply \
  --ply_steps "${MAX_STEPS}" \
  --test_every 8 \
  --normalize_world_space False \
  --strategy.cap_max "${CAP_MAX}" \
  "$@"
set +x

echo "[DONE] model under ${RESULT_DIR}/ply/"
echo "[NEXT] python pipeline/postprocess_dental_gs.py \\"
echo "         --ply ${RESULT_DIR}/ply/point_cloud_$((MAX_STEPS - 1)).ply \\"
echo "         --proxy_glb ${CASE}/web_assets/proxy_teeth_combined.glb \\"
echo "         --out_dir ${CASE}/web_assets --max_splats 120000 --sh_degree 1"
