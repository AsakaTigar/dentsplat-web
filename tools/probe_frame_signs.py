"""Probe: does the emitted CBCT cloud put the maxilla above the mandible, and the incisors in front?

Reads tools/out/cbct_route/web_assets/{cbct_layers.ply,tooth_meta_cbct.json} produced by
tools/verify_cbct_route.py and prints the frame facts the web app depends on. Run with
    python tools/probe_frame_signs.py [path/to/web_assets]
"""
import json
import os
import sys

import numpy as np
from plyfile import PlyData

web = sys.argv[1] if len(sys.argv) > 1 else os.path.join("tools", "out", "cbct_route", "web_assets")
v = PlyData.read(os.path.join(web, "cbct_layers.ply"))["vertex"].data
xyz = np.stack([np.asarray(v["x"], float), np.asarray(v["y"], float), np.asarray(v["z"], float)], 1)
fdi = np.asarray(v["fdi"], np.int64)
layer = np.asarray(v["layer"], np.int64)
meta = json.load(open(os.path.join(web, "tooth_meta_cbct.json"), encoding="utf-8"))

print(f"rows={len(xyz)}  extent_mm={[round(x, 1) for x in (xyz.max(0) - xyz.min(0))]}")
print(f"mean Y by FDI quadrant: " + "  ".join(
    f"q{q}={xyz[np.isin(fdi, [q * 10 + i for i in range(1, 9)])][:, 1].mean():+.1f}"
    for q in (1, 2, 3, 4) if np.isin(fdi, [q * 10 + i for i in range(1, 9)]).any()))
print("mean Y by jawbone layer code 3 (alveolar): "
      f"{xyz[layer == 3][:, 1].mean():+.1f}   teeth code 1: {xyz[layer == 1][:, 1].mean():+.1f}")
inc = np.isin(fdi, [11, 12, 21, 22, 31, 32, 41, 42])
mol = np.isin(fdi, [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48])
print(f"incisor mean Z={xyz[inc][:, 2].mean():+.1f}  molar mean Z={xyz[mol][:, 2].mean():+.1f}")
print(f"quadrant-1 (upper RIGHT) mean X={xyz[np.isin(fdi, [10 + i for i in range(1, 9)])][:, 0].mean():+.1f}"
      f"   quadrant-2 (upper LEFT) mean X={xyz[np.isin(fdi, [20 + i for i in range(1, 9)])][:, 0].mean():+.1f}")
cent = {k: t.get("centroid_mm") for k, t in list(meta.get("teeth", {}).items())[:4]}
print("meta centroids sample:", cent)
print("meta arch_extent_mm:", meta.get("arch_extent_mm"), " unit:", meta.get("unit"),
      " cs:", meta.get("coordinate_system"))
