'use strict';

// Who may use the K-line, seen through the GUI server's routes the way the page calls them: the reload during a
// recording, the owner's Stop, the start-by-itself policy (GET /api/runs and the POST /api/runs routes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, runs, state } = require('../server');
const { MockEcuTransport } = require('./mockecu');

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
const running = async () => (await call('GET /api/runs')).running.map((r) => r.feature).sort();

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
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

test('GET /api/runs says nothing runs before a connection, and needs no session to ask', async () => {
  await call('POST /api/disconnect');
  assert.deepEqual(await call('GET /api/runs'), { connected: false, exclusive: null, running: [], paused: [], stoppedByOwner: [], waiting: [] });
  await assert.rejects(() => call('POST /api/runs/reconcile'), /not connected/);
  await assert.rejects(() => call('POST /api/runs/start', { feature: 'dashboard' }), /not connected/);
});

test('reload during a recording: the page connects, starts its gauges and polls the switches, and none of it starts a run beside the recorder', async () => {
  const t = await connectBike();
  await call('POST /api/record/start', {});
  await until(() => state.record.samples >= 2);
  const recording = state.record;

  // what the reloaded page does: it asks for the gauges and the switches before it has asked about the recording
  const g = await call('POST /api/gauges/start');
  assert.equal(g.paused, true);
  assert.match(g.note, /a recording is running: the dashboard starts again when it ends/);
  const sw = await call('GET /api/switches');
  assert.deepEqual({ available: sw.available, rows: sw.rows, analogs: sw.analogs, paused: sw.paused }, { available: false, rows: [], analogs: [], paused: true });
  assert.match(sw.note, /a recording is running: the switch watcher starts again when it ends/);
  assert.equal((await call('POST /api/runs/reconcile')).started.length, 0);

  assert.deepEqual(conn.runs, ['record'], 'only the recorder is on the line');
  assert.equal(state.gauges, null, 'no gauge run was made');
  assert.equal(state.switches, null, 'no switch run was made');
  const dials = await call('GET /api/gauges');
  assert.equal(dials.running, false);
  const view = await call('GET /api/runs');
  assert.equal(view.exclusive, 'recording');
  assert.deepEqual(view.running.map((r) => [r.feature, r.role, r.run]), [['recording', 'exclusive', 'record']]);
  assert.deepEqual(view.paused.map((p) => [p.feature, p.by]), [['dashboard', 'recording'], ['switches', 'recording']]);
  assert.deepEqual(view.stoppedByOwner, []);

  // the recording ends: what the page asked for comes up, and the switches can be polled
  await call('POST /api/record/stop');
  await tick();
  assert.equal(recording.running, false);
  assert.deepEqual(await running(), ['dashboard', 'switches']);
  await until(() => state.gauges.cycles >= 1);
  const after = await call('GET /api/switches');
  assert.equal(after.available, true);
  assert.equal(after.paused, undefined);
  assert.ok(after.rows.length > 0);
  assert.equal((await call('GET /api/runs')).paused.length, 0);
  assert.ok(t.requests.length > 0);
  await call('POST /api/disconnect');
});

test('a recording started while the dashboard and the switch watcher run stops them and brings them back at its end', async () => {
  await connectBike();
  await call('POST /api/gauges/start');
  await call('GET /api/switches');
  assert.deepEqual(await running(), ['dashboard', 'switches']);
  await call('POST /api/record/start', {});
  assert.deepEqual(await running(), ['recording']);
  assert.deepEqual(conn.runs, ['record']);
  await call('POST /api/record/stop');
  await tick();
  assert.deepEqual(await running(), ['dashboard', 'switches']);
  await call('POST /api/disconnect');
  assert.deepEqual(conn.runs, []);
  assert.deepEqual(await running(), [], 'a disconnect leaves nothing running');
});

test('a disconnect during a recording leaves nothing running and nothing waiting to come back', async () => {
  await connectBike();
  await call('POST /api/gauges/start');
  await call('POST /api/record/start', {});
  await call('POST /api/disconnect');
  await until(() => !state.record.running);
  await tick();
  assert.deepEqual(conn.runs, []);
  const s = await call('GET /api/runs');
  assert.deepEqual([s.connected, s.running, s.paused], [false, [], []]);
});

