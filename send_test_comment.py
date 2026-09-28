"""
Check the path to LabChart before a session: ask the comment agent whether it can see LabChart, then
send three test comments and say how long each took.

    python send_test_comment.py                 # address from labchart.txt
    python send_test_comment.py 10.1.2.3:8766
"""
import json
import socket
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import labchart_comments  # noqa: E402


def main():
    target = (sys.argv[1] if len(sys.argv) > 1 else None) or labchart_comments.read_target(ROOT)
    if not target:
        sys.exit("no address: write the LabChart PC's address into labchart.txt, or pass it here")
    if ":" not in target:
        target += f":{labchart_comments.AGENT_PORT}"
    print(f"comment agent at {target}")
    try:
        with urllib.request.urlopen(f"http://{target}/ping", timeout=3) as r:
            print("  ping:", json.loads(r.read().decode("utf-8")))
    except Exception as e:
        sys.exit(f"  NOT reachable: {e}\n  Is the agent running on the LabChart PC, and does its Windows firewall "
                 f"allow it? Is the address right?")
    ok = 0
    for k in range(1, 4):
        text = f"test comment {k}/3 from {socket.gethostname()} at {time.strftime('%H:%M:%S')}"
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(f"http://{target}/comment", method="POST",
                                         data=json.dumps({"n": f"test{k}", "text": text}).encode("utf-8"),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as r:
                reply = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            reply = {"ok": False, "error": str(e)}
        ms = (time.perf_counter() - t0) * 1000
        print(f"  {text}: {'OK' if reply.get('ok') else 'FAILED ' + str(reply.get('error'))} ({ms:.0f} ms)")
        ok += bool(reply.get("ok"))
        time.sleep(1)
    print(f"{ok} of 3 comments arrived. Look for them in LabChart.")
    return 0 if ok == 3 else 1


if __name__ == "__main__":
    sys.exit(main())
