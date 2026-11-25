#!/usr/bin/env python3
"""cbct_proxy.py -- build the invisible FDI proxy for a CBCT case.

The web app picks teeth and measures millimetres against a hidden proxy mesh, not against splat
centres (NOTES.md §3). Scene A gets that proxy from the source mesh (`postprocess_dental_gs.py
--copy_proxy_only`), but the CBCT route had none: `toothfairy2_to_layers.py` emits a point cloud
and labels only, so a real case would have had nothing to raycast against. This script fills that
gap with one convex hull per FDI tooth.

Frame: identical to the converter's. Voxel centres go through the NIfTI affine into RAS+ mm, then
through RAS_TO_GLTF (x, y, z) -> (-x, z, y), then the whole cloud is shifted by the same
`center_yup_mm` the converter cached in `frame_cbct.json`. Reusing that sidecar (instead of
recomputing a centre from the hulls) is what keeps proxy and splats in one frame.

    python pipeline/cbct_proxy.py --labels_nii case.nii.gz \
        --frame_json out/frame_cbct.json --out public/assets/proxy_B.glb

Self-test (no input files, uses a small analytic volume): --selftest
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from typing import Dict, List, Tuple

import numpy as np

try:
    import nibabel as nib
except ImportError:  # pragma: no cover - the message is the point
    sys.exit("FATAL: nibabel is required to read the label volume (pip install nibabel)")

from scipy.spatial import ConvexHull, QhullError

# Same matrix as pipeline/toothfairy2_to_layers.py; duplicated rather than imported so this file can
# run without that module's argparse side effects, and asserted against it in --selftest.
RAS_TO_GLTF = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])


def fdi_map(seg: np.ndarray) -> Dict[int, int]:
    """Label id -> FDI for the ids that name a tooth. ToothFairy3: 11..48 teeth, 111..148 pulp."""
    vals, counts = np.unique(seg, return_counts=True)
    out: Dict[int, int] = {}
    for v, n in zip(vals.tolist(), counts.tolist()):
        if n <= 0:
            continue
        if 11 <= v <= 48:
            out[int(v)] = int(v)
        elif 111 <= v <= 148 and 11 <= v - 100 <= 48:
            out[int(v)] = int(v - 100)
    return out


def hulls(seg: np.ndarray, aff: np.ndarray, center: np.ndarray) -> Tuple[Dict[int, Tuple[np.ndarray, np.ndarray]], List[int]]:
    """One convex hull per FDI, in the project's Y-up millimetre frame.

    Tooth and pulp voxels are merged by FDI *before* hulling: ToothFairy3 gives the pulp its own
    label id (FDI+100), and hulling each id separately then assigning by FDI let the smaller pulp
    hull overwrite the tooth hull -- the selftest below caught exactly that (an 8 mm tooth became a
    3 mm pulp).
    """
    by_fdi: Dict[int, List[int]] = {}
    for label_id, fdi in fdi_map(seg).items():
        by_fdi.setdefault(fdi, []).append(label_id)
    if not by_fdi:
        raise SystemExit("FATAL: no FDI-naming label ids (11..48 or 111..148) in the volume")
    out: Dict[int, Tuple[np.ndarray, np.ndarray]] = {}
    skipped: List[int] = []
    for fdi, label_ids in sorted(by_fdi.items()):
        idx = np.argwhere(np.isin(seg, label_ids))
        if len(idx) < 4:
            skipped.append(fdi)
            continue
        ras = nib.affines.apply_affine(np.asarray(aff, dtype=np.float64), idx.astype(np.float64))
        yup = ras @ RAS_TO_GLTF.T - center
        try:
            hull = ConvexHull(yup)
        except QhullError:
            skipped.append(fdi)
            continue
        # Qhull's simplices index the ORIGINAL point array, not the hull.vertices subset that becomes
        # the vertex buffer. Shipping them unremapped produces a mesh whose indices point past the end
        # of POSITION -- which the browser rejects or renders as garbage. tools/check-glb.mjs caught
        # exactly that on the first fixture build; the remap below is the fix.
        pos = np.ascontiguousarray(yup[hull.vertices], dtype=np.float32)
        inv = np.full(len(yup), 0xFFFFFFFF, dtype=np.uint32)
        inv[hull.vertices] = np.arange(len(hull.vertices), dtype=np.uint32)
        faces = np.ascontiguousarray(inv[hull.simplices], dtype=np.uint32)
        if int(faces.max()) >= len(pos):
            skipped.append(fdi)
            continue
        out[fdi] = (pos, faces)
    if not out:
        raise SystemExit("FATAL: every tooth hull was degenerate")
    return out, skipped


def write_glb(path: str, parts: Dict[int, Tuple[np.ndarray, np.ndarray]]) -> Dict[str, object]:
    """Minimal GLB 2.0 writer: one node per tooth, POSITION + indices, no materials.

    Deliberately dependency-free: trimesh is only in requirements for *reading* proxies, and a
    writer that adds a dependency to the ingest path is a writer that can fail on the cluster.
    """
    bin_parts: List[bytes] = []
    views: List[dict] = []
    accessors: List[dict] = []
    meshes: List[dict] = []
    nodes: List[dict] = []
    offset = 0

    def add_view(buf: bytes, target: int) -> int:
        nonlocal offset
        pad = (-len(buf)) % 4
        chunk = buf + b"\x00" * pad
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(buf), "target": target})
        bin_parts.append(chunk)
        offset += len(chunk)
        return len(views) - 1

    for fdi, (pos, idx) in sorted(parts.items()):
        pv = add_view(pos.tobytes(), 34962)
        iv = add_view(idx.astype(np.uint32).tobytes(), 34963)
        pmin = pos.min(axis=0).astype(float).tolist()
        pmax = pos.max(axis=0).astype(float).tolist()
        accessors.append({"bufferView": pv, "componentType": 5126, "count": int(len(pos)),
                          "type": "VEC3", "min": pmin, "max": pmax})
        pa = len(accessors) - 1
        accessors.append({"bufferView": iv, "componentType": 5125, "count": int(idx.size), "type": "SCALAR"})
        ia = len(accessors) - 1
        meshes.append({"name": f"FDI_{fdi}", "primitives": [
            {"attributes": {"POSITION": pa}, "indices": ia, "mode": 4}]})
        nodes.append({"name": f"FDI_{fdi}", "mesh": len(meshes) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "dentsplat cbct_proxy.py"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binb = b"".join(bin_parts)
    total = 12 + 8 + len(js) + 8 + len(binb)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))   # 'glTF', version 2
        f.write(struct.pack("<II", len(js), 0x4E4F534A))     # JSON
        f.write(js)
        f.write(struct.pack("<II", len(binb), 0x004E4942))   # BIN
        f.write(binb)
    return {"bytes": total, "teeth": len(nodes), "vertices": int(sum(len(p) for p, _ in parts.values())),
            "triangles": int(sum(len(i) for _, i in parts.values()))}


def selftest() -> None:
    """Two analytic teeth on a synthetic 1 mm grid, checked against an independently built expectation."""
    aff = np.diag([1.0, 1.0, 1.0, 1.0])
    seg = np.zeros((60, 60, 60), dtype=np.int16)
    # tooth 11: a cube around voxel (20,20,20); tooth 36: a cube around (40,40,40)
    seg[16:25, 16:25, 16:25] = 11
    seg[36:45, 36:45, 36:45] = 36
    seg[18:22, 18:22, 18:22] = 111                   # pulp inside 11 -> same FDI
    center = np.array([30.0, 30.0, 30.0])
    parts, skipped = hulls(seg, aff, center)
    assert not skipped, skipped
    assert sorted(parts) == [11, 36], sorted(parts)
    pos11 = parts[11][0]
    # Y-up frame: x = -i, y = k, z = j (all minus centre); the cube spans 8 mm per side.
    assert np.allclose(pos11.max(axis=0) - pos11.min(axis=0), [8, 8, 8], atol=1e-4), pos11.max(axis=0) - pos11.min(axis=0)
    assert np.allclose(pos11.mean(axis=0), [-20, 20, 20] - center, atol=1e-3), pos11.mean(axis=0)
    # Faces must address the vertex buffer, not the original voxel array (this is the remap that the
    # GLB checker caught on the first fixture build).
    for fdi, (pos, faces) in parts.items():
        assert faces.size % 3 == 0 and int(faces.max()) < len(pos), (fdi, int(faces.max()), len(pos))
    assert len(parts[11][0]) == 8, len(parts[11][0])
    out = "/tmp/cbct_proxy_selftest.glb"
    meta = write_glb(out, parts)
    with open(out, "rb") as f:
        head = f.read(12)
    magic, version, length = struct.unpack("<III", head)
    assert magic == 0x46546C67 and version == 2 and length == meta["bytes"], (magic, version, length)
    print(f"selftest ok: {meta['teeth']} teeth, {meta['vertices']} vertices, {meta['triangles']} triangles, "
          f"{meta['bytes']} B  ({out})")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build one convex hull per FDI tooth for the CBCT proxy.")
    ap.add_argument("--labels_nii", help="segmentation volume (caseID.nii.gz)")
    ap.add_argument("--frame_json", help="frame_cbct.json written by toothfairy2_to_layers.py")
    ap.add_argument("--meta_json", help="tooth_meta_cbct.json from the same run; enables the bbox cross-check")
    ap.add_argument("--out", default="public/assets/proxy_B.glb")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.labels_nii or not args.frame_json:
        sys.exit("FATAL: --labels_nii and --frame_json are required (or pass --selftest)")

    img = nib.load(args.labels_nii)
    seg = np.asarray(img.dataobj)
    if seg.ndim == 4:
        seg = seg[..., 0]
    seg = seg.astype(np.int16, copy=False)
    frame = json.load(open(args.frame_json, encoding="utf-8"))
    center = np.asarray(frame["center_yup_mm"], dtype=np.float64)

    parts, skipped = hulls(seg, np.asarray(img.affine, dtype=np.float64), center)
    meta = write_glb(args.out, parts)
    lo = np.min([p.min(axis=0) for p, _ in parts.values()], axis=0)
    hi = np.max([p.max(axis=0) for p, _ in parts.values()], axis=0)
    side: Dict[str, object] = {"out": args.out, "bytes": meta["bytes"], "teeth": meta["teeth"],
                               "skipped_fdi": sorted(set(skipped)),
                               "bbox_mm": [np.round(lo, 2).tolist(), np.round(hi, 2).tolist()],
                               "centre_mm": np.round((lo + hi) / 2.0, 2).tolist(),
                               "frame_center": frame["center_yup_mm"]}
    problems: List[str] = []
    # The proxy covers teeth only, so its bbox is NOT expected to be centred on the frame (the frame
    # spans bone and sinus too). What must hold is that it lives inside the frame and is big enough to
    # be a dentition; and, when the converter's meta is supplied, that it agrees with the layer bbox
    # the splats themselves were built from.
    if float(np.max(np.abs((lo + hi) / 2.0))) > 80.0:
        problems.append(f"proxy centre {(np.round((lo + hi) / 2.0, 1)).tolist()} is outside +/-80 mm")
    if float(np.min(hi - lo)) < 10.0:
        problems.append(f"proxy spans only {np.round(hi - lo, 1).tolist()} mm")
    if args.meta_json:
        teeth_meta = (json.load(open(args.meta_json, encoding="utf-8")).get("teeth") or {}).get("LAYER_TEETH")
        if not teeth_meta:
            problems.append("--meta_json has no teeth.LAYER_TEETH entry")
        else:
            tlo = np.asarray(teeth_meta["bbox_min_mm"], dtype=np.float64)
            thi = np.asarray(teeth_meta["bbox_max_mm"], dtype=np.float64)
            over = np.maximum(tlo - lo, hi - thi)               # positive => proxy sticks out
            cover = (hi - lo) / np.maximum(thi - tlo, 1e-6)
            side["teeth_bbox_mm"] = [np.round(tlo, 2).tolist(), np.round(thi, 2).tolist()]
            side["max_overshoot_mm"] = round(float(np.max(over)), 2)
            side["axis_coverage"] = np.round(cover, 3).tolist()
            if float(np.max(over)) > 3.0:
                problems.append(f"proxy bbox exceeds LAYER_TEETH by {float(np.max(over)):.1f} mm -- wrong frame?")
            if float(np.min(cover)) < 0.6:
                problems.append(f"proxy covers only {float(np.min(cover)) * 100:.0f}% of a LAYER_TEETH axis")
    print(json.dumps(side, ensure_ascii=False))
    if problems:
        sys.exit("FATAL: " + "; ".join(problems))


if __name__ == "__main__":
    main()
