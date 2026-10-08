'use strict';

// The page's session state (public/js/session.js), loaded with require() the way the page loads it as a script:
// what should be running, decided from the facts and the server's GET /api/runs. The first tests give it facts
// and read the actions; the last ones run it against the real routes and the mock ECU the way the page does.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SessionState = require('../public/js/session');
const { routes, conn, state } = require('../server');
const { MockEcuTransport } = require('./mockecu');

const { decide } = SessionState;

/** What GET /api/runs answers, from a short description. */
const runsOf = ({ connected = true, exclusive = null, running = [], stopped = [], waiting = [], paused = [] } = {}) => ({
  connected,
  exclusive,
  running: running.map((feature) => ({ feature, role: 'background', run: feature, startedAt: 0 })),
  paused: paused.map((feature) => ({ feature, by: exclusive, why: 'x', note: 'x' })),
  stoppedByOwner: stopped,
  waiting: waiting.map((feature) => ({ feature, why: 'needs the ECU unlock, not available' })),
});
const facts = (runs, extra = {}) => ({ connected: true, unlock: 'unlocked', runs, ui: {}, ...extra });
const poll = (feature, on) => ({ type: 'poll', feature, on });
const RECONCILE = { type: 'reconcile' };

// ---- decide: the rules ------------------------------------------------------

test('decide: nothing is started or attached before the server has been asked', () => {
  assert.deepEqual(decide(facts(null)), []);
  assert.deepEqual(decide(facts(null, { ui: { dashboard: true } })), [], 'a poll that is on is left alone until the server says');
});

test('decide: connected, unlocked, nothing runs: ask the server to start what should run', () => {
  assert.deepEqual(decide(facts(runsOf())), [RECONCILE]);
});

test('decide: reload during a recording starts nothing and attaches nothing', () => {
  const runs = runsOf({ exclusive: 'recording', paused: ['dashboard', 'switches'] });
  assert.deepEqual(decide(facts(runs)), []);
  assert.deepEqual(decide(facts(runs, { ui: { dashboard: true, switches: true } })), [poll('dashboard', false), poll('switches', false)], 'a page that was polling lets go');
  assert.deepEqual(decide(facts(runsOf({ exclusive: 'scan' }))), [], 'an id scan holds the line the same way');
});

test('decide: the recording ends and the server brought the dashboard and the watcher back: the page follows', () => {
  const back = runsOf({ running: ['dashboard', 'switches'] });
  assert.deepEqual(decide(facts(back)), [poll('dashboard', true), poll('switches', true)]);
  assert.deepEqual(decide(facts(back, { ui: { dashboard: true, switches: true } })), [], 'nothing left to do');
});

test('decide: the recording ended but nothing was brought back (the owner stopped neither): ask for it', () => {
  assert.deepEqual(decide(facts(runsOf())), [RECONCILE]);
});

test('decide: what the owner stopped stays off; only the rest is asked for', () => {
  const dashStopped = runsOf({ stopped: ['dashboard'], running: ['switches'] });
  assert.deepEqual(decide(facts(dashStopped, { ui: { dashboard: true } })), [poll('dashboard', false), poll('switches', true)], 'no reconcile for the stopped one');
  const both = runsOf({ stopped: ['dashboard', 'switches'] });
  assert.deepEqual(decide(facts(both)), []);
  const swStopped = runsOf({ stopped: ['switches'], running: ['dashboard'] });
  assert.deepEqual(decide(facts(swStopped)), [poll('dashboard', true)]);
});

test('decide: after a new connection the server\'s list is empty again, so the stopped feature is asked for', () => {
  assert.deepEqual(decide(facts(runsOf({ stopped: ['dashboard'] }))), [RECONCILE], 'the switch watcher is still wanted');
  assert.deepEqual(decide(facts(runsOf({ stopped: [] }))), [RECONCILE]);
});

test('decide: locked, only the dashboard is wanted; once unlocked the switch watcher is too', () => {
  const locked = runsOf({ running: ['dashboard'], waiting: ['switches'] });
  assert.deepEqual(decide(facts(locked, { unlock: 'locked', ui: { dashboard: true } })), [], 'nothing to ask for: the watcher waits for the unlock');
  assert.deepEqual(decide(facts(locked, { unlock: 'unlocked', ui: { dashboard: true } })), [RECONCILE], 'unlocking starts the switch watcher');
  assert.deepEqual(decide(facts(runsOf({ running: ['dashboard', 'switches'] }), { unlock: 'locked' })), [poll('dashboard', true)], 'a watcher is only polled while unlocked');
  for (const unlock of ['unavailable', 'invalid', 'failed', 'unlocking']) {
    assert.deepEqual(decide(facts(runsOf({ running: ['dashboard'] }), { unlock, ui: { dashboard: true } })), [], unlock);
  }
});

