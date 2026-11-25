async () => {
  const mt = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  const settle = async (n) => { for (let i = 0; i < n; i++) { await mt(); D.pump(4); } };
  const D = window.DentSplat;
  if (!D) return { fatal: 'no handle' };

  // The compression card's PSNR is deliberately not a number in a config file: Viewer.bench()
  // renders Full and Pruned into the same offscreen target from the same camera and compares the
  // pixels the browser actually got back. Driving the real button proves the UI path works, and
  // reading the <dd> back is what the audit card shows a reviewer.
  const nodes = (sel) => [...document.querySelectorAll(sel)];
  const dts = () => nodes('dt');
  const readRow = (label) => {
    const dt = dts().find((n) => (n.textContent || '').trim().toLowerCase() === label);
    return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent.trim() : null;
  };
  const benchBtn = () => nodes('button').find((b) => (b.textContent || '').toLowerCase().includes('bench') ||
                                                    (b.textContent || '').includes('回读像素'));
  const labels = () => dts().map((n) => (n.textContent || '').trim());

  await settle(8);
  const btn0 = benchBtn();
  if (!btn0) return { fatal: 'no bench button in the DOM', dtLabels: labels() };
  const before = readRow('live psnr');
  const beforeBusy = btn0.textContent.trim();
  btn0.click();

  // Completion is the button leaving "回读像素中…", not the row changing: the row is the effect, the
  // label is the state machine. A previous draft polled only the row and could not tell "still
  // running" from "never started" -- which is exactly how the double-requestAnimationFrame deadlock
  // in runBench presented itself (a hidden window fires no rAF, so bench() was never called and the
  // button stayed busy forever with no timeout).
  let busy = true, after = before, frames = 0;
  for (let i = 0; i < 200; i++) {
    await settle(2);
    frames += 4;
    const b = benchBtn();
    after = readRow('live psnr');
    busy = !!b && b.textContent !== beforeBusy;
    if (!busy && after && after !== before) break;
  }

  const audit = {};
  for (const key of ['full', 'pruned', 'ratio', 'coverage gap', 'live psnr']) audit[key] = readRow(key);

  // Cross-check: the engine, called directly, must return the same pixels the DOM is showing.
  const direct = typeof D.bench === 'function' ? await D.bench(384) : null;

  return {
    caseId: D.caseId(),
    stats: D.stats(),
    before, after, busyAfter: busy, settleFrames: frames,
    audit,
    direct,
    agrees: !!(direct && after && after.startsWith(String(direct.psnr))),
    dtLabels: labels(),
    settled: !busy && after && after !== before ? 'PSNR changed after clicking bench'
      : busy ? 'button still shows the busy label -- bench() did not complete'
        : 'bench finished but the row never changed',
  };
}
