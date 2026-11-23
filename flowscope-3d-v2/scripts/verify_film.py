"""Independently compare the distributed film with the browser captures, source PCM and cue sheet."""
import argparse
import json
import re
import subprocess
import wave
from fractions import Fraction
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.signal import correlate


W, H = 384, 216


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def run(*args):
    try:
        return subprocess.check_output([str(arg) for arg in args], stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.stderr.decode("utf-8",errors="replace")[-1800:]) from None


def probe(exe, *args):
    return json.loads(run(exe, "-v", "error", "-of", "json", *args))


def frame_filter(numbers):
    # Compress contiguous ranges for the decoder, retaining exact frame indices.
    intervals = []
    for index in sorted(numbers):
        if intervals and index == intervals[-1][1] + 1:
            intervals[-1][1] = index
        else:
            intervals.append([index, index])
    terms=[f"eq(n,{a})" if a == b else f"between(n,{a},{b})" for a,b in intervals]
    # Keep FFmpeg's expression stack shallow for hundreds of validations.
    while len(terms)>1:
        terms=["("+"+".join(terms[i:i+6])+")" for i in range(0,len(terms),6)]
    return terms[0]


def frames(ffmpeg, path, numbers):
    order = sorted(set(numbers))
    vf = f"select='{frame_filter(order)}',scale={W}:{H}:flags=area:out_range=pc,format=rgb24"
    raw = run(ffmpeg, "-v", "error", "-threads", "4", "-i", path, "-map", "0:v:0", "-vf", vf,
              "-fps_mode", "passthrough", "-frames:v",str(len(order)),"-threads", "2", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
    pictures = np.frombuffer(raw, np.uint8).reshape(-1,H,W,3)
    assert len(pictures) == len(order), (path, len(order),len(pictures))
    return dict(zip(order, pictures))


def source_image(path):
    with Image.open(path) as im:
        assert im.size == (1920,1080), path
        return np.asarray(im.convert("RGB").resize((W,H), Image.Resampling.BOX))


def compare_frame(actual, reference, context):
    error = actual.astype(np.int16) - reference.astype(np.int16)
    mae = float(np.abs(error).mean())
    # Display RGB from the recoded limited-range BT.709 may carry a small
    # uniform offset. Bound that offset separately from spatial mismatches.
    bias = np.median(error[::4,::4],axis=(0,1))
    diff = np.abs(error-bias)
    # A mismatched state can occupy just one small readout in a large shared hero.
    tiles = diff.reshape(12,H//12,16,W//16,3).mean(axis=(1,3,4))
    worst = float(tiles.max())
    assert mae < 6.0 and abs(bias).max()<=6 and diff.mean()<2.5 and worst<11.0, (
        f"{context}: RGB mean error {mae:.2f}, RGB offset {bias.tolist()}, worst tile {worst:.2f}")
    return mae, worst


def verify_picture(ffmpeg, ffprobe, work, movie, timeline):
    expected = {}
    sample_ids = {}
    originals = work / "wake-fm-work"
    for shot in timeline["shots"]:
        name,start,length = shot["id"],shot["startFrame"],shot["frames"]
        ids = {0, length//2, length-1}
        for sub in shot["subtitles"]:
            ids.update({sub["startFrame"] - start,(sub["startFrame"]+sub["endFrame"])//2 - start})
        if name=="wake.play":
            assert length == 240
            ids.update(range(length))
        if name.startswith("fm.step"):
            second=shot["subtitles"][1]["startFrame"]-start
            ids.update({second-1,second, max(0,length-30)})
        sample_ids[name]=sorted(ids)
        video=work/"shots"/(name+".mp4")
        if video.is_file():
            src_frames=int(probe(ffprobe,"-select_streams","v:0","-show_entries","stream=nb_frames",video)["streams"][0]["nb_frames"])
            # Encoded shot motion runs at native 30 Hz; the last image then holds.
            local={i:min(i,src_frames-1) for i in ids}
            pictures=frames(ffmpeg,video,local.values())
            expected.update({start+i:pictures[n] for i,n in local.items()})
        else:
            picture=source_image(work/"shots"/(name+".png"))
            expected.update({start+i:picture for i in ids})
    print(f"Decoding {len(expected)} selected frames from the final film…",flush=True)
    actual=frames(ffmpeg,movie,expected)
    by_shot={}
    for shot in timeline["shots"]:
        name,start=shot["id"],shot["startFrame"]
        metrics=[compare_frame(actual[start+i],expected[start+i],f"{name} frame {i}") for i in sample_ids[name]]
        by_shot[name]={"sampleCount":len(metrics),"maxMAE":round(max(m[0] for m in metrics),3),
                       "maxTileMAE":round(max(m[1] for m in metrics),3)}

    shots={s["id"]:s for s in timeline["shots"]}
    weld=shots["wake.play"]["startFrame"]
    archive=read_json(Path(__file__).resolve().parents[1]/"public/data/manifest.json")["frames"]
    audit=read_json(originals/"wake-audit.json")
    assert len(audit)==len(archive)==81
    assert audit[0]["physical_s"]==0 and audit[-1]["physical_s"]==60
    assert audit[0]["videoFrame"]==0
    # The independent evidence is the original timestamped browser still for each
    # C04 archive and interpolation, before either shot encoding or final mux.
    archive_peak=0.
    previous=None
    for i,(observed,source) in enumerate(zip(audit,archive)):
        assert observed["step"]==source["step"] and abs(observed["physical_s"]-source["time_s"])<1e-7
        n=observed["videoFrame"]
        end=audit[i+1]["videoFrame"] if i+1<len(audit) else 240
        assert end>n
        if i+1<len(audit):
            assert end-n==1+len(observed["intermediate"])
        for j in range(end-n):
            file=originals/f"wake-{i:02d}-{j if i+1<len(audit) else 0}.jpg"
            reference=source_image(file)
            target=actual[weld+n+j]
            mae,_=compare_frame(target,reference,f"original C04 {i}/{j}")
            archive_peak=max(archive_peak,mae)
            if previous is not None:
                ref=reference.astype(np.int16)
                diff=np.abs(ref-previous)
                moving=diff.max(axis=2)>=12
                if moving.sum()>=30:
                    this_error=np.abs(target.astype(np.int16)-ref)[moving].mean()
                    delayed_error=np.abs(target.astype(np.int16)-previous)[moving].mean()
                    assert this_error<=delayed_error+1.5, f"Delayed wake frame at {i}/{j}"
            previous=reference.astype(np.int16)
    fm_audit=read_json(originals/"fm-audit.json")
    assert len(fm_audit)==8
    value=.2
    for k,readout in enumerate(fm_audit):
        t=k/8
        speed=1-.5*value+.25*t
        update=speed/8
        assert readout["tau"]==t and readout["step"]==k+1
        assert readout["readout"]==[f"{v:.4f}" for v in [value,speed,update,value+update]]
        name=f"fm.step{k+1}"
        row=shots[name]
        boundary=row["subtitles"][1]["startFrame"]
        for at,phase in [(boundary-1,"phase2"),(boundary,"phase3"),
                         (row["startFrame"]+row["frames"]-1,"landed")]:
            compare_frame(actual[at],source_image(originals/f"{name}-{phase}.jpg"),f"{name} {phase}")
        value+=update
    return {"pictureSamples":len(actual),"shots":by_shot,"wakeArchiveCount":len(audit),
            "wakeMovieFrames":240,"wakeStartS":0,"wakeEndS":60,"wakeOriginalMaxMAE":round(archive_peak,3),
            "fmStepsChecked":8,"fmFinalD0":round(value,6)}


def audio_pcm(ffmpeg,path):
    return np.frombuffer(run(ffmpeg,"-v","error","-i",path,"-map","0:a:0","-ar","48000",
                             "-ac","1","-c:a","pcm_s16le","-f","s16le","pipe:1"),"<i2")


def verify_audio(ffmpeg, work, movie, doc):
    packed=audio_pcm(ffmpeg,movie)
    guide=audio_pcm(ffmpeg,work/"finished/guide.m4a")
    assert np.array_equal(packed,guide), "The film and guide do not decode to identical samples"
    with wave.open(str(work/"voice/film.wav")) as f:
        assert f.getframerate()==48000 and f.getnchannels()==1 and f.getsampwidth()==2
        pcm=np.frombuffer(f.readframes(f.getnframes()),"<i2")
    samples=48000//doc["fps"]
    assert len(pcm)==doc["totalFrames"]*samples
    assert 0<=len(packed)-len(pcm)<1024, (len(packed),len(pcm))
    min_corr,max_lag=1.,0
    for row in doc["subtitles"]:
        lo,hi=row["startFrame"]*samples,row["endFrame"]*samples
        ref=pcm[lo:hi].astype(np.float64)
        match=packed[lo:hi].astype(np.float64)
        energy=np.linalg.norm(ref)
        assert energy/np.sqrt(len(ref))>70, f"No audible voice at {row['shot']}"
        corr=float(np.dot(ref,match)/(energy*np.linalg.norm(match)))
        assert corr>.94, f"{row['shot']} source to film speech correlation is {corr:.4f}"
        min_corr=min(min_corr,corr)
        # Estimate the delay independently inside each spoken sentence.
        length=min(14400,len(ref)//3)
        middle=lo+len(ref)//2-length//2
        for i in range(3):
            window=pcm[middle:middle+length].astype(np.float64)
            if np.max(np.abs(window))>800:break
            middle=lo+int((.25+.3*i)*len(ref))
            middle=min(hi-length,middle)
        radius=400
        search=packed[middle-radius:middle+length+radius].astype(np.float64)
        power=np.r_[0.,np.cumsum(search*search)]
        norm=np.sqrt(np.maximum(1.,power[length:]-power[:-length]))
        scores=correlate(search,window,mode="valid",method="fft")/norm
        lag=int(scores.argmax())-radius
        assert abs(lag)<=32, f"{row['shot']} audio lags source by {lag} samples"
        max_lag=max(max_lag,abs(lag))
    return {"decodedFilmAndGuideIdentical":True,"sourceSamples":len(pcm),"aacTrailingSamples":len(packed)-len(pcm),
            "spokenCues":len(doc["subtitles"]),"minimumVoiceCorrelation":round(min_corr,5),
            "maximumVoiceDelaySamples":max_lag}


def subtitle_time(value):
    h,m,s=re.split(":",value)
    return int(h)*3600+int(m)*60+float(s.replace(",","."))


def verify(ffmpeg, ffprobe, work, movie, report):
    doc=read_json(work/"voice/timeline.json")
    fps=doc["fps"]
    meta=probe(ffprobe,"-show_streams","-show_chapters",movie)
    streams={v["codec_type"]:v for v in meta["streams"]}
    v,a=streams["video"],streams["audio"]
    assert (v["width"],v["height"],v["codec_name"],Fraction(v["r_frame_rate"]))==(1920,1080,"h264",fps)
    assert abs(float(Fraction(v["avg_frame_rate"]))-fps)<.0001
    assert int(v["nb_frames"])==doc["totalFrames"] and int(a["sample_rate"])==48000
    assert a["codec_name"]=="aac" and a["tags"]["language"]=="zho"
    assert abs(float(a["start_time"]))<.001
    assert abs(float(a["duration"])-doc["totalFrames"]/fps)<=1/fps
    chapters=meta["chapters"]
    assert len(chapters)==len(doc["chapterNames"])==7
    stops=doc["chapterStarts"][1:]+[doc["totalFrames"]]
    for i,ch in enumerate(chapters):
        assert ch["tags"]["title"]==doc["chapterNames"][i]
        assert abs(float(ch["start_time"])-doc["chapterStarts"][i]/fps)<=.002
        assert abs(float(ch["end_time"])-stops[i]/fps)<=.002
    packets=probe(ffprobe,"-select_streams","v:0","-show_packets","-show_entries","packet=pts_time",movie)["packets"]
    pts=np.sort([float(p["pts_time"]) for p in packets])
    assert len(pts)==doc["totalFrames"]
    max_drift=float(np.abs(pts-np.arange(len(pts))/fps).max())
    assert max_drift<.001, max_drift
    assert streams["subtitle"]["codec_name"]=="mov_text" and streams["subtitle"]["tags"]["language"]=="zho"
    extracted=run(ffmpeg,"-v","error","-i",movie,"-map","0:s:0","-f","srt","pipe:1").decode("utf-8").strip()
    blocks=re.split(r"\r?\n\s*\r?\n",extracted)
    assert len(blocks)==len(doc["subtitles"])
    for text,row in zip(blocks,doc["subtitles"]):
        _,span,*lines=text.splitlines()
        start,end=map(subtitle_time,span.split(" --> "))
        assert abs(start-row["startFrame"]/fps)<.002 and abs(end-row["endFrame"]/fps)<.002
        assert "".join(lines)==row["text"], (text,row)
    result={"path":str(movie),"durationSeconds":round(doc["totalFrames"]/fps,3),"fps":fps,
            "frameCount":len(pts),"maxPicturePtsDriftSeconds":max_drift,"chaptersChecked":len(chapters),
            "embeddedSubtitlesChecked":len(blocks)}
    result.update(verify_audio(ffmpeg,work,movie,doc))
    result.update(verify_picture(ffmpeg,ffprobe,work,movie,doc))
    if report:
        report.write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k!="shots"},ensure_ascii=False,indent=2),flush=True)


if __name__=="__main__":
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work",type=Path,required=True)
    ap.add_argument("--movie",type=Path)
    ap.add_argument("--ffmpeg",default="ffmpeg")
    ap.add_argument("--ffprobe",default="ffprobe")
    ap.add_argument("--report",type=Path)
    args=ap.parse_args()
    verify(args.ffmpeg,args.ffprobe,args.work,args.movie or args.work/"finished/flowscope-demo.mp4",args.report)
