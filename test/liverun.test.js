'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { blockRun, gaugeRun, switchRun, probeRun, LiveRun } = require('../src/liverun');
const { DEFAULT_BIKE } = require('../src/bikes');
const { MockEcuTransport } = require('./mockecu');
const { NeedsUnlockError } = require('../src/services');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-run-'));

/** A connected Connection on a mock ECU, with a scratch config file. */
async function connected(mockOptions = {}, connOptions = {}) {
  const t = new MockEcuTransport({ target: 0xd5, ...mockOptions });
  const conn = new Connection({
    configPath: path.join(scratch(), 'config.json'),
    openTransport: async () => t,
    clock: t.clock,
    keepAliveMs: 60_000,
    ...connOptions,
  });
  await conn.connect({ port: 'MOCK' });
  return { t, conn };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Stop `run` once it has recorded `n` samples; resolves when it has ended. */
function stopAfter(run, n) {
  run.on('sample', () => {
    if (run.samples >= n) run.stop();
  });
  return run.start();
}

test('a block run records samples at its pace, then stops', async () => {
  const { t, conn } = await connected();
  const run = blockRun(conn, { interval: 150 });
  assert.deepEqual(conn.runs, ['live']);
  assert.equal(run.sampler.id, 0x80);

  const seen = [];
  run.on('sample', (s) => seen.push(s.data.length));
  assert.equal(await stopAfter(run, 5), 'cancelled');

  assert.equal(run.samples, 5);
  assert.equal(run.errors, 0);
  assert.deepEqual(seen, [64, 64, 64, 64, 64]);
  assert.equal(run.latest.data.length, 64);
  assert.deepEqual(run.latest.fields.map((f) => f.name), ['TPS']);
  assert.equal(run.running, false);
  assert.deepEqual(conn.runs, []);
  assert.equal(t.clock.sleeps.filter((ms) => ms === 150).length, 4, 'one pause between samples');

  const sent = t.requests.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sent, 'a stopped run reads nothing more');
  await conn.disconnect();
});

test('min/max follow every byte; reset makes the next sample the baseline', async () => {
  const { conn } = await connected();
  const run = blockRun(conn);
  for (let i = 0; i < 5; i++) await run.step();

  // the mock moves byte 5 by 7 per read (7, 14 ... 35); everything else is constant
  assert.equal(run.min[5], 7);
  assert.equal(run.max[5], 35);
  assert.equal(run.min[4], 1);
  assert.equal(run.max[4], 1);
  assert.equal(run.min[10], 90);
  assert.deepEqual(run.changed(), ['5']);

  run.resetRange();
  assert.deepEqual(run.changed(), []);
  await run.step();
  assert.equal(run.min[5], 42);
  assert.equal(run.max[5], 42);
  assert.deepEqual(run.changed(), []);
  await conn.disconnect();
});

test('the CSV has one format: time, the decoded fields, raw hex; one row per sample', async () => {
  const { conn } = await connected();
  const file = path.join(scratch(), 'nested', 'run.csv');
  const run = blockRun(conn, { logPath: file });
  assert.equal(run.csvPath, file);
  await stopAfter(run, 3);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'time,TPS,raw');
  const rows = lines.slice(1).map((l) => l.split(','));
  for (const [i, [time, tps, raw]] of rows.entries()) {
    assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const tpsRaw = 256 + (i + 1) * 7;
    assert.equal(Number(tps), Math.round(tpsRaw * 0.0196078 * 100) / 100);
    const bytes = raw.split(' ');
    assert.equal(bytes.length, 64);
    assert.equal(bytes[5], ((i + 1) * 7).toString(16).padStart(2, '0'));
  }

  // an explicit file is appended to, like before
  const again = blockRun(conn, { logPath: file });
  await stopAfter(again, 1);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4 + 2);
  await conn.disconnect();
});

test('log: true records to logDir under a timestamped name', async () => {
  const { conn } = await connected();
  const logDir = path.join(scratch(), 'logs');
  const run = blockRun(conn, { log: true, logDir });
  assert.equal(path.dirname(run.csvPath), logDir);
  assert.match(path.basename(run.csvPath), /^run-\d{4}-\d\d-\d\dT[\d-]+Z\.csv$/);
  await stopAfter(run, 2);
  assert.equal(fs.readFileSync(run.csvPath, 'utf8').trim().split('\n').length, 3);
  await conn.disconnect();
});

