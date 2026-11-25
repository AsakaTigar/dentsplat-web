"""toothfairy2_to_layers.py -- convert a ToothFairy2 / ToothFairy3 CBCT segmentation NIfTI
into anatomically aligned semantic layers plus the web-facing asset contract, WITHOUT training.

Outputs (under --out_dir, default <case>/web_assets):
    cbct_layers.ply            plain point cloud: x,y,z,red,green,blue,alpha,fdi,layer
    tooth_meta_cbct.json       same schema as the mesh route, plus "layer" per entry
    fdi_labels.bin / layer_labels.bin   row-aligned with cbct_layers.ply
    labels_manifest.json       N, sha256, cardinality -- so the .dspk converter can VERIFY
                               alignment instead of trusting it
    colmap_dataset/...         optional (--emit_colmap) synthetic camera rig + points3D,
                               so the same case can also be fed to 3DGS training

=============================== LABEL IDS ===============================
The default --schema tf3 table was read verbatim out of the official dataset viewer's label
JSON at https://ditto.ing.unimore.it/toothfairy3/ (77 classes, 532 volumes, ODIN2025 at
MICCAI2025; dataset paper Lumetti et al., "ToothFairy3: Scaling CBCT Maxillofacial
Segmentation to 77 Classes with U-Mamba2", MICCAI 2026). --schema tf2 is the older
44-class subset, verified against
https://github.com/AImageLab-zip/ToothFairy2-Benchmark/blob/main/dataset.json and
cross-checked with https://ditto.ing.unimore.it/toothfairy2/. Both agree on 1-10 and 11-48:

    0  background
    1  Lower Jawbone                     -> layer 'alveolar'
    2  Upper Jawbone                     -> layer 'alveolar'
    3  Left Inferior Alveolar Canal      -> layer 'nerve'
    4  Right Inferior Alveolar Canal     -> layer 'nerve'
    5  Left Maxillary Sinus              -> layer 'sinus'   (tf3)
    6  Right Maxillary Sinus             -> layer 'sinus'   (tf3)
    7  Pharynx                           -> layer 'other'   (tf3, off by default)
    8  Bridge                            -> layer 'restoration' (tf3; folded into 'teeth'
    9  Crown                                  with fdi 0 under tf2)
   10  Implant                               -- there is no honest nearest-tooth rule to give
                                               them a real FDI, so they stay unlabeled
  11-18, 21-28, 31-38, 41-48  FDI teeth, ONE label per tooth covering crown AND root
                                          -> layer 'teeth', misc byte = the FDI id
  103 / 104  Left / Right Mandibular Incisive Canal   -> 'nerve'   (tf3 only)
  105        Lingual Canal                            -> 'nerve'   (tf3 only)
  111-118, 121-128, 131-138, 141-148  pulp cavities / root canals of the 32 teeth
                                          -> layer 'pulp', misc byte = id - 100 = FDI
  19, 20, 29, 30, 39, 40  declared "NA" placeholders in dataset.json; never used

10 + 32 + 3 + 32 = 77. The pulp ids being FDI+100 is the whole trick behind the click-to-
highlight-a-root-canal interaction: no extra side-car is needed, the tooth's misc byte and its
canal's misc byte are the same number.

Important caveat, stated rather than hidden: neither release splits enamel from dentine, so
the 'teeth' layer is coronal+radicular anatomy. A true crown/root split needs a density
threshold inside each tooth mask (or Teeth3DS+ IOS meshes, which do carry per-vertex FDI).
The default --layers set gives the four transparency sliders of the CBCT case:

    alveolar = jawbone (1,2)          teeth = FDI (11..48)
    nerve    = IAN + incisive + lingual canals (3,4,103,104,105)
    pulp     = root canals (111..148) restoration = bridge/crown/implant (8,9,10)
    sinus    = maxillary sinus (5,6)

Override everything with --label_map if you are working from a different release.

=============================== COORDINATES ===============================
Voxel centres are mapped through the NIfTI affine (ras2aff) into RAS+ millimetres, then into the
project frame with the rule in RAS_TO_GLTF: (x, y, z)_RAS -> (-x, z, y), i.e. maxilla +Y, lips +Z,
patient's right at -X -- the same frame the shipped Scene A packet is measured to be in, and a
rotation (det +1) rather than a reflection. Centring is on the union bbox of the emitted masks so the
arch sits at the origin like every other artefact in the case. A cached frame.json sidecar keeps
repeated runs byte-consistent.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter
from typing import Dict, List, Sequence, Tuple

import numpy as np

try:
    import nibabel as nib
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(f"FATAL: nibabel is required ({exc}). pip install -r pipeline/requirements.txt\n")
    raise SystemExit(2)

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from dental_lib import VALID_FDI, file_row, human_size, print_artifacts, sha256_file  # noqa: E402

# --- verified defaults ------------------------------------------------------ #
# The ids common to both releases. ToothFairy3 keeps these and adds the canal/pulp ids below.
DEFAULT_LABELS: Dict[int, str] = {
    1: "alveolar", 2: "alveolar",
    3: "nerve", 4: "nerve",
    8: "teeth", 9: "teeth", 10: "teeth",
}

# --- layer codes written into layer_labels.bin / the DSPK container ---------------------------
# Byte-identical to LAYER in src/engine/dspk.ts. If you add one here, add it there in the same
# commit; the web viewer indexes uLayerAlpha by these numbers, so a drift silently recolours
# anatomy instead of failing loudly.
LAYER_CODES = {"gingiva": 0, "enamel": 1, "root": 2, "alveolar": 3, "nerve": 4, "other": 5,
               "pulp": 6, "sinus": 7, "restoration": 8}
# The CBCT tooth band (crown + root in one label) has no code of its own in the byte layout, so
# it borrows the enamel slot -- which is exactly the slot the viewer's '牙体 · 牙根' slider
# listens on (see CBCT_LAYERS in src/data/cases.ts). Without this alias emit("teeth") dies with
# a KeyError, which is why it is written out explicitly rather than left to a fallback.
EMIT_CODES = {**LAYER_CODES, "teeth": LAYER_CODES["enamel"]}
CBCT_CODE_NAMES = {v: k for k, v in EMIT_CODES.items()}
LABEL_NAMES = {v: k for k, v in LAYER_CODES.items()}
# Layers this script can actually build a mask for. 'other' (pharynx 7) and the IOS-side codes
# gingiva/enamel/root have no CBCT mask here, so asking for them would silently emit nothing.
EMITTABLE_LAYERS = ("alveolar", "teeth", "nerve", "pulp", "restoration", "sinus")

# --- ToothFairy3 label ids, read off the dataset viewer's own label table --------------------
# Source: https://ditto.ing.unimore.it/toothfairy3/ (the "labels" JSON embedded in the volume
# viewer), 77 classes = 10 structures + 32 teeth + 3 canals + 32 pulps. Pulp ids are FDI+100.
TF3_EXTRA_LABELS: Dict[int, str] = {
    103: "nerve",        # Left Mandibular Incisive Canal
    104: "nerve",        # Right Mandibular Incisive Canal
    105: "nerve",        # Lingual Canal
    5: "sinus", 6: "sinus",
    7: "other",          # Pharynx
    8: "restoration", 9: "restoration", 10: "restoration",   # Bridge / Crown / Implant
}
# The 32 pulp ids, i.e. every valid FDI + 100: 111-118, 121-128, 131-138, 141-148.
# Derive them from VALID_FDI rather than from a quadrant arithmetic loop -- an earlier version
# wrote `q * 100 + 11..18`, which produces 211-218/311-318/411-418, ids that do not exist in the
# dataset. That silently empties the root-canal layer, i.e. it deletes the money shot instead of
# failing. sorted() because VALID_FDI is a set and this list feeds a manifest cardinality.
TF3_PULP_IDS = sorted(fdi + 100 for fdi in VALID_FDI)
TF3_PULP_LABELS: Dict[int, str] = {i: "pulp" for i in TF3_PULP_IDS}
assert len(TF3_PULP_IDS) == 32 and TF3_PULP_IDS[0] == 111 and TF3_PULP_IDS[-1] == 148, \
    f"tf3 pulp ids look wrong: {TF3_PULP_IDS}"

# HU windows chosen per tissue so the point cloud reads correctly on a dark UI.
DEFAULT_HU_WINDOW = {
    "alveolar": (150.0, 1850.0),
    "teeth": (1200.0, 3400.0),
    "nerve": (-450.0, 60.0),
    "pulp": (-450.0, 250.0),           # the canal space is soft-tissue density inside the tooth
    "sinus": (-1000.0, -400.0),        # air
    "restoration": (1800.0, 3400.0),   # metal / ceramic are the brightest things in the stack
}
# Tints are the LAYER_RGB values from src/engine/dspk.ts divided by 255, so a splat that reaches
# the viewer keeps reading as the same tissue whether it was coloured by HU window or by the
# default layer palette. Keep them in sync in the same commit as the codes.
DEFAULT_TINT = {
    "alveolar": (0.808, 0.769, 0.690),   # #cec4b0
    "teeth": (0.933, 0.910, 0.847),      # #eee8d8 (shared with the enamel slot)
    "nerve": (0.980, 0.800, 0.235),      # #facc3c fluorescent yellow: the IAN decision layer
    "pulp": (0.886, 0.337, 0.376),       # #e2565f warm red
    "sinus": (0.471, 0.627, 0.824),      # #78a0d2
    "restoration": (0.729, 0.769, 0.808),  # #bac4ce
}


def parse_label_map(spec: str) -> Dict[int, str]:
    """'1-2=alveolar,3-4=nerve,11-48=teeth' -> {1:'alveolar',...}."""
    out: Dict[int, str] = {}
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" not in chunk:
            raise ValueError(f"--label_map entry '{chunk}' must look like RANGE=LAYER")
        keys, layer = chunk.split("=", 1)
        layer = layer.strip().lower()
        if layer not in EMIT_CODES:
            raise ValueError(f"unknown layer '{layer}'; choose from {sorted(EMIT_CODES)}")
        for key in keys.split("+"):
            key = key.strip()
            if "-" in key:
                lo, hi = (int(x) for x in key.split("-", 1))
                out.update({i: layer for i in range(lo, hi + 1)})
            else:
                out[int(key)] = layer
    return out


def build_label_table(args) -> Dict[int, str]:
    base = dict(DEFAULT_LABELS)
    if getattr(args, "schema", "tf3") == "tf3":
        # tf3 re-labels 8/9/10 as their own layer and adds the intraosseous canals + pulps
        base.update(TF3_EXTRA_LABELS)
        base.update(TF3_PULP_LABELS)
    for fdi in sorted(VALID_FDI):
        base[fdi] = "teeth"
    if args.label_map:
        override = parse_label_map(args.label_map)
        base.update(override)
        print(f"[LABELS] user override applied to {len(override)} ids")
    return base


def pulp_fdi_of(label_id: int) -> int:
    """ToothFairy3 encodes the pulp of FDI n as n+100 (111-118, 121-128, 131-138, 141-148).

    Membership-tested against VALID_FDI rather than range-checked: 111..148 also contains the
    ids dataset.json declares "NA" (119, 120, 129, 130, 139, 140), and those must not be given
    a tooth label they never had.
    """
    fdi = label_id - 100
    return fdi if fdi in VALID_FDI else 0


def load_volume(path: str) -> Tuple[np.ndarray, np.ndarray, List[float]]:
    img = nib.load(path)
    data = np.asarray(img.dataobj)
    if data.ndim == 4:
        print(f"[INFO] 4D volume {data.shape}; taking channel 0")
        data = data[..., 0]
    aff = np.asarray(img.affine, dtype=np.float64)
    zooms = [float(z) for z in img.header.get_zooms()[:3]]
    return data.astype(np.int16, copy=False), aff, zooms


# RAS+ -> the project frame. Rows are the new axes expressed in the RAS basis, so this matrix is
# applied as p @ RAS_TO_GLTF.T.
#
# RAS+ means +x -> the patient's RIGHT, +y -> anterior, +z -> superior (the name is the axis order).
# The web frame every artefact in a case must share (NOTES.md §3, and measured off the shipped
# sceneA_full.dspk: FDI_11 at x=-6.79, FDI_21 at x=+6.02, upper teeth at y=+5.4, incisors at z=+34)
# is: +X = patient's left, +Y = superior (maxilla above the occlusal plane), +Z = anterior (lips
# toward the camera). That makes the screen a right-handed frame viewed from in front, and gives:
#
#     X = -x_RAS      (RAS +x is the patient's right; the viewer's right is the patient's left)
#     Y = +z_RAS      (superior up -- NOT -z, which is what an earlier revision of this file did,
#                      silently turning the skull upside down and moving the maxilla to -Y)
#     Z = +y_RAS      (anterior toward the camera)
#
# det = +1, so this is a rotation: no mirroring, no chirality drift between Scene A and Scene B.
RAS_TO_GLTF = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])


def ras_to_gltf(points: np.ndarray) -> np.ndarray:
    """RAS+ mm -> the project's Y-up millimetre frame: (x, y, z)_RAS -> (-x, z, y)."""
    p = np.atleast_2d(np.asarray(points, dtype=np.float64))
    return p @ RAS_TO_GLTF.T


