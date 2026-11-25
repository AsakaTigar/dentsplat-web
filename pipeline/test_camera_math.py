#!/usr/bin/env python3
"""test_camera_math.py — the two matrix claims the Blender pipeline depends on, checked in isolation.

Both failures this guards against were only visible on the pipeline's first real run:

  * ``rotation_to_quaternion_wxyz`` diagonalised a 3x3 matrix and then unpacked four numbers from
    a three-vector, so every call raised (the run died at the first images.txt row);
  * the Blender camera was driven by ``to_track_quat('-Z', 'Y')`` while images.txt was written from
    ``look_at_world_to_camera``; at steep elevations the two disagreed by a 180 degree roll and the
    pose-consistency gate stopped the run (rot 2.00).

Run with any Python that has numpy (system python is fine; no bpy needed):

    python3 pipeline/test_camera_math.py
"""
from __future__ import annotations

import math
import sys

import numpy as np

from dental_lib import (
    M_G_FROM_B,
    S_CBL_FROM_CCV,
    look_at_world_to_camera,
    quat_wxyz_to_matrix,
    rotation_to_quaternion_wxyz,
)


def axis_angle(axis: np.ndarray, angle: float) -> np.ndarray:
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    k = np.array([[0.0, -a[2], a[1]], [a[2], 0.0, -a[0]], [-a[1], a[0], 0.0]])
    return np.eye(3) + math.sin(angle) * k + (1.0 - math.cos(angle)) * (k @ k)


def main() -> int:
    rng = np.random.default_rng(11)
    fails = 0

    def ok(cond: bool, msg: str) -> None:
        nonlocal fails
        print(("ok   " if cond else "FAIL ") + msg)
        if not cond:
            fails += 1

    worst = 0.0
    for _ in range(300):
        axis = rng.normal(size=3)
        R = axis_angle(axis, float(rng.uniform(-math.pi, math.pi)))
        q = rotation_to_quaternion_wxyz(R)
        worst = max(worst, float(np.max(np.abs(quat_wxyz_to_matrix(q) - R))), abs(float(np.dot(q, q)) - 1.0))
    ok(worst < 1e-6, f"quaternion round trip over 300 rotations (worst {worst:.2e})")
    ok(np.allclose(rotation_to_quaternion_wxyz(np.eye(3)), [1, 0, 0, 0], atol=1e-12), "identity -> (1,0,0,0)")
    # 180 deg is the branch that a naive implementation loses
    R180 = axis_angle(np.array([0.0, 1.0, 0.0]), math.pi)
    ok(np.allclose(quat_wxyz_to_matrix(rotation_to_quaternion_wxyz(R180)), R180, atol=1e-9), "180 deg about Y")

    # The Blender<->glTF map must be a proper rotation, and the camera pose must survive the round trip
    M_R = M_G_FROM_B[:3, :3]
    S = S_CBL_FROM_CCV[:3, :3]
    ok(abs(float(np.linalg.det(M_R)) - 1.0) < 1e-12, "det(M_G_FROM_B) == +1")
    ok(abs(float(np.linalg.det(S)) - 1.0) < 1e-12, "det(S_CBL_FROM_CCV) == +1")

    worst_t = worst_r = 0.0
    for _ in range(200):
        # camera on a sphere around the origin, elevation banded like the orbit, never exactly polar
        az = float(rng.uniform(0, 2 * math.pi))
        el = float(rng.uniform(-1.45, 1.45))
        r = float(rng.uniform(120, 200))
        pos = np.array([r * math.cos(el) * math.cos(az), r * math.sin(el), r * math.cos(el) * math.sin(az)])
        R_w2c, t_w2c = look_at_world_to_camera(pos, [0.0, 0.0, 0.0])
        # what the fixed pipeline does: drive Blender from the same look-at, then verify the recomposition
        R_b = np.linalg.inv(M_R) @ R_w2c.T @ S
        T_b = np.eye(4)
        T_b[:3, :3] = R_b
        pos_b = np.linalg.inv(M_G_FROM_B) @ np.append(pos, 1.0)
        T_b[:3, 3] = pos_b[:3]
        T_g = M_G_FROM_B @ T_b @ S_CBL_FROM_CCV
        T_c = np.linalg.inv(T_g)
        worst_r = max(worst_r, float(np.max(np.abs(T_c[:3, :3] - R_w2c))))
        worst_t = max(worst_t, float(np.max(np.abs(T_c[:3, 3] - t_w2c))))
    ok(worst_r < 1e-9, f"camera rotation round trip over 200 poses (worst {worst_r:.2e})")
    ok(worst_t < 1e-6, f"camera translation round trip over 200 poses (worst {worst_t:.2e})")

    print(f"\n{fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