test('a run without a CSV format refuses to log and leaves nothing registered', async () => {
  const { conn } = await connected();
  assert.throws(() => switchRun(conn, { log: true }), /no CSV format/);
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('disconnect cancels every run; a read in flight is not recorded and the log is closed', async () => {
  const { t, conn } = await connected();
  const file = path.join(scratch(), 'run.csv');
  const live = blockRun(conn, { interval: 5, logPath: file });
  const gauges = gaugeRun(conn);
  const probe = probeRun(conn);
  const switches = switchRun(conn);
  assert.deepEqual(conn.runs.sort(), ['gauges', 'live', 'probe', 'switches']);
  const ended = [live.start(), gauges.start(), probe.start()];
  await switches.step();
  await until(() => live.samples >= 2 && gauges.cycles >= 2 && probe.sampler.current >= 3);

  await conn.disconnect();
  assert.deepEqual(await Promise.all(ended), ['cancelled', 'cancelled', 'cancelled']);

  assert.equal(switches.outcome, 'cancelled');
  assert.deepEqual(conn.runs, []);
  assert.ok(probe.sampler.current < 0xff);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, live.samples + 1, 'every recorded sample is in the log, nothing else');
  await assert.rejects(() => switches.step(), /stopped/);

  const sent = t.requests.length;
  const samples = live.samples;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sent);
  assert.equal(live.samples, samples);
});

test('a run stopped mid-read does not record that read', async () => {
  const { conn } = await connected();
  const file = path.join(scratch(), 'run.csv');
  const run = blockRun(conn, { interval: 0, logPath: file });
  const ended = run.start();
  await until(() => run.samples >= 1);
  run.stop();
  const atStop = run.samples;
  await ended;
  assert.equal(run.samples, atStop);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, atStop + 1);
  await conn.disconnect();
});

test('a read that fails is counted and the run keeps going', async () => {
  const { t, conn } = await connected();
  const run = blockRun(conn, { interval: 0 });
  const faults = [];
  run.on('fault', (e) => faults.push(e.message));
  await run.step();
  t.inject('dropReply', { times: 2, service: 0x21 }); // the request and its one resend
  const ended = stopAfter(run, 4);
  assert.equal(await ended, 'cancelled');

  assert.equal(run.errors, 1);
  assert.equal(faults.length, 1);
  assert.equal(run.lastError, faults[0]);
  assert.ok(run.samples >= 4, 'later reads still land');
  await conn.disconnect();
});

test('a lost ECU ends the run through the connection', async () => {
  const { t, conn } = await connectedIso({}, { keepAliveMs: 3 });
  const run = gaugeRun(conn);
  const ended = run.start();
  await until(() => run.cycles >= 1);
  t.inject('dropReply', { times: 100000 });
  assert.equal(await ended, 'cancelled');
  assert.equal(conn.state, 'lost');
  await conn.disconnect();
});

/** A connected Connection on a mock of the real bike: slow init, ISO 9141 OBD-II. */
const connectedIso = (mockOptions = {}, connOptions = {}) => connected({ iso9141: true, ...mockOptions }, connOptions);

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json

/**
 * A connected ISO mock whose ECU does security access and whose unlock file (beside the scratch
 * config.json) names the made-up multiplier: unlocked after connecting unless `autoUnlock: false`.
 */
function connectedUnlockable(mockOptions = {}, connOptions = {}) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  return connectedIso({ unlockMultiplier: M, ...mockOptions }, { configPath: path.join(dir, 'config.json'), ...connOptions });
}

/** The 0x22 ids asked of an ISO mock since request number `from`. */
const commonIds = (t, from = 0) => t.requests.slice(from).filter((r) => r.service === 0x22).map((r) => (r.data[1] << 8) | r.data[2]);

/** The PIDs asked of an ISO mock since request number `from`, as hex numbers. */
const modeOnePids = (t, from = 0) => t.requests.slice(from).filter((r) => r.service === 0x01 && r.data[1] !== 0x00).map((r) => r.data[1]);

