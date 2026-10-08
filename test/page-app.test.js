'use strict';

// The page as a whole (public/index.html + public/js/*.js), without a browser: every script compiles, every
// element id the scripts use is in the markup, the modules stay free of the DOM, and the scripts run in a vm
// against a stubbed DOM and the real routes with the mock ECU: reload while connected, reload during a
// recording, the owner's Stop, connect and unlock, the graphs, the fuel map and a saved recording.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { routes, conn, state } = require('../server');
const FuelMap = require('../public/js/fuelmap');
const { MockEcuTransport } = require('./mockecu');

const PUBLIC = path.join(__dirname, '..', 'public');
const JS = path.join(PUBLIC, 'js');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SCRIPT_ORDER = ['graphstore.js', 'fuelmap.js', 'session.js', 'app.js'];
const read = (name) => fs.readFileSync(path.join(JS, name), 'utf8');
const MODULES = ['graphstore.js', 'fuelmap.js', 'session.js'];
const GLOBALS = { 'graphstore.js': 'GraphStore', 'fuelmap.js': 'FuelMap', 'session.js': 'SessionState' };

// ---- the files --------------------------------------------------------------------

test('every page script compiles, and the page loads them in dependency order', () => {
  const files = fs.readdirSync(JS).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(files, [...SCRIPT_ORDER].sort(), 'public/js holds exactly the page\'s scripts');
  for (const f of files) new vm.Script(read(f), { filename: f }); // throws on a syntax error
  const srcs = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, SCRIPT_ORDER);
  assert.doesNotMatch(html, /<script>/, 'no inline script is left in the page');
});

