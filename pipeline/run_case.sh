#!/usr/bin/env bash
# run_case.sh -- end-to-end DentSplat pipeline for ONE case.
#
#   render -> train -> postprocess -> (hand off to the .dspk converter)
#
# Idempotent and resumable: every stage checks for its own outputs and skips, so you can
# kill this mid-render and re-run the same command. Use --force to redo a stage.
#
# USAGE
#   bash pipeline/run_case.sh <case_name> --upper-obj U.obj --upper-json U.json \
#        [--lower-obj L.obj --lower-json L.json] [options]
#   bash pipeline/run_case.sh cbct01 --cbct-labels case.nii.gz --cbct-image case_0000.nii.gz
#
# The CBCT route needs no GPU at all: it emits cbct_layers.ply directly (Scene B fallback).
set -euo pipefail

# NOTE: ${BASH_SOURCE[0]} is empty in some bash 5.2 builds, so self-location uses $0 with a
# BASH_SOURCE fallback. Invoke as: bash pipeline/run_case.sh ... (path must be visible in $0).
SELF="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "${SELF}")" 2>/dev/null && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# --------------------------------------------------------------------------- #
CASE=""
UPPER_OBJ=""; UPPER_JSON=""; LOWER_OBJ=""; LOWER_JSON=""
CBCT_LABELS=""; CBCT_IMAGE=""; CBCT_ARCH="auto"
MODE="combined"; NUM_VIEWS=120; RES=1024; SAMPLES=48; SEED=1337
TRAIN="gsplat"; SKIP_TRAIN=0; COPY_PROXY_ONLY=0; ARCH_PASS=0
MAX_SPLATS=120000; KEEP_SH=1; MIN_FACE=24; BLENDER="blender"; PYTHON="${PYTHON:-python}"
FORCE=0; DEVICE="auto"

usage() {
  cat <<'USAGE'
run_case.sh -- end-to-end DentSplat pipeline for ONE case.
  render -> train -> postprocess -> (hand off to the .dspk converter)
Idempotent and resumable: each stage checks its own outputs and skips. Use --force to redo.

SYNOPSIS
  bash pipeline/run_case.sh <case> --upper-obj U.obj --upper-json U.json \
       [--lower-obj L.obj --lower-json L.json] [options]
  bash pipeline/run_case.sh <case> --cbct-labels case.nii.gz [--cbct-image img.nii.gz]

Mesh-route options
  --mode combined|upper|lower   which proxy/meta set to build (default combined)
  --views N                     orbit renders per arch          (default 120)
  --res N                       image size, square              (default 1024)
  --samples N                   Cycles samples                  (default 48)
  --seed N                      all RNGs + Cycles seed          (default 1337)
  --min-face-per-tooth N        FDI slivers below this merge into gingiva (default 24)
  --device auto|gpu|cpu         Cycles device                   (default auto)
  --blender PATH                blender executable (must be on PATH otherwise)
  --arch-pass                   also emit per-arch upper/lower passes
CBCT route
  --cbct-arch auto|upper|lower|both   jaw crop for ToothFairy2 volumes
Training / assets
  --train gsplat|2dgs|none      trainer to launch               (default gsplat)
  --skip-train                  stop after rendering
  --copy-proxy-only             no training at all: derive dental_pruned.ply from the proxy
  --max-splats N                pruning budget                  (default 120000)
  --keep-sh N                   SH degree kept in the output ply (default 1)
  --python PATH                 system python for postprocess (default: env PYTHON, else python)
  --force                       redo stages even if outputs exist
USAGE
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upper-obj)   UPPER_OBJ="$2"; shift 2;;
    --upper-json)  UPPER_JSON="$2"; shift 2;;
    --lower-obj)   LOWER_OBJ="$2"; shift 2;;
    --lower-json)  LOWER_JSON="$2"; shift 2;;
    --cbct-labels) CBCT_LABELS="$2"; shift 2;;
    --cbct-image)  CBCT_IMAGE="$2"; shift 2;;
    --cbct-arch)   CBCT_ARCH="$2"; shift 2;;
    --mode)        MODE="$2"; shift 2;;
    --views)       NUM_VIEWS="$2"; shift 2;;
    --res)         RES="$2"; shift 2;;
    --samples)     SAMPLES="$2"; shift 2;;
    --seed)        SEED="$2"; shift 2;;
    --train)       TRAIN="$2"; shift 2;;
    --skip-train)  SKIP_TRAIN=1; shift;;
    --copy-proxy-only) COPY_PROXY_ONLY=1; shift;;
    --arch-pass)   ARCH_PASS=1; shift;;
    --max-splats)  MAX_SPLATS="$2"; shift 2;;
    --keep-sh)     KEEP_SH="$2"; shift 2;;
    --min-face-per-tooth) MIN_FACE="$2"; shift 2;;
    --blender)     BLENDER="$2"; shift 2;;
    --python)      PYTHON="$2"; shift 2;;
    --device)      DEVICE="$2"; shift 2;;
    --force)       FORCE=1; shift;;
    -h|--help)     usage 0;;
    -*)            echo "unknown option: $1" >&2; echo "see: bash pipeline/run_case.sh --help" >&2; exit 2;;
    *)             if [[ -z "${CASE}" ]]; then CASE="$1"; shift; else
                     echo "unexpected argument: $1" >&2; usage 2; fi;;
  esac
