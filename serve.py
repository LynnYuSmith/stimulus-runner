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
    POST   /api/stimlog           append played epochs  <- {"session": ..., "rows": [...]}
    GET    /api/stimlog           list session logs     -> {"sessions": [{id,rows,bytes}]}
    GET    /api/stimlog?session=  replay one session     -> {"session": ..., "rows": [...]}
    PUT    /api/session/<id>      save the cockpit state <- {queue, form, cfg, run, ...}
    GET    /api/session           the newest saved state -> {"session": ..., "state": {...}}
    GET    /api/session/<id>      one saved state

**The session file is the other half of the trial log.** ``stimlog_<id>.jsonl`` is what was
played; ``session_<id>.json`` beside it is what the cockpit looked like -- the queue, the form,
the screen settings, where the run stood. The page PUTs it on every change, so after a frozen
machine the runner can offer to pick up where it was. Same pattern as pupil-monitor's
``pupil_<stamp>.csv`` + ``pupil_<stamp>.json``: data, and beside it what produced the data.

Set ``STIMULUS_RUNNER_LOG_DIR`` to write the trial log somewhere else (a data disk, say);
by default it goes to ``logs/`` beside this file.

**Why the log is written here and not only in the browser.** The trial log used to live in
the page's memory until someone clicked Export. On 2026-09-18 the stimulus PC froze mid-session
and took the whole log with it. Now every epoch is POSTed as it starts and appended to
``logs/stimlog_<session>.jsonl`` with an fsync, so the record survives a frozen tab, a killed
browser and a power cut. The Export buttons are unchanged -- this is a second, independent copy,
not a replacement.

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
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
PROTO_DIR = ROOT / "protocols"
PROTO_DIR.mkdir(exist_ok=True)
# Overridable so the log can be written straight onto the rig's data disk (and so the tests do
# not litter the repo). Falls back to logs/ beside this file, which travels with the folder.
LOG_DIR = Path(os.environ.get("STIMULUS_RUNNER_LOG_DIR") or (ROOT / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_PORT = 8000
MAX_BODY_BYTES = 1_048_576   # 1 MB cap on a POST body — protocols are tiny; reject anything larger
DRAIN_LIMIT_BYTES = 16_777_216   # read and discard at most this much of an oversized body


class BodyTooLarge(Exception):
    """A POST body over MAX_BODY_BYTES — distinct from a body that simply will not parse."""

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


# --- the durable trial log -------------------------------------------------
# One JSON object per line, appended and fsynced as each epoch starts, plus a CSV rebuilt
# beside it so the file on disk is directly usable without a conversion step. The JSONL is
# the truth and is NEVER rewritten; the CSV is derived and written atomically, so a crash
# during the rewrite can cost the convenience copy but never the record.
#
# A row may be sent twice: a grey has no duration when it starts, and the page closes it from
# the clock when the next epoch begins. Replay is therefore LAST-WRITE-WINS on ``n`` -- which
# is also why the file is append-only rather than being patched in place.

#: Deliberately stricter than safe_stem(): a session id is generated by the page, never typed,
#: so there is no reason to accept anything but a plain timestamp-shaped token.
_SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: The browser's Export CSV header, and the names lib/stimulus/runner_log.load_stimlog reads.
#: Kept identical on purpose: the recovered file must be usable wherever the exported one is.
STIMLOG_COLUMNS = ("n", "wallclock", "unix_ms", "type", "direction_deg", "orientation_deg",
                   "duration_s", "spatial_freq_cpd", "temporal_freq_hz", "contrast",
                   "stim_kind", "stim_code", "pair_code", "pair_part",
                   "plaid_direction_deg", "plaid_temporal_freq_hz")


def log_paths(session: str):
    """``logs/stimlog_<session>.{jsonl,csv}``, or None if the id is not acceptable."""
    # NOT .strip()ed: the page generates this id, so anything that needs tidying up is a sign
    # something else sent it. Being lenient here is how a log ends up in an unexpected file.
    sid = str(session or "")
    if not _SESSION_RE.match(sid):
        return None
    base = (LOG_DIR / f"stimlog_{sid}").resolve()
    try:
        base.relative_to(LOG_DIR.resolve())
    except ValueError:                       # pragma: no cover - _SESSION_RE already blocks it
        return None
    return base.with_suffix(".jsonl"), base.with_suffix(".csv")


def replay_stimlog(jsonl: Path) -> list[dict]:
    """Rebuild the row list from the append-only file: later ``n`` supersedes earlier.

    A torn final line (power cut mid-write) is skipped rather than raising -- one lost row is
    the honest cost of the crash, and refusing to read the other 200 would not undo it.
    """
    by_n: dict = {}
    if not jsonl.exists():
        return []
    for line in jsonl.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            warn(f"{jsonl.name}: skipped an unreadable line (torn write?)")
            continue
        if isinstance(row, dict) and row.get("n") is not None:
            by_n[row["n"]] = row
    return [by_n[k] for k in sorted(by_n, key=lambda v: (not isinstance(v, (int, float)), v))]


def _csv_cell(v) -> str:
    """Match the browser's ``[...].join(',')`` exactly: null/undefined become an empty field."""
    if v is None:
        return ""
    s = str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s


def write_stimlog_csv(rows: list[dict], csv_path: Path) -> None:
    """Derived file, atomically replaced. Column order is the browser's, not the dict's."""
    body = "\n".join(
        ",".join(_csv_cell(r.get(c)) for c in STIMLOG_COLUMNS) for r in rows)
    tmp = csv_path.with_suffix(".csv.tmp")
    tmp.write_text(",".join(STIMLOG_COLUMNS) + "\n" + body + ("\n" if body else ""),
                   encoding="utf-8")
    os.replace(tmp, csv_path)


def append_stimlog(jsonl: Path, rows: list[dict]) -> int:
    """Append rows and get them onto the platter. Returns how many were written.

    ``fsync`` is the whole point of this function: without it the rows sit in the OS page
    cache and a frozen machine loses exactly what we are trying to keep.
    """
    # A crash can leave the file ending mid-line. Appending straight onto that stub would
    # weld the stub and the new row into one unparseable line -- so the torn write would cost
    # the row AFTER it as well, silently. Close the line first. (Found by the crash test, not
    # by review: the naive version passed every other case.)
    try:
        if jsonl.exists() and jsonl.stat().st_size:
            with open(jsonl, "rb") as f:
                f.seek(-1, os.SEEK_END)
                if f.read(1) != b"\n":
                    with open(jsonl, "a", encoding="utf-8") as fa:
                        fa.write("\n")
                    warn(f"{jsonl.name}: previous line was torn (crash?); closed it before appending")
    except OSError as e:                       # pragma: no cover - the append below reports it
        warn(f"could not inspect {jsonl.name} before appending: {e}")
    with open(jsonl, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return len(rows)


def list_stimlogs() -> list[dict]:
    items = []
    for f in sorted(LOG_DIR.glob("stimlog_*.jsonl")):
        try:
            n = len(replay_stimlog(f))
        except Exception as e:
            warn(f"stimlog {f.name!r} is unreadable and was skipped in the list: {e}")
            continue
        items.append({"id": f.stem[len("stimlog_"):], "rows": n, "bytes": f.stat().st_size})
    return items


def session_path(session: str):
    """``logs/session_<id>.json``, or None if the id is not acceptable (same rule as the log)."""
    paths = log_paths(session)
    return paths[0].with_name(f"session_{session}.json") if paths else None


def save_session(path: Path, state: dict) -> None:
    """Atomic: temp + replace, so a crash mid-write leaves the previous state, never half of one."""
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def latest_session():
    """The newest session file by its own ``saved`` stamp, falling back to mtime.

    Returns (id, state) or (None, None). A file that will not parse is skipped with a warning
    rather than hiding every older, readable one behind it.
    """
    best = None
    for f in LOG_DIR.glob("session_*.json"):
        try:
            state = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            warn(f"session file {f.name!r} is unreadable and was skipped: {e}")
            continue
        if not isinstance(state, dict):
            continue
        key = (str(state.get("saved") or ""), f.stat().st_mtime)
        if best is None or key > best[0]:
            best = (key, f.stem[len("session_"):], state)
    return (best[1], best[2]) if best else (None, None)


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
        """Parse the JSON body.

        Raises :class:`BodyTooLarge` for an oversized one and lets json's own ValueError
        through for a malformed one. They used to be indistinguishable, because
        ``json.JSONDecodeError`` IS a ValueError -- so every syntax error was reported to the
        operator as "request body too large", which sends anyone debugging it in exactly the
        wrong direction.

        An oversized body is still DRAINED before answering: replying and closing while the
        client is mid-upload gives it a broken pipe instead of the 413 we carefully wrote.
        """
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY_BYTES:
            left = min(n, DRAIN_LIMIT_BYTES)
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
            raise BodyTooLarge(f"request body too large ({n} bytes > {MAX_BODY_BYTES})")
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
        if self.path == "/api/session":
            sid, state = latest_session()
            if sid is None:
                return self._json({"session": None, "state": None})
            return self._json({"session": sid, "state": state})
        if self.path.startswith("/api/session/"):
            sid = unquote(self.path[len("/api/session/"):])
            p = session_path(sid)
            if not p:
                return self._json({"error": "illegal session id"}, 400)
            if not p.exists():
                return self._json({"error": "not found"}, 404)
            try:
                return self._json({"session": sid, "state": json.loads(p.read_text(encoding="utf-8"))})
            except Exception as e:
                warn(f"session {p.name!r} is corrupt: {e}")
                return self._json({"error": f"session file is corrupt: {e}"}, 500)
        if self.path.split("?")[0] == "/api/stimlog":
            q = parse_qs(urlparse(self.path).query)
            sid = (q.get("session") or [""])[0]
            if not sid:
                return self._json({"sessions": list_stimlogs()})
            paths = log_paths(sid)
            if not paths:
                return self._json({"error": "illegal session id"}, 400)
            return self._json({"session": sid, "rows": replay_stimlog(paths[0])})
        # static files: serve only the page and its one script — never .git/, serve.py, etc.
        if self.path.split("?")[0] not in ("/", "/index.html", "/protocol.js"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/stimlog":
            if not self._host_ok():
                return self._json({"error": "cross-site request refused"}, 403)
            try:
                data = self._body()
            except BodyTooLarge as e:
                warn(f"rejected oversized stimlog body: {e}")
                return self._json({"error": str(e)}, 413)
            except Exception:
                return self._json({"error": "invalid JSON"}, 400)
            paths = log_paths(data.get("session"))
            if not paths:
                return self._json({"error": "missing or illegal session id"}, 400)
            rows = data.get("rows")
            if not isinstance(rows, list) or not rows:
                return self._json({"error": "no rows to append"}, 400)
            if not all(isinstance(r, dict) and r.get("n") is not None for r in rows):
                return self._json({"error": "every row needs a numeric n"}, 400)
            jsonl, csv_path = paths
            try:
                append_stimlog(jsonl, rows)
            except Exception as e:
                # The page shows this as a red banner. A trial log that fails quietly is the
                # bug we are fixing, so the failure has to reach the operator, not the console.
                warn(f"COULD NOT WRITE THE TRIAL LOG {jsonl.name!r}: {e}")
                return self._json({"error": f"could not append: {e}"}, 500)
            try:
                write_stimlog_csv(replay_stimlog(jsonl), csv_path)
            except Exception as e:
                # The record itself is already safe on disk; only the convenience copy failed.
                warn(f"trial log was saved but the CSV could not be rebuilt: {e}")
            return self._json({"ok": True, "appended": len(rows), "file": jsonl.name})
        if self.path == "/api/protocols":
            if not self._host_ok():
                return self._json({"error": "cross-site request refused"}, 403)
            try:
                data = self._body()
            except BodyTooLarge as e:
                warn(f"rejected oversized POST body: {e}")
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

    def do_PUT(self):
        if self.path.startswith("/api/session/"):
            if not self._host_ok():
                return self._json({"error": "cross-site request refused"}, 403)
            sid = unquote(self.path[len("/api/session/"):])
            p = session_path(sid)
            if not p:
                return self._json({"error": "illegal session id"}, 400)
            try:
                state = self._body()
            except BodyTooLarge as e:
                warn(f"rejected oversized session body: {e}")
                return self._json({"error": str(e)}, 413)
            except Exception:
                return self._json({"error": "invalid JSON"}, 400)
            if not isinstance(state, dict) or not state:
                return self._json({"error": "state must be a non-empty object"}, 400)
            try:
                save_session(p, state)
            except Exception as e:
                warn(f"COULD NOT SAVE THE SESSION {p.name!r}: {e}")
                return self._json({"error": f"could not save: {e}"}, 500)
            return self._json({"ok": True, "file": p.name})
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
    print(f"  trial log: {LOG_DIR}   (written as it plays — survives a frozen browser)")
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
