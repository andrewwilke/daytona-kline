'use strict';

// The page: drawing and DOM code. The logic that has no DOM lives in small modules loaded before this file
// (see index.html), each a plain script that sets a global and also works with require() in Node:
//   GraphStore   (graphstore.js)  the points the graphs, the vitals and the fuel map are drawn from
//   FuelMap      (fuelmap.js)     the fuel map's cells, derived metrics and crosshair position
//   SessionState (session.js)     what should be running, decided from what the server says (GET /api/runs)
// The page keeps no flags about who may use the K-line: the server's run coordinator decides that, and the
// page asks it (`syncRuns`) and follows. Starting what runs by itself is that explicit step, never a side
// effect of drawing something.

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'request failed');
  return j;
};
const msg = (text, isErr) => {
  $('msg').textContent = text || '';
  $('msg').style.color = isErr ? 'var(--err)' : 'var(--warn)';
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let connected = false;
let livePoll = null;
let liveActive = false;
let probePoll = null;
let statusPoll = null;
let unlockState = 'unavailable';
let unlockReason = null;

// The dashboard and the switch watcher run by themselves once connected (the switch watcher once the ECU is
// unlocked): tip-over, sidestand, clutch and the dash flags only matter when they change, and a brief change
// is easy to miss otherwise. A recording or an id scan pauses them (one run at a time on the K-line, decided
// by the server) and they come back after it. Stop turns one off until the next connection (the server
// remembers it). The page only polls what the server runs: `session` asks GET /api/runs, plans from the
// facts and does the actions; this file supplies the timers it attaches and detaches.
const session = SessionState.createController({
  api,
  ui: {
    polling: (feature) => (feature === 'dashboard' ? gaugePoll !== null : swTimer !== null),
    setPolling: (feature, on) => (feature === 'dashboard' ? setGaugePolling(on) : setSwitchPolling(on)),
  },
});
const sessionFacts = () => ({ connected, unlock: unlockState });

/** The reconcile step: ask the server what is running, start what should be, attach the polls. Safe to call at any time. */
const syncRuns = () => session.sync(sessionFacts()).catch(() => { /* server hiccup: the status poll tries again */ });

/** The owner's button for the dashboard or the switch watcher: Stop if the page shows it running, else Start. */
async function toggleFeature(feature) {
  try {
    const r = await session.toggle(feature, sessionFacts());
    if (r.paused || r.unavailable) msg(r.note, !!r.unavailable);
  } catch (e) { msg(e.message, true); }
}

const UNLOCK_TEXT = {
  unavailable: (r) => (/^no unlock file/.test(r || '') || !r ? 'Unlock off (no unlock.json)' : `Unlock off (${r})`),
  invalid: (r) => `Unlock file unusable: ${r}`,
  locked: () => 'ECU locked',
  unlocking: () => 'Unlocking…',
  unlocked: () => 'ECU unlocked',
  failed: (r) => `Unlock failed: ${r}`,
};

// The unlock indicator, the Try unlock button (only from locked or failed, never pressed by the page) and
// the panels that need the unlock; all of it follows the server's status. It only draws: nothing starts here.
function renderUnlock() {
  const info = $('unlockInfo');
  info.style.display = connected ? '' : 'none';
  info.textContent = (UNLOCK_TEXT[unlockState] || (() => unlockState))(unlockReason);
  info.className = 'unlock' + (unlockState === 'unlocked' ? ' ok' : unlockState === 'failed' || unlockState === 'invalid' ? ' bad' : '');
  $('btnUnlock').style.display = connected && (unlockState === 'locked' || unlockState === 'failed') ? '' : 'none';
  const open = connected && unlockState === 'unlocked';
  for (const panel of document.querySelectorAll('[data-needs-unlock]')) {
    panel.classList.toggle('locked', !open);
    for (const el of panel.querySelectorAll('button, input')) el.disabled = !open;
  }
  snapButtons();
  outButtons();
}

// The unlock state changed (or was learned): draw it, refresh the dials once, and reconcile (the switch watcher starts once unlocked).
function showUnlock(state, reason) {
  const changed = state !== unlockState;
  unlockState = state ?? 'unavailable';
  unlockReason = reason ?? null;
  renderUnlock();
  if (changed) {
    if (gaugePoll === null) pollGauges();
    syncRuns();
  }
}

async function refreshPorts() {
  try {
    const { ports } = await api('GET', '/api/ports');
    const sel = $('ports');
    sel.innerHTML = '';
    for (const p of ports) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = `${p.path} ${p.manufacturer || ''}`;
      if (/ftdi/i.test(p.manufacturer || '')) o.selected = true;
      sel.appendChild(o);
    }
    portsFound = ports.length > 0;
    if (!ports.length) sel.innerHTML = '<option>no cable found</option>';
    $('portHint').style.display = ports.length ? 'none' : '';
  } catch (e) { msg(e.message, true); }
}
let portsFound = false;
setInterval(() => { if (!connected && !portsFound) refreshPorts(); }, 3000); // plug the cable in and it shows up

// Everything the page started on a timer; all of it dies with the session.
function stopAllUi() {
  stopLiveUi();
  stopGaugesUi();
  stopSwitchesUi();
  clearInterval(probePoll);
  probePoll = null;
}

// While connected, watch the server's view of the session so a lost ECU shows up, and reconcile what runs.
async function checkStatus() {
  try {
    const s = await api('GET', '/api/status');
    showUnlock(s.unlock, s.unlockReason);
    if (s.connected) { await syncRuns(); return; }
    stopAllUi();
    setConnected(false);
    msg(s.error || 'Disconnected.', true);
  } catch { /* server hiccup: try again next tick */ }
}

function describeProgress(p) {
  if (!p) return '';
  const what = p.attempt?.text ?? '';
  if (p.step === 'opening') return `Opening ${p.port}…`;
  if (p.step === 'attempt') return `Trying ${p.attempt.saved ? 'saved wake-up: ' : ''}${what}…`;
  if (p.step === 'attempt-failed') return `No answer to ${what}${p.attempt.try < p.attempt.tries ? ', trying again' : ', trying the next one'}…`;
  if (p.step === 'first-request') return 'ECU answered, checking the first request…';
  if (p.step === 'diag-session') return 'ECU answered, starting diagnostic session…';
  return '';
}

// Only draws the connection state. Starting the dashboard and the watcher is `syncRuns`, which the callers
// run once they know the unlock state; a disconnect syncs here so every poll is detached and the next
// connection starts from the server's fresh list.
function setConnected(on, info) {
  connected = on;
  clearInterval(statusPoll);
  statusPoll = on ? setInterval(checkStatus, 2000) : null;
  $('dot').classList.toggle('on', on);
  $('startCard').style.display = on ? 'none' : '';
  $('btnConnect').style.display = on ? 'none' : '';
  $('btnDisconnect').style.display = on ? '' : 'none';
  $('connInfo').textContent = info || '';
  renderUnlock();
  if (!on) syncRuns();
}

$('btnConnect').onclick = async () => {
  msg('Connecting — the ECU answers a slow init only about one try in three, this can take up to a minute…');
  $('btnConnect').disabled = true;
  const progressPoll = setInterval(async () => {
    try { msg(describeProgress((await api('GET', '/api/status')).progress) || 'Connecting…'); } catch {}
  }, 500);
  try {
    const r = await api('POST', '/api/connect', { port: $('ports').value });
    setConnected(true, `ECU @ ${r.target} (${r.kind === 'slow' ? 'slow init' : 'fast init'}), keys ${r.keyBytes}`);
    msg('');
    await refreshUnlock(); // connect, learn the unlock state, then ask what is running and reconcile
    await syncRuns();
  } catch (e) { msg(e.message, true); }
  clearInterval(progressPoll);
  $('btnConnect').disabled = false;
};

