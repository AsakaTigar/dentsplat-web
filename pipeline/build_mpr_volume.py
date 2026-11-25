#!/usr/bin/env python3
"""Build the browser-native, Y-up millimetre MPR volume for DentVoxel case 0095.

The transform is deliberately identical to pipeline/cbct_surfel.py:
    RAS mm -> (RAS_TO_GLTF @ ras) - center_yup_mm
The target array is C-ordered [x, y, z], so the browser can turn any world-mm
cursor into an integer index with only bbox/spacing arithmetic.
"""
from __future__ import annotations

import argparse
import gzip
import json
import struct
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.ndimage import map_coordinates

RAS_TO_GLTF = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]], dtype=np.float64)


def world_centroid(indices: np.ndarray, affine: np.ndarray, center: np.ndarray) -> list[float]:
    ras = nib.affines.apply_affine(affine, indices.astype(np.float64))
    world = ras @ RAS_TO_GLTF.T - center
    return [round(float(v), 3) for v in world.mean(axis=0)]


def dspk_layer_centroid(path: Path, layer: int) -> list[float]:
    b = path.read_bytes()
    if b[:4] != b"DSPK":
        raise ValueError(f"{path}: not DSPK")
    stride = b[7]
    count = struct.unpack_from("<I", b, 8)[0]
    bmin = np.array(struct.unpack_from("<3f", b, 12), dtype=np.float64)
    bmax = np.array(struct.unpack_from("<3f", b, 24), dtype=np.float64)
    meta_len = struct.unpack_from("<I", b, 44)[0]
    base = 128 + meta_len
    total = np.zeros(3, dtype=np.float64)
    n = 0
    for i in range(count):
        o = base + i * stride
        if b[o + 18] != layer:
            continue
        for k in range(3):
            q = struct.unpack_from("<H", b, o + 2 * k)[0] / 65535.0
            total[k] += bmin[k] + q * (bmax[k] - bmin[k])
        n += 1
    if not n:
        raise ValueError(f"{path}: no layer {layer}")
    return [round(float(v), 3) for v in total / n]