def voxel_to_ras(vox: np.ndarray, aff: np.ndarray) -> np.ndarray:
    """Voxel indices (N,3) -> RAS+ mm (N,3).

    Two bugs lived here and both were only visible by running the file:

    * the call was spelled `nib.affines.apply_aff`, a name no nibabel release defines, so the route
      died with an AttributeError before sampling a single point;
    * it passed `coords.T`. nibabel's apply_affine computes `points @ A[:3,:3].T + A[:3,3]`, i.e. the
      3-vector must be on the LAST axis -- (N,3). Transposing gives (3,N), which raises a shape error
      for every real mask, so even the corrected name would not have run.

    `img.affine` already folds the header's s_pix scaling in, so no extra axis-code bookkeeping is
    needed here; the caller passes `img.affine` and gets millimetres.
    """
    vox = np.atleast_2d(np.asarray(vox, dtype=np.float64))
    if vox.shape[1] != 3:
        raise ValueError(f"voxel_to_ras expects (N,3), got {vox.shape}")
    return np.atleast_2d(nib.affines.apply_affine(np.asarray(aff, dtype=np.float64), vox))


def sample_mask_coords(mask: np.ndarray, aff: np.ndarray, spacing_mm: float,
                      rng: np.random.Generator, max_points: int,
                      surface_only: bool):
    """The voxel-cohort half of sample_mask_points.

    Returned separately from the physical coordinates on purpose: emit() needs the *voxel
    indices* too, so it can read the FDI / pulp label of exactly the points it draws.
    Sampling a mask twice instead would consume the generator twice and silently pair each
    splat with another splat's label -- the alignment hazard DSPK exists to avoid.
    """
    coords = np.argwhere(mask)
    if len(coords) == 0:
        return np.zeros((0, 3), dtype=np.int64), 0
    n_before = len(coords)
    if surface_only:
        coords = _boundary_voxels(mask, coords)
        if len(coords) == 0:
            coords = np.argwhere(mask)
    ras = voxel_to_ras(coords, aff)
    step = max(float(spacing_mm), 1e-3)
    keys = np.floor(ras / step).astype(np.int64)
    keys -= keys.min(axis=0)
    dims = keys.max(axis=0) + 1
    flat = (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]
    _, first = np.unique(flat, return_index=True)
    picked = coords[first]
    if max_points > 0 and len(picked) > max_points:
        sel = rng.choice(len(picked), size=max_points, replace=False)
        picked = picked[np.sort(sel)]
    return picked, n_before


