"""Start the built local FlowScope presentation. The static bundle contains its CFD data."""
import argparse
from pathlib import Path
import runpy


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1", help="Legacy option. The presentation runs on loopback.")
    parser.add_argument("--data-root", help="Legacy live-NPZ path. See scripts/export_volume.py to regenerate the bundle.")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent / "deliverables" / "flowscope-offline"
    if not (root / "launch.py").is_file():
        raise SystemExit("Build the static presentation first: npm ci && npm run build")
    if args.data_root:
        print("Using packaged C04 frames. To refresh them, use scripts/export_volume.py --source.")
    runpy.run_path(str(root / "launch.py"))["serve"](root, args.port, args.open)
