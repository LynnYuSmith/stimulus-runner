"use strict";
/* The page's half of the durable trial log. Run: node test/stimlog.test.js
 *
 * The crash that started this (2026-09-18, the stimulus PC froze mid-session) destroyed a log
 * that existed only in this page's memory. serve.py now appends every epoch to disk, and
 * test/stimlog_crash.test.py kills the server to prove the file survives. This file covers the
 * other half, which no server test can see:
 *
 *   * does the page actually SEND each epoch, with the columns the pipeline reads;
 *   * does it re-send a row whose duration was filled in afterwards;
 *   * when the send fails, does the operator SEE it -- a trial log that quietly stops saving is
 *     worse than none, because you would still believe there was a copy;
 *   * does a failed epoch get retried on the next one, rather than being dropped;
 *   * does Clear start a new file instead of appending to the finished session's.
 *
 * The page is driven through the same vm + DOM stub the export tests use (test/pageharness.js),
 * with `fetch` replaced by one this file controls.
 */
const assert = require("node:assert");
const { loadPage } = require("./pageharness");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

/** A fetch stub that records every call and can be told to fail. Resolution is synchronous
 *  (an already-settled promise), so a `drain()` of microtasks is all the waiting needed. */
function makeFetch() {
  const calls = [];
  let mode = "ok";                        // "ok" | "http" | "network"
  const fetch = (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: (opts && opts.method) || "GET", body });
    if (mode === "network") return Promise.reject(new Error("Failed to fetch"));
    if (mode === "http") return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve({ ok: true, status: 200,
                             json: () => Promise.resolve({ ok: true, file: "stimlog_test.jsonl" }) });
  };
  return { fetch, calls, fail: (m) => { mode = m; }, heal: () => { mode = "ok"; },
           posts: () => calls.filter(c => c.method === "POST" && c.url === "/api/stimlog") };
}

/** Let every queued promise callback run. */
function drain() {
  for (let i = 0; i < 50; i++) Promise.resolve().then(() => {});
  // the vm shares this realm's microtask queue, so a sync spin is not enough: yield once
  return new Promise(r => setImmediate(r));
}

/* The driver is spliced into the cockpit block, which is the only scope where logEntry,
   sessionId and the unsaved map exist. */
const DRIVE = `window.__t = {
  logEntry: (o) => logEntry(o),
  rows,
  unsaved,
  badge: () => ({ cls: saveBadge.className, text: saveBadge.textContent }),
  sessionId: () => sessionId,
  clear: () => document.getElementById('clearLog').onclick(),
  exportCsvText: null,
};`;

function page(patch) {
  const f = makeFetch();
  const p = loadPage(DRIVE, Object.assign({ fetch: f.fetch }, patch || {}));
  return { f, t: p.sandbox.window.__t, ...p };
}

