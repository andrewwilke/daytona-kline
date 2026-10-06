'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../src/services');
const { DEFAULT_BIKE: bike, defineBike, CONFIRMATION } = require('../src/bikes');

const byKey = (key) => bike.switches.find((s) => s.key === key);
const ON = [0x00, 0xff];
const ZERO = [0x00, 0x00];

test('a plain id is active when its value is not zero, an inverted one when its low byte is 00', () => {
  const plain = { id: 1, key: 'p', name: 'P' };
  const inverted = { ...plain, inverted: true };
  assert.deepEqual(svc.decodeSwitch(plain, ON), { active: true, raw: [0x00, 0xff] });
  assert.deepEqual(svc.decodeSwitch(plain, ZERO), { active: false, raw: [0x00, 0x00] });
  assert.equal(svc.decodeSwitch(plain, [0x00, 0x01]).active, true, 'any non-zero value');
  assert.equal(svc.decodeSwitch(plain, [0xff, 0x00]).active, true, 'the value is the whole reply');
  assert.deepEqual(svc.decodeSwitch(inverted, ZERO), { active: true, raw: [0x00, 0x00] });
  assert.equal(svc.decodeSwitch(inverted, ON).active, false);
  assert.equal(svc.decodeSwitch(inverted, [0xff, 0x00]).active, true, 'inverted looks at the low byte');
  assert.equal(svc.decodeSwitch(inverted, [0x00, 0xfe]).active, false);
  assert.deepEqual(svc.decodeSwitch(plain, []), { active: null, raw: [] }, 'no data, no state');
  assert.equal(svc.decodeSwitch(inverted, Buffer.from([0, 0])).active, true, 'any array-like of bytes');
});

test('every named switch has its own words for the two states', () => {
  const words = (key, bytes) => svc.describeSwitch(byKey(key), byKey(key).id, bytes).state;
  assert.deepEqual([words('neutral', ZERO), words('neutral', ON)], ['IN NEUTRAL', 'IN GEAR']);
  assert.deepEqual([words('clutch', ZERO), words('clutch', ON)], ['PULLED', 'RELEASED']);
  assert.deepEqual([words('startSwitch', ON), words('startSwitch', ZERO)], ['PRESSED', 'RELEASED']);
  assert.deepEqual([words('fuelPump', ON), words('fuelPump', ZERO)], ['ON', 'OFF']);
  assert.deepEqual([words('mainRelay', ON), words('mainRelay', ZERO)], ['ON', 'OFF']);
  assert.deepEqual([words('secondaryAir', ZERO), words('secondaryAir', ON)], ['ON', 'OFF'], 'the inverted ones too');
  assert.deepEqual([words('sidestand', ON), words('sidestand', ZERO)], ['DOWN', 'UP'], 'the owner named it: 00 ff = stand down');
  for (const key of ['warningLamp', 'engineLamp']) {
    assert.deepEqual([words(key, ON), words(key, ZERO)], ['DASH ON', 'DASH OFF'], `${key} follows the dash's power`);
  }
  for (const key of ['dashLamp62', 'dashLamp68', 'o2Heater', 'airFlap']) {
    assert.deepEqual([words(key, ON), words(key, ZERO)], ['ON', 'OFF'], key);
  }
  assert.deepEqual([words('tipOver', ON), words('tipOver', ZERO)], ['NOT TRIPPED', 'TRIPPED'], '00 ff is enabled and good, 00 00 is tripped');
});

test('a tile carries the name, state, raw bytes, id and how far the label is trusted', () => {
  const t = svc.describeSwitch(byKey('clutch'), 0x41, [0x00, 0xff]);
  assert.deepEqual(
    { ...t, evidence: typeof t.evidence },
    { id: 0x41, key: 'clutch', named: true, name: 'Clutch', inverted: true, confirmation: 'consistent', evidence: 'string', active: false, state: 'RELEASED', bad: false, raw: [0, 0xff], hex: '00 ff' },
  );
  const unknown = svc.describeSwitch(null, 0x123, [0x00, 0x01]);
  assert.deepEqual(unknown, {
    id: 0x123, key: null, named: false, name: 'ID 0x0123', inverted: false, confirmation: null, evidence: null, active: null, state: null, bad: false, raw: [0, 1], hex: '00 01',
  });
});

test('tiles: the named ids first in the bike table\'s order, the ones it does not name after, by id', () => {
  const rows = [0x0123, 0x70, 0x60, 0x0010, 0x41, 0x43].map((id) => ({ id, value: 1, hex: '00 01', bytes: [0, 1] }));
  rows.push({ id: 0x40, value: null, hex: 'n/a', bytes: [] });
  const tiles = svc.switchTiles(bike, rows);
  assert.deepEqual(tiles.map((t) => t.id), [0x41, 0x60, 0x70, 0x0010, 0x43, 0x0123]);
  assert.deepEqual(tiles.map((t) => t.named), [true, true, true, false, false, false]);
  assert.equal(tiles.at(-1).name, 'ID 0x0123');
  assert.ok(!tiles.some((t) => t.id === 0x40), 'an id the ECU did not answer has no tile');
  assert.ok(tiles.every((t) => t.stale === false), 'rows that carry no stale flag are fresh');
});

