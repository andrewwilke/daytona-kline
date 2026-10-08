'use strict';

// What the graphs are fed with: the run history behind `series(since)`, the gauge run's fuel extras,
// the server's series / recordings routes and the CSV reader for saved recordings.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, state } = require('../server');
const { listRecordings, loadRecording, parseCsv } = require('../src/recordings');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const query = (q) => new URLSearchParams(q);

async function connectBike() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = true;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  await routes['POST /api/connect']({ port: 'MOCK' });
  return t;
}

const logs = () => {
  state.logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-logs-')), 'logs');
  fs.mkdirSync(state.logDir, { recursive: true });
  return state.logDir;
};

test('the gauge run graphs the injection pulse, fuel pump and tip-over flag once unlocked, and series(since) hands out only what is newer', async () => {
  const t = await connectBike();
  t.dataIds[0x110] = [0x0b, 0xb8]; // 3000 us
  t.dataIds[0x60] = [0, 0xff]; // fuel pump on
  t.dataIds[0x63] = [0, 0x00]; // tip-over flag off: tripped
  await routes['POST /api/gauges/start']();
  await until(() => state.gauges.samples >= 4);
  const all = (await routes['GET /api/gauges']({}, query('since=-1'))).series;
  assert.ok(all.injPulse1.length >= 3, 'the injection pulse has points');
  assert.equal(all.injPulse1[0][1], 3);
  assert.equal(all.fuelPump[0][1], 1);
  assert.equal(all.tipOver[0][1], 0);
  assert.ok(all.rpm?.length, 'the OBD gauges are graphed too');
  const times = all.injPulse1.map((p) => p[0]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const newest = Math.max(...Object.values(all).map((pts) => pts[pts.length - 1][0]));
  const later = state.gauges.series(newest);
  assert.deepEqual(later, {}, 'nothing is newer than the newest point');
  const middle = state.gauges.series(times[1]);
  assert.ok(middle.injPulse1.every((p) => p[0] > times[1]));
  assert.equal(typeof (await routes['GET /api/gauges']({}, query('since=-1'))).elapsedMs, 'number');
  assert.equal((await routes['GET /api/gauges']({}, query(''))).series, undefined, 'no series unless asked for');
  await routes['POST /api/gauges/stop']();
  await routes['POST /api/disconnect']();
});

test('locked, the gauge run leaves the unlock-only extras out of the graphs and reads only the OBD values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = false;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  await routes['POST /api/connect']({ port: 'MOCK' });
  t.dataIds[0x110] = [0x0b, 0xb8];
  await routes['POST /api/gauges/start']();
  await until(() => state.gauges.samples >= 3);
  const { series } = await routes['GET /api/gauges']({}, query('since=-1'));
  assert.ok(series.rpm?.length);
  assert.equal(series.injPulse1, undefined);
  await routes['POST /api/gauges/stop']();
  await routes['POST /api/disconnect']();
  conn.autoUnlock = true;
});

test('parseCsv handles quoted cells with commas, quotes and blank cells', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,"x, ""y""",\n2,3,4'), [['a', 'b', 'c'], ['1', 'x, "y"', ''], ['2', '3', '4']]);
});

test('a saved recording loads as series, events and markers; blank cells make no point and _raw columns are left out', () => {
  const dir = logs();
  const csv = [
    't_ms,cycle_ms,rpmId,injPulse1,tipOver,battery_raw,marker,event',
    '0,1800,0,,1,00 8a,,',
    '1800,1750,1200,2.5,1,00 8a,Started,',
    '3600,1760,0,0,0,00 8a,,"tip-over sensor TRIPPED; engine stopped"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'record-2026-01-01T00-00-00-000Z.csv'), csv);
  const r = loadRecording('record-2026-01-01T00-00-00-000Z.csv', dir);
  assert.equal(r.durationMs, 3600);
  assert.deepEqual(r.series.rpmId, [[0, 0], [1800, 1200], [3600, 0]]);
  assert.deepEqual(r.series.injPulse1, [[1800, 2.5], [3600, 0]]);
  assert.deepEqual(r.series.tipOver, [[0, 1], [1800, 1], [3600, 0]]);
  assert.equal(r.series.battery_raw, undefined);
  assert.deepEqual(r.markers, [{ t_ms: 1800, text: 'Started' }]);
  assert.deepEqual(r.events.map((e) => e.text), ['tip-over sensor TRIPPED', 'engine stopped']);
});

test('only recording files can be listed or opened: other names and paths are refused', async () => {
  const dir = logs();
  fs.writeFileSync(path.join(dir, 'record-2026-01-01T00-00-00-000Z.csv'), 't_ms,rpm\n0,1\n');
  fs.writeFileSync(path.join(dir, 'unlock.json'), 'not for the page');
  fs.writeFileSync(path.join(dir, 'output-tests-2026-01-01.txt'), 'x');
  assert.deepEqual(listRecordings(dir).map((r) => r.name), ['record-2026-01-01T00-00-00-000Z.csv']);
  const { recordings } = await routes['GET /api/recordings']();
  assert.equal(recordings.length, 1);
  for (const bad of ['../server.js', '..\\server.js', 'unlock.json', 'record-x/../../unlock.json', '', 'record-2026.csv.txt']) {
    assert.throws(() => loadRecording(bad, dir), /not a recording file name/, bad);
  }
  assert.throws(() => loadRecording('record-nothing.csv', dir), /no recording named/);
  const ok = await routes['GET /api/recordings/load']({}, query('name=record-2026-01-01T00-00-00-000Z.csv'));
  assert.deepEqual(ok.series.rpm, [[0, 1]]);
  await assert.rejects(() => routes['GET /api/recordings/load']({}, query('name=unlock.json')), /not a recording file name/);
});

test('a recording in progress serves its series through /api/record?since=', async () => {
  const dir = logs();
  const t = await connectBike();
  t.dataIds[0x110] = [0x03, 0xe8];
  await routes['POST /api/record/start']({});
  await until(() => state.record.samples >= 3);
  const v = await routes['GET /api/record']({}, query('since=-1'));
  assert.ok(v.series.rpm || v.series.battery, 'the recorded channels come with the view');
  assert.ok(Object.values(v.series).every((pts) => pts.length && pts[0].length === 2));
  assert.equal((await routes['GET /api/record']({}, query(''))).series, undefined);
  await routes['POST /api/record/stop']();
  await until(() => !state.record.running);
  assert.ok(listRecordings(dir).length >= 1);
  await routes['POST /api/disconnect']();
});
