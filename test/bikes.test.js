'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineBike, resolveDataBlockId, DEFAULT_BIKE } = require('../src/bikes');
const { Connection } = require('../src/connection');
const svc = require('../src/services');
const { MockEcuTransport } = require('./mockecu');

test('the data block id: bike default, overridden by the saved probe result, overridden by a flag', () => {
  assert.equal(resolveDataBlockId(DEFAULT_BIKE), 0x80);
  assert.equal(resolveDataBlockId(DEFAULT_BIKE, { saved: 0x42 }), 0x42);
  assert.equal(resolveDataBlockId(DEFAULT_BIKE, { saved: 0x42, flag: 0x10 }), 0x10);
  assert.equal(resolveDataBlockId(DEFAULT_BIKE, { flag: 0 }), 0, 'block 0 is a real id, not "unset"');
});

test('describeDtc gives the confirmed meaning, or null for an unknown code', () => {
  assert.equal(DEFAULT_BIKE.describeDtc('P1632'), 'TIP-OVER (fall detection) sensor circuit high or open');
  assert.equal(DEFAULT_BIKE.describeDtc('p0230'), 'FUEL PUMP circuit');
  assert.equal(DEFAULT_BIKE.describeDtc('P9999'), null);
});

test('a description missing its identity is refused', () => {
  assert.throws(() => defineBike({ id: 'x', name: 'X' }), /dataBlockId/);
});

function fakeBike() {
  return defineBike({
    id: 'fake-bike',
    name: 'Fake bike',
    wake: { attempts: [{ target: 0x55, source: 0xf2, addrMode: 'phys' }] },
    diagSession: 0x90,
    dataBlockId: 0x21,
    switchIds: [0x41],
    dtcs: { P0515: 'Fake fault' },
  });
}

test('a second bike description swaps in everywhere without touching a generic module', async () => {
  const bike = fakeBike();
  const t = new MockEcuTransport({ target: 0x55 });
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-')), 'config.json');
  const conn = new Connection({ bike, configPath, openTransport: async () => t, clock: t.clock, keepAliveMs: 60_000 });
  const info = await conn.connect({ port: 'MOCK' });

  assert.equal(t.pulses.length, 1, "the fake bike's own address answers on the first pulse");
  assert.equal(info.target, 0x55);
  assert.equal(info.source, 0xf2);
  assert.deepEqual(t.requests.find((r) => r.service === 0x10).data, [0x10, 0x90], "the fake bike's diagnostic session");
  assert.equal(conn.dataBlockId(), 0x21);
  assert.deepEqual((await svc.readSwitches(conn.session, bike.switchIds)).map((r) => r.id), [0x41]);

  const { dtcs } = await svc.readDtcs(conn.session, bike);
  assert.deepEqual(dtcs.map((d) => d.description), ['Fake fault', null]);
  await conn.disconnect();
});

test('Connection.dataBlockId applies the precedence to config.json and a flag', async () => {
  const t = new MockEcuTransport();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-')), 'config.json');
  const conn = new Connection({ configPath, openTransport: async () => t, clock: t.clock });
  assert.equal(conn.dataBlockId(), 0x80);
  conn.saveConfig({ localId: 0x42 });
  assert.equal(conn.dataBlockId(), 0x42);
  assert.equal(conn.dataBlockId(0x10), 0x10);
});

