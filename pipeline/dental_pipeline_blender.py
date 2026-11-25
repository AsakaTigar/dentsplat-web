# dental_pipeline_blender.py
#
# Run inside Blender (3.6 LTS or 4.x):
#
#   blender --background --python pipeline/dental_pipeline_blender.py -- \
#       --upper_obj raw/case01_upper.obj --upper_json raw/case01_upper.json \
#       --lower_obj raw/case01_lower.obj --lower_json raw/case01_lower.json \
#       --out_dir output/case01 --mode combined --num_views 120 --res 1024
#
# Produces, under --out_dir:
#   colmap_dataset/images/frame_XXXX.png        (--num_views x res x res)
#   colmap_dataset/sparse/0/{cameras,images,points3D}.txt
#   web_assets/proxy_teeth_<mode>.glb           (nodes FDI_<n> / GINGIVA_<arch>)
#   web_assets/tooth_meta_<mode>.json
#   frame.json                                  (shared full-arch centring sidecar)
#
# Coordinate contract: everything numeric is written in ONE frame -- glTF/Three.js
# Y-up, millimetres, arch centred at origin, occlusal plane ~XZ, upper jaw +Y,
# lips +Z. See dental_lib module docstring for the transform proof.

import argparse
import json
import math
import os
import sys
from collections import Counter

import numpy as np

try:
    import bpy
    import mathutils
except Exception as exc:  # pragma: no cover - only hit if run outside Blender
    sys.stderr.write(
        "FATAL: this script must run inside Blender, e.g.\n"
        "  blender --background --python dental_pipeline_blender.py -- <args>\n"
        f"(import failed: {exc})\n"
    )
    raise SystemExit(2)

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from dental_lib import (  # noqa: E402
    GINGIVA_LABEL,
    M_G_FROM_B,
    S_CBL_FROM_CCV,
    VALID_FDI,
    blender_to_gltf,
    file_row,
    fingerprints_match,
    human_size,
    look_at_world_to_camera,
    merge_meta_files,
    print_artifacts,
    rotation_to_quaternion_wxyz,
    read_frame_json,
    write_frame_json,
)

SCRIPT_VERSION = "1.0.0"