done

[[ -z "${CASE}" ]] && { echo "FATAL: case name required as the first argument" >&2; usage 2; }
case "${MODE}" in combined|upper|lower) ;; *) echo "FATAL: --mode must be combined|upper|lower" >&2; exit 2;; esac
case "${TRAIN}" in gsplat|2dgs|none) ;; *) echo "FATAL: --train must be gsplat|2dgs|none" >&2; exit 2;; esac

OUT="output/${CASE}"
WEB="${OUT}/web_assets"
COLMAP="${OUT}/colmap_dataset"
mkdir -p "${OUT}" "${WEB}"

STAGES=()
banner() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { [[ -f "$1" ]]; }
# NOTE: under `set -e`, a *failing* command substitution aborts the shell before any message
# prints (bash 5.2, observed). Never assign directly from ls/find/wc -- use the glob-based
# helpers below, which always succeed and always assign a value.
shopt -s nullglob
count_png() { local n=0 f; for f in "$1"/*.png; do n=$((n+1)); done; printf '%s' "$n"; }
latest_file() { local f="" c; for c in "$@"; do [[ -f "$c" && "$c" -nt "$f" ]] && f="$c"; done; printf '%s' "$f"; }

# ---------------------------------------------------------------- validations
IS_CBCT=0
if [[ -n "${CBCT_LABELS}" ]]; then
  IS_CBCT=1
  if [[ ! -f "${CBCT_LABELS}" ]]; then echo "FATAL: --cbct-labels file not found: ${CBCT_LABELS}" >&2; exit 3; fi
  if [[ -n "${CBCT_IMAGE}" && ! -f "${CBCT_IMAGE}" ]]; then echo "FATAL: --cbct-image file not found: ${CBCT_IMAGE}" >&2; exit 3; fi
else
  if [[ ! -f "${UPPER_OBJ}" ]]; then echo "FATAL: --upper-obj required and must be an existing file (or use --cbct-labels): '${UPPER_OBJ}'" >&2; exit 3; fi
  if [[ ! -f "${UPPER_JSON}" ]]; then echo "FATAL: --upper-json must be an existing file: '${UPPER_JSON}'" >&2; exit 3; fi
  if [[ -n "${LOWER_OBJ}" && ! -f "${LOWER_OBJ}" ]]; then echo "FATAL: --lower-obj not found: ${LOWER_OBJ}" >&2; exit 3; fi
  if [[ -n "${LOWER_JSON}" && ! -f "${LOWER_JSON}" ]]; then echo "FATAL: --lower-json not found: ${LOWER_JSON}" >&2; exit 3; fi
  if [[ -n "${LOWER_OBJ}" && -z "${LOWER_JSON}" ]] || [[ -z "${LOWER_OBJ}" && -n "${LOWER_JSON}" ]]; then
    echo "FATAL: --lower-obj and --lower-json must be given together" >&2; exit 3
  fi
fi
if [[ "${IS_CBCT}" -eq 1 ]]; then
  # The CBCT route has no arch passes: --mode/--views/--res are meaningless there.
  if [[ "${MODE}" != "combined" ]]; then echo "FATAL: --mode is a mesh-route option; the CBCT route uses --cbct-arch" >&2; exit 2; fi
  if ! command -v "${PYTHON}" >/dev/null 2>&1; then
    echo "FATAL: python executable '${PYTHON}' not found (needed by toothfairy2_to_layers.py)." >&2
    echo "       Pass --python /path/to/python with numpy/scipy/trimesh/plyfile/nibabel installed." >&2
    exit 4
  fi
else
  if [[ "${MODE}" == "upper" || "${MODE}" == "lower" ]]; then
    if [[ "${ARCH_PASS}" -ne 1 ]]; then
      echo "NOTE: --mode ${MODE} writes an arch-specific GLB/meta that shares frame.json with the"
      echo "      other arch. Pass --arch-pass to confirm you intend a single-arch run."
    fi
  fi
  if [[ "${MODE}" == "combined" && -z "${LOWER_OBJ}" ]]; then
    echo "NOTE: combined mode with only one arch -- the open/close slider has nothing to animate."
  fi
  if ! command -v "${BLENDER}" >/dev/null 2>&1; then
    echo "FATAL: '${BLENDER}' not found on PATH. Install Blender 3.6/4.x or pass --blender /path/to/blender" >&2
    exit 4
  fi
  if ! command -v "${PYTHON}" >/dev/null 2>&1; then
    echo "FATAL: python executable '${PYTHON}' not found (needed by postprocess_dental_gs.py)." >&2
    echo "       Pass --python /path/to/python with numpy/scipy/trimesh/plyfile installed." >&2
    exit 4
  fi
fi

banner "DentSplat case '${CASE}'"
echo "  out dir      : ${OUT}"
if [[ "${IS_CBCT}" -eq 1 ]]; then
  # Six layers, not three: this route forwards neither --layers nor --schema, so the converter's
  # defaults apply -- tf3 (pulp = FDI+100) and alveolar/teeth/nerve/pulp/restoration/sinus.
  echo "  route        : CBCT segmentation -> six aligned layers (no GPU, no training)"
  echo "  jaw crop     : ${CBCT_ARCH}    seed=${SEED}"
else
  echo "  route        : surface mesh (render + train)"
  echo "  mode         : ${MODE}   views=${NUM_VIEWS}@${RES}px  samples=${SAMPLES}  seed=${SEED}"
  echo "  train        : $([[ ${COPY_PROXY_ONLY} -eq 1 ]] && echo "skipped (proxy placeholder)" || echo "${TRAIN}")"
fi
echo "  keep splats  : ${MAX_SPLATS} @ SH degree ${KEEP_SH}"

# =============================================================== CBCT ROUTE
if [[ "${IS_CBCT}" -eq 1 ]]; then
  banner "[1/2] CBCT segmentation -> six aligned layers"
  if [[ -f "${WEB}/cbct_layers.ply" && "${FORCE}" -eq 0 ]]; then
    echo "[SKIP] ${WEB}/cbct_layers.ply exists (use --force)"
  else
    ARGS=(--labels_nii "${CBCT_LABELS}" --out_dir "${WEB}" --arch "${CBCT_ARCH}" --seed "${SEED}")
    if [[ -n "${CBCT_IMAGE}" ]]; then ARGS+=(--image_nii "${CBCT_IMAGE}"); else ARGS+=(--flat_colour); fi
    "${PYTHON}" pipeline/toothfairy2_to_layers.py "${ARGS[@]}"
  fi
  STAGES+=("cbct_layers")
  banner "[2/2] hand-off"
  if [[ ! -s "${WEB}/tooth_meta_cbct.json" ]]; then
    echo "FATAL: toothfairy2_to_layers.py did not write ${WEB}/tooth_meta_cbct.json" >&2
    echo "       Check its output above; the converter needs meta with a \"layer\" per FDI entry." >&2
    exit 5
  fi
  cp "${WEB}/tooth_meta_cbct.json" "${WEB}/tooth_meta_combined.json"
  echo "       tooth_meta_cbct.json -> tooth_meta_combined.json (single-source case)"
  for f in "${WEB}/cbct_layers.ply" "${WEB}/tooth_meta_combined.json" \
           "${WEB}/labels_manifest.json"; do
    if [[ ! -s "${f}" ]]; then echo "FATAL: expected artefact missing or empty: ${f}" >&2; exit 5; fi
  done
  # label bins are uint8[N]; N can be small, so only require that they exist
  for f in "${WEB}/fdi_labels.bin" "${WEB}/layer_labels.bin"; do
    if [[ ! -f "${f}" ]]; then echo "FATAL: expected artefact missing: ${f}" >&2; exit 5; fi
  done
  echo "[NEXT] node tools/ply2dspk.ts --in ${WEB}/cbct_layers.ply --fdi ${WEB}/fdi_labels.bin --layer ${WEB}/layer_labels.bin --manifest ${WEB}/labels_manifest.json --out public/assets/sceneB_from_nifti.dspk --meta-out public/assets/meta_B.json --kind cbct --name sceneB"
  banner "SUMMARY :: ${WEB}"
  for f in "${WEB}"/*; do printf '  %10s  %s\n' "$(du -h "$f" | cut -f1)" "$f"; done
  echo "  stages completed: ${STAGES[*]}"
  exit 0
fi

# ================================================================ MESH ROUTE
OVERWRITE_FLAG=()
[[ "${FORCE}" -eq 1 ]] && OVERWRITE_FLAG=(--overwrite)

# ---- Stage 1: Blender render + COLMAP + proxy GLB ----
banner "[1/4] Blender: renders, COLMAP poses, proxy GLB (mode=${MODE})"
PROXY_GLB="${WEB}/proxy_teeth_${MODE}.glb"
META_JSON="${WEB}/tooth_meta_${MODE}.json"
N_PNG=$(count_png "${COLMAP}/images")
if [[ -f "${PROXY_GLB}" && -f "${COLMAP}/sparse/0/images.txt" && ${N_PNG} -ge ${NUM_VIEWS} && ${FORCE} -eq 0 ]]; then
  echo "[SKIP] ${N_PNG}/${NUM_VIEWS} renders + ${PROXY_GLB} already present"
else
  BL_ARGS=(--out_dir "${OUT}" --mode "${MODE}" --num_views "${NUM_VIEWS}" --res "${RES}"
           --samples "${SAMPLES}" --seed "${SEED}" --min_face_per_tooth "${MIN_FACE}"
           --device "${DEVICE}" "${OVERWRITE_FLAG[@]}")
  BL_ARGS+=(--upper_obj "${UPPER_OBJ}" --upper_json "${UPPER_JSON}")
  [[ -n "${LOWER_OBJ}" ]] && BL_ARGS+=(--lower_obj "${LOWER_OBJ}" --lower_json "${LOWER_JSON}")
  "${BLENDER}" --background --python pipeline/dental_pipeline_blender.py -- "${BL_ARGS[@]}"
fi
STAGES+=("render")
for f in "${COLMAP}/sparse/0/cameras.txt" "${COLMAP}/sparse/0/images.txt" \
         "${PROXY_GLB}" "${META_JSON}" "${OUT}/frame.json"; do
  if [[ ! -s "${f}" ]]; then echo "FATAL: expected artefact missing or empty after render: ${f}" >&2; exit 5; fi
done
# points3D.txt may legitimately be empty (we train from renders + poses; gsplat does not need it)
if [[ ! -f "${COLMAP}/sparse/0/points3D.txt" ]]; then
  echo "FATAL: ${COLMAP}/sparse/0/points3D.txt was not written at all" >&2; exit 5
fi
N_POSE_LINES=$(grep -c '^[0-9]' "${COLMAP}/sparse/0/images.txt")
echo "[OK] render artefacts verified (${N_POSE_LINES} COLMAP image lines)"
if [[ "${N_POSE_LINES}" -lt "${NUM_VIEWS}" ]]; then
  echo "FATAL: images.txt has ${N_POSE_LINES} poses but ${NUM_VIEWS} renders were requested -- frame.json/mode mismatch?" >&2
  exit 5
fi

# ---- Stage 1b: optional second arch sharing frame.json ----
if [[ "${MODE}" == "combined" && -n "${LOWER_OBJ}" && "${ARCH_PASS}" -eq 1 ]]; then
  banner "[1b] extra upper/lower passes (shares ${OUT}/frame.json)"
  for m in upper lower; do
    "${BLENDER}" --background --python pipeline/dental_pipeline_blender.py -- \
      --out_dir "${OUT}" --mode "${m}" --num_views "${NUM_VIEWS}" --res "${RES}" \
      --samples "${SAMPLES}" --seed "${SEED}" --device "${DEVICE}" \
      --upper_obj "${UPPER_OBJ}" --upper_json "${UPPER_JSON}" \
      --lower_obj "${LOWER_OBJ}" --lower_json "${LOWER_JSON}"
  done
fi

COMBINED_META="${WEB}/tooth_meta_combined.json"
if [[ ! -s "${COMBINED_META}" ]]; then
  if [[ -f "${WEB}/tooth_meta_upper.json" && -f "${WEB}/tooth_meta_lower.json" ]]; then
    banner "[1c] merging per-arch metadata"
    "${PYTHON}" pipeline/postprocess_dental_gs.py --merge_meta \
      "${WEB}/tooth_meta_upper.json" "${WEB}/tooth_meta_lower.json" --out_dir "${WEB}"
  elif [[ -f "${META_JSON}" ]]; then
    cp "${META_JSON}" "${COMBINED_META}"
    echo "[INFO] copied ${META_JSON} -> ${COMBINED_META}"
  fi
fi

# ---- Stage 2: training ----
PLY=""
if [[ "${SKIP_TRAIN}" -eq 1 ]]; then
  banner "[2/4] training SKIPPED (--skip-train): render-only run"
elif [[ "${COPY_PROXY_ONLY}" -eq 1 ]]; then
  banner "[2/4] training SKIPPED (--copy-proxy-only): writing proxy-derived assets"
elif [[ "${TRAIN}" == "none" ]]; then
  banner "[2/4] training disabled (--train none)"
else
  banner "[2/4] Gaussian training via ${TRAIN}"
  # A ply produced earlier (or copied in from the GPU box) always wins over retraining.
  if [[ "${TRAIN}" == "gsplat" ]]; then
    PLY=$(latest_file "${OUT}/gs_model/ply/"*.ply "${OUT}"/gs_model/point_cloud/iteration_*/point_cloud.ply)
  else
    PLY=$(latest_file "${OUT}"/gs2d_model/point_cloud/iteration_*/point_cloud.ply "${OUT}/gs_model/ply/"*.ply)
  fi
  if [[ -n "${PLY}" ]]; then
    echo "[SKIP] found trained ply, not launching training again: ${PLY}"
    echo "       delete it (or use --force) to retrain."
  elif [[ "${TRAIN}" == "gsplat" ]]; then
    if bash pipeline/train_gsplat.sh "${OUT}"; then
      PLY=$(latest_file "${OUT}/gs_model/ply/"*.ply "${OUT}"/gs_model/point_cloud/iteration_*/point_cloud.ply)
    else
      rc=$?
      echo "[WARN] gsplat training failed or is unavailable (exit ${rc})."
      echo "       Run it on the GPU box, e.g.:"
      echo "         bash pipeline/train_gsplat.sh ${OUT}"
      echo "       Then re-run this script; it will resume at postprocess."
      SKIP_TRAIN=1
    fi
  else
    if bash pipeline/train_2dgs.sh "${OUT}"; then
      PLY=$(latest_file "${OUT}"/gs2d_model/point_cloud/iteration_*/point_cloud.ply)
    else
      echo "[WARN] 2DGS training unavailable; re-run 'bash pipeline/train_2dgs.sh ${OUT}' on the GPU box."
      SKIP_TRAIN=1
    fi
  fi
  if [[ -z "${PLY}" ]]; then
    echo "[HINT] if you already trained elsewhere, drop the ply here and re-run:"
    echo "         ${OUT}/gs_model/ply/point_cloud_${MAX_STEPS:-15000}.ply"
  fi
