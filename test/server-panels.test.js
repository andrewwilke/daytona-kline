'use strict';

// The GUI server's switches panel, Record and Find more IDs routes (see also server.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, state } = require('../server');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const call = (route, body) => routes[route](body ?? {});
const LOCKED_NOTE = /^needs the ECU unlock, not available \(/;

/** An ISO mock that does security access, connected through the server's routes; `autoUnlock: false` leaves it locked. */
async function connectBike({ autoUnlock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = autoUnlock;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

const useLogs = () => {
  state.logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-logs-')), 'logs');
  return state.logDir;
};

// ---- Switches panel: named tiles and analog extras ------------------------------

test('the switches endpoint serves named tiles with the decoded state, the raw bytes and how far each label is trusted', async () => {
  const t = await connectBike();
  t.dataIds[0x46] = [0, 0xff]; // the starter button is pressed
  t.dataIds[0x41] = [0, 0x00]; // the clutch lever is pulled
  t.dataIds[0x61] = [0, 0x00]; // the three ids that answer only now and then on the bike: serve them so every named tile shows
  t.dataIds[0x63] = [0, 0xff];
  t.dataIds[0x68] = [0, 0x00];
  const r = await call('GET /api/switches');
  assert.equal(r.available, true);
  const tile = (name) => r.rows.find((x) => x.name === name);
  assert.deepEqual(r.rows.map((x) => x.name), conn.bike.switches.map((s) => s.name), "the named ones in the bike table's order");
  assert.deepEqual(
    { ...tile('Start switch'), evidence: undefined },
    { id: 0x46, key: 'startSwitch', named: true, name: 'Start switch', inverted: false, confirmation: 'confirmed', evidence: undefined, active: true, state: 'PRESSED', bad: false, raw: [0, 0xff], hex: '00 ff', stale: false },
  );
  assert.deepEqual([tile('Clutch').state, tile('Clutch').active, tile('Clutch').hex], ['PULLED', true, '00 00']);
  assert.deepEqual([tile('Neutral').state, tile('Neutral').confirmation], ['IN NEUTRAL', 'consistent']);
  assert.deepEqual([tile('Sidestand').state, tile('Sidestand').active, tile('Sidestand').confirmation], ['DOWN', true, 'confirmed'], '00 ff = stand down');
  assert.deepEqual([tile('Dash alive (flag 0x61)').state, tile('Dash alive (flag 0x61)').confirmation, tile('Dash alive (flag 0x61)').key], ['DASH OFF', 'unconfirmed', 'engineLamp']);
  assert.deepEqual([tile('Tip-over sensor').state, tile('Tip-over sensor').key, tile('Tip-over sensor').confirmation, tile('Tip-over sensor').hex], ['NOT TRIPPED', 'tipOver', 'confirmed', '00 ff'], '00 ff reads NOT TRIPPED (good)');
  assert.equal(tile('Tip-over sensor').bad, false);
  assert.deepEqual([tile('Dash lamp (id 0x68)').state, tile('Dash lamp (id 0x68)').key], ['OFF', 'dashLamp68']);
  assert.ok(r.rows.every((x) => x.stale === false), 'every tile answered this scan: none is stale');
  assert.equal(tile('Main relay').state, 'ON');
  assert.ok(['ON', 'OFF'].includes(tile('Fuel pump').state));
  assert.equal(tile('Air flap').confirmation, 'unconfirmed');
  assert.match(tile('Air flap').evidence, /not tested/);
  await call('POST /api/disconnect');
});

test('ids the bike table does not name come after the named ones as ID 0x....', async () => {
  const bike = conn.bike;
  conn.bike = { ...bike, switchIds: [0x0123, ...bike.switchIds, 0x0010] };
  try {
    const t = await connectBike();
    t.dataIds[0x61] = [0, 0x00]; // the three table ids the mock does not serve by default: serve them here
    t.dataIds[0x63] = [0, 0xff];
    t.dataIds[0x68] = [0, 0x00];
    const r = await call('GET /api/switches');
    const names = r.rows.map((x) => x.name);
    assert.deepEqual(names.slice(-2), ['ID 0x0010', 'ID 0x0123']);
    assert.deepEqual(names.slice(0, -2), bike.switches.map((s) => s.name));
    const unnamed = r.rows.at(-1);
    assert.deepEqual([unnamed.named, unnamed.state, unnamed.active, unnamed.hex, unnamed.confirmation], [false, null, null, '00 01', null]);
    await call('POST /api/disconnect');
  } finally {
    conn.bike = bike;
  }
});

test('the analog extras come as volts tiles with a note on how to confirm them; the recorded-only analogs (panel: false) are not tiles', async () => {
  const t = await connectBike();
  for (const id of [0x110, 0x111, 0x112, 0x120, 0x121, 0x122]) t.dataIds[id] = [0, 10]; // served by the ECU, but not for the panel
  const first = await call('GET /api/switches');
  assert.deepEqual(first.analogs.map((a) => [a.key, a.id, a.value, a.hex, a.unit, a.verified, a.available]), [
    ['sidestandV', 0x26, 2.51, '00 80', 'V', false, true],
    ['rolloverV', 0x28, 2.5, '02 00', 'V', false, true],
  ]);
  assert.match(first.analogs[0].note, /lifting and lowering the sidestand/);
  assert.match(first.analogs[1].note, /tilt the bike/);
  const recordedOnly = t.requests.filter((q) => q.service === 0x22 && q.data[1] >= 0x01);
  assert.equal(recordedOnly.length, 0, 'the panel does not ask the 0x110.. / 0x120.. analogs');

  t.dataIds[0x26] = [0, 255]; // the stand moves
  assert.equal((await call('GET /api/switches')).analogs[0].value, 5);
  await call('POST /api/disconnect');
});

test('an analog that answered and then goes silent keeps its last value (asked twice per scan, never marked not available)', async () => {
  const t = await connectBike();
  await call('GET /api/switches');
  t.silentIds.add(0x28);
  const asked = () => t.requests.filter((q) => q.service === 0x22 && q.data[1] === 0x00 && q.data[2] === 0x28).length;
  const before = asked();
  const second = await call('GET /api/switches');
  assert.equal(asked() - before, 2, 'the silent request is resent once');
  assert.deepEqual([second.analogs[1].available, second.analogs[1].value, second.analogs[1].hex], [true, 2.5, '02 00']);
  for (let i = 0; i < 8; i++) await call('GET /api/switches');
  const last = await call('GET /api/switches');
  assert.deepEqual([last.analogs[1].available, last.analogs[1].value], [true, 2.5], 'still there after many silent scans');
  assert.equal(asked() - before, 20, 'and still asked, twice, on every one of the 10 scans');
  assert.equal(last.analogs[0].available, true, 'the other one carries on');
  await call('POST /api/disconnect');
});

test('an analog that never answers is "not available", and asked (twice per scan) only for the first 6 scans', async () => {
  const t = await connectBike();
  t.silentIds.add(0x28);
  const asked = () => t.requests.filter((q) => q.service === 0x22 && q.data[1] === 0x00 && q.data[2] === 0x28).length;
  for (let scan = 1; scan <= 6; scan++) {
    const r = await call('GET /api/switches');
    assert.deepEqual([r.analogs[1].available, r.analogs[1].value, r.analogs[1].hex], [false, null, null], `scan ${scan}`);
    assert.equal(r.analogs[0].available, true, 'the other one carries on');
    assert.equal(asked(), 2 * scan, `scan ${scan}: the request and its resend`);
    assert.deepEqual(state.switches.sampler.analogsUnavailable, scan < 6 ? [] : ['rolloverV'], 'marked only after the 6th scan');
  }
  const seventh = await call('GET /api/switches');
  assert.equal(asked(), 12, 'not asked any more');
  assert.equal(seventh.analogs[1].available, false);
  assert.equal(seventh.available, true);
  await call('POST /api/disconnect');
});

test('a switch that answered and then goes silent is served stale with its last value; one that never answered has no tile', async () => {
  const t = await connectBike();
  t.dataIds[0x61] = [0, 0xff]; // the dash flag 0x61 answers on the first scan only (made silent below)
  const first = await call('GET /api/switches');
  assert.ok(first.rows.every((x) => x.stale === false));
  const clutchFirst = first.rows.find((x) => x.name === 'Clutch');
  t.silentIds.add(0x41);
  t.silentIds.add(0x61);
  const second = await call('GET /api/switches');
  const clutch = second.rows.find((x) => x.name === 'Clutch');
  assert.equal(clutch.stale, true);
  assert.deepEqual([clutch.hex, clutch.raw, clutch.state], [clutchFirst.hex, clutchFirst.raw, clutchFirst.state], 'the last value, not a blank');
  assert.equal(second.rows.find((x) => x.name === 'Dash alive (flag 0x61)').stale, true);
  assert.deepEqual(second.rows.map((x) => x.name), first.rows.map((x) => x.name), 'no tile disappears');
  assert.equal(second.rows.find((x) => x.name === 'Neutral').stale, false, 'the others are live');
  assert.equal(second.rows.find((x) => x.name === 'Tip-over sensor'), undefined, 'a table id the ECU never answered has no tile');
  t.silentIds.delete(0x41);
  const third = await call('GET /api/switches');
  assert.equal(third.rows.find((x) => x.name === 'Clutch').stale, false, 'and it is live again once the ECU answers');
  await call('POST /api/disconnect');
});

test('while locked the switches endpoint answers with no tiles and no analogs', async () => {
  await connectBike({ autoUnlock: false });
  const r = await call('GET /api/switches');
  assert.deepEqual([r.locked, r.rows, r.analogs], [true, [], []]);
  await call('POST /api/disconnect');
});

// ---- Record -------------------------------------------------------------------

test('the record routes: start, a marker on the next sample, the live view, stop', async () => {
  const logDir = useLogs();
  await connectBike();
  assert.deepEqual(await call('GET /api/record'), { active: false });
  await call('POST /api/gauges/start');
  await until(() => state.gauges.cycles >= 1);

  await call('POST /api/record/start', { minutes: 5 });
  assert.equal(state.gauges.running, false, 'the dashboard loop stops: one run at a time on the K-line');
  assert.deepEqual(conn.runs, ['record']);
  await call('POST /api/record/start', { minutes: 5 }); // a second click changes nothing
  assert.equal(conn.runs.length, 1);
  await until(() => state.record.samples >= 3);

  const m = await call('POST /api/record/mark', { text: 'Cranking' });
  assert.equal(m.marker.text, 'Cranking');
  await assert.rejects(() => call('POST /api/record/mark', { text: '   ' }), /type a note to mark/);
  const seen = state.record.samples;
  await until(() => state.record.samples >= seen + 2);

  const v = await call('GET /api/record');
  assert.equal(v.active, true);
  assert.equal(v.running, true);
  assert.deepEqual(v.markers.map((x) => x.text), ['Cranking']);
  assert.match(v.csvFile, /^record-.*\.csv$/);
  assert.equal(path.dirname(v.csvPath), logDir);
  assert.ok(v.elapsedMs > 0 && v.samples >= 5);
  assert.deepEqual(Object.keys(v.battery), ['min', 'max', 'last']);
  assert.deepEqual(v.locked, []);
  assert.deepEqual(Object.keys(v.live).sort(), ['battery', 'fuelPump', 'mainRelay', 'rpm', 'startSwitch', 'throttle']);
  assert.equal(v.live.battery, 13.8);
  assert.ok(Array.isArray(v.events));

  await call('POST /api/record/stop');
  await until(() => !state.record.running);
  const done = await call('GET /api/record');
  assert.equal(done.running, false);
  assert.equal(done.outcome, 'cancelled');
  await new Promise((r) => setImmediate(r));
  const rows = fs.readFileSync(v.csvPath, 'utf8').trim().split('\n');
  assert.ok(rows.some((row) => row.includes(',Cranking,')), 'the marker is in the CSV');
  assert.deepEqual(conn.runs, []);
  await assert.rejects(() => call('POST /api/record/mark', { text: 'late' }), /not recording/);
  await call('POST /api/disconnect');
  state.logDir = undefined;
});

test('recording works while the ECU is locked: OBD values only, with the reason', async () => {
  useLogs();
  const t = await connectBike({ autoUnlock: false });
  await call('POST /api/record/start', {});
  await until(() => state.record.samples >= 8);
  const v = await call('GET /api/record');
  assert.ok(v.locked.includes('battery') && v.locked.includes('fuelPump') && v.locked.includes('sidestandV'));
  assert.match(v.lockedNote, LOCKED_NOTE);
  assert.equal(v.live.rpm, 4000);
  assert.equal(v.live.battery, null);
  assert.equal(t.requests.filter((r) => r.service === 0x22).length, 0, 'no 0x22 request while locked');
  await call('POST /api/record/stop');
  await until(() => !state.record.running);
  await call('POST /api/disconnect');
  state.logDir = undefined;
});

test('a disconnect ends the recording and its view stays; recording and the id scan do not run together', async () => {
  useLogs();
  await connectBike();
  await call('POST /api/discover/start', { from: 0, to: 0xffff });
  await assert.rejects(() => call('POST /api/record/start', {}), /the id scan is running: stop it first/);
  await call('POST /api/discover/stop');
  await until(() => !state.discover.running);
  await call('POST /api/record/start', {});
  await assert.rejects(() => call('POST /api/discover/start', {}), /a recording is running: stop it first/);
  await assert.rejects(() => call('POST /api/snapshot', { which: 'a' }), /stop the recording or the id scan first/);
  await until(() => state.record.samples >= 2);
  await call('POST /api/disconnect');
  await until(() => !state.record.running);
  const v = await call('GET /api/record');
  assert.equal(v.outcome, 'cancelled');
  assert.ok(v.samples >= 2, 'what was recorded is still shown');
  state.logDir = undefined;
});

test('the record routes need a session', async () => {
  await call('POST /api/disconnect');
  await assert.rejects(() => call('POST /api/record/start', {}), /not connected/);
});

// ---- Find more IDs --------------------------------------------------------------

test("the id scan: progress, the ids found with the bike's names, the saved file", async () => {
  const logDir = useLogs();
  const t = await connectBike();
  t.silentIds.add(0x05);
  state.discover = null;
  assert.equal((await call('GET /api/discover')).active, false);
  await call('POST /api/discover/start', { from: 0x00, to: 0x30 });
  await call('POST /api/discover/start', { from: 0x00, to: 0x30 }); // a second click changes nothing
  await until(() => !state.discover.running);

  const v = await call('GET /api/discover');
  assert.equal(v.active, true);
  assert.deepEqual([v.from, v.to, v.asked, v.total, v.running, v.outcome], [0, 0x30, 0x31, 0x31, false, 'finished']);
  assert.deepEqual(v.found.map((f) => [f.id, f.hex, f.name]), [
    [0x07, '00 8a', 'Battery'], [0x10, '12 34', null], [0x11, '00 05', null], [0x21, '00 08', 'Gear'], [0x26, '00 80', 'Sidestand sensor'], [0x28, '02 00', 'Rollover (tip-over) switch'],
  ]);
  assert.equal(v.silent, 1);
  assert.match(v.resultFile, /^discovered-ids-.*\.json$/);
  assert.equal(path.dirname(v.resultPath), logDir);
  assert.deepEqual(v.snapshot, { a: null, b: null, changes: null, note: null });
  assert.ok(t.requests.filter((r) => r.service === 0x22).every((r) => r.data.length === 3));
  await call('POST /api/disconnect');
  state.logDir = undefined;
});

test('snapshot A, do something, snapshot B: the ids that changed, with before and after', async () => {
  useLogs();
  const t = await connectBike();
  state.discover = null;
  state.snapshot = null;
  await assert.rejects(() => call('POST /api/snapshot', { which: 'b' }), /take snapshot A first/);
  await assert.rejects(() => call('POST /api/snapshot', { which: 'c' }), /which must be/);

  // before any scan: the ids the bike table names, with a note
  const a0 = await call('POST /api/snapshot', { which: 'a' });
  assert.equal(a0.a.count, 15);
  assert.match(a0.note, /Scan first/);

  // after a scan: every id it found
  await call('POST /api/discover/start', { from: 0x00, to: 0x30 });
  await until(() => !state.discover.running);
  const a = await call('POST /api/snapshot', { which: 'a' });
  assert.equal(a.a.count, 6);
  assert.equal(a.note, null);
  assert.equal(a.b, null);

  t.dataIds[0x11] = [0, 9]; // something moved
  t.dataIds[0x28] = [3, 0xff];
  const b = await call('POST /api/snapshot', { which: 'b' });
  assert.equal(b.b.count, 6);
  assert.deepEqual(b.changes, [
    { id: 0x11, name: null, before: '00 05', after: '00 09' },
    { id: 0x28, name: 'Rollover (tip-over) switch', before: '02 00', after: '03 ff' },
  ]);
  assert.deepEqual((await call('GET /api/discover')).snapshot.changes, b.changes);

  const again = await call('POST /api/snapshot', { which: 'a' });
  assert.equal(again.changes, null, 'a new A clears the old result');
  await call('POST /api/disconnect');
  state.logDir = undefined;
});

test('while locked, the id scan and the snapshots answer "locked" and ask the ECU nothing', async () => {
  useLogs();
  const t = await connectBike({ autoUnlock: false });
  const sent = t.requests.length;
  for (const [route, body] of [['POST /api/discover/start', {}], ['POST /api/snapshot', { which: 'a' }]]) {
    const r = await call(route, body);
    assert.equal(r.locked, true, route);
    assert.match(r.note, LOCKED_NOTE);
  }
  assert.equal(t.requests.length, sent);
  assert.deepEqual(conn.runs, []);
  await call('POST /api/disconnect');
  for (const route of ['POST /api/discover/start', 'POST /api/snapshot']) await assert.rejects(() => call(route, { which: 'a' }), /not connected/, route);
  state.logDir = undefined;
});
