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
    TYPE_PULSES: { grey: 1, still: 2, moving: 3 },  // the decoder map (pulse count -> type)
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
    const n = MARKER.TYPE_PULSES[type];
    if (n == null) throw new Error("unknown stimulus type: " + type);
    return n;
  }

  /** Total on-screen duration of a marker train, seconds (last pulse has no trailing gap). */
  function markerTrainDuration(type) {
    const n = pulsesFor(type);
    return n <= 0 ? 0 : (n - 1) * MARKER.PULSE_PERIOD_S + MARKER.PULSE_WIDTH_S;
  }

  /** events_labeled-style label for a block. */
  function blockLabel(type, orientationDeg) {
    if (type === "grey") return "Grey";
    if (type === "black") return "Black";
    const kind = type === "moving" ? "Moving" : "Static";
    return `${kind} ${Number(orientationDeg)}°`;
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
        label: blockLabel(b.type, b.orientation),
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

  const API = {
    MARKER, STIM, pulsesFor, markerSidePx, markerTrainDuration, blockLabel,
    queueTimeline, buildProtocol, cyclesPerPixel,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.STIMPROTOCOL = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