def sample_mask_points(mask: np.ndarray, aff: np.ndarray, spacing_mm: float,
                      rng: np.random.Generator, max_points: int,
                      surface_only: bool):
    """Pick voxel centres from a binary mask, thinned to roughly `spacing_mm`.

    Uses a coarse lattice over the physical space so density is isotropic in mm rather
    than tied to anisotropic voxel size, then keeps the occupied cells. When
    --surface_only is set we restrict to mask boundary voxels, which is what makes the
    alveolar shell readable instead of an opaque blob.
    """
    picked, n_before = sample_mask_coords(mask, aff, spacing_mm, rng, max_points, surface_only)
    if len(picked) == 0:
        return np.zeros((0, 3), dtype=np.float64), n_before
    return voxel_to_ras(picked, aff), n_before


def _boundary_voxels(mask: np.ndarray, coords: np.ndarray) -> np.ndarray:
    """Voxels with at least one empty 6-neighbour (cheap morphological surface)."""
    m = mask.astype(bool)
    shape = m.shape
    c = coords
    nb = np.zeros(len(c), dtype=bool)
    for axis in range(3):
        for delta in (-1, 1):
            idx = c.copy()
            idx[:, axis] += delta
            inside = (idx[:, 0] >= 0) & (idx[:, 0] < shape[0]) & \
                     (idx[:, 1] >= 0) & (idx[:, 1] < shape[1]) & \
                     (idx[:, 2] >= 0) & (idx[:, 2] < shape[2])
            empty = np.ones(len(c), dtype=bool)
            if inside.any():
                sub = idx[inside]
                empty[inside] = ~m[sub[:, 0], sub[:, 1], sub[:, 2]]
            nb |= empty
    out = c[nb]
    return out if len(out) else c


def hu_colour(hu: np.ndarray, window: Tuple[float, float], tint: Tuple[float, float, float]):
    """Linear HU window -> normalised intensity -> tinted RGB in 0..255."""
    lo, hi = window
    span = max(hi - lo, 1e-6)
    t = np.clip((hu.astype(np.float64) - lo) / span, 0.0, 1.0)
    gain = 0.35 + 0.65 * t
    rgb = (np.clip(tint[0] * gain, 0, 1) * 255,
           np.clip(tint[1] * gain, 0, 1) * 255,
           np.clip(tint[2] * gain, 0, 1) * 255)
    return np.stack([rgb[0], rgb[1], rgb[2]], axis=1).astype(np.uint8), t


