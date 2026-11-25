#!/usr/bin/env bash
# Turn one Blender-rendered case (tools/out/<dir>/case) into a trained .dspk pair for the viewer.
#
#   bash tools/build-demo-case.sh upper U scene_upper "上层 U"
#   bash tools/build-demo-case.sh crown P scene_crown "上层 P"
#
# Steps: Brush 15k (SH1) -> -90 deg Y frame fix (positions, quaternions, l=1) -> DSPK -> prune x3.
# Labels: these two scans were never given a per-splat FDI side-car in this pass, so the container
# carries FDI 0 for every splat. The odontogram is therefore empty for them by design, not by a bug.
set -euo pipefail
DIR="${1:?case dir under tools/out}"; ID="${2:?case id, e.g. U}"
ASSET="${3:?asset stem}"; LABEL="${4:-$DIR}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CASE="tools/out/$DIR/case"
OUT="tools/out/$DIR/brush"
BRUSH="$ROOT/tools/out/brush/brush_app.exe"
NAME="case${ID}"

[[ -d "$CASE/colmap_dataset/images" ]] || { echo "no renders in $CASE"; exit 2; }
[[ -d "$CASE/colmap_dataset/sparse/0" ]] || { echo "no colmap sparse in $CASE"; exit 2; }
[[ -f "$CASE/web_assets/proxy_teeth_upper.glb" ]] || echo "warn: proxy not written yet"

mkdir -p "$OUT"
if [[ ! -f "$OUT/${NAME}_15000.ply" ]]; then
  echo "[1/4] Brush 15000 steps: $LABEL"
  "$BRUSH" "$(cygpath -m "$CASE/colmap_dataset")" \
    --total-steps 15000 --sh-degree 1 --eval-split-every 10 --eval-every 2000 \
    --export-every 15000 --export-path "$(cygpath -m "$OUT")" --export-name "${NAME}_{iter}.ply"
fi

echo "[2/4] frame fix (R_y(-90), q'=q_R q, l=1 (c0,c1,c2)->(c0,-c2,c1))"
node tools/ply-frame-fix.mjs --in "$OUT/${NAME}_15000.ply" --out "$OUT/${NAME}_viewer.ply"

echo "[3/4] DSPK"
node tools/ply2dspk.ts --in "$OUT/${NAME}_viewer.ply" \
  --out "public/assets/${ASSET}_full.dspk" --meta-out "public/assets/meta_${ID}.json" \
  --kind ios --case "$ID" | tail -4

echo "[4/4] prune x3"
node tools/dspk-decimate.mjs --in "public/assets/${ASSET}_full.dspk" --every 3 \
  --out "public/assets/${ASSET}_pruned.dspk"

if [[ -f "$CASE/web_assets/proxy_teeth_upper.glb" ]]; then
  cp "$CASE/web_assets/proxy_teeth_upper.glb" "public/assets/proxy_${ID}.glb"
fi
# the per-FDI meta from Blender carries bboxes/centroids; keep it next to the DSPK for the panel
if [[ -f "$CASE/web_assets/tooth_meta_upper.json" ]]; then
  cp "$CASE/web_assets/tooth_meta_upper.json" "public/assets/meta_${ID}_teeth.json"
fi
ls -l "public/assets/${ASSET}_full.dspk" "public/assets/${ASSET}_pruned.dspk"
