'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, state } = require('../server');
const { MockEcuTransport } = require('./mockecu');

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Point the server's connection at a mock ECU and a scratch config file. */
function useMock(mock, keepAliveMs = 60_000, { unlockFile = null, autoUnlock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  conn.configPath = path.join(dir, 'config.json');
  if (unlockFile) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify(unlockFile));
  conn.autoUnlock = autoUnlock;
  conn.openTransport = async () => mock;
  conn.clock = mock.clock;
  conn.keepAliveMs = keepAliveMs;
}
const call = (route, body) => routes[route](body ?? {});

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json

/** An ISO mock that does security access (and serves 0x1a when unlocked), connected through the server's routes. */
async function connectBike({ multiplier = M, ...options } = {}) {
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  t.modes[0x1a] = (option) => (option === 0x80 ? [0x5a, 0x80, ...Buffer.from('T675-KEIHIN')] : [0x7f, 0x1a, 0x12]);
  useMock(t, 60_000, { unlockFile: multiplier === null ? null : { multiplier }, ...options });
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}
const LOCKED_NOTE = /^needs the ECU unlock, not available \(/;

test('status starts disconnected with no error; routes refuse to run', async () => {
  useMock(new MockEcuTransport());
  const s = await call('GET /api/status');
  assert.equal(s.connected, false);
  assert.equal(s.state, 'disconnected');
  assert.equal(s.error, null);
  await assert.rejects(() => call('GET /api/dtc'), /not connected/);
});

test('a failed connect leaves the real error in the status', async () => {
  useMock(new MockEcuTransport({ target: 0x99 }));
  await assert.rejects(() => call('POST /api/connect', { port: 'MOCK' }), /No ECU answered/);
  const s = await call('GET /api/status');
  assert.equal(s.state, 'disconnected');
  assert.match(s.error, /No ECU answered/);
});

test('disconnect stops the probe, the live run and the gauge loop', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  useMock(t);
  const c = await call('POST /api/connect', { port: 'MOCK' });
  assert.equal(c.target, '0xd5');
  const s = await call('GET /api/status');
  assert.equal(s.connected, true);
  assert.equal(s.state, 'connected');
  assert.equal(s.target, 0xd5);

  await call('POST /api/gauges/start');
  await call('POST /api/live/start', { interval: 5 });
  await call('POST /api/probe', { from: 1, to: 0xff });
  await until(() => state.gauges.cycles >= 1 && state.live.samples >= 1 && state.probe.sampler.current >= 3);
  assert.deepEqual(conn.runs.sort(), ['gauges', 'live', 'probe']);

  await call('POST /api/disconnect');
  await until(() => !state.probe.running);

  assert.equal(state.gauges.running, false);
  assert.equal(state.live, null);
  assert.equal(state.probe.outcome, 'cancelled');
  assert.ok(state.probe.sampler.current < 0xff);
  assert.equal((await call('GET /api/status')).probe.cancelled, true);
  assert.deepEqual(conn.runs, []);
  assert.equal((await call('GET /api/status')).state, 'disconnected');
  assert.equal((await call('GET /api/status')).live, null);

  const sent = t.requests.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.requests.length, sent, 'nothing keeps polling the ECU');
});

test('a lost ECU shows in the status with the reason, and the runs stop', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  useMock(t, 3);
  await call('POST /api/connect', { port: 'MOCK' });
  await call('POST /api/gauges/start');
  await until(() => state.gauges.cycles >= 1);

  t.inject('dropReply', { times: 100000 });
  await until(() => conn.state === 'lost');

  const s = await call('GET /api/status');
  assert.equal(s.connected, false);
  assert.equal(s.state, 'lost');
  assert.match(s.error, /ECU stopped answering/);
  assert.equal(state.gauges.running, false);
  await assert.rejects(() => call('GET /api/dtc'), /connection lost/);
  await call('POST /api/disconnect');
  assert.equal((await call('GET /api/status')).error, null);
});

