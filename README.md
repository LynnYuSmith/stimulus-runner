# stimulus-runner

[![tests](https://github.com/LynnYuSmith/stimulus-runner/actions/workflows/tests.yml/badge.svg)](https://github.com/LynnYuSmith/stimulus-runner/actions/workflows/tests.yml)

A grating presenter for a two-photon rig, in a browser. Grey screen, switch to a grating of
the orientation, frequency, contrast and duration you want, switch back. Queue a sequence and
run it. Every block is marked into the recording, so the played protocol lands on the data
without new alignment code.

Built to replace an aging MATLAB rig. No install: one HTML page and a 100-line Python server.

![the cockpit: quick gratings, the grating form, and a live mirror of what the mouse sees](https://raw.githubusercontent.com/LynnYuSmith/stimulus-runner/main/docs/cockpit.png)

## Run it

```bash
python serve.py               # opens http://127.0.0.1:8000 in Chrome / Edge
python serve.py 8080          # another port
python serve.py --no-browser  # a tab is already open
```

Standard library only, Python 3.8+, bound to `127.0.0.1`. It serves the page and owns the
`protocols/` folder. Idle: ~0 % CPU, ~20 MB. Windows: `python serve.py` or `py serve.py`.
Needs Chrome or Edge (WebGL1 + ES6). Integrated graphics are fine; a dedicated GPU is not
needed.

Without the server the page still works from `python -m http.server` or straight off disk —
everything except the saved-protocol list.

## Two screens

**Stimulus screen** — full-screen WebGL, the grating and the corner marker, nothing else.
"Open stimulus window", drag it to the mouse's monitor. One monitor? "Fullscreen here".

**Cockpit** — quick gratings, the grating form, the queue, the trial log, and a live mirror of
what the mouse sees.

One page in two roles (`#stim` vs control), talking over `postMessage`.

| the queue and the trial log | what the mouse sees |
|---|---|
| ![a queued sweep and the log writing to disk](https://raw.githubusercontent.com/LynnYuSmith/stimulus-runner/main/docs/queue_and_log.png) | ![a 45° binary grating with the corner marker](https://raw.githubusercontent.com/LynnYuSmith/stimulus-runner/main/docs/stimulus_screen.png) |

Keys: **Space** present (pause / resume during a sequence) · **G / Esc** grey · **B** black ·
**1–8** presets. Click any value beside a slider to type an exact number. The **manual** link
in the header is the in-app guide.

## The grating

```
L(x,y,t) = L_mean · (1 + C · wave(2π·f·(x·cosθ + y·sinθ) + φ(t)))
```

Square wave by default (what the reference videos use), sinusoid on a switch. Spatial
frequency in **cycles per pixel** on a virtual frame — default 104 × 150 px, so 0.02 cyc/px is
3 cycles across the width — then scaled to the output size.

Grey, black and grating are the **same** WebGL surface, never rebuilt: grey is contrast 0 at
the grey mean, black is contrast 0 at mean 0. A switch changes shader uniforms between frames.
No black frame, no flash.

The orientation convention is matched frame-for-frame to the reference generator (the vertical
term is `− fy·sin θ`, and the drift phase decreases). Without that, 45° and 135° come out
mirrored and every oblique tuning label is wrong. Gamma LUT is not applied yet.

### Plaids

Set a **plaid angle** and a second grating that many degrees away is **added** to the first,
and their sum is shown:

```
L(x,y,t) = L_mean · (1 + C · k · Σ_θ wave(2π·f·(x·cosθ + y·sinθ) + φ(t)))
```

Both components share the spatial frequency, the temporal frequency and the phase, so a moving
plaid drifts coherently. `k` is what the contrast slider is taken to mean: `1` gives each
component the set contrast, so the sum spans twice it and anything above 0.5 flattens against
the screen's range; `0.5` keeps the pair inside the set contrast and gives each component half.
The clamp is the display running out of range, and it is not hidden — 50 % per component is the
highest a plaid carries with its peaks intact.

A plaid angle of 0 is *not* a plaid, it is a single grating, and nothing downstream treats it
as one. **+ plaid trio** queues three plaids of one angle with their component pairs 30° apart
(0/90, 30/120, 60/150 at 90°), which rotates the pair without changing the angle under test, so
repetition does not adapt the answer.

Use the **sinusoid** waveform for plaids. The binary default exists to match the baked stimulus
videos, and two summed binary waves give a three-level chequer rather than the smooth
interference pattern the word *plaid* normally means. Binary is still presented and recorded
faithfully — it is simply a different stimulus.

The marker is unchanged: a plaid counts as a moving or still grating to the photodiode. Which
blocks were plaids is in the log (`plaid_angle_deg`) and in the exported protocol
(`plaid_angle_deg`, `component_orientations_deg`, `plaid_contrast_per`), where the orientation
always lived.

## Corner markers

At every onset a **red** square flashes in a corner (top-right by default), coded by pulse
count. Mice are red-blind; the photodiode reads it.

| block | pulses |
|---|---|
| grey | 1 |
| static grating | 2 |
| moving grating | 3 |
| the contrast half of a back-to-back pair | 4 |
| black | none |

A pulse is 3 frames on, 3 off, at 51 fps. The constants live in `protocol.js` and are tested
against the pipeline's.

## The sequence

A literal list of blocks, each run for its own duration, in order: a grating, a grey rest, a
black rest, or a whole 0–315° sweep with grey gaps. The header shows the block count and the
total length.

* **Drag to reorder** by the ⠿ handle (or the row); an insert line shows where it lands.
  Locked while a queue runs.
* **Pause / resume** with Space: the drift freezes on both screens and the sequence holds.
  Both go into the log.
* **Saved protocols are files**, not browser storage. Name a queue, **★ Save** → `serve.py`
  writes `protocols/<name>.json`. Copy the folder to another rig, or commit it, and the
  protocols come along. `protocols/8-ori sweep.json` ships as an example.

## What reaches the recording

**Export protocol (MAT)** writes `protocol_played.json`: the blocks actually shown, in order,
with cumulative times, labels, orientations and marker counts, in the pipeline's schema. Those
are the intended onsets — the photodiode gives the frame-exact ones, and the two align
post-hoc.

The **trial log** records every block, gratings and rests alike, with a wall-clock timestamp,
and is written to disk as it goes (`logs/`), not held in the page. A session that dies mid-run
is offered back on the next load: continue it, and the log keeps going into the same file.
Exports as CSV or JSON.

## What's here

| | |
|---|---|
| `index.html` | the app — UI, WebGL, dual-screen wiring, queue, logging |
| `protocol.js` | the pure logic: marker encoding, stimulus defaults, the played-protocol builder, the timeline. No DOM, so it is tested headless |
| `serve.py` | the server: the page, the `protocols/` folder, the trial log, the session file |
| `protocols/` | saved protocols, one JSON each |
| `test/` | `npm test` — protocol, queue, log and session checks, plus real-Chrome scripts that are not part of it |

`test/shots_real_chrome.js` takes the screenshots above in a real Chrome and exits 1 on any
console error. A picture of a broken page is worse than no picture.

## Limits

* **A dropped frame can change a marker.** The code is the pulse *count*, each pulse ~3 frames
  wide. On a loaded rig PC a dropped frame inside a pulse changes the decoded type of that
  trial, and the photodiode records the loss faithfully — it cannot recover the count. It has
  happened. Fix planned: a wider pulse or a parity pulse. Until then use a machine that holds
  60 Hz and check the decoded train against the played protocol.
* Presentation timing is the browser's, so it is *measured* against the photodiode, not
  trusted. The photodiode stays the ground truth by design.
* The visual output and the drag-reorder have to be checked on the rig. Headless tests do not
  see them.

## Where this sits

Not a general stimulus platform, and not trying to be. It is a narrow drop-in whose corner
marker and pixel geometry match one existing pipeline's decoder. For anything general, use
these instead:

* **PsychoPy / PsychoJS** — Peirce et al. 2019, *Behav Res Methods* 51:195–203. The standard;
  PsychoJS already does browser gratings on WebGL.
* **Psychtoolbox-3** — Brainard 1997; Pelli 1997; Kleiner et al. 2007. The MATLAB standard.
* **QDSpy** — Euler lab, Tübingen. The direct inspiration: per-frame uniform swaps for seamless
  transitions, corner marker + TTL, an await-trigger state, dual-screen preview, gamma LUT.
* **BonVision** — Lopes et al. 2021, *eLife* 10:e65541, on Bonsai. Already has the closed-loop
  and trigger-out this would need next; look there before building it here.
* **StimServer / FocusStack** — Muir & Kampa 2015, *Front Neuroinform* 8:85. The closest match
  to this exact use case.

Summed gratings are taken from **Lin, Okun, Carandini & Harris 2015**, *The Nature of Shared
Cortical Variability*, *Neuron* 87:644–656 — gratings and plaids over a multi-site array, the
plaid angle fixed within a session and the component pair rotated in 30° steps across three
pairs to keep adaptation out of the measurement. The trio button and the per-component contrast
convention here follow that protocol.

The grating parameters (0.02 cyc/px, ~1 Hz, full contrast) follow the in-house generator and
sit in the canonical mouse-V1 range (Niell & Stryker 2008, *J Neurosci* 28:7520–7536). The
oblique convention is verified against **pulse2percept** (Beyeler et al. 2017). A coloured
corner square read by a photodiode is a community method, not ours.

## License

MIT — see [LICENSE](LICENSE).
