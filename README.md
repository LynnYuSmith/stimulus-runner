# stimulus-runner

An interactive, browser-based **drifting/static grating presenter** for two-photon rig
experiments. A grey (or black) screen you switch — seamlessly — to a grating of a chosen
orientation, spatial/temporal frequency, contrast, and duration, then back. Build a
sequence of gratings and grey/black rest blocks, run it in order, and it writes the played
protocol so it overlays onto the recording.

Gratings match the reference stimulus videos: a **binary (square-wave)** grating by default
(sinusoid is an option), defined in **cycles per pixel** on a virtual frame (default
104 × 150 px → 0.02 cyc/px = 3 cycles across the width), scaled to a configurable output
size.

This is **v1 (manual presenter)** — a light replacement for an aging MATLAB stimulus rig.
Saved protocols live as plain JSON files in a `protocols/` folder, owned by a tiny
standard-library server (`serve.py`) — the browser is a pure player, with no browser storage.
A closed-loop camera trigger ("fire when the mouse has been calm ≥ 2 s") and a hardware
**trigger-out** (e.g. a TTL into LabChart) are planned later phases that build on that same
one small server.

## Two screens

- **Stimulus screen** — a full-screen WebGL canvas showing only the grating (and the corner
  marker). Open it with **“Open stimulus window”**, drag it to the mouse's monitor, and it
  goes full-screen. No second monitor? Use **“Fullscreen here”**.
- **Operator control screen** — the cockpit: quick-grating buttons, a custom-grating form,
  the queue, the trial log, and a live mirror of what the mouse sees.

The two are one page in two roles (`#stim` vs control), talking over `postMessage` — no
install. The only backend is the tiny `serve.py`, and only the saved-protocol list uses it;
presentation itself is pure browser.

## Run it

Run the tiny server from this folder — it serves the page **and** owns the `protocols/`
folder (so saving a protocol writes a file, not browser storage) and auto-opens the runner
in Chrome (or Edge):

```bash
python serve.py               # opens http://127.0.0.1:8000 in Chrome / Edge
python serve.py 8080          # pick a port
python serve.py --no-browser  # don't open a tab (one is already open)
```

It is **standard-library only** (Python 3.8+), binds to `127.0.0.1` only (never the network —
it writes files), and is one light process: idle it uses ~0 % CPU and ~20 MB RAM, and you run
it only while presenting. **Windows:** `python serve.py` (or `py serve.py`). It prefers a
Chromium browser for reliable WebGL + full-screen — **Chrome, else Edge**, else the system
default. (Internet Explorer cannot run this page — it needs modern ES6+ JavaScript and WebGL1; on
Windows use Edge. No dedicated GPU is required — integrated graphics such as Intel HD on an i3 run it.)

*Gratings-only, no server:* the page also opens with any static server
(`python -m http.server 8000`) or straight from the file — everything works **except** the
saved-protocol list, which needs `serve.py`.

Keyboard: **Space** present (**pause / resume** while a sequence is running) · **G/Esc** grey ·
**B** black · **1–8** presets. Click the **manual** link in the header for an in-app guide, and
**click any value** beside a slider to type an exact number.

The quick orientation buttons (and **1–8**) present at the preset orientation but honour the
current **moving / still** toggle — a still quick-button stays static (2-pulse marker), a
moving one drifts (3-pulse) — so the motion choice is never silently overridden.

## Seamless grey / black ↔ grating

Grey, black, and grating are the **same** WebGL surface, never torn down: grey is a grating
at **contrast 0** on the grey mean luminance, black is the same at mean luminance 0.
Switching changes shader uniforms between frames — no scene rebuild, no black frame, no
flash.

```
L(x,y,t) = L_mean · (1 + C · wave(2π·f·(x·cosθ + y·sinθ) + φ(t)))
```

`wave` is a **square wave** by default (thresholded at the midpoint — the same binarization
the reference videos use), or a sinusoid if you switch *Waveform*. Spatial frequency `f` is
in **cycles per (frame) pixel**; with the default 150 px width, 0.02 cyc/px is 3 cycles
across. Grey level, frame size, marker corner/size, output size, and pixelation are all set
in *Screen & stimulus*. Gamma linearization (LUT) is not yet applied.

