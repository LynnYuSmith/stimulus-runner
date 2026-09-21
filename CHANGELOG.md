# Changelog

## 1.1 — 2026-09-21

The session survives the rig PC. Everything here came from one thing: on 2026-09-18 the
stimulus computer froze mid-experiment and took the whole trial log with it, because the log
was a JavaScript array in the page and nowhere else.

**The log is on disk, not in the tab.** Every epoch is appended to `logs/stimlog_<session>.jsonl`
as it plays, flushed to disk on each write, with a CSV derived beside it. A badge in the log
card says where it is being written, and turns red if a write fails — silence is not allowed to
look like success.

**A session that dies is offered back.** The queue, the form and the log position are saved to
`logs/session_<id>.json` on every change. Reload after a crash and the page asks whether to
continue that session; taking the offer keeps writing into the same trial log. A run that was
in progress is never restored as running — that is for the person to decide.

**The contrast half of a back-to-back pair pulses 4 times.** When a grating follows a grating
with no grey between, the second one is the contrast partner, and it now says so in the marker
itself instead of relying on the analysis to infer it from adjacency.

**The queue no longer hangs on a drag.** Dropping a row that removed its own drag source left
Chrome on Windows in a stuck drag session and froze the whole interface. The move is recorded
on drop and applied on `dragend`. ▲▼ buttons on every row are the drag-free route.

**Both JSON exports threw on every click, in silence.** Fixed, and covered.

Also: screenshots in the README taken by a real Chrome that exits 1 on a console error; the CDP
scripts kill the Chrome they start on every exit path; a shorter README.

Tests: protocol, exports, log, queue, session, and a crash suite that pulls the process out
from under the writer. `npm test`.

## 1.0 — 2026-08

The first working presenter: seamless grey ↔ grating on one WebGL surface, binary square-wave
gratings matched frame-for-frame to the reference generator (including the oblique convention,
verified against pulse2percept), corner pulse markers the pipeline's photodiode decoder already
understands, a literal sequence of gratings and rest blocks, saved protocols as files in a
folder, a tiny standard-library server, the offline USB package with a bundled Python, field
zones, blitz and bar sweeps.