# --------------------------------------------------------------------------- #
# Arguments
# --------------------------------------------------------------------------- #
def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else list(argv[1:])
    p = argparse.ArgumentParser(
        prog="dental_pipeline_blender.py",
        description=(
            "Render a Teeth3DS/3DTeethSeg intra-oral scan into a COLMAP dataset plus "
            "FDI-labelled proxy GLB, all in one shared glTF Y-up millimetre frame."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--upper_obj", type=str, default=None, help="Upper-arch .obj (required unless --resume_check)")
    p.add_argument("--upper_json", type=str, default=None, help="Upper-arch label .json with per-vertex FDI 'labels'")
    p.add_argument("--lower_obj", type=str, default=None, help="Lower-arch .obj")
    p.add_argument("--lower_json", type=str, default=None, help="Lower-arch label .json")
    p.add_argument("--out_dir", type=str, required=True, help="Case output directory")
    p.add_argument("--mode", type=str, default="combined", choices=["combined", "upper", "lower"],
                   help="combined renders both arches; upper/lower render one arch but reuse the "
                        "full-arch centring cached in frame.json")
    p.add_argument("--num_views", type=int, default=120, help="Number of rendered views")
    p.add_argument("--res", type=int, default=1024, help="Square render resolution in px")
    p.add_argument("--samples", type=int, default=48, help="Cycles samples per pixel")
    p.add_argument("--seed", type=int, default=1337, help="RNG seed for surface sampling and Cycles")
    p.add_argument("--camera", type=str, default="orbit", choices=["orbit", "blender"],
                   help="orbit (default): poses are built directly in the Y-up target frame and the "
                        "Blender camera is derived by the inverse map, so the two exports cannot drift. "
                        "blender: legacy path, pose authored on the Blender camera then converted.")
    p.add_argument("--raw_up", type=str, default="Z", choices=["Z", "Y"],
                   help="Vertical axis of the source mesh. Teeth3DS ships Z-up.")
    p.add_argument("--decimate_ratio", type=float, default=0.08, help="Proxy mesh decimation ratio")
    p.add_argument("--min_face_per_tooth", type=int, default=24,
                   help="Tooth fragments below this face count are merged into gingiva (scan noise, "
                        "orphan triangles). 0 disables the guard.")
    p.add_argument("--num_init_pts", type=int, default=25000, help="COLMAP points3D surface samples")
    p.add_argument("--lens", type=float, default=50.0, help="Camera focal length in mm")
    p.add_argument("--sensor_width", type=float, default=36.0, help="Camera sensor width in mm")
    p.add_argument("--radius_scale", type=float, default=1.45, help="Orbit radius as a multiple of arch extent")
    p.add_argument("--elevation_deg", type=float, default=75.0, help="Max orbit elevation above occlusal plane")
    p.add_argument("--device", type=str, default="auto", choices=["auto", "gpu", "cpu"])
    p.add_argument("--skip_render", action="store_true", help="Write sparse/0 + GLB only (fast geometry debug)")
    p.add_argument("--overwrite", action="store_true", help="Redo stages even if their outputs exist")
    p.add_argument("--resume_check", action="store_true",
                   help="Validate existing outputs against frame.json and exit without rendering")
    return p.parse_args(argv)


# --------------------------------------------------------------------------- #
# Strict OBJ parsing
# --------------------------------------------------------------------------- #
def load_obj_strict(obj_path):
    """Parse positions + triangle topology from an OBJ, preserving vertex order.

    ASSUMPTIONS (documented because the whole FDI binding depends on them):
      * The ``v`` lines, in file order, define vertex index i -> row i of the returned
        array. Teeth3DS/3DTeethSeg JSON ``labels`` are PER VERTEX in exactly this same
        order, so len(labels) == len(v) and labels[i] belongs to verts[i]. Verified
        against arXiv:2210.06094v2 Sec.3 ("The length of the tables 'labels' and
        'instances' is the same as the total number of vertices").
      * Face tokens may be ``v``, ``v/vt``, ``v//vn`` or ``v/vt/vn``. We take element 0
        after splitting on '/', which correctly handles the empty middle field of
        ``v//vn``. vt/vn indices are IGNORED: they are independent streams and are NOT
        parallel to vertex indices, so they must never be used to look up labels.
      * Negative face indices are relative to the current vertex count and are resolved
        as ``len(verts) + idx`` (OBJ spec), i.e. -1 == last vertex parsed so far.
      * Polygon faces are fan-triangulated.
      * Texture/normal/vertex-line counts are tracked so we can assert the label array
        matches the ``v`` stream rather than some other stream.
    """
    verts = []
    faces = []
    n_vn = n_vt = 0
    max_index_seen = 0
    with open(obj_path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if line.startswith("v "):
                parts = line.split()
                if len(parts) < 4:
                    continue
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif line.startswith("vn "):
                n_vn += 1
            elif line.startswith("vt "):
                n_vt += 1
            elif line.startswith("f "):
                tokens = line.split()[1:]
                idx = []
                for tok in tokens:
                    head = tok.split("/")[0]
                    if head == "":
                        raise ValueError(f"{obj_path}: malformed face token '{tok}'")
                    vi = int(head)
                    if vi > 0:
                        zero = vi - 1
                    else:
                        zero = len(verts) + vi  # negative indices are relative
                    if zero < 0 or zero >= len(verts):
                        raise ValueError(
                            f"{obj_path}: face index {vi} out of range (have {len(verts)} vertices so far)"
                        )
                    max_index_seen = max(max_index_seen, zero + 1)
                    idx.append(zero)
                for k in range(1, len(idx) - 1):
                    faces.append((idx[0], idx[k], idx[k + 1]))

    if not verts:
        raise ValueError(f"{obj_path}: no 'v ' lines found -- is this really an OBJ?")
    arr_v = np.asarray(verts, dtype=np.float64)
    arr_f = np.asarray(faces, dtype=np.int32).reshape(-1, 3)
    if max_index_seen > len(arr_v):
        raise ValueError(f"{obj_path}: face references vertex {max_index_seen} but only {len(arr_v)} exist")
    print(f"[OBJ] {os.path.basename(obj_path)}: {len(arr_v):,} v, {len(arr_f):,} f, "
          f"{n_vt:,} vt, {n_vn:,} vn")
    return arr_v, arr_f


def load_fdi_labels(json_path, num_verts, obj_path):
    """Load per-vertex FDI labels and hard-check alignment with the OBJ vertex stream.

    Teeth3DS/3DTeethSeg ship the array under "labels" (arXiv:2210.06094). Different re-releases
    and the 3DTeethSeg24 track have used "points" / "per_point_labels", so we accept those as
    aliases but require exactly one of them and always verify len == number of 'v' lines.
    """
    with open(json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    key = next((k for k in ("labels", "points", "per_point_labels", "vertex_labels")
                if isinstance(data.get(k), list)), None)
    if key is None:
        raise ValueError(
            f"{json_path}: none of 'labels'/'points'/'per_point_labels'/'vertex_labels' is a list "
            f"(found keys {sorted(data.keys())}). Pass the per-vertex annotation JSON, not the "
            f"mesh file."
        )
    if key != "labels":
        print(f"[WARN] {json_path}: using '{key}' as the per-vertex label array "
              f"(expected 'labels'); verify this is the right field for your release.")
    raw = np.asarray(data[key], dtype=np.int64)
    if raw.ndim != 1:
        raise ValueError(f"{json_path}: '{key}' must be a flat array, got shape {raw.shape}")
    if len(raw) != num_verts:
        raise ValueError(
            f"label/vertex mismatch for {obj_path}: obj has {num_verts} 'v' lines but "
            f"{json_path} has {len(raw)} labels. The OBJ importer must not have re-ordered or "
            f"merged vertices; check the file was not post-processed."
        )
    uniq = set(int(x) for x in np.unique(raw))
    unknown = sorted(u for u in uniq if u != GINGIVA_LABEL and u not in VALID_FDI)
    if unknown:
        print(f"[WARN] {json_path}: {len(unknown)} label values are not legal FDI ids and will be "
              f"folded into gingiva: {unknown[:12]}{' ...' if len(unknown) > 12 else ''}")
    jaw = str(data.get("jaw", "")).lower()
    n_teeth = len([u for u in uniq if u != GINGIVA_LABEL])
    print(f"[JSON] {os.path.basename(json_path)}: jaw={jaw or 'n/a'}, {n_teeth} distinct tooth ids")
    return raw.astype(np.int32), jaw


# --------------------------------------------------------------------------- #
# Mesh partitioning
# --------------------------------------------------------------------------- #
def face_labels_from_vertex_labels(faces, labels):
    """Vote the three vertex labels of each face into one face label.

    A face is assigned to a tooth only when at least two of its vertices agree on a
    non-gingival id; ties fall back to gingiva. This keeps the tooth/gingiva boundary
    tight instead of bleeding teeth onto the gum.
    """
    lv = labels[faces[:, 0]]
    mv = labels[faces[:, 1]]
    nv = labels[faces[:, 2]]
    stack = np.stack([lv, mv, nv], axis=1)
    nz = np.where(stack != GINGIVA_LABEL, stack, -1)
    out = np.zeros(len(faces), dtype=np.int64)
    for i in range(len(faces)):
        vals = [int(v) for v in nz[i] if v != -1]
        if not vals:
            out[i] = GINGIVA_LABEL
            continue
        cnt = Counter(vals)
        top, top_n = cnt.most_common(1)[0]
        tied = sum(1 for k, v in cnt.items() if v == top_n and k != GINGIVA_LABEL)
        out[i] = int(top) if (top_n >= 2 and tied == 1) else GINGIVA_LABEL
    return out


def build_objects_by_fdi(verts, faces, labels, arch_tag, mat_enamel, mat_gingiva, min_face_per_tooth):
    """Split the scan into one Blender object per FDI tooth plus one gingiva shell."""
    fl = face_labels_from_vertex_labels(faces, labels)

    # Minimum-face guard: merge slivers into gingiva before partitioning.
    if min_face_per_tooth > 0:
        sizes = Counter(int(x) for x in fl if x != GINGIVA_LABEL)
        slivers = {k for k, n in sizes.items() if n < min_face_per_tooth}
        if slivers:
            keep = np.isin(fl, list(slivers), invert=True)
            fl = np.where(~keep, GINGIVA_LABEL, fl)
            print(f"[GUARD] {arch_tag}: merged {len(slivers)} sub-{min_face_per_tooth}-face tooth "
                  f"fragments into gingiva: {sorted(slivers)[:12]}")

    created, meta = [], {}
    for lbl in np.unique(fl):
        mask = fl == lbl
        sub_faces = faces[mask]
        if len(sub_faces) == 0:
            continue
        used_v, inv_idx = np.unique(sub_faces, return_inverse=True)
        sub_verts = verts[used_v]
        remapped = inv_idx.reshape(-1, 3)

        if int(lbl) == GINGIVA_LABEL:
            name = f"GINGIVA_{arch_tag}"
        else:
            name = f"FDI_{int(lbl)}"

        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(sub_verts.tolist(), [], remapped.tolist())
        if len(mesh.polygons):
            try:
                mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
            except Exception:
                for poly in mesh.polygons:
                    poly.use_smooth = True
        mesh.validate(verbose=False)
        mesh.update()
        if len(mesh.polygons) == 0:
            print(f"[SKIP] {name}: produced zero faces after validation")
            bpy.data.meshes.remove(mesh)
            continue

        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(mat_enamel if int(lbl) != GINGIVA_LABEL else mat_gingiva)
        created.append(obj)

        pts_g = blender_to_gltf(sub_verts)
        entry = {
            "fdi": int(lbl),
            "arch": arch_tag,
            "centroid_mm": [round(float(v), 3) for v in pts_g.mean(axis=0)],
            "bbox_min_mm": [round(float(v), 3) for v in pts_g.min(axis=0)],
            "bbox_max_mm": [round(float(v), 3) for v in pts_g.max(axis=0)],
            "n_vertices": int(len(pts_g)),
            "n_faces": int(len(remapped)),
        }
        if name in meta:
            raise RuntimeError(f"duplicate metadata key '{name}' within arch '{arch_tag}'")
        meta[name] = entry
    return created, meta


# --------------------------------------------------------------------------- #
# Scene setup
# --------------------------------------------------------------------------- #
def configure_cycles(scene, args):
    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(args.samples)
    scene.cycles.use_denoising = True
    scene.cycles.seed = int(args.seed)
    scene.render.resolution_x = int(args.res)
    scene.render.resolution_y = int(args.res)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False

    vt = [i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items]
    for pick in ("AgX", "Filmic", "Standard"):
        if pick in vt:
            scene.view_settings.view_transform = pick
            break
    try:
        scene.view_settings.look = "None"
    except Exception:
        pass

    chosen = "CPU"
    if args.device in ("auto", "gpu"):
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for dt in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
                try:
                    prefs.compute_device_type = dt
                except Exception:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == dt]
                if gpus:
                    for d in prefs.devices:
                        d.use = (d.type == dt) or (args.device == "cpu")
                    scene.cycles.device = "GPU"
                    chosen = f"GPU/{dt} ({', '.join(d.name for d in gpus[:2])})"
                    break
        except Exception as exc:
            print(f"[WARN] GPU setup failed, falling back to CPU: {exc}")
    print(f"[RENDER] device = {chosen}, engine = CYCLES, samples = {args.samples}, res = {args.res}")
    return chosen


def create_dental_materials():
    """Enamel and gingiva shaders with AO-driven colour ramps.

    Every Principled input is set through a candidate-name list because Blender 4.0
    renamed Subsurface/Clearcoat/Specular; a missing key would otherwise raise.
    """
    def new_principled(label):
        mat = bpy.data.materials.new(label)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out.location = (600, 0)
        return mat, nt, out, bsdf

    def set_input(bsdf, candidates, value):
        for name in candidates:
            if name in bsdf.inputs:
                try:
                    bsdf.inputs[name].default_value = value
                    return True
                except Exception:
                    continue
        return False

    def link_color(nt, bsdf, ramp):
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    mat_enamel, nt, out, bsdf = new_principled("DentalEnamel")
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.samples = 16
    ao.inputs["Distance"].default_value = 4.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (0.68, 0.62, 0.50, 1.0)
    ramp.color_ramp.elements[1].position = 0.85
    ramp.color_ramp.elements[1].color = (0.94, 0.91, 0.84, 1.0)
    nt.links.new(ao.outputs["AO"], ramp.inputs["Fac"])
    link_color(nt, bsdf, ramp)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    set_input(bsdf, ["Roughness"], 0.14)
    set_input(bsdf, ["IOR"], 1.62)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.65)
    set_input(bsdf, ["Coat Weight", "Clearcoat"], 0.85)
    set_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.06)
    set_input(bsdf, ["Subsurface Weight", "Subsurface"], 0.22)
    set_input(bsdf, ["Subsurface Scale"], 0.8)

    mat_gingiva, nt2, out2, bsdf2 = new_principled("DentalGingiva")
    ao2 = nt2.nodes.new("ShaderNodeAmbientOcclusion")
    ao2.samples = 16
    ao2.inputs["Distance"].default_value = 5.0
    ramp2 = nt2.nodes.new("ShaderNodeValToRGB")
    ramp2.color_ramp.elements[0].position = 0.20
    ramp2.color_ramp.elements[0].color = (0.48, 0.16, 0.18, 1.0)
    ramp2.color_ramp.elements[1].position = 0.85
    ramp2.color_ramp.elements[1].color = (0.76, 0.36, 0.38, 1.0)
    nt2.links.new(ao2.outputs["AO"], ramp2.inputs["Fac"])
    link_color(nt2, bsdf2, ramp2)
    nt2.links.new(bsdf2.outputs["BSDF"], out2.inputs["Surface"])
    set_input(bsdf2, ["Roughness"], 0.22)
    set_input(bsdf2, ["Coat Weight", "Clearcoat"], 0.90)
    set_input(bsdf2, ["Coat Roughness", "Clearcoat Roughness"], 0.08)
    set_input(bsdf2, ["Subsurface Weight", "Subsurface"], 0.35)
    set_input(bsdf2, ["Subsurface Scale"], 1.5)
    return mat_enamel, mat_gingiva


def setup_world_and_lights():
    world = bpy.data.worlds.new("DentalWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mix = nt.nodes.new("ShaderNodeMixShader")
    lp = nt.nodes.new("ShaderNodeLightPath")
    bg_cam = nt.nodes.new("ShaderNodeBackground")
    bg_cam.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bg_cam.inputs["Strength"].default_value = 0.0
    bg_env = nt.nodes.new("ShaderNodeBackground")
    bg_env.inputs["Color"].default_value = (0.85, 0.90, 0.95, 1.0)
    bg_env.inputs["Strength"].default_value = 0.35
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg_env.outputs["Background"], mix.inputs[1])
    nt.links.new(bg_cam.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])

    # Positions are Blender Z-up (x right, y depth, z height); scene units are mm,
    # hence the large area-light energies.
    light_configs = [
        ("KeyLight", (90, -140, 110), 120.0, 180000.0, (1.00, 0.98, 0.95)),
        ("FillLight", (-130, -90, 60), 140.0, 90000.0, (0.92, 0.96, 1.00)),
        ("RimLight", (0, 150, 90), 130.0, 110000.0, (0.95, 0.98, 1.00)),
        ("BottomFill", (0, -80, -130), 140.0, 65000.0, (1.00, 0.96, 0.94)),
    ]
    for name, loc, size, energy, color in light_configs:
        ldata = bpy.data.lights.new(name=name, type="AREA")
        ldata.size = size
        ldata.energy = energy
        ldata.color = color
        lobj = bpy.data.objects.new(name=name, object_data=ldata)
        bpy.context.collection.objects.link(lobj)
        lobj.location = loc
        direction = mathutils.Vector((0.0, 0.0, 0.0)) - mathutils.Vector(loc)
        lobj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