test('an id scan takes the line from the dashboard too, and the dashboard comes back after it', async () => {
  await connectBike();
  await call('POST /api/gauges/start');
  await call('POST /api/discover/start', { from: 0, to: 0x30 });
  assert.equal((await call('GET /api/runs')).exclusive, 'scan');
  assert.equal(state.gauges.running, false);
  assert.equal((await call('POST /api/gauges/start')).paused, true);
  await until(() => !state.discover.running);
  await tick();
  assert.equal(state.gauges.running, true);
  assert.equal((await call('GET /api/discover')).outcome, 'finished');
  await call('POST /api/disconnect');
});

test('the owner\'s Stop sticks: a recording ending and reconcile do not restart the dashboard; the owner\'s Start does', async () => {
  await connectBike();
  await call('POST /api/runs/reconcile');
  assert.deepEqual(await running(), ['dashboard', 'switches']);

  const stopped = await call('POST /api/runs/stop', { feature: 'dashboard' });
  assert.deepEqual(stopped.runs.stoppedByOwner, ['dashboard']);
  assert.equal(state.gauges.running, false);
  await call('POST /api/record/start', {});
  await call('POST /api/record/stop');
  await tick();
  assert.deepEqual(await running(), ['switches'], 'the watcher came back, the dashboard did not');
  assert.deepEqual((await call('POST /api/runs/reconcile')).started, []);

  const started = await call('POST /api/runs/start', { feature: 'dashboard' });
  assert.equal(started.started, true);
  assert.deepEqual(started.runs.stoppedByOwner, []);
  assert.deepEqual(await running(), ['dashboard', 'switches']);
  await call('POST /api/disconnect');
});

test('POST /api/gauges/stop is the owner\'s Stop of the dashboard too', async () => {
  await connectBike();
  await call('POST /api/gauges/start');
  await call('POST /api/gauges/stop');
  assert.deepEqual((await call('GET /api/runs')).stoppedByOwner, ['dashboard']);
  await call('POST /api/gauges/start');
  assert.deepEqual((await call('GET /api/runs')).stoppedByOwner, []);
  await call('POST /api/disconnect');
});

test('the owner stopped the switch watcher: a late poll gets a paused answer and starts nothing; every new connection starts over', async () => {
  await connectBike();
  await call('GET /api/switches');
  await call('POST /api/runs/stop', { feature: 'switches' });
  const late = await call('GET /api/switches');
  assert.deepEqual({ available: late.available, rows: late.rows, paused: late.paused }, { available: false, rows: [], paused: true });
  assert.match(late.note, /the switch watcher was stopped/);
  assert.equal(state.switches.running, false);

  await call('POST /api/disconnect');
  assert.deepEqual((await call('GET /api/runs')).stoppedByOwner, []);
  await connectBike();
  assert.deepEqual((await call('POST /api/runs/reconcile')).started, ['dashboard', 'switches']);
  await call('POST /api/disconnect');
});

test('reconcile once connected: the dashboard runs locked, the switch watcher waits for the unlock and says so', async () => {
  await connectBike({ autoUnlock: false });
  const r = await call('POST /api/runs/reconcile');
  assert.deepEqual(r.started, ['dashboard']);
  assert.deepEqual(r.runs.waiting.map((w) => w.feature), ['switches']);
  assert.match(r.runs.waiting[0].why, /^needs the ECU unlock, not available/);
  const s = await call('POST /api/runs/start', { feature: 'switches' });
  assert.deepEqual([s.started, s.unavailable], [false, true]);
  assert.match(s.note, /needs the ECU unlock/);

  await call('POST /api/unlock');
  assert.deepEqual((await call('POST /api/runs/reconcile')).started, ['switches']);
  await call('POST /api/disconnect');
});

test('the run routes check the feature name', async () => {
  await connectBike();
  for (const route of ['POST /api/runs/start', 'POST /api/runs/stop']) {
    await assert.rejects(() => call(route, { feature: 'recording' }), /feature must be one of: dashboard, switches/, route);
    await assert.rejects(() => call(route, {}), /feature must be one of/, route);
  }
  await call('POST /api/disconnect');
});

test('the compatibility state reads the coordinator and only accepts null', async () => {
  await connectBike();
  await call('POST /api/discover/start', { from: 0, to: 0x05 });
  await until(() => !state.discover.running);
  state.discover = null;
  assert.equal((await call('GET /api/discover')).active, false);
  assert.throws(() => { state.record = {}; }, /owned by the run coordinator/);
  assert.equal(state.logDir, runs.logDir);
  await call('POST /api/disconnect');
});
