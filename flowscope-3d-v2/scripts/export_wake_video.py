"""Build the chapter-one fallback from the two archived fixed-view C04 PNG sequences.

Usage: python scripts/export_wake_video.py --archive <video_c04_shedding> --ffmpeg <ffmpeg>
"""
import argparse
import json
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageChops


PROJECT = Path(__file__).resolve().parents[1]
# Both 1500 × 900 dashboards put the same 3D axes and fixed colour bar here.
VIEW = (826, 70, 1500, 648)


def volume_view(path):
    with Image.open(path) as image:
        if image.size != (1500, 900):
            raise ValueError(f"Unexpected C04 dashboard size in {path}")
        return image.crop(VIEW).convert("RGB")


def archive_images(archive, frames):
    # The original lifecycle reel includes every fourth dense snapshot. The
    # fixed-view shedding reel includes all 26 consecutive steps from 835 to 885.
    dense_indices = [i for i, f in enumerate(frames) if 835 <= f["step"] <= 885]
    dense_steps = [frames[i]["step"] for i in dense_indices]
    if dense_steps != list(range(835, 886, 2)):
        raise ValueError("The archived dense C04 sequence does not match the manifest")
    lifecycle_indices = [i for i in range(len(frames)) if i not in dense_indices or i in dense_indices[::4]]

    def sequence(directory, indices):
        images = sorted((archive / directory).glob("frame_*.png"))
        return dict(zip(indices, images, strict=True))

    lifecycle = sequence("lifecycle_frames_3d", lifecycle_indices)
    shedding = sequence("time_frames_3d", dense_indices)
    for i in lifecycle.keys() & shedding.keys():
        if ImageChops.difference(volume_view(lifecycle[i]), volume_view(shedding[i])).getbbox():
            raise ValueError(f"Archive clocks or cameras disagree at step {frames[i]['step']}")
    return [p for _,p in sorted((lifecycle | shedding).items())]


def export_compact(images, ffmpeg, output, fps):
    # Each 100 ms transition begins on an unchanged archive image at either rate.
    if len(images) != 81:
        raise ValueError("The eight-second C04 sequence requires all 81 archives")
    steps = fps // 10
    with tempfile.TemporaryDirectory() as tmp:
        movie = Path(tmp) / "compact.mp4"
        prev = volume_view(images[0])
        with subprocess.Popen([str(ffmpeg), "-hide_banner", "-loglevel", "error",
                               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{prev.width}x{prev.height}",
                               "-framerate", str(fps), "-i", "pipe:0", "-an", "-c:v", "libx264",
                               "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "17",
                               "-g", str(fps), "-movflags", "+faststart", str(movie)], stdin=subprocess.PIPE) as process:
            for path in images[1:]:
                following = volume_view(path)
                for tick in range(steps):
                    picture = prev if tick == 0 else Image.blend(prev, following, tick / steps)
                    process.stdin.write(picture.tobytes())
                prev = following
            process.stdin.write(prev.tobytes())
            process.stdin.close()
            if process.wait():
                raise RuntimeError("Unable to encode the compact wake movie")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(movie.read_bytes())


def export(archive, manifest, ffmpeg, output, compact_output, compact_only=False):
    frames = json.loads(manifest.read_text(encoding="utf-8"))["frames"]
    times_ms = [round(f["time_s"] * 1000) for f in frames]
    if times_ms[0] != 0 or times_ms[-1] != 60000 or len(set(times_ms)) != len(frames):
        raise ValueError("Expected unique C04 snapshots from 0 s through 60 s")
    images = archive_images(archive, frames)
    export_compact(images, ffmpeg, compact_output, 60)
    export_compact(images, ffmpeg, compact_output.with_stem(compact_output.stem + "-120"), 120)
    if compact_only:
        return

    with tempfile.TemporaryDirectory() as tmp:
        build = Path(tmp)
        playlist = ["ffconcat version 1.0"]
        for i, path in enumerate(images):
            name = f"step-{frames[i]['step']}.png"
            volume_view(path).save(build / name, compress_level=1)
            # The PNG demuxer's 20 ms time base preserves every archive timestamp.
            playlist.extend([f"file '{name}'", "option framerate 50"])
            if i + 1 < len(frames):
                delta = times_ms[i + 1] - times_ms[i]
                if delta <= 0 or delta % 20:
                    raise ValueError("Invalid physical interval for the 50 Hz time base")
                playlist.append(f"duration {delta / 1000:.3f}")
        (build / "frames.txt").write_text("\n".join(playlist) + "\n", encoding="ascii")
        subprocess.run([str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-f", "concat", "-safe", "0", "-i", "frames.txt", "-an",
                        "-vf", "fps=50/3:start_time=0:round=near:eof_action=pass",
                        "-frames:v", str(times_ms[-1] // 60 + 1),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow",
                        "-crf", "18", "-g", "50", "-bf", "0",
                        "-video_track_timescale", "1000", "-movflags", "+faststart",
                        "wake.mp4"], cwd=build, check=True)
        # Check every encoded packet PTS before replacing a usable movie.
        checksum = subprocess.check_output([str(ffmpeg), "-v", "error", "-i", "wake.mp4",
                                            "-map", "0:v:0", "-c:v", "copy", "-f", "framecrc", "-"],
                                           cwd=build, text=True)
        timebase = Fraction(next(line.split(":", 1)[1].strip() for line in checksum.splitlines()
                                 if line.startswith("#tb 0:")))
        packet_times = [int(line.split(",")[2]) * timebase * 1000
                        for line in checksum.splitlines() if line.startswith("0,")]
        # The 60 ms display cadence keeps low-power browser decoders primed in
        # the sparse stretches. Between captures the previous image is repeated.
        if packet_times != list(range(0, 60001, 60)) or not set(times_ms).issubset(packet_times):
            raise ValueError(f"Incorrect encoded timeline: {len(packet_times)} packets, last {packet_times[-1]} ms")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes((build / "wake.mp4").read_bytes())
        print(f"{len(frames)} C04 frames, t = 0.00 to 60.00 s, {output.stat().st_size} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, default=PROJECT / "public/data/manifest.json")
    parser.add_argument("--output", type=Path, default=PROJECT / "public/assets/wake-0-60.mp4")
    parser.add_argument("--compact-output", type=Path, default=PROJECT / "public/assets/wake-compact.mp4")
    parser.add_argument("--compact-only", action="store_true")
    args = parser.parse_args()
    export(args.archive, args.manifest, args.ffmpeg.resolve(), args.output, args.compact_output, args.compact_only)
