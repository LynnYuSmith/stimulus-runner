"""LabChart comments, runner side to agent, with a fake LabChart: one comment per block, in order,
re-sent rows never duplicated, and an unreachable agent never holding anything up."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "labchart_agent"))
tmp = Path(tempfile.mkdtemp())
os.environ["LABCHART_AGENT_DIR"] = str(tmp)

import labchart_comments as lc  # noqa: E402
import labchart_agent  # noqa: E402

# the text
row = {"n": 17, "type": "moving", "direction_deg": 45, "temporal_freq_hz": 2, "contrast": 0.5,
       "spatial_freq_cpp": 0.02, "duration_s": 4, "waveform": "sine", "stim_code": "M045"}
t = lc.comment_text(row)
assert t == "#17 moving 45° · TF 2 Hz · C 50% · SF 0.02 c/px · 4 s · sine · [M045]", t
assert lc.comment_text({"n": 3, "type": "grey"}) == "#3 grey"
p = lc.comment_text({"n": 5, "type": "moving", "direction_deg": 90, "plaid_direction_deg": 210,
                     "plaid_temporal_freq_hz": 1})
assert p.startswith("#5 moving 90° + 210° @ 1 Hz"), p
print("text:", t)

# labchart.txt
d = Path(tempfile.mkdtemp())
assert lc.read_target(d) is None
(d / "labchart.txt").write_text("﻿# the LabChart PC\n10.1.2.3\n", encoding="utf-8")
assert lc.read_target(d) == "10.1.2.3:8766"

# the agent, fake LabChart, on a free port
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
threading.Thread(target=labchart_agent.main, args=(["--fake", "--port", str(port)],), daemon=True).start()
time.sleep(0.5)

fw = lc.CommentForwarder(f"127.0.0.1:{port}", tmp)
print("ping:", fw.ping())
assert "connected" in fw.ping()
blocks = [{"n": i, "type": "moving" if i % 2 else "grey", "direction_deg": 45 * i if i % 2 else None}
          for i in range(1, 11)]
fw.offer("S1", blocks[:3])
fw.offer("S1", [dict(blocks[1], duration_s=4.0), blocks[3]])      # a closed grey re-sent + a new block
fw.offer("S1", blocks[3:])                                           # block 4 again, and the rest
t0 = time.perf_counter()
while fw.sent + fw.failed < 10 and time.perf_counter() - t0 < 10:
    time.sleep(0.05)
lines = (tmp / "fake_comments.txt").read_text(encoding="utf-8").splitlines()
nums = [int(l.split("\t")[2].split()[0][1:]) for l in lines]
assert nums == list(range(1, 11)), nums
assert fw.sent == 10 and fw.failed == 0
recs = [json.loads(l) for l in (tmp / "S1.labchart.jsonl").read_text().splitlines()]
assert all(r["ok"] for r in recs) and len(recs) == 10
print(f"10 blocks -> 10 comments, in order, none repeated; round trip up to "
      f"{max(r['round_trip_ms'] for r in recs):.0f} ms")

# an agent that is not there: offering must return at once, and the failure must be recorded
dead = socket.socket(); dead.bind(("127.0.0.1", 0)); dead_port = dead.getsockname()[1]; dead.close()
fw2 = lc.CommentForwarder(f"127.0.0.1:{dead_port}", tmp, timeout=0.5)
t0 = time.perf_counter()
fw2.offer("S2", blocks)
took = (time.perf_counter() - t0) * 1000
assert took < 50, took
t0 = time.perf_counter()
while fw2.failed < 10 and time.perf_counter() - t0 < 15:
    time.sleep(0.05)
assert fw2.failed == 10 and fw2.sent == 0
print(f"unreachable agent: offer returned in {took:.1f} ms, all 10 failures recorded, nothing blocked")
print("ALL GOOD")
