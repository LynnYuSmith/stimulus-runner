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
  /* Elements are stubs, but a few things are real enough for the queue tests to lean on:
     classList is backed by className; addEventListener records into __listeners so a test can
     fire a handler; setting innerHTML to markup creates child stubs for the <button>s in it
     (dataset, class, disabled) and to '' clears the children; querySelectorAll walks the
     children by tag and class. Everything else stays inert. */
  const parseButtons = (markup) => {
    const out = [];
    for (const m of String(markup).matchAll(/<button\b([^>]*)>/g)) {
      const attrs = m[1]; const b = el();
      b.tagName = "BUTTON";
      const cls = /class="([^"]*)"/.exec(attrs); b.className = cls ? cls[1] : "";
      // digits count: `data-p2` is a perfectly ordinary attribute and a letters-only pattern
      // drops it SILENTLY, leaving the button with no dataset and the page reading it as unset.
      for (const d of attrs.matchAll(/data-([a-z][a-z0-9-]*)="([^"]*)"/g)) b.dataset[d[1]] = d[2];
      b.disabled = /\bdisabled\b/.test(attrs.replace(/"[^"]*"/g, ""));
      out.push(b);
    }
    return out;
  };
  const matches = (node, sel) => {
    // supports "tag", ".cls", "tag.cls", and comma lists
    if (sel === "*") return true;
    return sel.split(",").some(one => {
      one = one.trim(); const dot = one.indexOf(".");
      const tag = dot < 0 ? one : one.slice(0, dot); const cls = dot < 0 ? null : one.slice(dot + 1);
      if (tag && (node.tagName || "").toLowerCase() !== tag.toLowerCase()) return false;
      if (cls && !(node.className || "").split(/\s+/).includes(cls)) return false;
      return true;
    });
  };
  const walk = (node, sel, out) => {
    for (const c of [...(node.children || []), ...(node.__created || [])]) {
      if (matches(c, sel)) out.push(c);
      walk(c, sel, out);
    }
    return out;
  };
  const el = (tag) => {
    let className = "", html = "";
    const node = {
      tagName: (tag || "div").toUpperCase(),
      style: {}, dataset: {}, __listeners: {}, __created: [],
      children: [], childNodes: [], value: "", textContent: "", checked: false,
      width: 800, height: 600, clientWidth: 800, clientHeight: 600,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild() {}, insertBefore(c) { return c; }, remove() {},
      addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); },
      /* The page dispatches `new Event('input')` to make a programmatic value change look like
         a typed one -- that is how the form's displays refresh and how the mirrored sliders in
         the Sequence card stay one value. Without it here the stub throws at load. */
      dispatchEvent(ev) {
        const t = (ev && ev.type) || String(ev);
        for (const fn of this.__listeners[t] || []) fn.call(this, ev);
        return true;
      },
      removeEventListener() {}, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null,
      querySelector(sel) { return walk(this, sel, [])[0] || el(); },
      querySelectorAll(sel) { return walk(this, sel, []); },
      contains(other) { return walk(this, "*", []).includes(other) || other === this; },
      // logEntry scrolls the log panel into view; the export tests never called it
      closest: () => null, scrollTop: 0, scrollHeight: 0,
      getContext: () => anything(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      focus() {}, blur() {}, click() { if (this.onclick) this.onclick({}); },
      requestFullscreen() {}, insertAdjacentHTML() {},
    };
    Object.defineProperty(node, "className", {
      get: () => className, set: (v) => { className = String(v); }, enumerable: true });
    node.classList = {
      add(...c) { const s = new Set(className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); className = [...s].join(" "); },
      remove(...c) { className = className.split(/\s+/).filter(x => x && !c.includes(x)).join(" "); },
      toggle(c, force) { const has = this.contains(c); if (force === undefined ? has : !force) this.remove(c); else this.add(c); },
      contains(c) { return className.split(/\s+/).includes(c); },
    };
    Object.defineProperty(node, "innerHTML", {
      get: () => html, enumerable: true,
      set: (v) => { html = String(v); if (html === "") { node.children.length = 0; node.__created.length = 0; }
                    else node.__created = parseButtons(html); },
    });
    return node;
  };
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, el());
      return byId.get(id);
    },
    createElement(tag) {
      const n = el(tag);
      if (tag === "a") {
        // this is the download path: capture instead of navigating
        Object.defineProperty(n, "click", { value() { downloads.push({ name: n.download, href: n.href }); } });
      }
      return n;
    },
    querySelector: () => el(), querySelectorAll: () => [],
    __listeners: {},
    addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); },
    removeEventListener() {},
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
    // `new Event('input')` is how the page tells a control it changed; a stub without it
    // throws the moment the page's script runs.
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
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
