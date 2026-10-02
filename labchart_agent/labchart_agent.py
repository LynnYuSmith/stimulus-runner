"""
The comment agent: runs on the LabChart PC and puts every line it is sent into the running LabChart
recording as a comment, through LabChart's own automation interface (ADIChart.Application ->
ActiveDocument.AppendComment(text, channel); channel -1 = all channels; --channel sets it, e.g. the photodiode).

    python labchart_agent.py                    # listen on port 8766 for the stimulus runner
    python labchart_agent.py --allow STIM-PC       # only the stimulus PC (a computer name or an address)
    (or write that name into allow.txt next to this file — kept out of git — and START-AGENT.bat picks it up)
    python labchart_agent.py --com-test         # no network: put one comment into LabChart and exit
    python labchart_agent.py --fake             # no LabChart: record the comments to fake_comments.txt

LabChart 8 must be open with a document (recording, for the comments to sit at the current time).
All COM calls happen on one thread, as COM requires; web requests wait for it for at most 2 s.
Everything is logged to agent-log.txt and comments.csv next to this file.
Endpoints: GET /ping -> {"labchart": bool, "document": name}; POST /comment {"text", "channel", "n"}.
"""
from __future__ import annotations

import argparse
import csv
import http.server
import json
import os
import queue
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
OUT = Path(os.environ.get("LABCHART_AGENT_DIR") or HERE)      # where the logs go
PORT = 8766
MAX_TEXT = 500
LOCK = threading.Lock()


