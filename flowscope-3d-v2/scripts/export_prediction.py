"""Export one physical prediction on the C04 grid for the FlowScope rollout view."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CHANNELS = ("u", "v", "w", "p")


def strings(array: np.ndarray) -> list[str]:
    return [v.decode("utf-8") if isinstance(v, bytes) else str(v) for v in array.reshape(-1)]


def integer(archive, name: str) -> int:
    value = archive[name]
    if value.shape != () or value.dtype.kind not in "iu":
        raise ValueError(f"{name} must be a scalar integer")
    return int(value)


def export(prediction: Path, checkpoint: Path, data: Path, channel: str, out: Path) -> None:
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "flowscope.c04.volumes.v2":
        raise ValueError("Expected the FlowScope V2 C04 volume manifest")
    source_shape = tuple(manifest["grid_zyx"])
    if source_shape != (64, 96, 192):
        raise ValueError(f"Unexpected C04 ZYX grid {source_shape}")
    frame_index = {frame["step"]: frame for frame in manifest["frames"]}
    start = manifest["frames"][manifest.get("modelReferenceFrame", manifest["defaultFrame"])]["step"]
    digest = hashlib.sha256()
    with checkpoint.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    checkpoint_hash = digest.hexdigest()
    with np.load(prediction, allow_pickle=False) as a:
        step = integer(a, "step")
        if integer(a, "start_step") != start or not 0 <= step - start <= 100:
            raise ValueError(f"Forecast must start at step {start} and end within 100 solver steps")
        frame = frame_index.get(step)
        if frame is None or "1" not in frame["assets"]["volume"]:
            raise ValueError(f"The reference frame at step {step} needs an archived, full-resolution volume")
        time_s = a["time_s"]
        if time_s.shape != () or not np.isclose(float(time_s), frame["time_s"], rtol=0, atol=1e-6):
            raise ValueError("Prediction and reference time_s differ")
        if strings(a["channels"]) != list(CHANNELS):
            raise ValueError("Expected channel order u_stream, v_cross, w_span, p (keys u, v, w, p)")
        if strings(a["units"]) != [manifest["units"][c] for c in CHANNELS]:
            raise ValueError("Expected physical units m/s, m/s, m/s, Pa")
        for axis in "XYZ":
            expected = manifest["axes_m"][axis]
            actual = a[axis.lower() + "_m"]
            if actual.shape != (len(expected),) or not np.allclose(actual, expected, rtol=0, atol=1e-7):
                raise ValueError(f"{axis} grid coordinates differ from the C04 frame")
        volume = a["prediction"]
        if volume.shape != (4, *source_shape) or volume.dtype.kind != "f":
            raise ValueError("prediction must be a floating-point array with shape [4,64,96,192]")
        for key, expected in (("checkpoint_sha256", checkpoint_hash), ("truth_source_sha256", frame["source_sha256"])):
            if key in a and strings(a[key]) != [expected]:
                raise ValueError(f"{key} does not match the supplied artifact")
        mask_asset = frame["assets"]["masks"]["valid"]
        compressed = (data / mask_asset["path"]).read_bytes()
        if hashlib.sha256(compressed).hexdigest() != mask_asset["sha256"]:
            raise ValueError("The archived valid mask failed SHA-256 verification")
        packed = np.frombuffer(gzip.decompress(compressed), dtype="u1")
        valid = np.unpackbits(packed, bitorder="little", count=int(np.prod(source_shape))).reshape(source_shape).astype(bool)
        if "valid_mask" in a and not np.array_equal(a["valid_mask"], valid):
            raise ValueError("Predicted valid_mask differs from the archived mask")
        field = volume[CHANNELS.index(channel)]
        if not np.isfinite(field[valid]).all():
            raise ValueError(f"Nonfinite prediction inside the valid {channel} volume")
        slice_index = 32
        pixels = [float(x) if ok else None for x, ok in zip(field[slice_index].flat, valid[slice_index].flat)]
    payload = dict(
        schema="flowscope.forecast-slice.v1", channel=channel, unit=manifest["units"][channel],
        axis_order="YX", step=step, start_step=start, time_s=frame["time_s"],
        z_index=slice_index, shape_yx=list(source_shape[1:]), values=pixels,
        truth_source_sha256=frame["source_sha256"], checkpoint_sha256=checkpoint_hash,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=out.parent, delete=False) as temp:
        tmp = Path(temp.name)
    try:
        tmp.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--prediction", type=Path, required=True, help="Decoded physical prediction NPZ")
    p.add_argument("--checkpoint", type=Path, required=True, help="Checkpoint that produced this prediction")
    p.add_argument("--data", type=Path, default=(ROOT / "public" / "data" if (ROOT / "public" / "data" / "manifest.json").is_file() else ROOT / "data"), help="Directory of the packaged C04 manifest")
    p.add_argument("--channel", choices=CHANNELS, required=True)
    p.add_argument("--out", type=Path, required=True)
    export(**vars(p.parse_args()))

