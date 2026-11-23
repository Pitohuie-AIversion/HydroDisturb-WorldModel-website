"""Bake the four default Z=32 thumbnails from checked C04 volume assets."""
from pathlib import Path
import gzip
import hashlib
import io
import json

import numpy as np
from PIL import Image


project = Path(__file__).resolve().parents[1]
data = project / "public" / "data"
output = project / "public" / "assets" / "slices"
channels = ("u", "v", "w", "p")


def main():
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    palette = np.array([
        [int(color[i:i + 2], 16) for i in (1, 3, 5)] for color in manifest["palette"]
    ])
    frames = {}
    for frame in manifest["frames"]:
        levels = frame["assets"]["volume"]
        lod = min(map(int, levels))
        nz, ny, nx = [n // lod for n in manifest["grid_zyx"]]
        panels = []
        for channel in channels:
            asset = levels[str(lod)][channel]
            packed = (data / asset["path"]).read_bytes()
            assert hashlib.sha256(packed).hexdigest() == asset["sha256"], asset["path"]
            array = np.frombuffer(gzip.decompress(packed), dtype="<f4" if lod == 1 else "<f2")
            field = array.reshape(nz, ny, nx)[32 // lod, ::-1, :].astype(np.float64)
            low, high = manifest["display_ranges"][channel]
            valid = np.isfinite(field)
            intensity = np.clip(np.where(valid, (field-low) / (high-low), 0), 0, 1)
            bin_position = intensity * (len(palette) - 1)
            left = np.minimum(bin_position.astype(np.int32), len(palette) - 2)
            fraction = (bin_position-left)[:, :, None]
            # Use the browser's segment arithmetic and Uint8ClampedArray
            # round-to-even rule, including exact half-way channel values.
            rgb = palette[left] + fraction * (palette[left+1]-palette[left])
            rgb[~valid] = (65, 78, 75)
            panels.append(np.rint(rgb).astype(np.uint8))
        sheet = np.concatenate(panels, axis=1)
        image = io.BytesIO()
        Image.fromarray(sheet).save(image, format="PNG")
        payload = image.getvalue()
        assert np.array_equal(np.asarray(Image.open(io.BytesIO(payload))), sheet)
        name = f"{frame['step']:04d}.png"
        (output / name).write_bytes(payload)
        frames[frame["step"]] = {
            "path": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
            "source_sha256": frame["source_sha256"], "lod": lod, "width": nx, "height": ny,
        }
    index = {"schema": "flowscope.c04.midplane.v1", "z": 32, "channels": channels, "frames": frames}
    (output / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"{len(frames)} verified C04 preview strips, {sum(item['bytes'] for item in frames.values()):,} PNG bytes")


if __name__ == "__main__":
    main()