async function refreshUnlock() {
  try {
    const s = await api('GET', '/api/status');
    showUnlock(s.unlock, s.unlockReason);
  } catch { /* the status poll shows it next time */ }
}

// One click, one attempt: the server sends one seed request and at most one key.
$('btnUnlock').onclick = async () => {
  $('btnUnlock').disabled = true;
  msg('Unlocking…');
  try {
    const r = await api('POST', '/api/unlock');
    showUnlock(r.unlock, r.unlockReason);
    msg('');
  } catch (e) { msg(e.message, true); }
  $('btnUnlock').disabled = false;
  await refreshUnlock();
};
$('btnDisconnect').onclick = async () => {
  stopAllUi();
  try { await api('POST', '/api/disconnect'); } catch (e) { msg(e.message, true); }
  setConnected(false);
};

function showMil(status) {
  const el = $('mil');
  el.className = 'mil' + (status ? (status.milOn ? ' on' : ' off') : '');
  $('milText').textContent = !status ? 'Warning light: not reported by the ECU'
    : `Warning light ${status.milOn ? 'ON' : 'off'} · ${status.dtcCount} stored code${status.dtcCount === 1 ? '' : 's'} reported`;
}

$('btnDtc').onclick = async () => {
  msg('');
  try {
    const r = await api('GET', '/api/dtc');
    showMil(r.status);
    const note = `<div class="status">${r.summary}${r.pendingSupported === false ? ' Pending codes (mode 07) are not supported by this ECU.' : ''}</div>`;
    if (!r.count) {
      $('dtcOut').innerHTML = '<span class="good">No stored fault codes.</span> If the bike is still cutting fuel with zero codes, start the Dashboard and catch it in the act.' + note;
      return;
    }
    $('dtcOut').innerHTML = note + r.dtcs.map((d) =>
      `<div class="dtc"><span>${d.code}</span><span class="desc">${d.description || ''} · ${d.status}${d.statusByte == null ? '' : ' 0x' + d.statusByte.toString(16).padStart(2, '0')}</span></div>`
    ).join('');
  } catch (e) { msg(e.message, true); }
};

$('btnClear').onclick = async () => {
  if (!confirm('Erase all stored fault codes from the ECU? Read and note them first.')) return;
  try { await api('POST', '/api/cleardtc'); $('dtcOut').textContent = 'Codes cleared.'; showMil(null); $('milText').textContent = 'Warning light: read the codes again to check'; }
  catch (e) { msg(e.message, true); }
};

$('btnId').onclick = async () => {
  try {
    const { results, locked, note } = await api('GET', '/api/id');
    if (locked) { msg(note, true); return; }
    $('ecuOut').style.display = '';
    $('ecuOut').textContent = results.length
      ? results.map((r) => `option 0x${r.option.toString(16)}: ${r.ascii}\n  ${r.hex}`).join('\n')
      : 'This ECU gave no identification.';
  } catch (e) { msg(e.message, true); }
};

$('btnProbe').onclick = async () => {
  try {
    const started = await api('POST', '/api/probe', {});
    if (started.locked) { msg(started.note, true); return; }
    clearInterval(probePoll);
    probePoll = setInterval(async () => {
      let s;
      try { s = await api('GET', '/api/status'); } catch { return; }
      const p = s.probe;
      if (!p) return;
      if (p.unavailable) $('probeInfo').textContent = 'stopped early';
      else $('probeInfo').textContent = p.running
        ? `probing 0x${p.current.toString(16).padStart(2,'0')}… found ${p.found?.length ?? 0}`
        : `done — ${p.found.length} block(s)` + (p.biggest != null ? `, sensor block = 0x${p.biggest.toString(16)}` : '');
      if (!p.running) {
        clearInterval(probePoll);
        probePoll = null;
        if (p.found.length) {
          $('ecuOut').style.display = '';
          $('ecuOut').textContent = p.found.map((f) => `id 0x${f.id.toString(16).padStart(2,'0')}  ${f.length} bytes: ${f.hex}`).join('\n');
        }
        if (p.unavailable) msg('Sensor block probe ' + p.unavailable, true);
        else if (p.error) msg(p.error, true);
      }
    }, 500);
  } catch (e) { msg(e.message, true); }
};

function stopLiveUi() {
  liveActive = false;
  clearInterval(livePoll);
  livePoll = null;
  $('btnLive').textContent = 'Start';
  $('btnLive').classList.add('primary');
}

$('btnLive').onclick = async () => {
  if (liveActive) {
    await api('POST', '/api/live/stop');
    stopLiveUi();
    return;
  }
  try {
    const started = await api('POST', '/api/live/start', { log: $('chkLog').checked });
    if (started.locked) { msg(started.note, true); return; }
    liveActive = true;
    $('btnLive').textContent = 'Stop';
    $('btnLive').classList.remove('primary');
    livePoll = setInterval(renderLive, 250);
  } catch (e) { msg(e.message, true); }
};

$('btnReset').onclick = () => api('POST', '/api/live/reset').catch(() => {});

async function renderLive() {
  try {
    const r = await api('GET', '/api/live/latest');
    if (!r.active && r.error) { stopLiveUi(); msg(r.error, true); return; }
    if (r.active && !r.raw && r.errors) $('liveInfo').textContent = `${r.errors} errors (${r.lastError})`;
    if (!r.active || !r.raw) return;
    $('liveInfo').textContent =
      `block 0x${r.id.toString(16)} · ${r.samples} samples` +
      (r.errors ? ` · ${r.errors} errors (${r.lastError})` : '') +
      (r.csvPath ? ` · recording → ${r.csvPath.split(/[\\/]/).pop()}` : '');
    $('tiles').innerHTML = r.fields.map((f) =>
      `<div class="tile ${f.verified ? '' : 'unv'}"><div class="n">${f.name}</div><div class="v">${f.value}<span class="u"> ${f.unit}</span></div></div>`
    ).join('');
    let out = '';
    const changed = [];
    for (let i = 0; i < r.raw.length; i++) {
      if (i % 16 === 0) out += `<span class="off">${String(i).padStart(3,' ')}:</span> `;
      const chg = r.min[i] !== r.max[i];
      if (chg) changed.push(`[${i}] ${r.min[i]}–${r.max[i]}`);
      out += `<span class="${chg ? 'chg' : ''}">${r.raw[i].toString(16).padStart(2,'0')}</span>`;
      out += (i + 1) % 16 === 0 ? '<br>' : ' ';
    }
    $('hexgrid').innerHTML = out;
    $('changing').textContent = changed.length ? 'changing: ' + changed.join('  ') : '';
  } catch { /* transient */ }
}

// ---- Graphs -------------------------------------------------------------
// Strip charts of the fuel and engine channels. The points are kept by the graph store: live ones come from
// the dashboard run and from the recorder (each poll asks only for what is newer than the last point it got);
// a saved recording opens as the same lanes. Times are kept as ms on this page's clock: run time + the moment
// the run started. This file draws them.
const graphs = GraphStore.create();
const GAP_MS = 4000; // further apart than this and no line is drawn across (a recording pause, a silent ECU)
const LANES = [
  { group: 'Fuel', title: 'Injection pulse', keys: ['injPulse1', 'injPulse2', 'injPulse3'], unit: 'ms' },
  { title: 'Short-term fuel trim', keys: ['trim'], unit: '%', zero: true },
  { title: 'Fuel pump', keys: ['fuelPump'], flag: true, onText: 'ON', offText: 'OFF' },
  { title: 'Manifold pressure', keys: ['map'], unit: 'hPa' },
  { title: 'Engine load', keys: ['load'], unit: '%' },
  { group: 'Engine', title: 'Engine speed', keys: ['rpmId', 'rpm'], unit: 'rpm', first: true },
  { title: 'Throttle', keys: ['tps'], unit: '%' },
  { title: 'Battery', keys: ['battery'], unit: 'V' },
  { title: 'Tip-over sensor', keys: ['tipOver'], flag: true, onText: 'NOT TRIPPED', offText: 'TRIPPED', badOff: true },
  { title: 'Start switch', keys: ['startSwitch'], flag: true, onText: 'PRESSED', offText: 'RELEASED' },
];
const graph = {
  paused: false,
  hoverT: null,
  lanes: [],
};

