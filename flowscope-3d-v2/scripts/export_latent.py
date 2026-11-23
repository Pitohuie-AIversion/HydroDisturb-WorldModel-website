"""Convert a clean encoder cache NPZ and its checkpoint to a single .fslat file."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile

import numpy as np

from export_prediction import integer, strings


ROOT = Path(__file__).resolve().parents[1]


def export(cache: Path, checkpoint: Path, data: Path, out: Path) -> None:
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "flowscope.c04.volumes.v2":
        raise ValueError("Expected the FlowScope V2 C04 manifest")
    digest = hashlib.sha256()
    with checkpoint.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    checkpoint_sha256 = digest.hexdigest()
    with np.load(cache, allow_pickle=False) as archive:
        field = archive["z_clean"]
        if field.shape != (256, 8, 12, 24) or field.dtype.kind != "f" or not np.isfinite(field).all():
            raise ValueError("Expected one finite z_clean in CZYX [256,8,12,24]")
        if archive["training_noise"].shape != () or archive["training_noise"].dtype.kind != "b" or bool(archive["training_noise"]):
            raise ValueError("Export clean latents with training_noise=False")
        norm = strings(archive["rmsnorm"])
        if norm not in (["per_token_no_affine"], ["off_ablation"]):
            raise ValueError("Specify per_token_no_affine or off_ablation in the NPZ rmsnorm field")
        step = integer(archive, "step")
        frame = next((item for item in manifest["frames"] if item["step"] == step), None)
        if not frame or archive["time_s"].shape != () or not np.isclose(float(archive["time_s"]), frame["time_s"], rtol=0, atol=1e-6):
            raise ValueError("The source step or physical time differs from the C04 archive")
        for key, expected in (("source_sha256", frame["source_sha256"]), ("checkpoint_sha256", checkpoint_sha256)):
            if strings(archive[key]) != [expected]:
                raise ValueError(f"Cache provenance differs at {key}")
        values = np.ascontiguousarray(field, dtype="<f4")
        if not np.isfinite(values).all():
            raise ValueError("Value outside FP32 range")
        payload = values.tobytes()
    header = dict(
        schema="flowscope.clean-latent.v1", dataset="C04", name="z_clean", layout="CZYX",
        shape=[256, 8, 12, 24], dtype="float32_le", unit="1", training_noise=False,
        step=step, time_s=frame["time_s"], source_sha256=frame["source_sha256"],
        checkpoint_sha256=checkpoint_sha256, rmsnorm=norm[0], payload_sha256=hashlib.sha256(payload).hexdigest(),
    )
    header_json = json.dumps(header, separators=(",", ":"), allow_nan=False).encode("utf-8")
    header_json += b" " * (-len(header_json) % 4)
    out.parent.mkdir(parents=True, exist_ok=True)
    temp = tempfile.NamedTemporaryFile(dir=out.parent, delete=False)
    try:
        with temp:
            temp.write(b"FSLAT2\r\n" + struct.pack("<I", len(header_json)) + header_json)
            temp.write(payload)
        os.replace(temp.name, out)
    finally:
        Path(temp.name).unlink(missing_ok=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cache", type=Path, required=True, help="Offline encoder output NPZ")
    p.add_argument("--checkpoint", type=Path, required=True, help="Frozen encoder checkpoint")
    p.add_argument("--data", type=Path, default=(ROOT / "public" / "data" if (ROOT / "public" / "data" / "manifest.json").is_file() else ROOT / "data"))
    p.add_argument("--out", type=Path, required=True, help="Destination .fslat")
    export(**vars(p.parse_args()))

