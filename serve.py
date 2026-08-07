#!/usr/bin/env python3
"""stimulus-runner local server.

Serves the runner page AND owns the ``protocols/`` folder: the browser is a pure
player, every saved protocol is a plain JSON file on disk. No browser storage, no
database, no dependencies — just the Python standard library.

Run it from this folder:

    python serve.py            # macOS / Linux
    python serve.py            # Windows  (or:  py serve.py)
    python serve.py 8080       # pick a port
    python serve.py --no-browser   # don't open a tab (a page is already open)

It binds to 127.0.0.1 only (never exposed to the network, because it writes files),
opens the page in your browser, and serves:

    GET    /                      the runner page (index.html) and its assets
    GET    /api/protocols         list saved protocols  -> {"protocols": [{id,name,count}]}
    GET    /api/protocols/<id>    one protocol          -> {"name": ..., "blocks": [...]}
    POST   /api/protocols         save/overwrite        <- {"name": ..., "blocks": [...]}
    DELETE /api/protocols/<id>    delete a protocol

Portable: copy this whole folder to any machine with Python 3.8+ and run it. The
protocols travel with the folder (they are files in protocols/), so they are the
same on every computer and can be committed to git.
"""
from __future__ import annotations

import http.server
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
PROTO_DIR = ROOT / "protocols"
PROTO_DIR.mkdir(exist_ok=True)

DEFAULT_PORT = 8000
MAX_BODY_BYTES = 1_048_576   # 1 MB cap on a POST body — protocols are tiny; reject anything larger

# --- safe filenames (works on Windows too, keeps non-ASCII names) ------------
# Strip only the genuinely dangerous characters — the Windows-forbidden set,
# path separators, and control chars — so Ukrainian/German/French names survive
# (the page is lang="uk"). The reserved Windows device names are still forbidden,
# and proto_path() re-checks that nothing escapes protocols/ (path-traversal).
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_RESERVED = {"con", "prn", "aux", "nul",
             *(f"com{i}" for i in range(1, 10)),
             *(f"lpt{i}" for i in range(1, 10))}


def safe_stem(name: str) -> str | None:
    """Turn a user-typed protocol name into a safe file stem, or None if empty/illegal.

    Unicode letters are kept; only OS-dangerous characters are removed."""
    stem = _UNSAFE.sub("", str(name or ""))
    stem = re.sub(r"\s+", " ", stem).strip().strip(".")   # Windows dislikes trailing dots/spaces
    stem = stem[:64].strip()
    if not stem or stem in (".", "..") or stem.lower() in _RESERVED:
        return None
    return stem


def proto_path(stem: str) -> Path | None:
    """Resolve protocols/<stem>.json and confirm it stays inside protocols/."""
    p = (PROTO_DIR / f"{stem}.json").resolve()
    try:
        p.relative_to(PROTO_DIR.resolve())
    except ValueError:
        return None
    return p


def warn(msg: str) -> None:
    """A loud, visible warning — failures must never pass silently."""
    sys.stderr.write(f"[stimulus-runner] WARNING: {msg}\n")
    sys.stderr.flush()


