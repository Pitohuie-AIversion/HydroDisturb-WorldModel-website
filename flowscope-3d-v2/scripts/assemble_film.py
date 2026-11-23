"""Assemble the narrated FlowScope film from frame-timed website captures and Mandarin PCM."""
import argparse
import json
import re
import subprocess
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def inspect(probe, path):
    return json.loads(subprocess.check_output([
        str(probe), "-v", "error", "-show_streams", "-show_chapters", "-show_format",
        "-of", "json", str(path),
    ], encoding="utf-8"))


def clock_files(work, ffmpeg):
    voice = work / "voice"
    timeline = json.loads((voice / "timeline.json").read_text(encoding="utf-8"))
    fps = timeline["fps"]
    assert fps == 30 and len(timeline["chapterStarts"]) == 7
    out = work / "finished"
    out.mkdir(exist_ok=True)
    guide = dict(timeline["guide"], fps=fps, shots=[])
    end = 0
    chapters = []
    ids = set()
    for shot in timeline["shots"]:
        key, length = shot["id"], shot["frames"]
        assert re.fullmatch(r"[a-z0-9_.]+", key) and key not in ids
        ids.add(key)
        assert shot["startFrame"] == end and length > 0
        if not chapters or chapters[-1][0] != shot["chapter"]:
            chapters.append((shot["chapter"], end))
        captions = shot["subtitles"]
        assert all(end <= cue["startFrame"] < cue["endFrame"] <= end + length for cue in captions)
        guide["shots"].append(dict(id=key, chapter=shot["chapter"], startFrame=end, frames=length,
                                   subStarts=[c["startFrame"]-end for c in captions]))
        end += length
    assert [c[0] for c in chapters] == list(range(1,8))
    assert [c[1] for c in chapters] == timeline["chapterStarts"]
    assert end == timeline["totalFrames"]
    with wave.open(str(voice / "film.wav")) as pcm:
        assert pcm.getnframes()*fps == end*pcm.getframerate()
    (out / "guide.json").write_text(json.dumps(guide, ensure_ascii=False, indent=2), encoding="utf-8")
    audio = out / "guide.m4a"
    if not audio.exists() or audio.stat().st_mtime < (voice/"film.wav").stat().st_mtime:
        run(ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", voice / "film.wav",
            "-map", "0:a", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
            "-metadata:s:a:0", "language=zho", "-movflags", "+faststart", audio)
    return timeline


def encode(work, shot, fps, ffmpeg, ffprobe):
    name, n = shot["id"], shot["frames"]
    source = work / "shots" / (name+".mp4")
    motion = source.is_file()
    if not motion:
        source = source.with_suffix(".png")
    if not source.is_file():
        raise FileNotFoundError(f"Missing shot {name} in {work/'shots'}")
    segment = work / "segments" / (name+".mp4")
    if segment.exists() and segment.stat().st_mtime >= source.stat().st_mtime:
        if int(inspect(ffprobe, segment)["streams"][0]["nb_frames"]) == n:
            return segment
    inputs = ["-i", source] if motion else ["-framerate", str(fps), "-i", source]
    scale = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1"
    if motion:
        stream = inspect(ffprobe, source)["streams"][0]
        assert stream["width"] == 1920 and stream["height"] == 1080
        if name == "wake.play":
            assert int(stream["nb_frames"]) == n == 240 and stream["avg_frame_rate"] == "30/1"
        # Keep the original pacing of camera and feature motion. Hold its final state while a sentence finishes.
        vf = f"fps={fps},{scale},tpad=stop_mode=clone:stop={n}"
    else:
        from PIL import Image
        with Image.open(source) as image:
            assert image.size == (1920, 1080), (source, image.size)
        vf = f"{scale},tpad=stop_mode=clone:stop={n}"
    pending = segment.with_suffix(".next.mp4")
    run(ffmpeg, "-nostdin", "-loglevel", "error", "-y", *inputs, "-an", "-sn", "-filter_threads", "2",
        "-vf", vf, "-frames:v", n, "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
        "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-threads", "4", "-g", fps*2, "-video_track_timescale", "90000", pending)
    assert int(inspect(ffprobe,pending)["streams"][0]["nb_frames"]) == n
    pending.replace(segment)
    return segment


def assemble(work, ffmpeg, probe):
    doc = clock_files(work, ffmpeg)
    fps = doc["fps"]
    (work/"segments").mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        parts = list(pool.map(lambda s: encode(work,s,fps,ffmpeg,probe), doc["shots"]))
    playlist = work / "picture.ffconcat"
    lines = ["ffconcat version 1.0"]
    for part,shot in zip(parts,doc["shots"]):
        lines.extend([f"file 'segments/{part.name}'", f"duration {shot['frames']/fps:.9f}"])
    playlist.write_text("\n".join(lines)+"\n",encoding="ascii")
    ends = [*doc["chapterStarts"][1:],doc["totalFrames"]]
    lines = [";FFMETADATA1","title=FlowScope 3D · 流场世界模型","artist=深海智人"]
    for start,end,name in zip(doc["chapterStarts"],ends,doc["chapterNames"]):
        lines.extend(["[CHAPTER]", f"TIMEBASE=1/{fps}",f"START={start}",f"END={end}",f"title={name}"])
    metadata = work / "chapters.ffmeta"
    metadata.write_text("\n".join(lines)+"\n", encoding="utf-8")
    out = work / "finished"
    movie = out / "flowscope-demo.mp4"
    pending = movie.with_suffix(".next.mp4")
    run(ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", playlist,
        "-i", out/"guide.m4a", "-i", work/"voice/film.srt", "-f", "ffmetadata", "-i", metadata,
        "-map", "0:v", "-map", "1:a", "-map", "2:s", "-map_metadata", "3", "-map_chapters", "3",
        "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:a:0", "language=zho",
        "-metadata:s:s:0", "language=zho", "-metadata:s:s:0", "title=简体中文", "-disposition:s:0", "default",
        "-movie_timescale", "3000", "-movflags", "+faststart", pending)
    result = inspect(probe, pending)
    streams = {s["codec_type"]:s for s in result["streams"]}
    video = streams["video"]
    assert (video["codec_name"],video["width"],video["height"]) == ("h264",1920,1080)
    assert int(video["nb_frames"]) == doc["totalFrames"]
    for kind in ["audio", "video"]:
        assert abs(float(streams[kind]["duration"])-doc["totalFrames"]/fps) < 1/fps
    assert streams["subtitle"]["codec_name"] == "mov_text"
    assert len(result["chapters"]) == 7
    for chapter,start,end in zip(result["chapters"],doc["chapterStarts"],ends):
        assert abs(float(chapter["start_time"])-start/fps)<.002
        assert abs(float(chapter["end_time"])-end/fps)<.002
    pending.replace(movie)
    print(f"{movie} — {doc['totalFrames']} frames, {doc['totalFrames']/fps:.3f} seconds", flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work",type=Path,required=True)
    parser.add_argument("--ffmpeg",default="ffmpeg")
    parser.add_argument("--ffprobe",default="ffprobe")
    parser.add_argument("--clock-only",action="store_true")
    args=parser.parse_args()
    if args.clock_only:
        clock_files(args.work.resolve(),args.ffmpeg)
    else:
        assemble(args.work.resolve(),args.ffmpeg,args.ffprobe)