test('gauges: fast PIDs every cycle, one slow PID per cycle in turn, values decoded', async () => {
  const { t, conn } = await connectedIso();
  const run = gaugeRun(conn);
  const obd = DEFAULT_BIKE.gauges.filter((d) => !d.requiresUnlock);
  const slow = obd.filter((d) => !d.fast).map((d) => d.pid);
  const fast = obd.filter((d) => d.fast).map((d) => d.pid);
  assert.deepEqual(fast, [0x0c, 0x11], 'engine speed and throttle every cycle; speed takes turns, so the needles keep up');
  const before = t.requests.length;

  for (let i = 0; i < 8; i++) await run.step();

  const asked = modeOnePids(t, before);
  const perCycle = [];
  for (let i = 0; i < asked.length; i += fast.length + 1) perCycle.push(asked.slice(i, i + fast.length + 1));
  assert.deepEqual(perCycle.map((c) => c.slice(0, fast.length)), Array(8).fill(fast));
  assert.deepEqual(perCycle.map((c) => c[fast.length]), slow);
  assert.deepEqual(t.requests.slice(before).filter((r) => r.data[1] === 0x00).map((r) => r.data), [[1, 0]], 'the supported-PID list is read once, first');

  assert.deepEqual(run.sampler.unsupported, [], 'the unlock-only gauges are not "not available", they are just not asked yet');
  assert.deepEqual(commonIds(t), [], 'no 0x22 request while the connection is not unlocked');
  assert.deepEqual([...run.sampler.supported].sort((a, b) => a - b), [0x01, 0x03, 0x04, 0x05, 0x06, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x14, 0x1c]);
  assert.equal(run.errors, 0);
  assert.equal(run.cycles, 8);
  const v = run.sampler.values;
  assert.equal(v.rpm.value, 4000);
  assert.equal(v.rpm.at, 7);
  assert.equal(v.speed.value, 0);
  assert.equal(v.tps.value, 50.2);
  assert.equal(v.map.value, 1010);
  assert.equal(v.coolant.value, 90);
  assert.equal(v.airtemp.value, 22);
  assert.equal(v.load.value, 40);
  assert.equal(v.timing.value, 12);
  assert.equal(v.trim.value, 0);
  assert.equal(v.fuelSystem.text, 'closed loop');
  assert.equal(v.fuelSystem.value, 2);
  assert.equal(run.min.rpm, 4000);
  assert.equal(run.max.rpm, 4000);
  assert.equal(run.min.fuelSystem, 2, 'a text gauge still has a number to track');
  assert.equal(v.battery, undefined);
  assert.equal(v.gear, undefined);
  await conn.disconnect();
});

test('gauges: battery and gear are added once the connection is unlocked, even into a run that is already going', async () => {
  const { t, conn } = await connectedUnlockable({}, { autoUnlock: false });
  assert.equal(conn.unlockState, 'locked');
  const run = gaugeRun(conn);
  for (let i = 0; i < 4; i++) await run.step();
  assert.deepEqual(commonIds(t), [], 'locked: not asked');
  assert.equal(run.sampler.values.battery, undefined);

  assert.deepEqual(await conn.unlock(), { state: 'unlocked', reason: null });
  for (let i = 0; i < 12; i++) await run.step();

  const v = run.sampler.values;
  assert.equal(v.battery.value, 13.8);
  assert.deepEqual(v.battery.raw, [0, 138]);
  assert.equal(v.gear.value, 4);
  assert.equal(run.latest.channels.rpm, 4000);
  assert.ok(commonIds(t).includes(0x07) && commonIds(t).includes(0x21));
  assert.deepEqual(run.sampler.unsupported, []);
  assert.equal(run.errors, 0);
  assert.equal(run.min.battery, 13.8);
  await conn.disconnect();
});

test('gauges: on a connection unlocked at connect the unlock-only gauges are polled from the first cycles', async () => {
  const { t, conn } = await connectedUnlockable();
  assert.equal(conn.unlockState, 'unlocked');
  const run = gaugeRun(conn);
  for (let i = 0; i < 10; i++) await run.step();
  assert.equal(run.sampler.values.battery.value, 13.8);
  assert.equal(run.sampler.values.gear.value, 4);
  // the graph extras (injection pulse 0x110, fuel pump 0x60, tip-over 0x63) are read too, once unlocked
  assert.deepEqual(new Set(commonIds(t)), new Set([0x07, 0x21, 0x110, 0x60, 0x63]));
  await conn.disconnect();
});

test('gauges: the graph extras are the injection pulse every cycle and one of the flags per cycle in turn, only while unlocked', async () => {
  const { t, conn } = await connectedUnlockable({}, { autoUnlock: false });
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.filter((d) => d.key === 'rpm') });
  await run.step();
  await run.step();
  assert.deepEqual(commonIds(t), [], 'locked: none of them is asked');
  assert.deepEqual(await conn.unlock(), { state: 'unlocked', reason: null });
  const from = t.requests.length;
  for (let i = 0; i < 5; i++) await run.step();
  assert.deepEqual(commonIds(t, from), [0x110, 0x60, 0x110, 0x63, 0x110, 0x60, 0x110, 0x63, 0x110, 0x60]);
  assert.equal(run.errors, 0);
  await conn.disconnect();
});

