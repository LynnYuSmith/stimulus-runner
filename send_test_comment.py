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
        sys.exit("no address: " + labchart_comments.explain_missing_target(ROOT) +
                 "\n  Or give the address directly:  SEND-TEST-COMMENT.bat 10.1.2.3:8766")
    if ":" not in target:
        target += f":{labchart_comments.AGENT_PORT}"
    print(f"comment agent at {target}")
    try:
        with labchart_comments.urlopen(f"http://{target}/ping", timeout=3) as r:
            print("  ping:", json.loads(r.read().decode("utf-8")))
    except Exception as e:
        sys.exit(f"  NOT reachable: {e}\n"
                 f"  Check, in this order:\n"
                 f"   1. the agent window is open on the LabChart PC and shows this address;\n"
                 f"   2. from this PC, in PowerShell:  Test-NetConnection {target.split(':')[0]} -Port {target.split(':')[1]}\n"
                 f"      TcpTestSucceeded False = the network or the LabChart PC's firewall blocks it\n"
                 f"      (Windows Defender Firewall -> allow the agent's python.exe on private/domain networks);\n"
                 f"   3. both PCs are on the same network (a VPN on one of them can hide the other).")
    ok = 0
    for k in range(1, 4):
        text = f"test comment {k}/3 from {socket.gethostname()} at {time.strftime('%H:%M:%S')}"
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(f"http://{target}/comment", method="POST",
                                         data=json.dumps({"n": f"test{k}", "text": text}).encode("utf-8"),
                                         headers={"Content-Type": "application/json"})
            with labchart_comments.urlopen(req, timeout=3) as r:
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
