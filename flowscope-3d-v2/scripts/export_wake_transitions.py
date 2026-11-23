"""Build display correspondences between adjacent archived C04 Q surfaces.

The little-endian uint16 maps follow the input GLB POSITION order. Each pair
contains one target vertex index per source vertex, then the reverse mapping.
These display correspondences do not track fluid particles or add CFD samples.
"""
import argparse
import hashlib
import json
from functools import lru_cache
from pathlib import Path
import struct

import numpy as np
from scipy.spatial import cKDTree

from export_volume import PROJECT, json_bytes, save


def colour_lookup(palette):
    # Reverse the fixed omega palette in the same encoded colour space as GLB.
    stops = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in palette]) / 255
    omega = np.linspace(-1, 1, 513)
    rgb = np.column_stack([np.interp(omega, np.linspace(-1, 1, len(stops)), stops[:, k])
                           for k in range(3)])
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    return cKDTree(np.rint(linear * 255)), omega


def vertex_features(path, expected_hash, palette_tree, palette_omega):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_hash or raw[:4] != b'glTF':
        raise ValueError(f'Invalid source GLB: {path}')
    n = struct.unpack_from('<I', raw, 12)[0]
    gltf = json.loads(raw[20:20+n])
    binary = memoryview(raw)[28+n:]
    primitive, = gltf['meshes'][0]['primitives']

    def attribute(name, dtype, component_type, kind, columns):
        accessor = gltf['accessors'][primitive['attributes'][name]]
        view = gltf['bufferViews'][accessor['bufferView']]
        if (accessor['type'], accessor['componentType']) != (kind, component_type) or 'byteStride' in view:
            raise ValueError(f'Unsupported {name} layout: {path}')
        return np.frombuffer(binary, dtype=dtype, count=columns * accessor['count'],
                             offset=view.get('byteOffset', 0) + accessor.get('byteOffset', 0)).reshape(-1, columns)

    position = attribute('POSITION', '<f4', 5126, 'VEC3', 3)
    normal = attribute('NORMAL', '<f4', 5126, 'VEC3', 3)
    colour = attribute('COLOR_0', 'u1', 5121, 'VEC4', 4)[:, :3]
    if not 0 < len(position) <= 65536:
        raise ValueError(f'Outside uint16 vertex range: {path}')
    omega = palette_omega[palette_tree.query(colour)[1]]
    # Position is in the same scene units as the existing GLB. Normal and
    # signed vorticity softly favour matching sides of thin neighbouring sheets.
    features = np.column_stack([position, .065 * normal, .20 * omega])
    return features, cKDTree(features)


def export(root):
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    tree, omega = colour_lookup(manifest['palette'])

    @lru_cache(maxsize=6)
    def load(name, digest):
        return vertex_features(root / name, digest, tree, omega)

    intervals = []
    for a, b in zip(manifest['frames'], manifest['frames'][1:]):
        entry = {'fromStep': a['step'], 'toStep': b['step']}
        previous = None
        for detail in ('low', 'high'):
            assets = [f['assets'].get('structureLow', f['assets']['structure']) if detail == 'low'
                      else f['assets']['structure'] for f in (a, b)]
            source_hashes = tuple(x['sha256'] for x in assets)
            if source_hashes == previous:
                entry[detail] = entry['low']
                continue
            (fa, ta), (fb, tb) = [load(x['path'], x['sha256']) for x in assets]
            forward = tb.query(fa)[1]
            reverse = ta.query(fb)[1]
            if forward.max() >= len(fb) or reverse.max() >= len(fa):
                raise ValueError('Missing vertex correspondence')
            packed = np.concatenate([forward, reverse]).astype('<u2').tobytes()
            name = f"transitions/{a['step']:04d}-{b['step']:04d}-{detail}.bin"
            entry[detail] = save(root, name, packed)
            previous = source_hashes
        intervals.append(entry)
    save(root, 'transitions/index.json', json_bytes({
        'schema': 'flowscope.c04.surface-correspondence.v1',
        'encoding': 'uint16-le / from-to followed by to-from in GLB vertex order',
        'intervals': intervals,
    }))
    unique = {v['path']: v['bytes'] for pair in intervals for v in (pair['high'], pair['low'])}
    print(f'{len(intervals)} archive intervals, {len(unique)} maps, {sum(unique.values()):,} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=PROJECT / 'public' / 'data')
    export(parser.parse_args().data)
