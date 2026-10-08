'use strict';

// The run coordinator (src/runs.js) seen only through its interface: who may use the K-line, in what
// order, what the owner stopped, what comes back. Most of it runs against fake runs and a fake
// connection (nothing varies across the seam but the run factories); the last tests use the real
// features on a mock ECU to check the line-priority tuning and the end of a connection.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuns, backgroundWaitFor, RUNNING_RPM, BACKGROUND_WAIT_RUNNING_MS, BACKGROUND_WAIT_IDLE_MS } = require('../src/runs');
const { Connection } = require('../src/connection');
const { MockEcuTransport } = require('./mockecu');

const tick = () => new Promise((r) => setImmediate(r)); // lets the coordinator's restore (a microtask) happen
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};

// ---- fakes ------------------------------------------------------------------

class FakeRun extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.running = true;
    this.started = false;
    this.startedAt = 0;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.finish('cancelled');
  }

  finish(outcome = 'finished') {
    if (!this.running) return;
    this.running = false;
    this.emit('end', outcome);
  }
}

function fakeConn() {
  const conn = new EventEmitter();
  conn.session = { waits: [], setBackgroundWaitMs(ms) { this.waits.push(ms); } };
  conn.requireSession = () => {
    if (!conn.session) throw new Error('not connected');
    return conn.session;
  };
  conn.drop = (state = 'disconnected') => { // the connection ends: its runs are cancelled by whoever made them
    conn.session = null;
    conn.emit('state', { state });
  };
  conn.connectAgain = () => {
    conn.emit('state', { state: 'connecting' });
    conn.session = { waits: [], setBackgroundWaitMs() {} };
    conn.emit('state', { state: 'connected' });
  };
  return conn;
}

/** A feature table of the same shapes as the real one; `made` lists every run it made, in order. */
function fakeFeatures({ locked = { value: false } } = {}) {
  const made = [];
  const make = (feature) => () => {
    const run = new FakeRun(feature);
    made.push(run);
    return run;
  };
  const features = {
    dash: { role: 'background', auto: true, label: 'the dashboard', create: make('dash') },
    sw: { role: 'background', auto: true, polled: true, label: 'the switch watcher', unavailable: () => (locked.value ? 'needs the ECU unlock' : null), create: make('sw') },
    rec: { role: 'exclusive', label: 'a recording', create: make('rec') },
    scan: { role: 'exclusive', label: 'the id scan', create: make('scan') },
    tool: { role: 'tool', label: 'the tool', replace: true, keep: false, create: make('tool') },
  };
  return { features, made, of: (feature) => made.filter((r) => r.name === feature) };
}

function setup(options) {
  const conn = fakeConn();
  const f = fakeFeatures(options);
  const runs = createRuns(conn, { features: f.features });
  return { conn, runs, ...f };
}

// ---- starting and stopping ---------------------------------------------------

test('start makes and starts the run; starting again changes nothing', () => {
  const { runs, of } = setup();
  const first = runs.start('dash');
  assert.equal(first.started, true);
  assert.equal(first.run.started, true);
  assert.equal(runs.active('dash'), first.run);
  const again = runs.start('dash');
  assert.deepEqual([again.started, again.run], [false, first.run]);
  assert.equal(of('dash').length, 1);
});

test('a feature a page takes cycles from is made but not started by the coordinator', () => {
  const { runs } = setup();
  const { run } = runs.start('sw');
  assert.equal(run.running, true);
  assert.equal(run.started, false);
  assert.equal(runs.ensure('sw').run, run, 'a poll gets the same run');
});

test('starting needs a session, and only known features exist', () => {
  const { conn, runs } = setup();
  assert.throws(() => runs.start('nope'), /unknown feature "nope"/);
  assert.throws(() => runs.get('nope'), /unknown feature/);
  conn.session = null;
  assert.throws(() => runs.start('dash'), /not connected/);
  assert.throws(() => runs.ensure('sw'), /not connected/);
});

test('a finished run is still there to show its results, and a feature marked keep:false forgets it', () => {
  const { runs } = setup();
  const dash = runs.start('dash').run;
  dash.finish();
  assert.equal(runs.get('dash'), dash);
  assert.equal(runs.active('dash'), null);
  const tool = runs.start('tool').run;
  tool.finish();
  assert.equal(runs.get('tool'), null);
});

test('a feature marked replace is restarted by a new start; the old run ends first', () => {
  const { runs, of } = setup();
  const a = runs.start('tool').run;
  const b = runs.start('tool').run;
  assert.notEqual(a, b);
  assert.equal(a.running, false);
  assert.equal(runs.get('tool'), b, 'the old run ending does not drop the new one');
  assert.equal(of('tool').length, 2);
});

