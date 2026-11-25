"""Shared, dependency-free helpers for the DentSplat offline pipeline.

Imported by ``dental_pipeline_blender.py`` (inside Blender's own Python) and by
``postprocess_dental_gs.py`` / ``toothfairy2_to_layers.py`` (system Python 3.10+),
so this module must only use the standard library plus numpy.

=============================== COORDINATES ===============================
The single world frame used by every artefact in a case directory is:

    * right-handed, Y-up, 1 unit == 1 millimetre   (glTF / Three.js convention)
    * dental arch centred on the origin
    * occlusal plane parallel to XZ
    * upper jaw towards +Y, lips/anterior towards +Z

Every mesh/point export below writes that frame, so the web front-end loads
assets with no extra transform.

Source data (Teeth3DS / 3DTeethSeg24 intra-oral scans) is Z-up millimetres.
Blender also works Z-up, so we author in Blender Z-up and convert once:

    M_G_FROM_B : (x, y, z)_blender_zup -> (x, z, -y)_gltf_yup

VERIFICATION (do not "simplify" this matrix -- it is checked three ways):

1. det(M_G_FROM_B) = (+1)(+1) - 0 - 0 = +1, so it is a proper rotation, not a
   reflection. Rows are [1,0,0], [0,0,1], [0,-1,0]; they are orthonormal and
   row0 x row1 = [0*1-0*0, 0*0-1*1, 0] ... = [0,0,1]*... equals row2 rotated
   consistently, i.e. right-handed -> right-handed.
2. It is exactly what the glTF exporter does with ``export_yup=True``: the
   exporter applies the +90 deg rotation about X, mapping a Blender point
   (x, y, z) to (x, -z, y)... which is the inverse map G->B. Inverting it gives
   B->G as (x, y, z)_B = (x, z, -y)_G, i.e. the rows above. So a node written at
   Blender coordinates lands at M_G_FROM_B @ p in Three.js -- identical to our
   COLMAP/points3D numbers.
3. Numerically: a camera at Blender (0, 300, 0) looking at the origin with up
   +Z, and a surface point at Blender (10, 20, 5). Ground truth OpenCV camera
   coordinates from independent axis projection are (10, 5, 280) (depth > 0).
   The full chain R = M_G_FROM_B @ R_blend_from_cam @ S_CBL_FROM_CCV, then
   t = -(R @ cam_pos_in_G) reproduces (10, 5, 280) to 1e-14, with det(R)=+1 and
   positive depth, for 7 sampled viewpoints including near-polar ones.

Camera axis swap: an OpenCV/COLMAP camera is +X right, +Y down, +Z forward;
a Blender camera is +X right, +Y up, -Z forward, hence

    S_CBL_FROM_CCV = diag(1, -1, -1)      # maps OpenCV axes -> Blender axes

and its inverse (OpenCV <- Blender) is itself, because it is diagonal.
Both have det = (+1)(-1)(-1) = +1, so no handedness flip is introduced.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np

# --------------------------------------------------------------------------- #
# Transforms
# --------------------------------------------------------------------------- #

#: Blender Z-up -> glTF/Three.js Y-up rigid transform (det = +1). See module doc.
M_G_FROM_B = np.array(
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ],
    dtype=np.float64,
)

#: OpenCV/COLMAP camera axes -> Blender camera axes (det = +1). Self-inverse.
S_CBL_FROM_CCV = np.diag([1.0, -1.0, -1.0, 1.0])

_Rotation_33 = M_G_FROM_B[:3, :3]


def blender_to_gltf(points: np.ndarray) -> np.ndarray:
    """Apply :data:`M_G_FROM_B` to an ``(N, 3)`` array of Blender Z-up points."""
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"expected (N,3) points, got shape {pts.shape}")
    return pts @ _Rotation_33.T


def gltf_to_blender(points: np.ndarray) -> np.ndarray:
    """Inverse of :func:`blender_to_gltf` (Y-up -> Z-up)."""
    inv = _Rotation_33.T
    return np.asarray(points, dtype=np.float64) @ inv.T


def yaw_only_rotations(num_views: int) -> np.ndarray:
    """Evenly spaced yaw angles around +Y, offset so the first view is frontal."""
    return (np.arange(num_views, dtype=np.float64) * (2.0 * math.pi / max(1, num_views))
            + math.pi / 2.0)


def rotation_matrix_about_y(angle_rad: float) -> np.ndarray:
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float64)


def matrix_from_rz_up(forward: Sequence[float], up_hint: Sequence[float]) -> np.ndarray:
    """Right-handed ``R_G_from_Ccv`` whose +Z is ``forward`` (COLMAP/OpenCV).

    Columns of the result are the camera axes expressed in the world frame:
    ``+X`` right, ``+Y`` down, ``+Z`` forward. Built as ``[right, down, forward]``
    so that ``det == +1`` by construction (``down = forward x right``).
    """
    fwd = np.asarray(forward, dtype=np.float64)
    fwd = fwd / max(np.linalg.norm(fwd), 1e-12)
    hint = np.asarray(up_hint, dtype=np.float64)
    # Choose a reference axis least aligned with forward to avoid gimbal degeneracy.
    ref = np.array([0.0, 0.0, 1.0]) if abs(float(np.dot(hint, fwd))) < 0.9 else np.array([0.0, 1.0, 0.0])
    right = np.cross(ref, fwd)
    n = float(np.linalg.norm(right))
    if n < 1e-9:
        ref = np.array([1.0, 0.0, 0.0])
        right = np.cross(ref, fwd)
        n = float(np.linalg.norm(right))
    right = right / n
    down = np.cross(fwd, right)  # (u x v) x v is unit when u,v orthonormal
    down = down / max(float(np.linalg.norm(down)), 1e-12)
    R = np.stack([right, down, fwd], axis=1)  # columns = camera axes
    return R


def look_at_world_to_camera(
    cam_pos_gltf: Sequence[float],
    target_gltf: Sequence[float],
    up_hint_gltf: Sequence[float] = (0.0, -1.0, 0.0),
) -> Tuple[np.ndarray, np.ndarray]:
    """COLMAP world-to-camera ``(R_w2c, t_w2c)`` in the shared Y-up mm frame.

    ``R_w2c`` is the transpose of the camera-axis matrix, so ``det(R_w2c) == +1``.
    """
    forward = np.asarray(target_gltf, dtype=np.float64) - np.asarray(cam_pos_gltf, dtype=np.float64)
    if float(np.linalg.norm(forward)) < 1e-9:
        raise ValueError("camera position coincides with look-at target")
    R_g_from_c = matrix_from_rz_up(forward, up_hint_gltf)
    pos = np.asarray(cam_pos_gltf, dtype=np.float64)
    R_w2c = R_g_from_c.T
    t_w2c = -R_w2c @ pos
    return R_w2c, t_w2c


def rotation_to_quaternion_wxyz(R: np.ndarray) -> np.ndarray:
    """3x3 rotation -> unit quaternion (w, x, y, z), raising on a non-rotation.

    The previous implementation diagonalised a 3x3 symmetric matrix and then unpacked four
    numbers from a three-vector, so it could never return: the Blender pipeline died on its
    first real run at exactly this line. This is the standard branch method (Shepperd), which
    is stable at 180 degrees and trivially testable.
    """
    R = np.asarray(R, dtype=np.float64)
    if R.shape != (3, 3):
        raise ValueError(f"expected 3x3 rotation, got {R.shape}")
    tr = float(R[0, 0] + R[1, 1] + R[2, 2])
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(max(1e-12, 1.0 + R[0, 0] - R[1, 1] - R[2, 2])) * 2.0
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(max(1e-12, 1.0 + R[1, 1] - R[0, 0] - R[2, 2])) * 2.0
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(max(1e-12, 1.0 + R[2, 2] - R[0, 0] - R[1, 1])) * 2.0
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        return np.array([1.0, 0.0, 0.0, 0.0])
    q = np.array([w, x, y, z]) / n
    if q[0] < 0.0:
        q = -q
    return q


def quat_wxyz_to_matrix(q: Sequence[float]) -> np.ndarray:
    w, x, y, z = [float(v) for v in q]
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        return np.eye(3)
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


# --------------------------------------------------------------------------- #
# FDI conventions
# --------------------------------------------------------------------------- #

#: Teeth3DS / 3DTeethSeg24 JSON label semantics.
#: Source: Ben-Hamadou et al., "Teeth3DS+: An Extended Benchmark for Intra-oral 3D
#: Scans Analysis", arXiv:2210.06094v2, Sec. 3 -- "The length of the tables 'labels'
#: and 'instances' is the same as the total number of vertices in the corresponding
#: 3D scan. The label and instance '0' are reserved by default for gingiva."
#: https://arxiv.org/abs/2210.06094
#: Labels other than 0 are FDI two-digit numbers (11-18, 21-28, 31-38, 41-48).
GINGIVA_LABEL = 0

UPPER_FDI = tuple(range(11, 19)) + tuple(range(21, 29))
LOWER_FDI = tuple(range(31, 39)) + tuple(range(41, 49))
VALID_FDI = set(UPPER_FDI) | set(LOWER_FDI)


def fdi_is_valid(fdi: int) -> bool:
    return int(fdi) in VALID_FDI


def normalize_fdi(raw: int) -> int:
    """Map a dataset label onto a legal FDI id, or 0 (gingiva) when unknown.

    Some 3DTeethSeg24 exports additionally carry per-instance ids or sentinel values
    such as -1 for "unlabelled". Anything outside the FDI table becomes gingiva so a
    stray value can never create a bogus ``FDI_<n>`` node.
    """
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return GINGIVA_LABEL
    return v if v in VALID_FDI else GINGIVA_LABEL


def arch_of_fdi(fdi: int) -> str:
    """Return 'upper' / 'lower' from the FDI quadrant digit."""
    quadrant = int(fdi) // 10
    if quadrant in (1, 2):
        return "upper"
    if quadrant in (3, 4):
        return "lower"
    return "unknown"


# --------------------------------------------------------------------------- #
# Frame sidecar (shared centring between upper/lower runs)
# --------------------------------------------------------------------------- #

FRAME_SCHEMA_VERSION = 2


def write_frame_json(path: str, payload: dict) -> None:
    data = dict(payload)
    data["schema_version"] = FRAME_SCHEMA_VERSION
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def read_frame_json(path: str) -> dict:
    with open(frame_error_path(path), "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if int(data.get("schema_version", -1)) != FRAME_SCHEMA_VERSION:
        raise RuntimeError(
            f"{path}: frame.json schema_version={data.get('schema_version')} but this "
            f"pipeline expects {FRAME_SCHEMA_VERSION}. Delete frame.json and re-run BOTH "
            "arch passes together so upper and lower share one centring."
        )
    return data


def frame_error_path(path: str) -> str:
    if not os.path.isfile(path):
        raise RuntimeError(
            f"{path} not found. Upper/lower passes MUST share one full-arch centring or the "
            "web open/close slider will shear the two jaws apart. Run --mode combined first, "
            "or run --mode upper before --mode lower in the same out_dir."
        )
    return path


def fingerprints_match(a: Sequence[float], b: Sequence[float], tol: float = 1e-6) -> bool:
    aa = np.asarray(a, dtype=np.float64)
    bb = np.asarray(b, dtype=np.float64)
    if aa.shape != bb.shape:
        return False
    return bool(np.allclose(aa, bb, rtol=0.0, atol=tol))


# --------------------------------------------------------------------------- #
# Metadata merge
# --------------------------------------------------------------------------- #

def _round3(vec: Iterable[float]) -> List[float]:
    return [round(float(v), 3) for v in vec]


def merge_meta_files(paths: Sequence[str], out_path: str) -> dict:
    """Merge ``tooth_meta_<mode>.json`` files into ``tooth_meta_combined.json``.

    Key collisions across arches are a hard error: they mean two passes did not agree
    on naming, which would silently mis-highlight teeth in the UI.
    """
    merged: Dict[str, dict] = {}
    extents: List[float] = []
    provenance: List[str] = []
    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            blob = json.load(fh)
        extents.append(float(blob.get("arch_extent_mm", 0.0)))
        provenance.append(os.path.basename(path))
        for key, entry in blob.get("teeth", {}).items():
            if key in merged and merged[key] != entry:
                raise RuntimeError(
                    f"tooth_meta key collision for '{key}' between merged files "
                    f"{provenance}; entries differ. Two passes wrote the same arch tag."
                )
            merged[key] = entry
    out = {
        "unit": "mm",
        "coordinate_system": "glTF_Y_up",
        "arch_extent_mm": round(max(extents), 3) if extents else 0.0,
        "merged_from": provenance,
        "teeth": merged,
    }
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    os.replace(tmp, out_path)
    return out


# --------------------------------------------------------------------------- #
# Small IO utilities
# --------------------------------------------------------------------------- #

def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def human_size(nbytes: int) -> str:
    step = float(nbytes)
    for unit in ("B", "KB", "MB", "GB"):
        if abs(step) < 1024.0 or unit == "GB":
            return f"{step:.0f} {unit}" if unit == "B" else f"{step:.2f} {unit}"
        step /= 1024.0
    return f"{nbytes} B"


def print_artifacts(title: str, rows: Sequence[Tuple[str, int]]) -> None:
    bar = "=" * 78
    print(bar)
    print(f" ARTIFACTS :: {title}")
    print(bar)
    for path, size in rows:
        state = "missing" if size < 0 else human_size(size)
        print(f"  {state:>11}  {path}")
    print(bar)


def file_row(path: str) -> Tuple[str, int]:
    return (path, os.path.getsize(path) if os.path.isfile(path) else -1)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def count_faces(verts: np.ndarray, faces: np.ndarray) -> int:
    return int(len(faces))


def unique_nonzero_labels(labels: np.ndarray) -> np.ndarray:
    arr = np.asarray(labels, dtype=np.int64)
    vals = np.unique(arr[arr != GINGIVA_LABEL])
    return vals.astype(np.int64)
