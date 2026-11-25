"""make_tf3_fixture.py -- synthesise a ToothFairy3-shaped CBCT pair (labels + intensity) so the
Scene B route can be *executed* rather than merely reviewed.

This is a TEST FIXTURE, not data. It carries no relationship to any patient and must never be
presented as a real ToothFairy3 case -- its only purpose is to exercise the label map, the RAS ->
Y-up transform, the HU windowing and the row-alignment assertions of toothfairy2_to_layers.py
against a volume whose ground truth we know analytically (every voxel's intended class is recorded
in the manifest it writes here next to the NIfTIs).

    python tools/make_tf3_fixture.py --out /tmp/tf3
    python pipeline/toothfairy2_to_layers.py --labels_nii /tmp/tf3/case.nii.gz \
        --image_nii /tmp/tf3/case_0000.nii.gz --out_dir /tmp/tf3/web_assets --spacing_mm 1.0

Coordinate convention of the fixture: identity affine, 1 mm isotropic, RAS+, arch centred on the
volume centre, occlusal plane at z = cz. RAS+ names its axes in order, so +x is the patient's RIGHT,
+y anterior, +z superior -- which is why quadrant 1 and 4 (the right-side teeth) get sx = +1 here and
why the converter's (-x, z, y) rule must land them at -X, the same side FDI_11 sits on in the shipped
Scene A packet.
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

import nibabel as nib

# FDI layout: quadrant -> (sx, sz) in RAS voxels.
# RAS+: +x = anatomical RIGHT, -x = left, +y = anterior, +z = superior.
QUADRANTS = {1: (+1, +1), 2: (-1, +1), 3: (-1, -1), 4: (+1, -1)}  # sx, sz


def fdi_pos(fdi: int, n_teeth: int = 8) -> tuple[float, float, float]:
    q, i = divmod(fdi, 10)
    sx, sz = QUADRANTS[q]
    # Central incisors must NOT sit exactly on the midline: with ang = 0 for i = 1, FDI 11 and FDI 21
    # (and 31/41) land on the same voxel column, and the later quadrant overwrites the earlier one --
    # which is exactly how the first version of this fixture lost teeth 11 and 31 while still passing
    # its own "blob inside the volume" guard. Starting at 0.15 rad puts the pair ~5 mm either side of
    # the midline (10 mm apart, 2 mm of clear space between 4 mm-radius crowns) and keeps 18 deg
    # spacing out to the third molar.
    ang = 0.15 + (i - 1) * ((np.pi / 2) - 0.15) / (n_teeth - 1)
    a, b = 34.0, 40.0                      # mediolateral / anteroposterior radii, mm
    x = sx * a * np.sin(ang)
    y = b * np.cos(ang)
    return float(x), float(y), float(sz * 22.0)


def blob(vol: np.ndarray, c, r, value: int, z_scale=None) -> None:
    """Paint an ellipsoid of class `value` at centre c (mm) with radii r (mm)."""
    zz = r[2] if z_scale is None else z_scale
    sh = vol.shape
    xs = np.arange(int(c[0] - r[0]), int(c[0] + r[0]) + 1)
    ys = np.arange(int(c[1] - r[1]), int(c[1] + r[1]) + 1)
    zs = np.arange(int(c[2] - zz), int(c[2] + zz) + 1)
    xs = xs[(xs >= 0) & (xs < sh[0])]
    ys = ys[(ys >= 0) & (ys < sh[1])]
    zs = zs[(zs >= 0) & (zs < sh[2])]
    if not len(xs) or not len(ys) or not len(zs):
        raise RuntimeError(f"blob at {c} falls outside the volume -- fixture geometry is wrong")
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    e = (((X - c[0]) / r[0]) ** 2 + ((Y - c[1]) / r[1]) ** 2 + ((Z - c[2]) / zz) ** 2) <= 1.0
    vol[X[e], Y[e], Z[e]] = value


def build(out_dir: str, rng: np.random.Generator) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    lab = np.zeros((110, 120, 100), dtype=np.uint8)
    img = np.full(lab.shape, -1000.0, dtype=np.float32)
    cx, cy, cz = 55.0, 55.0, 50.0            # volume centre; occlusal plane sits at z = cz

    def pos(fdi):
        x, y, z = fdi_pos(fdi)
        return (cx + x, cy + y, cz + z)

    all_fdi = [q * 10 + i for q in (1, 2, 3, 4) for i in range(1, 9)]
    # Jawbone: an arch band per jaw (tf3 ids 1 = mandible, 2 = maxilla).
    for q, bone in ((1, 2), (2, 2), (3, 1), (4, 1)):
        for i in range(1, 9):
            x, y, z = pos(q * 10 + i)
            blob(lab, (x, y, cz + (z - cz) * 0.55), (7.0, 7.0, abs(z - cz) * 0.75), bone)
    # Teeth 11..48 (one label per tooth, crown AND root -- exactly the honest caveat in NOTES.md).
    for fdi in all_fdi:
        x, y, z = pos(fdi)
        blob(lab, (x, y, z), (4.0, 4.5, 8.0), fdi)
        # Pulp cavity = FDI + 100, the trick that makes root-canal highlighting free.
        blob(lab, (x, y, z), (1.6, 1.8, 6.0), fdi + 100)
    # Inferior alveolar canals (3 = left, 4 = right) plus incisive (103 left / 104 right) and lingual 105.
    for side, idn in ((+1, 4), (-1, 3)):
        for t in np.linspace(0, 1, 40):
            y = cy + 34.0 - 62.0 * t
            blob(lab, (cx + side * 20.0, y, cz - 20.0), (1.6, 3.0, 1.6), idn)
    blob(lab, (cx + 12.0, cy + 26.0, cz - 18.0), (2.0, 2.0, 2.0), 104)   # right
    blob(lab, (cx - 12.0, cy + 26.0, cz - 18.0), (2.0, 2.0, 2.0), 103)   # left
    blob(lab, (cx, cy - 12.0, cz - 8.0), (2.0, 2.0, 2.0), 105)
    # Maxillary sinuses (5 left / 6 right) and a couple of restorations (8 bridge, 9 crown, 10 implant).
    blob(lab, (cx - 22.0, cy - 10.0, cz + 24.0), (9.0, 12.0, 9.0), 5)    # left
    blob(lab, (cx + 22.0, cy - 10.0, cz + 24.0), (9.0, 12.0, 9.0), 6)    # right
    for fdi, val in ((16, 9), (46, 10), (24, 8)):
        x, y, z = pos(fdi)
        blob(lab, (x, y, z + (6.0 if z > cz else -6.0)), (3.0, 3.5, 3.0), val)

    # Intensity: HU per class, so the windowing paths have something real to clip against.
    hu = {0: -1000.0, 1: 320.0, 2: 340.0, 3: -180.0, 4: -170.0, 5: -950.0, 6: -940.0,
          8: 1800.0, 9: 2400.0, 10: 3000.0, 103: -190.0, 104: -190.0, 105: -200.0}
    for fdi in all_fdi:
        hu[fdi] = 2900.0
        hu[fdi + 100] = -40.0                     # pulp is soft tissue inside the tooth
    for k, v in hu.items():
        img[lab == k] = v
    img += rng.normal(0, 45.0, lab.shape).astype(np.float32) * (lab > 0)

    aff = np.eye(4)
    nib.save(nib.Nifti1Image(lab, aff), os.path.join(out_dir, "case.nii.gz"))
    nib.save(nib.Nifti1Image(img, aff), os.path.join(out_dir, "case_0000.nii.gz"))
    counts = {int(k): int(v) for k, v in zip(*np.unique(lab, return_counts=True)) if k}
    # A fixture that silently loses a tooth is worse than no fixture: every downstream "32 FDI ids
    # present" check would be reading a number that was never actually painted.
    missing = [f for f in all_fdi if counts.get(f, 0) < 40]
    missing_pulp = [f + 100 for f in all_fdi if counts.get(f + 100, 0) < 5]
    if missing or missing_pulp:
        raise RuntimeError(f"fixture lost labels -> teeth {missing} pulp {missing_pulp} "
                           f"(min voxel counts 40 / 5); geometry collides")
    truth = {"voxel_size_mm": [1.0, 1.0, 1.0], "affine": "identity", "n_labels": len(counts),
             "label_voxel_counts": counts,
             "min_teeth_voxels": min(counts.get(f, 0) for f in all_fdi),
             "expect": {"teeth_ids": all_fdi, "pulp_ids": [f + 100 for f in all_fdi]}}
    with open(os.path.join(out_dir, "fixture_truth.json"), "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=2)
    return truth


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/tf3")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    t = build(a.out, np.random.default_rng(a.seed))
    print(f"wrote {a.out}/case.nii.gz + case_0000.nii.gz  ({t['n_labels']} distinct labels)")
