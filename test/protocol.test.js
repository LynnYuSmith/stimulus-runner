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

test("a plaid is the SUM of its two components, not a blend of them", () => {
  // At a pixel where both components are at their peak the sum is 2, so a plaid at component
  // contrast 0.5 reaches exactly the top of the range and one at 1.0 is clipped by the screen.
  const at = (o) => P.plaidLuminance(0, 0, Object.assign(
    { orientationDeg: 0, sf: 0.02, phase: Math.PI / 2, waveform: "sinusoid",
      contrast: 0.5, meanLum: 0.5 }, o));
  assert.ok(Math.abs(at({}) - 0.75) < 1e-9);                       // one grating: 0.5·(1+0.5)
  assert.ok(Math.abs(at({ plaidAngleDeg: 90 }) - 1.0) < 1e-9);     // two: 0.5·(1+0.5·2) = 1
  assert.strictEqual(at({ plaidAngleDeg: 90, contrast: 1 }), 1);   // clipped, not wrapped
});

test("per-plaid contrast halves each component so the pair stays inside the set contrast", () => {
  const at = (o) => P.plaidLuminance(0, 0, Object.assign(
    { orientationDeg: 0, sf: 0.02, phase: Math.PI / 2, waveform: "sinusoid",
      contrast: 0.5, meanLum: 0.5, plaidAngleDeg: 90 }, o));
  assert.ok(Math.abs(at({ plaidNorm: true }) - 0.75) < 1e-9);      // same peak as one grating
  assert.ok(Math.abs(at({ plaidNorm: false }) - 1.0) < 1e-9);
});

test("a plaid angle of 0 is not a plaid — no second component is added", () => {
  assert.deepStrictEqual(P.plaidComponents(30, 0), [30]);
  assert.deepStrictEqual(P.plaidComponents(30, 90), [30, 120]);
  assert.deepStrictEqual(P.plaidComponents(300, 90), [300, 30]);   // wraps, stays a real angle
  const o = { orientationDeg: 30, sf: 0.02, phase: 0.3, waveform: "square",
              contrast: 0.4, meanLum: 0.5 };
  assert.strictEqual(P.plaidLuminance(7, 11, o),
                     P.plaidLuminance(7, 11, Object.assign({ plaidAngleDeg: 0 }, o)));
});

test("a plaid never reads as a single grating: the label names both components", () => {
  assert.strictEqual(P.blockLabel("moving", 0, 90), "Moving plaid 0/90°");
  assert.strictEqual(P.blockLabel("still", 30, 90), "Static plaid 30/120°");
  assert.strictEqual(P.blockLabel("moving", 0, 0), "Moving 0°");   // unchanged without an angle
  assert.strictEqual(P.blockLabel("moving", 0), "Moving 0°");
});

test("the exported protocol states the plaid, and states it was not one when it was not", () => {
  const proto = P.buildProtocol([
    { type: "moving", orientation: 0, sf: 0.02, tf: 1, contrast: 0.5, duration_s: 4,
      plaidAngle: 90, plaidNorm: true },
    { type: "moving", orientation: 45, sf: 0.02, tf: 1, contrast: 0.5, duration_s: 4 },
  ]);
  const [plaid, grating] = proto.sequence;
  assert.strictEqual(plaid.plaid_angle_deg, 90);
  assert.deepStrictEqual(plaid.component_orientations_deg, [0, 90]);
  assert.strictEqual(plaid.plaid_contrast_per, "plaid");
  assert.strictEqual(plaid.orientation_deg, 0);        // still a real orientation, not an average
  assert.strictEqual(plaid.marker_pulses, 3);          // the photodiode sees a moving grating
  assert.strictEqual(grating.plaid_angle_deg, null);
  assert.deepStrictEqual(grating.component_orientations_deg, [45]);
  assert.strictEqual(grating.plaid_contrast_per, null);
});

test("the shader mirror agrees with itself on the orientation convention", () => {
  // A plaid of components a and b must equal the plaid of b and a: summation is commutative,
  // and if the second component were built with the wrong sign it would not be.
  const base = { sf: 0.02, phase: 0.7, waveform: "sinusoid", contrast: 0.3, meanLum: 0.5 };
  for (const [fx, fy] of [[0, 0], [13, 5], [61, 97], [149, 103]]) {
    const ab = P.plaidLuminance(fx, fy, Object.assign({ orientationDeg: 30, plaidAngleDeg: 90 }, base));
    const ba = P.plaidLuminance(fx, fy, Object.assign({ orientationDeg: 120, plaidAngleDeg: 270 }, base));
    assert.ok(Math.abs(ab - ba) < 1e-9, `${fx},${fy}: ${ab} vs ${ba}`);
  }
});

console.log(`\n${passed} passed`);