def dist(a: list[float], b: list[float]) -> float:
    return round(float(np.linalg.norm(np.asarray(a) - np.asarray(b))), 3)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--image", default="tools/out/data/img0095.nii.gz")
    ap.add_argument("--labels", default="tools/out/data/labels_tf3_0095.nii.gz")
    ap.add_argument("--frame", default="tools/out/dentvoxel0095/frame_cbct.json")
    ap.add_argument("--dspk", default="public/assets/sceneB_dentvoxel_full.dspk")
    ap.add_argument("--out", default="public/assets/case0095_mpr.vol.gz")
    ap.add_argument("--meta", default="public/assets/case0095_mpr.json")
    ap.add_argument("--dims", default="160,140,128")
    ap.add_argument("--hu-min", type=float, default=-500.0)
    ap.add_argument("--hu-max", type=float, default=2800.0)
    args = ap.parse_args()

    dims = tuple(int(x) for x in args.dims.split(","))
    if len(dims) != 3 or min(dims) < 2:
        raise SystemExit("--dims must be nx,ny,nz with each >= 2")
    nx, ny, nz = dims
    image = nib.load(args.image)
    labels = nib.load(args.labels)
    hu = np.asarray(image.dataobj)
    seg = np.asarray(labels.dataobj)
    if hu.shape != seg.shape:
        raise SystemExit(f"shape mismatch: image {hu.shape}, labels {seg.shape}")
    if seg.ndim == 4:
        seg = seg[..., 0]
    if not np.allclose(image.affine, labels.affine, atol=1e-5):
        raise SystemExit("image/label affines differ")
    aff = np.asarray(image.affine, dtype=np.float64)
    inv_aff = np.linalg.inv(aff)
    center = np.asarray(json.load(open(args.frame, encoding="utf-8"))["center_yup_mm"], dtype=np.float64)

    corners = np.asarray([[0, 0, 0], [hu.shape[0] - 1, hu.shape[1] - 1, hu.shape[2] - 1]], dtype=np.float64)
    world_corners = nib.affines.apply_affine(aff, corners) @ RAS_TO_GLTF.T - center
    bbox_min = world_corners.min(axis=0)
    bbox_max = world_corners.max(axis=0)
    axes = [np.linspace(bbox_min[k], bbox_max[k], dims[k], dtype=np.float64) for k in range(3)]
    spacing = (bbox_max - bbox_min) / np.asarray([nx - 1, ny - 1, nz - 1], dtype=np.float64)

    gx, gy, gz = np.meshgrid(axes[0], axes[1], axes[2], indexing="ij")
    world = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    ras = (world + center) @ RAS_TO_GLTF  # R is an involution; this is R^T @ (world+center)
    vox = ras @ inv_aff[:3, :3].T + inv_aff[:3, 3]
    coords = np.ascontiguousarray(vox.T)
    del gx, gy, gz, world, ras, vox

    hu_res = map_coordinates(hu.astype(np.float32), coords, order=1, mode="constant", cval=args.hu_min, prefilter=False)
    seg_res = map_coordinates(seg.astype(np.float32), coords, order=0, mode="constant", cval=0, prefilter=False).reshape((nx, ny, nz))
    f38_res = map_coordinates((seg == 38).astype(np.float32), coords, order=0, mode="constant", cval=0, prefilter=False) > 0.5
    del coords

    hu_q = np.clip((hu_res - args.hu_min) / (args.hu_max - args.hu_min), 0.0, 1.0)
    hu8 = np.rint(hu_q * 255.0).astype(np.uint8).reshape((nx, ny, nz))
    mask = np.zeros((nx, ny, nz), dtype=np.uint8)
    mask[np.isin(seg_res, [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28,
                           31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48])] = 1
    mask[np.isin(seg_res, [1, 2])] = 2
    mask[seg_res == 3] = 3
    mask[seg_res == 5] = 4
    f38 = f38_res.reshape((nx, ny, nz))

    flat_mask = mask.ravel()
    packed = np.zeros((flat_mask.size + 1) // 2, dtype=np.uint8)
    packed[:flat_mask.size // 2] = flat_mask[0::2] | (flat_mask[1::2] << 4)
    if flat_mask.size % 2:
        packed[-1] = flat_mask[-1]
    hu_raw = hu8.tobytes(order="C")
    mask_raw = packed.tobytes(order="C")

    def target_centroid(vox_mask: np.ndarray) -> list[float]:
        idx = np.argwhere(vox_mask)
        if not len(idx):
            raise ValueError("empty resampled validation mask")
        w = bbox_min + idx.astype(np.float64) * spacing
        return [round(float(v), 3) for v in w.mean(axis=0)]

    src_f38 = world_centroid(np.argwhere(seg == 38), aff, center)
    src_nerve = world_centroid(np.argwhere(seg == 3), aff, center)
    res_f38 = target_centroid(f38)
    res_nerve = target_centroid(mask == 3)
    dspk_f38 = json.load(open("public/assets/meta_B_dentvoxel.json", encoding="utf-8"))["teeth"]["FDI_38"]["at"]
    dspk_nerve = dspk_layer_centroid(Path(args.dspk), 4)
    validation = {
        "fdi38_source_mm": src_f38,
        "fdi38_resampled_mm": res_f38,
        "fdi38_resample_error_mm": dist(src_f38, res_f38),
        "fdi38_3dgs_mm": dspk_f38,
        "fdi38_source_to_3dgs_mm": dist(src_f38, dspk_f38),
        "nerve_source_mm": src_nerve,
        "nerve_resampled_mm": res_nerve,
        "nerve_resample_error_mm": dist(src_nerve, res_nerve),
        "nerve_3dgs_mm": dspk_nerve,
        "nerve_source_to_3dgs_mm": dist(src_nerve, dspk_nerve),
    }
    if max(validation["fdi38_resample_error_mm"], validation["nerve_resample_error_mm"],
           validation["fdi38_source_to_3dgs_mm"], validation["nerve_source_to_3dgs_mm"]) >= 1.0:
        raise SystemExit(f"coordinate validation failed: {validation}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
            gz.write(hu_raw)
            gz.write(mask_raw)

    meta = {
        "format": "dentsplat-mpr-v1",
        "case": "DentVoxel v4 case 0095",
        "dims": [nx, ny, nz],
        "bbox_min_mm": [round(float(v), 5) for v in bbox_min],
        "bbox_max_mm": [round(float(v), 5) for v in bbox_max],
        "spacing_mm": [round(float(v), 6) for v in spacing],
        "hu_window": [args.hu_min, args.hu_max],
        "byteOffsets": {"hu": 0, "mask": len(hu_raw)},
        "byteLengths": {"hu": len(hu_raw), "mask": len(mask_raw)},
        "mask": {"packed": True, "bits": 4, "order": "low-nibble-even, high-nibble-odd", "codes": {"0": "background", "1": "teeth", "2": "bone", "3": "nerve", "4": "sinus"}},
        "transform": {"ras_to_gltf": RAS_TO_GLTF.tolist(), "center_yup_mm": center.tolist(), "source_affine": aff.tolist()},
        "source": {"image": args.image, "labels": args.labels, "dims": list(hu.shape), "spacing_mm": [float(x) for x in image.header.get_zooms()[:3]]},
        "validation": validation,
        "generator": "pipeline/build_mpr_volume.py",
    }
    Path(args.meta).write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out_path), "bytes": out_path.stat().st_size, "meta": str(args.meta), "dims": dims,
                      "spacing_mm": meta["spacing_mm"], "bbox_min_mm": meta["bbox_min_mm"], "bbox_max_mm": meta["bbox_max_mm"],
                      "hu_bytes": len(hu_raw), "mask_bytes": len(mask_raw), "validation": validation}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