test('forget drops the kept run of a feature', () => {
  const { runs } = setup();
  runs.start('dash').run.finish();
  runs.forget('dash');
  assert.equal(runs.get('dash'), null);
});

// ---- exclusivity -------------------------------------------------------------

test('a recording stops the dashboard and the switch watcher, and they come back when it ends', async () => {
  const { runs, of } = setup();
  const dash = runs.start('dash').run;
  const sw = runs.start('sw').run;
  const rec = runs.start('rec').run;
  assert.equal(rec.started, true);
  assert.deepEqual([dash.running, sw.running], [false, false]);
  assert.equal(runs.status().exclusive, 'rec');
  assert.deepEqual(runs.status().paused.map((p) => [p.feature, p.by]), [['dash', 'rec'], ['sw', 'rec']]);

  rec.finish(); // it ended by itself (time limit)
  assert.equal(runs.active('dash'), null, 'not at once: after the end has been dealt with');
  await tick();
  assert.equal(of('dash').length, 2);
  assert.equal(runs.active('dash').started, true, 'the dashboard is a new run, started');
  assert.equal(runs.active('sw').running, true);
  assert.deepEqual(runs.status().paused, []);
  assert.equal(runs.status().exclusive, null);
});

test('only what yielded comes back: a feature that was not running stays off', async () => {
  const { runs, of } = setup();
  runs.start('dash');
  const rec = runs.start('rec').run;
  rec.stop();
  await tick();
  assert.equal(of('dash').length, 2);
  assert.equal(of('sw').length, 0);
});

test('a background feature started during a recording is refused for now and comes up when it ends', async () => {
  const { runs, of } = setup();
  const rec = runs.start('rec').run;
  const r = runs.start('dash');
  assert.equal(r.started, false);
  assert.equal(r.run, null);
  assert.deepEqual([r.paused.by, r.paused.why], ['rec', 'a recording is running']);
  assert.match(r.paused.note, /a recording is running: the dashboard starts again when it ends/);
  assert.equal(of('dash').length, 0, 'no run was made');
  assert.deepEqual(runs.status().paused.map((p) => p.feature), ['dash']);
  rec.stop();
  await tick();
  assert.equal(runs.active('dash')?.started, true);
});

test('a poll for the switch watcher during a recording gets a paused answer, not a run', async () => {
  const { runs, of } = setup();
  const rec = runs.start('rec').run;
  const r = runs.ensure('sw');
  assert.equal(r.run, undefined);
  assert.equal(r.paused.by, 'rec');
  assert.equal(of('sw').length, 0);
  rec.stop();
  await tick();
  assert.equal(runs.active('sw')?.running, true, 'and once it ends the watcher is there again');
  assert.equal(runs.ensure('sw').run, runs.active('sw'));
});

test('an id scan holds the line like a recording does', async () => {
  const { runs } = setup();
  const dash = runs.start('dash').run;
  const scan = runs.start('scan').run;
  assert.equal(dash.running, false);
  assert.equal(runs.status().exclusive, 'scan');
  assert.equal(runs.start('sw').paused.why, 'the id scan is running');
  scan.finish();
  await tick();
  assert.equal(runs.active('dash')?.started, true);
  assert.equal(runs.active('sw')?.running, true);
});

test('the two exclusive features refuse each other, naming what runs, and disturb nothing', () => {
  const { runs, of } = setup();
  runs.start('dash');
  const rec = runs.start('rec').run;
  assert.throws(() => runs.start('scan'), /a recording is running: stop it first/);
  assert.equal(rec.running, true);
  assert.equal(of('scan').length, 0);
  rec.stop();
  const scan = runs.start('scan').run;
  assert.throws(() => runs.start('rec'), /the id scan is running: stop it first/);
  assert.equal(scan.running, true);
  assert.equal(runs.start('scan').started, false, 'starting the one that runs is not an error');
});

test('requireNoExclusive refuses while a recording or scan runs, with the words it is given', () => {
  const { runs } = setup();
  runs.requireNoExclusive();
  const rec = runs.start('rec').run;
  assert.throws(() => runs.requireNoExclusive(), /a recording is running: stop it first/);
  assert.throws(() => runs.requireNoExclusive('stop the recording first'), /^Error: stop the recording first$/);
  rec.stop();
  runs.requireNoExclusive();
});

test('an exclusive run that cannot be made gives the line back at once', () => {
  const conn = fakeConn();
  const f = fakeFeatures();
  f.features.rec.create = () => { throw new Error('cannot open the log'); };
  const runs = createRuns(conn, { features: f.features });
  const dash = runs.start('dash').run;
  assert.throws(() => runs.start('rec'), /cannot open the log/);
  assert.equal(dash.running, false, 'it had been stopped for the recording');
  assert.equal(runs.active('dash')?.started, true, 'and is back');
  assert.equal(runs.status().exclusive, null);
});