/** What a poll of the dashboard or the recorder brought: into the store, and into the live fuel map. */
function feedGraph(source, series, elapsedMs) {
  if (graphs.ingest(source, series, elapsedMs)) ingestLive();
}

function buildLanes() {
  const box = $('grLanes');
  box.innerHTML = '';
  graph.lanes = LANES.map((lane) => {
    if (lane.group) {
      const h = document.createElement('div');
      h.className = 'grgroup';
      h.textContent = lane.group;
      box.appendChild(h);
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'grlane';
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const view = graphView();
      graph.hoverT = view ? view.t0 + (e.clientX - r.left) / r.width * (view.t1 - view.t0) : null;
      drawGraphs();
    });
    canvas.addEventListener('mouseleave', () => { graph.hoverT = null; drawGraphs(); });
    box.appendChild(canvas);
    return { ...lane, canvas };
  });
}

/** The time range on show, { t0, t1 } in page-clock ms: following now, or (paused / a saved recording) placed by the slider. */
const graphView = () => graphs.view({ windowMs: Number($('grWindow').value), paused: graph.paused, scrub: Number($('grScrub').value) });

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const LINE_COLORS = ['--accent', '--warn', '--ok'];

function drawLane(lane, view, marks) {
  const c = lane.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = lane.flag ? 44 : 78;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = css('--panel2');
  g.fillRect(0, 0, w, h);
  const items = graphs.laneSeries(lane);
  const dim = css('--dim'), text = css('--text'), err = css('--err');
  const x = (t) => (t - view.t0) / (view.t1 - view.t0) * w;
  const top = 16;
  let lo = Infinity, hi = -Infinity;
  if (lane.flag) {
    lo = 0; hi = 1;
  } else {
    for (const it of items) for (const [t, v] of it.pts) if (t >= view.t0 - GAP_MS && t <= view.t1) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (lane.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    const m = (hi - lo) * 0.1;
    lo -= m; hi += m;
  }
  const y = (v) => h - 4 - (v - lo) / (hi - lo) * (h - 4 - top);
  g.lineWidth = 1;
  for (const m of marks) {
    if (m.t < view.t0 || m.t > view.t1) continue;
    g.strokeStyle = m.kind === 'mk' ? css('--warn') : err;
    g.globalAlpha = 0.55;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x(m.t), 0); g.lineTo(x(m.t), h); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
  if (lane.zero && lo < 0 && hi > 0) {
    g.strokeStyle = dim; g.globalAlpha = 0.4;
    g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke();
    g.globalAlpha = 1;
  }
  items.forEach((it, i) => {
    const color = css(LINE_COLORS[i % LINE_COLORS.length]);
    g.lineWidth = 1.6;
    if (lane.flag) {
      // A step line; the pump / switch being on is shaded, the tip-over sensor being tripped is shaded red.
      const pts = it.pts.filter(([t]) => t <= view.t1);
      for (let k = 0; k < pts.length; k++) {
        const [t, v] = pts[k];
        const next = k + 1 < pts.length ? pts[k + 1][0] : view.t1;
        const end = Math.min(next, t + GAP_MS);
        if (end < view.t0) continue;
        const xa = Math.max(0, x(t)), xb = Math.min(w, x(end));
        const bad = lane.badOff && v === 0;
        g.strokeStyle = bad ? err : color;
        g.fillStyle = bad ? err : color;
        if (v || bad) {
          g.globalAlpha = bad ? 0.5 : 0.25;
          g.fillRect(xa, top, Math.max(1, xb - xa), h - 4 - top);
          g.globalAlpha = 1;
        }
        g.beginPath();
        if (k > 0 && pts[k - 1][1] !== v && t - pts[k - 1][0] <= GAP_MS) { g.moveTo(xa, y(pts[k - 1][1])); g.lineTo(xa, y(v)); }
        g.moveTo(xa, y(v)); g.lineTo(Math.max(xa + 1, xb), y(v));
        g.stroke();
      }
    } else {
      g.strokeStyle = color;
      g.beginPath();
      let pen = false, lastT = -Infinity;
      for (const [t, v] of it.pts) {
        if (t < view.t0 - 20000 || t > view.t1) continue;
        if (t - lastT > GAP_MS) pen = false;
        if (pen) g.lineTo(x(t), y(v)); else { g.moveTo(x(t), y(v)); pen = true; }
        lastT = t;
      }
      g.stroke();
    }
  });
  // The title, the range, and the value under the pointer (or the newest one).
  const title = lane.title + (lane.unit ? ` (${lane.unit})` : '');
  g.textBaseline = 'top';
  g.font = '12px system-ui, sans-serif';
  g.fillStyle = dim;
  g.textAlign = 'left';
  g.fillText(title, 8, 3);
  const titleWidth = g.measureText(title).width;
  if (!lane.flag) {
    const digits = hi - lo < 5 ? 2 : 0;
    g.textAlign = 'right';
    g.fillText(hi.toFixed(digits), w - 6, 3);
    g.textBaseline = 'bottom';
    g.fillText(lo.toFixed(digits), w - 6, h - 2);
    g.textAlign = 'left';
    g.textBaseline = 'top';
  }
  const at = graph.hoverT ?? view.t1;
  const readout = items.map((it) => {
    const p = GraphStore.valueAt(it.pts, at);
    if (!p) return null;
    if (lane.flag) return p[1] ? lane.onText : lane.offText;
    return `${it.key.startsWith('inj') ? 'cyl ' + it.key.slice(-1) + ' ' : ''}${p[1].toFixed(Math.abs(p[1]) < 100 ? 2 : 0)}`;
  }).filter(Boolean).join('   ');
  g.fillStyle = text;
  g.font = '600 13px system-ui, sans-serif';
  g.fillText(items.length ? readout : 'no data yet', 8 + titleWidth + 14, 2);
  if (graph.hoverT != null) {
    g.strokeStyle = text; g.globalAlpha = 0.5; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x(graph.hoverT), 0); g.lineTo(x(graph.hoverT), h); g.stroke();
    g.globalAlpha = 1;
  }
}

function drawGraphs() {
  if (!graph.lanes.length || !$('graphPanel').offsetParent) return;
  const view = graphView() ?? { t0: Date.now() - 60000, t1: Date.now() };
  const marks = graphs.source().marks;
  for (const lane of graph.lanes) drawLane(lane, view, marks);
  $('grScrub').style.display = graphs.replay || graph.paused ? '' : 'none';
  drawFuelMap();
}

$('btnGrPause').onclick = () => {
  graph.paused = !graph.paused;
  $('btnGrPause').textContent = graph.paused ? 'Resume' : 'Pause';
  if (graph.paused) $('grScrub').value = 1000;
  drawGraphs();
};
$('grWindow').onchange = drawGraphs;
$('grScrub').oninput = drawGraphs;

