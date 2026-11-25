#!/usr/bin/env python3
"""cbct_surfel.py -- turn a labelled CBCT volume into oriented surfel Gaussians.

The voxel-centre sampler (toothfairy2_to_layers.py) gives isotropic blobs: 100% of them classified
"isotropic" by tools/analyze_gaussians.mjs, 49% under-covered, and 67% of the budget spent on bone.
This route instead extracts the real surface of each semantic layer with marching cubes, samples it
per layer with a clinically weighted budget, orients every primitive to the surface normal and bakes a
three-point light, a crease-aware AO and SH1 sheen, so the packet is made of flat surfels that sit on
the surface.

Sampling is Poisson-thinned (no clumps, no holes): the tangential sigma is then set to rho * measured
mean k=6 neighbour distance, so the audit's coverage ratio lands in the 1.0-1.2 band by construction
instead of by hand-tuning. Every splat also carries its real FDI, read back from the label volume a
little inside the surface, so the .dspk gets fdi_labels.bin / layer_labels.bin side-cars that
tools/ply2dspk.ts verifies against labels_manifest.json.

    python pipeline/cbct_surfel.py --labels_nii tools/out/data/labels_tf3_0095.nii.gz \
        --frame_json tools/out/dentvoxel0095/frame_cbct.json \
        --out tools/out/dentvoxel0095/surfel.ply \
        --budget teeth=65000,nerve=8000,bone=30000,sinus=8000 --rho 1.05

Writes a standard 3DGS .ply (f_dc, f_rest, opacity, scale_*, rot_*) for tools/ply2dspk.ts, plus the
label side-cars and their manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

import numpy as np

try:
    import nibabel as nib
    from scipy.spatial import cKDTree
    from skimage import measure
except ImportError:  # pragma: no cover
    sys.exit("FATAL: nibabel, scipy and scikit-image are required")

RAS_TO_GLTF = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
LAYER_IDS = {
    "teeth": list(range(11, 49)),
    "bone": [1, 2],
    "nerve": [3],
    "sinus": [5],
}
# semantic layer byte used by the web viewer (src/data/cases.ts CBCT_LAYERS)
LAYER_BYTE = {"teeth": 1, "bone": 3, "nerve": 4, "sinus": 7}
BASE_RGB = {
    "teeth": (0.97, 0.91, 0.79),
    "bone": (0.78, 0.67, 0.50),
    "nerve": (0.97, 0.79, 0.16),
    "sinus": (0.55, 0.72, 0.85),
}
ALPHA = {"teeth": 0.96, "bone": 0.20, "nerve": 0.97, "sinus": 0.16}
SHEEN = {"teeth": 1.4, "bone": 0.7, "nerve": 0.9, "sinus": 0.6}


def smooth_vertices(v: np.ndarray, f: np.ndarray, iters: int = 2, lam: float = 0.5) -> np.ndarray:
    """Two Laplacian passes are enough to take the voxel staircase off a marching-cubes surface."""
    n = len(v)
    i = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    j = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    ii = np.concatenate([i, j])
    jj = np.concatenate([j, i])
    cnt = np.maximum(np.bincount(ii, minlength=n).astype(np.float64), 1.0)
    for _ in range(iters):
        acc = np.zeros_like(v)
        np.add.at(acc, ii, v[jj])
        v = v + lam * (acc / cnt[:, None] - v)
    return v


def vertex_normals(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    n = np.zeros_like(v)
    tri = v[f]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


def vertex_ao(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    """Crease-aware AO: the Laplacian magnitude over the mean edge length is a cheap mean curvature."""
    lap = smooth_vertices(v, f, iters=1, lam=1.0) - v
    edge = np.linalg.norm(v[f[:, 0]] - v[f[:, 1]], axis=1)
    l = max(float(np.median(edge)), 1e-9)
    curv = np.linalg.norm(lap, axis=1) / l
    ao = np.exp(-2.0 * np.clip(curv - 0.18, 0.0, None))
    return np.clip(ao, 0.35, 1.0)


def quat_from_z_to(n: np.ndarray) -> np.ndarray:
    """Rotation (w, x, y, z) taking the local +Z axis to n, per row."""
    z = np.array([0.0, 0.0, 1.0])
    d = n @ z
    crossv = np.cross(np.broadcast_to(z, n.shape), n)
    w = 1.0 + d
    q = np.concatenate([w[:, None], crossv], axis=1)
    flip = d < -0.999999
    q[flip] = np.array([0.0, 1.0, 0.0, 0.0])
    ln = np.linalg.norm(q, axis=1, keepdims=True)
    return q / np.maximum(ln, 1e-12)


def poisson_thin(pts: np.ndarray, r_min: float, target: int, rng) -> np.ndarray:
    """Random-sequential thinning: no two accepted centres closer than r_min, so no clumps and no
    holes. Returns indices into pts (at most target)."""
    cell = float(r_min)
    inv = 1.0 / cell
    grid: dict = {}
    accepted: list[int] = []
    r2 = r_min * r_min
    for idx in rng.permutation(len(pts)):
        p = pts[idx]
        cx, cy, cz = int(math.floor(p[0] * inv)), int(math.floor(p[1] * inv)), int(math.floor(p[2] * inv))
        ok = True
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    lst = grid.get((cx + dx, cy + dy, cz + dz))
                    if not lst:
                        continue
                    for q in lst:
                        d = p - q
                        if d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < r2:
                            ok = False
                            break
                    if not ok:
                        break
                if not ok:
                    break
            if not ok:
                break
        if ok:
            accepted.append(int(idx))
            grid.setdefault((cx, cy, cz), []).append(p)
            if len(accepted) >= target:
                break
    return np.asarray(accepted, dtype=np.int64)


def stratify(v: np.ndarray, f: np.ndarray, vn: np.ndarray, ao: np.ndarray, count: int,
             rng) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    tri = v[f]
    e1 = tri[:, 1] - tri[:, 0]
    e2 = tri[:, 2] - tri[:, 0]
    area = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
    p = area / max(area.sum(), 1e-12)
    # 4x oversample, then thin: a plain multinomial draw duplicates some triangles and skips others,
    # which is exactly the under/over split the audit flagged.
    raw = min(max(count * 4, count + 256), 4_000_000)
    pick = rng.choice(len(f), size=raw, p=p)
    r1 = np.sqrt(rng.random(raw))
    r2 = rng.random(raw)
    w0 = 1 - r1
    w1 = r1 * (1 - r2)
    w2 = r1 * r2
    pts = v[f[pick, 0]] * w0[:, None] + v[f[pick, 1]] * w1[:, None] + v[f[pick, 2]] * w2[:, None]
    nor = vn[f[pick, 0]] * w0[:, None] + vn[f[pick, 1]] * w1[:, None] + vn[f[pick, 2]] * w2[:, None]
    nor /= np.maximum(np.linalg.norm(nor, axis=1, keepdims=True), 1e-12)
    occ = ao[f[pick, 0]] * w0 + ao[f[pick, 1]] * w1 + ao[f[pick, 2]] * w2
    spacing = math.sqrt(float(area.sum()) / max(count, 1))
    keep_n = count
    for attempt in range(4):
        r_min = (0.70 if attempt == 0 else 0.62) * spacing * (1.0 - 0.08 * attempt)
        keep = poisson_thin(pts, r_min, count, rng)
        if len(keep) >= count:
            break
    # thinning ran dry: keep what it accepted (a few splats short of budget) rather than topping up
    # with near-duplicate candidates, which would encode 0.03 mm gaussians and read as under-covered.
    keep = keep[:count]
    return pts[keep], nor[keep], occ[keep], spacing


def knn6_means(pts: np.ndarray, k: int = 6) -> np.ndarray:
    tree = cKDTree(pts)
    d, _ = tree.query(pts, k=k + 1, workers=-1)
    return d[:, 1:].mean(axis=1)


def shade(nor: np.ndarray, base: np.ndarray, occ: np.ndarray) -> np.ndarray:
    key = np.array([0.35, 0.75, 0.55]); key /= np.linalg.norm(key)
    fill = np.array([-0.60, 0.15, 0.40]); fill /= np.linalg.norm(fill)
    ndl = np.maximum(nor @ key, 0.0)
    ndf = np.maximum(nor @ fill, 0.0)
    rim = np.clip(1.0 - np.abs(nor[:, 2]), 0.0, 1.0) ** 3
    lit = (0.22 + 0.52 * ndl + 0.14 * ndf + 0.06 * rim) * occ
    return np.clip(np.asarray(base)[None, :] * lit[:, None], 0.0, 1.0)


def write_inria_ply(path: str, xyz: np.ndarray, rgb: np.ndarray, alpha: np.ndarray,
                    scale: np.ndarray, quat: np.ndarray, sh1: np.ndarray) -> int:
    n = len(xyz)
    props = (["x", "y", "z"] + [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(9)]
             + ["opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)])
    head = ["ply", "format binary_little_endian 1.0", "comment DentSplat oriented surfels",
            f"element vertex {n}", *[f"property float {p}" for p in props], "end_header", ""]
    head = "\n".join(head)
    buf = np.zeros(n, dtype=[(p, "<f4") for p in props])
    buf["x"], buf["y"], buf["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    dc = (rgb - 0.5) / 0.28209479177387814
    for i in range(3):
        buf[f"f_dc_{i}"] = dc[:, i]
    for i in range(9):
        buf[f"f_rest_{i}"] = sh1[:, i]
    buf["opacity"] = np.log(np.clip(alpha, 1e-4, 1 - 1e-4) / (1 - np.clip(alpha, 1e-4, 1 - 1e-4)))
    for i in range(3):
        buf[f"scale_{i}"] = np.log(np.maximum(scale[:, i], 1e-5))
    for i in range(4):
        buf[f"rot_{i}"] = quat[:, i]
    with open(path, "wb") as fh:
        fh.write(head.encode("latin1"))
        buf.tofile(fh)
    return n


def readback_fdi(seg: np.ndarray, world: np.ndarray, nor: np.ndarray, aff: np.ndarray, zooms: np.ndarray,
                 centre: np.ndarray) -> np.ndarray:
    """Sample 0.45 mm inside the surface: marching-cubes vertices sit between the mask and the air,
    so the voxel under the surface itself may be background."""
    probe = world - 0.45 * nor
    ras = (probe + centre) @ RAS_TO_GLTF            # RAS_TO_GLTF is symmetric: inverse == itself
    vox = np.rint(nib.affines.apply_affine(np.linalg.inv(aff), ras)).astype(np.int64)
    shape = np.asarray(seg.shape)
    vox = np.clip(vox, 0, shape[None, :] - 1)
    lab = seg[vox[:, 0], vox[:, 1], vox[:, 2]].astype(np.uint8)
    valid = np.isin(lab, LAYER_IDS["teeth"])
    if not valid.all():
        # The root surface is bounded by alveolar bone, so a probe "inside" the tooth can land on the
        # bone label. Look for the nearest tooth voxel in a 5x5x5 window; if there is none the splat
        # gets FDI 0 (no tooth) rather than a bogus bone id that the odontogram would try to draw.
        bad = np.flatnonzero(~valid)
        shape = np.asarray(seg.shape)
        out = lab.copy()
        for i in bad:
            out[i] = 0
            x, y, z = vox[i]
            for r in (1, 2):
                lo = np.maximum([x, y, z], r) - r
                hi = np.minimum([x, y, z], shape - 1 - r) + r
                win = seg[lo[0]:hi[0] + 1, lo[1]:hi[1] + 1, lo[2]:hi[2] + 1]
                ids = win[np.isin(win, LAYER_IDS["teeth"])]
                if ids.size:
                    out[i] = np.bincount(ids.astype(np.int64)).argmax()
                    break
        lab = out
    return lab


def main() -> None:
    ap = argparse.ArgumentParser(description="CBCT labels -> oriented surfel 3DGS PLY")
    ap.add_argument("--labels_nii", required=True)
    ap.add_argument("--frame_json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--budget", default="teeth=65000,nerve=8000,bone=30000,sinus=8000")
    ap.add_argument("--rho", type=float, default=1.05,
                    help="target sqrt(s1*s2)/mean-kNN; 1.0-1.2 is the no-gap / no-fog band")
    ap.add_argument("--seed", type=int, default=1337)
    args = ap.parse_args()

    budget = {}
    for part in args.budget.split(","):
        k, v = part.split("=")
        budget[k.strip()] = int(v)

    img = nib.load(args.labels_nii)
    seg = np.asarray(img.dataobj)
    if seg.ndim == 4:
        seg = seg[..., 0]
    aff = np.asarray(img.affine, dtype=np.float64)
    zooms = np.asarray([float(z) for z in img.header.get_zooms()[:3]])
    frame = json.load(open(args.frame_json, encoding="utf-8"))
    centre = np.asarray(frame["center_yup_mm"], dtype=np.float64)
    rng = np.random.default_rng(args.seed)

    pts_all, rgb_all, a_all, s_all, q_all, sh1_all, fdi_all, lyr_all = [], [], [], [], [], [], [], []
    stats = {}
    for name, ids in LAYER_IDS.items():
        mask = np.isin(seg, ids)
        if mask.sum() < 50:
            stats[name] = {"voxels": int(mask.sum()), "skipped": True}
            continue
        padded = np.pad(mask.astype(np.float32), 1)
        verts, faces, _normals, _vals = measure.marching_cubes(padded, level=0.5)
        verts = verts - 1.0                                   # undo the pad
        faces = faces.astype(np.int64)
        verts = smooth_vertices(verts, faces, iters=2, lam=0.5)
        vn = vertex_normals(verts, faces)
        ao = vertex_ao(verts, faces)
        # voxel index -> RAS mm -> the project's Y-up frame, minus the converter's centre
        ras = nib.affines.apply_affine(aff, verts)   # aff already folds the voxel pitch
        world = ras @ RAS_TO_GLTF.T - centre
        tri = world[faces]
        tri_area = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
        area = float(tri_area.sum())
        n = budget.get(name, 20000)
        p, nn, occ, spacing = stratify(world, faces, vn @ RAS_TO_GLTF.T, ao, n, rng)
        m6 = knn6_means(p)
        sig_t = np.clip(args.rho * m6, 0.05, 1.2)
        sig_n = 0.20 * sig_t
        scale = np.stack([sig_t, sig_t, sig_n], axis=1)
        q = quat_from_z_to(nn)
        rgb = shade(nn, BASE_RGB[name], occ)
        if name == "teeth":
            jitter = (rng.random((len(p), 1)) - 0.5) * 0.05
            rgb = np.clip(rgb + jitter, 0, 1)
        sh1 = np.zeros((len(p), 9), dtype=np.float64)
        for c in range(3):
            sh1[:, c * 3 + 0] = 0.10 * SHEEN[name] * rgb[:, c]
            sh1[:, c * 3 + 1] = 0.04 * SHEEN[name] * rgb[:, c]
            sh1[:, c * 3 + 2] = 0.06 * SHEEN[name] * rgb[:, c]
        fdi = (readback_fdi(seg, p, nn, aff, zooms, centre) if name == "teeth"
               else np.zeros(len(p), dtype=np.uint8))
        pts_all.append(p); rgb_all.append(rgb)
        a_all.append(np.full(len(p), ALPHA[name])); s_all.append(scale); q_all.append(q)
        sh1_all.append(sh1)
        fdi_all.append(fdi)
        lyr_all.append(np.full(len(p), LAYER_BYTE[name], dtype=np.uint8))
        hist = {int(k): int(v) for k, v in zip(*np.unique(fdi[fdi > 0], return_counts=True))} if name == "teeth" else {}
        stats[name] = {"voxels": int(mask.sum()), "verts": int(len(verts)), "faces": int(len(faces)),
                       "area_mm2": round(area, 1), "splats": int(len(p)),
                       "spacing_mm": round(spacing, 3),
                       "sigma_t_mm": round(float(np.median(sig_t)), 3),
                       "sigma_n_mm": round(float(np.median(sig_n)), 3),
                       "knn6_mm": round(float(np.median(m6)), 3),
                       "rho_median": round(float(np.median(sig_t / m6)), 2),
                       "fdi": hist}

    xyz = np.concatenate(pts_all); rgb = np.concatenate(rgb_all)
    alpha = np.concatenate(a_all); scale = np.concatenate(s_all)
    quat = np.concatenate(q_all)
    fdi = np.concatenate(fdi_all); layer = np.concatenate(lyr_all)
    sh1 = np.concatenate(sh1_all)

    n = write_inria_ply(args.out, xyz.astype(np.float64), rgb, alpha, scale, quat, sh1)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    fdi_path = os.path.join(out_dir, "fdi_labels.bin")
    layer_path = os.path.join(out_dir, "layer_labels.bin")
    fdi.astype(np.uint8).tofile(fdi_path)
    layer.astype(np.uint8).tofile(layer_path)

    def sha(path: str) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    man = {
        "generator": "pipeline/cbct_surfel.py",
        "order": "writer order, no permutation (marching-cubes layers concatenated teeth,bone,nerve,sinus)",
        "ply": {"file": os.path.basename(args.out), "sha256": sha(args.out), "count": n},
        "files": {
            "fdi_labels.bin": {"sha256": sha(fdi_path), "count": int(len(fdi))},
            "layer_labels.bin": {"sha256": sha(layer_path), "count": int(len(layer))},
        },
        "counts": {"fdi_nonzero": int((fdi > 0).sum()), "teeth": int((layer == 1).sum())},
        "spacing_mm": None,
    }
    man_path = os.path.join(out_dir, "labels_manifest.json")
    with open(man_path, "w", encoding="utf-8") as fh:
        json.dump(man, fh, indent=2)

    print(json.dumps({"out": args.out, "splats": n, "layers": stats,
                      "sidecars": [os.path.basename(fdi_path), os.path.basename(layer_path),
                                   os.path.basename(man_path)]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