test('gauges: a refusal of an unlock-only gauge marks it not available once, never an error, and it is not asked again', async () => {
  const { t, conn } = await connectedUnlockable();
  delete t.dataIds[0x07];
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.filter((d) => ['rpm', 'battery', 'gear'].includes(d.key)) });
  for (let i = 0; i < 6; i++) await run.step();
  assert.deepEqual(run.sampler.unsupported, ['battery']);
  assert.equal(commonIds(t).filter((id) => id === 0x07).length, 1, 'asked once');
  assert.equal(run.errors, 0);
  assert.equal(run.sampler.values.gear.value, 4, 'the others carry on');
  assert.equal(conn.session.linkFailures, 0);
  await conn.disconnect();
});

test('gauges: an ECU that refuses 0x22 although the connection says unlocked marks the gauges not available, not an error', async () => {
  const { t, conn } = await connectedUnlockable();
  t.unlocked = false; // the ECU dropped the session's unlock behind the connection's back
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.filter((d) => ['rpm', 'battery', 'gear'].includes(d.key)) });
  for (let i = 0; i < 4; i++) await run.step();
  assert.deepEqual(run.sampler.unsupported.sort(), ['battery', 'gear']);
  assert.equal(run.errors, 0);
  await conn.disconnect();
});

test('gauges: while engine speed or throttle is changing only the fast PIDs are read, then the rotation comes back', async () => {
  const { t, conn } = await connectedIso();
  const run = gaugeRun(conn);
  const fast = DEFAULT_BIKE.gauges.filter((d) => !d.requiresUnlock && d.fast).map((d) => d.pid); // engine speed and throttle
  const readsOfStep = async () => {
    const before = t.requests.length;
    await run.step();
    return modeOnePids(t, before);
  };
  assert.equal((await readsOfStep()).length, fast.length + 1, 'a steady cycle: the fast ones and one other');
  t.pids[0x0c] = [0x1f, 0x40]; // engine speed jumps from 4000 to 2000 rpm
  assert.equal((await readsOfStep()).length, fast.length + 1, 'the cycle that sees the change is still a full one');
  for (let i = 0; i < 4; i++) assert.deepEqual(await readsOfStep(), fast, 'then short cycles while it was moving');
  assert.equal((await readsOfStep()).length, fast.length + 1, 'steady again: the rotation is back');
  await conn.disconnect();
});

test('gauges: a PID the ECU does not list is marked not available once, never asked, never an error', async () => {
  const { t, conn } = await connectedIso();
  delete t.pids[0x0e]; // timing advance
  const run = gaugeRun(conn);
  const before = t.requests.length;

  for (let i = 0; i < 14; i++) await run.step();

  assert.deepEqual(run.sampler.unsupported, ['timing']);
  assert.ok(!modeOnePids(t, before).includes(0x0e), 'a PID outside the bitmap is not asked');
  assert.equal(run.errors, 0);
  assert.equal(run.sampler.values.timing, undefined);
  assert.equal(run.sampler.values.trim.value, 0, 'the others carry on');
  const slow = DEFAULT_BIKE.gauges.filter((d) => !d.fast && !d.requiresUnlock && d.key !== 'timing').map((d) => d.pid);
  const asked = modeOnePids(t, before);
  assert.deepEqual(asked.filter((_, i) => i % 3 === 2).slice(0, slow.length), slow, 'the turns skip it');
  await conn.disconnect();
});

test('gauges: a PID the ECU lists but never answers is dropped after three cycles in a row, not on a single miss', async () => {
  const { t, conn } = await connectedIso();
  const modes = t.modes[0x01];
  let miss = 2; // one miss and its resend
  t.modes[0x01] = (pid) => (pid === 0x05 && miss-- > 0 ? null : modes(pid));
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.filter((d) => ['rpm', 'coolant'].includes(d.key)) });
  await run.step();
  assert.deepEqual(run.sampler.unsupported, [], 'one miss is not an answer');
  await run.step();
  assert.equal(run.sampler.values.coolant.at, 1, 'it reads fine afterwards');

  const never = gaugeRun(conn, { defs: [{ key: 'ghost', label: 'Ghost', pid: 0x05, unit: '', min: 0, max: 1, verified: false }] });
  t.modes[0x01] = (pid) => (pid === 0x05 ? null : modes(pid));
  for (let i = 0; i < 3; i++) await never.step();
  assert.deepEqual(never.sampler.unsupported, ['ghost']);
  const asked = t.requests.length;
  await never.step();
  assert.equal(modeOnePids(t, asked).includes(0x05), false, 'no longer asked');
  assert.equal(never.errors, 0);
  assert.equal(conn.session.linkFailures, 0);
  await conn.disconnect();
});

