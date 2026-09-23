# Changelog

## 1.2 — 2026-09-23

**Plaids: two gratings summed frame by frame, each moving on its own.** Turn on the second
grating and it gets **its own direction** and **its own temporal frequency**; each carries its
own phase, so the two are never locked together and the screen shows their sum at every frame.
**Plaid sum** says what the contrast slider means — per component (each grating at that
contrast, the sum spanning twice it) or per plaid (the pair inside it, each grating at half).

**Standing gratings modulate instead of moving.** A **still** grating now holds its pattern and
reverses its contrast at a rate you set; **0 is a plain standing grating**, as before. Each
grating of a plaid reverses at its own rate, so two standing gratings summed gives the
contrast-reversing plaid of the cat experiment, while the drifting form stays the default for
the mouse. The rate sliders relabel themselves, and the exported protocol states which meaning
was in force (`temporal_freq_role`: `drift_hz` or `reversal_hz`).

**+ plaid** and **+ plaid sweep** — one plaid as the form reads it, or the pair rotated through
all eight directions in 45° steps, the grid the single-grating sweep already uses. After Lin,
Okun, Carandini & Harris 2015 (*Neuron* 87:644), whose design this borrows.

**The record says what the second grating was.** New `plaid_direction_deg` and
`plaid_temporal_freq_hz` columns in the trial log and its recovered CSV; the same plus
`plaid_angle_deg`, `component_directions_deg`, `component_temporal_freqs_hz`,
`plaid_contrast_per` and `temporal_freq_role` in the exported protocol; the block label reads
*Moving plaid 0°+90°* and never as a plain 0° grating. The photodiode marker is unchanged — a
plaid counts as a moving or still grating — so nothing already recorded changes meaning.

**Every settings card folds**, and which ones are open is saved with the session, so a cockpit
arranged for the night comes back arranged after a reload or a crash. The trial log keeps its
window: folding had let the table grow straight out of the card.

**Contrast pairs.** **+ contrast** queues a 4c4s pair — the same grating one way, then straight
back the other with no grey between — and **+ contrast sweep** queues four of them covering all
eight directions (135c315, 180c0, 225c45, 270c90), grey between the pairs and never inside one.
A plaid turns both of its gratings, so only the drift reverses. The contrast half is marked
where it always was, at presentation time, so it carries 4 pulses and `role=contrast` without
anything new being trusted.

**The record now says what a block WAS, separately from what it belongs to.** The trial log's
`role` column is replaced by four: `stim_kind` (`grating`, or `plaid` when two gratings are
summed — superimposed, so not a grating), `stim_code` (`135`, `0p90`), and `pair_code` +
`pair_part` for the contrast pair. The second half of a pair is no longer labelled "contrast":
both halves are gratings, and it is the two together that are the contrast stimulus. The
photodiode marker is untouched — the second half still carries its four pulses. The pipeline
derives its own base/contrast labels from the photodiode and never read this column, so nothing
downstream changes; its own vocabulary still says "contrast" for the second epoch.

**The queue is written in the MESc comments' own notation**, shown under the Sequence header
with a button to copy it: `135` a grating, `0p90` a plaid, `135c315` a contrast pair. Each
grating's code also goes into the exported protocol as `stim_code`, so the comment typed at the
microscope and the record the runner keeps cannot drift apart.

**The Sequence card carries the grating's duration and direction too**, beside the rest/grey
slider, so building a queue does not mean scrolling back up. They are mirrors of the fields in
Custom grating, not a second pair of settings — one value each, shown twice, because two copies
of the same quantity drift and the one you were not looking at is the one that reaches the
recording.

**The queue says it is read-only while it plays.** Clear, the row deletes and the reorder
arrows have always refused to act during a run; they refused silently, so pressing Clear
mid-run looked exactly like a frozen program. They are now disabled, with a tooltip saying to
stop the run first, and they come back the moment it stops.

**Checked under load:** eight rounds of queueing a plaid sweep, running it, switching the
motion mode mid-run and clearing the queue held 62–63 fps with a 1–2 MB heap and no
exceptions. A mid-run mode switch changes the form, not the blocks already queued — the queue
is literal, and what is playing keeps the settings it was queued with.

**Known, not a bug:** the default binary waveform makes a three-level chequer rather than the
smooth interference pattern a plaid usually means. Switch the waveform to sinusoid for plaids.

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
