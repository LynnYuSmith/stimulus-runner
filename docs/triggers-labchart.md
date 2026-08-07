# Roadmap — hardware trigger-out (LabChart / physiology)

**Status: planned, not built.** This note captures the design so the later phase is a
small step, not a rethink.

## Goal

Emit a **trigger** at each stimulus block onset that a physiology recorder (LabChart /
PowerLab) captures on its own channel, so the stimulus timeline is marked *inside* the
physiology trace — no post-hoc alignment for breathing / temperature / ECG. This is the
LabChart analogue of the RED corner pulse the 2-photon photodiode already reads.

## Where it lives: the server, not the browser

A browser page cannot toggle a hardware line (sandbox). The trigger driver therefore lives
in **`serve.py`** — which is exactly why the small local server is the right foundation. The
page already tracks block onsets (`openBlock` / `closeBlock` / `playedEvents`); the later
phase adds a `POST /api/trigger` the page hits at each onset, and `serve.py` pulses the
hardware. One process, no new server.

## Two routes (pick when we build it)

| route | hardware | timing | notes |
|---|---|---|---|
| **USB-serial TTL** (recommended) | a $5–30 Arduino / LabJack / FTDI DTR line → LabChart digital or trigger input | ~1 ms, jitter-tight | `pyserial` (or raw DTR toggle, stdlib-only via `pyserial` optional). Robust, decode by pulse count. |
| **Audio-out pulse** | just a 3.5 mm → BNC cable into a LabChart analog input | ~10–20 ms (audio buffering) | zero extra device; level-match needed. Fine for block-level marks, not frame-level. |

Both fire **one pulse per block onset**, optionally **pulse-count-coded** by block type /
orientation (same idea as the RED marker: grey=1, static=2, moving=3, …), so LabChart can
decode *which* stimulus, not just *that* a stimulus happened.

## Ground truth stays the photodiode

As with the 2-photon path, the trigger is the *intended* onset; if frame-exact LabChart
alignment is ever needed, the photodiode / recorded pulse is the truth and the two align
post-hoc. The trigger-out is for convenience and live marking, not to replace the
photodiode.

## Not in scope for this note

The closed-loop **camera trigger** ("present when the mouse has been calm ≥ 2 s") is a
separate later phase; it shares the same server home but is driven by the behavior camera,
not the stimulus clock.
