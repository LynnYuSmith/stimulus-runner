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

test("a grating straight after a grating gets 4 pulses and the two become one pair", () => {
  const { sandbox } = loadPage(`window.__c = {
    show: (ori) => showGrating({ type:'moving', orientation:ori, sf:0.02, tf:1, contrast:1, duration:4, moving:true }),
    grey: () => applyGrey(true),
    count: () => R.st.markerCount,
    last: (k) => rows[rows.length-1] && rows[rows.length-1][k],
    at: (i, k) => rows[i] && rows[i][k],
  };`);
  const c = sandbox.window.__c;
  c.grey(); c.show(135);
  assert.strictEqual(c.count(), 3, "a grating after grey is a plain moving grating");
  assert.strictEqual(c.last("kind"), "grating");
  assert.strictEqual(c.last("code"), "135");
  assert.strictEqual(c.last("pairCode"), "", "nothing to pair with yet");
  c.show(315);
  assert.strictEqual(c.count(), 4, "the second half of a pair is marked with four pulses");
  // BOTH blocks are still gratings. The pair is what the two of them are together.
  assert.strictEqual(c.last("kind"), "grating", "the second block is a grating, not a 'contrast'");
  assert.strictEqual(c.last("pairCode"), "135c315");
  assert.strictEqual(c.last("pairPart"), 2);
  assert.strictEqual(c.at(1, "pairCode"), "135c315", "the first block was amended into the pair");
  assert.strictEqual(c.at(1, "pairPart"), 1);
  c.grey(); c.show(135);
  assert.strictEqual(c.count(), 3, "grey in between breaks the pair");
  assert.strictEqual(c.last("pairCode"), "");
});

test("a plaid is logged as a plaid, because its two gratings are superimposed", () => {
  const { sandbox } = loadPage(`window.__c = {
    show: (tr) => showGrating(Object.assign({ type:'moving', sf:0.02, tf:1, contrast:1,
                                              duration:4, moving:true }, tr)),
    grey: () => applyGrey(true),
    last: (k) => rows[rows.length-1] && rows[rows.length-1][k],
  };`);
  const c = sandbox.window.__c;
  c.grey(); c.show({ orientation: 0, plaid: true, dir2: 90, tf2: 1 });
  assert.strictEqual(c.last("kind"), "plaid", "two summed gratings are not a grating");
  assert.strictEqual(c.last("code"), "0p90");
  c.grey(); c.show({ orientation: 0 });
  assert.strictEqual(c.last("kind"), "grating");
});

test("+ contrast queues the same grating turned 180°, with NO grey between the two", () => {
  const { sandbox } = loadPage(`window.__q = {
    press: (id) => document.getElementById(id).onclick(),
    set: (id, v) => { const e = document.getElementById(id); e.value = v; },
    pick: (seg, key, val) => document.querySelectorAll('#'+seg+' button').forEach(b =>
      b.classList.toggle('sel', b.dataset[key] === val)),
    queue: () => JSON.stringify(queue.map(it => ({ type: it.type, ori: it.orientation,
                                    dir2: it.dir2, plaid: !!it.plaid }))),
  };`);
  const q = sandbox.window.__q;
  q.set("ori", 135); q.set("greyBetween", 4);
  q.press("qContrast");
  const got = JSON.parse(q.queue());
  assert.strictEqual(got.length, 2, "a pair is two blocks, not three");
  assert.strictEqual(got[0].ori, 135);
  assert.strictEqual(got[1].ori, 315, "the contrast half is the base turned 180°");
  assert.ok(got.every(b => b.type !== "grey"), "a grey inside the pair would break the 4c4s");
});

test("+ contrast turns BOTH gratings of a plaid, so only the drift reverses", () => {
  // Driven through contrastPair itself: the page's seg buttons are read with a selector the
  // DOM stub does not implement, so going through the form here would test the stub, not this.
  // JSON round-trip: objects built inside the vm have the sandbox's Object.prototype, and
  // deepStrictEqual compares prototypes -- it fails on values that are otherwise identical.
  const { sandbox } = loadPage(`window.__p = (b) => JSON.stringify(contrastPair(b));`);
  assert.deepStrictEqual(
    JSON.parse(sandbox.window.__p({ orientation: 30, dir2: 120, plaid: true, type: "moving" })),
    [{ orientation: 30, dir2: 120, plaid: true, type: "moving" },
     { orientation: 210, dir2: 300, plaid: true, type: "moving" }]);
  // and it wraps rather than running past 360
  const wrapped = JSON.parse(sandbox.window.__p({ orientation: 315, dir2: 45 }));
  assert.strictEqual(wrapped[1].orientation, 135);
  assert.strictEqual(wrapped[1].dir2, 225);
});

test("+ contrast sweep is four pairs over all eight directions, grey only between pairs", () => {
  const { sandbox } = loadPage(`window.__q = {
    press: (id) => document.getElementById(id).onclick(),
    set: (id, v) => { const e = document.getElementById(id); e.value = v; },
    queue: () => JSON.stringify(queue.map(it => it.type === 'grey' ? 'grey' : it.orientation)),
  };`);
  const q = sandbox.window.__q;
  q.set("ori", 0); q.set("greyBetween", 4);
  q.press("qContrastSweep");
  assert.deepStrictEqual(JSON.parse(q.queue()),
    [0, 180, "grey", 45, 225, "grey", 90, 270, "grey", 135, 315]);
  const dirs = JSON.parse(q.queue()).filter(v => v !== "grey");
  assert.strictEqual(new Set(dirs).size, 8, "every direction appears, and appears once");
});

console.log(`\n  ${passed} queue tests passed`);
