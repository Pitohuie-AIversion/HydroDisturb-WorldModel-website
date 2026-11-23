"""Generate a teaching forecast by transporting a single archived C04 state.

The velocity used for transport is prescribed and frozen. All four fields are
passive scalars in this exercise, including pressure. No future truth arrays
or model weights participate in the forecast.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt, map_coordinates


CHANNELS = ("u", "v", "w", "p")
MIDPLANE = 32
VOLUME_STEP = 10
HORIZON = 100


def read_asset(root: Path, asset: dict) -> bytes:
    data = (root / asset["path"]).read_bytes()
    if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise ValueError(f"Invalid C04 asset: {asset['path']}")
    return gzip.decompress(data)


def smoothstep(fraction):
    t = np.clip(fraction, 0, 1)
    return t * t * (3 - 2 * t)


def sample(field, positions):
    return map_coordinates(field, positions, order=1, mode="nearest", prefilter=False)


def generate(root: Path, out: Path) -> None:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    initial = manifest["frames"][manifest["modelReferenceFrame"]]
    start_step = initial["step"]
    start_time = initial["time_s"]
    first, last = manifest["frames"][0], manifest["frames"][-1]
    dt = (last["time_s"] - first["time_s"]) / (last["step"] - first["step"])
    shape = tuple(manifest["grid_zyx"])
    axis = {key: np.array(values, dtype=np.float32) for key, values in manifest["axes_m"].items()}
    spacing = {key: (values[-1] - values[0]) / (len(values) - 1) for key, values in axis.items()}
    volumes = np.stack([
        np.frombuffer(read_asset(root, initial["assets"]["volume"]["1"][ch]), dtype="<f4").reshape(shape)
        for ch in CHANNELS
    ])
    valid = np.unpackbits(
        np.frombuffer(read_asset(root, initial["assets"]["masks"]["valid"]), dtype="u1"),
        bitorder="little", count=int(np.prod(shape)),
    ).reshape(shape).astype(bool)
    if not np.array_equal(np.isfinite(volumes), np.broadcast_to(valid, volumes.shape)):
        raise ValueError("Initial fields and valid mask disagree")
    # Extend fluid values into the solid only for interpolation at the interface.
    # The published result always restores the original cylinder mask.
    nearest = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = [field[tuple(nearest)] for field in volumes]
    diam = float(manifest["reference"]["diameter_m"])
    speed = float(manifest["reference"]["U0_m_s"])
    x = axis["X"][None, None, :]
    y = axis["Y"][None, :, None]
    wake = smoothstep((x - diam / 2) / (1.5 * diam))
    edge = smoothstep((max(abs(axis["Y"])) - abs(y)) / (.5 * diam))
    mobility = wake * edge
    # Grid-cell displacements per physical step, ordered as the array axes Z,Y,X.
    increments = [
        np.clip(field, -speed, speed) * .2 * mobility * dt / spacing[key]
        for field, key in ((filled[2], "Z"), (filled[1], "Y"))
    ]
    increments.append(np.broadcast_to(.68 * speed * mobility * dt / spacing["X"], shape))
    rows, cols = np.indices(shape[1:], dtype=np.float32)
    frames = []
    snapshot = np.empty_like(volumes)
    out.mkdir(parents=True, exist_ok=True)

    for z in range(shape[0]):
        positions = np.stack((np.full_like(rows, z), rows, cols))
        limit = HORIZON if z == MIDPLANE else VOLUME_STEP
        for k in range(limit + 1):
            if z == MIDPLANE or k == VOLUME_STEP:
                plane = (volumes[:, z].copy() if k == 0 else
                         np.stack([sample(field, positions) for field in filled]))
                plane[:, ~valid[z]] = np.nan
                if k == VOLUME_STEP:
                    snapshot[:, z] = plane
                if z == MIDPLANE:
                    blob = gzip.compress(plane.astype("<f4", copy=False).tobytes(), compresslevel=5, mtime=0)
                    name = f"{start_step + k}.f32.gz"
                    (out / name).write_bytes(blob)
                    frames.append(dict(k=k, step=start_step+k, time_s=round(start_time+k*dt, 8),
                                       path=name, sha256=hashlib.sha256(blob).hexdigest(), bytes=len(blob)))
            if k < limit:
                # Midpoint backtrace through a frozen three-dimensional velocity.
                mid = positions - .5 * np.stack([sample(field, positions) for field in increments])
                positions -= np.stack([sample(field, mid) for field in increments])
                for coord, extent in zip(positions, shape):
                    np.clip(coord, 0, extent-1, out=coord)

    volume_name = f"step-{start_step + VOLUME_STEP:04d}-volume.npz"
    volume_path = out / volume_name
    units = [manifest["units"][ch] for ch in CHANNELS]
    method = "冻结起始帧的三维输运速度，以中点法沿流线回溯，三线性采样起始场的 u、v、w、p。"
    np.savez_compressed(
        volume_path, prediction=snapshot, valid_mask=valid, x_m=axis["X"], y_m=axis["Y"], z_m=axis["Z"],
        channels=CHANNELS, units=units, start_step=start_step, step=start_step+VOLUME_STEP,
        time_s=start_time+VOLUME_STEP*dt, provenance="synthetic-passive-transport", method=method,
        initial_source_sha256=initial["source_sha256"],
    )
    info = dict(
        schema="flowscope.simulated-rollout.v1", provenance="synthetic-passive-transport",
        method=method, source_sha256=initial["source_sha256"], start_step=start_step,
        dt_s=dt, start_time_s=start_time, grid_zyx=shape, z_index=MIDPLANE, shape_yx=shape[1:],
        channels=CHANNELS, units=units, encoding="gzip, little-endian float32 [channel,Y,X]; invalid=NaN",
        volume=dict(path=volume_name, k=VOLUME_STEP, sha256=hashlib.sha256(volume_path.read_bytes()).hexdigest(),
                    bytes=volume_path.stat().st_size), frames=frames,
    )
    (out / "manifest.json").write_text(json.dumps(info, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parents[1] / "public/data")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    generate(args.data, args.out or args.data / "simulated-rollout")