def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}  {msg}"
    with LOCK:
        print(line, flush=True)
        with open(OUT / "agent-log.txt", "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


class RealLabChart:
    """LabChart's COM server, opened on (and only used from) the COM thread."""

    def __init__(self):
        import comtypes
        import comtypes.client
        comtypes.CoInitialize()
        self.cc = comtypes.client
        self.app = None

    def _app(self):
        if self.app is None:
            self.app = self.cc.GetActiveObject("ADIChart.Application", dynamic=True)
        return self.app

    def document(self):
        doc = self._app().ActiveDocument
        if doc is None:
            raise RuntimeError("LabChart is open but has no document")
        try:
            return doc, str(doc.Name)
        except Exception:
            return doc, "?"

    def comment(self, text, channel):
        for attempt in (1, 2):                   # LabChart restarted: reconnect once
            try:
                doc, _ = self.document()
                doc.AppendComment(text, channel)
                return
            except Exception:
                self.app = None
                if attempt == 2:
                    raise


class FakeLabChart:
    def __init__(self):
        self.path = OUT / "fake_comments.txt"

    def document(self):
        return None, "FAKE"

    def comment(self, text, channel):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(f"{time.time():.3f}\t{channel}\t{text}\n")


class ComThread:
    def __init__(self, fake):
        self.q: queue.Queue = queue.Queue()
        self.fake = fake
        threading.Thread(target=self._run, name="com", daemon=True).start()

    def _run(self):
        try:
            lc = FakeLabChart() if self.fake else RealLabChart()
        except Exception as e:
            lc = None
            startup_error = f"comtypes / COM could not start: {e!r}"
        while True:
            job, arg, done = self.q.get()
            try:
                if lc is None:
                    raise RuntimeError(startup_error)
                if job == "ping":
                    _, name = lc.document()
                    done["result"] = {"labchart": True, "document": name}
                else:
                    t0 = time.perf_counter()
                    lc.comment(*arg)
                    done["result"] = {"ok": True, "com_ms": round((time.perf_counter() - t0) * 1000, 2)}
            except Exception as e:
                done["result"] = {"ok": False, "labchart": False, "error": f"{type(e).__name__}: {e}"}
            done["event"].set()

    def call(self, job, arg=None, timeout=2.0):
        done = {"event": threading.Event()}
        self.q.put((job, arg, done))
        if not done["event"].wait(timeout):
            return {"ok": False, "labchart": False, "error": f"LabChart did not answer within {timeout} s"}
        return done["result"]


COM = None
ALLOW: set[str] = set()
CHANNEL = -1                                      # the LabChart channel comments go on; -1 = all


def record(peer, n, text, result):
    new = not (OUT / "comments.csv").exists()
    with LOCK, open(OUT / "comments.csv", "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["time", "from", "n", "ok", "com_ms", "error", "text"])
        w.writerow([datetime.now().isoformat(timespec="milliseconds"), peer, n, result.get("ok"),
                    result.get("com_ms", ""), result.get("error", ""), text])


class Allow:
    """Who may send comments: addresses and/or computer names (e.g. STIM-PC).

    A name is looked up when the agent starts and again whenever a request comes from an address not yet
    known (at most every 10 s) — on a university network a PC can get a new address after a restart. A name
    that cannot be looked up lets nobody in, and says so."""

    def __init__(self, text):
        self.entries = [x.strip() for x in str(text or "").split(",") if x.strip()]
        self.ips, self._last = set(), 0.0
        self.resolve(loud=True)

    def __bool__(self):
        return bool(self.entries)

    @staticmethod
    def _is_ip(x):
        for fam in (socket.AF_INET, socket.AF_INET6):
            try:
                socket.inet_pton(fam, x)
                return True
            except OSError:
                pass
        return False

    def resolve(self, loud=False):
        ips = set()
        for e in self.entries:
            if self._is_ip(e):
                ips.add(e)
                continue
            try:
                found = {ai[4][0] for ai in socket.getaddrinfo(e, None)}
                ips |= found
                if loud:
                    log(f"allowed sender {e} = {', '.join(sorted(found))}")
            except OSError as exc:
                log(f"WARNING: cannot look up the computer name {e!r} ({exc}); it cannot send until it can be "
                    f"found. Use its address instead (ipconfig on that PC) if this persists.")
        self.ips, self._last = ips, time.monotonic()
        return ips

    def permits(self, peer):
        if peer in self.ips:
            return True
        if any(not self._is_ip(e) for e in self.entries) and time.monotonic() - self._last > 10:
            self.resolve()
            return peer in self.ips
        return False


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self):
        peer = self.client_address[0]
        if ALLOW and not ALLOW.permits(peer):
            log(f"refused {peer} (not in --allow {', '.join(ALLOW.entries)})")
            self._send({"ok": False, "error": "address not allowed"}, 403)
            return False
        return True

    def do_GET(self):
        if not self._allowed():
            return
        if self.path.startswith("/ping"):
            return self._send(COM.call("ping"))
        self._send({"ok": False, "error": "unknown path"}, 404)

    def do_POST(self):
        if not self._allowed():
            return
        if not self.path.startswith("/comment"):
            return self._send({"ok": False, "error": "unknown path"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(min(n, 64 * 1024)).decode("utf-8"))
            text = str(data.get("text", ""))[:MAX_TEXT]
            channel = int(data.get("channel", CHANNEL))
        except Exception as e:
            return self._send({"ok": False, "error": f"bad request: {e}"}, 400)
        if not text:
            return self._send({"ok": False, "error": "empty text"}, 400)
        result = COM.call("comment", (text, channel))
        record(self.client_address[0], data.get("n", ""), text, result)
        if not result.get("ok"):
            log(f"comment FAILED from {self.client_address[0]}: {result.get('error')} | {text}")
        self._send(result, 200 if result.get("ok") else 503)

    def log_message(self, fmt, *args):
        pass


def addresses():
    out = set()
    try:
        out.update(a for a in socket.gethostbyname_ex(socket.gethostname())[2] if not a.startswith("127."))
    except OSError:
        pass
    try:                                         # the address used to reach the network
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        out.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(out) or ["?"]


def main(argv=None):
    global COM, ALLOW, CHANNEL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--allow", default="", help="comma-separated computer names or addresses allowed to send (default: any)")
    ap.add_argument("--channel", type=int, default=-1,
                    help="LabChart channel the comments go on, numbered as LabChart shows them "
                         "(e.g. 1 = the photodiode); -1 = all channels (default)")
    ap.add_argument("--com-test", action="store_true", help="put one comment into LabChart and exit")
    ap.add_argument("--fake", action="store_true", help="no LabChart: write comments to fake_comments.txt")
    a = ap.parse_args(argv)
    COM = ComThread(a.fake)
    CHANNEL = a.channel
    allow = a.allow
    if not allow:                                # the rig's own list, kept out of the repository
        f = Path(__file__).resolve().parent / "allow.txt"
        if f.is_file():
            allow = ",".join(x.strip() for x in f.read_text(encoding="utf-8-sig").splitlines()
                             if x.strip() and not x.strip().startswith("#"))
    ALLOW = Allow(allow)

    if a.com_test:
        r = COM.call("ping")
        log(f"COM test: {r}")
        if r.get("labchart"):
            r = COM.call("comment", (f"COM test from the comment agent, {datetime.now():%H:%M:%S}", CHANNEL))
            log(f"COM test comment: {r}")
        return 0 if r.get("ok") or r.get("labchart") else 1

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    log(f"comment agent listening on port {a.port}; this PC's address(es): {', '.join(addresses())}")
    log(f"put that address into labchart.txt next to serve.py on the stimulus PC, e.g.  {addresses()[0]}:{a.port}")
    log("allowed senders: " + (", ".join(ALLOW.entries) if ALLOW else "ANY (use --allow <stimulus PC name or address> to restrict)"))
    log(f"comments go on LabChart channel {CHANNEL}" + (" (all channels)" if CHANNEL == -1 else ""))
    log(f"LabChart: {COM.call('ping')}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
