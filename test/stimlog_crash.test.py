#!/usr/bin/env python3
"""The trial log has to survive the crash it was written for. Run: python3 test/stimlog_crash.test.py

Why this exists. On 2026-09-18 the stimulus PC froze mid-session and the whole trial log went
with it, because the log lived only in the page's memory until someone clicked Export. The fix
is a server-side append-and-fsync per epoch. A fix for a crash is worth exactly as much as its
crash test, so this kills the server the way the rig killed the browser -- SIGKILL, no unwind,
no atexit, no flush -- and then asks the disk what survived.

What is deliberately NOT claimed: this cannot prove fsync reached the physical platter, which
would need a real power cut. Measured on 2026-09-18: deleting the ``os.fsync`` call leaves all
eleven of these green, because a closed file is already visible to another process from the page
cache. What they DO prove is that the bytes leave the server process before the POST is answered
-- which is the part the code controls, and the part a frozen browser or a killed server takes
away. The fsync is there for the power cut the tests cannot stage.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVE = ROOT / "serve.py"

passed = 0
failed = []


def test(name):
    def deco(fn):
        global passed
        try:
            fn()
            passed += 1
            print("  [ok] " + name)
        except Exception as e:                    # noqa: BLE001 - a runner reports, never raises
            failed.append((name, e))
            print("  [FAIL] " + name + "\n         " + repr(e))
    return deco


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """serve.py in its own process, logging into a throwaway directory."""

    def __init__(self, log_dir: Path, port=None):
        self.log_dir = log_dir
        self.port = port or free_port()
        env = dict(os.environ, STIMULUS_RUNNER_LOG_DIR=str(log_dir))
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVE), str(self.port), "--no-browser"],
            cwd=str(ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._wait_ready()

    def _wait_ready(self, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.get("/api/stimlog")
                return
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("server died at startup")
                time.sleep(0.05)
        raise RuntimeError("server did not come up")

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))

    def post(self, path, payload, host=None, raw=None):
        body = raw if raw is not None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url + path, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        if host:
            req.add_header("Host", host)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")

    def kill(self):
        """SIGKILL: no flush, no close, no atexit. This is the point of the file."""
        if self.proc.poll() is None:
            os.kill(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()


def epoch(n, type_="moving", ori=135, dur=4.0, contrast=1.0):
    return {"n": n, "wallclock": "2026-09-18T12:00:%02d.000" % n,
            "unix_ms": 1758000000000 + n * 1000,
            "type": type_, "direction_deg": ori, "orientation_deg": ori, "duration_s": dur,
            "spatial_freq_cpd": 0.04, "temporal_freq_hz": 2.0, "contrast": contrast}


print("crash tests for the durable trial log\n")

with tempfile.TemporaryDirectory() as td:
    LOGS = Path(td)

    @test("a posted epoch is on disk before the POST is answered, not buffered in the server")
    def _():
        srv = Server(LOGS / "t1")
        try:
            code, _resp = srv.post("/api/stimlog",
                                   {"session": "20260918-120000", "rows": [epoch(1)]})
            assert code == 200, code
            # read from THIS process: if the bytes were still in the server's buffer, this fails
            f = LOGS / "t1" / "stimlog_20260918-120000.jsonl"
            assert f.exists(), "no file"
            assert json.loads(f.read_text().splitlines()[0])["n"] == 1
        finally:
            srv.stop()

    @test("SIGKILL mid-session loses nothing that was acknowledged")
    def _():
        srv = Server(LOGS / "t2")
        sid = "20260918-130000"
        try:
            for n in range(1, 8):
                code, _ = srv.post("/api/stimlog", {"session": sid, "rows": [epoch(n)]})
                assert code == 200
            srv.kill()                      # the freeze
        finally:
            srv.stop()
        f = LOGS / "t2" / ("stimlog_%s.jsonl" % sid)
        rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
        assert [r["n"] for r in rows] == list(range(1, 8)), [r["n"] for r in rows]

    @test("a restarted server continues the same session file instead of starting over")
    def _():
        d = LOGS / "t3"
        sid = "20260918-140000"
        srv = Server(d)
        try:
            for n in (1, 2, 3):
                srv.post("/api/stimlog", {"session": sid, "rows": [epoch(n)]})
            srv.kill()
        finally:
            srv.stop()
        srv2 = Server(d)
        try:
            for n in (4, 5):
                srv2.post("/api/stimlog", {"session": sid, "rows": [epoch(n)]})
            got = srv2.get("/api/stimlog?session=" + sid)
        finally:
            srv2.stop()
        assert [r["n"] for r in got["rows"]] == [1, 2, 3, 4, 5], got["rows"]

    @test("the retroactive duration wins: the same n sent twice replays as the later value")
    def _():
        srv = Server(LOGS / "t4")
        sid = "20260918-150000"
        try:
            # a grey starts with no duration -- it lasts until the next thing happens
            srv.post("/api/stimlog", {"session": sid, "rows": [epoch(1, "grey", None, None)]})
            # ...and the page closes it when the next epoch begins, resending n=1
            srv.post("/api/stimlog", {"session": sid,
                                      "rows": [epoch(1, "grey", None, 3.71), epoch(2)]})
            got = srv.get("/api/stimlog?session=" + sid)
        finally:
            srv.stop()
        assert len(got["rows"]) == 2, got["rows"]
        assert got["rows"][0]["duration_s"] == 3.71, got["rows"][0]
        assert got["rows"][1]["n"] == 2

    @test("a torn final line (power cut mid-write) costs one row, never the file")
    def _():
        d = LOGS / "t5"
        sid = "20260918-160000"
        srv = Server(d)
        try:
            for n in (1, 2, 3):
                srv.post("/api/stimlog", {"session": sid, "rows": [epoch(n)]})
        finally:
            srv.stop()
        f = d / ("stimlog_%s.jsonl" % sid)
        f.write_text(f.read_text() + '{"n": 4, "type": "mov')      # the cut
        srv2 = Server(d)
        try:
            got = srv2.get("/api/stimlog?session=" + sid)
            code, _ = srv2.post("/api/stimlog", {"session": sid, "rows": [epoch(5)]})
            after = srv2.get("/api/stimlog?session=" + sid)
        finally:
            srv2.stop()
        assert [r["n"] for r in got["rows"]] == [1, 2, 3], got["rows"]
        assert code == 200, "appending after a torn line must still work"
        assert [r["n"] for r in after["rows"]] == [1, 2, 3, 5], after["rows"]

    @test("the CSV beside it carries the pipeline's column names and every row")
    def _():
        d = LOGS / "t6"
        sid = "20260918-170000"
        srv = Server(d)
        try:
            for n in (1, 2, 3):
                srv.post("/api/stimlog", {"session": sid, "rows": [epoch(n, ori=45 * n)]})
        finally:
            srv.stop()
        lines = (d / ("stimlog_%s.csv" % sid)).read_text().strip().split("\n")
        head = lines[0].split(",")
        # the names lib/stimulus/runner_log.load_stimlog reads
        for col in ("n", "wallclock", "unix_ms", "type", "direction_deg", "orientation_deg",
                    "duration_s"):
            assert col in head, "CSV header is missing " + col
        assert len(lines) == 4, lines
        assert lines[1].split(",")[head.index("direction_deg")] == "45"

    @test("a null field becomes an empty CSV cell, exactly as the browser's join(',') does")
    def _():
        d = LOGS / "t7"
        sid = "20260918-180000"
        srv = Server(d)
        try:
            srv.post("/api/stimlog", {"session": sid, "rows": [epoch(1, "grey", None, None)]})
        finally:
            srv.stop()
        lines = (d / ("stimlog_%s.csv" % sid)).read_text().strip().split("\n")
        head, row = lines[0].split(","), lines[1].split(",")
        assert row[head.index("direction_deg")] == "", row
        assert row[head.index("duration_s")] == "", row
        assert row[head.index("type")] == "grey", row

    @test("a session id cannot escape the log directory")
    def _():
        d = LOGS / "t8"
        srv = Server(d)
        try:
            for bad in ("../../../../tmp/pwned", "a/b", "", "..", "x" * 90, " x"):
                code, resp = srv.post("/api/stimlog", {"session": bad, "rows": [epoch(1)]})
                assert code == 400, "%r was accepted (%s)" % (bad, code)
                assert "error" in resp
        finally:
            srv.stop()
        assert not Path("/tmp/pwned.jsonl").exists()
        assert list(d.glob("*")) == [], list(d.glob("*"))

    @test("malformed and oversized bodies are refused, and nothing is written")
    def _():
        d = LOGS / "t9"
        srv = Server(d)
        try:
            assert srv.post("/api/stimlog", None, raw=b"{not json")[0] == 400
            assert srv.post("/api/stimlog", {"session": "20260918-190000"})[0] == 400
            assert srv.post("/api/stimlog", {"session": "20260918-190000", "rows": []})[0] == 400
            # a row without n cannot be replayed or superseded, so it is refused, not stored
            assert srv.post("/api/stimlog",
                            {"session": "20260918-190000",
                             "rows": [{"type": "moving"}]})[0] == 400
            big = json.dumps({"session": "20260918-190000",
                              "rows": [epoch(1)] * 20000}).encode()
            assert len(big) > 1048576
            assert srv.post("/api/stimlog", None, raw=big)[0] == 413
        finally:
            srv.stop()
        assert list(d.glob("*")) == [], list(d.glob("*"))

    @test("a cross-site POST cannot write the log")
    def _():
        d = LOGS / "t10"
        srv = Server(d)
        try:
            code, _ = srv.post("/api/stimlog",
                               {"session": "20260918-200000", "rows": [epoch(1)]},
                               host="evil.example.com")
            assert code == 403, code
        finally:
            srv.stop()
        assert list(d.glob("*")) == [], list(d.glob("*"))

    @test("two sessions land in two files, and the listing counts each")
    def _():
        d = LOGS / "t11"
        srv = Server(d)
        try:
            srv.post("/api/stimlog", {"session": "20260918-210000", "rows": [epoch(1), epoch(2)]})
            srv.post("/api/stimlog", {"session": "20260918-213000", "rows": [epoch(1)]})
            listing = srv.get("/api/stimlog")
        finally:
            srv.stop()
        by_id = dict((s["id"], s["rows"]) for s in listing["sessions"])
        assert by_id == {"20260918-210000": 2, "20260918-213000": 1}, by_id

print()
if failed:
    print("%d passed, %d FAILED" % (passed, len(failed)))
    for name, e in failed:
        print("  - %s: %r" % (name, e))
    sys.exit(1)
print("  %d crash tests passed" % passed)