test('gauges: a PID that answered once is never dropped when the ECU goes quiet; that is up to the connection to decide', async () => {
  const { t, conn } = await connectedIso();
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.filter((d) => ['rpm', 'coolant'].includes(d.key)) });
  await run.step();
  t.modes[0x01] = () => null;
  for (let i = 0; i < 5; i++) await run.step();
  assert.deepEqual(run.sampler.unsupported, []);
  assert.equal(run.sampler.values.coolant.at, 0, 'its last value stays, with the cycle it was read in');
  await conn.disconnect();
});

test('gauges: a refusal marks the gauge not available and the run keeps polling until stopped', async () => {
  const { t, conn } = await connectedIso();
  const modes = t.modes[0x01];
  t.modes[0x01] = (pid) => (pid === 0x11 ? [0x7f, 0x33, 0x36] : modes(pid));
  const run = gaugeRun(conn, { defs: DEFAULT_BIKE.gauges.slice(0, 3) });
  await stopAfter(run, 8);
  assert.equal(run.samples, 8);
  assert.deepEqual(run.sampler.unsupported, ['tps']);
  assert.equal(run.errors, 0);
  assert.equal(run.sampler.values.rpm.value, 4000);
  await conn.disconnect();
});

test('gauges: the ECU not answering PID 00 is a failing run (errors counted), not an empty dashboard', async () => {
  const { t, conn } = await connectedIso();
  t.modes[0x01] = () => null;
  const run = gaugeRun(conn);
  await assert.rejects(() => run.step(), /did not answer mode 01 PID 00/);
  assert.equal(run.errors, 1);
  assert.deepEqual(run.sampler.unsupported, [], 'nothing is marked on a dead link');
  run.stop();
  await conn.disconnect();
});

test('the gauge CSV has a column per gauge with the latest value, and the PIDs read that cycle as raw', async () => {
  const { conn } = await connectedIso();
  const file = path.join(scratch(), 'gauges.csv');
  const run = gaugeRun(conn, { logPath: file });
  await stopAfter(run, 4);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'time,rpm,speed,tps,map,coolant,airtemp,load,timing,trim,fuelSystem,battery,gear,raw');
  const rows = lines.slice(1).map((l) => l.split(','));
  assert.deepEqual(rows[0].slice(1, 13), ['4000', '0', '50.2', '', '', '', '', '', '', '', '', ''], 'a slow gauge is blank until it has been read');
  assert.deepEqual(rows[3].slice(1, 13), ['4000', '0', '50.2', '1010', '90', '22', '', '', '', '', '', ''], 'locked: the unlock-only columns stay blank');
  assert.equal(rows[0].at(-1), '0c=3e 80|11=80|0d=00');
  assert.equal(rows[1].at(-1), '0c=3e 80|11=80|0b=65');
  assert.match(rows[0][0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  await conn.disconnect();
});

test('the run CSV time column and the graph history use the sample time: when the cycle started', async () => {
  const { conn } = await connectedIso();
  const file = path.join(scratch(), 'gauges.csv');
  const run = gaugeRun(conn, { logPath: file });
  const seen = [];
  run.on('sample', (s) => seen.push(s.t_ms));
  await stopAfter(run, 4);
  assert.equal(seen.length, 4);
  assert.ok(seen[1] > seen[0], 'the cycles take time');
  assert.deepEqual(run.history.rpm.map((p) => p[0]), seen, 'the history is stamped with the sample time');
  const times = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => Date.parse(l.split(',')[0]));
  assert.deepEqual(times, seen.map((t) => run.startedAt + t), 'the CSV row is stamped with the same moment');
  await conn.disconnect();
});

test('a run CSV never goes over an earlier one: log: true takes a numbered name when the file exists', async () => {
  const { conn } = await connected();
  const logDir = path.join(scratch(), 'logs');
  const a = blockRun(conn, { log: true, logDir });
  const b = blockRun(conn, { log: true, logDir });
  assert.notEqual(a.csvPath, b.csvPath);
  assert.equal(path.dirname(b.csvPath), logDir);
  assert.match(path.basename(b.csvPath), /^run-\d{4}-\d\d-\d\dT[\d-]+Z(-2)?\.csv$/);
  a.stop();
  b.stop();
  await conn.disconnect();
});