def list_protocols() -> list[dict]:
    items = []
    for f in sorted(PROTO_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                blocks = data.get("blocks", [])
                name = str(data.get("name") or f.stem)      # str() so a non-string name can't crash .lower()
            else:                       # a bare list of blocks is also accepted
                blocks = data
                name = f.stem
        except Exception as e:
            warn(f"protocol {f.name!r} is unreadable and was skipped in the list: {e}")
            continue
        items.append({"id": f.stem, "name": name,
                      "count": len(blocks) if isinstance(blocks, list) else 0})
    items.sort(key=lambda it: it["name"].lower())
    return items


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # -- helpers --
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY_BYTES:
            raise ValueError(f"request body too large ({n} bytes > {MAX_BODY_BYTES})")
        raw = self.rfile.read(n) if n > 0 else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _host_ok(self):
        """Only accept mutating requests aimed at localhost — blocks cross-site POST/DELETE."""
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        return host in ("127.0.0.1", "localhost", "[::1]", "::1", "")

    def _id_from_path(self, prefix):
        return safe_stem(unquote(self.path[len(prefix):]).strip())

    # -- routes --
    def do_GET(self):
        if self.path == "/api/protocols":
            return self._json({"protocols": list_protocols()})
        if self.path.startswith("/api/protocols/"):
            stem = self._id_from_path("/api/protocols/")
            p = proto_path(stem) if stem else None
            if not (p and p.exists()):
                return self._json({"error": "not found"}, 404)
            try:
                return self._json(json.loads(p.read_text(encoding="utf-8")))
            except Exception as e:
                warn(f"protocol {p.name!r} is corrupt and could not be loaded: {e}")
                return self._json({"error": f"protocol file is corrupt: {e}"}, 500)
        # static files: serve only the page and its one script — never .git/, serve.py, etc.
        if self.path.split("?")[0] not in ("/", "/index.html", "/protocol.js"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/protocols":
            if not self._host_ok():
                return self._json({"error": "cross-site request refused"}, 403)
            try:
                data = self._body()
            except ValueError as e:
                warn(f"rejected oversized/invalid POST body: {e}")
                return self._json({"error": str(e)}, 413)
            except Exception:
                return self._json({"error": "invalid JSON"}, 400)
            stem = safe_stem((data.get("name") or "").strip())
            blocks = data.get("blocks")
            if not stem:
                return self._json({"error": "name is empty, reserved, or has no usable characters"}, 400)
            if not isinstance(blocks, list) or not blocks:
                return self._json({"error": "no blocks to save"}, 400)
            p = proto_path(stem)
            if not p:
                return self._json({"error": "illegal name"}, 400)
            # server-side overwrite guard on the RESOLVED stem (client name-compare misses
            # collisions where two display names sanitise to one file)
            if p.exists() and not bool(data.get("overwrite")):
                return self._json({"error": f'a protocol named "{stem}" already exists', "exists": True}, 409)
            name = (data.get("name") or "").strip() or stem
            try:
                tmp = p.with_suffix(".json.tmp")          # atomic write: temp + replace
                tmp.write_text(json.dumps({"name": name, "blocks": blocks}, ensure_ascii=False, indent=2),
                               encoding="utf-8")
                os.replace(tmp, p)
            except Exception as e:
                warn(f"could not write protocol {p.name!r}: {e}")
                return self._json({"error": f"could not write file: {e}"}, 500)
            return self._json({"id": stem, "name": name})
        return self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        if self.path.startswith("/api/protocols/"):
            if not self._host_ok():
                return self._json({"error": "cross-site request refused"}, 403)
            stem = self._id_from_path("/api/protocols/")
            p = proto_path(stem) if stem else None
            if not (p and p.exists()):
                return self._json({"error": "not found"}, 404)
            try:
                p.unlink()
            except Exception as e:
                warn(f"could not delete protocol {p.name!r}: {e}")
                return self._json({"error": f"could not delete file: {e}"}, 500)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        # quiet for static assets; one concise line for the protocol API
        if "/api/" in self.path:
            sys.stderr.write("  %s %s\n" % (self.command, self.path))


def open_in_browser(url: str) -> str:
    """Open the runner in a Chromium-based browser (Chrome, else Edge), for reliable
    WebGL + fullscreen on the rig; fall back to the system default.

    Note: Internet Explorer CANNOT run this page (needs modern ES6+ JS and WebGL1). On Windows the
    modern equivalent is Edge (Chromium), which is used automatically if Chrome is absent.
    Returns a short label of what was opened (for the startup message).
    """
    system = platform.system()

    # 1) platform-specific direct launch — the RELIABLE path. We do NOT trust the
    #    webbrowser registry first: on macOS webbrowser.get("chrome") returns a
    #    MacOSXOSAScript that targets an app literally named "chrome", reports success,
    #    and opens NOTHING — a silent failure. So resolve the real app ourselves.
    try:
        if system == "Darwin":
            for app, label in (("Google Chrome", "Chrome"), ("Chromium", "Chromium"),
                               ("Microsoft Edge", "Edge")):
                # -Ra resolves the app WITHOUT launching; only then open the URL in it
                if subprocess.run(["open", "-Ra", app],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    subprocess.run(["open", "-a", app, url])
                    return label
            subprocess.run(["open", url])          # system default browser
            return "default browser"
        if system == "Windows":
            candidates = [
                (os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"), "Chrome"),
                (os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), "Chrome"),
                (os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"), "Chrome"),
                (os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), "Edge"),
                (os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), "Edge"),
            ]
            for exe, label in candidates:
                if os.path.exists(exe):
                    subprocess.Popen([exe, url])
                    return label
            os.startfile(url)   # system default browser
            return "default browser"
        # Linux / other
        for exe, label in (("google-chrome", "Chrome"), ("google-chrome-stable", "Chrome"),
                           ("chromium", "Chromium"), ("chromium-browser", "Chromium"),
                           ("microsoft-edge", "Edge")):
            if shutil.which(exe):
                subprocess.Popen([exe, url])
                return label
    except Exception as e:
        warn(f"preferred-browser launch failed ({e}); falling back to the system default")

    # 2) last resort: the OS default browser
    try:
        if webbrowser.open(url):
            return "default browser"
    except Exception as e:
        warn(f"system-default browser launch errored: {e}")
    warn(f"could not open a browser automatically — open this URL yourself: {url}")
    return "none — open it manually"


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)   # show the banner promptly in piped consoles (PyCharm)
    except Exception:
        pass
    args = sys.argv[1:]
    open_browser = "--no-browser" not in args
    ports = [a for a in args if not a.startswith("-")]
    port = int(ports[0]) if ports else DEFAULT_PORT
    httpd = None
    for p in range(port, port + 10):
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit(f"No free port in {port}..{port + 9}. Try:  python serve.py 9000")

    url = f"http://127.0.0.1:{port}/"
    print("stimulus-runner")
    print(f"  page:      {url}")
    print(f"  protocols: {PROTO_DIR}")
    if open_browser:
        opened = open_in_browser(url)
        print(f"  opening:   {opened}")
    print("  Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
