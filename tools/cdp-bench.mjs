/**
 * tools/cdp-bench.mjs — run Viewer.bench() in a real (headless) browser and print the JSON.
 *
 * The in-app debug evaluator refuses calls it cannot prove side-effect free, and the bench writes
 * pixels, so it is driven over the Chrome DevTools Protocol instead: launch Edge headless with a
 * throw-away profile, evaluate window.DentSplat.bench(384) with awaitPromise, and print the result.
 *
 *   node tools/cdp-bench.mjs --url http://localhost:5178/#B --out tools/out/bench-B-dentvoxel.json
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5178/#B');
const OUT = arg('--out', null);
const PORT = Number(arg('--port', 9333));
const EDGE = arg('--edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const profile = mkdtempSync(join(tmpdir(), 'dentsplat-cdp-'));

const child = spawn(EDGE, [
  '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--window-size=1440,900', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no debuggable page appeared');
}

let ws;
try {
  const page = await targets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const my = ++id;
    pending.set(my, res);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await send('Runtime.enable');
  await sleep(4000);
  const expression = `(async () => {
    const D = window.DentSplat;
    if (!D) return { fatal: 'no DentSplat handle' };
    const t0 = performance.now();
    const bench = await D.bench(384);
    return { caseId: D.caseId(), stats: D.stats(), ms: Math.round(performance.now() - t0), bench };
  })()`;
  const res = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  });
  const value = res.result?.result?.value ?? null;
  const out = {
    bundle: 'local dist build',
    job: 'bench',
    url: URL_,
    ua: (await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }))
      .result?.result?.value ?? null,
    res: value,
    exception: res.result?.exceptionDetails ?? null,
  };
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
} finally {
  try { ws?.close(); } catch {}
  child.kill();
}
