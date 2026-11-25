#!/usr/bin/env python3
"""dentvoxel_to_tf3.py -- map DentVoxel v4 label ids into the ToothFairy3 id space.

DentVoxel and ToothFairy3 describe the same anatomy with different numbers: DentVoxel calls the
teeth by their FDI value directly (ids 3..34 -> FDI 11..48), while toothfairy2_to_layers.py expects
FDI ids 11..48 plus its own canal/sinus ids. Rather than fork the converter, this rewrites the label
volume once:

    DentVoxel                          ToothFairy3 id space
    1 maxilla, 2 mandible          ->  1, 2            (alveolar in the converter)
    3..34 teeth                    ->  FDI 11..48      (the ids the converter's keep_raw_fdi reads)
    35,36 mandibular canals        ->  3               (IAN)
    37,38 maxillary sinuses        ->  5
    0 background                   ->  0

    python pipeline/dentvoxel_to_tf3.py --labels_nii label0095.nii.gz --out tools/out/data/labels_tf3_0095.nii.gz
    python pipeline/dentvoxel_to_tf3.py --selftest
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

import numpy as np

try:
    import nibabel as nib
except ImportError:  # pragma: no cover
    sys.exit("FATAL: nibabel is required (pip install nibabel)")

LUT_SIZE = 64


def build_lut() -> np.ndarray:
    lut = np.zeros(LUT_SIZE, dtype=np.int16)
    lut[1] = 1
    lut[2] = 2
    for src, dst in zip(range(3, 11), range(11, 19)):
        lut[src] = dst
    for src, dst in zip(range(11, 19), range(21, 29)):
        lut[src] = dst
    for src, dst in zip(range(19, 27), range(31, 39)):
        lut[src] = dst
    for src, dst in zip(range(27, 35), range(41, 49)):
        lut[src] = dst
    lut[35] = lut[36] = 3          # mandibular canals -> IAN
    lut[37] = lut[38] = 5          # maxillary sinuses
    return lut


def remap(seg: np.ndarray, lut: np.ndarray) -> np.ndarray:
    if seg.max() >= LUT_SIZE:
        raise SystemExit(f"FATAL: label {int(seg.max())} outside the DentVoxel table (0..38)")
    return np.take(lut, seg.astype(np.int16, copy=False))


def selftest() -> None:
    lut = build_lut()
    ids = np.arange(0, 39, dtype=np.int16)
    out = remap(ids, lut)
    expect = np.array([0, 1, 2] + list(range(11, 19)) + list(range(21, 29))
                      + list(range(31, 39)) + list(range(41, 49)) + [3, 3, 5, 5], dtype=np.int16)
    assert np.array_equal(out, expect), list(zip(ids.tolist(), out.tolist()))
    assert sorted(set(out.tolist()) - {0}) == sorted(set(expect.tolist()) - {0})
    print(f"selftest ok: 39 ids mapped, teeth {sorted(set(out.tolist()) & set(range(11, 49)))}")


def main() -> None:
    ap = argparse.ArgumentParser(description="DentVoxel label ids -> ToothFairy3 id space")
    ap.add_argument("--labels_nii")
    ap.add_argument("--out")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.labels_nii or not args.out:
        sys.exit("FATAL: --labels_nii and --out are required (or --selftest)")

    img = nib.load(args.labels_nii)
    seg = np.asarray(img.dataobj)
    if seg.ndim == 4:
        seg = seg[..., 0]
    lut = build_lut()
    out = remap(seg, lut)
    header = img.header.copy()
    header.set_data_dtype(np.int16)
    nib.save(nib.Nifti1Image(out.astype(np.int16), img.affine, header), args.out)

    old = Counter(int(v) for v in np.unique(seg))
    new = Counter(int(v) for v in np.unique(out))
    print(json.dumps({
        "out": args.out,
        "affine_matches_source": bool(np.allclose(nib.load(args.out).affine, img.affine)),
        "dentvoxel_ids": sorted(old),
        "tf3_ids": sorted(new),
        "teeth_fdi": sorted(v for v in new if 11 <= v <= 48),
        "canal_ids": sorted(v for v in new if v == 3),
        "sinus_ids": sorted(v for v in new if v == 5),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