$('btnGrPng').onclick = () => {
  drawGraphs();
  const lanes = graph.lanes.map((l) => l.canvas);
  const out = document.createElement('canvas');
  out.width = Math.max(...lanes.map((c) => c.width));
  out.height = lanes.reduce((n, c) => n + c.height, 0);
  const g = out.getContext('2d');
  g.fillStyle = css('--panel');
  g.fillRect(0, 0, out.width, out.height);
  let yy = 0;
  for (const c of lanes) { g.drawImage(c, 0, yy); yy += c.height; }
  const a = document.createElement('a');
  a.download = `graphs-${graphs.replay ? graphs.replay.name.replace(/\.csv$/, '') : new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
};

async function refreshGraphFiles() {
  try {
    const { recordings } = await api('GET', '/api/recordings');
    const sel = $('grFiles'), keep = sel.value;
    sel.innerHTML = '<option value="">Saved recordings…</option>' +
      recordings.map((r) => `<option value="${esc(r.name)}">${esc(r.name.replace(/^record-|\.csv$/g, ''))} (${Math.round(r.bytes / 1024)} kB)</option>`).join('');
    sel.value = keep;
  } catch { /* the page works without the list */ }
}

$('btnGrLoad').onclick = async () => {
  const name = $('grFiles').value;
  if (!name) { msg('Pick a saved recording first.', true); return; }
  try {
    const r = await api('GET', `/api/recordings/load?name=${encodeURIComponent(name)}`);
    graphs.openReplay(r);
    fmap.replay = newFuelMap();
    fmap.replay.ingest(graphs.replay.series);
    msg('');
    $('btnGrLive').style.display = '';
    $('grInfo').textContent = `${r.name}: ${fmtTime(r.durationMs)} long, ${r.events.length} events, ${r.markers.length} notes. Red dashed lines are events, yellow ones your notes. Pick a shorter window and slide through it.`;
    $('grWindow').value = '0';
    $('grScrub').value = 1000;
    drawGraphs();
  } catch (e) { msg(e.message, true); }
};

$('btnGrLive').onclick = () => {
  graphs.closeReplay();
  fmap.replay = null;
  $('btnGrLive').style.display = 'none';
  $('grWindow').value = '60000';
  $('grInfo').textContent = 'Live again.';
  drawGraphs();
};

// ---- Fuel map -----------------------------------------------------------
// A table of engine speed (rows) against throttle (columns) that fills in as the bike is ridden or a
// recording is opened: each cell holds the average of the chosen value (the injection pulse by default)
// seen at that speed and throttle, coloured like a tuning program's map, with a crosshair at the
// engine's operating point now (or at the moment under the pointer in a graph lane). The cells and the
// crosshair position come from FuelMap; this file draws them.
const fmAxis = () => FuelMap.AXES[$('fmAxis').value] ?? FuelMap.AXES.tps;
const fmap = { live: null, replay: null };

/** A fresh map for what the lists and the injector size say now. */
const newFuelMap = () => FuelMap.create({ key: $('fmMetric').value, axis: $('fmAxis').value, flow: Number($('fmFlow').value) || 0 });

function ingestLive() {
  fmap.live ??= newFuelMap();
  fmap.live.ingest(graphs.live.series);
}

function fmRebuild() {
  fmap.live = newFuelMap();
  fmap.live.ingest(graphs.live.series);
  if (graphs.replay) {
    fmap.replay = newFuelMap();
    fmap.replay.ingest(graphs.replay.series);
  }
}

const FM_LABEL = 52, FM_TOP = 22, FM_ROW = 17;
let fmLast = null; // what the last draw put where, for the pointer readout

function drawFuelMap() {
  const c = $('fmCanvas');
  const map = graphs.replay ? fmap.replay : fmap.live;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 640;
  const h = FM_TOP + FuelMap.RPM.length * FM_ROW + 24;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = css('--panel2');
  g.fillRect(0, 0, w, h);
  const R = FuelMap.RPM.length, C = fmAxis().cols.length;
  const cw = (w - FM_LABEL) / C;
  const cx = (col) => FM_LABEL + (col + 0.5) * cw;
  const ry = (row) => FM_TOP + (R - 1 - row + 0.5) * FM_ROW; // the highest speed on top
  const vals = map ? map.values($('fmFill').checked) : null;
  const { lo, hi } = vals ? FuelMap.range(vals) : { lo: Infinity, hi: -Infinity };
  const span = hi - lo || 1;
  g.font = '11px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // axis labels
  g.fillStyle = css('--dim');
  g.fillText(fmAxis().label, FM_LABEL + (w - FM_LABEL) / 2, 6);
  fmAxis().cols.forEach((v, col) => { g.fillText(String(v), cx(col), FM_TOP - 7 + 1); });
  for (let row = 0; row < R; row++) {
    g.fillStyle = `hsl(${Math.round(120 - 120 * row / (R - 1))} 55% 38%)`; // like the speed column of a tuning program
    g.fillRect(2, ry(row) - FM_ROW / 2 + 1, FM_LABEL - 6, FM_ROW - 2);
    g.fillStyle = '#fff';
    g.fillText(String(FuelMap.RPM[row]), 2 + (FM_LABEL - 6) / 2, ry(row));
  }
  fmLast = { w, cw, vals };
  for (let row = 0; row < R; row++) {
    for (let col = 0; col < C; col++) {
      const x0 = FM_LABEL + col * cw, y0 = ry(row) - FM_ROW / 2;
      const q = vals?.[row][col];
      g.fillStyle = q ? FuelMap.color((q.v - lo) / span, q.filled ? 0.5 : 1) : css('--panel');
      g.fillRect(x0 + 0.5, y0 + 0.5, cw - 1, FM_ROW - 1);
      if (q && !q.filled) {
        g.fillStyle = '#fff';
        g.fillText(q.v.toFixed(Math.abs(q.v) < 100 ? 1 : 0), x0 + cw / 2, y0 + FM_ROW / 2 + 0.5);
      }
    }
  }
  // the operating point: now, or the moment under the pointer in a graph lane
  const view = graphView();
  const at = graph.hoverT ?? view?.t1 ?? Date.now();
  const spot = FuelMap.crosshair(graphs.source().series, at, fmAxis().key);
  if (spot) {
    const fx = FM_LABEL + (spot.colFrac + 0.5) * cw;
    const fy = FM_TOP + (R - 1 - spot.rowFrac + 0.5) * FM_ROW;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.strokeRect(FM_LABEL + spot.col * cw + 1, ry(spot.row) - FM_ROW / 2 + 1, cw - 2, FM_ROW - 2);
    g.beginPath();
    g.moveTo(FM_LABEL, fy); g.lineTo(w, fy);
    g.moveTo(fx, FM_TOP); g.lineTo(fx, FM_TOP + R * FM_ROW);
    g.stroke();
    g.beginPath(); g.arc(fx, fy, 4, 0, Math.PI * 2); g.stroke();
  }
  // colour bar
  const by = FM_TOP + R * FM_ROW + 8;
  const grad = g.createLinearGradient(FM_LABEL, 0, w - 8, 0);
  for (const [s, col] of FuelMap.STOPS) grad.addColorStop(s, `rgb(${col[0]},${col[1]},${col[2]})`);
  g.fillStyle = grad;
  g.fillRect(FM_LABEL, by, w - 8 - FM_LABEL, 8);
  g.fillStyle = css('--dim');
  g.textAlign = 'left';
  if (Number.isFinite(lo)) g.fillText(lo.toFixed(1), FM_LABEL, by + 17 - 4);
  g.textAlign = 'right';
  if (Number.isFinite(hi)) g.fillText(hi.toFixed(1), w - 8, by + 17 - 4);
  const unit = $('fmMetric').selectedOptions[0]?.dataset.unit ?? '';
  $('fmInfo').textContent = $('fmMetric').value === 'injFlow' && !map?.flow
    ? 'Type the size of one injector (cc/min, from its spec sheet) to turn the injection pulse into an estimated fuel flow.'
    : !map || !map.count
    ? 'Nothing yet: the map fills in while the engine runs (it needs engine speed, throttle and the chosen value). Start the dashboard, or open a saved recording.'
    : `${map.count} samples, ${lo.toFixed(1)} to ${hi.toFixed(1)} ${unit}. ${graphs.replay ? 'From ' + graphs.replay.name + '.' : 'Live.'} Pale cells are filled in from their neighbours. The crosshair is where the engine is now${graph.hoverT != null ? ' (at the moment under the pointer)' : ''}.`;
}

$('fmCanvas').addEventListener('mousemove', (e) => {
  if (!fmLast?.vals) return;
  const r = $('fmCanvas').getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const col = Math.floor((x - FM_LABEL) / fmLast.cw), row = FuelMap.RPM.length - 1 - Math.floor((y - FM_TOP) / FM_ROW);
  const q = fmLast.vals[row]?.[col];
  $('fmHover').textContent = col >= 0 && col < fmAxis().cols.length && q
    ? `${FuelMap.RPM[row]} rpm, ${fmAxis().short} ${fmAxis().cols[col]} ${fmAxis().unit}: ${q.v.toFixed(2)} ${$('fmMetric').selectedOptions[0]?.dataset.unit ?? ''}${q.filled ? ' (filled in)' : `, ${q.n} samples`}`
    : '';
});
const fmShowFlow = () => { $('fmFlowBox').style.display = $('fmMetric').value === 'injFlow' ? '' : 'none'; };
$('fmMetric').onchange = () => { fmShowFlow(); fmRebuild(); drawGraphs(); };
$('fmFlow').onchange = () => { fmRebuild(); drawGraphs(); };
$('fmAxis').onchange = () => { fmRebuild(); drawGraphs(); };
$('fmFill').onchange = drawGraphs;
$('btnFmReset').onclick = () => {
  // Start the live map over: only samples from now on count.
  fmap.live = newFuelMap();
  fmap.live.skipSeen(graphs.live.series);
  drawGraphs();
};


buildLanes();
refreshGraphFiles();
setInterval(() => { if (!graph.paused && !graphs.replay) drawGraphs(); }, 250);
window.addEventListener('resize', drawGraphs);

// ---- Dashboard gauges -------------------------------------------------
const SWEEP = 120; // needle swings from -120 to +120 degrees around "up"
const pt = (r, a) => [100 + r * Math.sin(a * Math.PI / 180), 100 - r * Math.cos(a * Math.PI / 180)];
const arc = (r, a0, a1) => {
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};
const angleFor = (d, v) => -SWEEP + 2 * SWEEP * Math.min(1, Math.max(0, (v - d.min) / (d.max - d.min)));
const niceStep = (span) => { const raw = span / 7; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw); };

function buildGauge(d, big) {
  const el = document.createElement('div');
  el.className = 'gauge' + (big ? ' big' : '');
  el.id = 'g-' + d.key;
  if (d.type === 'text') {
    el.innerHTML = `<div class="name">${d.label}</div><div class="vtext" id="gv-${d.key}">–</div><div class="unv" id="gu-${d.key}"></div>`;
    return el;
  }
  if (d.type === 'bitpos') {
    el.innerHTML = `<div class="name">${d.label}</div><div class="gear" id="gv-${d.key}">–</div><div class="unv" id="gu-${d.key}"></div>`;
    return el;
  }
  let ticks = '';
  const step = niceStep(d.max - d.min);
  for (let v = Math.ceil(d.min / step) * step; v <= d.max + 1e-9; v += step) {
    const a = angleFor(d, v);
    const [x0, y0] = pt(70, a), [x1, y1] = pt(78, a), [tx, ty] = pt(60, a);
    ticks += `<line class="tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>` +
      `<text class="tlab" x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}">${d.unit === 'rpm' ? v / 1000 : v}</text>`;
  }
  const red = d.redline != null ? `<path class="red" d="${arc(86, angleFor(d, d.redline), SWEEP)}"/>` : '';
  el.innerHTML = `<div class="name">${d.label}</div>
    <svg viewBox="0 0 200 160" role="img" aria-label="${d.label}">
      <path class="track" d="${arc(86, -SWEEP, SWEEP)}"/>${red}
      <path class="fill" id="gf-${d.key}" d="${arc(86, -SWEEP, -SWEEP)}"/>
      ${ticks}
      <g class="needle" id="gn-${d.key}" style="transform:rotate(${-SWEEP}deg)"><line x1="100" y1="100" x2="100" y2="30"/></g>
      <circle class="hub" cx="100" cy="100" r="9"/>
      <text class="val" id="gv-${d.key}" x="100" y="138">–</text>
      <text class="unit" x="100" y="154">${d.unit}</text>
    </svg><div class="unv" id="gu-${d.key}"></div>`;
  return el;
}