The orientation convention is matched to the reference generator: the vertical term is
`− fy·sin θ` (screen y runs top→bottom, the generator's runs bottom→top), and the drift
phase decreases over time. This was verified frame-for-frame against the pulse2percept
generator at 0/45/90/135° — without it, oblique orientations (45°/135°) would come out
mirrored and every oblique tuning label would be wrong.

## Sequence (grating + grey/black rest blocks)

The sequence is a **literal** list of blocks, each run for its own duration, in order:
add the current grating, a grey rest block, a black rest block, or a full 0–315° sweep
(with a grey gap between gratings). This mirrors a real protocol — black pads, grey blocks,
gratings — so a played sequence maps straight onto the recording. The header shows the block
count and the **total length** of the sequence.

- **Reorder by dragging.** Grab a queue row by its **⠿** handle (or anywhere on the row) and
  drop it above or below another; an insert line shows where it lands. Disabled while a queue
  is running.
- **Pause / resume.** While a sequence runs, **Space** (or the **⏸ Pause** button) freezes the
  drift on both screens and holds the sequence; pressing again resumes from the same spot. Both
  the pause and the resume are written to the trial log.
- **Saved protocols — a folder, not the browser.** Name the current queue and **★ Save** it;
  `serve.py` writes it to `protocols/<name>.json`. Pick a saved protocol and **Load** it
  (replaces the current queue) or **Delete** it. Because they are plain files, they travel
  with the folder: copy the folder to another computer — or commit it to git — and the same
  protocols are there, independent of any browser. A starter `protocols/8-ori sweep.json`
  ships as an example.

## Corner pulse markers (matches the pipeline)

At each onset a **RED** square flashes in a screen **corner** (top-right by default,
configurable), pulse-coded by **count** (mice are red-blind; a photodiode reads it). This
reproduces the pipeline's generator one-to-one, so the recording's photodiode and the
existing decoder read it unchanged:

| block | marker pulses |
|-------|---------------|
| grey  | **1** |
| static grating | **2** |
| moving grating | **3** |
| black (rest) | 0 (no marker) |

Pulse = 3 frames on, 3 frames off, at 51 fps (the legacy stimulus-video reference). These
constants live in `protocol.js` and are unit-tested against the pipeline values.

## The played protocol (overlay onto the MAT)

**Export protocol (MAT)** writes `protocol_played.json`: the blocks actually shown, in
order, with cumulative times, `label`, `orientation_deg`, and `marker_pulses` — in the
pipeline's protocol schema. These are the *intended* (wall-clock) onsets; the recording's
photodiode gives the true, frame-exact onset, and the two align post-hoc.

The **trial log** records every block — gratings **and** the grey / black rest starts — with
a wall-clock timestamp, oldest at the top (newest scrolls into view at the bottom). It
exports as CSV/JSON.

## What's here

- `index.html` — the app (UI, WebGL renderer, dual-screen wiring, queue, logging).
- `protocol.js` — the **pure** logic (marker encoding, stimulus defaults matched to the
  generator, the played-protocol builder, the sequence timeline). No DOM/WebGL, so it is
  unit-tested headless.
- `serve.py` — the tiny standard-library server: serves the page, opens it in Chrome/Edge,
  and reads/writes the `protocols/` folder (`GET/POST/DELETE /api/protocols`). Localhost-only,
  no dependencies.
- `protocols/` — saved protocols, one JSON file each (`{name, blocks}`); ships an
  `8-ori sweep` example.
- `test/protocol.test.js` — `node test/protocol.test.js` (or `npm test`).

## Verification

The **protocol/marker logic is node-tested** (`npm test`, 12 checks) and the page's inline
script is syntax-checked. The **visual output, drag-reorder, and on-screen timing must be
verified in a browser on the rig** — that can't be tested headless. The photodiode remains
the timing ground truth by design, so browser presentation jitter is *measured*, not feared.

## Where this sits, and what to cite

This is **not** a general-purpose stimulus platform, and it does not try to be. The field
already has excellent, mature tools — this is a narrow, no-install **drop-in** whose corner
marker and pixel geometry are byte-matched to one existing analysis pipeline's photodiode
decoder, so a played protocol lands on the recording with no new alignment code. If you need
a full stimulus system, use one of the tools below instead.

**Prior art (use these for anything general):**

- **PsychoPy / PsychoJS + Pavlovia** — Peirce et al. 2019, *Behav Res Methods* 51:195–203.
  The field standard; PsychoJS already renders drifting gratings in the browser via WebGL.
- **Psychtoolbox-3** — Brainard 1997; Pelli 1997; Kleiner et al. 2007. The MATLAB standard
  (and the likely ancestor of the "aging MATLAB rig" this replaces).
- **QDSpy** — Euler lab, Tübingen (`github.com/eulerlab/QDSpy`). The direct inspiration for
  the patterns borrowed here: per-frame shader-uniform swaps for seamless transitions, a
  corner-marker + TTL scheme, an await-trigger presenter state (the v2/v3 closed-loop hook),
  dual-screen operator preview, and gamma-LUT calibration. Reference, not a dependency.
- **BonVision** — Lopes et al. 2021, *eLife* 10:e65541 (on **Bonsai**, Lopes et al. 2015).
  Open-source GPU visual environments for rodents with native hardware I/O and closed-loop —
  it already implements the closed-loop + trigger-out roadmap noted above; evaluate it before
  building that here.
- **StimServer / FocusStack** — Muir & Kampa 2015, *Front Neuroinform* 8:85. Open-source
  MATLAB visual stimulation tied to two-photon acquisition — the closest match to this exact
  use case.

**Also acknowledged:** the drifting-grating parameters (0.02 cyc/px spatial, ~1 Hz temporal,
full contrast) follow the in-house generator, whose physiological range matches canonical
mouse-V1 tuning (Niell & Stryker 2008, *J Neurosci* 28:7520–7536). The oblique-orientation
convention is verified frame-for-frame against **pulse2percept** (Beyeler et al. 2017,
*Proc. 16th SciPy Conf.*). The colored-corner-square + photodiode timing marker is a standard
community method, not original to this tool.

## License

MIT — see [LICENSE](LICENSE).