test('the Daytona\'s gauges are standard mode 01 PIDs the decoder knows, then two 0x22 gauges that need the unlock; none verified yet', () => {
  assert.deepEqual(DEFAULT_BIKE.gauges.map((g) => g.key), ['rpm', 'speed', 'tps', 'map', 'coolant', 'airtemp', 'load', 'timing', 'trim', 'fuelSystem', 'battery', 'gear']);
  const open = DEFAULT_BIKE.gauges.filter((g) => !g.requiresUnlock);
  assert.equal(open.length, 10);
  for (const g of open) {
    assert.ok(svc.PIDS[g.pid], `${g.key}: PID 0x${g.pid.toString(16)} has a decoder`);
    assert.equal(g.id, undefined, `${g.key} has no 0x22 ID`);
  }
  const gated = DEFAULT_BIKE.gauges.filter((g) => g.requiresUnlock);
  assert.deepEqual(gated.map((g) => g.key), ['battery', 'gear'], 'the only gauges behind the unlock');
  for (const g of gated) assert.equal(g.pid, undefined, `${g.key} is a 0x22 read, not a mode 01 PID`);
  assert.deepEqual(DEFAULT_BIKE.gauges.find((g) => g.key === 'battery'), { key: 'battery', label: 'Battery', id: 7, scale: 0.1, unit: 'V', min: 8, max: 16, requiresUnlock: true, verified: false });
  assert.deepEqual(DEFAULT_BIKE.gauges.filter((g) => g.id === 33).map((g) => [g.key, g.type]), [['gear', 'bitpos']]);
  for (const g of DEFAULT_BIKE.gauges) assert.equal(g.verified, false, `${g.key} stays unverified until compared with the dash`);
  assert.deepEqual(DEFAULT_BIKE.gauges.filter((g) => g.fast).map((g) => g.key), ['rpm', 'tps']);
  assert.deepEqual(DEFAULT_BIKE.gauges.filter((g) => g.type === 'text').map((g) => g.key), ['fuelSystem']);
  assert.equal(DEFAULT_BIKE.gauges.find((g) => g.key === 'map').scale, 10, 'kPa to hPa');
});

test('the Daytona\'s switch ids are named but only read on an unlocked ECU', () => {
  assert.deepEqual([...DEFAULT_BIKE.switchIds].sort((a, b) => a - b), [0x40, 0x41, 0x42, 0x44, 0x46, 0x60, 0x61, 0x62, 0x63, 0x64, 0x66, 0x68, 0x69, 0x70], 'the ids the ECU answers, 0x61, 0x63 and 0x68 only now and then; 0x43, 0x45 and 0x65 stay silent and are left out');
  assert.deepEqual(DEFAULT_BIKE.switchIds, [0x40, 0x41, 0x46, 0x60, 0x69, 0x42, 0x44, 0x61, 0x62, 0x63, 0x68, 0x64, 0x66, 0x70], 'the table order, which is the order of the tiles');
  assert.deepEqual(DEFAULT_BIKE.switchIds, DEFAULT_BIKE.switches.map((s) => s.id), 'one source of truth: the list is derived from the table');
  assert.equal(DEFAULT_BIKE.switchesRequireUnlock, true);
  assert.equal(defineBike({ id: 'x', name: 'X', dataBlockId: 1 }).switchesRequireUnlock, false, 'a plain bike has no gate');
});

test('a gauge without a PID is refused unless it is a 0x22 id gauge that says it needs the unlock', () => {
  assert.throws(() => defineBike({ id: 'x', name: 'X', dataBlockId: 1, gauges: [{ key: 'rpm', id: 256 }] }), /needs a key and a PID/);
  assert.throws(() => defineBike({ id: 'x', name: 'X', dataBlockId: 1, gauges: [{ key: 'rpm', requiresUnlock: true }] }), /needs a key and a PID/);
  const bike = defineBike({ id: 'x', name: 'X', dataBlockId: 1, gauges: [{ key: 'volts', id: 7, requiresUnlock: true }] });
  assert.equal(bike.gauges[0].id, 7);
});

test('fault code bytes decode the standard way', () => {
  assert.equal(svc.dtcToString(0x00, 0x78), 'P0078');
  assert.equal(svc.dtcToString(0x11, 0x08), 'P1108');
  assert.equal(svc.dtcToString(0x41, 0x23), 'C0123');
  assert.equal(svc.dtcToString(0xc0, 0x01), 'U0001');
});
