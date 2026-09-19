"use strict";
/* The sequence queue: reordering by drag and by the arrow buttons. Run: node test/queue.test.js
 *
 * Why this exists. On the rig (Windows, Chrome) dragging a grating to a new place in the queue
 * left the whole cockpit unresponsive (2026-09-18). The drop handler re-rendered the table at
 * once, which destroys the very row being dragged while the browser's drag session is still
 * open; Chromium on Windows then never fires dragend and keeps eating clicks. That cannot be
 * reproduced on a Mac, and a DOM stub cannot reproduce a browser's drag session at all -- so
 * this file pins the INVARIANT the fix rests on, which any stub can check:
 *
 *   during `drop`, the queue table is not touched. The move is applied on `dragend`.
 *
 * Plus the things that must keep working around it: the order after a drop, a drag abandoned
 * outside the table, the up/down buttons as the drag-free route, and both being refused while
 * the queue is running.
 *
 * Driven through test/pageharness.js like the other page suites.
 */
const assert = require("node:assert");
const { loadPage } = require("./pageharness");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

/* The harness's elements are inert stubs: no layout, no real event dispatch. The drag handlers
   are reached through the listener lists the stub records, and rows are given a fake
   getBoundingClientRect so "above / below the midline" is decidable. */
const DRIVE = `window.__q = {
  queue, qBody,
  // the stub's inputs start empty; the real slider defaults to 4 s, and the sweep only inserts
  // greys when the gap is > 0
  fill: () => { greyBetweenEl.value = '4'; document.getElementById('qSweep').onclick(); },
  rows: () => qBody.children.filter(r => r.className && r.className.indexOf('qrow') >= 0),
  order: () => queue.map(it => it.type === 'grey' ? 'g' : String(it.orientation)).join(' '),
  setRunning: (v) => { running = v; },
  addBlockGrey: () => addBlock('grey'),
};`;

function page() {
  const p = loadPage(DRIVE);
  const q = p.sandbox.window.__q;
  // rows created by the page's createElement get an addEventListener that records listeners
  return { q, ...p };
}

/** Fire a listener of `type` registered on `el` (the stub keeps them in el.__listeners). */
function fire(el, type, ev) {
  const ls = (el.__listeners && el.__listeners[type]) || [];
  assert.ok(ls.length, `no ${type} listener on the row`);
  for (const fn of ls) fn(ev);
}
const dt = () => ({ effectAllowed: "", dropEffect: "", setData() {} });
const evAt = (row, yFrac) => ({ preventDefault() {}, dataTransfer: dt(),
                                 clientY: 100 + yFrac * 30, target: row });
function geometry(rows) { rows.forEach(r => { r.getBoundingClientRect = () => ({ top: 100, height: 30 }); }); }

test("the sweep fills the queue with 8 gratings and 7 greys in order", () => {
  const { q } = page();
  q.fill();
  assert.strictEqual(q.order(), "0 g 45 g 90 g 135 g 180 g 225 g 270 g 315");
  assert.strictEqual(q.rows().length, 15);
});

test("a drop does NOT re-render the table; dragend does", () => {
  const { q } = page();
  q.fill();
  const rows = q.rows(); geometry(rows);
  const before = q.rows();
  fire(rows[0], "dragstart", evAt(rows[0], 0.5));
  fire(rows[3], "dragover", evAt(rows[3], 0.8));
  fire(rows[3], "drop", evAt(rows[3], 0.8));
  // the invariant: same row objects, same order, right after drop
  assert.deepStrictEqual(q.rows(), before, "drop re-rendered the table while the drag was open");
  assert.strictEqual(q.order(), "0 g 45 g 90 g 135 g 180 g 225 g 270 g 315",
                     "the queue itself must not change until the browser lets go either");
  fire(rows[0], "dragend", {});
  assert.strictEqual(q.order(), "g 45 g 0 90 g 135 g 180 g 225 g 270 g 315",
                     "after dragend the move is applied: 0° lands after row 3");
  assert.notStrictEqual(q.rows()[0], before[0], "dragend re-rendered the rows");
});

test("dropping on the upper half of a row inserts before it", () => {
  const { q } = page();
  q.fill();
  const rows = q.rows(); geometry(rows);
  fire(rows[2], "dragstart", evAt(rows[2], 0.5));         // the 45°
  fire(rows[0], "dragover", evAt(rows[0], 0.2));
  fire(rows[0], "drop", evAt(rows[0], 0.2));
  fire(rows[2], "dragend", {});
  assert.strictEqual(q.order().split(" ").slice(0, 3).join(" "), "45 0 g");
});