test('decide: not connected (the page\'s view, or the server\'s) lets go of every poll and asks for nothing', () => {
  const on = { dashboard: true, switches: true };
  assert.deepEqual(decide({ connected: false, unlock: 'unavailable', runs: null, ui: on }), [poll('dashboard', false), poll('switches', false)]);
  assert.deepEqual(decide({ connected: false, unlock: 'unlocked', runs: runsOf({ running: ['dashboard'] }), ui: {} }), []);
  assert.deepEqual(decide(facts(runsOf({ connected: false }), { ui: on })), [poll('dashboard', false), poll('switches', false)]);
  assert.deepEqual(decide(facts(runsOf({ connected: false }))), []);
});

// ---- the planner: a reconcile is not asked twice for the same facts -----------

test('planner: the same facts do not ask for a reconcile twice; changed facts do; not connected forgets', () => {
  const planner = SessionState.createPlanner();
  const none = facts(runsOf());
  assert.deepEqual(planner.plan(none), [RECONCILE]);
  assert.deepEqual(planner.plan(none), [], 'a start that did not happen is not retried on every poll');
  assert.deepEqual(planner.plan(facts(runsOf(), { unlock: 'locked' })), [RECONCILE], 'the unlock changed');
  assert.deepEqual(planner.plan(facts(runsOf({ waiting: ['switches'] }), { unlock: 'locked' })), [RECONCILE], 'what the server says is waiting changed');
  assert.deepEqual(planner.plan(facts(runsOf({ waiting: ['switches'] }), { unlock: 'locked' })), []);
  assert.deepEqual(planner.plan(facts(runsOf({ exclusive: 'recording' }))), []);
  assert.deepEqual(planner.plan(none), [RECONCILE], 'the recording came and went: ask again');

  planner.plan({ connected: false, unlock: 'unavailable', runs: null, ui: {} });
  assert.deepEqual(planner.plan(none), [RECONCILE], 'a new connection starts over');
});

test('planner: polls are never held back, only the reconcile is remembered', () => {
  const planner = SessionState.createPlanner();
  const f = facts(runsOf({ running: ['dashboard'], stopped: ['switches'] }));
  assert.deepEqual(planner.plan(f), [poll('dashboard', true)]);
  assert.deepEqual(planner.plan(f), [poll('dashboard', true)], 'asked again while the page has not done it');
});

// ---- the controller with a fake server ------------------------------------------

/** An api that answers from a script and writes down what it was asked, and a page whose polls are plain flags. */
function fakePage(answers) {
  const calls = [];
  const polls = { dashboard: false, switches: false };
  const api = async (method, url, body) => {
    calls.push(`${method} ${url}${body ? ' ' + JSON.stringify(body) : ''}`);
    const answer = answers[`${method} ${url}`];
    if (answer === undefined) throw new Error(`unexpected ${method} ${url}`);
    return { ok: true, ...(typeof answer === 'function' ? answer(body) : answer) };
  };
  const ui = { polling: (f) => polls[f], setPolling: (f, on) => { polls[f] = on; } };
  return { calls, polls, controller: SessionState.createController({ api, ui }) };
}

test('controller: connect, then ask what is running, then reconcile (in that order), then follow the answer', async () => {
  let running = [];
  const page = fakePage({
    'GET /api/runs': () => runsOf({ running }),
    'POST /api/runs/reconcile': () => { running = ['dashboard', 'switches']; return { started: ['dashboard', 'switches'], runs: runsOf({ running }) }; },
  });
  const r = await page.controller.sync({ connected: true, unlock: 'unlocked' });
  assert.deepEqual(page.calls, ['GET /api/runs', 'POST /api/runs/reconcile']);
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  assert.deepEqual(r.running.map((x) => x.feature), ['dashboard', 'switches']);
  assert.equal(page.controller.runs, r);

  await page.controller.sync({ connected: true, unlock: 'unlocked' });
  assert.deepEqual(page.calls.slice(2), ['GET /api/runs'], 'nothing more to ask for');
});

test('controller: a page loaded during a recording asks, sees it, and sends no reconcile and no start', async () => {
  const page = fakePage({ 'GET /api/runs': () => runsOf({ exclusive: 'recording', paused: ['dashboard', 'switches'] }) });
  await page.controller.sync({ connected: true, unlock: 'unlocked' });
  assert.deepEqual(page.calls, ['GET /api/runs']);
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
});

test('controller: not connected asks nothing and lets go of the polls', async () => {
  const page = fakePage({});
  page.polls.dashboard = page.polls.switches = true;
  assert.equal(await page.controller.sync({ connected: false, unlock: 'unavailable' }), null);
  assert.deepEqual(page.calls, []);
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
  assert.equal(page.controller.runs, null);
});