# --------------------------------------------------------------------------- #
# Camera rig
# --------------------------------------------------------------------------- #
def generate_orbit_poses(num_views, radius, elevation_deg, rng):
    """Cameras in the SHARED Y-up frame: azimuth Fibonacci-spread, elevation banded.

    Returning poses in the export frame (not Blender's) removes the class of bug where
    the GLB and images.txt disagree, because there is only ever one frame involved.
    """
    elev = math.radians(elevation_deg)
    golden = math.pi * (3.0 - math.sqrt(5.0))
    poses = []
    for i in range(num_views):
        t = i / max(1, num_views - 1)
        sin_el = math.sin(elev) * (1.0 - 2.0 * t)
        cos_el = math.sqrt(max(1e-9, 1.0 - sin_el * sin_el))
        az = golden * i + rng.uniform(-0.02, 0.02)
        r = radius * (0.92 + 0.16 * ((i % 5) / 4.0))
        pos = np.array([r * cos_el * math.cos(az), r * sin_el, r * cos_el * math.sin(az)], dtype=np.float64)
        poses.append(pos)
    return poses


def apply_pose_to_blender_camera(cam_obj, cam_pos_gltf, target=np.zeros(3)):
    """Drive the Blender camera so it renders exactly the Y-up pose ``cam_pos_gltf``.

    Inverse of M_G_FROM_B maps the Y-up position/axes back into Blender Z-up, so the
    rendered image and the numbers written to images.txt come from one definition.
    """
    pos_b = np.linalg.inv(M_G_FROM_B) @ np.append(np.asarray(cam_pos_gltf, dtype=np.float64), 1.0)
    # Drive the camera from the SAME look-at matrix that is written to images.txt instead of
    # to_track_quat(): the two disagreed by a 180 deg roll (verify_pose_consistency caught it at
    # rot 2.00), because track_quat picks its roll from an up hint that is nearly degenerate for
    # steep elevations. One source of truth: R_B_from_CBl = M_R^-1 @ R_G_from_Ccv @ S^-1.
    # look_at_world_to_camera returns world-to-camera; the camera axes in the world are its transpose.
    R_w2c, _ = look_at_world_to_camera(cam_pos_gltf, target)
    R_b_from_c = np.linalg.inv(M_G_FROM_B[:3, :3]) @ R_w2c.T @ S_CBL_FROM_CCV[:3, :3]
    M = mathutils.Matrix(R_b_from_c.tolist()).to_4x4()
    M.translation = mathutils.Vector((float(pos_b[0]), float(pos_b[1]), float(pos_b[2])))
    cam_obj.matrix_world = M
    return pos_b