test('a tile is stale when its row says the ECU is silent on it now: it keeps its last value', () => {
  const rows = [
    { id: 0x41, value: 0xff, hex: '00 ff', bytes: [0, 0xff], stale: true },
    { id: 0x60, value: 0, hex: '00 00', bytes: [0, 0], stale: false },
    { id: 0x0123, value: 1, hex: '00 01', bytes: [0, 1], stale: true },
  ];
  const tiles = svc.switchTiles(bike, rows);
  assert.deepEqual(tiles.map((t) => [t.id, t.stale]), [[0x41, true], [0x60, false], [0x0123, true]]);
  assert.equal(tiles[0].hex, '00 ff', 'the last value, not n/a');
  assert.equal(tiles[0].state, 'RELEASED');
  assert.equal(tiles[1].state, 'OFF');
});

test('the Daytona\'s switch table: the confirmed, consistent and unconfirmed labels as seen on the bike', () => {
  const level = (l) => bike.switches.filter((s) => s.confirmation === l).map((s) => s.id).sort((a, b) => a - b);
  assert.deepEqual(level('confirmed'), [0x42, 0x46, 0x60, 0x63], 'sidestand and the tip-over sensor (named by the owner, who gave the polarity), start switch and fuel pump were watched flipping');
  assert.deepEqual(level('consistent'), [0x40, 0x41, 0x69]);
  assert.deepEqual(level('unconfirmed'), [0x44, 0x61, 0x62, 0x64, 0x66, 0x68, 0x70]);
  assert.deepEqual(bike.switches.filter((s) => s.inverted).map((s) => s.id).sort((a, b) => a - b), [0x40, 0x41, 0x66]);
  for (const s of bike.switches) {
    assert.ok(CONFIRMATION.includes(s.confirmation));
    assert.equal(typeof s.evidence, 'string', `${s.name}: a note of how it was seen`);
  }
  assert.deepEqual(bike.switchIds, bike.switches.map((s) => s.id), 'the id list is derived from the table');
  for (const silent of [0x43, 0x45, 0x65]) assert.ok(!bike.switchIds.includes(silent), `0x${silent.toString(16)} is silent on this ECU`);
  // These answer only now and then, so they stay in the table (the monitor resends a request once).
  for (const key of ['engineLamp', 'dashLamp68']) assert.equal(byKey(key).confirmation, 'unconfirmed', key);
  assert.deepEqual([byKey('engineLamp').id, byKey('tipOver').id, byKey('dashLamp68').id], [0x61, 0x63, 0x68]);
});

test('the tip-over sensor (0x63): its own key, name and words, confirmed by the owner (00 ff = good, 00 00 = tripped), the bad state is flagged', () => {
  const s = byKey('tipOver');
  assert.deepEqual(
    { id: s.id, key: s.key, name: s.name, onText: s.onText, offText: s.offText, bad: s.bad, confirmation: s.confirmation, inverted: !!s.inverted },
    { id: 0x63, key: 'tipOver', name: 'Tip-over sensor', onText: 'NOT TRIPPED', offText: 'TRIPPED', bad: 'off', confirmation: 'confirmed', inverted: false },
  );
  assert.equal(byKey('startRelay'), undefined, 'the other tool\'s label for this id is gone from the table');
  assert.match(s.evidence, /tip-over/);
  assert.match(s.evidence, /00 ff = enabled and good/);
  assert.match(s.evidence, /00 00 = tripped/);
  assert.equal(bike.switches.findIndex((x) => x.id === 0x63), bike.switches.findIndex((x) => x.id === 0x62) + 1, 'same position in the table');
  const good = svc.describeSwitch(s, s.id, [0x00, 0xff]);
  assert.deepEqual([good.name, good.state, good.active, good.bad, good.confirmation], ['Tip-over sensor', 'NOT TRIPPED', true, false, 'confirmed']);
  const tripped = svc.describeSwitch(s, s.id, [0x00, 0x00]);
  assert.deepEqual([tripped.state, tripped.active, tripped.bad], ['TRIPPED', false, true], 'the page shows this one in red');
  assert.equal(svc.describeSwitch(byKey('fuelPump'), 0x60, [0, 0]).bad, false, 'only a switch whose table entry names a bad state has one');
});