let gaugeDefs = null;
let gaugePoll = null; // the page's poll of the dashboard run, attached while the server runs it (see `session`)

function renderGauges(g) {
  if (!gaugeDefs) {
    gaugeDefs = g.defs;
    $('dash').innerHTML = '';
    for (const d of gaugeDefs) $('dash').appendChild(buildGauge(d, d.key === 'rpm'));
  }
  // One slow gauge is read per cycle, so a slow one is current for that many cycles.
  const staleAfter = gaugeDefs.filter((d) => !d.fast).length + 3;
  for (const d of gaugeDefs) {
    const v = g.values[d.key];
    const box = $('g-' + d.key);
    const unsupported = g.unsupported.includes(d.key);
    const locked = (g.locked ?? []).includes(d.key);
    box.classList.toggle('na', unsupported || locked);
    box.classList.toggle('stale', unsupported || locked || !v || g.cycles - v.at > staleAfter);
    $('gu-' + d.key).textContent = locked ? 'needs the ECU unlock' : unsupported ? 'not available' : (!d.verified ? 'unverified' : '');
    if (unsupported || locked) { $('gv-' + d.key).textContent = '–'; continue; }
    if (!v) continue;
    if (d.type === 'text') { $('gv-' + d.key).textContent = v.text; continue; }
    if (d.type === 'bitpos') { $('gv-' + d.key).textContent = v.value || 'N'; continue; }
    $('gv-' + d.key).textContent = v.value.toFixed(d.unit === '%' || d.unit === '°' || d.unit === 'V' ? 1 : 0);
    const a = angleFor(d, v.value);
    $('gn-' + d.key).style.transform = `rotate(${a}deg)`;
    $('gf-' + d.key).setAttribute('d', arc(86, -SWEEP, Math.max(-SWEEP + 0.01, a)));
    $('gf-' + d.key).style.stroke = d.redline != null && v.value >= d.redline ? 'var(--err)' : '';
  }
  feedGraph('gauges', g.series, g.elapsedMs);
  $('gaugeInfo').textContent = `${g.cycles} cycles` +
    (g.errors ? ` · ${g.errors} errors (${g.lastError})` : '') +
    (g.supported ? ` · ECU serves PIDs ${g.supported.map((p) => p.toString(16).padStart(2, '0')).join(' ')}` : '');
}

async function pollGauges() {
  try { renderGauges(await api('GET', `/api/gauges?since=${graphs.since('gauges')}`)); } catch (e) { msg(e.message, true); }
}