def blender_camera_world_to_camera(cam_obj):
    """Legacy path: derive COLMAP w2c from the live Blender camera matrix_world."""
    T_B_from_Cbl = np.array(cam_obj.matrix_world, dtype=np.float64)
    T_G_from_Ccv = M_G_FROM_B @ T_B_from_Cbl @ S_CBL_FROM_CCV
    T_Ccv_from_G = np.linalg.inv(T_G_from_Ccv)
    return T_Ccv_from_G[:3, :3], T_Ccv_from_G[:3, 3]


def verify_pose_consistency(cam_obj, cam_pos_gltf, tol=1e-4):
    """Assert the two derivations agree, i.e. our Blender<->glTF maps are inverses."""
    R_a, t_a = look_at_world_to_camera(cam_pos_gltf, [0.0, 0.0, 0.0])
    R_b, t_b = blender_camera_world_to_camera(cam_obj)
    err_r = float(np.max(np.abs(R_a - R_b)))
    err_t = float(np.max(np.abs(t_a - t_b)))
    if err_r > tol or err_t > tol:
        raise RuntimeError(
            f"pose derivation mismatch (rot {err_r:.2e}, trans {err_t:.2e}). The Blender->glTF "
            f"map and the exported frame disagree; do not proceed."
        )
    return err_r, err_t


