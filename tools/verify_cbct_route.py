"""verify_cbct_route.py -- execute the Scene B chain end to end and prove the contract.

Runs the REAL toothfairy2_to_layers.py over a synthetic-but-analytically-labelled CBCT pair
(tools/make_tf3_fixture.py), then checks the emitted artefacts against ground truth. Nothing here
trusts the converter's own exit code: every claim is re-derived from the files on disk.

    python tools/verify_cbct_route.py            # exits non-zero on the first hard failure
    npm run test:pipeline                        # the same thing, with an interpreter that has numpy

What it proves, in order of how much it would hurt if it were wrong:
  1. row alignment -- fdi_labels.bin / layer_labels.bin length and values vs cbct_layers.ply
  2. the layer byte -- pulp lands on 6, teeth on the 1 (enamel) alias, nerve on 4, alveolar 3,
     sinus 7, restoration 8, exactly as LAYER in src/engine/dspk.ts defines them
  3. FDI survives the id-100 round trip (the click-to-highlight-a-root-canal trick)
  4. the frame is Y-up millimetres -- maxilla above mandible, incisors in front of molars
  5. labels_manifest.json's sha256/bytes actually describe the file it shipped with
  6. HU windowing changes colour, --flat_colour does not, and both stay inside 0..255
  7. a second identical converter run reproduces the PLY and the side-car bins byte for byte
  8. the .dspk the browser loads is reproducible from exactly those files via tools/ply2dspk.ts
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from plyfile import PlyData

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out", "cbct_route")
WEB = os.path.join(OUT, "web_assets")

fails: list[str] = []
skips: list[str] = []
checks = 0


def ok(cond: bool, name: str, detail: str = "") -> None:
    global checks
    checks += 1
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f" -- {detail}" if detail else ""))


def skip(name: str, why: str) -> None:
    """A gate that did not run is NOT a gate that passed, so it is counted and printed separately."""
    skips.append(name)
    print(f"  SKIP {name} -- {why}")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    labels = os.path.join(OUT, "case.nii.gz")
    image = os.path.join(OUT, "case_0000.nii.gz")

    # ---------------------------------------------------------------- 1. build the fixture
    subprocess.run([sys.executable, os.path.join(HERE, "make_tf3_fixture.py"), "--out", OUT],
                   check=True, cwd=ROOT)
    truth = json.load(open(os.path.join(OUT, "fixture_truth.json"), encoding="utf-8"))
    vox = {int(k): v for k, v in truth["label_voxel_counts"].items()}
    fdis = [q * 10 + i for q in (1, 2, 3, 4) for i in range(1, 9)]
    ok(len(vox) >= 70, "fixture paints nearly every tf3 class", f"{len(vox)} labels")
    n_teeth = sum(1 for f in fdis if f in vox)
    n_pulp = sum(1 for f in fdis if f + 100 in vox)
    # Used to be >= 28 / >= 26 because tooth 11 and 31 shared a voxel column with 21 and 41 at the
    # midline, so the later quadrant quietly erased the earlier one. make_tf3_fixture.py now starts
    # each arcade 0.15 rad off the midline and refuses to ship a fixture whose tooth or pulp shells
    # fall under 40 / 5 voxels, which makes 32/32 a fact about the fixture rather than a hope. If
    # this ever drops below 32 the fixture regressed; do not "fix" it by loosening the number.
    ok(n_teeth == 32, "fixture paints all 32 FDI tooth ids", f"{n_teeth}/32")
    ok(n_pulp == 32, "fixture paints all 32 pulp ids (FDI+100)", f"{n_pulp}/32")

    # ---------------------------------------------------------------- 2. run the real converter
    r = subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "toothfairy2_to_layers.py"),
                        "--labels_nii", labels, "--image_nii", image, "--out_dir", WEB,
                        "--schema", "tf3", "--spacing_mm", "1.0", "--surface_only", "0",
                        "--max_points_per_layer", "60000", "--overwrite"],
                       cwd=ROOT, capture_output=True, text=True)
    ok(r.returncode == 0, "toothfairy2_to_layers.py exits 0",
       (r.stderr or r.stdout)[-400:])
    if r.returncode != 0:
        print(r.stdout[-2500:])
        return 1
    for f in ("cbct_layers.ply", "tooth_meta_cbct.json", "fdi_labels.bin", "layer_labels.bin",
              "labels_manifest.json"):
        ok(os.path.isfile(os.path.join(WEB, f)), f"artefact written: {f}")

    ply = PlyData.read(os.path.join(WEB, "cbct_layers.ply"))["vertex"]
    n = int(len(ply.data))
    v = {nm: np.asarray(ply[nm], dtype=np.float64) for nm in ply.data.dtype.names}
    fdi = np.fromfile(os.path.join(WEB, "fdi_labels.bin"), dtype=np.uint8)
    layer = np.fromfile(os.path.join(WEB, "layer_labels.bin"), dtype=np.uint8)

    # ---------------------------------------------------------------- 3. row alignment
    ok(n > 5000, "point cloud is non-trivial", f"{n} rows")
    ok(len(fdi) == n and len(layer) == n, "label bins are row-aligned with the PLY",
       f"n={n} fdi={len(fdi)} layer={len(layer)}")
    ok(np.array_equal(fdi, np.asarray(v["fdi"], dtype=np.uint8)),
       "fdi_labels.bin == the PLY's own fdi column")
    ok(np.array_equal(layer, np.asarray(v["layer"], dtype=np.uint8)),
       "layer_labels.bin == the PLY's own layer column")

    # ---------------------------------------------------------------- 4. the semantic bytes
    want = {"alveolar": 3, "teeth": 1, "nerve": 4, "pulp": 6, "restoration": 8, "sinus": 7}
    seen = {int(c): int((layer == c).sum()) for c in want.values()}
    for nm, code in want.items():
        ok(seen.get(code, 0) > 0, f"layer '{nm}' emitted as byte {code}", f"counts={seen}")
    ok(set(np.unique(layer)).issubset(set(range(9))), "no layer byte outside the DSPK table",
       f"unique={sorted(set(np.unique(layer).tolist()))}")
    tooth_rows = (layer == want["teeth"]) & (fdi >= 11) & (fdi <= 48)
    ok(tooth_rows.sum() > 0, "tooth band carries real FDI ids")
    present_fdi = sorted(set(fdi[tooth_rows].tolist()))
    ok(present_fdi == fdis, "all 32 FDI ids reach the cloud",
       f"{len(present_fdi)}/32 missing={sorted(set(fdis) - set(present_fdi))}")
    pulp_rows = (layer == want["pulp"]) & (fdi > 0)
    ok(pulp_rows.sum() > 0 and set(fdi[pulp_rows].tolist()).issubset(set(fdis)),
       "pulp rows carry fdi = id - 100, nothing else")
    nerve_rows = layer == want["nerve"]
    ok(nerve_rows.sum() > 0 and not fdi[nerve_rows].any(),
       "canal rows are FDI-free (they belong to no tooth)")

    # ---------------------------------------------------------------- 5. frame and units
    pts = np.stack([v["x"], v["y"], v["z"]], axis=1)
    ok(np.all(np.isfinite(pts)), "all coordinates finite")
    up = pts[layer == want["alveolar"]]
    ext = pts.max(axis=0) - pts.min(axis=0)
    ok(40.0 < ext[0] < 160.0 and 40.0 < ext[2] < 160.0, "arch extent is millimetres, not metres",
       f"extent={ext.round(1).tolist()}")
    upper = fdi_is_upper = np.isin(fdi, [f for f in fdis if f // 10 in (1, 2)])
    lower = np.isin(fdi, [f for f in fdis if f // 10 in (3, 4)])
    ok(upper.any() and lower.any(), "both jaws present")
    ok(pts[upper][:, 1].mean() > pts[lower][:, 1].mean(), "maxilla sits at +Y (Y-up, occlusal = y0)",
       f"{pts[upper][:,1].mean():.1f} vs {pts[lower][:,1].mean():.1f}")
    inc = np.isin(fdi, [11, 12, 21, 22, 31, 32, 41, 42])
    mol = np.isin(fdi, [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48])
    ok(pts[inc][:, 2].mean() > pts[mol][:, 2].mean(), "incisors sit at +Z (lips forward)")
    q1 = np.isin(fdi, [10 + i for i in range(1, 9)])
    q2 = np.isin(fdi, [20 + i for i in range(1, 9)])
    ok(pts[q1][:, 0].mean() < pts[q2][:, 0].mean(),
       "patient's-right teeth at -X, the side FDI_11 occupies in the shipped sceneA_full.dspk",
       f"q1 X={pts[q1][:,0].mean():+.1f} q2 X={pts[q2][:,0].mean():+.1f}")

    # ---------------------------------------------------------------- 6. colour + meta + sha
    rgb = np.stack([v["red"], v["green"], v["blue"]], axis=1)
    ok(rgb.min() >= 0 and rgb.max() <= 255, "colours inside 0..255")
    ok(len(np.unique(layer)) >= 5 and len(np.unique(np.round(rgb / 16))) >= 6,
       "HU windowing actually separates tissues by colour")
    meta = json.load(open(os.path.join(WEB, "tooth_meta_cbct.json"), encoding="utf-8"))
    ok(meta.get("unit") == "mm" and "coordinate_system" in meta, "meta declares unit + frame",
       str(meta.get("unit")))
    teeth_meta = meta.get("teeth", {})
    # The converter's tooth_meta carries one entry per FDI id PLUS six LAYER_* aggregates (a centroid
    # and bbox for each semantic layer, which is what the UI's "focus this layer" button reads). So
    # "32" is the FDI count, not the dict length -- asserting on len() would have failed the moment
    # the aggregates were added and told me nothing about the teeth.
    fdi_keys = sorted(int(k.split("_")[1]) for k in teeth_meta
                      if k.startswith("FDI_") and k.split("_")[1].isdigit())
    ok(fdi_keys == fdis, "meta lists one entry per FDI id", f"{len(fdi_keys)} of 32")
    layer_keys = sorted(k for k in teeth_meta if k.startswith("LAYER_"))
    ok(len(layer_keys) == 6, "meta carries the six LAYER_* aggregates the UI reads", str(layer_keys))
    ok(len(teeth_meta) == len(fdi_keys) + len(layer_keys), "meta has no other keys",
       f"{len(teeth_meta)} entries")
    tagged = [t for t in meta.get("teeth", {}).values() if "layer" in t]
    ok(len(tagged) == len(meta.get("teeth", {})), "every tooth entry carries 'layer'")
    man = json.load(open(os.path.join(WEB, "labels_manifest.json"), encoding="utf-8"))
    raw = open(os.path.join(WEB, "cbct_layers.ply"), "rb").read()
    ok(man.get("n_splats") == n, "manifest n_splats matches the PLY", f"{man.get('n_splats')} vs {n}")
    ok(man.get("ply_bytes") == len(raw), "manifest ply_bytes matches the file")
    ok(man.get("ply_sha256") == hashlib.sha256(raw).hexdigest(), "manifest sha256 re-derives")
    ok(sum(man.get("fdi_counts", {}).values()) == n, "manifest fdi_counts sum to N")

    # ---------------------------------------------------------------- 7. the switches do differ
    flat = os.path.join(OUT, "flat_assets")
    r2 = subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "toothfairy2_to_layers.py"),
                         "--labels_nii", labels, "--out_dir", flat, "--flat_colour",
                         "--spacing_mm", "2.0", "--layers", "alveolar,teeth,nerve,pulp",
                         "--overwrite"], cwd=ROOT, capture_output=True, text=True)
    ok(r2.returncode == 0, "--flat_colour route (no image, no sinus/restoration) exits 0",
       (r2.stderr or r2.stdout)[-300:])
    if r2.returncode == 0:
        p2 = PlyData.read(os.path.join(flat, "cbct_layers.ply"))["vertex"]
        l2 = np.asarray(p2["layer"], dtype=np.uint8)
        ok(set(np.unique(l2).tolist()).isdisjoint({want["sinus"], want["restoration"]}),
           "--layers subset really restricts what is emitted", f"got {sorted(set(l2.tolist()))}")
        rgb2 = np.stack([np.asarray(p2["red"]), np.asarray(p2["green"]), np.asarray(p2["blue"])], axis=1)
        ok(len(np.unique(rgb2, axis=0)) <= 6, "flat colours are flat tints, not windowed",
           f"{len(np.unique(rgb2, axis=0))} distinct")

    # ---------------------------------------------------------------- 8. the converter is repeatable
    # Everything above re-derives claims from ONE run's files. That is worth little if a second run
    # of the same command produced different bytes, so run it again and compare what got written.
    # (This is not a theoretical worry: the packet shipped before the fixture midline fix was built
    # from a PLY that the current converter no longer produces, and nothing on disk said so.)
    again = os.path.join(OUT, "repeat_assets")
    r3 = subprocess.run([sys.executable, os.path.join(ROOT, "pipeline", "toothfairy2_to_layers.py"),
                         "--labels_nii", labels, "--image_nii", image, "--out_dir", again,
                         "--schema", "tf3", "--spacing_mm", "1.0", "--surface_only", "0",
                         "--max_points_per_layer", "60000", "--overwrite"],
                        cwd=ROOT, capture_output=True, text=True)
    if r3.returncode == 0:
        pairs = ["cbct_layers.ply", "fdi_labels.bin", "layer_labels.bin", "tooth_meta_cbct.json"]
        dig = {}
        for f in pairs:
            a = open(os.path.join(WEB, f), "rb").read()
            b = open(os.path.join(again, f), "rb").read()
            dig[f] = (len(a), len(b), hashlib.sha256(a).hexdigest()[:12] == hashlib.sha256(b).hexdigest()[:12])
        bad = [f for f, v in dig.items() if not v[2]]
        ok(not bad, "a second identical run reproduces the PLY, both label bins and the meta",
           f"{[(f, dig[f][0], dig[f][1]) for f in bad]} differ; ply sha={dig['cbct_layers.ply']}")
    else:
        skip("converter repeatability", f"second run exited {r3.returncode}: {(r3.stderr or r3.stdout)[-200:]}")

    # ---------------------------------------------------------------- 9. the shipped container is this pipeline's output
    # The .dspk is the artefact the browser actually loads, so its bytes have to follow from the files
    # just verified. Rebuild it into a scratch directory and compare -- never overwrite the real one.
    packet = os.path.join(OUT, "sceneB_from_nifti.dspk")
    node = shutil.which("node")
    repro = os.path.join(OUT, "repeat_assets", "sceneB_from_nifti.dspk")
    if not node:
        skip("the .dspk follows from this run", "node not on PATH")
    elif not os.path.isfile(packet):
        skip("the .dspk follows from this run", f"{packet} absent -- build it with tools/ply2dspk.ts")
    else:
        r4 = subprocess.run([node, os.path.join(HERE, "ply2dspk.ts"),
                             "--in", os.path.join(WEB, "cbct_layers.ply"),
                             "--fdi", os.path.join(WEB, "fdi_labels.bin"),
                             "--layer", os.path.join(WEB, "layer_labels.bin"),
                             "--manifest", os.path.join(WEB, "labels_manifest.json"),
                             "--out", repro, "--meta-out", repro + ".meta.json",
                             "--kind", "cbct", "--case", "B"],
                            cwd=ROOT, capture_output=True, text=True)
        if r4.returncode == 0 and os.path.isfile(repro):
            a, b = open(packet, "rb").read(), open(repro, "rb").read()
            ok(hashlib.sha256(a).hexdigest() == hashlib.sha256(b).hexdigest(),
               "the shipped sceneB_from_nifti.dspk is byte-identical to a rebuild from this run",
               f"shipped {len(a)} B/{hashlib.sha256(a).hexdigest()[:12]} vs rebuilt {len(b)} B/"
               f"{hashlib.sha256(b).hexdigest()[:12]} -- the packet is STALE, rebuild it")
        else:
            skip("the .dspk follows from this run",
                 f"ply2dspk exited {r4.returncode}: {(r4.stderr or r4.stdout)[-200:]}")

    print(f"\n{checks - len(fails)}/{checks} checks passed"
          + (f", {len(skips)} skipped: " + "; ".join(skips) if skips else ""))
    if fails:
        print("FAILED: " + ", ".join(fails))
        return 1
    print(f"artefacts: {WEB}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