test('the DTC endpoint returns descriptions, the warning light and a summary; status reports the data block id in use', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  useMock(t);
  await call('POST /api/connect', { port: 'MOCK' });
  assert.equal((await call('GET /api/status')).dataBlockId, 0x80);

  const r = await call('GET /api/dtc');
  assert.deepEqual(r.dtcs, [
    { code: 'P0078', status: 'stored', statusByte: null, description: 'Exhaust valve actuator circuit' },
    { code: 'P1108', status: 'stored', statusByte: null, description: null },
  ]);
  assert.equal(r.count, 2);
  assert.equal(r.status.milOn, true);
  assert.equal(r.status.dtcCount, 2);
  assert.equal(r.pendingSupported, false);
  assert.equal(r.summary, 'Warning light ON; the ECU reports 2 stored codes and 2 were read.');

  t.storedCodes = [0x0078];
  assert.match((await call('GET /api/dtc')).summary, /reports 2 stored codes but 1 was read/);

  conn.saveConfig({ localId: 0x42 });
  assert.equal((await call('GET /api/status')).dataBlockId, 0x42);
  await call('POST /api/disconnect');
});

test('connecting to the bike by slow init: the connect answer and the status say how', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 2 });
  useMock(t);
  const c = await call('POST /api/connect', { port: 'MOCK' });
  assert.deepEqual({ target: c.target, kind: c.kind, keyBytes: c.keyBytes }, { target: '0x33', kind: 'slow', keyBytes: '08 08' });
  const s = await call('GET /api/status');
  assert.equal(s.kind, 'slow');
  assert.equal(s.style, 'iso9141');
  assert.equal(s.progress.step, 'connected');
  await call('POST /api/disconnect');
});

test('the progress the page shows names the slow-init try', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 3 });
  useMock(t);
  const seen = [];
  const listener = () => seen.push(conn.progress);
  conn.on('progress', listener);
  await call('POST /api/connect', { port: 'MOCK' });
  conn.off('progress', listener);
  const texts = seen.filter((p) => p.step === 'attempt').map((p) => p.attempt.text);
  assert.deepEqual(texts, ['slow init 0x33, try 1/6', 'slow init 0x33, try 2/6', 'slow init 0x33, try 3/6']);
  await call('POST /api/disconnect');
});


test('status carries the unlock state and reason: off without an unlock file, locked until tried, unlocked, failed', async () => {
  let t = await connectBike({ multiplier: null });
  let s = await call('GET /api/status');
  assert.equal(s.unlock, 'unavailable');
  assert.match(s.unlockReason, /no unlock file/);
  assert.equal(t.requests.filter((r) => r.service === 0x27).length, 0, 'no security access request without a file');
  await call('POST /api/disconnect');

  t = await connectBike({ autoUnlock: false });
  s = await call('GET /api/status');
  assert.deepEqual([s.unlock, s.unlockReason], ['locked', null]);
  assert.equal(t.seedRequests, 0, 'not tried until asked');
  await call('POST /api/disconnect');

  t = await connectBike();
  s = await call('GET /api/status');
  assert.deepEqual([s.unlock, s.unlockReason], ['unlocked', null]);
  assert.equal(s.connected, true);
  assert.ok(!JSON.stringify(s).includes(String(M)), 'the multiplier is never in the status');
  await call('POST /api/disconnect');
  assert.equal((await call('GET /api/status')).unlock, 'locked', 'a new connection starts over');

  t = await connectBike({ multiplier: M + 1 });
  s = await call('GET /api/status');
  assert.equal(s.unlock, 'failed');
  assert.match(s.unlockReason, /refused the key \(code 0x35\)/);
  assert.equal(t.keyAttempts, 1);
  await call('POST /api/disconnect');
});

test('POST /api/unlock tries once per click and returns the new state', async () => {
  const t = await connectBike({ multiplier: M + 1, autoUnlock: false });
  const first = await call('POST /api/unlock');
  assert.equal(first.unlock, 'failed');
  assert.match(first.unlockReason, /refused the key/);
  assert.equal(t.keyAttempts, 1);
  assert.equal(t.seedRequests, 1);

  const second = await call('POST /api/unlock');
  assert.equal(second.unlock, 'failed');
  assert.equal(t.keyAttempts, 2, 'a second click is a second attempt, never more');
  await call('POST /api/disconnect');

  const good = await connectBike({ autoUnlock: false });
  assert.deepEqual(await call('POST /api/unlock'), { unlock: 'unlocked', unlockReason: null });
  assert.equal(good.keyAttempts, 1);
  assert.equal((await call('GET /api/status')).unlock, 'unlocked');
  await assert.rejects(() => call('POST /api/unlock'), /already unlocked/);
  assert.equal(good.keyAttempts, 1, 'no further key');
  await call('POST /api/disconnect');
});

