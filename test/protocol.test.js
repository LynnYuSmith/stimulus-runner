"use strict";
/* Headless tests for the pure protocol logic. Run: node test/protocol.test.js */
const assert = require("node:assert");
const P = require("../protocol.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

test("marker pulse counts match the pipeline (grey=1, still=2, moving=3, black=0)", () => {
  assert.strictEqual(P.pulsesFor("grey"), 1);
  assert.strictEqual(P.pulsesFor("still"), 2);
  assert.strictEqual(P.pulsesFor("moving"), 3);
  assert.strictEqual(P.pulsesFor("black"), 0);   // black is a rest screen, no marker
  assert.throws(() => P.pulsesFor("bogus"), /unknown stimulus type/);
});

test("stimulus defaults match the pipeline generator (104x150, 0.02 cyc/px, grey 128)", () => {
  assert.strictEqual(P.STIM.FRAME_H, 104);
  assert.strictEqual(P.STIM.FRAME_W, 150);
  assert.strictEqual(P.STIM.SPATIAL_FREQ_CPP, 0.02);
  assert.ok(Math.abs(P.STIM.SPATIAL_FREQ_CPP * P.STIM.FRAME_W - 3) < 1e-9); // 3 cycles across width
  assert.ok(Math.abs(P.STIM.GREY_LEVEL - 128 / 255) < 1e-9);
});

test("marker square side = sqrt(ratio*H*W), corner top-right", () => {
  assert.strictEqual(P.MARKER.CORNER, "tr");
  assert.strictEqual(P.MARKER.RESERVE_RATIO, 0.0185);
  const side = P.markerSidePx(104, 150, 0.0185);
  assert.ok(Math.abs(side - Math.sqrt(0.0185 * 104 * 150)) < 1e-9);
  assert.ok(side > 16 && side < 18);   // ~17 px on the 104x150 frame
});

test("blackLabel + black block in buildProtocol carries no marker", () => {
  assert.strictEqual(P.blockLabel("black"), "Black");
  const proto = P.buildProtocol([{ type: "black", duration_s: 20 }], {});
  assert.strictEqual(proto.sequence[0].label, "Black");
  assert.strictEqual(proto.sequence[0].marker_pulses, 0);
  assert.strictEqual(proto.sequence[0].orientation_deg, null);
});

test("marker geometry matches the generator (3-frame pulse, 6-frame period @51fps)", () => {
  assert.ok(Math.abs(P.MARKER.PULSE_WIDTH_S - 3 / 51) < 1e-9);
  assert.ok(Math.abs(P.MARKER.PULSE_PERIOD_S - 6 / 51) < 1e-9);
  // a moving train (3 pulses) spans 2 periods + 1 width
  assert.ok(Math.abs(P.markerTrainDuration("moving") - (2 * 6 / 51 + 3 / 51)) < 1e-9);
});

test("cyc/deg -> cyc/px uses pixels-per-degree", () => {
  assert.ok(Math.abs(P.cyclesPerPixel(0.04, 20) - 0.002) < 1e-9);
});

test("grating orientation convention matches the generator (fy is negated, not mirrored)", () => {
  const sf = 0.02;
  // horizontal step (+x) raises the phase for a 0deg grating (vertical bars drift in x)
  assert.ok(P.gratingPhaseArg(1, 0, 0, sf, 0) - P.gratingPhaseArg(0, 0, 0, sf, 0) > 0);
  // the load-bearing sign: a downward step (+y) must LOWER the phase for a 45deg grating.
  // With a "+fy" regression this would be positive, mirroring 45deg into 135deg.
  const dPhi_dy_45 = P.gratingPhaseArg(0, 1, 45, sf, 0) - P.gratingPhaseArg(0, 0, 45, sf, 0);
  assert.ok(dPhi_dy_45 < 0, "45deg grating must have -fy convention (else obliques mirror)");
  // 45 and 135 must be genuinely different orientations (not accidentally equal)
  const g45 = P.gratingPhaseArg(1, 1, 45, sf, 0) - P.gratingPhaseArg(0, 0, 45, sf, 0);
  const g135 = P.gratingPhaseArg(1, 1, 135, sf, 0) - P.gratingPhaseArg(0, 0, 135, sf, 0);
  assert.ok(Math.abs(g45 - g135) > 1e-6);
});

test("blockLabel is events_labeled-style", () => {
  assert.strictEqual(P.blockLabel("grey"), "Grey");
  assert.strictEqual(P.blockLabel("moving", 45), "Moving 45°");
  assert.strictEqual(P.blockLabel("still", 90), "Static 90°");
});

test("queueTimeline inserts grey between items with cumulative times", () => {
  const q = [
    { type: "moving", orientation: 0, sf: 0.04, tf: 2, contrast: 1, duration: 4 },
    { type: "still", orientation: 90, sf: 0.04, tf: 0, contrast: 1, duration: 4 },
  ];
  const tl = P.queueTimeline(q, 4);
  // grey, moving(0), grey, still(90)
  assert.deepStrictEqual(tl.map((b) => b.type), ["grey", "moving", "grey", "still"]);
  assert.deepStrictEqual(tl.map((b) => b.start_time_s), [0, 4, 8, 12]);
  assert.deepStrictEqual(tl.map((b) => b.end_time_s), [4, 8, 12, 16]);
});

test("queueTimeline with no grey is back-to-back gratings", () => {
  const q = [{ type: "moving", orientation: 0, sf: 0.04, tf: 2, contrast: 1, duration: 4 }];
  const tl = P.queueTimeline(q, 0);
  assert.deepStrictEqual(tl.map((b) => b.type), ["moving"]);
  assert.strictEqual(tl[0].start_time_s, 0);
});

test("buildProtocol produces a pipeline-schema sequence with correct cumulative times", () => {
  const played = [
    { type: "grey", duration_s: 27 },
    { type: "moving", orientation: 0, sf: 0.04, tf: 2, contrast: 1, duration_s: 4 },
    { type: "grey", duration_s: 4 },
    { type: "moving", orientation: 45, sf: 0.04, tf: 2, contrast: 1, duration_s: 4 },
  ];
  const proto = P.buildProtocol(played, { name: "test_run" });
  assert.strictEqual(proto.protocol_name, "test_run");
  assert.deepStrictEqual(proto.orientations_deg, [0, 45]);
  assert.strictEqual(proto.stim_duration_sec, 4);
  assert.strictEqual(proto.gray_duration_sec, 27);
  assert.strictEqual(proto.total_duration_s, 39);
  const s = proto.sequence;
  assert.strictEqual(s.length, 4);
  // cumulative times
  assert.deepStrictEqual(s.map((b) => b.start_time_s), [0, 27, 31, 35]);
  assert.deepStrictEqual(s.map((b) => b.end_time_s), [27, 31, 35, 39]);
  // marker pulses per block
  assert.deepStrictEqual(s.map((b) => b.marker_pulses), [1, 3, 1, 3]);
  // labels + orientation carried (REQUIRED for events_labeled)
  assert.strictEqual(s[1].label, "Moving 0°");
  assert.strictEqual(s[3].orientation_deg, 45);
  assert.strictEqual(s[0].orientation_deg, null); // grey has no orientation
});

test("buildProtocol carries grating params and marker encoding", () => {
  const proto = P.buildProtocol(
    [{ type: "still", orientation: 135, sf: 0.05, tf: 0, contrast: 0.8, duration_s: 8 }], {});
  const b = proto.sequence[0];
  assert.strictEqual(b.spatial_freq_cpp, 0.05);
  assert.strictEqual(b.contrast, 0.8);
  assert.strictEqual(b.marker_pulses, 2);
  assert.strictEqual(proto.marker.type_pulses.moving, 3);
  assert.strictEqual(proto.marker.corner, "tr");
});

/* ---------------------------------------------------------------- plaids */

const BASE = { sf: 0.02, waveform: "sinusoid", contrast: 0.5, meanLum: 0.5 };

test("a plaid is the SUM of its two gratings, not a blend of them", () => {
  // At a pixel where both gratings peak the sum is 2, so a plaid at per-component contrast 0.5
  // reaches exactly the top of the range and one at 1.0 is clipped by the screen.
  const at = (o) => P.plaidLuminance(0, 0, Object.assign(
    { directionDeg: 0, phase: Math.PI / 2 }, BASE, o));
  assert.ok(Math.abs(at({}) - 0.75) < 1e-9);                          // one grating: 0.5·(1+0.5)
  assert.ok(Math.abs(at({ plaidDirDeg: 90 }) - 1.0) < 1e-9);          // two: 0.5·(1+0.5·2) = 1
  assert.strictEqual(at({ plaidDirDeg: 90, contrast: 1 }), 1);        // clipped, not wrapped
});

test("each grating drifts on its OWN phase — they are not locked together", () => {
  // Same two directions, same frame, but the second grating is a quarter cycle further on.
  // If the two shared a phase these would be equal, which is exactly the thing being ruled out.
  const o = { directionDeg: 0, plaidDirDeg: 90, phase: 0 };
  const locked = P.plaidLuminance(11, 7, Object.assign({}, BASE, o, { phase2: 0 }));
  const own = P.plaidLuminance(11, 7, Object.assign({}, BASE, o, { phase2: Math.PI / 2 }));
  assert.notStrictEqual(locked, own);
  // and an absent phase2 means "the same as the first", not "zero regardless"
  assert.strictEqual(P.plaidLuminance(11, 7, Object.assign({}, BASE, o, { phase: 0.9 })),
                     P.plaidLuminance(11, 7, Object.assign({}, BASE, o, { phase: 0.9, phase2: 0.9 })));
});

test("two gratings at different temporal frequencies are at different phases by the same frame", () => {
  assert.ok(Math.abs(P.driftPhase(1, 1) + 2 * Math.PI) < 1e-12);   // one cycle back per second
  assert.strictEqual(Math.abs(P.driftPhase(2.5, 0)), 0);           // a still grating stays put
  assert.notStrictEqual(P.driftPhase(0.7, 1), P.driftPhase(0.7, 3));
  // the direction of drift is the phase DECREASING, as the shader and the generator have it
  assert.ok(P.driftPhase(0.5, 2) < 0);
});

test("a grating's direction is its own, and 0° and 180° are opposite drifts of one pattern", () => {
  assert.deepStrictEqual(P.plaidComponents(30, null), [30]);
  assert.deepStrictEqual(P.plaidComponents(30, 120), [30, 120]);
  assert.deepStrictEqual(P.plaidComponents(300, 30), [300, 30]);    // no wrapping arithmetic
  assert.strictEqual(P.plaidAngle(0, 90), 90);
  assert.strictEqual(P.plaidAngle(300, 30), 90);                    // shortest way round
  assert.strictEqual(P.plaidAngle(0, 270), 90);
  assert.strictEqual(P.plaidAngle(0, null), null);
});

test("no second grating means no second grating — the single case is untouched", () => {
  const o = { directionDeg: 30, phase: 0.3, waveform: "square", sf: 0.02,
              contrast: 0.4, meanLum: 0.5 };
  assert.strictEqual(P.plaidLuminance(7, 11, o),
                     P.plaidLuminance(7, 11, Object.assign({ plaidDirDeg: null }, o)));
});

test("a plaid never reads as a single grating: the label names both gratings", () => {
  assert.strictEqual(P.blockLabel("moving", 0, 90), "Moving plaid 0p90°");
  assert.strictEqual(P.blockLabel("still", 45, 135), "Static plaid 45p135°");
  assert.strictEqual(P.blockLabel("moving", 0, null), "Moving 0°");   // unchanged without one
  assert.strictEqual(P.blockLabel("moving", 0), "Moving 0°");
});

test("the exported protocol states the second grating, and states there was none when there was none", () => {
  const proto = P.buildProtocol([
    { type: "moving", orientation: 0, sf: 0.02, tf: 1, contrast: 0.5, duration_s: 4,
      plaid: true, dir2: 90, tf2: 3, plaidNorm: true },
    { type: "moving", orientation: 45, sf: 0.02, tf: 1, contrast: 0.5, duration_s: 4 },
  ]);
  const [plaid, grating] = proto.sequence;
  assert.strictEqual(plaid.plaid_direction_deg, 90);
  assert.strictEqual(plaid.plaid_temporal_freq_hz, 3);
  assert.strictEqual(plaid.plaid_angle_deg, 90);
  assert.deepStrictEqual(plaid.component_directions_deg, [0, 90]);
  assert.deepStrictEqual(plaid.component_temporal_freqs_hz, [1, 3]);
  assert.strictEqual(plaid.plaid_contrast_per, "plaid");
  assert.strictEqual(plaid.orientation_deg, 0);        // still a real direction, not an average
  assert.strictEqual(plaid.marker_pulses, 3);          // the photodiode sees a moving grating
  assert.strictEqual(plaid.label, "Moving plaid 0p90°");
  assert.strictEqual(grating.plaid_direction_deg, null);
  assert.strictEqual(grating.plaid_angle_deg, null);
  assert.deepStrictEqual(grating.component_directions_deg, [45]);
  assert.deepStrictEqual(grating.component_temporal_freqs_hz, [1]);
  assert.strictEqual(grating.plaid_contrast_per, null);
});

test("summing is commutative: the pair does not depend on which grating is named first", () => {
  for (const [fx, fy] of [[0, 0], [13, 5], [61, 97], [149, 103]]) {
    const ab = P.plaidLuminance(fx, fy, Object.assign({}, BASE,
      { directionDeg: 30, plaidDirDeg: 120, phase: 0.7, phase2: -1.1 }));
    const ba = P.plaidLuminance(fx, fy, Object.assign({}, BASE,
      { directionDeg: 120, plaidDirDeg: 30, phase: -1.1, phase2: 0.7 }));
    assert.ok(Math.abs(ab - ba) < 1e-9, `${fx},${fy}: ${ab} vs ${ba}`);
  }
});

/* ------------------------------------------------- standing, contrast-reversing gratings */

test("a standing grating swings its contrast instead of moving, and 0 Hz stands plainly", () => {
  assert.strictEqual(P.reversalAmplitude(0, 4), 1);
  assert.strictEqual(P.reversalAmplitude(3.7, 0), 1);            // no rate = nothing modulating
  assert.ok(Math.abs(P.reversalAmplitude(1 / 16, 4) - 0) < 1e-12); // quarter cycle: blank
  assert.ok(Math.abs(P.reversalAmplitude(1 / 8, 4) + 1) < 1e-12);  // half cycle: inverted
  assert.ok(Math.abs(P.reversalAmplitude(1 / 4, 4) - 1) < 1e-12);  // full cycle: back
});

test("at the reversal's zero crossing the screen is uniform grey, whatever the pattern", () => {
  const o = { directionDeg: 30, sf: 0.02, phase: 0, waveform: "sinusoid",
              contrast: 0.5, meanLum: 0.5, amp: P.reversalAmplitude(1 / 16, 4) };
  for (const [fx, fy] of [[0, 0], [17, 3], [88, 51], [149, 103]]) {
    assert.ok(Math.abs(P.plaidLuminance(fx, fy, o) - 0.5) < 1e-9, `${fx},${fy}`);
  }
});

test("inverting the amplitude inverts the pattern about the mean — that is what reversing is", () => {
  const base = { directionDeg: 30, sf: 0.02, phase: 0, waveform: "sinusoid",
                 contrast: 0.5, meanLum: 0.5 };
  for (const [fx, fy] of [[17, 3], [88, 51], [149, 103]]) {
    const up = P.plaidLuminance(fx, fy, Object.assign({}, base, { amp: 1 }));
    const down = P.plaidLuminance(fx, fy, Object.assign({}, base, { amp: -1 }));
    assert.ok(Math.abs((up + down) / 2 - 0.5) < 1e-9, `${fx},${fy}: ${up} ${down}`);
  }
});

test("each grating of a standing plaid reverses at its own rate", () => {
  const o = { directionDeg: 0, plaidDirDeg: 90, sf: 0.02, phase: 0, waveform: "sinusoid",
              contrast: 0.4, meanLum: 0.5 };
  const t = 1 / 8;
  const a = P.plaidLuminance(31, 17, Object.assign({}, o,
    { amp: P.reversalAmplitude(t, 4), amp2: P.reversalAmplitude(t, 4) }));
  const b = P.plaidLuminance(31, 17, Object.assign({}, o,
    { amp: P.reversalAmplitude(t, 4), amp2: P.reversalAmplitude(t, 2) }));
  assert.notStrictEqual(a, b);
});

test("the protocol says whether a rate is a drift or a reversal", () => {
  const proto = P.buildProtocol([
    { type: "moving", orientation: 0, sf: 0.02, tf: 1, contrast: 0.5, duration_s: 4 },
    { type: "still", orientation: 0, sf: 0.02, tf: 4, contrast: 0.5, duration_s: 4 },
  ]);
  assert.strictEqual(proto.sequence[0].temporal_freq_role, "drift_hz");
  assert.strictEqual(proto.sequence[1].temporal_freq_role, "reversal_hz");
  assert.strictEqual(proto.sequence[1].temporal_freq, 4);
  assert.strictEqual(proto.sequence[1].marker_pulses, 2);   // still is still, to the photodiode
});

/* ------------------------------------------- the notation the MESc comments are written in */

test("a block is named the way the MESc comment names it", () => {
  assert.strictEqual(P.mescCode({ type: "moving", orientation: 135 }), "135");
  assert.strictEqual(P.mescCode({ type: "still", orientation: 0 }), "0");
  assert.strictEqual(P.mescCode({ type: "moving", orientation: 0, plaid: true, dir2: 90 }), "0p90");
  assert.strictEqual(P.mescCode({ type: "grey" }), null);      // rest blocks are not named
  assert.strictEqual(P.mescCode({ type: "bar", orientation: 0 }), null);
});

test("two gratings with nothing between them are joined by c, base first", () => {
  const q = [
    { type: "moving", orientation: 135 }, { type: "moving", orientation: 315 },
    { type: "grey" },
    { type: "moving", orientation: 180 }, { type: "moving", orientation: 0 },
  ];
  assert.strictEqual(P.mescComment(q), "135c315, 180c0deg");
});

test("a grey between two gratings breaks the pair, which is what the grey is for", () => {
  assert.strictEqual(P.mescComment([
    { type: "moving", orientation: 135 }, { type: "grey" }, { type: "moving", orientation: 315 },
  ]), "135, 315deg");
});

test("plaids are written with p, and a plaid pair carries both", () => {
  assert.strictEqual(P.mescComment([
    { type: "moving", orientation: 0, plaid: true, dir2: 90 },
    { type: "moving", orientation: 180, plaid: true, dir2: 270 },
  ]), "0p90c180p270deg");
  assert.strictEqual(P.mescComment([{ type: "moving", orientation: 0, plaid: true, dir2: 90 }]),
                     "0p90deg");
  assert.strictEqual(P.mescComment([{ type: "grey" }]), "");
  assert.strictEqual(P.mescComment([]), "");
});

test("the exported protocol carries each block's code", () => {
  const proto = P.buildProtocol([
    { type: "moving", orientation: 0, sf: 0.02, tf: 1, contrast: 1, duration_s: 4,
      plaid: true, dir2: 90 },
    { type: "moving", orientation: 135, sf: 0.02, tf: 1, contrast: 1, duration_s: 4 },
    { type: "grey", duration_s: 4 },
  ]);
  assert.strictEqual(proto.sequence[0].stim_code, "0p90");
  assert.strictEqual(proto.sequence[1].stim_code, "135");
  assert.strictEqual(proto.sequence[2].stim_code, undefined);   // a grey has no code
});

console.log(`\n${passed} passed`);