test("if dragend never arrives, a timer applies the move anyway", () => {
  /* The harness's setTimeout is inert, so the fallback is exercised by calling what it would
     call. What this pins: the recorded move is applied by the fallback path, not lost. */
  const { q, sandbox } = page();
  const fired = [];
  sandbox.setTimeout = (fn, ms) => { fired.push({ fn, ms }); return fired.length; };
  q.fill();
  const rows = q.rows(); geometry(rows);
  fire(rows[0], "dragstart", evAt(rows[0], 0.5));
  fire(rows[3], "drop", evAt(rows[3], 0.8));
  const fb = fired.find(f => f.ms === 150);
  assert.ok(fb, "no fallback timer was armed on drop");
  assert.strictEqual(q.order().split(" ")[0], "0", "nothing applied before the timer");
  fb.fn();
  assert.strictEqual(q.order(), "g 45 g 0 90 g 135 g 180 g 225 g 270 g 315");
});

test("a drag abandoned outside the table changes nothing and leaves no marks", () => {
  const { q, sandbox } = page();
  q.fill();
  const rows = q.rows(); geometry(rows);
  fire(rows[0], "dragstart", evAt(rows[0], 0.5));
  fire(rows[2], "dragover", evAt(rows[2], 0.8));      // a mark is set
  // dragend on the document, as happens when the mouse is released off the table
  const docLs = (sandbox.document.__listeners && sandbox.document.__listeners.dragend) || [];
  assert.ok(docLs.length, "no document-level dragend safety net");
  docLs.forEach(fn => fn({}));
  assert.strictEqual(q.order(), "0 g 45 g 90 g 135 g 180 g 225 g 270 g 315");
  const marked = q.rows().filter(r => /drop-(above|below)|dragging/.test(r.className || ""));
  assert.strictEqual(marked.length, 0, "marks were left on rows");
  // and the next drag must start clean: a dragover with no drag in progress is ignored
  const r2 = q.rows(); geometry(r2);
  fire(r2[1], "dragover", evAt(r2[1], 0.5));
  assert.strictEqual(q.rows().filter(r => /drop-/.test(r.className || "")).length, 0,
                     "a dragover with no drag in progress must not mark anything");
});

test("the arrow buttons move a block up and down without any drag", () => {
  const { q, byId } = page();
  q.fill();
  const btns = () => q.rows().flatMap(r => (r.__created || []).filter(b => (b.className || "").indexOf("qmove") >= 0));
  let b = btns();
  assert.ok(b.length >= 2, "no move buttons rendered");
  const down0 = b.find(x => x.dataset.i === "0" && x.dataset.d === "1");
  assert.ok(down0, "row 0 has no ▼");
  down0.onclick();
  assert.strictEqual(q.order().split(" ").slice(0, 3).join(" "), "g 0 45");
  b = btns();
  const up1 = b.find(x => x.dataset.i === "1" && x.dataset.d === "-1");
  up1.onclick();
  assert.strictEqual(q.order().split(" ").slice(0, 3).join(" "), "0 g 45");
  const up0 = btns().find(x => x.dataset.i === "0" && x.dataset.d === "-1");
  assert.ok(up0.disabled, "the first row's ▲ must be disabled");
});

test("neither drag nor the arrows reorder while the queue is running", () => {
  const { q } = page();
  q.fill(); q.setRunning(true);
  const rows = q.rows(); geometry(rows);
  let prevented = false;
  fire(rows[0], "dragstart", { preventDefault() { prevented = true; }, dataTransfer: dt() });
  assert.ok(prevented, "dragstart was not refused while running");
  const down0 = q.rows().flatMap(r => r.__created || []).find(x => (x.className || "").indexOf("qmove") >= 0 && x.dataset.d === "1");
  down0.onclick();
  assert.strictEqual(q.order().split(" ")[0], "0", "the arrow moved a block during a run");
});

test("a grating straight after a grating is the contrast half: 4 pulses, role=contrast; after grey it is 3", () => {
  const { sandbox } = loadPage(`window.__c = {
    show: (ori) => showGrating({ type:'moving', orientation:ori, sf:0.02, tf:1, contrast:1, duration:4, moving:true }),
    grey: () => applyGrey(true),
    count: () => R.st.markerCount,
    lastRole: () => rows[rows.length-1].role,
  };`);
  const c = sandbox.window.__c;
  c.grey(); c.show(135);
  assert.strictEqual(c.count(), 3, "a grating after grey is a plain moving grating");
  assert.strictEqual(c.lastRole(), "grating");
  c.show(315);
  assert.strictEqual(c.count(), 4, "a grating straight after a grating is the contrast half");
  assert.strictEqual(c.lastRole(), "contrast");
  c.grey(); c.show(135);
  assert.strictEqual(c.count(), 3, "grey in between breaks the pair");
});

console.log(`\n  ${passed} queue tests passed`);