# --------------------------------------------------------------------------- #
# Surface sampling
# --------------------------------------------------------------------------- #
def sample_surface_points(mesh_entries, total_points, rng):
    """Area-weighted surface samples across ALL meshes, exact count, robust split.

    The draft allocated ``total_points // len(entries)`` per mesh, which loses the
    remainder and crashes outright on an empty list. Here the budget is distributed by
    SURFACE AREA with a largest-remainder pass so sum(counts) == total_points exactly,
    and degenerate meshes (zero area / zero faces) receive zero without dividing by 0.
    """
    if total_points <= 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.uint8)
    entries = []
    for verts, faces, labels in mesh_entries:
        verts = np.asarray(verts, dtype=np.float64)
        faces = np.asarray(faces, dtype=np.int32).reshape(-1, 3)
        if len(verts) == 0 or len(faces) == 0:
            continue
        v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
        areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)
        entries.append((verts, faces, np.asarray(labels, dtype=np.int32), areas))
    if not entries:
        raise RuntimeError("sample_surface_points: every input mesh is empty -- nothing to render")

    total_area = float(sum(a.sum() for _, _, _, a in entries))
    if total_area <= 0.0:
        weights = np.array([len(f) for _, f, _, _ in entries], dtype=np.float64)
        weights = weights / max(weights.sum(), 1.0)
    else:
        weights = np.array([float(a.sum()) for _, _, _, a in entries], dtype=np.float64) / total_area

    ideal = weights * total_points
    counts = np.floor(ideal).astype(np.int64)
    deficit = int(total_points - counts.sum())
    if deficit > 0:
        order = np.argsort(-(ideal - counts))
        counts[order[:deficit]] += 1

    pts_out, col_out = [], []
    for (verts, faces, labels, areas), want in zip(entries, counts):
        if want <= 0:
            continue
        good = areas > 0.0
        if not good.any():
            good = np.ones(len(faces), dtype=bool)
        probs = areas.copy()
        probs[~good] = 0.0
        probs = probs / max(probs.sum(), 1e-12)
        face_idx = rng.choice(len(faces), size=int(want), replace=True, p=probs)
        r1 = np.sqrt(rng.random((int(want), 1)))
        r2 = rng.random((int(want), 1))
        v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
        pts_b = (1 - r1) * v0[face_idx] + r1 * (1 - r2) * v1[face_idx] + r1 * r2 * v2[face_idx]
        pts_out.append(blender_to_gltf(pts_b))
        lbl = labels[faces[face_idx, 0]]
        cols = np.where(lbl[:, None] != GINGIVA_LABEL,
                        np.array([238, 232, 218], dtype=np.uint8),
                        np.array([205, 118, 122], dtype=np.uint8))
        col_out.append(cols.astype(np.uint8))

    pts = np.vstack(pts_out)
    cols = np.vstack(col_out)
    if len(pts) != total_points:
        raise RuntimeError(f"internal sampling error: produced {len(pts)}, expected {total_points}")
    return pts, cols


# --------------------------------------------------------------------------- #
# COLMAP text writers
# --------------------------------------------------------------------------- #
COLMAP_HEADER_CAMERAS = (
    "# Camera list with one line of data per camera:\n"
    "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n"
    "# Number of cameras: 1\n"
)
COLMAP_HEADER_IMAGES = (
    "# Image list with two lines of data per image:\n"
    "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n"
    "#   POINTS2D[] as (X, Y, POINT3D_ID)\n"
    "# Number of images: {n}\n"
)
COLMAP_HEADER_POINTS = (
    "# 3D point list with one line of data per point:\n"
    "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n"
    "# Number of points: {n}\n"
)


