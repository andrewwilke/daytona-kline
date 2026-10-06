'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services');
const { DEFAULT_BIKE: bike } = require('../src/bikes');
const { awakeSession } = require('./helpers');
const { unlockSession } = require('../src/unlock');

test('ECU identification', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const ids = await svc.readEcuId(session);
  assert.equal(ids.length, 1);
  assert.match(ids[0].ascii, /T675-KEIHIN/);
});

test('DTC read handles responsePending and gives every code the one shape, with its description', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const { count, dtcs, pendingSupported, status } = await svc.readDtcs(session, bike);
  assert.equal(count, 2);
  assert.deepEqual(dtcs, [
    { code: 'P0515', status: 'reported', statusByte: 0xe0, description: null },
    { code: 'P1113', status: 'reported', statusByte: 0x60, description: null },
  ]);
  assert.equal(pendingSupported, null, 'the KWP fallback does not ask for pending codes');
  assert.equal(status, null, 'this ECU has no mode 01 status');
});

test('OBD mode 03/07 DTC read across multiple reply frames, same shape, descriptions from the bike', async () => {
  const { session } = await awakeSession({ target: 0xd5, obd: true }, { source: 0xf5 });
  const { dtcs } = await svc.readDtcs(session, bike);
  assert.deepEqual(dtcs, [
    { code: 'P0078', status: 'stored', statusByte: null, description: 'Exhaust valve actuator circuit' },
    { code: 'P0135', status: 'stored', statusByte: null, description: null },
    { code: 'P0505', status: 'stored', statusByte: null, description: 'Idle speed control' },
    { code: 'P0122', status: 'stored', statusByte: null, description: 'TPS low' },
    { code: 'P0335', status: 'pending', statusByte: null, description: 'Crank position sensor' },
  ]);
  await svc.clearDtcs(session);
  assert.equal((await svc.readDtcs(session, bike)).count, 0);
});

test('without a bike the codes still read, with no descriptions', async () => {
  const { session } = await awakeSession({ target: 0xd5, obd: true }, { source: 0xf5 });
  const { dtcs } = await svc.readDtcs(session);
  assert.equal(dtcs.length, 5);
  assert.ok(dtcs.every((d) => d.description === null));
});

test('common-ID reads (an advanced tool): supported IDs read, unsupported ones come back null', async () => {
  const { session } = await awakeSession({ target: 0xd5 }, { source: 0xf5 });
  const ids = [0x40, 0x41, 0x42, 0x60, 0x70];
  const a = await svc.readSwitches(session, ids);
  const supported = a.filter((r) => r.value !== null).map((r) => r.id);
  assert.deepEqual(supported, [0x41, 0x60]);
  const b = await svc.readSwitches(session, supported);
  assert.notEqual(a.find((r) => r.id === 0x41).value, b.find((r) => r.id === 0x41).value);
  assert.equal(b.find((r) => r.id === 0x60).value, 1);
});

test('clear DTCs', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  await svc.clearDtcs(session);
  assert.equal((await svc.readDtcs(session, bike)).count, 0);
});

test('live sensor block read + map decode', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const data = await svc.readLocalId(session, bike.dataBlockId);
  assert.equal(data.length, 64);
  const tps = svc.decodeBlock(data, bike.sensorBlock).find((f) => f.name === 'TPS');
  assert.ok(tps, 'TPS field decoded');
  assert.ok(tps.raw === data[4] * 256 + data[5]);
  // poll again: mock moves the TPS byte every read
  assert.notDeepEqual(data, await svc.readLocalId(session, bike.dataBlockId));
});

test('probe finds supported local ids only', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const found = await svc.probeLocalIds(session, { from: 0x70, to: 0x90 });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, bike.dataBlockId);
  assert.equal(found[0].length, 64);
});

