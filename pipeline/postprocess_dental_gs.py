"""postprocess_dental_gs.py -- prune a trained 3DGS/2DGS .ply, bind FDI + anatomical
layer labels, and emit the exact web contract:

    <out_dir>/dental_pruned.ply     standard 3DGS binary_little_endian PLY
    <out_dir>/fdi_labels.bin        uint8[N], row-aligned with dental_pruned.ply
    <out_dir>/layer_labels.bin      uint8[N], row-aligned with dental_pruned.ply
    <out_dir>/labels_manifest.json  N, sha256 of the ply, label cardinality
    <out_dir>/tooth_meta_combined.json   (only with --merge_meta)

Layer encoding for layer_labels.bin (kept small because it is per-splat):
    0 = gingiva / soft tissue      1 = enamel or crown
    2 = root / dentine             3 = alveolar bone
    4 = inferior alveolar nerve    5 = unknown / other
Surface-mesh cases only ever use {0,1,2}; CBCT cases can use all six.

Usage:
    python pipeline/postprocess_dental_gs.py \
        --ply output/case01/gs_model/point_cloud/iteration_15000/point_cloud.ply \
        --proxy_glb output/case01/web_assets/proxy_teeth_combined.glb \
        --meta output/case01/web_assets/tooth_meta_combined.json \
        --out_dir output/case01/web_assets --max_splats 120000 --sh_degree 1
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
    import trimesh
    from plyfile import PlyData, PlyElement
    from scipy.spatial import cKDTree
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(f"FATAL: missing dependency ({exc}). pip install -r pipeline/requirements.txt\n")
    raise SystemExit(2)

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from dental_lib import VALID_FDI, file_row, human_size, merge_meta_files, print_artifacts  # noqa: E402

LAYER_NAMES = {
    0: "gingiva",
    1: "enamel",
    2: "root",
    3: "alveolar",
    4: "nerve",
    5: "other",
}
MAX_DIST_SANITY_MM = 400.0  # no real intra-oral scan spans more than this


# --------------------------------------------------------------------------- #
def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(np.asarray(x, dtype=np.float64), -20.0, 20.0)))


def parse_label_map(spec: str) -> Dict[int, int]:
    """Parse '11-18=enamel,31=root' or JSON into {raw_label: layer_code}."""
    out: Dict[int, int] = {}
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" not in chunk:
            raise ValueError(f"--label_map entry '{chunk}' is not of the form RANGE=CODE")
        keys, val = chunk.split("=", 1)
        val = val.strip().lower()
        if val in LAYER_NAMES:
            code = [k for k, v in LAYER_NAMES.items() if v == val][0]
        else:
            code = int(val)
        if code not in LAYER_NAMES:
            raise ValueError(f"--label_map code {code} outside 0..{max(LAYER_NAMES)}")
        for key in keys.split("+"):
            key = key.strip()
            if "-" in key:
                lo, hi = key.split("-")
                for i in range(int(lo), int(hi) + 1):
                    out[i] = code
            else:
                out[int(key)] = code
    return out


def default_fdi_layer_map() -> Dict[int, int]:
    """Teeth3DS surface scans: quadrant-first-digit 1/2 upper, 3/4 lower; all are crowns.

    Surface intra-oral scanners capture exposed coronal anatomy only, so every FDI id
    maps to 'enamel' (1) and gingiva to 0. Roots are not present in these meshes; the
    map stays user-overridable via --label_map for datasets that do label roots.
    """
    return {fdi: 1 for fdi in sorted(VALID_FDI)}


# --------------------------------------------------------------------------- #
def load_reference_pointcloud(args) -> Tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Return (points_mm_yup, fdi_uint8, layer_uint8, provenance).

    The proxy GLB is the primary reference because its node names carry the FDI ids.
    When --raw_obj/--raw_json are given we instead use the ORIGINAL scan vertices,
    which is strictly better: decimation moves vertices off the true surface, and a
    splat sitting between two adjacent teeth would otherwise be bound to whichever
    proxy vertex survived decimation.
    """
    prov = {"source": None, "nodes": 0, "faces": 0, "vertices": 0}

    if args.raw_obj and args.raw_json:
        from dental_lib import blender_to_gltf
        frame_center = None
        if args.frame_json:
            if not os.path.isfile(args.frame_json):
                raise FileNotFoundError(
                    f"--frame_json {args.frame_json} does not exist. It is required with --raw_obj so the "
                    f"binding cloud is centred exactly like the rendered images; omit --raw_obj to bind "
                    f"against --proxy_glb instead.")
            frame_center = np.asarray(json.load(open(args.frame_json, encoding="utf-8"))["center_blender_zup"],
                                      dtype=np.float64)
        verts_list, fdi_list, layer_list = [], [], []
        for obj_path, json_path in _pair_raw_inputs(args):
            v, vert_lbl = _read_obj_positions_with_labels(obj_path, json_path)
            if args.raw_up == "Y":
                # Y-up source -> Blender Z-up (identical rule to the render pass)
                v = np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)
            center = np.zeros(3) if frame_center is None else frame_center
            vg = blender_to_gltf(v - center)
            clean = np.array([int(l) if int(l) in VALID_FDI else 0 for l in vert_lbl], dtype=np.int64)
            verts_list.append(vg.astype(np.float32))
            fdi_list.append(clean.astype(np.uint8))
            layer_list.append(np.array([args.layer_map.get(int(l), 0) for l in clean], dtype=np.uint8))
        pts = np.vstack(verts_list)
        prov.update(source="raw_obj+json", vertices=int(len(pts)), nodes=len(verts_list))
        return pts, np.concatenate(fdi_list), np.concatenate(layer_list), prov

    scene = trimesh.load(args.proxy_glb, force="scene")
    pts_list, fdi_list, lay_list = [], [], []
    handled = set()
    for node_name in scene.graph.nodes_geometry:
        if node_name in handled:
            continue
        handled.add(node_name)
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry[geom_name]
        raw = node_name if "FDI_" in node_name or "GINGIVA" in node_name else geom_name
        clean = raw.replace("/", "_").strip("_")
        if clean.upper().startswith("FDI_"):
            try:
                fdi = int(clean.split("FDI_", 1)[1].split(".")[0])
            except ValueError:
                fdi = 0
            if fdi not in VALID_FDI:
                print(f"[WARN] node '{clean}' has an illegal FDI id {fdi}; treated as gingiva")
                fdi = 0
            layer = int(args.layer_map.get(fdi, 1))
        elif "GINGIVA" in clean.upper():
            fdi, layer = 0, 0
        else:
            print(f"[WARN] node '{clean}' is neither FDI_* nor GINGIVA_* -> labelled gingiva(0)")
            fdi, layer = 0, 0

        verts = trimesh.transform_points(np.asarray(geom.vertices, dtype=np.float64),
                                        np.asarray(transform, dtype=np.float64)).astype(np.float32)
        if len(verts) == 0:
            continue
        pts_list.append(verts)
        fdi_list.append(np.full(len(verts), fdi, dtype=np.uint8))
        lay_list.append(np.full(len(verts), layer, dtype=np.uint8))
        prov["faces"] += int(len(getattr(geom, "faces", []) or []))

    if not pts_list:
        raise RuntimeError(f"no usable geometry found in {args.proxy_glb}")
    pts = np.vstack(pts_list)
    prov.update(source="proxy_glb", nodes=len(pts_list), vertices=int(len(pts)))
    return pts, np.concatenate(fdi_list), np.concatenate(lay_list), prov


