# stimulus-runner

An interactive, browser-based **drifting/static grating presenter** for two-photon rig
experiments. A grey screen you switch — seamlessly — to a grating of a chosen orientation,
spatial/temporal frequency, contrast, and duration, then back to grey. Queue gratings to
run in sequence, and it writes the played protocol so it overlays onto the recording.

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

Keyboard: **Space** present · **G/Esc** grey · **1–8** presets.

## Seamless grey ↔ grating

Grey and grating are the **same** WebGL surface, never torn down: grey is just a grating
with **contrast = 0**. Switching changes shader uniforms between frames (contrast up, phase
drifting) — no scene rebuild, no black frame, no flash.

```
L(x,y,t) = L_mean · (1 + C · sin(2π·f·(x·cosθ + y·sinθ) + φ(t)))
```

Spatial frequency is entered in **cycles/degree** and converted to cycles/pixel with the
rig's pixels-per-degree (set once in *Geometry*). Gamma linearization (LUT) is a v0.5
calibration step, not yet applied.

## Corner pulse markers (matches the pipeline)

At each onset a **RED** square flashes in the **bottom-right** corner, pulse-coded by
**count** (mice are red-blind; a photodiode reads it). This reproduces the pipeline's
generator one-to-one, so the recording's photodiode and the existing decoder read it
unchanged:

| block | marker pulses |
|-------|---------------|
| grey  | **1** |
| static grating | **2** |
| moving grating | **3** |

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
- `protocol.js` — the **pure** logic (marker encoding, the played-protocol builder, the
  queue timeline, the cyc/deg→cyc/px conversion). No DOM/WebGL, so it is unit-tested
  headless.
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
