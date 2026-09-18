"use strict";
/* The export buttons, actually clicked. Run: node test/exports.test.js
 *
 * Why this exists. On 2026-09-11 both JSON exports referenced `MARKER_FPS`, a constant that had
 * been renamed into `MARKER.FPS` inside protocol.js. Every click threw ReferenceError, an
 * exception inside an onclick reaches the console and nowhere else, and so the buttons simply
 * did nothing -- while Export CSV, which never touched that constant, kept working. The session
 * ran, the CSV came out, and the played protocol had to be written out BY HAND afterwards.
 *
 * Neither existing check could have caught it: `node --check` finds syntax errors and this was a
 * runtime one, and the protocol tests exercise protocol.js while the bug was in the page's own
 * inline script. A regex lint over that script was tried first and rejected -- nested template
 * literals desync any quote-stripping, so it reported `MARKER_RGB` and `PULSE_PERIOD_S` (both
 * declared, as the second declarator of a `const a = x, b = y`) as undefined. A guard that cries
 * wolf gets ignored, which is worse than no guard.
 *
 * So this runs the page's real inline script in a `vm` against a DOM stub, then clicks all three
 * export buttons and asserts each one produced a file with the expected shape. Anything the
 * handlers touch has to exist for real.
 *
 * The stub is deliberately dumb: getElementById hands out a generic element, the canvas context
 * is a Proxy that swallows every WebGL call, and `download` is captured. That is enough because
 * the exports are pure data assembly -- if one ever needs a live GL context to write a file,
 * this test failing is the correct answer.
 */
const assert = require("node:assert");
const { loadPage } = require("./pageharness");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  \u2713 " + name); }


test("the page's inline script loads against a DOM stub", () => {
  const { sandbox } = loadPage();
  assert.ok(sandbox.window.STIMPROTOCOL, "protocol.js did not publish STIMPROTOCOL");
});

test("all three export buttons have a handler attached", () => {
  const { byId } = loadPage();
  for (const id of ["expCsv", "expJson", "expProto"]) {
    assert.strictEqual(typeof byId.get(id).onclick, "function", id + " has no onclick");
  }
});

test("Export CSV writes the header the pipeline's runner-log reader expects", () => {
  const { byId, downloads, text } = loadPage();
  byId.get("expCsv").onclick();
  assert.strictEqual(downloads.length, 1, "no file was produced");
  assert.strictEqual(downloads[0].name, "stimlog.csv");
  const head = text(downloads[0]).split("\n")[0];
  // lib/stimulus/runner_log.load_stimlog reads these names
  for (const col of ["n", "wallclock", "unix_ms", "type", "direction_deg", "orientation_deg",
                     "duration_s"]) {
    assert.ok(head.split(",").includes(col), "CSV header is missing " + col);
  }
});

test("Export JSON writes a parseable file with its provenance — the MARKER_FPS regression", () => {
  const { byId, downloads, text, sandbox } = loadPage();
  byId.get("expJson").onclick();
  assert.deepStrictEqual(sandbox.__alerts, [], "the handler reported a failure");
  assert.strictEqual(downloads.length, 1, "Export JSON produced no file");
  assert.strictEqual(downloads[0].name, "stimlog.json");
  const d = JSON.parse(text(downloads[0]));
  assert.ok(d.session_started, "no session_started");
  assert.ok(d.exported, "no exported timestamp");
  assert.strictEqual(d.marker_fps, sandbox.window.STIMPROTOCOL.MARKER.FPS,
                     "marker_fps must come from protocol.js, not a stray constant");
  assert.ok(Array.isArray(d.rows), "rows must be an array");
});

test("Export protocol straight after load writes the opening grey, and says nothing else", () => {
  /* The page's last act is `openBlock('grey', null)` — a session always starts on grey — so the
     "Nothing played yet" branch is unreachable in practice, and an export at any moment after
     load yields at least that one block. Asserted because the first version of this test
     assumed the opposite and the page corrected it. */
  const { byId, downloads, text, sandbox } = loadPage();
  byId.get("expProto").onclick();
  assert.deepStrictEqual(sandbox.__alerts, [], "the handler reported a failure");
  assert.strictEqual(downloads.length, 1, "Export protocol produced no file");
  const p = JSON.parse(text(downloads[0]));
  assert.strictEqual(p.sequence.length, 1);
  assert.strictEqual(p.sequence[0].type, "grey");
});

test("Export protocol writes a played protocol once blocks exist", () => {
  // drive the page's OWN bookkeeping rather than fabricating a protocol
  const { byId, downloads, text, sandbox } = loadPage(`
      openBlock('grey', null); closeBlock();
      openBlock('moving', {orientation:45, sf:0.02, tf:1, contrast:1}); closeBlock();`);
  byId.get("expProto").onclick();
  assert.deepStrictEqual(sandbox.__alerts, [], "the handler reported a failure");
  assert.strictEqual(downloads.length, 1, "Export protocol produced no file");
  assert.strictEqual(downloads[0].name, "protocol_played.json");
  const p = JSON.parse(text(downloads[0]));
  assert.ok(Array.isArray(p.sequence) && p.sequence.length >= 2, "no sequence");
  assert.strictEqual(p.marker_fps, sandbox.window.STIMPROTOCOL.MARKER.FPS);
  assert.ok(p.session_started, "no session_started");
  // the pipeline groups epochs by type and reads the orientation off the moving ones
  const moving = p.sequence.filter(s => s.type === "moving");
  assert.strictEqual(moving.length, 1);
  assert.strictEqual(moving[0].orientation_deg, 45);
});

test("a throwing export reports itself instead of doing nothing", () => {
  const { byId, sandbox } = loadPage(
      "document.getElementById('expCsv').onclick = "
    + "guard('Export CSV', function(){ throw new Error('boom'); });");
  byId.get("expCsv").onclick();
  assert.strictEqual(sandbox.__alerts.length, 1, "the failure was swallowed");
  assert.match(sandbox.__alerts[0], /Export CSV failed/);
  assert.match(sandbox.__alerts[0], /boom/);
});

console.log(`\n  ${passed} export tests passed`);