function stopGaugesUi() {
  clearInterval(gaugePoll);
  gaugePoll = null;
  $('btnGauges').textContent = 'Start gauges';
  $('btnGauges').classList.add('primary');
}

/** Attach the poll of the dashboard (the server runs it), or detach it; the button says which. */
function setGaugePolling(on) {
  if (on === (gaugePoll !== null)) return;
  if (!on) { stopGaugesUi(); return; }
  $('btnGauges').textContent = 'Stop gauges';
  $('btnGauges').classList.remove('primary');
  gaugePoll = setInterval(pollGauges, 200);
  pollGauges();
}

$('btnGauges').onclick = () => toggleFeature('dashboard');

// Draw the empty dials immediately so the page shows what's coming.
api('GET', '/api/gauges').then(renderGauges).catch(() => {});

// ---- Switches (the ECU unlock) ----------------------------------------
const idHex = (id) => '0x' + id.toString(16).padStart(4, '0');
const BADGES = {
  consistent: ['~', 'Consistent with what the bike showed, but this input was not operated on its own yet'],
  unconfirmed: ['?', "Unconfirmed: a label from another tool's table, not tried on this bike"],
};
let swTimer = null; // the page's poll of the switch watcher: each request is one cycle of the server's switch run
let swFirst = new Map();
let swBusy = false;

// One tile: the name big, the state pill (the decode rule and the words come from the server), the raw bytes and the id small.
function switchTile(row) {
  if (!swFirst.has(row.id)) swFirst.set(row.id, row.hex);
  const changed = swFirst.get(row.id) !== row.hex;
  const [mark, why] = BADGES[row.confirmation] || [];
  const badge = mark ? `<span class="badge${row.confirmation === 'unconfirmed' ? ' q' : ''}" title="${esc(why)}">${mark}</span>` : '';
  const pill = row.state ? `<div class="pill${row.active ? ' on' : ''}${row.bad ? ' bad' : ''}">${esc(row.state)}</div>` : '';
  const meta = row.hex + (row.named ? ' · ' + idHex(row.id) : '') + (row.stale ? ' · no reply, last value' : '') + (changed ? ` · changed (was ${swFirst.get(row.id)})` : '');
  return `<div class="tile sw${changed ? ' chg' : ''}${row.stale ? ' stale' : ''}" title="${esc(row.evidence || '')}">${badge}<div class="nm">${esc(row.name)}</div>${pill}<div class="meta">${meta}</div></div>`;
}

function analogTile(a) {
  const mark = a.verified ? '' : ' <span style="color:var(--warn)" title="Unconfirmed: a formula from another tool\'s table">?</span>';
  const value = a.available
    ? `<div class="v">${a.value.toFixed(2)}<span class="u"> ${esc(a.unit)}</span></div>`
    : '<div class="v">not available</div>';
  const meta = (a.hex ? a.hex + ' · ' : '') + idHex(a.id);
  return `<div class="tile small${a.available ? '' : ' na'}"><div class="n">${esc(a.label)}${mark}</div>${value}<div class="note">${esc(a.note || '')}</div><div class="meta" style="margin-top:6px;font:12px var(--mono);color:var(--dim)">${meta}</div></div>`;
}

async function pollSwitches() {
  if (swBusy) return;
  swBusy = true;
  try {
    const r = await api('GET', '/api/switches');
    if (r.locked) { stopSwitchesUi(); msg(r.note, true); }
    $('swTiles').innerHTML = r.rows.map(switchTile).join('') || `<span class="status">${r.note || 'The ECU did not serve any switch ID.'}</span>`;
    const analogs = r.analogs || [];
    $('swAnalogHead').style.display = analogs.length ? '' : 'none';
    $('swAnalog').innerHTML = analogs.map(analogTile).join('');
  } catch (e) { stopSwitchesUi(); msg(e.message, true); }
  swBusy = false;
}
function stopSwitchesUi() {
  clearInterval(swTimer);
  swTimer = null;
  $('btnSw').textContent = 'Watch switches';
  $('btnSw').classList.add('primary');
}

/** Attach the poll of the switch watcher (the server runs it), or detach it; the button says which. */
function setSwitchPolling(on) {
  if (on === (swTimer !== null)) return;
  if (!on) { stopSwitchesUi(); return; }
  swFirst = new Map();
  pollSwitches();
  swTimer = setInterval(pollSwitches, 700);
  $('btnSw').textContent = 'Stop';
  $('btnSw').classList.remove('primary');
}
$('btnSw').onclick = () => toggleFeature('switches');
$('btnSwReset').onclick = () => { swFirst = new Map(); };

