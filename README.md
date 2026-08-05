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
A closed-loop camera trigger ("fire when the mouse has been calm ≥ 2 s") is a planned later
phase and adds a small Python backend; it is not part of v1.

## Two screens

- **Stimulus screen** — a full-screen WebGL canvas showing only the grating (and the corner
  marker). Open it with **“Open stimulus window”**, drag it to the mouse's monitor, and it
  goes full-screen. No second monitor? Use **“Fullscreen here”**.
- **Operator control screen** — the cockpit: quick-grating buttons, a custom-grating form,
  the queue, the trial log, and a live mirror of what the mouse sees.

The two are one page in two roles (`#stim` vs control), talking over `postMessage` — no
install, no backend.

## Run it

Serve the folder and open `index.html` in a browser (Chrome/Edge/Firefox):

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

(Opening the file directly also works, but a local server keeps `postMessage` and
full-screen well-behaved.)

Keyboard: **Space** present · **G/Esc** grey · **B** black · **1–8** presets.

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
gratings — so a played sequence maps straight onto the recording.

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
photodiode gives the true, frame-exact onset, and the two align post-hoc. (The trial log
also exports as CSV/JSON.)

## What's here

- `index.html` — the app (UI, WebGL renderer, dual-screen wiring, queue, logging).
- `protocol.js` — the **pure** logic (marker encoding, stimulus defaults matched to the
  generator, the played-protocol builder, the sequence timeline). No DOM/WebGL, so it is
  unit-tested headless.
- `test/protocol.test.js` — `node test/protocol.test.js` (or `npm test`).

## Verification

The **protocol/marker logic is node-tested** (`npm test`, 8 checks) and the page's inline
script is syntax-checked. The **visual output and on-screen timing must be verified in a
browser on the rig** — that can't be tested headless. The photodiode remains the timing
ground truth by design, so browser presentation jitter is *measured*, not feared.

## Citing QDSpy

The design borrows proven patterns from **QDSpy** (Euler lab, University of Tübingen —
`eulerlab/QDSpy`): per-frame shader-uniform updates for seamless transitions, a
corner-marker + TTL scheme, an await-trigger presenter state (the closed-loop hook for
v2/v3), dual-screen with an operator preview, and gamma-LUT calibration. QDSpy is the
reference, not a dependency (it is GPU-heavy and Windows-first; this runner is deliberately
light and browser-based). If you publish work using this runner, please cite QDSpy per its
repository's citation guidance.

## License

MIT — see [LICENSE](LICENSE).
