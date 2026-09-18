"use strict";
/* The page harness, shared by the tests that need to run index.html's inline script.
 *
 * It was extracted from exports.test.js on 2026-09-18, when a second test file (the durable
 * trial log) needed the same DOM stub. Two copies of a stub this fiddly drift apart, and the
 * drift is invisible until one of them stops reflecting the page.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** The page's own inline script — the largest <script> block with no src. */
function inlineScript(src) {
  const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);
  assert.ok(blocks.length, "index.html has no inline <script> block");
  return blocks.reduce((a, b) => (b.length > a.length ? b : a));
}

/** A DOM stub thin enough to read and complete enough to load the page's script. */
function makeSandbox(downloads, patch) {
  const anything = () => new Proxy(function () {}, {
    get: (t, k) => (k === "then" ? undefined : anything()),
    apply: () => anything(),
    set: () => true,
  });
  const el = () => {
    const node = {
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      children: [], childNodes: [], value: "", textContent: "", innerHTML: "", checked: false,
      width: 800, height: 600, clientWidth: 800, clientHeight: 600,
      appendChild(c) { this.children.push(c); return c; },
      removeChild() {}, insertBefore(c) { return c; }, remove() {},
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [],
      // logEntry scrolls the log panel into view; the export tests never called it
      closest: () => null, scrollTop: 0, scrollHeight: 0,
      getContext: () => anything(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      focus() {}, blur() {}, click() { if (this.onclick) this.onclick({}); },
      requestFullscreen() {}, insertAdjacentHTML() {},
    };
    return node;
  };
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, el());
      return byId.get(id);
    },
    createElement(tag) {
      const n = el();
      if (tag === "a") {
        // this is the download path: capture instead of navigating
        Object.defineProperty(n, "click", { value() { downloads.push({ name: n.download, href: n.href }); } });
      }
      return n;
    },
    querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: el(), documentElement: el(), hidden: false, fullscreenElement: null,
    exitFullscreen() {},
  };
  const blobs = new Map();
  let n = 0, clock = 0;
  const sandbox = {
    document,
    console: { log() {}, warn() {}, error() {}, info() {} },
    alert(msg) { sandbox.__alerts.push(String(msg)); },
    __alerts: [],
    __blobs: blobs,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: {
      createObjectURL(b) { const u = "blob:" + (++n); blobs.set(u, b); return u; },
      revokeObjectURL() {},
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    // a clock that ADVANCES: closeBlock() drops any block shorter than 20 ms, so a frozen
    // now() silently produces an empty protocol — which is the real duration logic working
    performance: { now: () => (clock += 1000) },
    navigator: { userAgent: "node", platform: "test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { hash: "", href: "http://localhost/", search: "", reload() {} },
    screen: { width: 1920, height: 1080 }, devicePixelRatio: 1,
    innerWidth: 1200, innerHeight: 800, open: () => null, BroadcastChannel: class {
      constructor() {} postMessage() {} close() {} addEventListener() {}
    },
    WebGLRenderingContext: function () {}, Math, JSON, Date, Object, Array, String, Number,
    Boolean, Error, TypeError, Promise, Map, Set, isNaN, parseFloat, parseInt, encodeURIComponent,
  };
  // Per-test overrides (a controllable `fetch`, say) go in BEFORE window/globalThis are
  // aliased, so the page sees one object however it reaches for them.
  Object.assign(sandbox, patch || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // protocol.js is a real dependency, not a stub: the renamed constant lived in it
  const ctx = vm.createContext(sandbox);
  const protocolJs = fs.readFileSync(path.join(ROOT, "protocol.js"), "utf8");
  vm.runInContext(protocolJs + "\n;if(!window.STIMPROTOCOL && typeof module!=='undefined')"
    + "window.STIMPROTOCOL=module.exports;", ctx);
  return { ctx, sandbox, byId };
}

/** The page splits into two roles — `if (ROLE === 'stim') { ...stimulus screen... } else {
 *  ...operator cockpit... }` — and everything the exports use (`openBlock`, `guard`,
 *  `playedEvents`) is declared inside that else block. In strict mode a block-scoped
 *  declaration does not leak, so a driver appended after the script cannot see any of it.
 *  It is therefore SPLICED IN just before the block closes, which is also the only honest
 *  place to put it: the test then runs in exactly the scope the buttons run in. */
function spliceIntoCockpit(src, drive) {
  if (!drive) return src;
  const lines = src.split("\n");
  const close = lines.reduce((last, l, i) => (/^\}\s*$/.test(l) ? i : last), -1);
  assert.ok(close > 0, "could not find the cockpit block's closing brace");
  lines.splice(close, 0, drive);
  return lines.join("\n");
}

function loadPage(drive, patch) {
  const downloads = [];
  const { ctx, sandbox, byId } = makeSandbox(downloads, patch);
  vm.runInContext(spliceIntoCockpit(inlineScript(html), drive), ctx,
                  { filename: "index.html(inline)" });
  return { ctx, sandbox, byId, downloads, text: (d) => sandbox.__blobs.get(d.href).parts.join("") };
}

module.exports = { ROOT, html, inlineScript, makeSandbox, spliceIntoCockpit, loadPage };
