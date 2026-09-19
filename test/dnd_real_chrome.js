"use strict";
/* Drive the queue's drag-and-drop in a REAL Chrome over CDP -- no puppeteer, node's built-in
   WebSocket only. NOT part of `npm test`: it needs Chrome on the machine and a running serve.py.

     python3 serve.py 8973 --no-browser &
     node test/dnd_real_chrome.js http://127.0.0.1:8973/

   What it checks: the sweep fills the queue; row 0 dragged onto row 3 lands after it; a click
   still works afterwards; a second drag starts. What it CANNOT check: the Windows-only stuck
   drag session (2026-09-18) -- a CDP-intercepted drag never delivers dragend, so the code path
   the fix exists for is not exercised here. test/queue.test.js pins the invariant instead.

   Two traps found writing it: rows in the 150 px scroll box that are scrolled out of view
   report a rect over whatever is painted there (the grey-gap slider), and mousePressed needs
   `buttons: 1` on the moves or Chrome never starts the drag. */
const { spawn } = require("node:child_process");
const http = require("node:http");

const URL_ = process.argv[2] || "http://127.0.0.1:8973/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, r => {
  let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--no-first-run", "--no-default-browser-check", "--user-data-dir=/tmp/dnd_chrome_profile",
    "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  // Whatever way this process ends -- success, fail(), an evaluate that threw, ctrl-c -- the
  // Chrome it started ends with it. Twelve orphaned headless Chromes were found on the
  // machine on 2026-09-19, one per script run that had exited through fail().
  process.on("exit", () => { try { chrome.kill(); } catch (_) {} });
  process.on("SIGINT", () => process.exit(130));
  await sleep(1500);
  let targets;
  for (let i = 0; i < 20; i++) { try { targets = await getJSON(`http://127.0.0.1:${PORT}/json`); break; } catch { await sleep(300); } }
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method) events.push(d); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJS = async (expr, timeoutMs = 3000) => {
    const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true }),
                                  sleep(timeoutMs).then(() => ({ timeout: true }))]);
    if (r.timeout) return { TIMEOUT: true };
    return r.result && r.result.result ? r.result.result.value : r;
  };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: URL_ });
  await sleep(1500);
  // the page opens a stim window on load? make sure the cockpit is what we have
  console.log("title:", await evalJS("document.title"));

  // fill the queue: the 8-orientation sweep button
  await evalJS("document.getElementById('qSweep').click(); document.getElementById('qCount').textContent");
  const n0 = await evalJS("document.querySelectorAll('#queueBody tr.qrow').length");
  console.log("queue rows:", n0);
  const before = await evalJS("[...document.querySelectorAll('#queueBody tr.qrow')].map(r=>r.children[1].textContent+':'+r.children[2].textContent).join(' | ')");
  console.log("before:", before);

  // geometry of row 0 and row 4
  const rect = async (i) => await evalJS(`(()=>{const r=document.querySelectorAll('#queueBody tr.qrow')[${i}].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,h:r.height}})()`);
  // the queue sits in a 150 px scroll box: ~4 rows visible, so drag row 0 onto row 3 without scrolling.
  // Scroll the PAGE so the box is in the viewport (the row rects are viewport-relative).
  await evalJS("document.getElementById('queueBody').closest('.logscroll').scrollIntoView({block:'center'})");
  await sleep(200);
  const src = await rect(0), dst = await rect(3);
  console.log("src", src, "dst", dst);
  console.log("viewport:", await evalJS("innerWidth+'x'+innerHeight+' scrollY='+scrollY"));
  console.log("elementFromPoint(src):", await evalJS(`(()=>{const e=document.elementFromPoint(${src.x},${src.y});return e?e.tagName+'#'+e.id+'.'+e.className:'null'})()`));
  console.log("layout of #queueBody:", await evalJS("JSON.stringify(document.getElementById('queueBody').getBoundingClientRect())"));

  await evalJS("window.__ev=[];['mousedown','mousemove','dragstart','dragend','drop','dragover','mouseup','click'].forEach(t=>document.addEventListener(t,e=>{if(__ev.length<40)__ev.push(t+':'+e.target.tagName+(e.target.className?'.'+e.target.className:''))},true)); 'ok'");
  console.log("running flag:", await evalJS("(()=>{try{return document.querySelector('#qRun').textContent}catch(e){return e+''}})()"));
  console.log("row draggable attr:", await evalJS("document.querySelectorAll('#queueBody tr.qrow')[0].getAttribute('draggable')"));
  // native drag via CDP: intercept, then replay as drag events (this is what puppeteer does)
  await send("Input.setInterceptDrags", { enabled: true });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: src.x, y: src.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: src.x, y: src.y, button: "left", clickCount: 1 });
  for (let k = 1; k <= 12; k++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: src.x + k, y: src.y + (dst.y + 4 - src.y) * k / 12, button: "left", buttons: 1 });
    await sleep(30);
  }
  await sleep(300);
  const intercepted = events.find(e => e.method === "Input.dragIntercepted");
  console.log("page events:", await evalJS("__ev.join(' ')"));
  console.log("cdp events seen:", [...new Set(events.map(e=>e.method))].join(","));
  if (!intercepted) { console.log("NO dragIntercepted event — drag never started"); }
  else {
    const data = intercepted.params.data;
    await send("Input.dispatchDragEvent", { type: "dragEnter", x: dst.x, y: dst.y + 4, data });
    await send("Input.dispatchDragEvent", { type: "dragOver", x: dst.x, y: dst.y + 4, data });
    await send("Input.dispatchDragEvent", { type: "drop", x: dst.x, y: dst.y + 4, data });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dst.x, y: dst.y + 4, button: "left", clickCount: 1 });
  await send("Input.setInterceptDrags", { enabled: false });
  await sleep(300);

  const after = await evalJS("[...document.querySelectorAll('#queueBody tr.qrow')].map(r=>r.children[1].textContent+':'+r.children[2].textContent).join(' | ')");
  console.log("after: ", after);

  // is the UI alive? a real click must still do something
  const alive = await evalJS("(()=>{const b=+document.getElementById('qCount').textContent;document.getElementById('qGrey').click();return {before:b,after:+document.getElementById('qCount').textContent}})()");
  console.log("click after drop:", JSON.stringify(alive));
  // does a second drag still start?
  events.length = 0;
  const s2 = await rect(1), d2 = await rect(3);
  await send("Input.setInterceptDrags", { enabled: true });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s2.x, y: s2.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: s2.x, y: s2.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s2.x + 3, y: s2.y + 8, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: d2.x, y: d2.y, button: "left", buttons: 1 });
  await sleep(300);
  console.log("second drag starts:", !!events.find(e => e.method === "Input.dragIntercepted"));
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: d2.x, y: d2.y, button: "left", buttons: 1 });
  await send("Input.setInterceptDrags", { enabled: false });
  console.log("dragFrom stuck? drop marks left?", await evalJS("document.querySelectorAll('#queueBody .drop-above,#queueBody .drop-below,#queueBody .dragging').length"));
  ws.close(); chrome.kill();
})().catch(e => { console.error("ERR", e); process.exit(1); });