def _pair_raw_inputs(args) -> List[Tuple[str, str]]:
    out = []
    if args.raw_obj_upper and args.raw_json_upper:
        out.append((args.raw_obj_upper, args.raw_json_upper))
    if args.raw_obj_lower and args.raw_json_lower:
        out.append((args.raw_obj_lower, args.raw_json_lower))
    if not out and args.raw_obj and args.raw_json:
        out.append((args.raw_obj, args.raw_json))
    if not out:
        raise RuntimeError("--raw_obj/--raw_json given but no complete obj+json pair could be resolved")
    incomplete = [(a, b) for a, b in ((args.raw_obj, args.raw_json),
                                      (args.raw_obj_upper, args.raw_json_upper),
                                      (args.raw_obj_lower, args.raw_json_lower)) if bool(a) != bool(b)]
    if incomplete:
        raise RuntimeError(f"obj/json must be supplied in pairs; got {len(incomplete)} unpaired argument(s)")
    return out


def _read_obj_positions_with_labels(obj_path: str, json_path: str):
    """Vertex-ordered OBJ positions + the matching per-vertex FDI labels."""
    verts: List[List[float]] = []
    with open(obj_path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if line.startswith("v "):
                parts = line.split()
                if len(parts) >= 4:
                    verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
    with open(json_path, "r", encoding="utf-8") as fh:
        labels = np.asarray(json.load(fh)["labels"], dtype=np.int64)
    if len(labels) != len(verts):
        raise ValueError(f"{obj_path}: {len(verts)} vertices vs {json_path}: {len(labels)} labels")
    return np.asarray(verts, dtype=np.float64), labels


# --------------------------------------------------------------------------- #
def read_ply_fields(ply_path: str):
    ply = PlyData.read(ply_path)
    if "vertex" not in ply:
        raise RuntimeError(f"{ply_path}: expected a 'vertex' element, found {[e.name for e in ply.elements]}")
    data = ply["vertex"].data
    names = list(data.dtype.names)
    for req in ("x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"):
        if req not in names:
            raise RuntimeError(f"{ply_path}: missing required 3DGS attribute '{req}' (has {len(names)} fields)")
    n_rest = len([nm for nm in names if nm.startswith("f_rest_")])
    sh_degree_in = {0: 0, 9: 1, 24: 2, 45: 3}.get(n_rest, None)
    if sh_degree_in is None:
        print(f"[WARN] {n_rest} f_rest_* fields found -- not 0/9/24/45, treating input as SH degree 3 layout")
        sh_degree_in = 3
    return ply, data, names, sh_degree_in


def build_output_dtype(names: Sequence[str], keep_sh_degree: int, has_normals: bool) -> List[Tuple[str, str]]:
    """Canonical 3DGS field order, truncated at the requested SH degree.

    Field ORDER matters for the front-end converter: x,y,z, f_dc_*, normals_*, opacity,
    scale_*, rot_*, then f_rest_*. Official 3DGS stores quaternion components rot_0..3
    in (w, x, y, z) order and scales in log space -- we preserve both verbatim.
    """
    keep_rest = {0: 0, 1: 9, 2: 24, 3: 45}[keep_sh_degree]
    drop = {f"f_rest_{i}" for i in range(keep_rest, 45)}
    prefix = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"]
    mid = ["normals_0", "normals_1", "normals_2"] if has_normals else []
    tail = ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    rest = [f"f_rest_{i}" for i in range(keep_rest)]
    chosen = [c for c in prefix + mid + tail + rest if c in names and c not in drop]
    unexpected = [nm for nm in names if nm not in chosen and nm not in drop]
    if unexpected:
        print(f"[INFO] dropping {len(unexpected)} non-3DGS attributes: {unexpected[:8]}")
    dtype = [(nm, "<f4") for nm in chosen]
    missing = [nm for nm in prefix + tail if nm not in names]
    if missing:
        raise RuntimeError(f"cannot build output: source ply lacks {missing}")
    return dtype


def normalise_quaternions(out: np.ndarray, names: Sequence[str]) -> int:
    cols = ["rot_0", "rot_1", "rot_2", "rot_3"]
    if not all(c in names for c in cols):
        return 0
    q = np.stack([out[c] for c in cols], axis=1).astype(np.float64)
    norms = np.linalg.norm(q, axis=1)
    bad = int(np.sum(~np.isfinite(q) | (norms < 1e-8)))
    safe = np.where(norms > 1e-8, norms, 1.0)
    q = q / safe[:, None]
    q[~np.isfinite(q)] = np.array([1.0, 0.0, 0.0, 0.0])
    for i, c in enumerate(cols):
        out[c] = q[:, i].astype(np.float32)
    return bad


# --------------------------------------------------------------------------- #
def main(argv=None):
    p = argparse.ArgumentParser(
        description="Prune a trained Gaussian-splat .ply and bind FDI + layer labels.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--ply", type=str, default=None, help="Trained point_cloud.ply (omit with --copy_proxy_only)")
    p.add_argument("--proxy_glb", type=str, default=None, help="Proxy GLB used as the labelling reference")
    p.add_argument("--meta", type=str, default=None, help="tooth_meta json; copied through to combined when needed")
    p.add_argument("--merge_meta", type=str, nargs="+", default=None, metavar="META_JSON",
                   help="Merge several tooth_meta_<mode>.json into <out_dir>/tooth_meta_combined.json and exit")
    p.add_argument("--out_dir", type=str, required=True)
    p.add_argument("--min_opacity", type=float, default=0.05, help="Drop splats below this activated opacity")
    p.add_argument("--max_dist_mm", type=float, default=2.5,
                   help="Drop splats further than this from the reference surface (floaters)")
    p.add_argument("--max_scale_mm", type=float, default=6.0, help="Drop absurdly large ellipsoids")
    p.add_argument("--max_splats", type=int, default=120000, help="Hard cap after filtering")
    p.add_argument("--sh_degree", type=int, default=1, choices=[0, 1, 2, 3], help="SH degree to keep")
    p.add_argument("--seed", type=int, default=1337, help="Deterministic tie-break RNG for Top-K sampling")
    p.add_argument("--topk_strategy", type=str, default="coverage",
                   choices=["coverage", "importance", "spatial"],
                   help="coverage (default) = one representative per binary-searched voxel cell, then "
                        "dilate the survivor's radii by sqrt(stands-for); this is the recipe the shipped "
                        ".dspk packets use, so the compression slider compares like with like. "
                        "importance = opacity*volume top-K, which measured 17.2 dB vs 21.8 dB and darkens "
                        "the arch ~14%. spatial = one splat per fixed --voxel_mm cell, no compensation.")
    p.add_argument("--voxel_mm", type=float, default=0.35, help="Grid size for --topk_strategy spatial")
    p.add_argument("--dilate_cap", type=float, default=1.8,
                   help="Max radius multiplier per surviving splat under --topk_strategy coverage. "
                        "1.8 is ~3.2x area; uncapped, a sparse cell inflates into a slab that reads as a "
                        "different surface.")
    p.add_argument("--alpha_comp", type=float, default=0.0,
                   help="Partial transmittance compensation under coverage pruning (0 = off). Tested at "
                        "0.6 and rejected: whole-frame PSNR moved 21.81 -> 21.72 dB while a deliberately "
                        "translucent sinus splat (a=0.24) was pushed to ~0.47, i.e. it manufactures density "
                        "instead of restoring coverage. Kept as a switch so the ablation is reproducible.")
    p.add_argument("--label_map", type=str, default="",
                   help="Override layer codes, e.g. '11-28=enamel,31-48=root,0=gingiva'. "
                        "Default: every valid FDI -> enamel, 0 -> gingiva.")
    p.add_argument("--raw_obj", type=str, default=None, help="Optional original scan .obj for exact binding")
    p.add_argument("--raw_json", type=str, default=None, help="Matching per-vertex label .json")
    p.add_argument("--raw_obj_upper", type=str, default=None)
    p.add_argument("--raw_json_upper", type=str, default=None)
    p.add_argument("--raw_obj_lower", type=str, default=None)
    p.add_argument("--raw_json_lower", type=str, default=None)
    p.add_argument("--raw_arch", type=str, default="upper", choices=["upper", "lower"],
                   help="Only used to name gingiva when binding from raw OBJ; the layer/FDI ids come "
                        "from the JSON, so this does not affect label values.")
    p.add_argument("--raw_up", type=str, default="Z", choices=["Z", "Y"])
    p.add_argument("--frame_json", type=str, default=None,
                   help="Case frame.json; REQUIRED with --raw_obj so centring matches the render pass")
    p.add_argument("--copy_proxy_only", action="store_true",
                   help="No training run: write fdi/layer bins + manifest straight from the proxy mesh")
    p.add_argument("--overwrite", action="store_true")
    args = p.parse_args(argv)

    args.layer_map = {**default_fdi_layer_map(), **parse_label_map(args.label_map)} if args.label_map \
        else default_fdi_layer_map()

    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)

    if args.merge_meta:
        merged_path = os.path.join(out_dir, "tooth_meta_combined.json")
        merged = merge_meta_files(args.merge_meta, merged_path)
        print_artifacts("postprocess_dental_gs.py (--merge_meta)", [
            file_row(merged_path),
            (f"<teeth entries: {len(merged['teeth'])}>", 0),
        ])
        return 0

    if args.copy_proxy_only:
        return _copy_proxy_only(args, out_dir)

    if not args.ply:
        p.error("--ply is required unless --copy_proxy_only or --merge_meta")
    if not args.proxy_glb and not (args.raw_obj and args.raw_json):
        p.error("need --proxy_glb, or --raw_obj together with --raw_json (+ --frame_json)")

    out_ply = os.path.join(out_dir, "dental_pruned.ply")
    out_fdi = os.path.join(out_dir, "fdi_labels.bin")
    out_layer = os.path.join(out_dir, "layer_labels.bin")
    out_manifest = os.path.join(out_dir, "labels_manifest.json")
    if os.path.isfile(out_ply) and not args.overwrite:
        print(f"[SKIP] {out_ply} already exists (use --overwrite to redo)")
        print_artifacts("postprocess_dental_gs.py (cached)", [
            file_row(out_ply), file_row(out_fdi), file_row(out_layer), file_row(out_manifest)])
        return 0

    ply, v, names, sh_in = read_ply_fields(args.ply)
    n_total = int(len(v))
    xyz = np.stack([np.asarray(v["x"]), np.asarray(v["y"]), np.asarray(v["z"])], axis=1).astype(np.float64)
    opac = sigmoid(np.asarray(v["opacity"], dtype=np.float64))
    scales = np.exp(np.stack([np.asarray(v[f"scale_{i}"], dtype=np.float64) for i in range(3)], axis=1))

    finite = np.all(np.isfinite(xyz), axis=1) & np.isfinite(opac) & np.all(np.isfinite(scales), axis=1)
    if not finite.all():
        print(f"[CLEAN] dropped {int((~finite).sum())} non-finite splats")

    ref_pts, ref_fdi, ref_layer, prov = load_reference_pointcloud(args)
    if ref_pts.shape[0] < 16:
        raise RuntimeError(f"reference cloud has only {ref_pts.shape[0]} points -- cannot bind labels")
    bbox = ref_pts.max(axis=0) - ref_pts.min(axis=0)
    if np.any(bbox > MAX_DIST_SANITY_MM):
        print(f"[WARN] reference bbox spans {bbox.round(1).tolist()} mm -- larger than any real jaw. "
              f"Check units (must be millimetres) and that --raw_up/frame.json match the render pass.")

    tree = cKDTree(ref_pts)
    dists, nn_idx = tree.query(xyz, k=1, workers=-1)
    splat_fdi = ref_fdi[nn_idx]
    splat_layer = ref_layer[nn_idx]

    valid = (finite
             & (opac >= args.min_opacity)
             & (dists <= args.max_dist_mm)
             & (scales.max(axis=1) <= args.max_scale_mm))
    valid_idx = np.flatnonzero(valid)
    print(f"[PRUNE] {n_total:,} splats -> {len(valid_idx):,} after "
          f"(opacity>={args.min_opacity}, dist<={args.max_dist_mm}mm, maxscale<={args.max_scale_mm}mm)")
    if len(valid_idx) == 0:
        raise RuntimeError(
            "every splat was pruned. Most likely the reference cloud and the trained model are "
            "not in the same frame (check frame.json / raw_up), or min_opacity/max_dist_mm are too strict."
        )

    prune_info = None
    if len(valid_idx) > args.max_splats:
        if args.topk_strategy == "spatial":
            # _spatial_thin indexes into the FILTERED array, so the result must be remapped through
            # valid_idx before it touches v[] or splat_fdi[]. Missing that remap was a silent
            # mislabelling bug: every label shifted by the number of splats the filters dropped, and
            # the on-disk alignment check could not catch it because it used the same wrong indices.
            local = _spatial_thin(xyz[valid_idx], args.max_splats, args.voxel_mm,
                                  np.random.default_rng(args.seed))
            keep_idx = valid_idx[local]
        elif args.topk_strategy == "coverage":
            local, stands, cell_mm = _coverage_thin(
                xyz[valid_idx], args.max_splats,
                opac[valid_idx], scales[valid_idx], args.dilate_cap)
            keep_idx = valid_idx[local]
            prune_info = {"stands": stands, "cell_mm": cell_mm,
                          "log_gain": np.log(np.minimum(args.dilate_cap, np.sqrt(stands)))}
        else:
            importance = opac[valid_idx] * np.prod(scales[valid_idx], axis=1) ** 0.5
            part = np.argpartition(-importance, args.max_splats)[:args.max_splats]
            keep_idx = valid_idx[np.sort(part)]
        print(f"[PRUNE] Top-K {args.topk_strategy}: {len(valid_idx):,} -> {len(keep_idx):,}")
    else:
        keep_idx = valid_idx

    dtype = build_output_dtype(names, args.sh_degree, has_normals=all(
        f"normals_{i}" in names for i in range(3)))
    out = np.empty(len(keep_idx), dtype=dtype)
    for nm in dtype:
        out[nm[0]] = np.asarray(v[nm[0]])[keep_idx]
    bad_q = normalise_quaternions(out, [nm[0] for nm in dtype])
    if bad_q:
        print(f"[FIX] re-normalised {bad_q} degenerate/zero quaternions")

    kept_names = [nm[0] for nm in dtype]
    n_rest_out = len([nm for nm in kept_names if nm.startswith("f_rest_")])
    if n_rest_out != {0: 0, 1: 9, 2: 24, 3: 45}[args.sh_degree]:
        raise RuntimeError(f"SH truncation failed: asked degree {args.sh_degree}, wrote {n_rest_out} f_rest fields")

    if prune_info is not None:
        if not all(f"scale_{k}" in kept_names for k in range(3)):
            raise RuntimeError("coverage pruning needs scale_0..2 in the output; this PLY has none")
        # Coverage compensation, in log-space here (the PLY stores ln of the scale) rather than as the
        # u8 byte delta the web container uses -- same multiplier, different representation. Two rules
        # matter: only the two WIDE axes grow by the full amount and the thin axis gets half, because
        # growing the thickness makes the surface read as a slab; and the growth is capped
        # (--dilate_cap) so a sparse cell cannot become a balloon. Positions are never moved, so the
        # pruned cloud stays a subset of the trained one and the chamfer/coverage metrics stay valid.
        lg = prune_info["log_gain"]
        rows = np.arange(len(keep_idx))
        thick = np.argmin(np.stack([out["scale_0"], out["scale_1"], out["scale_2"]], axis=1), axis=1)
        for k in range(3):
            field = f"scale_{k}"
            grow = np.where(rows == thick, lg * 0.5, lg)
            out[field] = out[field] + grow
        if args.alpha_comp > 0:
            st = prune_info["stands"]
            a = opac[keep_idx]
            eff = 1.0 - np.power(1.0 - a, 1.0 + (st - 1.0) * args.alpha_comp)
            eff = np.clip(np.maximum(a, eff), 1e-6, 1 - 1e-6)          # grow only, never fully opaque
            out["opacity"] = np.log(eff / (1.0 - eff))                  # back to the stored logit
        dil = int((lg > 1e-9).sum())
        print(f"[COVER] dilated {dil:,}/{len(keep_idx):,} survivors, cell {prune_info['cell_mm']:.3f} mm, "
              f"mean radius gain {float(np.exp(lg[lg > 1e-9].mean())) if dil else 1.0:.3f}, "
              f"alpha_comp {args.alpha_comp}")

    PlyData([PlyElement.describe(out, "vertex")], text=False).write(out_ply)

    final_fdi = np.ascontiguousarray(splat_fdi[keep_idx], dtype=np.uint8)
    final_layer = np.ascontiguousarray(splat_layer[keep_idx], dtype=np.uint8)
    assert len(final_fdi) == len(out), f"fdi length {len(final_fdi)} != ply rows {len(out)}"
    assert len(final_layer) == len(out), f"layer length {len(final_layer)} != ply rows {len(out)}"
    final_fdi.tofile(out_fdi)
    final_layer.tofile(out_layer)

    # Re-read from disk and assert byte-for-byte alignment against the actual PLY rows.
    chk = PlyData.read(out_ply)["vertex"].data
    n_rows = int(len(chk))
    on_disk_fdi = np.fromfile(out_fdi, dtype=np.uint8)
    on_disk_layer = np.fromfile(out_layer, dtype=np.uint8)
    if n_rows != len(keep_idx) or len(on_disk_fdi) != n_rows or len(on_disk_layer) != n_rows:
        raise RuntimeError(
            f"ALIGNMENT FAILURE: ply rows={n_rows}, fdi={len(on_disk_fdi)}, layer={len(on_disk_layer)}")
    px = np.asarray(chk["x"], dtype=np.float64)
    if not np.allclose(px, np.asarray(v["x"])[keep_idx], atol=1e-5):
        raise RuntimeError("ALIGNMENT FAILURE: written x coordinates do not match the kept index order")

    fdi_counts = {str(k): int(c) for k, c in sorted(Counter(int(x) for x in on_disk_fdi).items())}
    layer_counts = {LAYER_NAMES.get(k, str(k)): int(c) for k, c in
                    sorted(Counter(int(x) for x in on_disk_layer).items())}
    manifest = {
        "schema_version": 1,
        "n_splats": n_rows,
        "ply": os.path.basename(out_ply),
        "ply_sha256": _sha256(out_ply),
        "ply_bytes": os.path.getsize(out_ply),
        "ply_attributes": kept_names,
        "sh_degree": int(args.sh_degree),
        "n_f_rest": int(n_rest_out),
        "coordinate_system": "glTF_Y_up",
        "unit": "mm",
        "fdi_labels_bin": {"file": "fdi_labels.bin", "dtype": "uint8", "bytes": int(on_disk_fdi.nbytes),
                           "row_order": "identical to dental_pruned.ply vertex rows"},
        "layer_labels_bin": {"file": "layer_labels.bin", "dtype": "uint8", "bytes": int(on_disk_layer.nbytes),
                             "row_order": "identical to dental_pruned.ply vertex rows"},
        "fdi_cardinality": len(fdi_counts),
        "fdi_counts": fdi_counts,
        "layer_cardinality": len(layer_counts),
        "layer_counts": layer_counts,
        "layer_encoding": {str(k): v for k, v in LAYER_NAMES.items()},
        "reference": prov,
        "filters": {"min_opacity": args.min_opacity, "max_dist_mm": args.max_dist_mm,
                    "max_scale_mm": args.max_scale_mm, "max_splats": args.max_splats,
                    "topk_strategy": args.topk_strategy, "seed": args.seed},
        # Written so a reviewer can tell which pruner made this cloud. The web generator embeds the
        # same keys under meta.metrics.prune inside the .dspk; keep the two in step, because the
        # Full-vs-Pruned claim is only fair when both sides share a recipe.
        "prune": ({"strategy": args.topk_strategy,
                   "cell_mm": round(float(prune_info["cell_mm"]), 4),
                   "dilate_cap": args.dilate_cap, "alpha_comp": args.alpha_comp,
                   "dilated_splats": int((prune_info["log_gain"] > 1e-9).sum()),
                   "mean_gain": round(float(np.exp(prune_info["log_gain"][prune_info["log_gain"] > 1e-9]
                                                  .mean())), 4)
                   if int((prune_info["log_gain"] > 1e-9).sum()) else 1.0,
                   "positions_subset_of_input": True,
                   "naive_repro": "--topk_strategy importance"}
                  if prune_info is not None else
                  {"strategy": args.topk_strategy, "dilate_cap": None, "alpha_comp": None,
                   "positions_subset_of_input": True}),
        "input_ply": os.path.abspath(args.ply),
        "input_splats": n_total,
        "input_sh_degree": int(sh_in),
    }
    with open(out_manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    orig_mb = os.path.getsize(args.ply) / (1024 ** 2)
    new_mb = os.path.getsize(out_ply) / (1024 ** 2)
    print(f"[LABEL] reference = {prov['source']} ({prov['vertices']:,} pts, {prov['nodes']} nodes)")
    print(f"[LABEL] distinct FDI on splats: {len(fdi_counts)}  layers: {sorted(layer_counts)}")
    print(f"[SIZE ] {orig_mb:.2f} MB -> {new_mb:.2f} MB (SH degree {sh_in} -> {args.sh_degree})")
    print_artifacts("postprocess_dental_gs.py", [
        file_row(out_ply), file_row(out_fdi), file_row(out_layer), file_row(out_manifest),
    ])
    return 0


def _spatial_thin(pts: np.ndarray, target: int, voxel_mm: float, rng: np.random.Generator) -> np.ndarray:
    """Keep one splat per voxel until the budget is met, preferring high-importance cells.

    Deterministic given --seed, and unlike pure importance ranking it never collapses the
    whole cloud onto the few brightest splats, which would leave holes in the arch.
    """
    vox = max(float(voxel_mm), 1e-3)
    keys = np.floor(pts / vox).astype(np.int64)
    offs = keys.min(axis=0)
    keys = keys - offs
    dims = keys.max(axis=0) + 1
    flat = (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]
    uniq, first = np.unique(flat, return_index=True)
    if len(uniq) <= target:
        return np.sort(first)
    order = rng.permutation(len(first))
    picked = first[np.sort(order[:target])]
    return np.sort(picked)


def _coverage_thin(pts: np.ndarray, target: int, opac: np.ndarray, scales: np.ndarray,
                   dilate_cap: float):
    """Cell selection with areal compensation -- the Python twin of pruneCloud() in
    tools/gen-dental-assets.ts, which is what the shipped .dspk packets were built with.

    Three ideas, in order of how much they matter:

    1. Binary-search the CELL EDGE so the number of occupied cells lands on the budget, instead of
       fixing --voxel_mm and hoping. Too fine and you keep one splat per cell but far more cells than
       you can afford; too coarse and whole quadrants collapse onto one survivor.
    2. Keep the *best* splats per cell, distributed round-robin by cell size, so a dense region buys
       more survivors rather than being truncated by global rank.
    3. Dilate each survivor by sqrt(stands_for), where stands_for = (splats in the cell) / (splats
       the budget kept from that cell). Replacing k footprints with one needs area x k, i.e. radius
       x sqrt(k). This is what preserves coverage; dropping the losers bare simply removes paint,
       which measured 17.2 dB against this recipe's 21.8 dB and darkened the arch by ~14%.

    Returns (local_indices_sorted, stands_per_survivor, cell_mm). Indices are LOCAL to the arrays
    passed in; the caller remaps through valid_idx.
    """
    n = len(pts)
    target = max(1, int(target))
    span = pts.max(axis=0) - pts.min(axis=0)
    # Same importance as the TS path (alpha^2 * geometric-mean radius): alpha^2 because a splat's
    # contribution to a pixel goes roughly as its transmittance squared once neighbours are counted,
    # and a length rather than a volume so a paper-thin floater does not out-rank a real surface splat.
    score = (np.asarray(opac, dtype=np.float64) ** 2) * np.cbrt(np.prod(scales, axis=1))

    def cells(q):
        # np.floor of millimetre coordinates is a valid grid for negatives too: two splats share a
        # cell iff every axis floors to the same integer, which is exactly what np.unique(axis=0) keys.
        g = np.floor(pts / q).astype(np.int64)
        _, inv = np.unique(g, axis=0, return_inverse=True)
        return inv.ravel()

    best = None
    best_err = float("inf")
    lo, hi = 0.05, max(float(np.sort(span)[0]) * 0.5, 0.06)
    for _ in range(14):
        q = float(np.sqrt(lo * hi))                     # geometric mid: the error is multiplicative
        inv = cells(q)
        counts = np.bincount(inv)
        n_cells = int(len(counts))
        err = abs(n_cells - target) / float(target)
        if best is None or err < best_err:
            best, best_err = (q, inv, counts), err
        if n_cells > target:
            lo = q          # too many cells -> the grid is too fine -> coarsen
        else:
            hi = q          # too few -> refine
        if err < 0.03:
            break

    cell_mm, inv, counts = best

    # rank inside each cell by score (0 = best), then take ranks in round-robin over cells ordered
    # by cell population, so the budget spreads across the arch before it deepens anywhere.
    order = np.lexsort((-score, inv))
    inv_sorted = inv[order]
    first_occ = np.empty(len(counts), dtype=np.int64)
    first_occ[inv_sorted[::-1]] = np.arange(n)[::-1]     # last write wins -> first occurrence
    rank = np.arange(n) - first_occ[inv_sorted]
    cell_priority = np.argsort(-counts)[inv_sorted]
    pick_order = order[np.lexsort((-cell_priority, rank))[:target]]
    local = np.sort(pick_order)

    picked_cells = inv[pick_order]
    kept = np.bincount(picked_cells, minlength=len(counts))
    stands = (counts / np.maximum(kept, 1))[picked_cells]
    # stands is currently aligned to pick_order; re-align it to the sorted `local` the caller indexes with
    stands = stands[np.argsort(pick_order)]
    stands = np.maximum(stands, 1.0)
    # The caller takes sqrt(stands) as the radius multiplier, so capping the radius at dilate_cap means
    # capping stands at cap**2 here. Doing it before the sqrt keeps one clamp, not two.
    if dilate_cap and dilate_cap > 0:
        stands = np.minimum(stands, float(dilate_cap) ** 2)
    return local, stands, cell_mm


def _copy_proxy_only(args, out_dir: str) -> int:
    """Scene-B-style fallback: no Gaussians, just label arrays for the proxy mesh.

    Writes a minimal-but-valid 3DGS PLY whose splats sit exactly on the proxy vertices
    with tiny isotropic scales, so the front-end can still render something before any
    training happens. This is NOT a substitute for a trained model -- it is a placeholder
    that is guaranteed coordinate-consistent.
    """
    if not args.proxy_glb:
        raise SystemExit("FATAL: --copy_proxy_only needs --proxy_glb")
    pts, fdi, layer, prov = load_reference_pointcloud(args)
    n = len(pts)
    dtype = [("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
             ("f_dc_0", "<f4"), ("f_dc_1", "<f4"), ("f_dc_2", "<f4"),
             ("opacity", "<f4"), ("scale_0", "<f4"), ("scale_1", "<f4"), ("scale_2", "<f4"),
             ("rot_0", "<f4"), ("rot_1", "<f4"), ("rot_2", "<f4"), ("rot_3", "<f4")]
    arr = np.empty(n, dtype=dtype)
    arr["x"], arr["y"], arr["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
    is_tooth = fdi != 0
    base_rgb = np.where(is_tooth[:, None],
                        np.array([0.92, 0.88, 0.80], dtype=np.float64),
                        np.array([0.72, 0.34, 0.36], dtype=np.float64))
    # Inverse of the 3DGS SH band-0 encoding: rgb = 0.5 + C0 * f_dc, C0 = 0.5 / sqrt(pi)
    c0 = 0.5 / float(np.sqrt(np.pi))
    sh0 = (base_rgb - 0.5) / c0
    for i in range(3):
        arr[f"f_dc_{i}"] = sh0[:, i].astype(np.float32)
    arr["opacity"] = np.float32(math.log(0.9 / 0.1))
    log_s = np.log(np.float32(max(args.voxel_mm, 0.25)))
    for i in range(3):
        arr[f"scale_{i}"] = log_s
    arr["rot_0"], arr["rot_1"], arr["rot_2"], arr["rot_3"] = 1.0, 0.0, 0.0, 0.0

    out_ply = os.path.join(out_dir, "dental_pruned.ply")
    out_fdi = os.path.join(out_dir, "fdi_labels.bin")
    out_layer = os.path.join(out_dir, "layer_labels.bin")
    out_manifest = os.path.join(out_dir, "labels_manifest.json")
    PlyData([PlyElement.describe(arr, "vertex")], text=False).write(out_ply)
    np.ascontiguousarray(fdi, dtype=np.uint8).tofile(out_fdi)
    np.ascontiguousarray(layer, dtype=np.uint8).tofile(out_layer)

    rows = int(len(PlyData.read(out_ply)["vertex"].data))
    assert rows == n == os.path.getsize(out_fdi) == os.path.getsize(out_layer), \
        f"ALIGNMENT FAILURE rows={rows} n={n} fdi_bytes={os.path.getsize(out_fdi)}"
    fdi_counts = {str(k): int(c) for k, c in sorted(Counter(int(x) for x in fdi).items())}
    layer_counts = {LAYER_NAMES.get(k, str(k)): int(c) for k, c in
                    sorted(Counter(int(x) for x in layer).items())}
    with open(out_manifest, "w", encoding="utf-8") as fh:
        json.dump({
            "schema_version": 1, "n_splats": rows, "ply": "dental_pruned.ply",
            "ply_sha256": _sha256(out_ply), "ply_bytes": os.path.getsize(out_ply),
            "ply_attributes": [d[0] for d in dtype], "sh_degree": 0, "n_f_rest": 0,
            "coordinate_system": "glTF_Y_up", "unit": "mm",
            "synthetic_placeholder": True,
            "note": "Generated from proxy mesh without training. Replace by running train_gsplat.sh.",
            "fdi_cardinality": len(fdi_counts), "fdi_counts": fdi_counts,
            "layer_cardinality": len(layer_counts), "layer_counts": layer_counts,
            "layer_encoding": {str(k): v for k, v in LAYER_NAMES.items()},
            "reference": prov,
        }, fh, indent=2)
    print(f"[PROXY_ONLY] wrote {rows:,} synthetic splats (no training performed)")
    print_artifacts("postprocess_dental_gs.py (--copy_proxy_only)", [
        file_row(out_ply), file_row(out_fdi), file_row(out_layer), file_row(out_manifest)])
    return 0


def _sha256(path: str) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    sys.exit(main())