(async () => {

test("the page probes the log endpoint at load, so a dead server is visible before the session", () => {
  const { f } = page();
  const probes = f.calls.filter(c => c.url === "/api/stimlog" && c.method === "GET");
  assert.strictEqual(probes.length, 1, "no probe at load");
});

test("each logged epoch is POSTed, with the column names the pipeline's reader expects", () => {
  const { f, t } = page();
  t.logEntry({ type: "moving", orientation: 135, duration: 4, sf: 0.04, tf: 2, contrast: 1 });
  const posts = f.posts();
  assert.strictEqual(posts.length, 1, "the epoch was not sent");
  const { session, rows } = posts[0].body;
  // timestamp + a random tail: the tail is what stops two sessions sharing one file
  assert.ok(/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(session),
            "session id is not a stamped, disambiguated one: " + session);
  assert.strictEqual(rows.length, 1);
  for (const col of ["n", "wallclock", "unix_ms", "type", "direction_deg", "orientation_deg",
                     "duration_s", "spatial_freq_cpd", "temporal_freq_hz", "contrast"]) {
    assert.ok(col in rows[0], "the sent row is missing " + col);
  }
  assert.strictEqual(rows[0].direction_deg, 135);
  assert.strictEqual(rows[0].duration_s, 4);
});

test("a grey's duration, filled in when the next epoch starts, is sent again with the new one", () => {
  const { f, t } = page();
  t.logEntry({ type: "grey" });                      // no duration: it lasts until the next thing
  t.logEntry({ type: "moving", orientation: 90, duration: 4 });
  const posts = f.posts();
  assert.strictEqual(posts.length, 2);
  const second = posts[1].body.rows;
  assert.strictEqual(second.length, 2, "the closed grey was not re-sent with the new epoch");
  const grey = second.find(r => r.type === "grey");
  assert.ok(grey, "no grey row in the second POST");
  assert.ok(typeof grey.duration_s === "number" && grey.duration_s >= 0,
            "the grey went to disk still open: " + JSON.stringify(grey));
});

test("a logged epoch never throws into the presentation path, even if fetch does", () => {
  const { t } = page({ fetch: () => { throw new Error("fetch exploded"); } });
  assert.doesNotThrow(() => t.logEntry({ type: "moving", orientation: 0, duration: 4 }));
  assert.strictEqual(t.rows.length, 1, "the row was still logged in the page");
  assert.strictEqual(t.badge().cls, "bad", "a thrown fetch must still show as not saved");
});

test("a failed save turns the badge red and says how many epochs are only in the tab", async () => {
  const { f, t } = page();
  f.fail("network");
  t.logEntry({ type: "moving", orientation: 45, duration: 4 });
  await drain();
  const b = t.badge();
  assert.strictEqual(b.cls, "bad", "the badge stayed quiet after a failed save: " + b.text);
  assert.match(b.text, /NOT SAVED/, b.text);
  assert.match(b.text, /1 epoch/, b.text);
});

test("an epoch that failed to save is re-sent with the next one, not dropped", async () => {
  const { f, t } = page();
  f.fail("http");
  t.logEntry({ type: "moving", orientation: 0, duration: 4 });
  await drain();
  f.heal();
  t.logEntry({ type: "moving", orientation: 90, duration: 4 });
  await drain();
  const last = f.posts().pop().body.rows;
  assert.deepStrictEqual(last.map(r => r.n), [1, 2],
                         "the failed epoch was not carried into the next POST");
  assert.strictEqual(t.badge().cls, "ok", "the badge did not recover after a successful save");
  assert.strictEqual(t.unsaved.size, 0, "rows stayed marked unsaved after being acknowledged");
});

test("a late reply to an old send does not clear a row that changed since", async () => {
  /* The failure this guards: a grey is sent open, the reply is slow, the page meanwhile closes
     its duration and re-queues it. If the old reply cleared the row by identity, the closed
     value would never reach the disk and the file would keep the open one for ever. */
  const { f, t } = page();
  f.fail("network");
  t.logEntry({ type: "grey" });                      // n=1, open, fails
  await drain();
  f.heal();
  t.logEntry({ type: "moving", orientation: 135, duration: 4 });   // closes n=1, sends 1 and 2
  await drain();
  const sent = f.posts().pop().body.rows;
  const grey = sent.find(r => r.n === 1);
  assert.ok(typeof grey.duration_s === "number",
            "the re-sent grey is still open: " + JSON.stringify(grey));
  assert.strictEqual(t.unsaved.size, 0);
});

test("Clear starts a new session id, so a finished log is never appended to", () => {
  const { f, t } = page();
  t.logEntry({ type: "moving", orientation: 0, duration: 4 });
  const first = t.sessionId();
  t.clear();
  t.logEntry({ type: "moving", orientation: 0, duration: 4 });
  const posts = f.posts();
  const second = posts[posts.length - 1].body.session;
  assert.notStrictEqual(second, first, "Clear kept the old session id: " + first);
  assert.strictEqual(posts[posts.length - 1].body.rows[0].n, 1,
                     "the new session did not restart the epoch count");
});

test("what the page sends and what Export CSV writes describe the same epochs", () => {
  /* Two independent copies are only worth having if they agree. This checks the pairing the
     pipeline relies on: same count, same order, same n. */
  const { f, t, byId, downloads, text } = page();
  for (const ori of [0, 45, 90]) t.logEntry({ type: "moving", orientation: ori, duration: 4 });
  byId.get("expCsv").onclick();
  const csv = text(downloads[0]).trim().split("\n");
  const head = csv[0].split(",");
  const csvRows = csv.slice(1).map(l => l.split(","));
  const sentByN = new Map();
  for (const p of f.posts()) for (const r of p.body.rows) sentByN.set(r.n, r);
  assert.strictEqual(csvRows.length, sentByN.size, "the two copies hold different epoch counts");
  for (const row of csvRows) {
    const n = Number(row[head.indexOf("n")]);
    const sent = sentByN.get(n);
    assert.ok(sent, "epoch " + n + " is in the CSV but was never sent to disk");
    assert.strictEqual(String(sent.direction_deg), row[head.indexOf("direction_deg")]);
    assert.strictEqual(String(sent.type), row[head.indexOf("type")]);
  }
});

console.log(`\n  ${passed} trial-log tests passed`);
})().catch(e => { console.error("\n  FAILED: " + (e && e.stack || e)); process.exit(1); });
