// Final pre-delivery verification: drives the UI as a user would (real click/pointer events),
// captures evidence PNGs, and dumps a JSON report.
const OUT = 'captures/verify3.json';
const VIEWS = [
  ['1-frontal', [0, 0, -165], [0, 12, 0]],
  ['2-upper-occlusal', [0, 105, -6], [0, 10, 0]],
  ['3-jaw-open', [78, 20, -120], [0, 6, -6]],
  ['4-section-cap', [0, 8, -150], [0, 12, 0]],
  ['5-ian-xray', [-92, -22, -78], [-18, -6, -12]],
];
const out = { at: new Date().toISOString(), diag: {}, caps: {}, errors: [] };

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pointer(el, type, x, y) {
  el.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, bubbles: true,
    clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'mouse' }));
}
function clickText(txt) {
  const els = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes(txt));
  if (els.length) els[0].click();
  return els.length;
}
function tap(clientX, clientY) {
  const cn = document.querySelector('canvas');
  const r = cn.getBoundingClientRect();
  const x = r.left + clientX, y = r.top + clientY;
  pointer(cn, 'pointerdown', x, y); pointer(cn, 'pointerup', x, y);
  cn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
}
function setRange(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function project(view, target) {
  const c = window.__dentsplat, cam = c.viewer.camera;
  const p = c.THREE.MathUtils.degToRad(view[0]), a = c.THREE.MathUtils.degToRad(view[1]);
  const cp = Math.cos(a) * Math.cos(p), sp = Math.sin(a) * Math.cos(p), sq = Math.sin(p);
  const t = target ?? [0, 8, 0];
  cam.position.set(t[0] + cp * view[2], t[1] + sp * view[2], t[2] + sq * view[2]);
  cam.lookAt(t[0], t[1], t[2]); cam.updateMatrixWorld();
  c.viewer.controls.target.set(t[0], t[1], t[2]);
  c.viewer.controls.update(); c.renderNow();
  const cn = document.querySelector('canvas');
  const r = cn.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  const map = {};
  for (const [id, mm] of Object.entries(c.teeth)) {
    const v = new c.THREE.Vector3(mm.at[0], mm.at[1], mm.at[2]).project(cam);
    map[id] = [Math.round(((v.x + 1) / 2) * w), Math.round(((1 - v.y) / 2) * h),
      Math.abs(v.z) < 1 ? 1 : 0, +mm.dist.toFixed(2)];
  }
  return { w, h, teeth: map };
}

const c = await (async () => {
  for (let i = 0; i < 100; i++) {
    const x = window.__dentsplat;
    if (x && x.layer && x.layer.n > 1000) return x;
    await wait(500);
  }
  return null;
})();
if (!c) { out.fatal = 'viewer never booted'; return out; }

const gl = c.gl2;
out.diag.swRegistered = !!(await navigator.serviceWorker.getRegistration());
out.diag.splats = c.layer.n;
out.diag.bytes = c.layer.bytes;
out.diag.units = c.layer.dspk.unitsPerNode === 1 ? 'mm' : 'unknown';
out.diag.caseId = c.viewer.caseId;
out.diag.renderer = gl.getParameter(gl.RENDERER);
out.diag.webgl2 = !!gl.fenceSync;
out.diag.hasEXT = !!gl.getExtension('EXT_texture_filter_anisotropic');

// --- 1. 2D odontogram -> 3D highlight (real clicks on the odontogram cells) ---
for (const fdi of ['26', '11', '48']) {
  const btn = document.querySelector(`[data-fdi="${fdi}"]`);
  if (!btn) { out.diag['odo_' + fdi] = 'cell missing'; continue; }
  btn.click();
  await wait(260);
  out.diag['sel_after_click_' + fdi] = {
    uniform: c.layer.u.uSelectedTooth.value,
    highlightedCell: document.querySelector('.odo-cell.is-sel')?.getAttribute('data-fdi') ?? null,
    camRadius: +c.viewer.camera.position.length().toFixed(1),
  };
}

// --- 2. 3D tap -> odontogram selection (picking through the invisible proxy mesh) ---
const camA = project([0, 0, -165], [0, 12, 0]);
const t11 = camA.teeth.FDI_11, t21 = camA.teeth.FDI_21;
out.diag.tapPixels = { fdi11: t11, fdi21: t21, canvas: [camA.w, camA.h] };
document.querySelector('[data-fdi="26"]')?.click(); await wait(200);
tap(t11[0], t11[1]);
await wait(300);
out.diag.tap_pick_result = {
  selectedUniform: c.layer.u.uSelectedTooth.value,
  odoHighlight: document.querySelector('.odo-cell.is-sel')?.getAttribute('data-fdi') ?? null,
};

// --- 3. mm measurement via two taps, checked against the dataset's own geometry ---
clickText('mm 测量'); clickText('进入测量');
await wait(200);
out.diag.measureMode = c.viewer.measureMode;
const truth = (function () {
  const a = c.teeth.FDI_11.at, b = c.teeth.FDI_21.at;
  return +Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(2);
})();
tap(t11[0], t11[1]); await wait(350); tap(t21[0], t21[1]); await wait(450);
out.diag.measure = {
  pointsPlaced: c.viewer.measure.points.length,
  centroidTruthMM: truth,
  lines: c.scene ? (function () {
    let n = 0; c.viewer.scene.traverse((o) => { if (o.type === 'Line') n++; });
    return n;
  })() : null,
  chips: [...document.querySelectorAll('.m')].map((n) =>
    (n.textContent || '').replace(/\s+/g, ' ').trim()),
};

// --- 4. jaw slider drives the shader hinge (real input event) ---
const sliders = [...document.querySelectorAll('input[type=range]')];
out.diag.ranges = sliders.map((s) => ({ id: s.id || s.getAttribute('aria-label') || '',
  min: s.min, max: s.max, value: s.value }));
const jawSlider = sliders.find((s) => +s.max >= 30 && +s.max <= 60) ?? sliders[1];
out.diag.jawBefore = +c.layer.u.uJawOpen.value.toFixed(3);
if (jawSlider) { setRange(jawSlider, Math.min(+jawSlider.max, 38)); await wait(500); }
out.diag.jawAfter = +c.layer.u.uJawOpen.value.toFixed(3);
out.diag.jawSliderValue = jawSlider ? jawSlider.value : null;
if (jawSlider) { setRange(jawSlider, 0); await wait(350); }
out.diag.jawReset = +c.layer.u.uJawOpen.value.toFixed(3);

// --- 5. captures (renderToDataURL works in a hidden 0x0 viewport, rAF does not) ---
for (const [name, view, target] of VIEWS) {
  if (name === '5-ian-xray') {
    out.diag.caseBSwitch = clickText('Case B');
    await wait(2500);
    clickText('神经管透照');
    await wait(1000);
  }
  if (name === '4-section-cap') {
    c.layer.u.uClipEnabled.value = 1; c.layer.u.uClipBand.value = 3.2; c.renderNow();
  }
  project(view, target);
  await wait(1000);
  const data = await c.viewer.renderToDataURL(1280, 800);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  out.caps[name] = { b64len: data.length,
    sha: [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16),
    data };
}

// --- 6. HUD exactly as the user sees it, after all interaction ---
out.diag.caseAfter = c.viewer.caseId;
out.diag.splatsAfter = c.layer.n;
out.diag.bytesAfter = c.layer.bytes;
out.diag.glErrorAfter = gl.getError();
out.diag.hud = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200);
return out;
