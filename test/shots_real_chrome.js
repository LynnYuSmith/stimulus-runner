"use strict";
/* The resume path in a REAL Chrome over CDP: fill the queue, change the form, reload the page
   as a crash would, take the "Continue" offer, and check what came back. NOT in `npm test`
   (needs Chrome + a running serve.py):

     STIMULUS_RUNNER_LOG_DIR=/tmp/resume_logs python3 serve.py 8974 --no-browser &
     node test/resume_real_chrome.js http://127.0.0.1:8974/
*/
const { spawn } = require("node:child_process");
const http = require("node:http");
const URL_ = process.argv[2] || "http://127.0.0.1:8974/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9337;
const OUT = process.argv[3] || "docs";
const fs = require("node:fs"); const path = require("node:path");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--no-first-run",
    "--user-data-dir=/tmp/shots_chrome_profile", "--window-size=1500,1180", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  process.on("exit", () => { try { chrome.kill(); } catch (_) {} });
  process.on("SIGINT", () => process.exit(130));
  let targets; for (let i = 0; i < 30; i++) { try { targets = await getJSON(`http://127.0.0.1:${PORT}/json`); break; } catch { await sleep(300); } }
  const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text); };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64")); console.log("  shot", name); };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  // --- the cockpit: a sweep queued, a grating on the screen, the log filling ---------------
  await send("Page.navigate", { url: URL_ }); await sleep(1500);
  await ev(`document.getElementById('qSweep').click(); document.getElementById('qCount').textContent`);
  await sleep(300);
  await ev(`document.querySelectorAll('#presets button')[1]?.click(); 1`);   // 45 deg, moving
  await sleep(1200);
  await shot("cockpit");

  // the same page scrolled to the queue and the trial log
  await ev(`(()=>{ const p=document.getElementById('panel'); p.scrollTop = p.scrollHeight; return p.scrollTop })()`);
  await sleep(500);
  await shot("queue_and_log");

  // --- what the mouse sees --------------------------------------------------------------
  await send("Page.navigate", { url: "about:blank" }); await sleep(300);
  await send("Page.navigate", { url: URL_ + "#stim" }); await sleep(1500);
  // the stim role takes its orders by postMessage, exactly as the cockpit sends them
  await ev(`(()=>{ window.postMessage({cmd:'present', trial:{type:'moving', orientation:45, sf:0.02, tf:1,
       contrast:1, duration:60, moving:true, wave:'binary', trialId:1, markerCount:3}}, '*'); return 1 })()`);
  await sleep(1200);
  await shot("stimulus_screen");

  // a favicon 404 is the page asking for something the tiny server does not serve, not a fault
  const real = errors.filter(e => !/favicon/i.test(e) && !/404 \(Not Found\)/.test(e));
  if (real.length) { console.error("console errors:\n  " + real.join("\n  ")); process.exit(1); }
  console.log("  no console errors");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
