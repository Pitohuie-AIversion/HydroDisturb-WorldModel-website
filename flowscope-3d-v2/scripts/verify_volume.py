"""Compare the packaged C04 volumes with source NPZ, including axis swaps and masks."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
from pathlib import Path
import struct

import numpy as np


def digest(data: bytes):
    return hashlib.sha256(data).hexdigest()


def check_frame(root, archive_root, manifest, frame):
    source_bytes = (archive_root/frame["source"]).read_bytes()
    assert digest(source_bytes) == frame["source_sha256"]
    raw = np.load(io.BytesIO(source_bytes), allow_pickle=False)
    assert frame["step"] == int(raw["step"])
    assert frame["time_s"] == float(raw["time_s"])
    for axis, key in {"X":"x","Y":"z_cross","Z":"y_span"}.items():
        np.testing.assert_array_equal(manifest["axes_m"][axis], raw[key])
    # Construct the independent reference in original NPZ storage order.
    fields = {ch:raw[name] for ch,name in {"u":"u","v":"w_cross","w":"v_span","p":"p"}.items()}
    solid = np.broadcast_to((raw["x"][None,:]**2+raw["z_cross"][:,None]**2 <= .15**2)[:,None,:],
                            fields["u"].shape)
    valid = np.isfinite(np.stack(list(fields.values()))).all(axis=0) & ~solid
    derivative = valid.copy()
    for axis in range(3):
        derivative &= np.roll(valid,1,axis) & np.roll(valid,-1,axis)
        edges = [slice(None)]*3
        edges[axis]=[0,-1]
        derivative[tuple(edges)] = False
    means = [float(np.mean(f[valid],dtype=np.float64)) for f in fields.values()]
    variances = [float(np.var(f[valid],dtype=np.float64)) for f in fields.values()]
    np.testing.assert_allclose(frame["stats6"],means+[sum(variances[:3])**.5,variances[3]**.5],rtol=1e-9,atol=1e-11)
    assert int(valid.sum()) == frame["valid_count"]
    assert int(derivative.sum()) == frame["derivative_count"]
    checked = 0

    def content(asset):
        nonlocal checked
        data = (root/asset["path"]).read_bytes()
        assert len(data)==asset["bytes"] and digest(data)==asset["sha256"], asset["path"]
        checked+=1
        return data

    assets = frame["assets"]
    for key, flag in {"solid":solid,"valid":valid,"derivative":derivative}.items():
        bits=np.frombuffer(gzip.decompress(content(assets["masks"][key])),dtype=np.uint8)
        decoded=np.unpackbits(bits,bitorder="little").reshape(manifest["grid_zyx"])
        np.testing.assert_array_equal(decoded, flag.transpose(1,0,2))
    # Match np.gradient's uneven cell-centre spacing, including the stored
    # FP32 coordinate rounding, using the original velocity-component names.
    omega = np.gradient(fields["v"],raw["x"],axis=2)-np.gradient(fields["u"],raw["z_cross"],axis=0)
    fields["omega"] = np.where(derivative,omega,np.nan)
    for level, block in assets["volume"].items():
        lod=int(level)
        dtype="<f4" if lod==1 else "<f2"
        sample=(slice(None,None,lod),)*3
        for ch, asset in block.items():
            compared = np.where(valid[sample],fields[ch][sample],np.nan).transpose(1,0,2).astype(dtype)
            decoded=np.frombuffer(gzip.decompress(content(asset)),dtype=dtype).reshape(compared.shape)
            np.testing.assert_array_equal(decoded,compared)
    for asset in (assets.get("structureLow"), assets["structure"]):
        if asset is None:
            continue
        glb=content(asset)
        magic,version,length=struct.unpack_from("<4sII",glb)
        assert magic==b"glTF" and version==2 and length==len(glb)
        head_length=struct.unpack_from("<I",glb,12)[0]
        header=json.loads(glb[20:20+head_length])
        assert header["accessors"][0]["count"]>50 and header["accessors"][3]["count"]%3==0
    return checked


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data",type=Path,default=Path(__file__).resolve().parents[1]/"public"/"data")
    p.add_argument("--source",type=Path,default=Path(r"Z:\E\cfd_3d\05_reports_viz\video_c04_shedding"))
    p.add_argument("--workers",type=int,default=3)
    p.add_argument("--report",type=Path)
    args=p.parse_args()
    if not __debug__:
        raise RuntimeError("Verification requires Python assertions")
    manifest_bytes=(args.data/"manifest.json").read_bytes()
    manifest=json.loads(manifest_bytes)
    assert manifest["grid_zyx"]==[64,96,192]
    frames=manifest["frames"]
    assert all(a["time_s"]<b["time_s"] for a,b in zip(frames,frames[1:]))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        count=sum(pool.map(lambda f:check_frame(args.data,args.source,manifest,f),frames))
    report={"schema":"flowscope.c04.verification.v2","manifest_sha256":digest(manifest_bytes),
            "frames_verified":len(frames),"asset_checksums_verified":count,
            "fp32_steps":[f["step"] for f in frames if "1" in f["assets"]["volume"]],
            "source_mapping":{"u":"u","v":"w_cross","w":"v_span","p":"p"},
            "checks":["Source SHA-256 and Web asset SHA-256","All four channel volumes and derived spanwise vorticity at every stored voxel and LOD",
                      "All physical coordinates and timestamps","All three packed masks, voxel by voxel",
                      "Full-resolution six background statistics","Indexed GLB header, size and primitive checks"],
            "result":"passed"}
    text=json.dumps(report,indent=2,ensure_ascii=False)
    if args.report:
        args.report.write_text(text+"\n",encoding="utf-8")
    print(text)


if __name__=="__main__":
    main()
