"""Independently audit every default inspector thumbnail against its scalar plane."""
import gzip
import hashlib
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image


assets = Path(__file__).resolve().parents[1] / "public"
data = assets / "data"
previews = assets / "assets" / "slices"


def checked(root, asset):
    packed = (root / asset["path"]).read_bytes()
    if len(packed) != asset["bytes"] or hashlib.sha256(packed).hexdigest() != asset["sha256"]:
        raise ValueError(f"Asset integrity mismatch: {asset['path']}")
    return packed


def main():
    manifest = json.loads((data / "manifest.json").read_bytes())
    index = json.loads((previews / "index.json").read_bytes())
    colors = [tuple(bytes.fromhex(code[1:])) for code in manifest["palette"]]
    pixels = masked = 0
    assert index["channels"] == ["u", "v", "w", "p"] and index["z"] == 32
    assert len(index["frames"]) == len(manifest["frames"])
    for frame in manifest["frames"]:
        thumbnail = index["frames"][str(frame["step"])]
        strip = np.asarray(Image.open(BytesIO(checked(previews, thumbnail))))
        lod = min(map(int, frame["assets"]["volume"]))
        nz, ny, nx = [n // lod for n in manifest["grid_zyx"]]
        assert (thumbnail["source_sha256"], thumbnail["lod"]) == (frame["source_sha256"], lod)
        assert (thumbnail["width"], thumbnail["height"], strip.shape) == (nx, ny, (ny, 4*nx, 3))
        for pos, channel in enumerate(index["channels"]):
            packed = checked(data, frame["assets"]["volume"][str(lod)][channel])
            values = np.frombuffer(gzip.decompress(packed), dtype="<f4" if lod == 1 else "<f2")
            plane = values.reshape(nz, ny, nx)[32 // lod, ::-1]
            actual = strip[:, pos*nx:(pos+1)*nx]
            valid = np.isfinite(plane)
            assert np.all(actual[~valid] == [65, 78, 75])
            # Build a scalar reference for each unique displayed value, using
            # Python round-to-even for the browser's clamped 8-bit channels.
            unique, lookup = np.unique(plane[valid], return_inverse=True)
            low, high = manifest["display_ranges"][channel]
            rgb = []
            for scalar in unique:
                t = min(1., max(0., (float(scalar)-low)/(high-low))) * (len(colors)-1)
                left = min(int(t), len(colors)-2)
                first, last = colors[left:left+2]
                rgb.append([round(a+(t-left)*(b-a)) for a, b in zip(first, last)])
            expected = np.asarray(rgb, dtype=np.uint8)[lookup]
            if not np.array_equal(actual[valid], expected):
                raise ValueError(f"Pixel mismatch at step {frame['step']}, channel {channel}")
            pixels += nx*ny
            masked += int(np.count_nonzero(~valid))
    print(f"All {pixels:,} RGB pixels matched, including {masked:,} masked pixels.")


if __name__ == "__main__":
    main()