fi

# ---- Stage 3: postprocess ----
banner "[3/4] prune + FDI/layer binding -> dental_pruned.ply"
BIND_ARGS=()
if [[ "${MODE}" == "combined" && -n "${LOWER_OBJ}" ]]; then
  BIND_ARGS+=(--raw_obj_upper "${UPPER_OBJ}" --raw_json_upper "${UPPER_JSON}"
              --raw_obj_lower "${LOWER_OBJ}" --raw_json_lower "${LOWER_JSON}")
else
  BIND_ARGS+=(--raw_obj "${UPPER_OBJ}" --raw_json "${UPPER_JSON}")
fi
BIND_ARGS+=(--frame_json "${OUT}/frame.json")

if [[ -n "${PLY}" && -f "${PLY}" ]]; then
  "${PYTHON}" pipeline/postprocess_dental_gs.py \
    --ply "${PLY}" --proxy_glb "${WEB}/proxy_teeth_combined.glb" \
    --out_dir "${WEB}" --max_splats "${MAX_SPLATS}" --sh_degree "${KEEP_SH}" \
    --seed "${SEED}" "${BIND_ARGS[@]}" "${OVERWRITE_FLAG[@]}"
elif [[ "${COPY_PROXY_ONLY}" -eq 1 ]]; then
  "${PYTHON}" pipeline/postprocess_dental_gs.py --copy_proxy_only \
    --proxy_glb "${WEB}/proxy_teeth_${MODE}.glb" --out_dir "${WEB}" \
    --voxel_mm 0.30 "${OVERWRITE_FLAG[@]}"
