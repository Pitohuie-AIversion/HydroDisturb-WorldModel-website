"""Serve the complete offline directory on loopback using the Python standard library."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.request
import webbrowser


class StaticHandler(SimpleHTTPRequestHandler):
    # Chromium requests the field, slices and script dependencies concurrently.
    protocol_version = "HTTP/1.1"


class LocalServer(ThreadingHTTPServer):
    request_queue_size = 64
    allow_reuse_address = False


def already_serving(port: int, version: str) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/release.json", timeout=.45) as response:
            info = json.load(response)
        return info.get("edition") == version
    except (ValueError, OSError, AttributeError):
        return False


def serve(root: Path, port: int = 8765, open_page: bool = False) -> None:
    if not (root / "data" / "manifest.json").is_file():
        raise SystemExit("C04 data/manifest.json missing. Start from the complete offline folder.")
    version = json.loads((root / "release.json").read_text(encoding="utf-8"))["edition"]
    handler = functools.partial(StaticHandler, directory=str(root))
    for candidate in range(port, min(port + 20, 65536)):
        url = f"http://127.0.0.1:{candidate}/"
        if already_serving(candidate, version):
            print(f"FlowScope is already running at {url}", flush=True)
            if open_page:
                webbrowser.open(url)
            return
        try:
            server = LocalServer(("127.0.0.1", candidate), handler)
        except OSError:
            if already_serving(candidate, version):
                print(f"FlowScope is already running at {url}", flush=True)
                if open_page:
                    webbrowser.open(url)
                return
            continue
        print(f"FlowScope 3D V2.0   {url}\nClose this window to stop the local server.", flush=True)
        if open_page:
            webbrowser.open(url)
        with server:
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        return
    raise SystemExit("No available loopback port. Supply a different --port.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    serve(Path(__file__).resolve().parent, args.port, args.open)