def write_ply(path: str, xyz: np.ndarray, rgba: np.ndarray, fdi: np.ndarray, layer: np.ndarray) -> None:
    """Binary little-endian PLY with x,y,z,float32 + red,green,blue,alpha,uint8 + fdi,layer,uint8."""
    n = len(xyz)
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment DentSplat CBCT layered point cloud (units: mm, frame: glTF Y-up)\n"
        "element vertex %d\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n"
        "property uchar fdi\nproperty uchar layer\n"
        "end_header\n" % n
    )
    rec = np.zeros(n, dtype=np.dtype([
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("red", "u1"), ("green", "u1"), ("blue", "u1"), ("alpha", "u1"),
        ("fdi", "u1"), ("layer", "u1"),
    ]))
    rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rec["red"], rec["green"], rec["blue"], rec["alpha"] = rgba[:, 0], rgba[:, 1], rgba[:, 2], rgba[:, 3]
    rec["fdi"], rec["layer"] = fdi, layer
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(rec.tobytes(order="C"))
    os.replace(tmp, path)


def main(argv=None) -> int:
    # Scanned before argparse because --labels_nii/--case_dir are in a required mutually exclusive
    # group, and a self-test must not have to invent an input file to run.
    if "--selftest" in (argv if argv is not None else sys.argv[1:]):
        return _self_test()
    p = argparse.ArgumentParser(
        description="ToothFairy2/3 CBCT segmentation -> aligned anatomical layers (.ply).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--labels_nii", type=str, help="Segmentation NIfTI/MHA (caseID.nii.gz)")
    src.add_argument("--case_dir", type=str, help="nnU-Net style folder; auto-finds *_0000 image + label")
    p.add_argument("--image_nii", type=str, default=None,
                   help="Intensity volume for HU colouring. Required unless --flat_colour.")
    p.add_argument("--out_dir", type=str, default=None, help="Default: <case>/web_assets next to the input")
    p.add_argument("--case_name", type=str, default=None)
    p.add_argument("--layers", type=str, default="alveolar,teeth,nerve,pulp,restoration,sinus",
                   help="Comma list of layers to emit; subset of "
                        "alveolar|teeth|nerve|pulp|restoration|sinus")
    p.add_argument("--schema", type=str, default="tf3", choices=["tf2", "tf3"],
                   help="Label-id schema. tf3 = the 77-class release (adds pulps 111-148, incisive "
                        "103/104 and lingual 105 canals, and gives crowns/bridges/implants their own "
                        "layer); tf2 = the older release, where 8/9/10 have no layer of their own and "
                        "ride along inside --teeth with fdi 0")
    p.add_argument("--spacing_mm", type=float, default=1.2, help="Point lattice pitch in mm")
    p.add_argument("--max_points_per_layer", type=int, default=120000)
    p.add_argument("--surface_only", type=int, default=1, choices=[0, 1],
                   help="1 (default): keep only mask-boundary voxels so layers stay see-through")
    p.add_argument("--arch", type=str, default="auto", choices=["auto", "upper", "lower", "both"],
                   help="Restrict to one jaw. 'auto' infers from the dominant jawbone label and "
                        "keeps matching FDI quadrants.")
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--label_map", type=str, default="",
                   help="Override the verified defaults, e.g. '1-2=alveolar,3-4=nerve,11-48=teeth'")
    p.add_argument("--flat_colour", action="store_true",
                   help="Skip HU windowing and use fixed tints (no --image_nii needed)")
    p.add_argument("--emit_colmap", action="store_true",
                   help="Also write a colmap_dataset/ so this case can be trained on")
    p.add_argument("--num_views", type=int, default=60, help="Synthetic views for --emit_colmap")
    p.add_argument("--res", type=int, default=1024)
    p.add_argument("--selftest", action="store_true",
                   help="run the affine/Y-up/label-byte self-checks and exit 0 (needs no input files)")
    p.add_argument("--overwrite", action="store_true")
    args = p.parse_args(argv)

    rng = np.random.default_rng(args.seed)
    wanted = [s.strip().lower() for s in args.layers.split(",") if s.strip()]
    unknown = [w for w in wanted if w not in EMITTABLE_LAYERS]
    if unknown:
        p.error(f"--layers contains unknown entries {unknown}; "
                f"emittable: {','.join(EMITTABLE_LAYERS)} "
                f"(code-only layers with no mask of their own: other)")
    if not args.flat_colour and not args.image_nii and not args.case_dir:
        p.error("need --image_nii for HU colouring, or pass --flat_colour")

    label_table = build_label_table(args)

    # ---------------- resolve inputs ----------------
    if args.case_dir:
        lab, img_path, case_name = _discover_case(args.case_dir)
        labels_path = lab
        image_path = args.image_nii or img_path
    else:
        labels_path = args.labels_nii
        image_path = args.image_nii
        base = os.path.basename(labels_path)
        case_name = args.case_name or base.replace(".nii.gz", "").replace(".mha", "").replace(".nii", "")
    if args.case_name:
        case_name = args.case_name

    out_dir = args.out_dir or os.path.join(os.path.dirname(os.path.abspath(labels_path)), "..", "web_assets")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    out_ply = os.path.join(out_dir, "cbct_layers.ply")
    out_meta = os.path.join(out_dir, "tooth_meta_cbct.json")
    if os.path.isfile(out_ply) and not args.overwrite:
        print(f"[SKIP] {out_ply} exists (use --overwrite)")
        print_artifacts("toothfairy2_to_layers.py (cached)", [
            file_row(out_ply), file_row(os.path.join(out_dir, "fdi_labels.bin")),
            file_row(os.path.join(out_dir, "layer_labels.bin")),
            file_row(os.path.join(out_dir, "labels_manifest.json"))])
        return 0

    seg, aff, zooms = load_volume(labels_path)
    present = set(int(v) for v in np.unique(seg) if v != 0)
    unmapped = sorted(i for i in present if i not in label_table and i not in VALID_FDI)
    if unmapped:
        print(f"[WARN] label ids present but not mapped to any layer, skipped: {unmapped}")
    print(f"[VOL ] {os.path.basename(labels_path)} shape={seg.shape} zooms={zooms} "
          f"labels_present={len(present)}")

    if not args.flat_colour:
        if not image_path or not os.path.isfile(image_path):
            raise SystemExit(f"FATAL: intensity volume not found ({image_path}). Pass --image_nii or --flat_colour.")
        img_arr, img_aff, _ = load_volume(image_path)
        if img_arr.shape != seg.shape:
            raise SystemExit(f"FATAL: image {img_arr.shape} and label {seg.shape} grids differ; resample first.")
        if not np.allclose(img_aff, aff, atol=1e-3):
            print("[WARN] image and label affines differ by more than 1e-3 mm; using the LABEL affine for "
                  "positions and indexing intensities by voxel, which assumes identical grids.")
        hu = img_arr.astype(np.float32)
    else:
        hu = np.ones_like(seg, dtype=np.float32) * 1000.0

    # ---------------- per-layer sampling ----------------
    all_xyz, all_rgb, all_fdi, all_layer = [], [], [], []
    per_layer_stats: Dict[str, dict] = {}

    # Jaw restriction support: FDI quadrant filtering + jawbone label choice.
    upper_ids = set(range(11, 29))
    lower_ids = set(range(31, 49))
    arch = args.arch
    if arch == "auto":
        n_up = int((seg == 2).sum())
        n_lo = int((seg == 1).sum())
        arch = "both" if min(n_up, n_lo) > 0.35 * max(n_up, n_lo, 1) else ("upper" if n_up > n_lo else "lower")
        print(f"[ARCH ] auto-detected '{arch}' (upper jawbone {n_up:,} vs lower {n_lo:,} voxels)")

    def emit(layer: str, mask: np.ndarray, id_to_fdi: Dict[int, int] | None = None,
             keep_raw_fdi: bool = False):
        """Sample one layer and append it to the shared arrays.

        `id_to_fdi` is the semantic map: when present, every drawn voxel's own label is
        translated through it and written into the splat's misc byte. Because the label is
        read from the *same* `picked` cohort that becomes geometry, row i of the position
        plane and row i of the label plane are the same voxel by construction -- no join,
        no Morton reorder, nothing to desynchronise.
        """
        picked, n_before = sample_mask_coords(mask, aff, args.spacing_mm, rng,
                                              args.max_points_per_layer, bool(args.surface_only))
        if len(picked) == 0:
            per_layer_stats[layer] = {"voxels": int(mask.sum()), "points": 0}
            print(f"[LAYER] {layer:<10} mask empty -- skipped")
            return
        ras = voxel_to_ras(picked, aff)
        g = ras_to_gltf(ras)
        # Nearest-voxel HU lookup: recompute integer indices from the sampled positions.
        huv = _sample_hu_at(mask, ras, aff, hu)
        win = DEFAULT_HU_WINDOW[layer] if not args.flat_colour else (0.0, 1.0)
        rgb, _t = hu_colour(huv, win, DEFAULT_TINT[layer])
        alpha = np.full(len(rgb), 255, dtype=np.uint8)
        if id_to_fdi is not None:
            ids = seg[picked[:, 0], picked[:, 1], picked[:, 2]]
            fdi = np.array([int(id_to_fdi.get(int(v), 0)) for v in ids], dtype=np.uint8)
        elif keep_raw_fdi:
            ids = seg[picked[:, 0], picked[:, 1], picked[:, 2]]
            fdi = np.array([int(v) if int(v) in VALID_FDI else 0 for v in ids], dtype=np.uint8)
        else:
            fdi = np.zeros(len(rgb), dtype=np.uint8)
        code = EMIT_CODES[layer]
        all_xyz.append(g)
        all_rgb.append(np.concatenate([rgb, alpha[:, None]], axis=1))
        all_fdi.append(fdi.astype(np.uint8))
        all_layer.append(np.full(len(g), code, dtype=np.uint8))
        per_layer_stats[layer] = {"voxels": int(mask.sum()), "candidate_voxels": int(n_before),
                                  "points": int(len(g)), "hu_window": list(win),
                                  "fdi_labeled_points": int((fdi != 0).sum()),
                                  "fdi_ids": sorted(set(int(v) for v in fdi if v != 0))}
        print(f"[LAYER] {layer:<10} {int(mask.sum()):>10,} voxels -> {len(g):>8,} pts "
              f"(lattice {args.spacing_mm} mm)")

    # alveolar (jawbone 1/2): the shell that gives the arcade its context
    if "alveolar" in wanted:
        jaw_labels = {"upper": [2], "lower": [1], "both": [1, 2]}[arch]
        emit("alveolar", np.isin(seg, jaw_labels), {i: 0 for i in jaw_labels})

    # teeth: FDI ids, optionally restricted to the selected arch
    tooth_ids = [i for i in present if i in VALID_FDI]
    if arch == "upper":
        tooth_ids = [i for i in tooth_ids if i in upper_ids]
    elif arch == "lower":
        tooth_ids = [i for i in tooth_ids if i in lower_ids]
    # Under tf2 the restorations have no layer of their own, so they ride along with the teeth
    # band -- but with fdi 0. The old header claimed they were "merged into the nearest FDI tooth
    # band"; inventing that assignment here would be a guess, not a measurement, so the prosthetic
    # voxels stay unlabeled and the manifest says so.
    prosthetic_ids = [i for i in present if i in (8, 9, 10)]
    merge_prosthetic = args.schema == "tf2"
    if "teeth" in wanted:
        teeth_mask = np.isin(seg, tooth_ids + (prosthetic_ids if merge_prosthetic else []))
        emit("teeth", teeth_mask, {i: i for i in tooth_ids}, keep_raw_fdi=True)

    # nerve: IAN (3,4) plus, under tf3, the incisive (103,104) and lingual (105) canals
    nerve_ids = [3, 4] + ([103, 104, 105] if args.schema == "tf3" else [])
    if "nerve" in wanted:
        emit("nerve", np.isin(seg, nerve_ids), {i: 0 for i in nerve_ids})

    # pulp / root canal: tf3 only. FDI is carried as (id - 100) so clicking tooth 38 highlights
    # its canal and the IAN-relationship slider, which is the clinical money shot.
    if "pulp" in wanted:
        pulp_present = [i for i in present if i in TF3_PULP_LABELS]
        if pulp_present:
            emit("pulp", np.isin(seg, pulp_present), {i: pulp_fdi_of(i) for i in pulp_present})
        else:
            print("[LAYER] pulp       none of ids 111-148 present -- skipped")

    # restorations: tf3 keeps bridge/crown/implant as their own metallic layer
    if "restoration" in wanted:
        if merge_prosthetic:
            print("[LAYER] restoration 8/9/10 fold into --teeth under --schema tf2")
        elif not prosthetic_ids:
            print("[LAYER] restoration  no ids 8/9/10 present -- skipped")
        else:
            emit("restoration", np.isin(seg, prosthetic_ids), {i: 0 for i in prosthetic_ids})

    # maxillary sinus (5,6): air window, faint by default, doubles as a FOV sanity check
    if "sinus" in wanted:
        emit("sinus", np.isin(seg, [5, 6]), {5: 0, 6: 0})

    if not all_xyz:
        raise SystemExit("FATAL: nothing was sampled. Check --layers/--arch and that the label file "
                         "actually contains ids 1-4 or 11-48.")

    xyz = np.vstack(all_xyz).astype(np.float32)
    rgba = np.vstack(all_rgb)
    fdi = np.concatenate(all_fdi)
    layer = np.concatenate(all_layer)

    # ---- shared centring: cache so re-runs stay byte-consistent ----
    center = (xyz.max(axis=0).astype(np.float64) + xyz.min(axis=0).astype(np.float64)) / 2.0
    frame_path = os.path.join(os.path.dirname(out_dir), "frame_cbct.json")
    if os.path.isfile(frame_path) and not args.overwrite:
        try:
            prev = json.load(open(frame_path, encoding="utf-8"))
            pc = np.asarray(prev["center_yup_mm"], dtype=np.float64)
            if np.allclose(pc, center, atol=1e-2):
                center = pc
                print(f"[FRAME] reused cached centring from {frame_path}")
            else:
                print(f"[WARN] cached centring {pc.round(2).tolist()} differs from recomputed "
                      f"{center.round(2).tolist()} (different scan?) -- using the new value.")
        except Exception as exc:
            print(f"[WARN] could not read {frame_path}: {exc}")
    with open(frame_path, "w", encoding="utf-8") as fh:
        json.dump({"center_yup_mm": [round(float(v), 4) for v in center],
                   "case": case_name, "n_points": int(len(xyz)), "seed": int(args.seed)}, fh, indent=2)

    xyz = (xyz.astype(np.float64) - center).astype(np.float32)
    extent = float(np.linalg.norm(xyz.max(axis=0) - xyz.min(axis=0)))

    write_ply(out_ply, xyz, rgba, fdi, layer)

    # ---- metadata ----
    teeth_meta: Dict[str, dict] = {}
    code_to_name = dict(CBCT_CODE_NAMES)
    for code in sorted(set(int(c) for c in layer)):
        name = code_to_name.get(code, str(code))
        sel = layer == code
        pts = xyz[sel]
        teeth_meta[f"LAYER_{name.upper()}"] = {
            "fdi": 0, "arch": arch if arch != "both" else "upper",
            "layer": name, "layer_code": code, "centroid_mm": _r3(pts.mean(axis=0)),
            "bbox_min_mm": _r3(pts.min(axis=0)), "bbox_max_mm": _r3(pts.max(axis=0)),
            "n_vertices": int(sel.sum()),
        }
    for fdi_id in sorted(set(int(v) for v in fdi if v != 0)):
        sel = (fdi == fdi_id)
        pts = xyz[sel]
        codes = sorted(set(int(c) for c in layer[sel]))
        teeth_meta[f"FDI_{fdi_id}"] = {
            "fdi": fdi_id,
            "arch": "upper" if fdi_id // 10 in (1, 2) else "lower",
            "layer": "teeth",
            # A pulp-bearing id spans two layer codes (tooth body + canal), so the centroid and
            # bbox describe the whole tooth unit rather than the tooth-body mesh alone.
            "layer_codes": codes,
            "layers": [code_to_name.get(c, str(c)) for c in codes],
            "centroid_mm": _r3(pts.mean(axis=0)),
            "bbox_min_mm": _r3(pts.min(axis=0)),
            "bbox_max_mm": _r3(pts.max(axis=0)),
            "n_vertices": int(sel.sum()),
        }
    meta = {
        "unit": "mm", "coordinate_system": "glTF_Y_up",
        "arch_extent_mm": round(extent, 3), "case": case_name, "arch": arch,
        "source": os.path.basename(labels_path),
        "schema": args.schema,
        "label_map_used": {str(k): v for k, v in sorted(label_table.items()) if v in wanted},
        "per_layer": per_layer_stats,
        "note": ("ToothFairy2/3 merge crown+root per tooth, so 'teeth' is not enamel-only. "
                 "Points with fdi 0 are jawbone, canals, sinus or prosthetics -- prosthetics are "
                 "left unlabeled rather than guessed onto a neighbouring tooth."),
        "teeth": teeth_meta,
    }
    with open(out_meta, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    out_fdi = os.path.join(out_dir, "fdi_labels.bin")
    out_layer_bin = os.path.join(out_dir, "layer_labels.bin")
    np.ascontiguousarray(fdi, dtype=np.uint8).tofile(out_fdi)
    np.ascontiguousarray(layer, dtype=np.uint8).tofile(out_layer_bin)

    rows = _verify_ply_rows(out_ply, len(fdi))
    assert rows == len(fdi) == len(layer), f"ALIGNMENT FAILURE ply={rows} fdi={len(fdi)} layer={len(layer)}"
    manifest = {
        "schema_version": 1, "n_splats": int(rows), "ply": "cbct_layers.ply",
        "ply_sha256": sha256_file(out_ply), "ply_bytes": os.path.getsize(out_ply),
        "ply_attributes": ["x", "y", "z", "red", "green", "blue", "alpha", "fdi", "layer"],
        "kind": "point_cloud", "coordinate_system": "glTF_Y_up", "unit": "mm",
        "fdi_labels_bin": {"file": "fdi_labels.bin", "dtype": "uint8", "bytes": int(fdi.nbytes),
                           "row_order": "identical to cbct_layers.ply vertex rows"},
        "layer_labels_bin": {"file": "layer_labels.bin", "dtype": "uint8", "bytes": int(layer.nbytes),
                             "row_order": "identical to cbct_layers.ply vertex rows"},
        "fdi_cardinality": len(set(int(v) for v in fdi)),
        "fdi_counts": {str(k): int(c) for k, c in sorted(Counter(int(v) for v in fdi).items())},
        "layer_cardinality": len(set(int(v) for v in layer)),
        "layer_counts": {CBCT_CODE_NAMES.get(int(k), str(k)): int(c) for k, c in
                         sorted(Counter(int(v) for v in layer).items())},
        # What the bytes MEAN in this file: code 1 here is the CBCT tooth band (crown+root), which
        # shares the DSPK enamel slot. LAYER_CODES (the shared byte table) is written alongside so
        # a decoder can tell the two vocabularies apart instead of guessing.
        "layer_encoding": {str(k): v for k, v in LAYER_CODES.items()},
        "layer_encoding_cbct": {str(k): v for k, v in sorted(CBCT_CODE_NAMES.items())},
        "schema": args.schema,
        "per_layer": per_layer_stats,
        "spacing_mm": args.spacing_mm, "surface_only": bool(args.surface_only),
        "seed": args.seed, "arch": arch,
        "sources": {"labels": os.path.abspath(labels_path),
                    "image": os.path.abspath(image_path) if image_path and not args.flat_colour else None},
        "label_id_reference": (
            "https://ditto.ing.unimore.it/toothfairy3/" if args.schema == "tf3"
            else "https://github.com/AImageLab-zip/ToothFairy2-Benchmark/blob/main/dataset.json"),
    }
    out_manifest = os.path.join(out_dir, "labels_manifest.json")
    with open(out_manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    if args.emit_colmap:
        _emit_colmap_stub(out_dir, xyz, rgba, args, extent, rng)

    rows_written = [
        file_row(out_ply), file_row(out_meta), file_row(out_fdi),
        file_row(out_layer_bin), file_row(out_manifest), file_row(frame_path),
    ]
    if args.emit_colmap:
        for nm in ("cameras.txt", "images.txt", "points3D.txt"):
            rows_written.append(file_row(os.path.join(out_dir, "..", "colmap_dataset", "sparse", "0", nm)))
    print_artifacts(f"toothfairy2_to_layers.py  case={case_name}  arch={arch}", rows_written)
    print(f"[NEXT ] feed cbct_layers.ply straight to the converter, or train: "
          f"bash pipeline/train_gsplat.sh {os.path.dirname(out_dir)}")
    return 0


def _r3(vec) -> List[float]:
    return [round(float(v), 3) for v in vec]


def _discover_case(case_dir: str) -> Tuple[str, str, str]:
    root = os.path.abspath(case_dir)
    cands_lab = [f for f in os.listdir(root) if f.endswith(".nii.gz") and not f.endswith("_0000.nii.gz")]
    cands_img = [f for f in os.listdir(root) if f.endswith("_0000.nii.gz")]
    if not cands_lab:
        raise SystemExit(f"FATAL: no label .nii.gz found in {root}")
    lab = os.path.join(root, sorted(cands_lab)[0])
    img = os.path.join(root, sorted(cands_img)[0]) if cands_img else None
    name = os.path.basename(lab).replace(".nii.gz", "")
    return lab, img, name


def _sample_hu_at(mask: np.ndarray, ras: np.ndarray, aff: np.ndarray, hu: np.ndarray) -> np.ndarray:
    """Intensity at each sampled point, via inverse-affine rounding back to voxel index."""
    inv = np.linalg.inv(aff)
    # The homogeneous multiply leaves a 4th column (the w row) after transposing back to (N,4), and it
    # must be dropped before the clip: np.clip((N,4), 0, (3,)) is a broadcast error, not a silent
    # wrong answer, which is the only reason this was caught -- the shape mismatch aborts loudly.
    vox = np.round(inv @ np.hstack([ras, np.ones((len(ras), 1))]).T).astype(np.int64).T[:, :3]
    dim = np.array(hu.shape)
    vox = np.clip(vox, 0, dim - 1)
    return hu[vox[:, 0], vox[:, 1], vox[:, 2]]


def _emit_colmap_stub(out_dir: str, xyz: np.ndarray, rgba: np.ndarray, args, extent: float, rng) -> None:
    """Synthetic COLMAP rig around the CBCT cloud so the case is trainable."""
    case_root = os.path.abspath(os.path.join(out_dir, ".."))
    sparse = os.path.join(case_root, "colmap_dataset", "sparse", "0")
    imgs = os.path.join(case_root, "colmap_dataset", "images")
    os.makedirs(sparse, exist_ok=True)
    os.makedirs(imgs, exist_ok=True)
    fx = fy = (50.0 / 36.0) * args.res
    cx = cy = args.res / 2.0
    with open(os.path.join(sparse, "cameras.txt"), "w", encoding="utf-8") as fh:
        fh.write("# Camera list with one line of data per camera:\n")
        fh.write("#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n")
        fh.write(f"1 PINHOLE {args.res} {args.res} {fx:.6f} {fy:.6f} {cx:.6f} {cy:.6f}\n")
    radius = max(extent * 1.45, 60.0)
    lines = ["# Image list with two lines of data per image:\n",
             "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n",
             "#   POINTS2D[] as (X, Y, POINT3D_ID)\n",
             f"# Number of images: {args.num_views}\n"]
    from dental_lib import look_at_world_to_camera, rotation_to_quaternion_wxyz
    for i in range(args.num_views):
        az = 2 * math.pi * i / args.num_views
        el = math.radians(-40.0 + 80.0 * (i % 5) / 4.0)
        pos = np.array([radius * math.cos(el) * math.cos(az),
                        radius * math.sin(el),
                        radius * math.cos(el) * math.sin(az)])
        R, t = look_at_world_to_camera(pos, [0.0, 0.0, 0.0])
        q = rotation_to_quaternion_wxyz(R)
        lines.append(f"{i+1} {q[0]:.8f} {q[1]:.8f} {q[2]:.8f} {q[3]:.8f} "
                     f"{t[0]:.6f} {t[1]:.6f} {t[2]:.6f} 1 cbct_frame_{i+1:04d}.png\n\n")
    with open(os.path.join(sparse, "images.txt"), "w", encoding="utf-8") as fh:
        fh.writelines(lines)
    with open(os.path.join(sparse, "points3D.txt"), "w", encoding="utf-8") as fh:
        fh.write("# 3D point list with one line of data per point:\n")
        fh.write("#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n")
        for pid, (p, c) in enumerate(zip(xyz, rgba), start=1):
            fh.write(f"{pid} {p[0]:.6f} {p[1]:.6f} {p[2]:.6f} {c[0]} {c[1]} {c[2]} 0.0\n")
    print(f"[COLMAP] synthetic rig for {args.num_views} views written to {sparse}")
    print(f"[COLMAP] NOTE: {imgs} is EMPTY -- there are no real renderings for a CBCT volume. "
          f"Training on this requires rendering the point cloud first; use cbct_layers.ply directly instead.")


def _verify_ply_rows(path: str, expected: int) -> int:
    with open(path, "rb") as fh:
        head = b""
        while not head.endswith(b"end_header\n"):
            line = fh.readline()
            if not line:
                break
            head += line
        text = head.decode("ascii", "ignore")
    n_hdr = None
    for ln in text.splitlines():
        if ln.startswith("element vertex"):
            n_hdr = int(ln.split()[-1])
    body = os.path.getsize(path) - len(head)
    # x,y,z float32 (12 B) + rgba uchar (4 B) + fdi,layer uchar (2 B) = 18 B/vertex.
    # The header is ASCII terminated by "end_header\n", so no trailing padding follows it.
    stride = 3 * 4 + 4 + 2
    n_body = body // stride
    if n_hdr != n_body:
        raise RuntimeError(f"PLY header says {n_hdr} vertices but body holds {n_body} ({body} bytes)")
    if n_body != expected:
        raise RuntimeError(f"PLY has {n_body} rows but label arrays have {expected}")
    return n_body


def _self_test() -> int:
    """Numeric self-check of the two transforms this file cannot afford to get wrong.

    Run with:  python pipeline/toothfairy2_to_layers.py --selftest

    Both assertions are *derived from the quantity under measurement* rather than hard-coded
    constants: an affine round trip, and the sign of the Y-up mapping against an independently built
    reference (a tooth painted at a known superior voxel index must land at +Y, an anterior one at
    +Z). This is the check that would have caught `apply_aff`/`coords.T` on the day it was written.
    """
    rng = np.random.default_rng(0)
    vox = rng.integers(0, 120, size=(512, 3)).astype(np.float64)
    for name, aff in (
        ("identity", np.eye(4)),
        ("1mm isotropic", np.diag([1.0, 1.0, 1.0, 1.0])),
        ("asymmetric zooms", np.diag([0.4, 0.5, 0.6, 1.0])),
        ("rotated + offset", np.array([[0.0, -0.4, 0.0, 12.0],
                                       [0.5, 0.0, 0.0, -3.0],
                                       [0.0, 0.0, 0.7, 40.0],
                                       [0.0, 0.0, 0.0, 1.0]])),
    ):
        ras = voxel_to_ras(vox, aff)
        back = np.round((np.linalg.inv(aff) @ np.hstack([ras, np.ones((len(ras), 1))]).T)[:3].T)
        assert np.allclose(back, vox, atol=1e-6), f"affine round trip failed for {name}"
        assert ras.shape == (len(vox), 3), f"voxel_to_ras lost the (N,3) shape for {name}"
        print(f"  ok   voxel_to_ras round trip: {name}")

    # Sign convention, checked on the frame the web app actually reads. Each direction vector is a
    # statement about anatomy, so a flipped row shows up as "the skull is upside down" rather than as
    # a passing test -- which is exactly how (x,-z,y) hid for as long as it did.
    sup = voxel_to_ras([[10, 10, 80], [10, 10, 20]], np.eye(4))      # RAS +z = superior
    assert sup[0, 2] > sup[1, 2], "superior voxels must raise RAS z"
    ant = voxel_to_ras([[10, 90, 10], [10, 20, 10]], np.eye(4))      # RAS +y = anterior
    assert ant[0, 1] > ant[1, 1], "anterior voxels must raise RAS y"
    g = ras_to_gltf(sup)
    assert g[0, 1] > g[1, 1], "superior must land at +Y: the renderer puts the maxilla above y0"
    g2 = ras_to_gltf(ant)
    assert g2[0, 2] > g2[1, 2], "anterior must land at +Z: lips face the camera at +Z"
    right = ras_to_gltf(np.array([[10.0, 10.0, 10.0]]))              # RAS +x = patient's right
    assert right[0, 0] < 0, "RAS +x (patient's right) must land at -X, matching FDI_11 in sceneA"
    d = float(np.linalg.det(RAS_TO_GLTF))
    assert abs(d - 1.0) < 1e-9, f"RAS->Y-up must be a rotation, det={d} (a reflection mirrors the arch)"
    print("  ok   RAS+ -> Y-up: maxilla +Y, lips +Z, patient's right at -X, det=+1")

    # The label byte contract, re-derived from this module's own tables rather than restated.
    for layer, code in (("teeth", 1), ("alveolar", 3), ("nerve", 4), ("pulp", 6),
                        ("sinus", 7), ("restoration", 8)):
        assert EMIT_CODES[layer] == code, f"layer '{layer}' maps to {EMIT_CODES[layer]}, not {code}"
    assert len(TF3_PULP_IDS) == 32 and min(TF3_PULP_IDS) == 111 and max(TF3_PULP_IDS) == 148
    print(f"  ok   layer bytes + 32 pulp ids ({TF3_PULP_IDS[0]}..{TF3_PULP_IDS[-1]})")
    print("SELFTEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