test('tools do not take part: they run beside a recording and are not stopped by it', () => {
  const { runs } = setup();
  const tool = runs.start('tool').run;
  runs.start('rec');
  assert.equal(tool.running, true);
  assert.equal(runs.start('tool').started, true, 'a tool can be started during a recording');
});

// ---- the owner ----------------------------------------------------------------

test('the owner stops the dashboard: nothing brings it back until the owner starts it, not a recording ending, not reconcile', async () => {
  const { runs, of } = setup();
  const dash = runs.start('dash').run;
  runs.stop('dash');
  assert.equal(dash.running, false);
  assert.deepEqual(runs.status().stoppedByOwner, ['dash']);

  const rec = runs.start('rec').run;
  rec.stop();
  await tick();
  assert.deepEqual(runs.reconcile(), ['sw'], 'only the switch watcher is started');
  assert.equal(of('dash').length, 1);

  assert.equal(runs.start('dash').started, true, 'the owner asks again');
  assert.deepEqual(runs.status().stoppedByOwner, []);
});

test('stopping a background feature while it is held back cancels its coming back', async () => {
  const { runs, of } = setup();
  runs.start('dash');
  const rec = runs.start('rec').run;
  runs.stop('dash'); // the owner presses Stop on the paused dashboard
  rec.stop();
  await tick();
  assert.equal(of('dash').length, 1);
  assert.deepEqual(runs.status().paused, []);
});

test('a poll does not undo the owner\'s stop of the switch watcher', () => {
  const { runs, of } = setup();
  runs.start('sw');
  runs.stop('sw');
  const r = runs.ensure('sw');
  assert.equal(r.paused.by, 'owner');
  assert.match(r.paused.note, /the switch watcher was stopped/);
  assert.equal(of('sw').length, 1, 'no new run');
  assert.equal(runs.start('sw').started, true);
  assert.equal(of('sw').length, 2);
});

test('stopping something that is not running, or a tool, is fine and sets no owner flag', () => {
  const { runs } = setup();
  runs.stop('rec');
  runs.stop('tool');
  assert.deepEqual(runs.status().stoppedByOwner, []);
  const tool = runs.start('tool').run;
  runs.stop('tool');
  assert.equal(tool.running, false);
});

test('the owner\'s stops are forgotten with every new connection and when the connection ends', () => {
  const { conn, runs } = setup();
  runs.start('dash');
  runs.stop('dash');
  runs.stop('sw');
  assert.deepEqual(runs.status().stoppedByOwner, ['dash', 'sw']);
  conn.drop();
  assert.deepEqual(runs.status().stoppedByOwner, []);

  runs.stop('dash');
  conn.connectAgain();
  assert.deepEqual(runs.status().stoppedByOwner, []);
  assert.deepEqual(runs.reconcile(), ['dash', 'sw'], 'the new connection starts watching again');
});

// ---- reconcile -----------------------------------------------------------------

test('reconcile starts the dashboard and the switch watcher, once, and never a tool or an exclusive feature', () => {
  const { runs, of } = setup();
  assert.deepEqual(runs.reconcile(), ['dash', 'sw']);
  assert.deepEqual(runs.reconcile(), [], 'nothing left to start');
  assert.deepEqual(['rec', 'scan', 'tool'].map((n) => of(n).length), [0, 0, 0]);
  assert.equal(of('dash')[0].started, true);
});

test('reconcile starts nothing without a session', () => {
  const { conn, runs } = setup();
  conn.session = null;
  assert.deepEqual(runs.reconcile(), []);
});

test('reconcile leaves what is not possible yet waiting, and says why; the unlock turns it on', () => {
  const locked = { value: true };
  const { runs } = setup({ locked });
  assert.deepEqual(runs.reconcile(), ['dash']);
  assert.deepEqual(runs.status().waiting, [{ feature: 'sw', why: 'needs the ECU unlock' }]);
  assert.deepEqual(runs.start('sw'), { run: null, started: false, unavailable: 'needs the ECU unlock' });
  locked.value = false;
  assert.deepEqual(runs.reconcile(), ['sw']);
  assert.deepEqual(runs.status().waiting, []);
});

test('reconcile during a recording starts nothing and remembers what it held back', async () => {
  const { runs } = setup();
  const rec = runs.start('rec').run;
  assert.deepEqual(runs.reconcile(), []);
  assert.deepEqual(runs.status().paused.map((p) => p.feature), ['dash', 'sw']);
  rec.stop();
  await tick();
  assert.deepEqual(runs.status().running.map((r) => r.feature).sort(), ['dash', 'sw']);
});

