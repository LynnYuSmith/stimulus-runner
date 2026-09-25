"use strict";
/* Starting phases on the real stimulus screen, in a real Chrome over CDP. The shader, not a
   model of it: a grating started at 90° must be bright at the frame's top-left and one started
   at 270° dark there, and a plaid whose second grating starts elsewhere must be a different
   picture from the same plaid at 0. NOT in `npm test` (needs Chrome + serve.py):

     python3 serve.py 8975 --no-browser &
     node test/phase_real_chrome.js http://127.0.0.1:8975/
*/
const { spawn } = require("node:child_process"); const http = require("node:http");
const URL_ = process.argv[2] || "http://127.0.0.1:8975/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; const PORT = 9343;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let b=""; r.on("data",d=>b+=d); r.on("end",()=>res(JSON.parse(b))); }).on("error", rej));
(async () => {
  const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--no-first-run",
    "--user-data-dir=/tmp/phase_chrome_profile","--window-size=900,700","--enable-unsafe-swiftshader",
    "--use-angle=swiftshader","about:blank"], {stdio:"ignore"});
  process.on("exit", () => { try { chrome.kill(); } catch(_){} });
  let t; for (let i=0;i<30;i++){ try { t = await getJSON(`http://127.0.0.1:${PORT}/json`); break; } catch { await sleep(300);} }
  const ws = new WebSocket(t.find(x=>x.type==="page").webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id=0; const pend=new Map(); const errors=[];
  ws.onmessage = m => { const d=JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    else if (d.method==="Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text); };
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
  const ev=async e=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text); return r.result.result.value;};
  const fail=m=>{console.error("  FAIL: "+m); chrome.kill(); process.exit(1);};
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate",{url:URL_+"#stim"}); await sleep(1500);

  /* Present, let the renderer draw a frame, and read the canvas in the SAME animation frame —
     after the renderer's own callback and before the frame is composited, the one moment a
     WebGL canvas without preserveDrawingBuffer can still be read. Frozen so no drift moves it. */
  const show = (tr) => ev(`new Promise(res => {
    R.present(Object.assign({type:'still', orientation:0, sf:0.02, tf:0, contrast:0.5, moving:false,
                             duration:60}, ${JSON.stringify(tr)}));
    if (R.setFrozen) R.setFrozen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const c = document.getElementById('gl'), g = c.getContext('webgl');
      const w = c.width, h = c.height, p = new Uint8Array(w*h*4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, p);
      // the stimulus rect is what is not letterbox-black; its top-left is the frame's origin
      let top = -1, left = -1;
      for (let y = h-1; y >= 0 && top < 0; y--) for (let x = 0; x < w; x++) if (p[(y*w+x)*4] > 8) { top = y; break; }
      for (let x = 0; x < w && left < 0; x++) if (p[(top*w+x)*4] > 8) { left = x; }
      const at = (dx, dy) => p[((top-dy)*w + left+dx)*4];
      let sig = 0; for (let i = 0; i < p.length; i += 4*211) sig = (sig*31 + p[i]) >>> 0;
      res({ corner: at(2, 2), sig, top, left });
    }));
  })`);
  const p90 = await show({ phaseDeg: 90 }), p270 = await show({ phaseDeg: 270 });
  if (!(p90.corner > 150 && p270.corner < 100)) fail(`90° not bright / 270° not dark at the top-left: ${p90.corner} ${p270.corner}`);
  const plaid = { plaid: true, dir2: 90, tf2: 0 };
  const same = await show({ ...plaid, phaseDeg: 0, phase2Deg: 0 });
  const apart = await show({ ...plaid, phaseDeg: 0, phase2Deg: 180 });
  if (same.sig === apart.sig) fail("the second grating's start phase did not change the plaid on screen");
  const again = await show({ ...plaid, phaseDeg: 0, phase2Deg: 0 });
  if (again.sig !== same.sig) fail("the same plaid twice was not the same picture — the check itself is not stable");
  console.log("  top-left at 90°:", p90.corner, "· at 270°:", p270.corner);
  console.log("  plaid, second grating at 0° vs 180°:", same.sig, "vs", apart.sig, "(repeat:", again.sig + ")");
  console.log("  console errors:", errors.length, errors.slice(0, 2));
  chrome.kill(); process.exit(errors.length ? 1 : 0);
})();