test('controller: a reconcile that fails is not retried until the facts change', async () => {
  let asked = 0;
  const page = fakePage({
    'GET /api/runs': () => runsOf(),
    'POST /api/runs/reconcile': () => { asked++; throw new Error('not connected'); },
  });
  await page.controller.sync({ connected: true, unlock: 'locked' });
  await page.controller.sync({ connected: true, unlock: 'locked' });
  assert.equal(asked, 1);
  await page.controller.sync({ connected: true, unlock: 'unlocked' });
  assert.equal(asked, 2);
});

test('controller: calls run one after the other', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const page = fakePage({
    'GET /api/runs': async () => { order.push('runs'); await gate; return runsOf({ running: ['dashboard'], stopped: ['switches'] }); },
  });
  const first = page.controller.sync({ connected: true, unlock: 'unlocked' });
  const second = page.controller.sync({ connected: false });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['runs'], 'the second waits for the first');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(page.polls, { dashboard: false, switches: false }, 'the later call had the last word');
});

test('controller: the owner\'s button stops what the page polls and starts what it does not, and says why a start is held', async () => {
  const page = fakePage({
    'POST /api/runs/stop': ({ feature }) => ({ runs: runsOf({ stopped: [feature], running: feature === 'dashboard' ? ['switches'] : ['dashboard'] }) }),
    'POST /api/runs/start': ({ feature }) => ({ started: false, paused: true, note: `a recording is running: ${feature} starts again when it ends`, runs: runsOf({ exclusive: 'recording' }) }),
  });
  page.polls.dashboard = page.polls.switches = true;
  assert.deepEqual(await page.controller.toggle('dashboard', { connected: true, unlock: 'unlocked' }), { stopped: true });
  assert.deepEqual(page.calls, ['POST /api/runs/stop {"feature":"dashboard"}']);
  assert.deepEqual(page.polls, { dashboard: false, switches: true });

  const held = await page.controller.toggle('dashboard');
  assert.deepEqual([held.started, held.paused, held.unavailable], [false, true, false]);
  assert.match(held.note, /a recording is running/);
  assert.deepEqual(page.polls, { dashboard: false, switches: false }, 'nothing to poll while the recording holds the line');
  assert.throws(() => page.controller.toggle('recording'), /feature must be one of/);
});

// ---- the controller with the real routes and the mock ECU ---------------------------

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const tick = () => new Promise((r) => setImmediate(r));
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
  state.gauges = null; // forget the runs the tests before this one left behind: what a test sees is what it made
  state.switches = null;
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

/** The page's `api` against the real routes: the same answers (ok + the route's object) and the same throwing. */
const routeApi = async (method, url, body) => {
  const [route, query = ''] = url.split('?');
  const handler = routes[`${method} ${route}`];
  if (!handler) throw new Error(`no route ${method} ${route}`);
  return { ok: true, ...(await handler(method === 'POST' ? body ?? {} : null, new URLSearchParams(query))) };
};

/** A page: the controller on the real routes, its polls as flags, and the unlock state it last learned from GET /api/status. */
function realPage() {
  const polls = { dashboard: false, switches: false };
  const controller = SessionState.createController({ api: routeApi, ui: { polling: (f) => polls[f], setPolling: (f, on) => { polls[f] = on; } } });
  const sync = async () => {
    const s = await routeApi('GET', '/api/status');
    return controller.sync({ connected: s.connected, unlock: s.unlock });
  };
  return { polls, controller, sync };
}
const runningNow = async () => (await call('GET /api/runs')).running.map((r) => r.feature).sort();

test('page + server: connecting reconciles once; the dashboard and the watcher run and are polled', async () => {
  await connectBike();
  const page = realPage();
  assert.deepEqual(await runningNow(), [], 'nothing runs until the page asks');
  await page.sync();
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  await page.sync();
  assert.deepEqual(await runningNow(), ['dashboard', 'switches'], 'asking again changes nothing');
  await call('POST /api/disconnect');
  await page.sync();
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
});

test('page + server: a reload during a recording starts nothing; when the recording ends the dashboard is back and polled', async () => {
  const t = await connectBike();
  await call('POST /api/record/start', {});
  await until(() => state.record.samples >= 2);
  const recording = state.record;

  const reloaded = realPage(); // a fresh page: no polls, no memory
  await reloaded.sync();
  assert.deepEqual(conn.runs, ['record'], 'only the recorder is on the line');
  assert.equal(state.gauges, null, 'no dashboard run was made beside the recorder');
  assert.equal(state.switches, null, 'no switch run was made beside the recorder');
  assert.deepEqual(reloaded.polls, { dashboard: false, switches: false });
  assert.equal((await call('GET /api/runs')).exclusive, 'recording');
  await reloaded.sync();
  assert.deepEqual(conn.runs, ['record'], 'asking again does not start anything either');

  await call('POST /api/record/stop');
  await tick();
  assert.equal(recording.running, false);
  await reloaded.sync();
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);
  assert.deepEqual(reloaded.polls, { dashboard: true, switches: true });
  await until(() => state.gauges.cycles >= 1);
  assert.ok(t.requests.length > 0);
  await call('POST /api/disconnect');
});