test('POST /api/unlock without a file, without a connection, or while the file is unusable says why and sends nothing', async () => {
  await assert.rejects(() => call('POST /api/unlock'), /not connected/);
  const t = await connectBike({ multiplier: null });
  await assert.rejects(() => call('POST /api/unlock'), /unlock is unavailable: no unlock file/);
  assert.equal(t.requests.filter((r) => r.service === 0x27).length, 0);
  await call('POST /api/disconnect');
});

test('the gauges endpoint serves the dial definitions, decoded values, the supported PIDs and what is not available', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  delete t.pids[0x0e]; // timing advance
  useMock(t);
  await call('POST /api/connect', { port: 'MOCK' });

  const idle = await call('GET /api/gauges');
  assert.equal(idle.running, false);
  assert.deepEqual(idle.defs.map((d) => d.key), ['rpm', 'speed', 'tps', 'map', 'coolant', 'airtemp', 'load', 'timing', 'trim', 'fuelSystem', 'battery', 'gear']);
  assert.deepEqual(idle.locked, ['battery', 'gear']);
  assert.deepEqual(idle.values, {});
  assert.equal(idle.supported, null);

  await call('POST /api/gauges/start');
  await until(() => state.gauges.cycles >= 12);
  const g = await call('GET /api/gauges');
  assert.equal(g.running, true);
  assert.deepEqual(g.unsupported, ['timing']);
  assert.deepEqual(g.locked, ['battery', 'gear'], 'waiting for the unlock, not "not available"');
  assert.deepEqual(g.supported, [0x01, 0x03, 0x04, 0x05, 0x06, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x14, 0x1c]);
  const value = (key) => g.values[key]?.value;
  assert.deepEqual([value('rpm'), value('speed'), value('tps'), value('map'), value('coolant'), value('airtemp'), value('load'), value('trim')], [4000, 0, 50.2, 1010, 90, 22, 40, 0]);
  assert.equal(g.values.fuelSystem.text, 'closed loop');
  assert.equal(g.values.timing, undefined);
  assert.equal(g.values.battery, undefined);
  assert.equal(g.errors, 0);
  assert.equal(t.requests.filter((r) => r.service === 0x22).length, 0);

  await call('POST /api/gauges/stop');
  await until(() => !state.gauges.running);
  await call('POST /api/disconnect');
});

test('the gauges endpoint shows battery and gear once the ECU is unlocked', async () => {
  await connectBike();
  await call('POST /api/gauges/start');
  await until(() => state.gauges.cycles >= 12);
  const g = await call('GET /api/gauges');
  assert.deepEqual(g.locked, []);
  assert.equal(g.values.battery.value, 13.8);
  assert.equal(g.values.gear.value, 4);
  assert.deepEqual(g.unsupported, []);
  assert.equal(g.errors, 0);
  await call('POST /api/gauges/stop');
  await until(() => !state.gauges.running);
  await call('POST /api/disconnect');
});

test('while locked, the gated endpoints answer "locked" with a note and ask the ECU nothing', async () => {
  for (const options of [{ multiplier: null }, { autoUnlock: false }, { multiplier: M + 1 }]) {
    const t = await connectBike(options);
    const sent = t.requests.length;
    const runs = conn.runs.length;

    const sw = await call('GET /api/switches');
    assert.deepEqual({ available: sw.available, rows: sw.rows, locked: sw.locked }, { available: false, rows: [], locked: true });
    assert.match(sw.note, LOCKED_NOTE);
    const id = await call('GET /api/id');
    assert.deepEqual([id.locked, id.results], [true, []]);
    assert.match(id.note, LOCKED_NOTE);
    for (const route of ['POST /api/probe', 'POST /api/live/start']) {
      const r = await call(route, {});
      assert.equal(r.locked, true, route);
      assert.match(r.note, LOCKED_NOTE);
    }

    assert.equal(t.requests.length, sent, 'nothing was sent');
    assert.equal(conn.runs.length, runs, 'no run was started');
    await call('POST /api/disconnect');
  }
});

