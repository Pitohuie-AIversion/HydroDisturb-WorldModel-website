"""Prepare local C04 WebGL resources from the original COMSOL archive.

Dependencies: numpy, scipy, scikit-image. No server or inference is involved.
All arrays, including packed masks, follow C-order [span, cross, stream].
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import struct

import numpy as np
from scipy.ndimage import map_coordinates
from skimage.measure import marching_cubes


PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"Z:\E\cfd_3d\05_reports_viz\video_c04_shedding")
FIELDS = {"u": "u", "v": "w_cross", "w": "v_span", "p": "p"}
GRID = (64, 96, 192)
FINE_STEPS = {835, 837, 839, 841, 843, 845, 851, 885, 935}
RANGES = {"u": [-0.25, 0.85], "v": [-0.5, 0.5], "w": [-0.3, 0.3],
          "p": [-1400., 1100.], "omega": [-12., 12.]}
PALETTE = ["#053061", "#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7",
           "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"]
Q_LEVEL = 0.85
RADIUS = 0.15
SCALE = 8 / 3.6


def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def save(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".part")
    temp.write_bytes(content)
    os.replace(temp, path)
    return {"path": name, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}


def write_array(root, name, values):
    return save(root, name, gzip.compress(values.tobytes("C"), compresslevel=2, mtime=0))


def masks(fields, x, cross):
    solid_plane = cross[:, None] ** 2 + x[None, :] ** 2 <= RADIUS**2
    solid = np.broadcast_to(solid_plane, GRID)
    valid = ~solid & np.logical_and.reduce([np.isfinite(v) for v in fields.values()])
    stencil = np.zeros_like(valid)
    stencil[1:-1, 1:-1, 1:-1] = (
        valid[1:-1, 1:-1, 1:-1] & valid[:-2, 1:-1, 1:-1] & valid[2:, 1:-1, 1:-1]
        & valid[1:-1, :-2, 1:-1] & valid[1:-1, 2:, 1:-1]
        & valid[1:-1, 1:-1, :-2] & valid[1:-1, 1:-1, 2:])
    return solid, valid, stencil


def structures(fields, x, cross, span, derivative):
    # Canonical vector components are (u_stream,v_cross,w_span), with axes
    # permuted together. tr(J²) is invariant to simultaneous permutation.
    du_s, du_c, du_x = np.gradient(fields["u"], span, cross, x)
    dv_s, dv_c, dv_x = np.gradient(fields["v"], span, cross, x)
    dw_s, dw_c, dw_x = np.gradient(fields["w"], span, cross, x)
    q = -0.5 * (du_x**2 + dv_c**2 + dw_s**2) - du_c*dv_x - du_s*dw_x - dv_s*dw_c
    omega = dv_x - du_c
    return np.where(derivative, q, np.nan), np.where(derivative, omega, np.nan)


def isosurface_glb(q, omega, derivative, x, cross, span, stride=2):
    # Disable cells touching unavailable difference stencils. A sentinel
    # alone would introduce a false surface along a mask boundary.
    safe = np.zeros_like(derivative)
    n = stride
    nz, ny, nx = derivative.shape
    interior = safe[n:, n:, n:]
    interior[:] = True
    for dz in (0, n):
        for dy in (0, n):
            for dx in (0, n):
                interior &= derivative[dz:dz+nz-n, dy:dy+ny-n, dx:dx+nx-n]
    verts, faces, normals, _ = marching_cubes(
        np.nan_to_num(q), level=Q_LEVEL, step_size=stride, mask=safe, allow_degenerate=False)
    coords = verts.T
    x0, y0, z0 = (a[0] for a in (x, cross, span))
    center = [(a[0]+a[-1]) / 2 for a in (x, cross, span)]
    position = np.column_stack((
        x0 + coords[2]*(x[1]-x[0]) - center[0],
        y0 + coords[1]*(cross[1]-cross[0]) - center[1],
        -(z0 + coords[0]*(span[1]-span[0]) - center[2]))) * SCALE
    rotation = normals[:, [2, 1, 0]].copy()
    rotation[:, 2] *= -1
    vorticity = map_coordinates(np.nan_to_num(omega), coords, order=1)
    gradient = np.array([[int(h[i:i+2],16) for i in (1,3,5)] for h in PALETTE]) / 255
    s = np.clip((vorticity+12)/24, 0, 1)
    rgb = np.stack([np.interp(s, np.linspace(0, 1, 11), gradient[:, i]) for i in range(3)], axis=1)
    linear = np.where(rgb <= .04045, rgb/12.92, ((rgb+.055)/1.055)**2.4)
    colors = np.column_stack((np.rint(255*linear).astype("u1"), np.full(len(verts),255,"u1")))
    binary = bytearray()
    views, accessors = [], []
    for array, component, kind in [
            (position.astype("<f4"), 5126, "VEC3"), (rotation.astype("<f4"), 5126, "VEC3"),
            (colors, 5121, "VEC4"), (faces.astype("<u2" if len(verts)<65535 else "<u4").ravel(),
                                      5123 if len(verts)<65535 else 5125, "SCALAR")]:
        views.append({"buffer":0, "byteOffset":len(binary), "byteLength":array.nbytes,
                      "target":34963 if kind=="SCALAR" else 34962})
        acc = {"bufferView":len(views)-1,"componentType":component,"count":len(array),"type":kind}
        if not accessors:
            acc.update(min=array.min(axis=0).tolist(),max=array.max(axis=0).tolist())
        if component == 5121:
            acc["normalized"] = True
        accessors.append(acc)
        binary.extend(array.tobytes())
        binary.extend(bytes((-len(binary)) % 4))
    spec = {"asset":{"version":"2.0","generator":"FlowScope C04 Q exporter"}, "scene":0,
            "scenes":[{"nodes":[0]}], "nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"COLOR_0":2},
                                       "indices":3,"material":0}]}],
            "materials":[{"doubleSided":True, "pbrMetallicRoughness":{"metallicFactor":0.,
                                                                       "roughnessFactor":0.62}}],
            "buffers":[{"byteLength":len(binary)}],"bufferViews":views,"accessors":accessors}
    head = json_bytes(spec)
    head += b" " * ((-len(head)) % 4)
    return (struct.pack("<4sII", b"glTF", 2, 28+len(head)+len(binary)) +
            struct.pack("<I4s",len(head),b"JSON") + head +
            struct.pack("<I4s",len(binary),b"BIN\x00") + binary)


def export_frame(path, out):
    source = path.read_bytes()
    with np.load(io.BytesIO(source), allow_pickle=False) as archive:
        fields = {key: np.ascontiguousarray(archive[name].transpose(1,0,2), dtype="<f4")
                  for key,name in FIELDS.items()}
        step, time = int(archive["step"]), float(archive["time_s"])
        x, cross, span = (archive[key] for key in ("x","z_cross","y_span"))
    if any(field.shape!=GRID for field in fields.values()):
        raise ValueError(f"Unexpected grid in {path.name}")
    solid, valid, derivative = masks(fields, x, cross)
    q, omega = structures(fields, x, cross, span, derivative)
    base = f"frames/{step:04d}/"
    mask_assets = {}
    for name, array in {"solid":solid,"valid":valid,"derivative":derivative}.items():
        mask_assets[name] = write_array(out,base+name+".bits.gz",np.packbits(array, bitorder="little"))
    mean = [float(np.mean(f[valid], dtype=np.float64)) for f in fields.values()]
    var = [float(np.var(f[valid], dtype=np.float64)) for f in fields.values()]
    field_stats = {k: [float(f[valid].min()),float(f[valid].max())] for k,f in fields.items()}
    field_stats["omega"] = [float(np.nanmin(omega)),float(np.nanmax(omega))]
    resources = {}
    full = step in FINE_STEPS
    for lod in ([1, 2, 4] if full else [2, 4]):
        sub = (slice(None,None,lod),)*3
        resources[str(lod)] = {}
        for channel, field in dict(fields, omega=omega).items():
            # Preserve the raw FP32 values at every valid voxel in full LOD.
            chunk = np.where(valid[sub],field[sub],np.nan).astype("<f4" if lod==1 else "<f2")
            resources[str(lod)][channel] = write_array(out,base+f"{channel}-d{lod}.bin.gz",chunk)
    surface = save(out, base+"q085.glb", isosurface_glb(q,omega,derivative,x,cross,span))
    assets = {"volume":resources,"masks":mask_assets,"structure":surface}
    if full:
        assets["structureLow"] = surface
        assets["structure"] = save(out,base+"q085-full.glb",
                                   isosurface_glb(q,omega,derivative,x,cross,span,stride=1))
    return {"step":step,"time_s":time,"source":path.name, "source_sha256":hashlib.sha256(source).hexdigest(),
            "stats6":mean+[sum(var[:3])**.5, var[3]**.5],"range":field_stats,
            "valid_count":int(valid.sum()),"derivative_count":int(derivative.sum()),
            "assets":assets}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",type=Path,default=DEFAULT_SOURCE)
    p.add_argument("--out",type=Path,default=PROJECT/"public"/"data")
    p.add_argument("--workers",type=int,default=3)
    args=p.parse_args()
    files = sorted(args.source.glob("c04_vol_step_*.npz"),key=lambda path:int(path.stem.split("_")[-1]))
    if not files:
        raise FileNotFoundError(args.source)
    with np.load(files[0], allow_pickle=False) as a:
        axes={k:a[v].tolist() for k,v in {"X":"x","Y":"z_cross","Z":"y_span"}.items()}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        frames = []
        for f in pool.map(lambda path:export_frame(path,args.out),files):
            frames.append(f)
            print(f"{len(frames)}/{len(files)}  step {f['step']}  {f['time_s']:.2f} s", flush=True)
    manifest = {"schema":"flowscope.c04.volumes.v2","version":"2.0","dataset":"C04",
                "origin":"COMSOL_export","source_directory":"E:/cfd_3d/05_reports_viz/video_c04_shedding",
                "grid_zyx":GRID,"axes_m":axes,"units":{"u":"m/s","v":"m/s","w":"m/s","p":"Pa","omega":"s⁻¹"},
                "source_fields":FIELDS,"storage_to_canonical":"[z_cross,y_span,x] → [y_span,z_cross,x]",
                "scene_transform":"2.22222 × (X−1.20, Y, −(Z+1.50)); X=x, Y=z_cross, Z=y_span",
                "solid":"SDF=hypot(X,Y)−0.15 m; solid when SDF≤0; positive in fluid",
                "valid":"finite(u,v,w,p) AND outside analytic cylinder",
                "derivative":"valid center and six valid neighbours, outer planes excluded",
                "mask_encoding":"LSB-first binary bitset in flattened [Z,Y,X] order; gzip",
                "volume_encoding":"little-endian, row-major [Z,Y,X], gzip; d1 FP32, d2/d4 FP16; invalid values are NaN; stride=d",
                "structure":{"criterion":"Q=-tr(J²)/2", "isovalue":Q_LEVEL,"unit":"s⁻²",
                             "color":"ω=∂v_cross/∂x−∂u/∂cross","method":"centered differences; marching cubes stride=2, stride=1 on full-detail frames"},
                "display_ranges":RANGES,"palette":PALETTE,"reference":{"diameter_m":.30,"U0_m_s":.5,"Re":126167},
                "time_range_s":[frames[0]["time_s"],frames[-1]["time_s"]],
                "defaultFrame":0,
                "modelReferenceFrame":next((i for i,f in enumerate(frames) if f["step"]==835),0),"frames":frames}
    save(args.out, "manifest.json", json_bytes(manifest))


if __name__=="__main__":
    main()