test('page + server: starting a recording from a page that polls: its polls let go, and come back at the end', async () => {
  await connectBike();
  const page = realPage();
  await page.sync();
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  await call('POST /api/record/start', {});
  await page.sync();
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
  assert.deepEqual(conn.runs, ['record']);
  await call('POST /api/record/stop');
  await tick();
  await page.sync();
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);
  await call('POST /api/disconnect');
});

test('page + server: the owner\'s Stop is remembered until the next connection; Start by the owner clears it', async () => {
  await connectBike();
  const page = realPage();
  await page.sync();
  assert.deepEqual(await page.controller.toggle('dashboard', { connected: true, unlock: 'unlocked' }), { stopped: true });
  assert.deepEqual(page.polls, { dashboard: false, switches: true });
  assert.equal(state.gauges.running, false);
  assert.deepEqual((await call('GET /api/runs')).stoppedByOwner, ['dashboard']);

  // a recording comes and goes, the page syncs over and over: the dashboard stays off
  await call('POST /api/record/start', {});
  await page.sync();
  await call('POST /api/record/stop');
  await tick();
  await page.sync();
  await page.sync();
  assert.deepEqual(await runningNow(), ['switches']);
  assert.deepEqual(page.polls, { dashboard: false, switches: true });

  // the owner stops the watcher too: nothing is left running, and nothing is started behind their back
  await page.controller.toggle('switches');
  await page.sync();
  assert.deepEqual(await runningNow(), []);
  assert.deepEqual(page.polls, { dashboard: false, switches: false });

  // the owner starts the dashboard again
  const started = await page.controller.toggle('dashboard');
  assert.equal(started.started, true);
  assert.deepEqual(page.polls, { dashboard: true, switches: false });

  // the next connection forgets the stops
  await call('POST /api/disconnect');
  await page.sync();
  await connectBike();
  await page.sync();
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  await call('POST /api/disconnect');
});

test('page + server: the owner pressing Start during a recording is told it waits, and it starts when the recording ends', async () => {
  await connectBike();
  const page = realPage();
  await page.sync();
  await page.controller.toggle('dashboard', { connected: true, unlock: 'unlocked' }); // stop
  await call('POST /api/record/start', {});
  await page.sync();
  const r = await page.controller.toggle('dashboard');
  assert.deepEqual([r.started, r.paused], [false, true]);
  assert.match(r.note, /a recording is running: the dashboard starts again when it ends/);
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
  await call('POST /api/record/stop');
  await tick();
  await page.sync();
  assert.deepEqual(page.polls.dashboard, true, 'it came back at the end of the recording');
  await call('POST /api/disconnect');
});

test('page + server: locked, the dashboard runs and the watcher waits; unlocking starts the watcher', async () => {
  await connectBike({ autoUnlock: false });
  const page = realPage();
  await page.sync();
  assert.deepEqual(await runningNow(), ['dashboard']);
  assert.deepEqual(page.polls, { dashboard: true, switches: false });
  assert.deepEqual((await call('GET /api/runs')).waiting.map((w) => w.feature), ['switches']);
  assert.equal(state.switches, null);

  await call('POST /api/unlock');
  await page.sync();
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);
  assert.deepEqual(page.polls, { dashboard: true, switches: true });
  await call('POST /api/disconnect');
});

test('page + server: during an output test the dials and tiles are brought up, except while a recording holds the line', async () => {
  await connectBike();
  const page = realPage();
  await page.sync();
  await page.controller.toggle('dashboard', { connected: true, unlock: 'unlocked' });
  await page.controller.toggle('switches');
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
  await page.controller.afterOutputTestStart({ connected: true, unlock: 'unlocked' });
  assert.deepEqual(page.polls, { dashboard: true, switches: true }, 'the owner\'s Start, as pressing both buttons was');
  assert.deepEqual(await runningNow(), ['dashboard', 'switches']);

  await call('POST /api/record/start', {});
  await page.sync();
  await page.controller.afterOutputTestStart();
  assert.deepEqual(page.polls, { dashboard: false, switches: false });
  assert.deepEqual(conn.runs, ['record']);
  await call('POST /api/record/stop');
  await tick();
  await call('POST /api/disconnect');
});
