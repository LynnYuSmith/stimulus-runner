"""
Forward every played block to LabChart as a comment, the moment it starts.

The page sends each block's row to serve.py as it begins (and re-sends rows it has to amend: a
grey's duration, a pair's code). The first time serve.py sees a block number it hands a one-line
description to the comment agent on the LabChart PC, which puts it into the running recording with
LabChart's own AppendComment. Only the text travels: the TIME of the block is still the photodiode's,
and the block number in every comment ties the two together.

On by the presence of labchart.txt next to serve.py, holding the agent's address (host or host:port).
Sending runs on its own thread with a short timeout, so an unreachable LabChart PC can never hold up
the page or the trial log. Every attempt is recorded in logs/<session>.labchart.jsonl.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

AGENT_PORT = 8766


def _num(v):
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _fmt(v):
    return f"{v:g}"


def comment_text(row: dict) -> str:
    """One readable line per block, starting with its number: '#17 moving 45° · TF 2 Hz · C 50% · ...'."""
    n, kind = row.get("n"), str(row.get("type") or "?")
    parts = [f"#{n} {kind}"]
    d = _num(row.get("direction_deg"))
    if d is not None:
        parts[0] += f" {_fmt(d)}°"
    plaid = _num(row.get("plaid_direction_deg"))
    if plaid is not None:
        pt = _num(row.get("plaid_temporal_freq_hz"))
        parts[0] += f" + {_fmt(plaid)}°" + (f" @ {_fmt(pt)} Hz" if pt is not None else "")
    tf, c, sf, dur = (_num(row.get(k)) for k in ("temporal_freq_hz", "contrast", "spatial_freq_cpp", "duration_s"))
    if tf is not None:
        parts.append(f"TF {_fmt(tf)} Hz")
    if c is not None:
        parts.append(f"C {_fmt(round(c * 100, 1))}%")
    if sf is not None:
        parts.append(f"SF {_fmt(sf)} c/px")
    if dur is not None:
        parts.append(f"{_fmt(dur)} s")
    if row.get("waveform"):
        parts.append(str(row["waveform"]))
    if row.get("stim_code"):
        parts.append(f"[{row['stim_code']}]")
    return " · ".join(parts)[:250]


def read_target(root: Path) -> str | None:
    """host:port from labchart.txt (first line that is not blank or a # comment), or None = off."""
    f = Path(root) / "labchart.txt"
    if not f.is_file():
        return None
    for line in f.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line if ":" in line else f"{line}:{AGENT_PORT}"
    return None


class CommentForwarder:
    def __init__(self, target: str, log_dir: Path, timeout: float = 1.5):
        self.target, self.log_dir, self.timeout = target, Path(log_dir), timeout
        self.url = f"http://{target}/comment"
        self.seen: set[tuple[str, int]] = set()
        self.lock = threading.Lock()
        self.q: queue.Queue = queue.Queue(maxsize=10000)
        self.sent = self.failed = 0
        threading.Thread(target=self._run, name="labchart-comments", daemon=True).start()

    def ping(self) -> str:
        try:
            with urllib.request.urlopen(f"http://{self.target}/ping", timeout=self.timeout) as r:
                d = json.loads(r.read().decode("utf-8"))
            return (f"agent reachable; LabChart {'connected, document ' + repr(d.get('document')) if d.get('labchart') else 'NOT connected: ' + str(d.get('error'))}")
        except Exception as e:
            return f"agent NOT reachable ({e})"

    def offer(self, session: str, rows: list[dict]) -> int:
        """Queue a comment for every block number not seen before in this session. Never blocks."""
        new = 0
        for r in rows:
            try:
                key = (str(session), int(r.get("n")))
            except (TypeError, ValueError):
                continue
            with self.lock:
                if key in self.seen:
                    continue
                self.seen.add(key)
            try:
                self.q.put_nowait((session, key[1], comment_text(r), time.time()))
                new += 1
            except queue.Full:
                self._record(session, {"n": key[1], "ok": False, "error": "queue full"})
        return new

    def _record(self, session, entry):
        try:
            with open(self.log_dir / f"{session}.labchart.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def _run(self):
        while True:
            session, n, text, queued = self.q.get()
            t0 = time.time()
            entry = {"n": n, "text": text, "queued_unix": round(queued, 3)}
            try:
                req = urllib.request.Request(self.url, method="POST",
                                             data=json.dumps({"n": n, "text": text, "channel": -1}).encode("utf-8"),
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    reply = json.loads(r.read().decode("utf-8"))
                entry.update(ok=bool(reply.get("ok")), agent=reply)
            except Exception as e:
                entry.update(ok=False, error=str(e))
            entry["round_trip_ms"] = round((time.time() - t0) * 1000, 1)
            entry["delay_after_onset_ms"] = round((time.time() - queued) * 1000, 1)
            if entry["ok"]:
                self.sent += 1
            else:
                self.failed += 1
            self._record(session, entry)