test('a reconcile that makes a feature fail leaves it off and carries on', () => {
  const conn = fakeConn();
  const f = fakeFeatures();
  f.features.dash.create = () => { throw new Error('boom'); };
  const runs = createRuns(conn, { features: f.features });
  assert.deepEqual(runs.reconcile(), ['sw']);
});

// ---- the end of a connection -----------------------------------------------------

test('nothing is started into a connection that ended while a recording was running', async () => {
  const { conn, runs, made } = setup();
  const dash = runs.start('dash').run;
  const rec = runs.start('rec').run;
  const before = made.length;
  conn.drop('lost'); // the connection cancels its runs...
  rec.stop();
  dash.stop();
  await tick();
  assert.equal(made.length, before, '...and the coordinator does not bring anything back');
  assert.deepEqual(runs.status().paused, [], 'and forgot what it was holding');
  assert.equal(runs.status().connected, false);
});

// ---- status ------------------------------------------------------------------------

test('status is plain data: what runs (feature, role, run name), what is paused and why, what the owner stopped', () => {
  const { runs } = setup();
  runs.start('dash');
  runs.stop('sw');
  const s = runs.status();
  assert.deepEqual(s, JSON.parse(JSON.stringify(s)));
  assert.deepEqual(s, {
    connected: true,
    exclusive: null,
    running: [{ feature: 'dash', role: 'background', run: 'dash', startedAt: 0 }],
    paused: [],
    stoppedByOwner: ['sw'],
    waiting: [],
  });
  runs.start('rec');
  assert.deepEqual(runs.status().paused, [{ feature: 'dash', by: 'rec', why: 'a recording is running', note: 'a recording is running: the dashboard starts again when it ends' }]);
});

// ---- line priority: the tuning --------------------------------------------------------

test('the background wait follows the engine: long while it runs, the default otherwise', () => {
  assert.equal(backgroundWaitFor(RUNNING_RPM + 1), BACKGROUND_WAIT_RUNNING_MS);
  assert.equal(backgroundWaitFor(RUNNING_RPM), BACKGROUND_WAIT_IDLE_MS);
  assert.equal(backgroundWaitFor(0), BACKGROUND_WAIT_IDLE_MS);
  assert.equal(backgroundWaitFor(undefined), BACKGROUND_WAIT_IDLE_MS);
  assert.equal(BACKGROUND_WAIT_IDLE_MS, 300, 'the session default');
});

async function realBike({ target = 0xd5, ...mockOptions } = {}) {
  const t = new MockEcuTransport({ target, iso9141: true, ...mockOptions });
  const conn = new Connection({
    configPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-runs-')), 'config.json'),
    openTransport: async () => t,
    clock: t.clock,
    keepAliveMs: 60_000,
  });
  await conn.connect({ port: 'MOCK' });
  return { t, conn, runs: createRuns(conn, { logDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-runs-logs-')), 'logs') }) };
}

test('the real dashboard tunes the line: 800 ms background wait while the engine runs, the default when it does not or the dashboard ends', async () => {
  const { t, conn, runs } = await realBike();
  const session = conn.session;
  assert.equal(session.backgroundAgeMs, 300);
  runs.start('dashboard');
  await until(() => session.backgroundAgeMs === 800); // the mock's engine runs at 4000 rpm
  t.pids[0x0c] = [0, 0]; // the engine stops
  await until(() => session.backgroundAgeMs === 300);
  t.pids[0x0c] = [0x3e, 0x80]; // and starts again
  await until(() => session.backgroundAgeMs === 800);
  runs.stop('dashboard');
  assert.equal(session.backgroundAgeMs, 300, 'with the dashboard gone there is no engine speed to follow');
  await conn.disconnect();
});

test('the real features: a recording takes the line from the dashboard and gives it back; a disconnect during one leaves nothing running', async () => {
  const { conn, runs } = await realBike();
  runs.start('dashboard');
  await until(() => runs.get('dashboard').cycles >= 1);
  runs.start('recording');
  assert.deepEqual(conn.runs, ['record']);
  assert.equal(runs.status().exclusive, 'recording');
  runs.stop('recording');
  await tick();
  assert.deepEqual(conn.runs, ['gauges'], 'the dashboard is back');

  runs.start('recording');
  assert.deepEqual(conn.runs, ['record']);
  await conn.disconnect();
  await tick();
  await tick();
  assert.deepEqual(conn.runs, [], 'nothing was started into the ended connection');
  assert.deepEqual(runs.status().running, []);
  assert.deepEqual(runs.status().paused, []);
});
