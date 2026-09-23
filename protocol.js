/* protocol.js — pure stimulus-protocol logic, shared by the browser app and the node tests.
 *
 * NO DOM / WebGL here: this is the part that must be provably correct (the marker encoding
 * and the played-protocol export that overlays on the recording MAT), so it lives apart and
 * is unit-tested headless (test/protocol.test.js).
 *
 * Marker encoding is reproduced one-to-one from the recording pipeline's stimulus
 * generator, and read back unchanged by its decoder (pulse count -> type,
 * {1: grey, 2: still, 3: moving}):
 *   grey = 1 pulse, still = 2 pulses, moving = 3 pulses,
 *   pulse ON = 3 frames, gap = 3 frames, at MARKER_FPS (legacy stimulus-video fps),
 *   RED square in the bottom-right corner (mice are red-blind; the photodiode sees it).
 */
(function (root) {
  "use strict";

  const MARKER = {
    FPS: 51,               // legacy stimulus-video fps — the pulse-geometry reference
    PULSE_W_FRAMES: 3,     // pulse ON width, frames
    PULSE_GAP_FRAMES: 3,   // gap between pulses, frames
    RGB: [1.0, 0.0, 0.0],  // RED
    CORNER: "tr",          // top-right — the stimulus generator's default
    RESERVE_RATIO: 0.0185, // marker square: side = sqrt(ratio·H·W) px, exactly the generator's
    TYPE_PULSES: { grey: 1, still: 2, moving: 3, contrast: 4 },  // the decoder map (pulse count -> type)
    // `contrast` = the SECOND grating of a back-to-back pair (4c4s: base, then its contrast
    // at once, no grey between). Four pulses so the recording itself says which half is
    // which, instead of only their order (task #40, 2026-09-19). The pipeline's decoder reads
    // 4 as a moving grating with role=contrast; older recordings (3+3) are still paired by
    // adjacency there, so nothing already recorded changes meaning.
  };
  MARKER.PULSE_WIDTH_S = MARKER.PULSE_W_FRAMES / MARKER.FPS;                       // ~0.059 s
  MARKER.PULSE_PERIOD_S = (MARKER.PULSE_W_FRAMES + MARKER.PULSE_GAP_FRAMES) / MARKER.FPS; // ~0.118 s

  /* Canonical stimulus parameters — MUST match the recording pipeline's stimulus
     generator. The runner's defaults come from here so a preset grating is physically
     identical to the baked stimulus videos. */
  const STIM = {
    FRAME_H: 104,          // stimulus-frame height, px
    FRAME_W: 150,          // stimulus-frame width, px  (0.02 cyc/px -> 3 cycles across)
    SPATIAL_FREQ_CPP: 0.02, // cycles per (frame) pixel
    TEMPORAL_FREQ: 0.04,   // generator drift value (moving); 0 = static
    GREY_LEVEL: 128 / 255, // mid-grey (0..1)
    BLACK_LEVEL: 0.0,
  };

  /** Marker square side in FRAME pixels: side = sqrt(ratio · H · W) (the generator's rule). */
  function markerSidePx(frameH, frameW, ratio) {
    return Math.sqrt(Number(ratio) * Number(frameH) * Number(frameW));
  }

  /** Pulse count for a block type. grey=1, still=2, moving=3; black=0 (a rest screen, no
   *  marker — like the generator's pre/post black padding). Throws on anything else. */
  function pulsesFor(type) {
    if (type === "black") return 0;
    if (type === "blitz" || type === "bar") return 1;  // single onset blip (placeholder, not a decoder contract)
    const n = MARKER.TYPE_PULSES[type];
    if (n == null) throw new Error("unknown stimulus type: " + type);
    return n;
  }

  /** Total on-screen duration of a marker train, seconds (last pulse has no trailing gap). */
  function markerTrainDuration(type) {
    const n = pulsesFor(type);
    return n <= 0 ? 0 : (n - 1) * MARKER.PULSE_PERIOD_S + MARKER.PULSE_WIDTH_S;
  }

  /** events_labeled-style label for a block. A plaid names BOTH its components, because the
   *  pair is the stimulus — "Moving plaid 0/90°" is not a 0° grating and must never read as one. */
  function blockLabel(type, orientationDeg, plaidAngleDeg) {
    if (type === "grey") return "Grey";
    if (type === "black") return "Black";
    if (type === "blitz") return "Blitz";
    if (type === "bar") return orientationDeg == null ? "Bar sweep" : `Bar ${Number(orientationDeg)}°`;
    const kind = type === "moving" ? "Moving" : "Static";
    const a = Number(orientationDeg), pa = Number(plaidAngleDeg) || 0;
    if (pa > 0) return `${kind} plaid ${a}/${(a + pa) % 360}°`;
    return `${kind} ${a}°`;
  }

  /**
   * Component orientations of a plaid, in degrees: the set one is given plus the plaid angle.
   * Returns a single orientation when the angle is 0 — that is not a plaid, it is a grating,
   * and the two must not be conflated anywhere downstream.
   */
  function plaidComponents(orientationDeg, plaidAngleDeg) {
    const a = Number(orientationDeg), pa = Number(plaidAngleDeg) || 0;
    return pa > 0 ? [a, (a + pa) % 360] : [a];
  }

  /**
   * Luminance at frame pixel (fx, fy) — MIRRORS the WebGL shader, so what the screen shows is
   * node-testable. A plaid is the SUM of its components, each a grating of the same spatial and
   * temporal frequency: `L = mean · (1 + contrast · norm · Σ component)`, clamped to the
   * displayable range. `norm` is 1 when the contrast is per component and 0.5 when it is per
   * plaid. The clamp is the honest part: two components at contrast 0.5 already reach the ends
   * of the range, and anything above that is flattened by the screen, not by us.
   * Keep this in sync with the shader in index.html.
   */
  function plaidLuminance(fx, fy, o) {
    o = o || {};
    const comps = plaidComponents(o.orientationDeg, o.plaidAngleDeg);
    const square = o.waveform === "square";
    let g = 0;
    for (const th of comps) {
      const v = Math.sin(gratingPhaseArg(fx, fy, th, o.sf, o.phase));
      g += square ? (v > 0 ? 1 : -1) : v;
    }
    const norm = (comps.length > 1 && o.plaidNorm) ? 0.5 : 1;
    const mean = o.meanLum == null ? STIM.GREY_LEVEL : Number(o.meanLum);
    return Math.min(1, Math.max(0, mean * (1 + Number(o.contrast) * norm * g)));
  }

  const isGrating = (type) => type === "moving" || type === "still";

  /**
   * Plan the timeline of a QUEUE run: each item is preceded by a grey block of
   * `greyBetweenS` seconds, then the grating for its own duration. Returns an ordered
   * list of blocks with cumulative start/end times (seconds from run start).
   *
   * queue item: {type:'moving'|'still', orientation, sf, tf, contrast, duration}
   */
  function queueTimeline(queue, greyBetweenS) {
    const g = Math.max(0, Number(greyBetweenS) || 0);
    const blocks = [];
    let t = 0;
    for (const it of queue) {
      if (g > 0) {
        blocks.push({ type: "grey", orientation_deg: null, duration_s: g,
                      start_time_s: t, end_time_s: t + g });
        t += g;
      }
      const d = Number(it.duration);
      blocks.push({
        type: it.type, orientation_deg: Number(it.orientation), duration_s: d,
        start_time_s: t, end_time_s: t + d,
        spatial_freq_cpd: Number(it.sf), temporal_freq_hz: Number(it.tf),
        contrast: Number(it.contrast),
      });
      t += d;
    }
    return blocks;
  }

  /**
   * Build a protocol JSON (pipeline schema) from a list of PLAYED blocks, in order.
   * Each played block: {type, orientation, sf, tf, contrast, duration_s}. Times are made
   * cumulative from 0 (the first block's onset = time origin, as the pipeline's
   * start-marker onset defines t=0). The result carries `orientations_deg`, a `sequence`
   * with per-block start/end/label/marker_pulses, and the marker encoding — everything the
   * pipeline needs to overlay the played stimulus onto the recording MAT.
   */
  function buildProtocol(played, opts) {
    opts = opts || {};
    const seq = [];
    let t = 0;
    const oris = new Set();
    let stimDur = null, greyDur = null;
    for (let i = 0; i < played.length; i++) {
      const b = played[i];
      const dur = Number(b.duration_s);
      const grating = isGrating(b.type);
      const item = {
        index: i,
        type: b.type,
        label: blockLabel(b.type, b.orientation, b.plaidAngle),
        orientation_deg: grating ? Number(b.orientation) : null,
        start_time_s: round3(t),
        end_time_s: round3(t + dur),
        duration_s: round3(dur),
        marker_pulses: pulsesFor(b.type),
      };
      if (grating) {
        item.spatial_freq_cpp = numOrNull(b.sf);
        item.temporal_freq = numOrNull(b.tf);
        item.contrast = numOrNull(b.contrast);
        /* A plaid carries its second component explicitly. `orientation_deg` stays the FIRST
           component so a consumer that knows nothing of plaids still reads a real orientation
           rather than a meaningless average — but `plaid_angle_deg` being non-null is the
           statement that this block was not a single grating. */
        item.plaid_angle_deg = (Number(b.plaidAngle) || 0) || null;
        item.component_orientations_deg = plaidComponents(b.orientation, b.plaidAngle);
        item.plaid_contrast_per = item.plaid_angle_deg
          ? (b.plaidNorm ? "plaid" : "component") : null;
        oris.add(Number(b.orientation));
        if (stimDur == null) stimDur = dur;
      } else if (b.type === "grey" && greyDur == null) {
        greyDur = dur;
      }
      seq.push(item);
      t += dur;
    }
    return {
      protocol_name: opts.name || "played_protocol",
      generated: opts.generated || null,
      note: "Played-stimulus protocol from the interactive runner. Times are intended " +
            "(wall-clock) onsets; the recording photodiode gives the true frame-exact onset.",
      stim_duration_sec: stimDur,
      gray_duration_sec: greyDur,
      orientations_deg: Array.from(oris).sort((a, b) => a - b),
      total_duration_s: round3(t),
      marker: {
        fps: MARKER.FPS,
        pulse_w_frames: MARKER.PULSE_W_FRAMES,
        pulse_gap_frames: MARKER.PULSE_GAP_FRAMES,
        corner: MARKER.CORNER,
        color: "red",
        type_pulses: Object.assign({}, MARKER.TYPE_PULSES),
      },
      sequence: seq,
    };
  }

  function round3(x) { return Math.round(Number(x) * 1000) / 1000; }
  function numOrNull(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

  /** cyc/deg -> cyc/px given pixels-per-degree (the viewing-geometry conversion). */
  function cyclesPerPixel(sfCpd, pxPerDeg) {
    return Number(sfCpd) / Math.max(Number(pxPerDeg), 1e-6);
  }

  /**
   * Phase argument of the grating at frame pixel (fx, fy) — MIRRORS the WebGL shader
   * (`d = fx*cos(theta) - fy*sin(theta); arg = 2*pi*sf*d + phase`) so the orientation
   * convention is node-testable. The ``-fy`` is load-bearing: fy runs top→bottom on screen
   * but the reference generator's y runs bottom→top, so without the minus sign the oblique
   * orientations (45°/135°) come out MIRRORED. Verified frame-for-frame against the
   * pulse2percept generator. Keep this in sync with the shader in index.html.
   */
  function gratingPhaseArg(fx, fy, thetaDeg, sf, phase) {
    const th = Number(thetaDeg) * Math.PI / 180;
    const d = Number(fx) * Math.cos(th) - Number(fy) * Math.sin(th);
    return 2 * Math.PI * Number(sf) * d + (Number(phase) || 0);
  }

  const API = {
    MARKER, STIM, pulsesFor, markerSidePx, markerTrainDuration, blockLabel,
    queueTimeline, buildProtocol, cyclesPerPixel, gratingPhaseArg,
    plaidComponents, plaidLuminance,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.STIMPROTOCOL = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
