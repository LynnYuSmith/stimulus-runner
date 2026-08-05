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

console.log(`\n${passed} passed`);