test('probe stops when its signal aborts', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const ac = new AbortController();
  const seen = [];
  const found = await svc.probeLocalIds(session, {
    from: 0x01,
    to: 0xff,
    signal: ac.signal,
    onProgress: (id) => { seen.push(id); if (id === 0x03) ac.abort(); },
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(found, []);
});

// ---- Mode 01 over ISO 9141 (the real bike's framing) -------------------------

const iso = (mockOptions) => awakeSession({ iso9141: true, ...mockOptions });
const BIKE_PIDS = [0x01, 0x03, 0x04, 0x05, 0x06, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x14, 0x1c];
const sorted = (set) => [...set].sort((a, b) => a - b);

// [pid, data bytes, expected value, unit]: SAE J1979 formulas, bytes from the bike and the mock.
const DECODED = [
  [0x04, [102], 40, '%'],
  [0x04, [255], 100, '%'],
  [0x05, [130], 90, '°C'],
  [0x05, [0], -40, '°C'],
  [0x06, [128], 0, '%'],
  [0x06, [0], -100, '%'],
  [0x06, [192], 50, '%'],
  [0x0b, [101], 101, 'kPa'],
  [0x0c, [0x3e, 0x80], 4000, 'rpm'],
  [0x0c, [0x00, 0x01], 0.25, 'rpm'],
  [0x0d, [0], 0, 'km/h'],
  [0x0d, [88], 88, 'km/h'],
  [0x0e, [152], 12, '°'],
  [0x0e, [0], -64, '°'],
  [0x0f, [62], 22, '°C'],
  [0x11, [255], 100, '%'],
  [0x11, [0], 0, '%'],
  [0x14, [0x5a, 0xff], 0.45, 'V'],
  [0x03, [0x02, 0x00], 2, ''],
];

test('every PID in the table decodes with its SAE J1979 formula', () => {
  const tested = [...new Set(DECODED.map(([pid]) => pid))].sort((a, b) => a - b);
  assert.deepEqual(Object.keys(svc.PIDS).map(Number).sort((a, b) => a - b), tested, 'a PID without a decoding test');
  for (const [pid, bytes, value, unit] of DECODED) {
    const d = svc.decodePid(pid, bytes);
    assert.equal(d.value, value, `PID ${pid.toString(16)} ${bytes}`);
    assert.equal(d.unit, unit);
  }
  assert.ok(Math.abs(svc.decodePid(0x11, [128]).value - 50.196) < 0.001);
  assert.ok(Math.abs(svc.decodePid(0x06, [255]).value - 99.22) < 0.01);
});

test('fuel system status decodes the bitmask to words, bank 2 in the second byte', () => {
  const text = (a, b = 0) => svc.decodePid(0x03, [a, b]).text;
  assert.equal(text(0), 'not reported');
  assert.equal(text(1), 'open loop, insufficient temperature');
  assert.equal(text(2), 'closed loop');
  assert.equal(text(4), 'open loop, load/deceleration');
  assert.equal(text(8), 'open loop, system failure');
  assert.equal(text(16), 'closed loop with fault');
  assert.equal(text(2, 4), 'closed loop; bank 2: open loop, load/deceleration');
  assert.equal(text(0x20), 'unknown 0x20');
});

test('oxygen sensor 1 carries its trim in the second byte unless the ECU marks it unused', () => {
  assert.equal(svc.decodePid(0x14, [0x5a, 0xff]).trim, null);
  assert.equal(svc.decodePid(0x14, [0x5a, 0x80]).trim, 0);
  assert.equal(svc.decodePid(0x14, [0x5a, 0xc0]).trim, 50);
});

test('decoding refuses what it cannot decode: an unknown PID, a short reply', () => {
  assert.throws(() => svc.decodePid(0x42, [1, 2]), /no decoder for mode 01 PID 0x42/);
  assert.throws(() => svc.decodePid(0x0c, [0x3e]), /needs 2/);
});

test('readPid returns the data bytes; a PID the ECU does not serve reads as null, never throws, and is not a link failure', async () => {
  const { t, session } = await iso();
  assert.deepEqual(await svc.readPid(session, 0x0c), [0x3e, 0x80]);
  assert.deepEqual(await svc.readPid(session, 0x01), [0x82, 0x00, 0x00, 0xff]);

  assert.equal(await svc.readPid(session, 0x42), null, 'silence: unsupported');
  assert.equal(await svc.readPid(session, 0x43), null);
  assert.equal(session.linkFailures, 0, 'silence is not a dead link');

  t.modes[0x01] = () => [0x7f, 0x33, 0x36];
  assert.equal(await svc.readPid(session, 0x0c), null, 'a refusal whose second byte is not the service');
  assert.equal(session.linkFailures, 0);
});

test('readPid fails on a link that is really failing, and on a reply for another PID', async () => {
  const { t, session } = await iso();
  t.inject('badChecksum', { times: 2, service: 0x01 });
  await assert.rejects(() => svc.readPid(session, 0x0c), /checksum/);
  assert.equal(session.linkFailures, 1);
  t.modes[0x01] = () => [0x41, 0x0d, 0];
  await assert.rejects(() => svc.readPid(session, 0x0c), /not for PID 0xc/);
});

test('supportedPids reads PID 00 and lists what the bitmap says', async () => {
  const { t, session } = await iso();
  assert.deepEqual(sorted(await svc.supportedPids(session)), BIKE_PIDS);
  assert.deepEqual(t.requests.map((r) => r.data), [[1, 0]], 'no next range: PID 20 is not asked');
});

test('supportedPids follows the bitmap into the next ranges only while it says they exist', async () => {
  const { t, session } = await iso();
  const asked = [];
  t.modes[0x01] = (pid) => {
    asked.push(pid);
    if (pid === 0x00) return [0x41, 0x00, 0x80, 0x00, 0x00, 0x01]; // PID 01 and PID 20
    if (pid === 0x20) return [0x41, 0x20, 0x40, 0x00, 0x00, 0x01]; // PID 22 and PID 40
    if (pid === 0x40) return [0x41, 0x40, 0x00, 0x00, 0x00, 0x00]; // nothing, and no PID 60
    return null;
  };
  assert.deepEqual(sorted(await svc.supportedPids(session)), [0x01, 0x20, 0x22, 0x40]);
  assert.deepEqual(asked, [0x00, 0x20, 0x40]);
});

test('supportedPids throws when PID 00 itself goes unanswered', async () => {
  const { t, session } = await iso();
  t.modes[0x01] = () => null;
  await assert.rejects(() => svc.supportedPids(session), /did not answer mode 01 PID 00/);
});

test('readStatus decodes PID 01 into the warning light and the code count', async () => {
  const { t, session } = await iso();
  assert.deepEqual(await svc.readStatus(session), { milOn: true, dtcCount: 2, raw: '82 00 00 ff' });
  t.pids[0x01] = [0x00, 0x00, 0x00, 0x00];
  assert.deepEqual(await svc.readStatus(session), { milOn: false, dtcCount: 0, raw: '00 00 00 00' });
  t.pids[0x01] = [0xff, 0, 0, 0];
  const full = await svc.readStatus(session);
  assert.equal(full.milOn, true);
  assert.equal(full.dtcCount, 127);
  delete t.pids[0x01];
  assert.equal(await svc.readStatus(session), null);
});

test('every gauge of the bike reads and decodes through the mock', async () => {
  const { session } = await iso();
  const got = {};
  for (const d of bike.gauges) got[d.key] = await svc.readGauge(session, d);
  assert.equal(got.rpm.value, 4000);
  assert.equal(got.speed.value, 0);
  assert.equal(got.tps.value, 50.2);
  assert.equal(got.map.value, 1010, 'kPa converted to hPa by the bike description');
  assert.equal(got.coolant.value, 90);
  assert.equal(got.airtemp.value, 22);
  assert.equal(got.load.value, 40);
  assert.equal(got.timing.value, 12);
  assert.equal(got.trim.value, 0);
  assert.equal(got.fuelSystem.text, 'closed loop');
  assert.equal(got.fuelSystem.value, 2);
  assert.deepEqual(got.rpm.raw, [0x3e, 0x80]);
  assert.equal(got.rpm.text, undefined);
});

test('a gauge whose PID the ECU refuses or ignores reads as null instead of throwing', async () => {
  const { t, session } = await iso();
  assert.notEqual(await svc.readGauge(session, { key: 'rpm', pid: 0x0c }), null);
  delete t.pids[0x0c];
  assert.equal(await svc.readGauge(session, { key: 'rpm', pid: 0x0c }), null);
  t.modes[0x01] = () => [0x7f, 0x33, 0x36];
  assert.equal(await svc.readGauge(session, { key: 'tps', pid: 0x11 }), null);
});

test('mode 03 codes come back with the bike\'s descriptions; mode 07 getting no answer is "not supported", not an error', async () => {
  const { t, session } = await iso();
  const before = t.clock.t;
  const r = await svc.readDtcs(session, bike);
  assert.deepEqual(r.dtcs, [
    { code: 'P0078', status: 'stored', statusByte: null, description: 'Exhaust valve actuator circuit' },
    { code: 'P1108', status: 'stored', statusByte: null, description: null },
  ]);
  assert.equal(r.count, 2);
  assert.equal(r.pendingSupported, false);
  assert.deepEqual(r.status, { milOn: true, dtcCount: 2, raw: '82 00 00 ff' });
  assert.deepEqual(t.requests.map((q) => q.service), [0x03, 0x07, 0x07, 0x01], 'mode 07 was asked twice (the silence is resent once, like a lost reply), then the status');
  assert.ok(t.clock.t - before < 2000, 'and the silence cost a few hundred ms, not the KWP two seconds');
  assert.equal(session.linkFailures, 0, 'the silent mode 07 did not count against the link');
});

test('codes spread over several mode 03 replies are all read, and pending ones are added when mode 07 is served', async () => {
  const { t, session } = await iso();
  t.storedCodes = [0x0078, 0x1108, 0x0505, 0x0122];
  t.modes[0x07] = () => [0x47, 0x03, 0x35, 0x00, 0x00, 0x00, 0x00];
  const r = await svc.readDtcs(session, bike);
  assert.deepEqual(r.dtcs.map((d) => `${d.code}:${d.status}`), ['P0078:stored', 'P1108:stored', 'P0505:stored', 'P0122:stored', 'P0335:pending']);
  assert.equal(r.pendingSupported, true);
});

test('a mode 07 refusal is also "not supported"; a mode 03 refusal is an error on an OBD-only session (no KWP fallback)', async () => {
  const { t, session } = await iso();
  t.modes[0x07] = () => [0x7f, 0x07, 0x11];
  assert.equal((await svc.readDtcs(session, bike)).pendingSupported, false);
  t.modes[0x03] = () => [0x7f, 0x03, 0x11];
  t.requests.length = 0;
  await assert.rejects(() => svc.readDtcs(session, bike), /negative response/);
  assert.deepEqual(t.requests.map((q) => q.service), [0x03], 'no KWP 0x18 sent in the OBD framing');
});

test('a zero-code answer reads as no codes, with the light off', async () => {
  const { t, session } = await iso();
  t.storedCodes = [];
  t.pids[0x01] = [0x00, 0x00, 0x00, 0x00];
  const r = await svc.readDtcs(session, bike);
  assert.equal(r.count, 0);
  assert.equal(r.status.milOn, false);
  assert.match(svc.faultSummary(r), /Warning light off; the ECU reports 0 stored codes and 0 were read/);
});

test('faultSummary compares the ECU\'s code count with the codes read; pending codes are not stored codes', async () => {
  const { t, session } = await iso();
  const ok = await svc.readDtcs(session, bike);
  assert.equal(svc.faultSummary(ok), 'Warning light ON; the ECU reports 2 stored codes and 2 were read.');

  t.storedCodes = [0x0078];
  const fewer = await svc.readDtcs(session, bike);
  assert.equal(svc.faultSummary(fewer), 'Warning light ON; the ECU reports 2 stored codes but 1 was read: the list may be incomplete.');

  t.pids[0x01] = [0x81, 0, 0, 0];
  t.modes[0x07] = () => [0x47, 0x03, 0x35, 0x00, 0x00, 0x00, 0x00];
  const withPending = await svc.readDtcs(session, bike);
  assert.equal(withPending.count, 2);
  assert.equal(svc.faultSummary(withPending), 'Warning light ON; the ECU reports 1 stored code and 1 was read.');

  delete t.pids[0x01];
  const noStatus = await svc.readDtcs(session, bike);
  assert.equal(noStatus.status, null);
  assert.match(svc.faultSummary(noStatus), /1 stored code read; the ECU does not report its warning light/);
});

test('clearing codes on an OBD session sends mode 04 only, once, and never falls back to a KWP service', async () => {
  const { t, session } = await iso();
  t.modes[0x04] = () => {
    t.storedCodes = [];
    return [0x44];
  };
  await svc.clearDtcs(session);
  assert.deepEqual(t.requests.map((q) => q.data), [[0x04]]);
  assert.equal((await svc.readDtcs(session, bike)).count, 0);

  t.modes[0x04] = () => [0x7f, 0x04, 0x22];
  t.requests.length = 0;
  await assert.rejects(() => svc.clearDtcs(session), /negative response/);
  assert.deepEqual(t.requests.map((q) => q.service), [0x04]);
});

// ---- The ECU unlock gate and the reads behind it ---------------------------------

const M = 0x1234; // made up; the real multiplier lives in the user's own unlock.json

/** An ISO session on a mock with security access, unlocked with the right (made-up) multiplier. */
async function unlockedIso(mockOptions) {
  const r = await iso({ unlockMultiplier: M, ...mockOptions });
  await unlockSession(r.session, M);
  return r;
}

test('the unlock gate reads the connection\'s own state and never guesses from a refusal', () => {
  const conn = (unlockState, unlockReason = null, style = 'iso9141') => ({ style, unlockState, unlockReason, bike });
  assert.equal(svc.needsUnlock(conn('unlocked')), null);
  assert.equal(svc.needsUnlock(conn('locked', null, 'addressed')), null, 'other session styles are not gated');
  assert.equal(svc.needsUnlock(conn('unavailable', 'no unlock file at x')), 'needs the ECU unlock, not available (unlock is off: no unlock.json)');
  assert.equal(svc.needsUnlock(conn('locked')), 'needs the ECU unlock, not available (not unlocked yet)');
  assert.equal(svc.needsUnlock(conn('unlocking')), 'needs the ECU unlock, not available (unlock in progress)');
  assert.equal(svc.needsUnlock(conn('failed', 'the ECU refused the key (code 0x35)')), 'needs the ECU unlock, not available (unlock failed: the ECU refused the key (code 0x35))');
  assert.match(svc.needsUnlock(conn('invalid', 'the unlock file x is not valid JSON')), /^needs the ECU unlock, not available \(the unlock file x is not valid JSON\)$/);
  assert.throws(() => svc.requireUnlock(conn('locked')), (e) => e instanceof svc.NeedsUnlockError && /needs the ECU unlock/.test(e.message));
  svc.requireUnlock(conn('unlocked'));
});

test('lockedGauges names the unlock-only gauges until the connection is unlocked', () => {
  const state = (unlockState) => ({ unlockState, bike });
  assert.deepEqual(svc.lockedGauges(state('locked')), ['battery', 'gear']);
  assert.deepEqual(svc.lockedGauges(state('unavailable')), ['battery', 'gear'], 'also on a connection that cannot unlock');
  assert.deepEqual(svc.lockedGauges(state('unlocking')), ['battery', 'gear']);
  assert.deepEqual(svc.lockedGauges(state('unlocked')), []);
  assert.deepEqual(svc.lockedGauges(state('locked'), bike.gauges.filter((g) => g.key === 'rpm')), []);
});

test('id gauges decode the big-endian reply: scaled, offset, stepped, or the highest set bit', () => {
  const battery = bike.gauges.find((g) => g.key === 'battery');
  const gear = bike.gauges.find((g) => g.key === 'gear');
  assert.deepEqual(svc.decodeGauge(battery, [0, 138]), { value: 13.8, raw: [0, 138] });
  assert.equal(svc.decodeGauge(gear, [0, 8]).value, 4);
  assert.equal(svc.decodeGauge(gear, [0, 1]).value, 1);
  assert.equal(svc.decodeGauge(gear, [0, 0]).value, 0, 'neutral');
  assert.equal(svc.decodeGauge({ key: 'x', id: 1, scale: 0.25, step: 10, requiresUnlock: true }, [0x3e, 0x80]).value, 4000);
  assert.equal(svc.decodeGauge({ key: 'x', id: 1, add: -40, requiresUnlock: true }, [130]).value, 90);
});

test('battery and gear read through the mock once unlocked; a locked ECU refuses them and that reads as null', async () => {
  const { t, session } = await iso({ unlockMultiplier: M });
  const battery = bike.gauges.find((g) => g.key === 'battery');
  const gear = bike.gauges.find((g) => g.key === 'gear');
  assert.equal(await svc.readGauge(session, battery), null, 'refused (7F 33 36)');
  assert.equal(session.linkFailures, 0);

  await unlockSession(session, M);
  assert.deepEqual(await svc.readGauge(session, battery), { value: 13.8, raw: [0, 138] });
  assert.equal((await svc.readGauge(session, gear)).value, 4);
  delete t.dataIds[0x21];
  assert.equal(await svc.readGauge(session, gear), null, 'an id the unlocked ECU does not serve is refused too');
});

test('an id gauge the ECU stays silent on is a failing link, not "not served"', async () => {
  const { t, session } = await unlockedIso();
  t.inject('dropReply', { times: 5, service: 0x22 });
  await assert.rejects(() => svc.readGauge(session, bike.gauges.find((g) => g.key === 'battery')), /no response/);
  assert.equal(session.linkFailures, 1);
});

test('ECU identification on an ISO session that stays silent gives up after three options and is not a link failure', async () => {
  const { t, session } = await iso();
  assert.deepEqual(await svc.readEcuId(session), []);
  assert.deepEqual(t.requests.map((r) => r.data), [[0x1a, 0x80], [0x1a, 0x81], [0x1a, 0x82]]);
  assert.equal(session.linkFailures, 0);
});

test('ECU identification on an unlocked ISO session lists what the ECU answers and skips what it refuses', async () => {
  const { t, session } = await unlockedIso();
  t.modes[0x1a] = (option) => (option === 0x80 ? [0x5a, 0x80, ...Buffer.from('T675-KEIHIN')] : [0x7f, 0x1a, 0x12]);
  const ids = await svc.readEcuId(session);
  assert.equal(ids.length, 1);
  assert.equal(ids[0].option, 0x80);
  assert.equal(ids[0].ascii, 'T675-KEIHIN');
  assert.equal(t.requests.filter((r) => r.service === 0x1a).length, 23, 'refusals are answers: every option is asked');
});

test('an id the ECU leaves unanswered is n/a too, does not stop the scan and does not count against the link', async () => {
  const { t, session } = await unlockedIso();
  t.inject('dropReply', { service: 0x22 }); // the first id asked gets no reply at all
  const rows = await svc.readSwitches(session, [0x43, 0x41, 0x60]);
  assert.equal(rows.find((r) => r.id === 0x43).hex, 'n/a');
  assert.deepEqual(rows.filter((r) => r.value !== null).map((r) => r.id), [0x41, 0x60]);
  assert.equal(session.linkFailures, 0);
});

test('switch states read once unlocked: the ids the ECU serves come back, the others as n/a', async () => {
  const { session } = await unlockedIso();
  const rows = await svc.readSwitches(session, [0x43, ...bike.switchIds]);
  // The mock does not serve the three ids the real ECU answers only now and then (it refuses them), nor 0x43.
  const unserved = [0x61, 0x63, 0x68];
  assert.deepEqual(rows.filter((r) => r.value !== null).map((r) => r.id), bike.switchIds.filter((id) => !unserved.includes(id)));
  assert.deepEqual(rows.filter((r) => r.value === null).map((r) => r.id), [0x43, ...unserved]);
  assert.equal(rows.find((r) => r.id === 0x43).hex, 'n/a');
  const again = await svc.readSwitches(session, [0x41, 0x60]);
  assert.notEqual(rows.find((r) => r.id === 0x41).value, again.find((r) => r.id === 0x41).value, 'the clutch flips on every read');
});

test('a switch id the ECU ignores once is asked again and then answers; a refusal is not resent', async () => {
  const { t, session } = await unlockedIso();
  t.inject('dropReply', { service: 0x22 }); // the first request of the scan gets no reply at all
  const rows = await svc.readSwitches(session, [0x42, 0x43]);
  assert.deepEqual(rows[0], { id: 0x42, value: 0xff, hex: '00 ff', bytes: [0x00, 0xff] }, 'the resend was answered');
  assert.equal(rows[1].hex, 'n/a', '0x43 is refused by the mock');
  const asked = t.requests.filter((r) => r.service === 0x22).map((r) => r.data[2]);
  assert.deepEqual(asked, [0x42, 0x42, 0x43], 'the silent request is sent twice, the refused one once');
  assert.equal(session.linkFailures, 0);
});

test('a switch id that stays silent costs two requests per read, comes back as n/a and is no link failure', async () => {
  const { t, session } = await unlockedIso();
  t.silentIds.add(0x42);
  const rows = await svc.readSwitches(session, [0x42, 0x44]);
  assert.deepEqual(rows.map((r) => [r.id, r.value === null ? null : r.hex]), [[0x42, null], [0x44, '00 ff']]);
  assert.deepEqual(t.requests.filter((r) => r.service === 0x22).map((r) => r.data[2]), [0x42, 0x42, 0x44]);
  assert.equal(session.linkFailures, 0);
});

test('an analog the ECU ignores once is resent and answers; one that stays silent is null after two requests', async () => {
  const { t, session } = await unlockedIso();
  const sidestandV = bike.analogs.find((a) => a.key === 'sidestandV');
  t.inject('dropReply', { service: 0x22 });
  const got = await svc.readAnalog(session, sidestandV);
  assert.equal(got.hex, '00 80');
  assert.equal(got.value, 2.51, '128 / 51');
  assert.equal(t.requests.filter((r) => r.service === 0x22).length, 2);
  t.silentIds.add(0x26);
  const before = t.requests.length;
  assert.equal(await svc.readAnalog(session, sidestandV), null);
  assert.equal(t.requests.length - before, 2, 'a silent id costs two requests per read');
  assert.equal(session.linkFailures, 0);
});

test('the recorder id read resends once on silence: readIdBytes with retries 1', async () => {
  const { t, session } = await unlockedIso();
  t.inject('dropReply', { service: 0x22 });
  assert.deepEqual(await svc.readIdBytes(session, 0x42, { retries: 1 }), [0x00, 0xff]);
  t.inject('dropReply', { service: 0x22 });
  assert.equal(await svc.readIdBytes(session, 0x42), null, 'without retries one silence is "not served"');
});
