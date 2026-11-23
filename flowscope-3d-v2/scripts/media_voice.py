"""Build frame-locked Mandarin narration, subtitle tracks and shot timings offline.

Usage: python scripts/media_voice.py --out PATH
Visual exports consume timeline.json after it appears in the output directory.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import tempfile
import wave

import numpy as np
from scipy.signal import resample_poly
import win32com.client


FPS = 30
RATE = 48000
SAMPLES_PER_FRAME = RATE // FPS
SILENCE = bytes(SAMPLES_PER_FRAME * 2)


class Speaker:
    def __init__(self, temp: Path):
        self.temp = temp
        self.voice = win32com.client.Dispatch("SAPI.SpVoice")
        mandarin = [token for token in self.voice.GetVoices()
                    if "804" in token.GetAttribute("Language").lower().split(";")]
        if not mandarin:
            raise RuntimeError("A Simplified Chinese SAPI voice is required.")
        self.voice.Voice = mandarin[0]
        self.voice.Rate, self.voice.Volume = 1, 100
        self.name = self.voice.Voice.GetDescription()

    def render(self, name: str, text: str) -> np.ndarray:
        file = self.temp / (name + ".wav")
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        stream.Open(str(file), 3, False)
        try:
            self.voice.AudioOutputStream = stream
            self.voice.Speak(text)
        finally:
            stream.Close()
        with wave.open(str(file), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError(f"Expected mono PCM16: {file}")
            src_rate = wav.getframerate()
            data = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype("float32")
        active = np.flatnonzero(np.abs(data) > 16)
        if not len(active):
            raise ValueError(f"TTS emitted empty audio for {name}")
        # Replace variable engine lead/tail silence with explicit frame timing.
        data = data[max(0, active[0] - src_rate // 50):active[-1] + 1 + src_rate // 20]
        common = math.gcd(src_rate, RATE)
        high = resample_poly(data, RATE // common, src_rate // common)
        return np.rint(np.clip(high, -32767, 32767)).astype("<i2")


def stamp(frame: int, sep: str = "."):
    ms = round(frame * 1000 / FPS)
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def write_subtitles(output: Path, subtitles: list[dict], vtt: bool):
    lines = ["WEBVTT", ""] if vtt else []
    sep = "." if vtt else ","
    for i, cue in enumerate(subtitles, 1):
        lines.extend([str(i), stamp(cue["startFrame"], sep) + " --> " + stamp(cue["endFrame"], sep),
                      cue["text"], ""])
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(script: Path, output: Path):
    chapters = json.loads(script.read_text(encoding="utf-8"))
    ids = [shot[0] for chapter in chapters for shot in chapter["shots"]]
    if len(chapters) != 7 or len(ids) != len(set(ids)):
        raise ValueError("Each of the seven chapters needs unique shot IDs.")
    output.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix="render-", dir=output))
    speaker = Speaker(staged)
    starts, shots, subtitles = [], [], []
    frame = 0
    md = ["# FlowScope 3D · 新版成片旁白", "",
          "按成片时间码排列。首章首轮回放覆盖 C04 的全部 81 个归档时刻，"
          "物理时间从 0 到 60 秒。第六章跟踪教学算例的 D0 分量，八步共预测一个物理步。", ""]
    with wave.open(str(staged / "film.wav"), "wb") as track:
        track.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        for chapter_index, chapter in enumerate(chapters, 1):
            starts.append(frame)
            md.extend([f'## {chapter_index:02d}　{chapter["title"]}　{stamp(frame)}', ""])
            for id_, action, lines in chapter["shots"]:
                start = frame
                shot_subs = []
                speech_lines = []
                lead = 5
                track.writeframesraw(SILENCE * lead)
                frame += lead
                for n, (spoken, displayed) in enumerate(lines):
                    wave_data = speaker.render(f"{id_}-{n+1}", spoken)
                    voice_frames = math.ceil(len(wave_data) / SAMPLES_PER_FRAME)
                    end = frame + voice_frames
                    cue = dict(shot=id_, chapter=chapter_index, startFrame=frame, endFrame=end,
                               text=displayed, spoken=spoken)
                    subtitles.append(cue)
                    shot_subs.append(cue)
                    speech_lines.append(spoken)
                    track.writeframesraw(wave_data.tobytes())
                    track.writeframesraw(bytes((voice_frames * SAMPLES_PER_FRAME - len(wave_data))*2))
                    frame = end
                    if n+1 < len(lines):
                        track.writeframesraw(SILENCE * 5)
                        frame += 5
                tail = 9
                if id_ == "wake.play":
                    tail = start + 8 * FPS - frame
                    if tail < 0:
                        raise ValueError(f"Wake narration overran the 8 second playback by {-tail} frames")
                track.writeframesraw(SILENCE * tail)
                frame += tail
                shots.append(dict(id=id_, chapter=chapter_index, startFrame=start, frames=frame-start,
                                  action=action, text="".join(speech_lines), subtitles=shot_subs))
                md.extend([f'**{stamp(start)}　{action}**', "", "".join(speech_lines), ""])
            print(f'{chapter_index:02d}  {chapter["title"]}  {stamp(starts[-1])} -> {stamp(frame)}', flush=True)
    timeline = dict(fps=FPS, audioRate=RATE, voice=speaker.name, totalFrames=frame,
                    chapterNames=[c["title"] for c in chapters], chapterStarts=starts,
                    guide=dict(starts=[f/FPS for f in starts], duration=frame/FPS),
                    shots=shots, subtitles=subtitles)
    (staged/"timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
    (staged/"narration.md").write_text("\n".join(md), encoding="utf-8")
    write_subtitles(staged / "film.vtt", subtitles, vtt=True)
    write_subtitles(staged / "film.srt", subtitles, vtt=False)
    with wave.open(str(staged / "film.wav")) as track:
        assert track.getnframes() == frame*SAMPLES_PER_FRAME
    for name in ("film.wav","film.vtt","film.srt","narration.md","timeline.json"):
        os.replace(staged/name, output/name)
    return timeline


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--script", type=Path, default=Path(__file__).with_name("film_script.json"))
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    build(args.script, args.out.resolve())
