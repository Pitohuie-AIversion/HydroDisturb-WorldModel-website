"""Export a fixed physical sample across the archived C04 frames."""
import argparse
import json
from pathlib import Path

import numpy as np


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('source', type=Path)
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    rows = []
    coords = None
    for path in args.source.glob('c04_vol_step_*.npz'):
        with np.load(path, allow_pickle=False) as data:
            axes = [data[k] for k in ('z_cross', 'y_span', 'x')]
            index = tuple(int(np.argmin(abs(axis - target))) for axis, target
                          in zip(axes, (0.16, -1.5, 0.9)))
            position = [float(axis[i]) for axis, i in zip(axes, index)]
            if coords is not None and coords != position:
                raise ValueError(f'Sample position changed in {path.name}')
            coords = position
            row = {'time_s': float(data['time_s'].item()), 'step': int(data['step'].item())}
            for key, raw in zip('uvwp', ('u', 'w_cross', 'v_span', 'p')):
                value = float(data[raw][index])
                if not np.isfinite(value):
                    raise ValueError(f'Sample is invalid in {path.name}: {key}')
                row[key] = value
            rows.append(row)
    if not rows:
        raise ValueError('No C04 frames found')
    cross, span, stream = coords
    payload = {'xyz_m': [stream, cross, span], 'rows': sorted(rows, key=lambda r: r['time_s'])}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')), encoding='utf-8')
    print(f'Exported {len(rows)} physical samples at {payload["xyz_m"]}')


if __name__ == '__main__':
    main()