test('the gauge CSV carries the unlock-only gauges once they are read, with their ids in the raw column', async () => {
  const { conn } = await connectedUnlockable();
  const file = path.join(scratch(), 'gauges.csv');
  const run = gaugeRun(conn, { logPath: file, defs: DEFAULT_BIKE.gauges.filter((d) => ['rpm', 'battery', 'gear'].includes(d.key)) });
  await stopAfter(run, 3);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'time,rpm,battery,gear,raw');
  const rows = lines.slice(1).map((l) => l.split(','));
  assert.deepEqual(rows[0].slice(1, 4), ['4000', '13.8', '']);
  assert.deepEqual(rows[1].slice(1, 4), ['4000', '13.8', '4']);
  assert.equal(rows[0].at(-1), '0c=3e 80|22:0007=00 8a');
  assert.equal(rows[1].at(-1), '0c=3e 80|22:0021=00 08');
  await conn.disconnect();
});

test('probe on an OBD session needs the unlock: locked it refuses to start and sends nothing', async () => {
  const { t, conn } = await connectedIso();
  const before = t.requests.length;
  assert.throws(() => probeRun(conn), (e) => e instanceof NeedsUnlockError && /needs the ECU unlock, not available/.test(e.message));
  assert.deepEqual(conn.runs, [], 'nothing registered');
  assert.equal(t.requests.length, before);
  await conn.disconnect();
});

