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
const PORT = 9334;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));

(async () => {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--no-first-run",
    "--user-data-dir=/tmp/resume_chrome_profile", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  // Whatever way this process ends -- success, fail(), an evaluate that threw, ctrl-c -- the
  // Chrome it started ends with it. Twelve orphaned headless Chromes were found on the
  // machine on 2026-09-19, one per script run that had exited through fail().
  process.on("exit", () => { try { chrome.kill(); } catch (_) {} });
  process.on("SIGINT", () => process.exit(130));
  let targets; for (let i = 0; i < 30; i++) { try { targets = await getJSON(`http://127.0.0.1:${PORT}/json`); break; } catch { await sleep(300); } }
  const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : r; };
  const fail = (m) => { console.error("  FAIL: " + m); chrome.kill(); process.exit(1); };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: URL_ }); await sleep(1200);

  // 1. a session: sweep + a form change + move the queue
  await ev("document.getElementById('qSweep').click(); const o=document.getElementById('ori'); o.value='135'; o.dispatchEvent(new Event('input')); 'ok'");
  await ev("document.getElementById('toBlack').click(); 'ok'");   // one epoch before the crash, so the log exists
  await ev("document.querySelector('#queueBody .qmove[data-d=\"1\"]').click(); 'ok'");
  await sleep(900);                       // past the 400 ms debounce + the PUT
  const sid = await ev("document.getElementById('logSaveState').textContent");
  console.log("  badge:", sid);
  const latest = await getJSON(URL_ + "api/session");
  if (!latest.session) fail("nothing was saved to the server");
  console.log("  saved session:", latest.session, "queue:", latest.state.queue.length, "ori:", latest.state.form.ori);
  if (latest.state.queue.length !== 15 || latest.state.form.ori !== "135") fail("saved state is wrong");
  if (latest.state.queue[0].type !== "grey") fail("the ▼ move was not in the saved queue");

  // 2. the crash: navigate away and back
  await send("Page.navigate", { url: "about:blank" }); await sleep(300);
  await send("Page.navigate", { url: URL_ }); await sleep(1200);
  const shown = await ev("document.getElementById('resume').classList.contains('show')");
  const text = await ev("document.getElementById('resumeText').textContent");
  console.log("  banner:", shown, "—", text);
  if (!shown) fail("no resume banner after reload");

  // 3. yes
  await ev("document.getElementById('resumeYes').click(); 'ok'"); await sleep(300);
  const after = await ev("JSON.stringify({q: document.querySelectorAll('#queueBody tr.qrow').length, ori: document.getElementById('ori').value, run: document.getElementById('qRun').textContent, first: document.querySelector('#queueBody tr.qrow td:nth-child(2)').textContent, badge: document.getElementById('logSaveState').textContent})");
  console.log("  after yes:", after);
  const a = JSON.parse(after);
  if (a.q !== 15 || a.ori !== "135" || a.first !== "grey") fail("resume did not restore the queue and form");
  if (!/Run queue/.test(a.run)) fail("the queue came back running");
  // 4. and a new epoch goes into the SAME stimlog (queueing a block is not an epoch; SHOWING one is)
  await ev("document.getElementById('toBlack').click(); 'ok'"); await sleep(900);
  const logs = await getJSON(URL_ + "api/stimlog");
  console.log("  stimlog sessions:", logs.sessions.map(s => s.id + ":" + s.rows).join(", "));
  if (logs.sessions.length !== 1 || logs.sessions[0].id !== latest.session || logs.sessions[0].rows < 2)
    fail("the log did not continue in the same file");
  console.log("\n  resume path OK in real Chrome");
  ws.close(); chrome.kill();
})().catch(e => { console.error("ERR", e); process.exit(1); });