test('the analog extras are unlock-only, unverified, and decode to volts', () => {
  assert.deepEqual(bike.analogs.map((a) => [a.key, a.id, a.unit, a.requiresUnlock, a.verified]), [
    ['sidestandV', 0x26, 'V', true, false],
    ['rolloverV', 0x28, 'V', true, false],
    ['rpmId', 0x100, 'rpm', true, false],
    ['injPulse1', 0x110, 'ms', true, false],
    ['injPulse2', 0x111, 'ms', true, false],
    ['injPulse3', 0x112, 'ms', true, false],
    ['ignTiming1', 0x120, '°', true, false],
    ['ignTiming2', 0x121, '°', true, false],
    ['ignTiming3', 0x122, '°', true, false],
  ]);
  assert.deepEqual(bike.analogs.filter((a) => a.panel === false).map((a) => a.key), ['rpmId', 'injPulse1', 'injPulse2', 'injPulse3', 'ignTiming1', 'ignTiming2', 'ignTiming3'], 'recorded only: not tiles in the Switches panel');
  const [sidestand, rollover, rpmId, inj1, , , ign1] = bike.analogs;
  assert.equal(svc.decodeGauge(rpmId, [0x00, 0x00]).value, 0);
  assert.equal(svc.decodeGauge(rpmId, [0x01, 0x90]).value, 100, 'raw 400 * 0.25 = 100 rpm');
  assert.equal(svc.decodeGauge(rpmId, [0x01, 0xa0]).value, 100, 'raw 416 -> 104 rpm, rounded down to a multiple of 10');
  assert.equal(svc.decodeGauge(rpmId, [0x0f, 0xa0]).value, 1000, 'raw 4000 * 0.25');
  assert.equal(svc.decodeGauge(inj1, [0x00, 0x00]).value, 0, 'engine off: no injection pulse');
  assert.equal(svc.decodeGauge(inj1, [0x0b, 0xb8]).value, 3, 'raw 3000 * 0.001 ms');
  assert.equal(svc.decodeGauge(ign1, [0x00, 0x80]).value, 0, 'raw 128 * 0.5 - 64');
  assert.equal(svc.decodeGauge(ign1, [0x00, 0xa0]).value, 16, 'raw 160 * 0.5 - 64');
  assert.equal(svc.decodeGauge(ign1, [0x00, 0x00]).value, -64);
  assert.equal(svc.decodeGauge(sidestand, [0x00, 0xff]).value, 5, 'raw / 51');
  assert.equal(svc.decodeGauge(sidestand, [0x01, 0xff]).value, 10.02);
  assert.equal(svc.decodeGauge(rollover, [0x02, 0x00]).value, 2.5, 'raw * 4.887 / 1000');
  assert.equal(svc.decodeGauge(rollover, [0x03, 0xff]).value, 5, '1023 * 4.887 / 1000 = 5.0');
  assert.match(sidestand.note, /lifting/);
  assert.match(rollover.note, /tilt/);
});

test('a bike description with a switch that is not properly labelled is refused', () => {
  const base = { id: 'x', name: 'X', dataBlockId: 1 };
  assert.throws(() => defineBike({ ...base, switches: [{ id: 1, key: 'a', name: 'A' }] }), /needs an id, a key, a name and a confirmation/);
  assert.throws(() => defineBike({ ...base, switches: [{ id: 1, key: 'a', name: 'A', confirmation: 'sure' }] }), /confirmation/);
  const twice = { key: 'a', name: 'A', confirmation: 'confirmed' };
  assert.throws(() => defineBike({ ...base, switches: [{ id: 1, ...twice }, { id: 1, ...twice, key: 'b' }] }), /listed twice/);
  assert.throws(() => defineBike({ ...base, analogs: [{ key: 'v', id: 1 }] }), /needs a key, an id and a scale/);
  const ok = defineBike({ ...base, switches: [{ id: 1, ...twice }] });
  assert.deepEqual(ok.switchIds, [1], 'derived when the description gives no list');
  assert.deepEqual(defineBike(base).switches, []);
  assert.deepEqual(defineBike(base).analogs, []);
});

test('known ids: the bike names its switches, id gauges and analogs; the diff names what changed', () => {
  assert.equal(svc.knownIdName(bike, 0x41), 'Clutch');
  assert.equal(svc.knownIdName(bike, 0x07), 'Battery');
  assert.equal(svc.knownIdName(bike, 0x26), 'Sidestand sensor');
  assert.equal(svc.knownIdName(bike, 0x0123), null);
  assert.deepEqual(svc.knownIds(bike), [0x07, 0x21, 0x26, 0x28, 0x40, 0x41, 0x42, 0x44, 0x46, 0x60, 0x61, 0x62, 0x63, 0x64, 0x66, 0x68, 0x69, 0x70, 0x100, 0x110, 0x111, 0x112, 0x120, 0x121, 0x122]);
  const a = { 0x41: { hex: '00 ff' }, 0x50: { hex: '00 01' }, 0x60: { hex: '00 00' } };
  const b = { 0x41: { hex: '00 00' }, 0x50: { hex: '00 01' }, 0x77: { hex: 'aa bb' } };
  assert.deepEqual(svc.diffSnapshots(a, b, bike), [
    { id: 0x41, name: 'Clutch', before: '00 ff', after: '00 00' },
    { id: 0x60, name: 'Fuel pump', before: '00 00', after: null },
    { id: 0x77, name: null, before: null, after: 'aa bb' },
  ]);
  assert.deepEqual(svc.diffSnapshots(a, a, bike), []);
});
