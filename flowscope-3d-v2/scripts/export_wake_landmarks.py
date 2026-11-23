"""Track two signed vorticity maxima in the archived Z=32 plane at stride 2."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import maximum_filter


def export():
    public = Path(__file__).resolve().parents[1] / "public"
    data = public / "data"
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    stride = 2
    z = 32
    x, y = [np.array(manifest["axes_m"][a][::stride]) for a in ("X", "Y")]
    landmarks = []
    for start, stop, sign in [(835, 847, 1), (851, 867, -1)]:
        previous = None
        for frame in manifest["frames"]:
            step = frame["step"]
            if not start <= step <= stop:
                continue
            def plane(channel):
                asset = frame["assets"]["volume"][str(stride)][channel]
                packed = (data / asset["path"]).read_bytes()
                assert hashlib.sha256(packed).hexdigest() == asset["sha256"]
                field = np.frombuffer(gzip.decompress(packed), dtype="<f2").reshape(-1, len(y), len(x))
                return field[z // stride].astype("float32")
            omega = np.gradient(plane("v"), x, axis=1) - np.gradient(plane("u"), y, axis=0)
            signed = sign * omega
            maxima = (signed >= maximum_filter(np.nan_to_num(signed), size=5)) & (signed > 3)
            maxima &= (-sign * y[:, None] > 0) & (np.abs(y[:, None]) < 0.3)
            if previous is None:
                maxima &= (x[None, :] >= 0.35) & (x[None, :] <= 0.5)
                score = signed
            else:
                distance = np.hypot(x[None, :] - previous[0], y[:, None] - previous[1])
                maxima &= distance < 0.12
                score = -distance
            if not maxima.any():
                raise ValueError(f"Cannot follow vorticity maximum at {step}")
            row, col = np.unravel_index(np.argmax(np.where(maxima, score, -np.inf)), score.shape)
            previous = (float(x[col]), float(y[row]))
            if step in (start, stop):
                landmarks.append(dict(step=step, x=col.item()*stride, y=row.item()*stride,
                                      x_m=round(previous[0], 3), y_m=round(previous[1], 3),
                                      omega_z=round(float(omega[row, col]), 2)))
    assert len(landmarks) == 4
    target = public / "assets" / "wake-landmarks.json"
    target.write_text(json.dumps(dict(z=z, stride=stride, landmarks=landmarks), indent=2), encoding="utf-8")


if __name__ == "__main__":
    export()