else
  echo "[WAIT] no trained ply found. Nothing to postprocess yet."
  echo "       After training completes, run:"
  echo "         python pipeline/postprocess_dental_gs.py --ply <point_cloud.ply> \\"
  echo "           --proxy_glb ${WEB}/proxy_teeth_${MODE}.glb --out_dir ${WEB} \\"
  echo "           --max_splats ${MAX_SPLATS} --sh_degree ${KEEP_SH} ${BIND_ARGS[*]}"
fi
STAGES+=("postprocess")

# ---- Stage 4: hand-off ----
banner "[4/4] hand-off to the web asset converter"
PRUNED="${WEB}/dental_pruned.ply"
if [[ -f "${PRUNED}" ]]; then
  echo "[NEXT] node tools/ply2dspk.ts --in ${PRUNED} --fdi ${WEB}/fdi_labels.bin --layer ${WEB}/layer_labels.bin --out public/assets/sceneA_pruned.dspk --meta-out public/assets/meta_A.json --kind ios --name sceneA"
else
  echo "[NEXT] (assets not ready yet) node tools/ply2dspk.ts --in output/${CASE}/web_assets/dental_pruned.ply --fdi output/${CASE}/web_assets/fdi_labels.bin --layer output/${CASE}/web_assets/layer_labels.bin --out public/assets/sceneA_pruned.dspk --meta-out public/assets/meta_A.json --kind ios --name sceneA"
fi

banner "SUMMARY :: ${OUT}"
for f in "${OUT}/frame.json" \
         "${COLMAP}/sparse/0/cameras.txt" "${COLMAP}/sparse/0/images.txt" \
         "${COLMAP}/sparse/0/points3D.txt" \
         "${WEB}/proxy_teeth_${MODE}.glb" "${META_JSON}" "${COMBINED_META}" \
         "${PRUNED}" "${WEB}/fdi_labels.bin" "${WEB}/layer_labels.bin" \
         "${WEB}/labels_manifest.json"; do
  if [[ -f "${f}" ]]; then printf '  %10s  %s\n' "$(du -h "${f}" | cut -f1)" "${f}"; else
    printf '  %10s  %s\n' "-" "${f}"; fi
done
printf '  %10s  %s\n' "$(count_png "${COLMAP}/images") png" "${COLMAP}/images"
echo "  stages completed: ${STAGES[*]}"
