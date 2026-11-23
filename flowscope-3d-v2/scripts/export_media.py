"""Rebuild the narrated film from the interactive exhibits and optionally refresh the architecture PDF."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

from PIL import Image
from playwright.sync_api import sync_playwright

from assemble_film import assemble


def architecture(original: Path, output: Path):
    xmlns = "http://www.w3.org/2000/svg"
    ET.register_namespace("", xmlns)
    ET.register_namespace("h", "http://www.w3.org/1999/xhtml")
    root = ET.Element(f"{{{xmlns}}}svg", {"viewBox": "0 0 1640 2900", "width": "1640", "height": "2900"})
    def add(tag, attrs, text=None):
        element = ET.SubElement(root, f"{{{xmlns}}}{tag}", {k: str(v) for k, v in attrs.items()})
        element.text = text
    def label(text, x, y, size, color="#163447", weight=400):
        add("text", {"x": x,"y": y,"font-family": "Microsoft YaHei, sans-serif","font-size": size,"font-weight": weight,"fill": color}, text)
    add("title", {}, "FlowScope 3D V2.0 · 七章导览与 V1.2 预训练架构")
    add("rect", {"width": 1640,"height": 2900,"fill": "white"})
    label("FlowScope 3D    /    V2.0", 60, 62, 23, "#007C7D", 700)
    label("圆柱流场世界模型", 58, 141, 60, "#163447", 700)
    label("七章展示与 V1.2 预训练架构", 60, 194, 31, "#4B6373")
    lines = [
        ("01", "真实三维尾流", "C04 的 u、v、w、p","Q 等值面与展向涡量"),
        ("02", "3D DC-AE 编码", "三级 S2C 压缩","Stem 6→32，末端为 256 通道"),
        ("03", "潜空间与 Probe", "2304 个位置 × 256 个特征","RMSNorm、物理探针与独立 b[6]"),
        ("04", "物理解码", "三级 C2S、矢量势与 Curl","逆归一化后恢复四个物理量"),
        ("05", "双轨时空模型", "四帧历史与五个条件槽位","Clean 缓存，Query 读取因果 KV"),
        ("06", "Flow Matching", "τ 从 0 推进至 1","每步重新运行 Query 和单个速度头"),
        ("07", "未来恢复与滚动", "配对预测与四帧 FIFO","自由滚动 H = 10 / 50 / 100"),
    ]
    for idx, (num, title, row1, row2) in enumerate(lines):
        x=60+(idx%4)*391
        y=255+idx//4*146
        color="#007C7D" if idx in (0,1,3) else "#67499B"
        label(num, x, y, 21, color, 700)
        label(title,x,y+40,29,"#163447",700)
        label(row1,x,y+78,21,"#4B6373")
        label(row2,x,y+108,19,"#4B6373")
    add("path", {"d":"M60 546 H1580","stroke":"#A5BAC3","fill":"none","stroke-width":"1.4"})
    label("预训练网络详图",60,606,37,"#163447",700)
    label("研究基准 V1.2     K = 1     WTA 关闭     概率头关闭",60,649,22,"#4B6373")
    inner=ET.parse(original).getroot()
    inner.attrib.update(x="46", y="675", width="1548", height="2195")
    root.append(inner)
    ET.ElementTree(root).write(output, encoding="utf-8", xml_declaration=True)


def replace_file(source, destination):
    destination.parent.mkdir(exist_ok=True, parents=True)
    temp = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copyfile(source, temp)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def publish_sources(work, deliver, docs):
    finished, voice = work / "finished", work / "voice"
    public = deliver.parent / "public"
    with Image.open(work/"shots/wake.start.png") as first:
        first.convert("RGB").save(finished/"film-poster.jpg", quality=90, optimize=True)
    for source,dest in (
        (finished/"flowscope-demo.mp4", deliver/"flowscope-demo.mp4"),
        (finished/"guide.m4a", public/"assets/guide.m4a"),
        (finished/"film-poster.jpg", public/"assets/film-poster.jpg"),
        (voice/"film.vtt", public/"library/flowscope-demo.vtt"),
        (voice/"narration.md", docs/"narration.md"),
        (finished/"guide.json", public/"assets/guide.json"),
    ):
        replace_file(source,dest)


def architecture_files(original, deliver, chromium):
    architecture(original, deliver/"architecture.svg")
    svg=(deliver/"architecture.svg").read_text(encoding="utf-8").split("?>")[-1]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=str(chromium)) if chromium else pw.chromium.launch(channel="msedge")
        page=browser.new_page()
        page.set_content('<meta charset="utf-8"><style>@page{margin:0}body{margin:0}svg{display:block}</style>'+svg)
        page.pdf(path=str(deliver/"architecture.pdf"), width="1640px", height="2900px", print_background=True)
        browser.close()


if __name__=="__main__":
    root=Path(__file__).resolve().parents[1]
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True, help="Working directory for audio, captures and encoding")
    parser.add_argument("--url", default="http://127.0.0.1:8765/", help="Local running presentation to capture")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--deliver", type=Path, default=root/"deliverables")
    parser.add_argument("--docs", type=Path, default=root/"docs")
    parser.add_argument("--original", type=Path, help="Also regenerate the combined architecture SVG and PDF")
    parser.add_argument("--chromium", type=Path, help="Optional browser executable for printing the architecture PDF")
    parser.add_argument("--c04", type=Path, help=argparse.SUPPRESS)  # Older command lines passed the raw CFD archive.
    args=parser.parse_args()
    work=args.build.resolve()
    work.mkdir(exist_ok=True, parents=True)
    scripts=root/"scripts"
    for command in (
        ["media_voice.py","--out",work/"voice"],
        ["film_wake_fm.py","--out",work,"--url",args.url,"--ffmpeg",args.ffmpeg],
        ["film_model_shots.py","--out",work/"shots","--url",args.url,"--ffmpeg",args.ffmpeg],
    ):
        subprocess.run([sys.executable,str(scripts/command[0]),*map(str,command[1:])],check=True)
    assemble(work, args.ffmpeg, args.ffprobe)
    publish_sources(work, args.deliver.resolve(), args.docs.resolve())
    if args.original:
        architecture_files(args.original, args.deliver, args.chromium)
