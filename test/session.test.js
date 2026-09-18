"use strict";
/* The session that saves itself. Run: node test/session.test.js
 *
 * What the page must do (2026-09-18, after the stimulus PC froze mid-session):
 *   * PUT the cockpit state to the server whenever it changes -- queue, form, screen settings,
 *     run position -- under the SAME id as the trial log;
 *   * on load, if the server has a recent session, offer to continue it; saying yes restores
 *     the queue and the form, keeps the same session id (so the stimlog continues), and stands
 *     the queue at the block that was on screen -- PAUSED. `running` is never restored;
 *   * saying no starts fresh and saves the fresh state;
 *   * a session from another day is not offered.
 *
 * Driven through test/pageharness.js with a fetch this file controls. Timers in the harness
 * are inert, so the debounced save is exercised by calling the flush it schedules.
 */
const assert = require("node:assert");
const { loadPage } = require("./pageharness");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

function makeFetch(latest) {
  const puts = [];
  const fetch = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (method === "PUT" && url.startsWith("/api/session/")) {
      puts.push({ id: decodeURIComponent(url.slice("/api/session/".length)), body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    if (method === "GET" && url === "/api/session") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(latest || { session: null, state: null }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, file: "x" }) });
  };
  return { fetch, puts };
}

const DRIVE = `window.__s = {
  state: () => sessionState(),
  flush: () => { sessDirty = true; flushSession(); },
  sessionId: () => sessionId,
  queue, rows,
  isRunning: () => running, isPaused: () => paused, runIdx: () => runIdx,
  fill: () => { greyBetweenEl.value = '4'; document.getElementById('qSweep').onclick(); },
  setOri: (v) => { const o = document.getElementById('ori'); o.value = String(v); o.dispatchEvent(new Event('input')); },
  ori: () => document.getElementById('ori').value,
  banner: () => ({ shown: document.getElementById('resume').classList.contains('show'),
                   text: document.getElementById('resumeText').innerHTML }),
  yes: () => document.getElementById('resumeYes').onclick(),
  no: () => document.getElementById('resumeNo').onclick(),
  startRun: () => { running = true; paused = false; runIdx = 3; },
};`;

/** The harness has no Event constructor and inputs do not dispatch; give the sandbox both. */
function page(latest) {
  const f = makeFetch(latest);
  const timers = [];
  const p = loadPage(DRIVE, {
    fetch: f.fetch,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  // the stub's dispatchEvent is a no-op; wire it to the recorded 'input' listeners
  for (const el of p.byId.values()) {
    el.dispatchEvent = (ev) => { ((el.__listeners || {})[ev.type] || []).forEach(fn => fn(ev)); return true; };
  }
  return { f, timers, s: p.sandbox.window.__s, ...p };
}
const drain = () => new Promise(r => setImmediate(r));

(async () => {

test("the state carries the queue, the form, the segments, the run position and the log count", () => {
  const { s } = page();
  s.fill(); s.setOri(135);
  const st = s.state();
  assert.strictEqual(st.queue.length, 15);
  assert.strictEqual(st.form.ori, "135");
  assert.ok(st.moveSeg === null || typeof st.moveSeg === "object");
  assert.deepStrictEqual(Object.keys(st.run).sort(), ["next_block", "paused", "runIdx", "was_running"]);
  assert.ok(st.saved && st.session_started, "no timestamps");
  assert.strictEqual(typeof st.log.n, "number");
});

test("a change to the queue schedules a save, and the save PUTs under the stimlog's id", async () => {
  const { s, f, timers } = page();
  s.fill();
  const t = timers.find(x => x.ms === 400);
  assert.ok(t, "renderQueue did not schedule the debounced save");
  t.fn();
  await drain();
  assert.strictEqual(f.puts.length, 1, "no PUT went out");
  assert.strictEqual(f.puts[0].id, s.sessionId(), "session saved under a different id than the log");
  assert.strictEqual(f.puts[0].body.queue.length, 15);
});

test("a form change alone also saves", async () => {
  const { s, f, timers } = page();
  s.setOri(90);
  const t = timers.find(x => x.ms === 400);
  assert.ok(t, "an input change did not schedule a save");
  t.fn(); await drain();
  assert.strictEqual(f.puts.pop().body.form.ori, "90");
});

test("with no saved session the banner stays hidden", async () => {
  const { s } = page();
  await drain();
  assert.strictEqual(s.banner().shown, false);
});

const saved = (over) => ({
  session: "20260918-124700-ab12",
  state: Object.assign({
    saved: new Date(Date.now() - 5 * 60000).toISOString(),
    session_started: new Date(Date.now() - 40 * 60000).toISOString(),
    queue: [{ type: "grey", orientation: null, duration: 4 },
            { type: "moving", orientation: 225, sf: 0.04, tf: 2, contrast: 1, duration: 8, moving: true, zone: null },
            { type: "grey", orientation: null, duration: 4 }],
    form: { ori: "225", dur: "8", greyBetween: "4" },
    moveSeg: { mv: "moving" }, waveSeg: null, zone: null,
    run: { runIdx: 2, paused: false, was_running: true, next_block: 1 },
    log: { n: 7, rows: 7 },
  }, over || {}),
});

test("a recent session is offered, with its queue size and position in the text", async () => {
  const { s } = page(saved());
  await drain(); await drain();
  const b = s.banner();
  assert.strictEqual(b.shown, true, "banner not shown for a 5-minute-old session");
  assert.match(b.text, /Queue of <b>3<\/b> blocks/);
  assert.match(b.text, /#2/, "the block that was playing is not named");
  assert.match(b.text, /7 epochs/);
});

test("yes: the queue and form come back, the id is the old one, and the queue stands PAUSED", async () => {
  const { s, f } = page(saved());
  await drain(); await drain();
  s.yes();
  assert.strictEqual(s.sessionId(), "20260918-124700-ab12", "resume did not keep the session id");
  assert.strictEqual(s.queue.length, 3);
  assert.strictEqual(s.queue[1].orientation, 225);
  assert.strictEqual(s.ori(), "225", "the form was not restored");
  assert.strictEqual(s.isRunning(), false, "running must never be restored");
  assert.strictEqual(s.runIdx(), 1, "the queue should stand at the block that was on screen");
});

test("no: nothing is restored, a fresh state is saved under a NEW id", async () => {
  const { s, f, timers } = page(saved());
  await drain(); await drain();
  const before = s.sessionId();
  s.no();
  assert.notStrictEqual(s.sessionId(), "20260918-124700-ab12");
  assert.strictEqual(s.sessionId(), before);
  assert.strictEqual(s.queue.length, 0);
  const t = timers.find(x => x.ms === 400); assert.ok(t); t.fn(); await drain();
  assert.strictEqual(f.puts.pop().id, before);
});

test("a session older than 12 hours is not offered", async () => {
  const { s } = page(saved({ saved: new Date(Date.now() - 20 * 3600000).toISOString() }));
  await drain(); await drain();
  assert.strictEqual(s.banner().shown, false);
});

test("the saved state never says a run is in progress after a resume", async () => {
  const { s, timers, f } = page(saved());
  await drain(); await drain();
  s.yes();
  const t = timers.filter(x => x.ms === 400).pop(); assert.ok(t); t.fn(); await drain();
  const st = f.puts.pop().body;
  assert.strictEqual(st.run.was_running, false);
});

console.log(`\n  ${passed} session tests passed`);
})().catch(e => { console.error("\n  FAILED: " + (e && e.stack || e)); process.exit(1); });