def write_colmap(sparse_dir, args, fx, fy, cx, cy, image_rows, points, colors):
    os.makedirs(sparse_dir, exist_ok=True)
    with open(os.path.join(sparse_dir, "cameras.txt"), "w", encoding="utf-8") as fh:
        fh.write(COLMAP_HEADER_CAMERAS)
        fh.write(f"1 PINHOLE {args.res} {args.res} {fx:.6f} {fy:.6f} {cx:.6f} {cy:.6f}\n")
    with open(os.path.join(sparse_dir, "images.txt"), "w", encoding="utf-8") as fh:
        fh.write(COLMAP_HEADER_IMAGES.format(n=len(image_rows)))
        for line in image_rows:
            fh.write(line)
    with open(os.path.join(sparse_dir, "points3D.txt"), "w", encoding="utf-8") as fh:
        fh.write(COLMAP_HEADER_POINTS.format(n=len(points)))
        for pid, (p, c) in enumerate(zip(points, colors), start=1):
            fh.write(f"{pid} {p[0]:.6f} {p[1]:.6f} {p[2]:.6f} {int(c[0])} {int(c[1])} {int(c[2])} 0.0\n")


# --------------------------------------------------------------------------- #
# Decimation + GLB export
# --------------------------------------------------------------------------- #
def decimate_objects(objs, ratio):
    """Apply a Decimate modifier to every object, surviving empty meshes.

    ``bpy.ops.object.modifier_apply`` reads the active object from context, so we set
    view_layer.objects.active explicitly and wrap in temp_override where available
    (Blender 3.2+). Objects with no polygons are skipped -- applying DECIMATE to an
    empty mesh raises.
    """
    done = 0
    for obj in objs:
        if obj.type != "MESH" or len(obj.data.polygons) == 0:
            continue
        try:
            mod = obj.modifiers.new(name="DecimateProxy", type="DECIMATE")
            mod.ratio = float(ratio)
            mod.use_collapse_triangulate = True
            try:
                with bpy.context.temp_override(object=obj, active_object=obj,
                                               selected_editable_objects=[obj]):
                    bpy.ops.object.modifier_apply(modifier=mod.name)
            except (AttributeError, TypeError):
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.modifier_apply(modifier=mod.name)
            done += 1
        except Exception as exc:
            print(f"[WARN] decimate failed on {obj.name}: {exc} (keeping full-res proxy)")
            for m in list(obj.modifiers):
                try:
                    obj.modifiers.remove(m)
                except Exception:
                    pass
    print(f"[PROXY] decimated {done}/{len(objs)} objects at ratio {ratio}")
    return done


def export_proxy_glb(objs, path, mode):
    bpy.ops.object.select_all(action="DESELECT")
    selected = 0
    for obj in objs:
        try:
            obj.select_set(True)
            selected += 1
        except Exception:
            pass
    bpy.context.view_layer.objects.active = objs[0] if objs else None
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,          # applies the SAME (x,y,z)->(x,-z,y) we modelled
        export_materials="NONE",
        export_normals=True,
        export_apply=True,        # bake modifiers, no animation/data leftovers
        export_animations=False,
        export_extras=False,
        export_transactions=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        kwargs.pop("export_transactions", None)
        kwargs.pop("export_extras", None)
        bpy.ops.export_scene.gltf(**kwargs)
    except Exception as exc:
        print(f"[WARN] strict glTF export failed ({exc}); retrying with defaults")
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB",
                                  use_selection=True, export_yup=True)
    print(f"[PROXY] wrote {path} ({human_size(os.path.getsize(path))}) from {selected} nodes, mode={mode}")