// ---- Record -----------------------------------------------------------
let recPoll = null;
let recActive = false; // what the last answer of GET /api/record said (drives the buttons)
const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${((Math.floor(ms / 100) / 10) % 60).toFixed(1).padStart(4, '0')}`;

function recButtons() {
  for (const id of ['btnMkCranking', 'btnMkStarted', 'btnMkDied', 'btnMkOther', 'recText']) $(id).disabled = !recActive;
}

function renderRecord(v) {
  const wasActive = recActive;
  recActive = !!v.running;
  if (wasActive !== recActive) {
    // A recording began or ended: the dashboard and the watcher paused or came back (the server did it; the polls follow).
    // The server brings them back a moment after the recorder's last read, so ask once more shortly after.
    syncRuns();
    setTimeout(syncRuns, 600);
  }
  if (wasActive && !recActive) refreshGraphFiles();
  $('btnRec').textContent = recActive ? 'Stop recording' : 'Start recording';
  $('btnRec').classList.toggle('primary', !recActive);
  recButtons();
  if (!v.active) return;
  feedGraph('record', v.series, v.elapsedMs);
  graphs.setMarks(v);
  $('recLock').style.display = v.locked.length ? 'block' : 'none';
  $('recLock').textContent = v.locked.length ? `${v.lockedNote}: battery, switch flags and analog values are skipped, only the OBD values are recorded.` : '';
  const volts = (x) => (x === null ? '–' : x.toFixed(1) + ' V');
  const stat = (name, value) => `<div class="tile small"><div class="n">${name}</div><div class="v">${value}</div></div>`;
  $('recStats').innerHTML = stat('Elapsed', fmtTime(v.elapsedMs)) + stat('Samples', v.samples) +
    stat('Battery now', volts(v.battery.last)) + stat('Battery lowest', volts(v.battery.min)) + stat('Battery highest', volts(v.battery.max)) +
    stat('File', `<span style="font-size:13px;font-family:var(--mono);word-break:break-all">${esc(v.csvFile || '–')}</span>`);
  const lines = [...v.events.map((e) => ({ ...e, kind: 'ev' })), ...v.markers.map((m) => ({ ...m, kind: 'mk' }))].sort((a, b) => b.t_ms - a.t_ms);
  $('recEvents').style.display = lines.length ? '' : 'none';
  $('recEvents').innerHTML = lines.map((l) => `<div class="${l.kind}"><span class="t">${fmtTime(l.t_ms)}</span>${l.kind === 'mk' ? 'mark: ' : ''}${esc(l.text)}</div>`).join('');
  $('recInfo').textContent = (recActive
    ? 'Recording. Press a button (or type a note) the moment something happens: it is stamped on the next sample.'
    : `Stopped${v.stopReason ? ': ' + v.stopReason : ''}. ${v.samples} samples saved to ${v.csvFile}.`) +
    (v.notAvailable.length ? ` Not available on this ECU: ${v.notAvailable.join(', ')}.` : '') +
    (v.errors ? ` ${v.errors} read errors (${v.lastError}).` : '');
}

async function pollRecord() {
  try {
    const v = await api('GET', `/api/record?since=${graphs.since('record')}`);
    renderRecord(v);
    if (!v.running) { clearInterval(recPoll); recPoll = null; }
  } catch { /* transient */ }
}

function startRecordPoll() {
  clearInterval(recPoll);
  recPoll = setInterval(pollRecord, 500);
  pollRecord();
}

$('btnRec').onclick = async () => {
  try {
    if (recActive) {
      await api('POST', '/api/record/stop');
      await pollRecord();
      return;
    }
    // One run at a time on the K-line: the server pauses the dashboard and the switch watcher for the recording
    // and brings them back after it; the page only asks and then follows (syncRuns).
    graphs.resetCursor('record');
    await api('POST', '/api/record/start', {});
    recActive = true;
    recButtons();
    startRecordPoll();
  } catch (e) { msg(e.message, true); }
  syncRuns();
};

async function mark(text) {
  try {
    await api('POST', '/api/record/mark', { text });
    pollRecord();
  } catch (e) { msg(e.message, true); }
}
$('btnMkCranking').onclick = () => mark('Cranking');
$('btnMkStarted').onclick = () => mark('Started');
$('btnMkDied').onclick = () => mark('Died');
$('btnMkOther').onclick = () => {
  const text = $('recText').value.trim();
  if (!text) { $('recText').focus(); return; }
  mark(text);
  $('recText').value = '';
};
$('recText').onkeydown = (e) => { if (e.key === 'Enter') $('btnMkOther').click(); };

// ---- Find more IDs (the ECU unlock) -------------------------------------
let scanPoll = null;
let scanActive = false;
let snapBusy = false;
let snapHaveA = false;

const parseId = (s) => {
  const t = String(s).trim().replace(/^0x/i, '');
  return /^[0-9a-f]{1,4}$/i.test(t) ? parseInt(t, 16) : null;
};

// The unlock gate enables every button of these panels; the ones that depend on what is going on are settled here.
function snapButtons() {
  const open = connected && unlockState === 'unlocked';
  $('btnScan').disabled = !open || snapBusy;
  $('btnSnapA').disabled = !open || scanActive || snapBusy;
  $('btnSnapB').disabled = !open || scanActive || snapBusy || !snapHaveA;
}

function idsTable(table, head, rows) {
  table.style.display = rows.length ? '' : 'none';
  table.innerHTML = rows.length
    ? `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>` + rows.map((r) => `<tr>${r.map((c, i) => `<td${i === r.length - 1 ? ' class="name"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')
    : '';
}

function renderScan(v) {
  const wasActive = scanActive;
  scanActive = !!v.running;
  if (wasActive !== scanActive) syncRuns(); // an id scan holds the line like a recording: the dashboard pauses and comes back
  $('btnScan').textContent = scanActive ? 'Stop' : 'Scan';
  $('btnScan').classList.toggle('primary', !scanActive);
  snapButtons();
  if (!v.active) return;
  $('scBar').style.width = v.total ? `${Math.round((100 * v.asked) / v.total)}%` : '0%';
  $('scInfo').textContent = v.running
    ? `asking ${idHex(v.current)}… ${v.asked} of ${v.total}, ${v.found.length} answered`
    : `${v.outcome === 'cancelled' ? 'stopped' : 'done'}: asked ${v.asked} of ${v.total}, ${v.found.length} answered, ${v.refused} refused, ${v.silent} silent` +
      (v.stopReason ? ` · ${v.stopReason}` : '') + (v.resultFile ? ` · saved ${v.resultFile}` : '') + (v.errors ? ` · ${v.errors} read errors (${v.lastError})` : '');
  idsTable($('scTable'), ['ID', 'Value', 'Hex', 'Name on this bike'], v.found.map((f) => [idHex(f.id), f.value ?? '', f.hex, f.name || '']));
}

function renderSnapshot(s) {
  snapHaveA = !!s.a;
  snapButtons();
  const when = (x) => new Date(x.at).toLocaleTimeString();
  $('snapInfo').textContent = !s.a ? '' :
    `A: ${s.a.count} ids at ${when(s.a)}` + (s.b ? ` · B: ${s.b.count} ids at ${when(s.b)}` : ' · now do something to the bike, then take B') +
    (s.changes && !s.changes.length ? ' · no id changed' : '') + (s.note ? ` · ${s.note}` : '');
  idsTable($('snapTable'), ['Changed ID', 'Before', 'After', 'Name on this bike'],
    (s.changes || []).map((c) => [idHex(c.id), c.before ?? 'no answer', c.after ?? 'no answer', c.name || '']));
}

async function pollScan() {
  try {
    const v = await api('GET', '/api/discover');
    renderScan(v);
    renderSnapshot(v.snapshot);
    if (!v.running) { clearInterval(scanPoll); scanPoll = null; }
  } catch { /* transient */ }
}

$('scExt').onchange = () => {
  $('scFrom').value = $('scExt').checked ? '0100' : '0000';
  $('scTo').value = $('scExt').checked ? '03ff' : '00ff';
};

$('btnScan').onclick = async () => {
  try {
    if (scanActive) {
      await api('POST', '/api/discover/stop');
      await pollScan();
      return;
    }
    const from = parseId($('scFrom').value);
    const to = parseId($('scTo').value);
    if (from === null || to === null || from > to) { msg('Enter the first and the last id as hex numbers (up to 4 digits), the first not above the last.', true); return; }
    const r = await api('POST', '/api/discover/start', { from, to });
    if (r.locked) { msg(r.note, true); return; }
    msg('');
    scanActive = true;
    snapButtons();
    clearInterval(scanPoll);
    scanPoll = setInterval(pollScan, 500);
    pollScan();
    syncRuns(); // the server paused the dashboard and the watcher for the scan: the polls follow
  } catch (e) { msg(e.message, true); }
};

async function snapshot(which) {
  snapBusy = true;
  snapButtons();
  $('snapInfo').textContent = `reading snapshot ${which.toUpperCase()}…`;
  try {
    const r = await api('POST', '/api/snapshot', { which });
    if (r.locked) msg(r.note, true);
    else renderSnapshot(r);
  } catch (e) { msg(e.message, true); }
  snapBusy = false;
  snapButtons();
}
$('btnSnapA').onclick = () => snapshot('a');
$('btnSnapB').onclick = () => snapshot('b');

// ---- Output tests (the ECU unlock; off until enabled on this page) -------------
// The token comes back only to this page from the enable call; it is kept in memory, never stored, so a
// reload or a lost connection starts again with the feature off.
let outToken = null;
let outTests = [];
let outRunning = false;
let outPoll = null;

function outButtons() {
  const open = connected && unlockState === 'unlocked';
  if (!open && outToken) outDisable();
  $('outAck').disabled = !open || !!outToken;
  $('btnOutEnable').disabled = !open || !$('outAck').checked || !!outToken;
  $('btnOutOff').disabled = !open || outRunning;
  $('btnOutStop').disabled = !open || !outRunning;
  for (const b of document.querySelectorAll('#outTests button')) b.disabled = !open || outRunning;
}

function outDisable() {
  outToken = null;
  outRunning = false;
  clearInterval(outPoll);
  outPoll = null;
  $('outAck').checked = false;
  $('outIntro').style.display = '';
  $('outMain').style.display = 'none';
  $('outLive').style.display = 'none';
  outButtons();
}

function outCards() {
  $('outTests').innerHTML = outTests.map((t) =>
    `<div class="tile small"><div class="n">${esc(t.name)} · <span style="color:var(--warn)">${t.confirmation === 'unconfirmed' ? 'not yet confirmed on a bike' : esc(t.confirmation)}</span></div>` +
    `<div class="note" style="color:var(--text)">You should see: ${esc(t.see)}</div>` +
    `<div class="note" style="color:var(--warn)">Safety: ${esc(t.safety)}</div>` +
    `<div style="margin-top:8px"><button data-key="${esc(t.key)}">Run test…</button></div></div>`).join('');
  for (const b of document.querySelectorAll('#outTests button')) b.onclick = () => runOut(b.dataset.key);
}

function renderOut(v, status) {
  outRunning = !!(v && v.running);
  $('btnOutStop').textContent = v && v.needsStop ? 'Stop test' : 'Stop watching';
  $('outPre').textContent = status && status.cooldownMs > 0 && !outRunning ? `Next test possible in ${Math.ceil(status.cooldownMs / 1000)} s.` : '';
  const lines = [];
  if (v) {
    const secs = (v.elapsedMs / 1000).toFixed(1);
    if (v.running) lines.push(`${v.name}: the ECU answered ${v.reply}; running for ${secs} s (watching up to ${v.watchMs / 1000} s).`);
    else if (v.state === 'failed') lines.push(`${v.name}: ${v.error}`);
    else lines.push(`${v.name}: ${v.outcome} after ${secs} s.`);
    for (const w of v.warnings) lines.push(`WARNING: ${w}`);
    lines.push(`Effect: ${v.effect.text}`);
    if (v.battery.min !== null) lines.push(`Battery during the test: ${v.battery.min.toFixed(1)} to ${v.battery.max.toFixed(1)} V`);
    if (v.needsStop && v.stopSent) lines.push(v.stopError ? `Stop was not acknowledged: ${v.stopError}` : `Stop sent, the ECU answered ${v.stopReply}.`);
    if (!v.running && v.logFile) lines.push(`Logged to ${v.logFile.split(/[\\/]/).pop()}`);
  }
  $('outLive').style.display = lines.length ? '' : 'none';
  $('outLive').innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
  outButtons();
}

async function pollOut() {
  try {
    const s = await api('GET', '/api/outputtest/status');
    renderOut(s.current, s);
    if (!s.running) { clearInterval(outPoll); outPoll = null; }
  } catch { /* transient */ }
}

$('outAck').onchange = outButtons;
$('btnOutEnable').onclick = async () => {
  try {
    const r = await api('POST', '/api/outputtest/enable', { acknowledged: $('outAck').checked });
    const list = await api('GET', '/api/outputtest/list');
    outToken = r.token;
    outTests = list.tests;
    $('outPre').textContent = '';
    outCards();
    $('outIntro').style.display = 'none';
    $('outMain').style.display = '';
    outButtons();
  } catch (e) { msg(e.message, true); }
};
$('btnOutOff').onclick = outDisable;
$('btnOutStop').onclick = async () => {
  try { renderOut((await api('POST', '/api/outputtest/stop')).test); pollOut(); } catch (e) { msg(e.message, true); }
};

async function runOut(key) {
  const t = outTests.find((x) => x.key === key);
  if (!t) return;
  if (!confirm(`Run the ${t.name} test now?\n\nYou should see: ${t.see}\nSafety: ${t.safety}\n\nThis makes the bike move or run parts.`)) return;
  try {
    const r = await api('POST', '/api/outputtest/start', { key, confirmed: true, token: outToken });
    if (r.locked) { msg(r.note, true); return; }
    msg('');
    renderOut(r.test);
    clearInterval(outPoll);
    outPoll = setInterval(pollOut, 400);
    // The dials and the switch tiles refresh while the test runs (nothing while a recording or a scan holds the line).
    session.afterOutputTestStart(sessionFacts()).catch(() => {});
  } catch (e) { msg(e.message, true); }
}


// ---- Vitals and tabs ----------------------------------------------------
// The numbers that matter most stay on screen on every tab: they come from the graph store, which the
// dashboard run and the recorder both feed.
const VITALS = [
  { n: 'Engine', keys: ['rpmId', 'rpm'], u: 'rpm', d: 0, age: 5000 },
  { n: 'Throttle', keys: ['tps'], u: '%', d: 1, age: 5000 },
  { n: 'Battery', keys: ['battery'], u: 'V', d: 1, age: 15000 },
  { n: 'Coolant', keys: ['coolant'], u: '°C', d: 0, age: 20000 },
  { n: 'Injection', keys: ['injPulse1'], u: 'ms', d: 2, age: 5000 },
  { n: 'Fuel pump', keys: ['fuelPump'], flag: true, on: 'ON', off: 'OFF', age: 15000 },
  { n: 'Tip-over', keys: ['tipOver'], flag: true, on: 'OK', off: 'TRIPPED', badOff: true, age: 15000 },
];
let vitalsHtml = '';

function renderVitals() {
  const now = Date.now();
  const html = VITALS.map((vt) => {
    const last = graphs.latest(vt.keys);
    if (!last) return `<div class="vit stale"><div class="n">${vt.n}</div><div class="v">–</div></div>`;
    const { t, v } = last;
    const stale = now - t > vt.age;
    if (vt.flag) {
      // a brief trip must not blink past: a tripped sensor stays shown for 5 s
      const tripped = vt.badOff && last.pts.some(([pt, pv]) => pv === 0 && now - pt < 5000);
      const text = tripped ? vt.off : v ? vt.on : vt.off;
      return `<div class="vit${stale ? ' stale' : ''}${tripped || (vt.badOff && !v) ? ' bad' : vt.badOff && v ? ' good' : ''}"><div class="n">${vt.n}</div><div class="v">${text}</div></div>`;
    }
    return `<div class="vit${stale ? ' stale' : ''}"><div class="n">${vt.n}</div><div class="v">${v.toFixed(vt.d)} <span class="u">${vt.u}</span></div></div>`;
  }).join('');
  if (html !== vitalsHtml) { vitalsHtml = html; $('vitals').innerHTML = html; }
}
setInterval(renderVitals, 400);
renderVitals();

function showTab(name, remember = true) {
  if (!$('tab-' + name)) name = 'dashboard';
  for (const sec of document.querySelectorAll('.tab')) sec.classList.toggle('on', sec.dataset.tab === name);
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  if (remember) {
    try { localStorage.setItem('ecuTab', name); } catch { /* private window: no memory */ }
    try { history.replaceState(null, '', '#' + name); } catch { /* file preview */ }
  }
  drawGraphs();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener('hashchange', () => showTab(location.hash.slice(1), false));
{
  let first = location.hash.slice(1);
  if (!first) { try { first = localStorage.getItem('ecuTab') || ''; } catch { /* none */ } }
  showTab(first || 'dashboard', false);
}

renderUnlock();

// Load: connect, then ask what is running, then reconcile. A recording or a scan that is already going (or has
// just ended) when the page is opened is learned from the server first, so nothing is started beside it.
(async () => {
  await refreshPorts();
  try {
    const s = await api('GET', '/api/status');
    if (s.connected) setConnected(true, `ECU @ 0x${s.target.toString(16)}`);
    showUnlock(s.unlock, s.unlockReason);
    if (!s.connected && s.error) msg(s.error, true);
    if (s.live) {
      liveActive = true;
      $('btnLive').textContent = 'Stop';
      $('btnLive').classList.remove('primary');
      livePoll = setInterval(renderLive, 250);
    }
  } catch {}
  try {
    const rec = await api('GET', '/api/record');
    renderRecord(rec);
    if (rec.running) startRecordPoll();
    const scan = await api('GET', '/api/discover');
    renderScan(scan);
    renderSnapshot(scan.snapshot);
    if (scan.running) scanPoll = setInterval(pollScan, 500);
  } catch {}
  await syncRuns();
})();