test('every element id the page scripts use is in index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const app = read('app.js');
  const used = new Set();
  for (const m of app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  for (const m of app.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  for (const m of app.matchAll(/(?:querySelector(?:All)?|closest)\('[^']*?#([A-Za-z0-9_-]+)/g)) used.add(m[1]);
  const list = app.match(/for \(const id of \[([^\]]+)\]\)/); // recButtons walks a list of ids
  for (const m of list[1].matchAll(/'([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size > 80, `the scan found the page's elements (${used.size})`);
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'ids the scripts use that the markup does not have');
});

test('the markup the scripts count on: five tabs with a section each, the unlock panels, the canvases', () => {
  const tabs = [...html.matchAll(/<button data-tab="([a-z]+)" role="tab">/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['dashboard', 'graphs', 'record', 'faults', 'advanced']);
  for (const t of tabs) assert.match(html, new RegExp(`<section class="tab" data-tab="${t}" id="tab-${t}">`));
  assert.ok((html.match(/data-needs-unlock/g) || []).length >= 5, 'the panels behind the unlock');
  assert.match(html, /<canvas id="fmCanvas"/);
  for (const id of ['grLanes', 'grScrub', 'grWindow', 'vitals', 'dash', 'swTiles', 'recStats']) assert.match(html, new RegExp(`id="${id}"`));
});

test('the fuel map lists in the markup are the module\'s metrics and axes', () => {
  const select = (id) => html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1];
  const metrics = [...select('fmMetric').matchAll(/<option value="([^"]+)" data-unit="([^"]*)"/g)].map((m) => ({ key: m[1], unit: m[2] }));
  assert.deepEqual(metrics, FuelMap.METRICS.map(({ key, unit }) => ({ key, unit })));
  assert.equal(metrics.find((m) => m.key === 'injFlow').unit, 'cc/min');
  const axes = [...select('fmAxis').matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(axes, Object.keys(FuelMap.AXES));
  assert.deepEqual([...select('grWindow').matchAll(/<option value="(\d+)"/g)].map((m) => m[1]), ['30000', '60000', '300000', '0']);
});

test('the modules know nothing of the page: no DOM, storage, network or timers', () => {
  for (const f of MODULES) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(document|window|localStorage|sessionStorage|fetch|XMLHttpRequest|setInterval|setTimeout|requestAnimationFrame|alert|confirm)\b/, f);
    assert.doesNotMatch(code, /\bimport\b|\bexport\b|=>\s*import\(/, `${f}: a plain script, no ES module syntax`);
  }
});

test('the modules load as plain scripts in a browser-like context (a global) and as modules in Node', () => {
  for (const f of MODULES) {
    const ctx = vm.createContext({});
    vm.runInContext(read(f), ctx, { filename: f });
    assert.equal(typeof ctx[GLOBALS[f]], 'object', `${f} sets ${GLOBALS[f]}`);
    assert.deepEqual(Object.keys(ctx[GLOBALS[f]]).sort(), Object.keys(require(path.join(JS, f))).sort(), f);
  }
});

test('nothing but the tab name is remembered by the page, and the output tests are not remembered at all', () => {
  const storing = (code) => [...code.matchAll(/(localStorage|sessionStorage|document\.cookie|indexedDB)\.?\w*\(?[^;\n]*/g)].map((m) => m[0]);
  for (const f of MODULES) assert.deepEqual(storing(read(f)), [], f);
  const uses = storing(read('app.js'));
  assert.equal(uses.length, 2, 'the selected tab, written and read');
  assert.ok(uses.every((u) => /ecuTab/.test(u)), uses.join('\n'));
});

// ---- the page, run against a stubbed DOM and the real routes ----------------------------

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const call = (route, body) => routes[route](body ?? {});

async function connectBike({ autoUnlock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = autoUnlock;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  state.logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-logs-')), 'logs');
  state.gauges = null;
  state.switches = null;
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

/** The select options of the markup: { value, unit, selected } for a select id. */
function optionsOf(id) {
  const body = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!body) return [];
  return [...body[1].matchAll(/<option value="([^"]*)"([^>]*)>/g)].map((m) => ({ value: m[1], unit: (m[2].match(/data-unit="([^"]*)"/) || [])[1] ?? '', selected: /\bselected\b/.test(m[2]) }));
}

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

/** A canvas 2D context that takes every call and remembers every assignment. */
const context2d = () => new Proxy({ measureText: () => ({ width: 40 }), createLinearGradient: () => ({ addColorStop() {} }) }, {
  get: (target, key) => (key in target ? target[key] : () => {}),
  set: (target, key, value) => { target[key] = value; return true; },
});

/** The page scripts in a vm with a stub DOM (every id of index.html, nothing else), fake timers and `fetch` into the real routes. */
function loadPage() {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const tabNames = [...html.matchAll(/<button data-tab="([a-z]+)" role="tab">/g)].map((m) => m[1]);
  const elements = new Map();
  const intervals = [];
  const firstRejection = rejections.length;
  const classList = () => {
    const set = new Set();
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, force) => { if (force === undefined ? !set.has(c) : force) set.add(c); else set.delete(c); }, has: (c) => set.has(c) };
  };
  const makeElement = (id) => {
    const select = optionsOf(id);
    const el = {
      id, style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', disabled: false, checked: false,
      value: '', children: [], listeners: {}, attributes: {}, offsetParent: {}, clientWidth: 800, width: 0, height: 0,
      onclick: null, onchange: null, oninput: null, onkeydown: null,
      classList: classList(),
      addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
      appendChild(c) { el.children.push(c); return c; },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 100 }),
      getContext: () => context2d(),
      setAttribute(k, v) { el.attributes[k] = v; },
      focus() {},
      click() { return el.onclick?.(); },
    };
    if (select.length) {
      el.value = (select.find((o) => o.selected) ?? select[0]).value;
      Object.defineProperty(el, 'selectedOptions', { get: () => [{ dataset: { unit: select.find((o) => o.value === el.value)?.unit ?? '' } }] });
    }
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    if (input) {
      const v = input[0].match(/\bvalue="([^"]*)"/);
      if (v) el.value = v[1];
      el.checked = /\bchecked\b/.test(input[0]);
    }
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([^<]*)</button>`));
    if (button) el.textContent = button[1];
    const styled = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*\\bstyle="([^"]*)"`));
    const shown = styled && styled[1].match(/display:\s*([a-z]+)/);
    if (shown) el.style.display = shown[1];
    if (id === 'grScrub') el.value = '1000';
    return el;
  };
  const el = (id) => {
    if (/^tab-/.test(id) && !ids.has(id)) return null; // the page asks for a tab it may not have
    if (!ids.has(id) && !/^(g|gv|gu|gn|gf)-/.test(id)) throw new Error(`the page asked for #${id}, which index.html does not have`);
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const tabSections = tabNames.map((name) => ({ dataset: { tab: name }, classList: classList() }));
  const tabButtons = tabNames.map((name) => ({ dataset: { tab: name }, classList: classList(), setAttribute() {}, onclick: null }));
  // the panels behind the unlock: each holds the buttons and inputs that sit in its part of the markup
  const unlockPanels = [...html.matchAll(/<div class="panel" data-needs-unlock[^>]*>/g)].map((m) => {
    const rest = html.slice(m.index + m[0].length);
    const end = rest.search(/<div class="panel"|<\/section>/);
    const part = end < 0 ? rest : rest.slice(0, end);
    const own = [...part.matchAll(/<(?:button|input)\b[^>]*\bid="([^"]+)"/g)].map((x) => x[1]);
    return { classList: classList(), querySelectorAll: () => own.map(el) };
  });
  const document = {
    getElementById: el,
    createElement: () => makeElement('created'),
    querySelectorAll: (sel) => (sel === '.tab' ? tabSections : sel === '#tabs button' ? tabButtons : sel === '[data-needs-unlock]' ? unlockPanels : []),
  };
  const timers = {
    active: (ms) => intervals.filter((t) => t.active && (ms === undefined || t.ms === ms)),
    async fire(ms) { for (const t of timers.active(ms)) await t.fn(); await flush(); },
  };
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const [route, query = ''] = url.split('?');
    let out;
    if (route === '/api/ports') out = { ok: true, ports: [] };
    else {
      try {
        const handler = routes[`${method} ${route}`];
        if (!handler) throw new Error(`no route ${method} ${route}`);
        out = { ok: true, ...(await handler(method === 'POST' ? JSON.parse(opts.body || '{}') : null, new URLSearchParams(query))) };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
    }
    return { json: async () => JSON.parse(JSON.stringify(out)) };
  };
  const ctx = {
    document, fetch, console,
    setInterval: (fn, ms) => { const t = { id: intervals.length + 1, fn, ms, active: true }; intervals.push(t); return t.id; },
    clearInterval: (id) => { const t = intervals.find((x) => x.id === id); if (t) t.active = false; },
    setTimeout: () => 0,
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    confirm: () => true,
    location: { hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
  };
  ctx.window = Object.assign(ctx, { devicePixelRatio: 1, addEventListener() {} });
  vm.createContext(ctx);
  for (const f of SCRIPT_ORDER) vm.runInContext(read(f), ctx, { filename: f });
  return {
    ctx, el, timers, tabSections,
    get errors() { return rejections.slice(firstRejection); }, // promises the page left unhandled
    run: (code) => vm.runInContext(code, ctx),
    text: (id) => el(id).textContent,
    async click(id) { await el(id).onclick(); await flush(); },
  };
}

/** Run a page until it has settled after loading. */
async function openPage() {
  const page = loadPage();
  await flush(60);
  return page;
}

after(async () => {
  await call('POST /api/disconnect').catch(() => {});
});

test('a page opened with no bike connected: dials drawn from the definitions (speed in mph), nothing polled, nothing started', async () => {
  await call('POST /api/disconnect');
  const page = await openPage();
  const gauges = page.el('dash').children;
  assert.equal(gauges.length, conn.bike.gauges.length, 'one dial per gauge of the bike description');
  assert.match(gauges.find((g) => g.id === 'g-speed').innerHTML, />mph</);
  assert.deepEqual(page.timers.active(200), [], 'no gauge poll');
  assert.deepEqual(page.timers.active(700), [], 'no switch poll');
  assert.equal(page.text('btnGauges'), 'Start gauges');
  assert.equal(page.text('btnSw'), 'Watch switches');
  assert.notEqual(page.el('btnConnect').style.display, 'none');
  assert.equal(page.el('btnDisconnect').style.display, 'none');
  assert.notEqual(page.el('startCard').style.display, 'none');
  assert.deepEqual(conn.runs, []);
  assert.deepEqual(page.errors, []);
  assert.ok(page.tabSections.find((s) => s.dataset.tab === 'dashboard').classList.contains('on'), 'the dashboard tab shows first');
});

test('reload while connected: the page asks what is running, reconciles, and polls the dashboard and the switch watcher', async () => {
  await connectBike();
  const page = await openPage();
  assert.equal(page.el('btnDisconnect').style.display, '');
  assert.equal(page.text('unlockInfo'), 'ECU unlocked');
  assert.deepEqual((await call('GET /api/runs')).running.map((r) => r.feature).sort(), ['dashboard', 'switches']);
  assert.equal(page.timers.active(200).length, 1);
  assert.equal(page.timers.active(700).length, 1);
  assert.equal(page.text('btnGauges'), 'Stop gauges');
  assert.equal(page.text('btnSw'), 'Stop');

  await until(() => state.gauges.cycles >= 2);
  await page.timers.fire(200);
  assert.match(page.text('gaugeInfo'), /^\d+ cycles/);
  await page.timers.fire(700);
  // a scan of the switch ids reads in the background, one id per dashboard cycle, so the first scan may still be on its way
  await until(() => /class="tile sw/.test(page.el('swTiles').innerHTML));
  assert.match(page.el('swTiles').innerHTML, /class="tile sw/, 'the switch tiles are drawn');
  assert.deepEqual(page.errors, []);
  await call('POST /api/disconnect');
});

test('reload during a recording: nothing is started beside the recorder; when it ends the page brings the dashboard and the watcher back', async () => {
  await connectBike();
  await call('POST /api/record/start', {});
  await until(() => state.record.samples >= 2);
  const page = await openPage();

  assert.deepEqual(conn.runs, ['record'], 'only the recorder is on the line');
  assert.equal(state.gauges, null);
  assert.equal(state.switches, null);
  assert.deepEqual(page.timers.active(200), []);
  assert.deepEqual(page.timers.active(700), []);
  assert.equal(page.text('btnRec'), 'Stop recording');
  assert.equal(page.el('btnMkDied').disabled, false);
  assert.equal(page.timers.active(500).length, 1, 'the page polls the recording');

  await page.click('btnRec'); // Stop recording
  await flush();
  assert.equal(page.text('btnRec'), 'Start recording');
  assert.equal(page.el('btnMkDied').disabled, true);
  assert.deepEqual((await call('GET /api/runs')).running.map((r) => r.feature).sort(), ['dashboard', 'switches'], 'the server restored them');
  assert.equal(page.timers.active(200).length, 1, 'recording end restores the dashboard');
  assert.equal(page.timers.active(700).length, 1);
  assert.equal(page.text('btnGauges'), 'Stop gauges');
  await call('POST /api/disconnect');
});

test('the Record button: the dashboard and the watcher let go, the recording runs alone, and they are back after it', async () => {
  await connectBike();
  const page = await openPage();
  assert.equal(page.timers.active(200).length, 1);
  await page.click('btnRec');
  assert.deepEqual(conn.runs, ['record']);
  assert.deepEqual(page.timers.active(200), []);
  assert.deepEqual(page.timers.active(700), []);
  assert.equal(page.text('btnGauges'), 'Start gauges');
  assert.equal(page.text('btnSw'), 'Watch switches');
  assert.equal(page.text('btnRec'), 'Stop recording');
  await until(() => state.record.samples >= 3);
  await page.timers.fire(500);
  assert.match(page.el('recStats').innerHTML, /Samples/);

  await page.click('btnRec');
  assert.equal(page.text('btnRec'), 'Start recording');
  // the dashboard and the watcher come back once the recorder's last read is over: that takes a few turns of the event loop
  // (the page asks the server again on its status poll too, which is what brings them back if its first question came too early)
  for (let i = 0; i < 20 && !(page.timers.active(200).length === 1 && page.timers.active(700).length === 1); i++) {
    await new Promise((r) => setTimeout(r, 25));
    await page.timers.fire(2000);
  }
  assert.equal(page.timers.active(200).length, 1);
  assert.equal(page.timers.active(700).length, 1);
  assert.equal(page.text('btnGauges'), 'Stop gauges');
  await call('POST /api/disconnect');
});

test('Stop on the dashboard turns it off until the next connection; the watcher keeps going; Start turns it on again', async () => {
  await connectBike();
  const page = await openPage();
  await page.click('btnGauges'); // Stop gauges
  assert.equal(page.text('btnGauges'), 'Start gauges');
  assert.deepEqual(page.timers.active(200), []);
  assert.equal(state.gauges.running, false);
  assert.equal(page.timers.active(700).length, 1, 'only the dashboard was stopped');

  for (let i = 0; i < 3; i++) await page.timers.fire(2000); // the status poll: it must not start it again
  await call('POST /api/record/start', {});
  await page.timers.fire(2000);
  await call('POST /api/record/stop');
  await flush();
  await page.timers.fire(2000);
  assert.equal(state.gauges.running, false, 'nothing restarts it behind the owner\'s back');
  assert.deepEqual(page.timers.active(200), []);
  assert.equal(page.timers.active(700).length, 1);

  await page.click('btnGauges'); // Start gauges
  assert.equal(page.text('btnGauges'), 'Stop gauges');
  assert.equal(page.timers.active(200).length, 1);
  assert.equal(state.gauges.running, true);

  await page.click('btnSw'); // Stop the watcher
  assert.equal(page.text('btnSw'), 'Watch switches');
  assert.deepEqual(page.timers.active(700), []);
  await page.timers.fire(2000);
  assert.deepEqual(page.timers.active(700), [], 'and it stays off');
  assert.deepEqual(page.errors, []);
  await call('POST /api/disconnect');
});

test('Stop, Disconnect, Connect: the next connection starts them again by itself', async () => {
  await connectBike();
  const page = await openPage();
  await page.click('btnGauges'); // Stop gauges
  await page.click('btnSw'); // Stop the watcher
  assert.deepEqual((await call('GET /api/runs')).running, []);

  await page.click('btnDisconnect');
  assert.equal(page.el('btnConnect').style.display, '');
  assert.deepEqual(page.timers.active(200), []);

  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  page.el('ports').value = 'MOCK';
  await page.click('btnConnect');
  await flush();
  assert.equal(page.el('btnDisconnect').style.display, '');
  assert.deepEqual((await call('GET /api/runs')).running.map((r) => r.feature).sort(), ['dashboard', 'switches'], 'the owner\'s stops did not outlive the connection');
  assert.equal(page.timers.active(200).length, 1);
  assert.equal(page.timers.active(700).length, 1);
  assert.equal(page.text('btnGauges'), 'Stop gauges');
  await call('POST /api/disconnect');
});

test('locked: the dashboard starts and the watcher waits; unlocking (the page\'s own button) starts the watcher, drawing the unlock state starts nothing', async () => {
  await connectBike({ autoUnlock: false });
  const page = await openPage();
  assert.equal(page.text('unlockInfo'), 'ECU locked');
  assert.equal(page.el('btnUnlock').style.display, '');
  assert.equal(page.timers.active(200).length, 1);
  assert.deepEqual(page.timers.active(700), [], 'the watcher waits for the unlock');
  assert.equal(state.switches, null);
  assert.equal(page.el('btnSw').disabled, true, 'the unlock panels are shut');

  // drawing alone never starts a run
  page.run('renderUnlock(); renderUnlock();');
  await flush();
  assert.equal(state.switches, null);

  await page.click('btnUnlock');
  await flush();
  assert.equal(page.text('unlockInfo'), 'ECU unlocked');
  assert.equal(page.el('btnSw').disabled, false, 'the unlock panels are open');
  assert.equal(page.timers.active(700).length, 1, 'the switch watcher is polled once unlocked');
  assert.deepEqual((await call('GET /api/runs')).running.map((r) => r.feature).sort(), ['dashboard', 'switches']);
  await call('POST /api/disconnect');
});

test('a lost connection (the status poll says so): every poll is let go and the page says why', async () => {
  await connectBike();
  const page = await openPage();
  await call('POST /api/disconnect');
  await page.timers.fire(2000);
  assert.deepEqual(page.timers.active(200), []);
  assert.deepEqual(page.timers.active(700), []);
  assert.equal(page.el('btnConnect').style.display, '');
  assert.equal(page.text('btnGauges'), 'Start gauges');
  assert.equal(page.text('msg'), 'Disconnected.');
});

test('the output tests panel: enabled by the checkbox and the button, per page session; a disconnect turns it off again', async () => {
  await connectBike();
  const page = await openPage();
  assert.equal(page.el('btnOutEnable').disabled, true);
  page.el('outAck').checked = true;
  page.run('outButtons()');
  assert.equal(page.el('btnOutEnable').disabled, false);
  await page.click('btnOutEnable');
  assert.equal(page.el('outIntro').style.display, 'none');
  assert.equal(page.el('outMain').style.display, '');
  assert.equal(page.run('outTests.length'), 8, 'the whitelist of eight');
  assert.ok(page.run('outToken'));
  await page.click('btnDisconnect');
  assert.equal(page.run('outToken'), null);
  assert.equal(page.el('outIntro').style.display, '');
  assert.equal(page.el('outMain').style.display, 'none');
  assert.equal(page.el('outAck').checked, false);
});

test('graphs and the fuel map: a poll feeds the store and the map; the metric, the axis and Clear map act on them', async () => {
  await call('POST /api/disconnect');
  state.gauges = null; // not the kept run of an earlier test: the page would draw that one first
  const page = await openPage();
  const feed = (rows, elapsedMs) => page.run(`feedGraph('gauges', ${JSON.stringify(rows)}, ${elapsedMs})`);
  feed({ rpm: [[0, 3000], [100, 3000]], tps: [[0, 29.4], [100, 29.4]], injPulse1: [[0, 2], [100, 4]] }, 200);
  assert.equal(page.run('graphs.since("gauges")'), 100);
  assert.equal(page.run('fmap.live.count'), 2);

  page.run('drawGraphs()');
  assert.match(page.text('fmInfo'), /^2 samples, 3\.0 to 3\.0 ms\. Live\./);
  assert.equal(page.el('grScrub').style.display, 'none');

  page.el('fmMetric').value = 'injDuty';
  page.el('fmMetric').onchange();
  assert.match(page.text('fmInfo'), /^2 samples, 7\.5 to 7\.5 %\./, 'duty % = pulse x rpm / 1200, averaged over the two samples');
  assert.equal(page.el('fmFlowBox').style.display, 'none');

  page.el('fmMetric').value = 'injFlow';
  page.el('fmMetric').onchange();
  assert.match(page.text('fmInfo'), /^Type the size of one injector/);
  assert.equal(page.el('fmFlowBox').style.display, '');
  page.el('fmFlow').value = '250';
  page.el('fmFlow').onchange();
  assert.match(page.text('fmInfo'), /^2 samples, 56\.3 to 56\.3 cc\/min/, '7.5 % x 250 x 3 / 100 = 56.25');

  page.el('fmAxis').value = 'map';
  page.el('fmAxis').onchange();
  assert.match(page.text('fmInfo'), /^Nothing yet/, 'no manifold pressure was fed: the map has nothing');

  page.el('fmAxis').value = 'tps';
  page.el('fmMetric').value = 'injPulse1';
  page.el('fmMetric').onchange();
  assert.equal(page.run('fmap.live.count'), 2);
  await page.click('btnFmReset');
  assert.equal(page.run('fmap.live.count'), 0, 'Clear map starts over');
  assert.match(page.text('fmInfo'), /^Nothing yet/);
  feed({ rpm: [[0, 3000], [100, 3000], [200, 3000]], tps: [[0, 29.4], [100, 29.4], [200, 29.4]], injPulse1: [[0, 2], [100, 4], [200, 6]] }, 300);
  assert.equal(page.run('fmap.live.count'), 1, 'only samples from now on count');

  // a new run of the dashboard (the run time goes back) is taken from the start
  feed({ rpm: [[0, 3500]] }, 50);
  assert.equal(page.run('graphs.since("gauges")'), -1);

  // the vitals strip reads the store
  page.run('renderVitals()');
  assert.match(page.el('vitals').innerHTML, /<div class="n">Engine<\/div><div class="v">3000 <span class="u">rpm/);
  assert.deepEqual(page.errors, []);
});

test('a saved recording opens as graphs and a fuel map of its own, and Back to live returns', async () => {
  await connectBike();
  await call('POST /api/record/start', {});
  await until(() => state.record.samples >= 3);
  await call('POST /api/record/stop');
  const page = await openPage();
  await flush();
  const { recordings } = await call('GET /api/recordings');
  assert.ok(recordings.length >= 1, 'the recording is listed');
  assert.match(page.el('grFiles').innerHTML, /record-/, 'the page lists it');

  page.el('grFiles').value = recordings[0].name;
  await page.click('btnGrLoad');
  assert.equal(page.el('btnGrLive').style.display, '');
  assert.equal(page.run('graphs.replay.name'), recordings[0].name);
  assert.equal(page.el('grWindow').value, '0');
  assert.match(page.text('grInfo'), /long, \d+ events, \d+ notes/);
  page.run('drawGraphs()');
  assert.equal(page.el('grScrub').style.display, '', 'the slider is there for a recording');
  assert.match(page.text('fmInfo'), /^(Nothing yet|\d+ samples.*From record-)/);

  await page.click('btnGrLive');
  assert.equal(page.run('graphs.replay'), null);
  assert.equal(page.el('btnGrLive').style.display, 'none');
  assert.equal(page.el('grWindow').value, '60000');
  assert.equal(page.text('grInfo'), 'Live again.');
  assert.deepEqual(page.errors, []);
  await call('POST /api/disconnect');
});

test('a tab remembers itself and the hash picks it', async () => {
  const page = await openPage();
  page.run("showTab('graphs')");
  assert.ok(page.tabSections.find((s) => s.dataset.tab === 'graphs').classList.contains('on'));
  assert.ok(!page.tabSections.find((s) => s.dataset.tab === 'dashboard').classList.contains('on'));
  page.run("showTab('nonsense')");
  assert.ok(page.tabSections.find((s) => s.dataset.tab === 'dashboard').classList.contains('on'), 'an unknown tab is the dashboard');
});
