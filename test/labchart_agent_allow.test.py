"""--allow takes computer names as well as addresses; an unknown sender gets 403, an unknown name lets no one in."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.chdir(tempfile.mkdtemp())                      # the agent writes its logs next to itself / here
sys.path.insert(0, str(ROOT / "labchart_agent"))
sys.path.insert(0, str(ROOT))
import labchart_agent                              # noqa: E402
import labchart_comments                           # noqa: E402


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def run_agent(allow):
    port = free_port()
    th = threading.Thread(target=labchart_agent.main, args=(["--fake", "--port", str(port), "--allow", allow],),
                          daemon=True)
    th.start()
    for _ in range(50):
        try:
            labchart_comments.urlopen(f"http://127.0.0.1:{port}/ping", timeout=0.5).close()
            break
        except urllib.error.HTTPError:
            break                                   # up, and answering (maybe 403)
        except Exception:
            time.sleep(0.1)
    return port


def status(port):
    try:
        with labchart_comments.urlopen(f"http://127.0.0.1:{port}/ping", timeout=2) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


cases = [("localhost", 200), ("127.0.0.1", 200), ("no-such-pc.invalid", 403), ("10.255.255.1", 403)]
for allow, want in cases:
    got = status(run_agent(allow))
    print(f"--allow {allow:20s} -> {got} (want {want})")
    assert got == want, (allow, got)
print("ALL GOOD")