# --------------------------------------------------------------------------- #
# Frame sidecar
# --------------------------------------------------------------------------- #
def resolve_frame(frame_path, loaded, mode, overwrite, raw_up):
    """Compute or reuse the full-arch centring so upper/lower passes stay consistent.

    Centring MUST come from all arches together: if each pass centred itself, the two
    jaws would sit in different local origins and the web open/close slider would tear
    them apart. Hence a cached sidecar plus loud fingerprint checks.
    """
    all_stack = np.vstack([v for _, v, _, _ in loaded])
    vmin, vmax = all_stack.min(axis=0), all_stack.max(axis=0)
    center_local = 0.5 * (vmin + vmax)
    extent_local = float(np.linalg.norm(vmax - vmin))

    payload = {
        "center_blender_zup": [round(float(x), 6) for x in center_local],
        "extent_mm": round(extent_local, 6),
        "raw_up": raw_up,
        "fingerprints": {},
        "sources": [],
    }

    existing = None
    if os.path.isfile(frame_path) and not overwrite:
        try:
            existing = read_frame_json(frame_path)
        except RuntimeError as exc:
            print(f"[FATAL] {exc}")
            raise

    for tag, v, _f, lbl in loaded:
        uniq = sorted(set(int(x) for x in np.unique(lbl) if x != GINGIVA_LABEL))
        fp = {
            "n_verts": int(len(v)),
            "tooth_ids": uniq,
            "bbox_min": [round(float(x), 4) for x in v.min(axis=0)],
            "bbox_max": [round(float(x), 4) for x in v.max(axis=0)],
        }
        payload["fingerprints"][tag] = fp
        payload["sources"].append(tag)
    payload["arch_modes_this_pass"] = mode

    if existing is None:
        return center_local, extent_local, payload, "created"

    prev_center = np.asarray(existing["center_blender_zup"], dtype=np.float64)
    prev_extent = float(existing["extent_mm"])
    # Recompute centre using ONLY the arches present in BOTH runs, so that a
    # combined-first workflow followed by single-arch passes stays identical.
    common = [t for t in payload["fingerprints"] if t in existing["fingerprints"]]
    if not common:
        raise RuntimeError(
            f"{frame_path} describes arches {sorted(existing['fingerprints'])} but this run has "
            f"{sorted(payload['fingerprints'])}. No overlap -- refusing to mix coordinate frames."
        )
    stack_common = np.vstack([v for tag, v, _, _ in loaded if tag in common])
    cmin, cmax = stack_common.min(axis=0), stack_common.max(axis=0)
    center_common = 0.5 * (cmin + cmax)
    if not fingerprints_match(center_common, prev_center, tol=1e-4):
        raise RuntimeError(
            f"{frame_path} centring {list(np.round(prev_center,4))} does not match the centring "
            f"recomputed from the shared arches {common}: {list(np.round(center_common,4))}. "
            f"The raw meshes changed since the first pass. Delete frame.json and re-run every "
            f"pass for this case, otherwise the two jaws will not share a coordinate system."
        )
    if abs(prev_extent - extent_local) > 1e-3:
        print(f"[WARN] full-arch extent differs from cache ({prev_extent:.3f} vs {extent_local:.3f} mm) "
              f"-- this pass added an arch. Using the CACHED centre so both jaws stay aligned.")
    for tag in common:
        if existing["fingerprints"][tag] != payload["fingerprints"][tag]:
            print(f"[WARN] arch '{tag}' fingerprint changed since the cached pass "
                  f"(different mesh or labels). Cached centre still applied.")
    return prev_center, prev_extent, payload, "reused"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    args = parse_args()
    rng = np.random.default_rng(args.seed)

    if args.mode == "combined" and not (args.upper_obj and args.lower_obj):
        print("[INFO] --mode combined with a single arch: rendering one jaw only.")
    needed = {"upper": (args.upper_obj, args.upper_json), "lower": (args.lower_obj, args.lower_json)}
    primary = args.mode if args.mode != "combined" else "upper"
    po, pj = needed[primary]
    if not po or not pj:
        raise SystemExit(f"FATAL: --mode {args.mode} requires --{primary}_obj and --{primary}_json")

    raw_items = []
    for tag, (op, jp) in needed.items():
        if op and jp:
            raw_items.append((tag, op, jp))
        elif op or jp:
            raise SystemExit(f"FATAL: arch '{tag}' given only one of obj/json")

    bpy.ops.wm.read_factory_settings(use_empty=True)

    loaded = []
    for tag, op, jp in raw_items:
        v, f = load_obj_strict(op)
        lbl, _jaw = load_fdi_labels(jp, len(v), op)
        if args.raw_up == "Y":
            # Y-up source -> Blender Z-up: (x,y,z)_src -> (x, -z, y)
            v = np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)
        loaded.append((tag, v, f, lbl))

    # Absolute: bpy resolves a relative render filepath against the .blend location ("//"), which in
    # --background with no blend is not the shell CWD. The first real run rendered 120 frames into
    # nowhere and honestly reported "0 PNGs" in its own summary.
    out_dir = os.path.abspath(args.out_dir)
    colmap_dir = os.path.join(out_dir, "colmap_dataset")
    img_dir = os.path.join(colmap_dir, "images")
    sparse_dir = os.path.join(colmap_dir, "sparse", "0")
    web_dir = os.path.join(out_dir, "web_assets")
    frame_path = os.path.join(out_dir, "frame.json")
    for d in (img_dir, sparse_dir, web_dir):
        os.makedirs(d, exist_ok=True)

    center, extent, payload, frame_state = resolve_frame(
        frame_path, loaded, args.mode, args.overwrite, args.raw_up)
    write_frame_json(frame_path, payload)
    print(f"[FRAME] {frame_state} centring (Blender Z-up) = "
          f"({center[0]:.3f}, {center[1]:.3f}, {center[2]:.3f}) mm, extent = {extent:.3f} mm")

    if args.resume_check:
        print("[RESUME_CHECK] frame.json validated; nothing rendered.")
        print_artifacts("dental_pipeline_blender.py (resume check)", [file_row(frame_path)])
        return

    device = configure_cycles(bpy.context.scene, args)
    mat_enamel, mat_gingiva = create_dental_materials()
    setup_world_and_lights()

    active_entries = []
    for tag, v, f, lbl in loaded:
        if args.mode in ("combined", tag):
            active_entries.append((tag, v - center, f, lbl))
    if not active_entries:
        raise SystemExit(f"FATAL: --mode {args.mode} selected no arches")

    created_objs, all_meta = [], {}
    for tag, v, f, lbl in active_entries:
        objs, meta = build_objects_by_fdi(v, f, lbl, tag, mat_enamel, mat_gingiva,
                                         args.min_face_per_tooth)
        created_objs.extend(objs)
        for k, val in meta.items():
            if k in all_meta:
                raise RuntimeError(f"metadata key collision '{k}' -- two arches emitted the same node name")
            all_meta[k] = val
    n_teeth = sum(1 for k in all_meta if k.startswith("FDI_"))
    print(f"[SCENE] {len(created_objs)} objects ({n_teeth} teeth + gingiva) for mode={args.mode}")

    cam_data = bpy.data.cameras.new("DentalCam")
    cam_data.lens = float(args.lens)
    cam_data.sensor_width = float(args.sensor_width)
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.clip_start = 1.0
    cam_data.clip_end = 4000.0
    cam_obj = bpy.data.objects.new("DentalCam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj

    fx = fy = (cam_data.lens / cam_data.sensor_width) * args.res
    cx = cy = args.res / 2.0

    radius = float(extent * args.radius_scale)
    poses = generate_orbit_poses(args.num_views, radius, args.elevation_deg, rng)

    images_txt = os.path.join(sparse_dir, "images.txt")
    already_done = (os.path.isfile(images_txt) and not args.overwrite
                    and os.path.isdir(img_dir)
                    and len([n for n in os.listdir(img_dir) if n.endswith(".png")]) >= args.num_views)
    if already_done:
        print(f"[SKIP] render + poses already complete ({args.num_views} PNGs). Pass --overwrite to redo.")
    else:
        image_rows = []
        max_rot_err = max_t_err = 0.0
        for idx, pos_g in enumerate(poses, start=1):
            img_name = f"frame_{idx:04d}.png"
            img_path = os.path.join(img_dir, img_name)
            if args.skip_render:
                pass
            elif os.path.isfile(img_path) and not args.overwrite:
                pass
            else:
                apply_pose_to_blender_camera(cam_obj, pos_g)
                bpy.context.view_layer.update()
                bpy.context.scene.render.filepath = img_path
                bpy.ops.render.render(write_still=True)

            if args.camera == "orbit":
                R_w2c, t_w2c = look_at_world_to_camera(pos_g, [0.0, 0.0, 0.0])
                if idx == 1:
                    apply_pose_to_blender_camera(cam_obj, pos_g)
                    bpy.context.view_layer.update()
                    er, et = verify_pose_consistency(cam_obj, pos_g)
                    max_rot_err, max_t_err = er, et
            else:
                apply_pose_to_blender_camera(cam_obj, pos_g)
                bpy.context.view_layer.update()
                R_w2c, t_w2c = blender_camera_world_to_camera(cam_obj)

            det = float(np.linalg.det(R_w2c))
            if abs(det - 1.0) > 1e-6:
                raise RuntimeError(f"view {idx}: det(R_w2c) = {det:.6f}, expected +1 (proper rotation)")
            q = rotation_to_quaternion_wxyz(R_w2c)
            if abs(float(np.dot(q, q)) - 1.0) > 1e-9:
                raise RuntimeError(f"view {idx}: quaternion not unit: {q}")
            image_rows.append(
                f"{idx} {q[0]:.8f} {q[1]:.8f} {q[2]:.8f} {q[3]:.8f} "
                f"{t_w2c[0]:.6f} {t_w2c[1]:.6f} {t_w2c[2]:.6f} 1 {img_name}\n\n"
            )
            if not args.skip_render and (idx % 10 == 0 or idx == len(poses)):
                print(f"[RENDER] {idx}/{len(poses)} views"
                      + (f" (pose self-check rot {max_rot_err:.1e} mm {max_t_err:.1e})" if idx == 1 else ""))
        pts, cols = sample_surface_points([(v, f, l) for _, v, f, l in active_entries],
                                          args.num_init_pts, rng)
        write_colmap(sparse_dir, args, fx, fy, cx, cy, image_rows, pts, cols)
        print(f"[COLMAP] {len(image_rows)} images, {len(pts):,} initial points -> {sparse_dir}")

    decimate_objects(created_objs, args.decimate_ratio)
    proxy_path = os.path.join(web_dir, f"proxy_teeth_{args.mode}.glb")
    export_proxy_glb(created_objs, proxy_path, args.mode)

    meta_path = os.path.join(web_dir, f"tooth_meta_{args.mode}.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump({
            "unit": "mm",
            "coordinate_system": "glTF_Y_up",
            "arch_extent_mm": round(float(extent), 3),
            "mode": args.mode,
            "seed": int(args.seed),
            "teeth": all_meta,
        }, fh, indent=2)

    # When both arch files were supplied, also emit the merged metadata the front-end
    # consumes for the combined scene, so run_case.sh needs no extra step.
    combined_meta = os.path.join(web_dir, "tooth_meta_combined.json")
    merge_note = ""
    if args.mode == "combined" and len(active_entries) == 2:
        merge_meta_files([meta_path], combined_meta)
        merge_note = "written (single-pass combined)"

    n_imgs = len([n for n in os.listdir(img_dir) if n.endswith(".png")]) if os.path.isdir(img_dir) else 0
    rows = [
        file_row(frame_path),
        file_row(os.path.join(sparse_dir, "cameras.txt")),
        file_row(os.path.join(sparse_dir, "images.txt")),
        file_row(os.path.join(sparse_dir, "points3D.txt")),
        (f"{img_dir}/  ({n_imgs} PNGs)", n_imgs * 0),
        file_row(proxy_path),
        file_row(meta_path),
    ]
    if os.path.isfile(combined_meta):
        rows.append(file_row(combined_meta))
    print_artifacts(f"dental_pipeline_blender.py  mode={args.mode}  device={device}", rows)
    if merge_note:
        print(f"[NOTE] tooth_meta_combined.json {merge_note}")
    if args.mode in ("upper", "lower"):
        print(f"[NOTE] run the other arch with the SAME --out_dir so frame.json is reused, "
              f"then merge metadata with: python postprocess_dental_gs.py --merge_meta "
              f"{os.path.join(web_dir, 'tooth_meta_upper.json')} "
              f"{os.path.join(web_dir, 'tooth_meta_lower.json')} --out_dir {web_dir}")


main()