test('the locked answer says why: no file, not tried yet, or the failed attempt', async () => {
  let t = await connectBike({ multiplier: null });
  assert.match((await call('GET /api/switches')).note, /unlock is off: no unlock.json/);
  await call('POST /api/disconnect');
  t = await connectBike({ autoUnlock: false });
  assert.match((await call('GET /api/id')).note, /not unlocked yet/);
  await call('POST /api/disconnect');
  t = await connectBike({ multiplier: M + 1 });
  assert.match((await call('GET /api/id')).note, /unlock failed: .*refused the key/);
  await call('POST /api/disconnect');
});

test('without a connection the gated endpoints still fail as not connected, not as locked', async () => {
  await call('POST /api/disconnect');
  for (const route of ['GET /api/switches', 'GET /api/id', 'POST /api/probe', 'POST /api/live/start']) {
    await assert.rejects(() => call(route, {}), /not connected/, route);
  }
});

test('once unlocked, the switch states are read through the endpoint', async () => {
  const t = await connectBike();
  const unserved = [0x61, 0x63, 0x68]; // in the bike's table, but the mock does not serve them unless a test adds them
  const first = await call('GET /api/switches');
  assert.equal(first.locked, undefined);
  assert.equal(first.available, true);
  assert.deepEqual(first.rows.map((r) => r.id), conn.bike.switches.map((s) => s.id).filter((id) => !unserved.includes(id)), "the named ones the ECU answered, in the table's order; an id it never answered has no tile");
  for (const id of unserved) t.dataIds[id] = [0, 0xff]; // the ECU answers them now: they were not dropped after one silent scan
  const withAll = await call('GET /api/switches');
  assert.deepEqual(withAll.rows.map((r) => r.id), conn.bike.switches.map((s) => s.id), 'every named id, in the real table order');
  const clutch = (r) => r.rows.find((x) => x.name === 'Clutch');
  const second = await call('GET /api/switches');
  assert.notEqual(clutch(second).hex, clutch(withAll).hex, 'the clutch flips on every read');
  await call('POST /api/disconnect');
});

test('trying the unlock while the page is mid-way: the switches endpoint turns from locked to live without reconnecting', async () => {
  await connectBike({ autoUnlock: false });
  assert.equal((await call('GET /api/switches')).locked, true);
  await call('POST /api/unlock');
  assert.equal((await call('GET /api/switches')).available, true);
  await call('POST /api/disconnect');
});

test('once unlocked, the ECU identity is read through the endpoint', async () => {
  await connectBike();
  const r = await call('GET /api/id');
  assert.equal(r.locked, undefined);
  assert.deepEqual(r.results.map((x) => [x.option, x.ascii]), [[0x80, 'T675-KEIHIN']]);
  await call('POST /api/disconnect');
});

test('the probe endpoint on the unlocked bike stops early and says it is not available, instead of failing', async () => {
  await connectBike();
  await call('POST /api/probe', {});
  await until(() => !state.probe.running);
  const p = (await call('GET /api/status')).probe;
  assert.match(p.unavailable, /not available: the ECU served none of the first 8 block ids, even unlocked/);
  assert.deepEqual(p.found, []);
  assert.equal(p.error, undefined);
  assert.equal(p.cancelled, false);
  await call('POST /api/disconnect');
});

test('an unlocked sensor block run the ECU does not serve ends by itself with the reason', async () => {
  await connectBike();
  assert.deepEqual(await call('POST /api/live/start', { interval: 1 }), {});
  await until(() => state.live === null);
  const r = await call('GET /api/live/latest');
  assert.equal(r.active, false);
  assert.match(r.error, /no response to \[21 80\].*advanced tool/);
  await call('POST /api/live/start', { interval: 1 });
  assert.equal((await call('GET /api/live/latest')).error, undefined, 'a new run clears the old reason');
  await call('POST /api/disconnect');
});

test('a bike description with no switch ids says so rather than blaming the unlock', async () => {
  const bike = conn.bike;
  conn.bike = { ...bike, switchIds: [] };
  try {
    await connectBike();
    const r = await call('GET /api/switches');
    assert.deepEqual({ available: r.available, rows: r.rows }, { available: false, rows: [] });
    assert.match(r.note, /names no switch IDs/);
    await call('POST /api/disconnect');
  } finally {
    conn.bike = bike;
  }
});
