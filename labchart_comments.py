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

# The agent is on the lab network, one hop away. Never through a proxy: on a university Windows PC Python
# picks up the system proxy from the registry, and the proxy cannot (or will not) reach a PC next door —
# the comment then fails with a proxy error that reads like "PC not found" (2026-10-02).
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def urlopen(req, timeout):
    """urllib.request.urlopen, but straight to the agent, never via a proxy."""
    return _DIRECT.open(req, timeout=timeout)
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


def _config_file(root: Path) -> Path | None:
    """labchart.txt — or labchart.txt.txt, which is what Notepad makes of it on a Windows that hides
    extensions (it happened on the rig, 2026-10-02)."""
    for name in ("labchart.txt", "labchart.txt.txt", "labchart"):
        f = Path(root) / name
        if f.is_file():
            return f
    return None


def _read_text_any(f: Path) -> str:
    """UTF-8 (with or without BOM) or UTF-16, which Notepad writes when "Unicode" is chosen."""
    raw = f.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig", errors="replace")


def read_target(root: Path) -> str | None:
    """host:port from labchart.txt (first line that is not blank or a # comment), or None = off."""
    f = _config_file(root)
    if f is None:
        return None
    for line in _read_text_any(f).splitlines():
        line = line.strip().strip("\u200b\ufeff")
        if line and not line.startswith("#"):
            return line if ":" in line else f"{line}:{AGENT_PORT}"
    return None


def explain_missing_target(root: Path) -> str:
    """Why read_target found nothing — what is actually in the folder."""
    near = sorted(p.name for p in Path(root).iterdir() if p.name.lower().startswith("labchart"))
    f = _config_file(root)
    if f is not None:
        return (f"{f.name} is there but has no address line (every line is blank or starts with #). "
                f"Put the address on a line of its own, without #, e.g. 10.1.2.3:8766")
    return (f"no labchart.txt in {root}. Files here starting with 'labchart': {near or 'none'}. "
            f"Copy labchart.txt.example to labchart.txt in THIS folder and write the address in it.")


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
            with urlopen(f"http://{self.target}/ping", timeout=self.timeout) as r:
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
                with urlopen(req, timeout=self.timeout) as r:
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
