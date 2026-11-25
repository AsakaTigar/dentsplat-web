#!/usr/bin/env bash
# bootstrap_gsplat.sh -- one-shot environment for pipeline/train_gsplat.sh on a CUDA box.
#
# Why this exists: getting gsplat to import is the step that ate the first remote session, and the
# reasons are all environment, not code -- torch has to be the CUDA build, gsplat compiles its
# kernels on first use and therefore needs nvcc plus the right TORCH_CUDA_ARCH_LIST (Volta is 7.0,
# Turing 7.5, Ampere 8.0/8.6), and the example trainer has its own requirements file.
#
# It is idempotent and logs next to the venv, so on a rate-limited jump host it can be launched once
# and left alone:
#
#   setsid nohup bash pipeline/bootstrap_gsplat.sh /tmp/dsv 7.0 > /tmp/dsv/bootstrap.log 2>&1 < /dev/null &
#   # ...later
#   tail -5 /tmp/dsv/bootstrap.log
#   bash pipeline/train_gsplat.sh <case_dir>        # with PYTHON=/tmp/dsv/bin/python
#
# Usage: bash pipeline/bootstrap_gsplat.sh [venv_dir] [arch, e.g. 7.0|7.5|8.6]
set -euo pipefail

VENV="${1:-$HOME/dsv}"
ARCH="${2:-7.0}"
GSPLAT_DIR="${GSPLAT_DIR:-${VENV}/gsplat}"
PY="${VENV}/bin/python"

echo "[1/5] venv ${VENV}"
if [ ! -x "${PY}" ]; then python3 -m venv "${VENV}"; fi
"${PY}" -m pip -q install --upgrade pip

echo "[2/5] torch (cu121)"
if ! "${PY}" -c "import torch" >/dev/null 2>&1; then
  "${PY}" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
fi
"${PY}" -c "import torch; assert torch.cuda.is_available(), 'torch sees no GPU'; print('  torch', torch.__version__, 'on', torch.cuda.get_device_name(0))"

echo "[3/5] gsplat source at ${GSPLAT_DIR}"
if [ ! -f "${GSPLAT_DIR}/examples/simple_trainer.py" ]; then
  rm -rf "${GSPLAT_DIR}"
  git clone --recursive https://github.com/nerfstudio-project/gsplat "${GSPLAT_DIR}"
fi
git -C "${GSPLAT_DIR}" rev-parse --short HEAD

echo "[4/5] gsplat + example requirements (this compiles kernels on first use)"
export TORCH_CUDA_ARCH_LIST="${ARCH}"
"${PY}" -m pip -q install -r "${GSPLAT_DIR}/examples/requirements.txt"
"${PY}" -m pip -q install -e "${GSPLAT_DIR}"

echo "[5/5] smoke"
"${PY}" - <<'PY'
import torch, gsplat
x = torch.rand(4, 3, device="cuda", requires_grad=True)
print("  gsplat", getattr(gsplat, "__version__", "?"), "imported; cuda tensor ok:", x.sum().item() >= 0.0)
PY

cat <<EOF

ready. train with:
  PYTHON=${PY} GSPLAT_DIR=${GSPLAT_DIR} TORCH_CUDA_ARCH_LIST=${ARCH} bash pipeline/train_gsplat.sh <case_dir>
then postprocess (labels via the proxy) and convert with tools/ply2dspk.ts as the script prints.
EOF