test('probe on an unlocked OBD session gives up early with the reason instead of asking all 255 ids', async () => {
  const { t, conn } = await connectedUnlockable();
  const run = probeRun(conn);
  assert.equal(await run.start(), 'finished');
  assert.equal(run.sampler.found.length, 0);
  assert.equal(run.samples, 8);
  assert.match(run.sampler.blocked, /not available: the ECU served none of the first 8 block ids, even unlocked/);
  assert.deepEqual(t.requests.filter((r) => r.service === 0x21).map((r) => r.data[1]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(conn.config().localId, undefined);
  assert.equal(run.errors, 0, 'an explanation, not a failure');
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('switches: an id the ECU refuses is asked once per scan (not resent) and dropped after 6 scans, the rest keep being read, changes are flagged', async () => {
  const { t, conn } = await connected();
  const run = switchRun(conn, { ids: [0x41, 0x99, 0x60] });
  let before = t.requests.length;

  const first = await run.step();
  assert.deepEqual(first.rows.map((r) => r.id), [0x41, 0x60], 'a refused id has no row');
  assert.equal(t.requests.length - before, 3, 'all three asked once: a refusal is not resent');
  assert.deepEqual(run.sampler.ids, [0x41, 0x99, 0x60], 'the refused id is not dropped on its first miss');

  before = t.requests.length;
  await run.step();
  await run.step();
  assert.equal(t.requests.length - before, 6, 'still asked every scan while it has had fewer than 6 scans');
  assert.deepEqual(run.changed(), ['65'], 'the clutch moved (0x41), the other switch did not');

  for (let scan = 4; scan <= 6; scan++) await run.step();
  assert.deepEqual(run.sampler.ids, [0x41, 0x60], 'dropped after the 6th scan without ever answering');
  before = t.requests.length;
  await run.step();
  assert.equal(t.requests.length - before, 2, 'and not asked again');
  assert.equal(run.errors, 0);
  await conn.disconnect();
});

test('switches on the bike need the unlock: locked the run refuses to start and sends nothing', async () => {
  const { t, conn } = await connectedIso();
  const before = t.requests.length;
  assert.throws(() => switchRun(conn), NeedsUnlockError);
  assert.equal(t.requests.length, before);
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('switches on an unlocked bike are read, the refused and silent ids dropped after 6 scans, the clutch flagged as changing', async () => {
  const { t, conn } = await connectedUnlockable();
  delete t.dataIds[0x40]; // refused
  t.silentIds.add(0x70); // no answer at all
  // 0x61, 0x63 and 0x68 are in the bike's table but not in the mock's id table: refused too
  const run = switchRun(conn);
  assert.deepEqual(run.sampler.ids, DEFAULT_BIKE.switchIds);
  const notServed = [0x40, 0x61, 0x63, 0x68, 0x70];
  const served = DEFAULT_BIKE.switchIds.filter((id) => !notServed.includes(id));
  assert.deepEqual(served, [0x41, 0x46, 0x60, 0x69, 0x42, 0x44, 0x62, 0x64, 0x66]);
  const first = await run.step();
  assert.deepEqual(first.rows.map((r) => r.id), served, 'rows only for the ids that answered');
  assert.deepEqual(run.sampler.ids, DEFAULT_BIKE.switchIds, 'nobody is dropped after one scan');
  for (let scan = 2; scan <= 5; scan++) await run.step();
  assert.deepEqual(run.sampler.ids, DEFAULT_BIKE.switchIds, 'nor after five');
  await run.step();
  assert.deepEqual(run.sampler.ids, served, 'after the 6th scan the ids that never answered are dropped');
  await run.step();
  assert.deepEqual(run.changed().sort(), ['65', '96']);
  assert.equal(run.errors, 0);
  assert.equal(commonIds(t).filter((id) => id === 0x40).length, 6, 'a refused id is asked once per scan (not resent) for 6 scans');
  assert.equal(commonIds(t).filter((id) => id === 0x70).length, 12, 'a silent one is asked twice per scan (resent once) for 6 scans');
  assert.equal(commonIds(t).filter((id) => id === 0x41).length, 7, 'an id that answers is asked once per scan, 7 scans');
  await conn.disconnect();
});

test('switches: an id named twice is asked once per scan, with one row', async () => {
  const { t, conn } = await connected();
  const run = switchRun(conn, { ids: [0x41, 0x60, 0x41] });
  const before = t.requests.length;
  const sample = await run.step();
  assert.equal(t.requests.length - before, 2);
  assert.deepEqual(sample.rows.map((r) => r.id), [0x41, 0x60]);
  assert.deepEqual(run.sampler.ids, [0x41, 0x60]);
  await conn.disconnect();
});

test('a switch run polls by itself when started', async () => {
  const { conn } = await connected();
  const run = switchRun(conn, { ids: [0x41, 0x60] });
  await stopAfter(run, 4);
  assert.equal(run.samples, 4);
  assert.deepEqual(run.changed(), ['65']);
  await assert.rejects(() => run.step(), /stopped/);
  await conn.disconnect();
});

test('switches: a silent first read is resent once and then answered, with no row marked stale and no error', async () => {
  const { t, conn } = await connectedUnlockable();
  t.inject('dropReply', { service: 0x22 }); // the ECU ignores the very first 0x22 request
  const run = switchRun(conn, { ids: [0x41, 0x60] });
  const before = t.requests.length;
  const sample = await run.step();
  assert.deepEqual(commonIds(t, before), [0x41, 0x41, 0x60], 'the silent request was sent again, the next id asked once');
  assert.deepEqual(sample.rows.map((r) => r.id), [0x41, 0x60]);
  assert.ok(sample.rows.every((r) => r.value !== null && !r.stale));
  assert.equal(run.errors, 0, 'silence is not an error');
  await conn.disconnect();
});

test('switches: an id that answered once keeps its row with its last value and stale: true while the ECU is silent on it', async () => {
  const { t, conn } = await connectedUnlockable();
  const run = switchRun(conn, { ids: [0x41, 0x60] });
  const first = await run.step();
  const clutch = first.rows.find((r) => r.id === 0x41);
  assert.equal(clutch.value, 254);
  assert.ok(!clutch.stale);

  t.silentIds.add(0x41);
  const before = t.requests.length;
  const second = await run.step();
  assert.deepEqual(commonIds(t, before), [0x41, 0x41, 0x60], 'a silent id costs two requests per scan');
  assert.deepEqual(second.rows.map((r) => r.id), [0x41, 0x60], 'the row stays');
  assert.deepEqual(second.rows[0], { ...clutch, stale: true }, 'its last value (and bytes), marked stale');
  assert.ok(!second.rows[1].stale, 'the id that answers is live');
  assert.equal(second.channels[0x41], 254);

  for (let scan = 3; scan <= 12; scan++) await run.step(); // far beyond the 6 scans an id that never answered gets
  assert.deepEqual(run.sampler.ids, [0x41, 0x60], 'never dropped');
  assert.deepEqual(run.latest.rows[0], { ...clutch, stale: true });
  assert.equal(run.errors, 0);

  t.silentIds.delete(0x41);
  const back = await run.step();
  assert.ok(!back.rows[0].stale, 'live again once it answers');
  assert.notEqual(back.rows[0].value, null);
  await conn.disconnect();
});

test('switches: an id that never answers is asked for 6 full scans (twice each when silent), not fewer, then dropped', async () => {
  const { t, conn } = await connectedUnlockable();
  t.silentIds.add(0x60);
  const run = switchRun(conn, { ids: [0x41, 0x60] });
  for (let scan = 1; scan <= 5; scan++) {
    const sample = await run.step();
    assert.deepEqual(run.sampler.ids, [0x41, 0x60], `still asked after scan ${scan}`);
    assert.deepEqual(sample.rows.map((r) => r.id), [0x41], 'but it has no row');
  }
  assert.equal(commonIds(t).filter((id) => id === 0x60).length, 10);
  await run.step();
  assert.deepEqual(run.sampler.ids, [0x41], 'dropped after the 6th scan');
  assert.equal(commonIds(t).filter((id) => id === 0x60).length, 12);
  await run.step();
  assert.equal(commonIds(t).filter((id) => id === 0x60).length, 12, 'and not asked again');
  assert.equal(run.errors, 0);
  await conn.disconnect();
});

test('switch run analogs: one that never answers is marked unavailable only after 6 scans, one that answered keeps its last value', async () => {
  const { t, conn } = await connectedUnlockable();
  const analogs = DEFAULT_BIKE.analogs.filter((a) => a.key === 'sidestandV' || a.key === 'rolloverV');
  t.silentIds.add(0x28); // the rollover voltage never answers
  const run = switchRun(conn, { ids: [0x60], analogs });
  await run.step();
  await run.step();
  assert.deepEqual(Object.keys(run.sampler.analogs), ['sidestandV']);
  const lastSidestand = run.sampler.analogs.sidestandV;
  assert.equal(lastSidestand.hex, '00 80');
  t.silentIds.add(0x26); // now the sidestand voltage goes silent too
  for (let scan = 3; scan <= 5; scan++) {
    await run.step();
    assert.deepEqual(run.sampler.analogsUnavailable, [], `not marked after scan ${scan}`);
  }
  await run.step();
  assert.deepEqual(run.sampler.analogsUnavailable, ['rolloverV'], 'marked after the 6th scan, and only the one that never answered');
  assert.deepEqual(run.sampler.analogs.sidestandV, lastSidestand, 'the one that answered keeps its last value');
  const asked = (id) => commonIds(t).filter((x) => x === id).length;
  assert.equal(asked(0x28), 12, 'twice per scan for 6 scans');
  await run.step();
  assert.equal(asked(0x28), 12, 'then not asked');
  assert.equal(asked(0x26), 2 + 2 * 5, 'the silent one that answered once is still asked, twice per scan');
  assert.deepEqual(run.sampler.analogsUnavailable, ['rolloverV']);
  await conn.disconnect();
});

test('probe finishes by itself, reports what it found and saves the biggest block', async () => {
  const { conn } = await connected();
  const run = probeRun(conn, { from: 0x7c, to: 0x84 });
  const progress = [];
  run.on('sample', ({ id }) => progress.push(id));

  assert.equal(await run.start(), 'finished');
  assert.deepEqual(progress, [0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81, 0x82, 0x83, 0x84]);
  assert.deepEqual(run.sampler.found.map((f) => f.id), [0x80]);
  assert.equal(run.sampler.found[0].length, 64);
  assert.equal(run.sampler.biggest.id, 0x80);
  assert.equal(conn.config().localId, 0x80);
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('a cancelled probe saves nothing', async () => {
  const { conn } = await connected();
  const run = probeRun(conn, { from: 0x70 });
  assert.equal(await stopAfter(run, 12), 'cancelled');
  assert.ok(run.sampler.current < 0xff);
  assert.equal(conn.config().localId, undefined);
  await conn.disconnect();
});

test('a run needs a session, and starting a run under a used name replaces the old one', async () => {
  const idle = new Connection({ configPath: path.join(scratch(), 'config.json') });
  assert.throws(() => blockRun(idle), /not connected/);

  const { conn } = await connected();
  const a = blockRun(conn);
  const b = blockRun(conn);
  assert.equal(a.outcome, 'cancelled');
  assert.equal(b.running, true);
  assert.deepEqual(conn.runs, ['live']);
  assert.throws(() => { b.start(); b.start(); }, /already started/);
  await assert.rejects(() => b.step(), /polling by itself/);
  b.stop();
  await conn.disconnect();
});

test('any sampler can be run: status reports the run, step() surfaces the error', async () => {
  const { conn } = await connected();
  let n = 0;
  const sampler = {
    name: 'custom',
    async sample() {
      if (++n === 2) throw new Error('boom');
      return { channels: { x: n } };
    },
  };
  const run = new LiveRun(conn, sampler, { interval: 0 });
  await run.step();
  await assert.rejects(() => run.step(), /boom/);
  await run.step();
  assert.deepEqual(run.status(), {
    name: 'custom', running: true, outcome: null, cycles: 3, samples: 2, errors: 1, lastError: 'boom', csvPath: null, startedAt: run.startedAt,
  });
  assert.equal(run.min.x, 1);
  assert.equal(run.max.x, 3);
  run.stop();
  await conn.disconnect();
});
