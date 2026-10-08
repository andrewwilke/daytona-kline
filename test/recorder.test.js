'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { recordRun, EventDetector, EVERY_CYCLE, ROTATING_TIMEOUT_MS } = require('../src/recorder');
const { loadRecording } = require('../src/recordings');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-rec-'));

/** A connected mock of the bike: unlocked after connecting unless `unlocked: false`; `autoUnlock: false` leaves it 'locked' until conn.unlock(). */
async function connectedBike({ unlocked = true, mock = {}, connection = {} } = {}) {
  const dir = scratch();
  if (unlocked) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M, ...mock });
  const conn = new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => t, clock: t.clock, keepAliveMs: 60_000, ...connection });
  await conn.connect({ port: 'MOCK' });
  return { t, conn, logDir: path.join(dir, 'logs') };
}

const rpmBytes = (rpm) => [Math.floor((rpm * 4) / 256), (rpm * 4) & 0xff];

/** Make the mock ECU's values follow a plain object a test changes between cycles. */
function drive(t) {
  const car = { rpm: 0, rpmId: null, volts: 12.6, pump: false, relay: true, start: false, tipOver: false, dash44: true, dash61: true };
  t.pids[0x0c] = () => rpmBytes(car.rpm);
  t.dataIds[0x100] = () => rpmBytes(car.rpmId ?? car.rpm); // the ECU's own engine speed: raw = rpm * 4
  t.dataIds[0x63] = () => [0, car.tipOver ? 0xff : 0x00]; // the tip-over sensor: 00 ff = good (not tripped), 00 00 = tripped
  t.dataIds[0x44] = () => [0, car.dash44 ? 0xff : 0x00]; // the two dash power flags
  t.dataIds[0x61] = () => [0, car.dash61 ? 0xff : 0x00];
  t.dataIds[0x07] = () => [0, Math.round(car.volts * 10)];
  t.dataIds[0x60] = () => [0, car.pump ? 0xff : 0x00];
  t.dataIds[0x69] = () => [0, car.relay ? 0xff : 0x00];
  t.dataIds[0x46] = () => [0, car.start ? 0xff : 0x00];
  return car;
}

/** The mock does not serve the ids the bike description added later (0x61, 0x63, 0x68, the ECU's engine speed, the injection pulses and the ignition timings): serve them, all zero. */
const NEW_IDS = [0x61, 0x63, 0x68, 0x100, 0x110, 0x111, 0x112, 0x120, 0x121, 0x122];
const serveNewIds = (t) => { for (const id of NEW_IDS) t.dataIds[id] = [0, 0]; };

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const tick = () => new Promise((r) => setImmediate(r));
/** The clock time the cycle of the next step takes. */
const cycleTime = async (run) => (await run.step()).cycleMs;

/** What the ECU was asked since request number `from`, as '22:07' (a 0x22 id, at least two digits: '22:110') or '01:0c' (a mode 01 PID). */
const asked = (t, from = 0) => t.requests.slice(from).map((r) => (r.service === 0x22
  ? `22:${((r.data[1] << 8) | r.data[2]).toString(16).padStart(2, '0')}`
  : `${r.service.toString(16).padStart(2, '0')}:${(r.data[1] ?? 0).toString(16).padStart(2, '0')}`));

function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cell); cell = ''; } else cell += c;
  }
  cells.push(cell);
  return cells;
}

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const header = splitCsvLine(head);
  return { header, rows: lines.map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [header[i], v]))), lines: [head, ...lines] };
}

const HEADER = [
  't_ms', 'cycle_ms', 'rpm', 'speed', 'tps', 'map', 'coolant', 'airtemp', 'load', 'timing', 'trim', 'fuelSystem', 'battery', 'gear',
  'sidestandV', 'rolloverV', 'rpmId', 'injPulse1', 'injPulse2', 'injPulse3', 'ignTiming1', 'ignTiming2', 'ignTiming3',
  'neutral', 'clutch', 'startSwitch', 'fuelPump', 'mainRelay', 'sidestand', 'warningLamp', 'engineLamp', 'dashLamp62', 'tipOver', 'dashLamp68', 'o2Heater', 'secondaryAir', 'airFlap',
  'battery_raw', 'gear_raw',
  'neutral_raw', 'clutch_raw', 'startSwitch_raw', 'fuelPump_raw', 'mainRelay_raw', 'sidestand_raw', 'warningLamp_raw', 'engineLamp_raw', 'dashLamp62_raw', 'tipOver_raw', 'dashLamp68_raw', 'o2Heater_raw', 'secondaryAir_raw', 'airFlap_raw',
  'sidestandV_raw', 'rolloverV_raw', 'rpmId_raw', 'injPulse1_raw', 'injPulse2_raw', 'injPulse3_raw', 'ignTiming1_raw', 'ignTiming2_raw', 'ignTiming3_raw',
  'marker', 'event',
];

// ---- scheduling ------------------------------------------------------------------

test('every cycle reads the safety-critical values first, the rest take turns one per cycle', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t); // the ECU's engine speed, the injection pulse, the tip-over sensor and the dash flag 0x61 are in the every-cycle list; a value the ECU refuses three times in a row would leave it
  assert.deepEqual(EVERY_CYCLE, ['battery', 'rpmId', 'startSwitch', 'fuelPump', 'injPulse1', 'tipOver', 'warningLamp', 'engineLamp']);
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  for (let i = 0; i < 30; i++) await run.step();
  const all = asked(t, from);
  assert.equal(all[0], '01:00', 'the first cycle reads the supported PIDs once');
  const critical = ['22:07', '22:100', '22:46', '22:60', '22:110', '22:63', '22:44', '22:61'];
  const cycles = [];
  for (let i = 1; i < all.length; i += critical.length + 1) cycles.push(all.slice(i, i + critical.length + 1));
  assert.equal(cycles.length, 30);
  for (const c of cycles) assert.deepEqual(c.slice(0, critical.length), critical, 'every cycle, in this order');
  const rotating = cycles.map((c) => c[critical.length]);
  assert.deepEqual(rotating, [
    '22:40', '22:41', '22:69', '22:42', '22:62', '22:68', '22:64', '22:66', '22:70', // the switches the every-cycle list does not take, in the table's order (the main relay takes turns; the tip-over sensor and the two dash flags are read every cycle)
    '01:0c', '01:0d', '01:11', '01:0b', '01:05', '01:0f', '01:04', '01:0e', '01:06', '01:03', '22:21', // then the other gauges (the OBD rpm and the throttle are among them)
    '22:26', '22:28', '22:111', '22:112', '22:120', '22:121', '22:122', // then the analogs the every-cycle list does not take (the rollover voltage takes turns)
    '22:40', '22:41', '22:69', // and round again
  ]);
  assert.equal(run.errors, 0);
  assert.deepEqual(run.notAvailable, []);
  run.stop();
  await conn.disconnect();
});

test('perCycle takes two rotating values per cycle', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir, perCycle: 2 });
  await run.step();
  const from = t.requests.length;
  await run.step();
  assert.deepEqual(asked(t, from).slice(EVERY_CYCLE.length), ['22:69', '22:42']);
  run.stop();
  await conn.disconnect();
});

test('samples carry a timestamp in ms since the start, and a cycle stays short', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  for (let i = 0; i < 6; i++) await run.step();
  assert.equal(seen[0].t_ms, 0);
  for (let i = 1; i < seen.length; i++) assert.equal(seen[i].t_ms - seen[i - 1].t_ms, seen[i - 1].cycleMs, 'the next sample starts when the last cycle ended');
  assert.ok(seen.every((s) => s.cycleMs > 0));
  // A read takes the session's P3 plus the reply and the quiet that ends it (about 140 ms on the mock): a cycle of
  // the 8 every-cycle reads and one rotating read is 1.3 s at most; the first one also asks for the supported PIDs.
  assert.ok(Math.max(...seen.slice(1).map((s) => s.cycleMs)) <= 1300, `cycles ${seen.map((s) => s.cycleMs)}`);
  assert.ok(seen[0].cycleMs <= 1500, `cycles ${seen.map((s) => s.cycleMs)}`);
  assert.equal(run.longestCycleMs, Math.max(...seen.map((s) => s.cycleMs)));
  assert.ok(run.elapsedMs >= seen.at(-1).t_ms);
  run.stop();
  await conn.disconnect();
});

test('a rotating id the ECU stays silent on or refuses for two reads in a row is marked not available once, never an error, never asked again', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  t.silentIds.add(0x42); // sidestand
  delete t.dataIds[0x62]; // refused
  delete t.pids[0x0e]; // not on the ECU's list of supported PIDs
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  // The rotation has 27 items, so a rotating item is read once every 27 cycles: 90 cycles are three full rounds
  // plus the start of a fourth, where the two dropped ids would be read a third time if they were still asked.
  for (let i = 0; i < 90; i++) await run.step();
  const all = asked(t, from);
  assert.equal(all.filter((x) => x === '22:42').length, 4, 'two reads, each sent twice (the ECU may just have skipped one), then never again');
  assert.equal(all.filter((x) => x === '22:62').length, 2, 'two reads of a refusal, which is not resent, then never again');
  assert.equal(all.filter((x) => x === '01:0e').length, 0, 'a PID the ECU does not list is never asked');
  assert.deepEqual(run.notAvailable.sort(), ['dashLamp62', 'sidestand', 'timing']);
  assert.equal(run.errors, 0);
  assert.equal(conn.session.linkFailures, 0, 'silence is not a link failure');
  assert.ok(all.filter((x) => x === '22:41').length >= 3, 'the others carry on');
  const csv = readCsv(run.csvPath);
  assert.ok(csv.rows.every((r) => r.sidestand === '' && r.timing === ''), 'blank in the CSV');
  run.stop();
  await conn.disconnect();
});

test('a safety-critical value that never answers is dropped after three silent cycles, not on the first', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  t.silentIds.add(0x44); // the warning lamp, read every cycle
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  await run.step();
  await run.step();
  assert.deepEqual(run.notAvailable, [], 'two misses are not an answer');
  await run.step();
  assert.deepEqual(run.notAvailable, ['warningLamp']);
  const before = asked(t, from).filter((x) => x === '22:44').length;
  assert.equal(before, 6, 'three cycles, the request sent twice in each');
  await run.step();
  assert.equal(asked(t, from).filter((x) => x === '22:44').length, before, 'not asked any more');
  assert.equal(run.errors, 0);
  assert.equal(conn.session.linkFailures, 0);
  run.stop();
  await conn.disconnect();
});

test('a rotating item with one silent read is not marked not available; one silent two reads in a row is; one that answered once is never dropped', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  // perCycle above the size of the rotation reads each rotating item once per cycle, so a strike is one cycle.
  const run = recordRun(conn, { logDir, perCycle: 100 });
  t.silentIds.add(0x42); // sidestand: silent from the start
  t.silentIds.add(0x62); // dashLamp62: silent in the first cycle only
  const from = t.requests.length;
  const count = (id) => asked(t, from).filter((x) => x === id).length;

  await run.step();
  assert.deepEqual(run.notAvailable, [], 'one silent read is nothing');
  assert.equal(count('22:42'), 2, 'asked twice (the ECU may just have skipped one)');
  t.silentIds.delete(0x62);
  t.silentIds.add(0x64); // o2Heater answered in the first cycle: from the second on silent for good
  await run.step();
  assert.deepEqual(run.notAvailable, ['sidestand'], 'two silent reads in a row');
  assert.equal(readCsv(run.csvPath).rows.at(-1).dashLamp62, '1', 'the one that missed once answered the next cycle');
  assert.equal(count('22:42'), 4);
  await run.step();
  assert.equal(count('22:42'), 4, 'not asked again');

  for (let i = 0; i < 6; i++) await run.step();
  assert.deepEqual(run.notAvailable, ['sidestand'], 'a value that answered once is never dropped, however long the ECU is silent on it');
  assert.equal(count('22:64'), 1 + 2 * 8, 'one answered read (one request), then every cycle two requests again, 8 cycles');
  const csv = readCsv(run.csvPath);
  assert.equal(csv.rows.at(-1).o2Heater, '1', 'it keeps its last value');
  assert.equal(csv.rows.at(-1).o2Heater_raw, '00 ff');
  assert.equal(csv.rows.at(-1).sidestand, '', 'a dropped one is blank');
  assert.equal(run.errors, 0);
  assert.equal(conn.session.linkFailures, 0, 'silence is never a link failure');
  run.stop();
  await conn.disconnect();
});

test('the injection pulse of cylinder 1 is recorded in every cycle when the ECU serves it', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  let raw = 0;
  t.dataIds[0x110] = () => [raw >> 8, raw & 0xff];
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  const pulses = [0, 1500, 2800, 3250]; // raw / 1000 ms
  for (const p of pulses) {
    raw = p;
    await run.step();
  }
  assert.ok(seen.every((s) => s.read.includes('injPulse1')), 'read in every cycle');
  assert.deepEqual(seen.map((s) => s.channels.injPulse1), [0, 1.5, 2.8, 3.25]);
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.injPulse1), ['0', '1.5', '2.8', '3.25']);
  assert.deepEqual(csv.rows.map((r) => r.injPulse1_raw), ['00 00', '05 dc', '0a f0', '0c b2']);
  assert.ok(csv.rows.every((r) => r.injPulse2 === ''), 'the other cylinders only take their turn');
  assert.deepEqual(run.notAvailable, []);
  run.stop();
  await conn.disconnect();
});

test('a read that fails on the link is counted and the cycle goes on', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  await run.step();
  // An id read is sent again once, so one bad reply is absorbed...
  t.inject('badChecksum', { service: 0x22 });
  const once = await run.step();
  assert.equal(run.errors, 0);
  assert.ok(once.read.includes('battery'), 'the resend was answered');
  // ... and it takes two in a row to fail the read.
  t.inject('badChecksum', { service: 0x22, times: 2 });
  const sample = await run.step();
  assert.equal(run.errors, 1);
  assert.ok(!sample.read.includes('battery'), 'the read that failed twice gave no value');
  assert.ok(sample.read.includes('startSwitch') && sample.read.includes('fuelPump'), 'the other reads of that cycle still landed');
  run.stop();
  await conn.disconnect();
});

test('the ECU\'s own engine speed is read in every cycle, the OBD rpm (PID 0C) is not: cranking shows on rpmId while the OBD rpm stays 0 and is only read when its turn comes', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  const from = t.requests.length;
  const script = [
    { rpmId: 0, start: false },
    { rpmId: 0, start: true },
    { rpmId: 160, start: true }, // cranking: 640 raw * 0.25
    { rpmId: 163, start: true }, // raw 652 -> 163 rpm, shown rounded down to a multiple of 10
    { rpmId: 0, start: false },
  ];
  for (const change of script) {
    Object.assign(car, change);
    await run.step();
  }
  assert.ok(seen.every((s) => s.read.includes('rpmId') && s.read.includes('startSwitch')), 'both in every sample');
  assert.ok(seen.every((s) => !s.read.includes('rpm')), 'the OBD rpm only takes its turn in the rotation (its turn is the tenth: not within five cycles)');
  assert.equal(asked(t, from).filter((x) => x === '01:0c').length, 0, 'PID 0C is not asked in these five cycles');
  assert.deepEqual(seen.map((s) => s.channels.rpmId), [0, 0, 160, 160, 0]);
  assert.deepEqual(seen.map((s) => s.channels.rpm), [undefined, undefined, undefined, undefined, undefined]);
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.rpmId), ['0', '0', '160', '160', '0']);
  assert.deepEqual(csv.rows.map((r) => r.rpm), ['', '', '', '', ''], 'the OBD rpm is blank until its turn comes');
  assert.deepEqual(csv.rows.map((r) => r.startSwitch), ['0', '1', '1', '1', '0']);
  assert.equal(csv.rows[2].rpmId_raw, '02 80');
  assert.equal(csv.rows[3].rpmId_raw, '02 8c');
  assert.equal(run.view().live.rpm, 0, 'the live rpm is the ECU\'s own');
  assert.deepEqual(run.notAvailable, []);
  run.stop();
  await conn.disconnect();
});

test('the tip-over sensor (id 0x63, key tipOver) is read in every cycle, so a trip of one cycle is in the CSV; the OBD rpm is not in the every-cycle list', async () => {
  assert.ok(EVERY_CYCLE.includes('tipOver'));
  assert.ok(!EVERY_CYCLE.includes('rpm'), 'rpm (PID 0C) takes its turn in the rotation');
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  const from = t.requests.length;
  const trips = [false, false, true, false, false, true, true, false];
  for (const tripped of trips) {
    car.tipOver = tripped;
    await run.step();
  }
  assert.ok(seen.every((s) => s.read.includes('tipOver')), 'read in all eight cycles, not once per rotation');
  assert.equal(asked(t, from).filter((x) => x === '22:63').length, trips.length, 'one request per cycle (no resend: it answered)');
  assert.deepEqual(seen.map((s) => s.channels.tipOver), trips.map(Number));
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.tipOver), trips.map((x) => (x ? '1' : '0')), 'a one-cycle trip is a row of its own');
  assert.deepEqual(csv.rows.map((r) => r.tipOver_raw), trips.map((x) => (x ? '00 ff' : '00 00')));
  assert.ok(!csv.header.includes('startRelay') && !csv.header.includes('startRelay_raw'));
  assert.deepEqual(seen.map((s) => s.snapshot.tipOver), trips);
  assert.deepEqual(run.notAvailable, []);
  run.stop();
  await conn.disconnect();
});

test('cycle_ms is the second CSV column and in view(): how long the cycle of that row took', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  for (let i = 0; i < 5; i++) await run.step();
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.header.slice(0, 3), ['t_ms', 'cycle_ms', 'rpm']);
  assert.deepEqual(csv.rows.map((r) => Number(r.cycle_ms)), seen.map((s) => s.cycleMs));
  assert.ok(csv.rows.every((r) => /^\d+$/.test(r.cycle_ms) && Number(r.cycle_ms) > 0));
  for (let i = 1; i < csv.rows.length; i++) assert.equal(Number(csv.rows[i].t_ms) - Number(csv.rows[i - 1].t_ms), Number(csv.rows[i - 1].cycle_ms), 'the next row starts when the cycle of this one ended');
  const view = run.view();
  assert.equal(view.cycle_ms, seen.at(-1).cycleMs, 'the newest cycle');
  assert.deepEqual(view.cycleMs, { last: seen.at(-1).cycleMs, longest: run.longestCycleMs });
  run.mark('after the last sample');
  run.stop();
  await tick();
  const last = readCsv(run.csvPath).rows.at(-1);
  assert.equal(last.marker, 'after the last sample');
  assert.equal(last.cycle_ms, '', 'the closing row of a marker is no cycle');
  await conn.disconnect();
});

/** The clock time of the second cycle of a recording whose ECU is silent on `silent` (0x22 ids); `perCycle` rotating reads per cycle. */
async function secondCycleMs(silent, perCycle) {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  for (const id of silent) t.silentIds.add(id);
  const run = recordRun(conn, { logDir, perCycle });
  await run.step();
  const ms = (await run.step()).cycleMs;
  run.stop();
  await conn.disconnect();
  return ms;
}

test('a silent rotating item costs about 2 x 250 ms when its turn comes, a silent every-cycle one 2 x 500 ms, and a rotating one is dropped after 2 strikes', async () => {
  assert.equal(ROTATING_TIMEOUT_MS, 250);
  // Every rotating item is read once per cycle, so sidestand (0x42) is asked in the second cycle: two requests
  // (the resend), each P3 (60 ms) + the wait, in place of one answered read (about 140 ms on the mock).
  const rotating = (await secondCycleMs([0x42], 100)) - (await secondCycleMs([], 100));
  assert.ok(rotating >= 2 * (60 + 250) - 160 && rotating <= 2 * (60 + 250), `a silent rotating item cost ${rotating} ms more than an answered one`);
  const every = (await secondCycleMs([0x44], 1)) - (await secondCycleMs([], 1)); // the warning lamp is read every cycle
  assert.ok(every >= 2 * (60 + 500) - 160 && every <= 2 * (60 + 500), `a silent every-cycle item cost ${every} ms more than an answered one`);

  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  t.silentIds.add(0x42);
  const run = recordRun(conn, { logDir, perCycle: 100 });
  const from = t.requests.length;
  await run.step();
  assert.deepEqual(run.notAvailable, [], 'one silent read');
  await run.step();
  assert.deepEqual(run.notAvailable, ['sidestand'], 'two in a row');
  const before = asked(t, from).filter((x) => x === '22:42').length;
  assert.equal(before, 4, 'two reads, each sent twice');
  await run.step();
  assert.equal(asked(t, from).filter((x) => x === '22:42').length, before, 'not asked again');
  run.stop();
  await conn.disconnect();
});

test('the rotating read of a cycle is skipped when the every-cycle reads of that cycle were slow, and the rotation order is kept', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  t.silentIds.add(0x44); // two every-cycle ids that say nothing (warning lamp, fuel pump): 2 x 2 x 500 ms of waiting
  t.silentIds.add(0x60);
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  const s1 = await run.step();
  assert.equal(s1.skipped, true);
  assert.ok(s1.cycleMs > 2400, `${s1.cycleMs} ms of every-cycle reads`);
  assert.ok(!asked(t, from).includes('22:40'), 'no rotating read in a slow cycle');
  const s2 = await run.step();
  const s3 = await run.step();
  assert.equal(run.skippedRotations, 3);
  assert.equal(run.view().skippedRotations, 3);
  assert.ok(!asked(t, from).includes('22:40'));
  assert.deepEqual(run.notAvailable.sort(), ['fuelPump', 'warningLamp'], 'three silent cycles in a row: not available');
  const mark = t.requests.length;
  const s4 = await run.step();
  assert.equal(s4.skipped, false, 'the cycle is short again');
  assert.ok(s4.cycleMs < 1400);
  assert.deepEqual(asked(t, mark).slice(-1), ['22:40'], 'the rotation starts where it would have started: nothing was taken from its turn');
  assert.ok(s2.skipped && s3.skipped);
  assert.equal(run.errors, 0);
  run.stop();
  await conn.disconnect();
});

test('an every-cycle value that answered and then goes silent for 3 cycles takes turns with the rotation, and is every-cycle again once it answers', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const run = recordRun(conn, { logDir, perCycle: 100 }); // the whole rotation is read each cycle: its turn comes at once
  await run.step();
  await run.step();
  t.silentIds.add(0x44); // the warning lamp stops answering
  const cycles = [];
  for (let i = 0; i < 3; i++) cycles.push(await cycleTime(run));
  assert.deepEqual(run.demoted, ['warningLamp'], 'three silent cycles in a row');
  assert.deepEqual(run.notAvailable, [], 'it answered before: never dropped');
  assert.equal(run.view().demoted[0], 'warningLamp');
  // Now it is asked once per round, by the rotation's short wait (2 x 250 ms), not every cycle (2 x 500 ms).
  const from = t.requests.length;
  const next = await cycleTime(run);
  assert.equal(asked(t, from).filter((x) => x === '22:44').length, 2, 'once in the rotation, sent twice');
  assert.ok(asked(t, from).indexOf('22:44') > asked(t, from).indexOf('22:61'), 'after the every-cycle reads (the last of them is the dash flag 0x61)');
  assert.ok(next < cycles[0], `${next} ms instead of ${cycles[0]} ms`);
  t.silentIds.delete(0x44); // it comes back
  await run.step();
  assert.deepEqual(run.demoted, [], 'answered in the rotation: every cycle again');
  const again = t.requests.length;
  await run.step();
  assert.equal(asked(t, again).indexOf('22:44'), EVERY_CYCLE.indexOf('warningLamp'), 'read among the every-cycle values again');
  assert.equal(readCsv(run.csvPath).rows.at(-1).warningLamp, '1');
  assert.equal(run.errors, 0);
  assert.equal(conn.session.linkFailures, 0);
  run.stop();
  await conn.disconnect();
});

test('a failed supported-PID read is retried only every 10 cycles, not every cycle', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const answer = t.modes[0x01];
  let down = true;
  t.modes[0x01] = (pid, ...rest) => (pid === 0x00 && down ? null : answer(pid, ...rest));
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  for (let i = 0; i < 25; i++) await run.step();
  // cycles 0, 10 and 20 asked (PID 00, sent twice each: the session resends once), the 22 others did not
  assert.equal(asked(t, from).filter((x) => x === '01:00').length, 6);
  assert.equal(run.errors, 3, 'each failed attempt is one error');
  assert.equal(run.samples, 25, 'the recording goes on without the list');
  assert.ok(asked(t, from).includes('01:0d'), 'the gauges are still read');
  down = false;
  for (let i = 0; i < 4; i++) await run.step(); // cycles 25..28
  assert.equal(asked(t, from).filter((x) => x === '01:00').length, 6, 'not asked before cycle 30');
  await run.step();
  await run.step();
  await run.step(); // cycle 30 (the fourth try) works
  const tries = asked(t, from).filter((x) => x === '01:00').length;
  assert.equal(tries, 7, 'answered at the first request');
  for (let i = 0; i < 12; i++) await run.step();
  assert.equal(asked(t, from).filter((x) => x === '01:00').length, tries, 'a list that was read is not asked for again');
  assert.equal(run.errors, 3);
  run.stop();
  await conn.disconnect();
});

// ---- markers ---------------------------------------------------------------------

test('a marker lands on the next sample, and on that one only; several join; an empty one is ignored', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  assert.equal(run.mark('  '), null);
  assert.equal((await run.step()).marker, '');
  assert.deepEqual(run.mark('Cranking'), { t_ms: run.markers[0].t_ms, text: 'Cranking' });
  run.mark('Started\nbut rough');
  const s2 = await run.step();
  assert.equal(s2.marker, 'Cranking | Started but rough');
  assert.equal((await run.step()).marker, '');
  run.mark('a, "quoted" note');
  await run.step();
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.marker), ['', 'Cranking | Started but rough', '', 'a, "quoted" note']);
  assert.deepEqual(run.markers.map((m) => m.text), ['Cranking', 'Started but rough', 'a, "quoted" note']);
  run.stop();
  await conn.disconnect();
});

test('a marker set after the last sample still gets a row, and a stopped run takes no more markers', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  const ended = run.start();
  await until(() => run.samples >= 2);
  run.mark('Died');
  run.stop();
  assert.equal(await ended, 'cancelled');
  await tick();
  const csv = readCsv(run.csvPath);
  assert.equal(csv.rows.at(-1).marker, 'Died');
  assert.equal(csv.rows.at(-1).t_ms, String(run.endedAt - run.startedAt));
  assert.equal(csv.rows.length, run.samples + 1, 'the marker has its own row after the last sample');
  assert.equal(csv.rows.at(-1).rpm, csv.rows.at(-2).rpm, 'with the values carried over');
  assert.equal(run.mark('too late'), null);
  await conn.disconnect();
});

test('a marker typed before the run starts lands on its first sample', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  run.mark('Key on');
  assert.equal((await run.step()).marker, 'Key on');
  run.stop();
  await conn.disconnect();
});

// ---- events ----------------------------------------------------------------------

/** One detector step at time `t` ms with the newest values. */
const feed = (d, t, v) => d.push({ t, rpm: null, battery: null, fuelPump: null, mainRelay: null, startSwitch: null, tipOver: null, warningLamp: null, engineLamp: null, ...v });

test('engine stopped: rpm falls from above 400 to below 100 within 2 s, once, and not otherwise', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { rpm: 4000 }), []);
  assert.deepEqual(feed(d, 1000, { rpm: 0 }), ['engine stopped']);
  assert.deepEqual(feed(d, 2000, { rpm: 0 }), [], 'only once');
  assert.deepEqual(feed(d, 3000, { rpm: 900 }), []);
  assert.deepEqual(feed(d, 4000, { rpm: 80 }), ['engine stopped'], 'armed again by running');

  const slow = new EventDetector();
  feed(slow, 0, { rpm: 4000 });
  assert.deepEqual(feed(slow, 2500, { rpm: 0 }), [], 'more than 2 s between the two readings');
  const edge = new EventDetector();
  feed(edge, 0, { rpm: 500 });
  assert.deepEqual(feed(edge, 2000, { rpm: 99 }), ['engine stopped'], 'exactly 2 s still counts');

  const winding = new EventDetector();
  for (const [t, rpm] of [[0, 1200], [1000, 300], [2000, 150], [3000, 60], [4000, 0]]) {
    assert.deepEqual(feed(winding, t, { rpm }), [], `rpm ${rpm} at ${t}: it came down slowly`);
  }
  const idle = new EventDetector();
  for (const [t, rpm] of [[0, 0], [1000, 350], [2000, 0], [3000, 100]]) assert.deepEqual(feed(idle, t, { rpm }), [], 'never above 400, never above 400 then below 100');
  const unknown = new EventDetector();
  assert.deepEqual(feed(unknown, 0, { rpm: 4000 }), []);
  assert.deepEqual(feed(unknown, 500, { rpm: null }), [], 'an rpm that was not read says nothing');
});

test('fuel pump: ON when the flag turns on, OFF while running only when rpm is above 0', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { fuelPump: true, rpm: 0 }), [], 'the first value seen is the baseline');
  assert.deepEqual(feed(d, 1000, { fuelPump: false, rpm: 0 }), [], 'off with the engine not turning: the prime ending');
  assert.deepEqual(feed(d, 2000, { fuelPump: true, rpm: 0 }), ['fuel pump ON']);
  assert.deepEqual(feed(d, 3000, { fuelPump: true, rpm: 1500 }), []);
  assert.deepEqual(feed(d, 4000, { fuelPump: false, rpm: 1500 }), ['fuel pump OFF while running']);
  assert.deepEqual(feed(d, 5000, { fuelPump: false, rpm: 1500 }), [], 'a transition, not a state');
  assert.deepEqual(feed(d, 6000, { fuelPump: null, rpm: 1500 }), []);
  const unread = new EventDetector();
  assert.deepEqual(feed(unread, 0, { fuelPump: null }), []);
  assert.deepEqual(feed(unread, 1000, { fuelPump: true }), [], 'first known value: baseline, not ON');
});

test('main relay OFF and the start switch on the transitions, not the states', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { mainRelay: true, startSwitch: false }), []);
  assert.deepEqual(feed(d, 1000, { mainRelay: true, startSwitch: true }), ['start switch pressed']);
  assert.deepEqual(feed(d, 2000, { mainRelay: true, startSwitch: true }), []);
  assert.deepEqual(feed(d, 3000, { mainRelay: true, startSwitch: false }), ['start switch released']);
  assert.deepEqual(feed(d, 4000, { mainRelay: false, startSwitch: false }), ['main relay OFF']);
  assert.deepEqual(feed(d, 5000, { mainRelay: false, startSwitch: false }), []);
  assert.deepEqual(feed(d, 6000, { mainRelay: true, startSwitch: false }), [], 'the relay coming back is not an event');
});

test('tip-over sensor: TRIPPED when the flag turns off (00 00), OK again when it turns on (00 ff, good), a transition and not a state; the first value is a baseline', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { tipOver: true }), [], 'the first value seen is the baseline');
  assert.deepEqual(feed(d, 1000, { tipOver: true }), []);
  assert.deepEqual(feed(d, 2000, { tipOver: false }), ['tip-over sensor TRIPPED']);
  assert.deepEqual(feed(d, 3000, { tipOver: false }), [], 'still tripped: not a new event');
  assert.deepEqual(feed(d, 4000, { tipOver: true }), ['tip-over sensor OK again']);
  assert.deepEqual(feed(d, 5000, { tipOver: true }), []);
  assert.deepEqual(feed(d, 6000, { tipOver: false }), ['tip-over sensor TRIPPED'], 'and again');
  assert.deepEqual(feed(d, 7000, { tipOver: null }), [], 'a value that was not read says nothing');
  assert.deepEqual(feed(d, 8000, { tipOver: false }), [], 'a null in between does not make a change');

  const tripped = new EventDetector();
  assert.deepEqual(feed(tripped, 0, { tipOver: false }), [], 'a recording that starts tripped: baseline, not an event');
  assert.deepEqual(feed(tripped, 1000, { tipOver: true }), ['tip-over sensor OK again']);

  const unread = new EventDetector();
  assert.deepEqual(feed(unread, 0, { tipOver: null }), []);
  assert.deepEqual(feed(unread, 1000, { tipOver: true }), [], 'first known value: baseline, not an event');
  assert.deepEqual(feed(unread, 2000, { tipOver: false }), ['tip-over sensor TRIPPED']);
});

test('dash power flags: an event each time 0x44 and 0x61 change into disagreement and when they agree again, none for a baseline or while the state holds', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { warningLamp: true, engineLamp: true }), [], 'the first pair is the baseline');
  assert.deepEqual(feed(d, 1000, { warningLamp: true, engineLamp: true }), []);
  assert.deepEqual(feed(d, 2000, { warningLamp: true, engineLamp: false }), ['dash power flags disagree (0x44 on, 0x61 off)']);
  assert.deepEqual(feed(d, 3000, { warningLamp: true, engineLamp: false }), [], 'the same disagreement: once');
  assert.deepEqual(feed(d, 4000, { warningLamp: false, engineLamp: false }), ['dash power flags agree again']);
  assert.deepEqual(feed(d, 5000, { warningLamp: false, engineLamp: false }), [], 'both off together is agreement (the key off)');
  assert.deepEqual(feed(d, 6000, { warningLamp: false, engineLamp: true }), ['dash power flags disagree (0x44 off, 0x61 on)'], 'a new disagreement');
  assert.deepEqual(feed(d, 7000, { warningLamp: true, engineLamp: false }), [], 'one disagreement into another is not a new one');
  assert.deepEqual(feed(d, 8000, { warningLamp: true, engineLamp: true }), ['dash power flags agree again']);

  const baseline = new EventDetector();
  assert.deepEqual(feed(baseline, 0, { warningLamp: true, engineLamp: false }), [], 'a recording that starts in disagreement: baseline');
  assert.deepEqual(feed(baseline, 1000, { warningLamp: true, engineLamp: false }), []);
  assert.deepEqual(feed(baseline, 2000, { warningLamp: true, engineLamp: true }), ['dash power flags agree again']);

  const partial = new EventDetector();
  assert.deepEqual(feed(partial, 0, { warningLamp: true, engineLamp: null }), [], 'only one flag known: nothing to compare');
  assert.deepEqual(feed(partial, 1000, { warningLamp: false, engineLamp: null }), []);
  assert.deepEqual(feed(partial, 2000, { warningLamp: false, engineLamp: true }), [], 'the second flag first seen, and it disagrees: baseline, not an event');
  assert.deepEqual(feed(partial, 3000, { warningLamp: false, engineLamp: false }), ['dash power flags agree again']);
  assert.deepEqual(feed(partial, 4000, { warningLamp: null, engineLamp: false }), [], 'a flag that was not read says nothing');
});

test('events from a recording: the tip-over sensor and the dash flags are in the snapshot and the events reach the CSV and the live list', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  const run = recordRun(conn, { logDir });
  const live = [];
  run.on('event', (e) => live.push(e.text));
  const step = async (change) => {
    Object.assign(car, change);
    return run.step();
  };
  const first = await step({});
  assert.deepEqual([first.snapshot.tipOver, first.snapshot.warningLamp, first.snapshot.engineLamp], [false, true, true], 'booleans in the snapshot');
  assert.deepEqual(first.events, [], 'baselines');
  assert.deepEqual((await step({ tipOver: true })).events, ['tip-over sensor OK again'], 'the baseline was the tripped state (00 00); 00 ff is good');
  assert.deepEqual((await step({ tipOver: false })).events, ['tip-over sensor TRIPPED'], 'seen in the very cycle it happened: a trip of one cycle is caught');
  assert.deepEqual((await step({ dash61: false })).events, ['dash power flags disagree (0x44 on, 0x61 off)']);
  assert.deepEqual((await step({ dash44: false })).events, ['dash power flags agree again']);
  assert.deepEqual((await step({ dash44: true, dash61: true })).events, [], 'both back on together: they agree throughout');
  assert.deepEqual(live, ['tip-over sensor OK again', 'tip-over sensor TRIPPED', 'dash power flags disagree (0x44 on, 0x61 off)', 'dash power flags agree again']);
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.event), ['', 'tip-over sensor OK again', 'tip-over sensor TRIPPED', 'dash power flags disagree (0x44 on, 0x61 off)', 'dash power flags agree again', '']);
  assert.deepEqual(csv.rows.map((r) => r.tipOver), ['0', '1', '0', '0', '0', '0']);
  run.stop();
  await conn.disconnect();
});

test('battery dip: below 9.5 V, once per dip', () => {
  const d = new EventDetector();
  assert.deepEqual(feed(d, 0, { battery: 12.6 }), []);
  assert.deepEqual(feed(d, 1000, { battery: 9.5 }), [], '9.5 is not below 9.5');
  assert.deepEqual(feed(d, 2000, { battery: 9.4 }), ['battery dip 9.4 V']);
  assert.deepEqual(feed(d, 3000, { battery: 8.7 }), [], 'the same dip');
  assert.deepEqual(feed(d, 4000, { battery: 12.1 }), []);
  assert.deepEqual(feed(d, 5000, { battery: 9.0 }), ['battery dip 9.0 V'], 'a new dip');
  const first = new EventDetector();
  assert.deepEqual(feed(first, 0, { battery: 8.2 }), ['battery dip 8.2 V'], 'a recording that starts in a dip');
});

test('events from a recording: each lands on the sample where it happened, in the CSV and the live list', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  const run = recordRun(conn, { logDir }); // the main relay takes turns with the rotation (its turn is the third, then every 27 cycles)
  const live = [];
  run.on('event', (e) => live.push(e.text));
  const events = async (change) => {
    Object.assign(car, change);
    return (await run.step()).events;
  };

  assert.deepEqual(await events({}), [], 'the first sample is a baseline');
  assert.deepEqual(await events({ pump: true }), ['fuel pump ON'], 'key on, the prime');
  assert.deepEqual(await events({ pump: false }), [], 'the prime ends with the engine not turning');
  assert.deepEqual(await events({ pump: true, start: true }), ['fuel pump ON', 'start switch pressed']);
  assert.deepEqual(await events({ volts: 8.9, rpm: 250 }), ['battery dip 8.9 V']);
  assert.deepEqual(await events({ volts: 8.6, rpm: 1100 }), [], 'the same dip');
  assert.deepEqual(await events({ start: false, volts: 13.4 }), ['start switch released']);
  assert.deepEqual(await events({ pump: false }), ['fuel pump OFF while running']);
  assert.deepEqual(await events({ rpm: 0 }), ['engine stopped']);
  // The relay goes off now, but it is only seen on the sample that reads it (cycle 29, its next turn), and that sample gets the event.
  car.relay = false;
  const quiet = [];
  let off = null;
  while (off === null && quiet.length < 40) {
    const sample = await run.step();
    if (sample.events.length) off = sample;
    else quiet.push(sample);
  }
  assert.ok(off, 'the relay change was seen');
  assert.deepEqual(off.events, ['main relay OFF']);
  assert.ok(off.read.includes('mainRelay'), 'on the sample that read the relay');
  assert.ok(quiet.every((q) => !q.read.includes('mainRelay')), 'no sample before it read the relay again');
  assert.equal(quiet.length, 20, 'cycles 9 to 28 had nothing to report; the relay was read again in cycle 29');
  assert.deepEqual(await events({}), []);

  assert.deepEqual(live, ['fuel pump ON', 'fuel pump ON', 'start switch pressed', 'battery dip 8.9 V', 'start switch released', 'fuel pump OFF while running', 'engine stopped', 'main relay OFF']);
  assert.deepEqual(run.events.map((e) => e.text), live);
  assert.ok(run.events.every((e, i) => i === 0 || e.t_ms >= run.events[i - 1].t_ms));
  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.rows.map((r) => r.event), ['', 'fuel pump ON', '', 'fuel pump ON; start switch pressed', 'battery dip 8.9 V', '', 'start switch released', 'fuel pump OFF while running', 'engine stopped', ...quiet.map(() => ''), 'main relay OFF', '']);
  assert.deepEqual(run.battery, { min: 8.6, max: 13.4, last: 13.4 }, 'lowest and highest battery voltage seen');
  run.stop();
  await conn.disconnect();
});

test('the event snapshot takes the ECU\'s own engine speed (rpmId) when it has one, else the OBD rpm: a stop is seen on either', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  car.rpm = 0; // the OBD rpm does not report cranking or low speeds here: it stays 0
  car.rpmId = 3000;
  const run = recordRun(conn, { logDir });
  const first = await run.step();
  assert.equal(first.snapshot.rpm, 3000, 'rpmId, not the OBD rpm');
  car.rpmId = 0;
  const second = await run.step();
  assert.equal(second.snapshot.rpm, 0);
  assert.deepEqual(second.events, ['engine stopped'], 'seen on rpmId although the OBD rpm never moved');
  run.stop();
  await conn.disconnect();

  const other = await connectedBike();
  const car2 = drive(other.t);
  delete other.t.dataIds[0x100]; // the ECU refuses the id: no rpmId, the OBD rpm is the fallback
  car2.rpm = 4000;
  // The OBD rpm takes its turn in the rotation now: perCycle 100 reads the whole rotation each cycle, so it is read every cycle here.
  const run2 = recordRun(other.conn, { logDir: other.logDir, perCycle: 100 });
  const a = await run2.step();
  assert.equal(a.snapshot.rpm, 4000, 'the OBD rpm when rpmId was not read');
  assert.ok(!a.read.includes('rpmId') && a.read.includes('rpm'));
  car2.rpm = 0;
  const b = await run2.step();
  assert.equal(b.snapshot.rpm, 0);
  // Reading the whole rotation takes seconds, longer than the 2 s window of a stop, so the recording itself may not see it here
  // (with the ECU's rpmId refused, the OBD rpm is read only when its turn comes): the snapshots are what a detector works from.
  const detector = new EventDetector();
  assert.deepEqual(detector.push({ ...a.snapshot, t: 0 }), []);
  assert.deepEqual(detector.push({ ...b.snapshot, t: 1000 }), ['engine stopped'], 'the fallback snapshot is a usable rpm');
  run2.stop();
  await other.conn.disconnect();
});

// ---- the CSV ---------------------------------------------------------------------

test('the CSV: timestamp, a column per gauge and analog, a 0/1 per switch, raw bytes, marker, event', async () => {
  const { t, conn, logDir } = await connectedBike();
  serveNewIds(t);
  const car = drive(t);
  car.pump = true;
  car.rpm = 1250;
  car.tipOver = true;
  const run = recordRun(conn, { logDir, perCycle: 2 });
  assert.equal(path.dirname(run.csvPath), logDir);
  assert.match(path.basename(run.csvPath), /^record-\d{4}-\d\d-\d\dT[\d-]+Z\.csv$/);
  for (let i = 0; i < 12; i++) await run.step();

  const csv = readCsv(run.csvPath);
  assert.deepEqual(csv.header, HEADER);
  assert.equal(csv.rows.length, 12);
  for (const line of csv.lines) assert.equal(splitCsvLine(line).length, HEADER.length, 'every row has every column');
  const row = csv.rows.at(-1);
  assert.equal(row.rpm, '1250');
  assert.equal(row.rpmId, '1250', 'the ECU\'s own engine speed: raw 5000 * 0.25');
  assert.equal(row.rpmId_raw, '13 88');
  assert.equal(row.tipOver, '1');
  assert.equal(row.tipOver_raw, '00 ff');
  assert.equal(csv.rows[0].tipOver, '1', 'read in every cycle: in the very first row');
  assert.equal(row.tps, '50.2');
  assert.equal(row.battery, '12.6');
  assert.equal(row.battery_raw, '00 7e');
  assert.equal(row.fuelPump, '1');
  assert.equal(row.fuelPump_raw, '00 ff');
  assert.equal(row.mainRelay, '1');
  assert.equal(row.startSwitch, '0');
  assert.equal(row.startSwitch_raw, '00 00');
  assert.equal(row.neutral, '1', 'inverted: 00 00 is in neutral');
  assert.equal(row.neutral_raw, '00 00');
  assert.equal(row.secondaryAir, '0', 'inverted: 00 ff is off');
  assert.equal(row.airFlap, '1');
  assert.equal(row.gear, '4', 'a rotating value is read once the turn comes');
  assert.equal(row.gear_raw, '00 08');
  assert.equal(row.coolant, '90');
  assert.equal(csv.rows[0].coolant, '', 'blank until it has been read');
  assert.equal(csv.rows[0].sidestandV, '');
  assert.equal(row.sidestandV, '2.51');
  assert.equal(row.rolloverV, '2.5');
  assert.equal(row.sidestandV_raw, '00 80');
  assert.deepEqual(csv.rows.map((r) => Number(r.t_ms)), csv.rows.map((r) => Number(r.t_ms)).sort((a, b) => a - b));
  assert.equal(csv.rows[0].t_ms, '0');
  assert.ok(csv.rows.every((r) => /^\d+$/.test(r.t_ms)));
  run.stop();
  await conn.disconnect();
});

test('the CSV is capped: the run ends with a clear message, nothing past the cap is written and the file is closed', async () => {
  const { conn, logDir } = await connectedBike();
  const probe = recordRun(conn, { logDir });
  await probe.step();
  const rowBytes = fs.statSync(probe.csvPath).size;
  probe.stop();
  const head = HEADER.join(',').length + 1;
  const cap = head + Math.floor((rowBytes - head) * 2.5);
  const run = recordRun(conn, { logDir, maxBytes: cap });
  assert.equal(await run.start(), 'finished');
  assert.match(run.stopReason, /^CSV size limit reached \(\d+ bytes\): recording stopped$/);
  const size = fs.statSync(run.csvPath).size;
  assert.ok(size <= cap, `${size} <= ${cap}`);
  assert.equal(run.csvBytes, size);
  assert.equal(readCsv(run.csvPath).rows.length, 2);
  assert.equal(run.csvOpen, false);
  assert.equal(run.view().stopReason, run.stopReason);
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();

  const { conn: other, logDir: dir2 } = await connectedBike();
  const big = recordRun(other, { logDir: dir2, maxBytes: 50 * 1024 * 1024 });
  assert.equal(big.maxBytes, 52428800, 'the default cap is 50 MB');
  big.stop();
  await other.disconnect();
});

test('a recording stops by itself after its minutes (10 by default)', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir, minutes: 0.1 });
  assert.equal(await run.start(), 'finished');
  assert.equal(run.stopReason, 'time limit of 0.1 minutes reached');
  assert.ok(run.elapsedMs >= 6000 && run.elapsedMs < 8500, `${run.elapsedMs} ms`);
  assert.ok(run.samples >= 5);
  assert.equal(run.csvOpen, false);
  assert.equal(readCsv(run.csvPath).rows.length, run.samples);
  assert.deepEqual(conn.runs, []);

  const long = recordRun(conn, { logDir });
  assert.equal(long.maxMs, 600_000);
  long.stop();
  assert.throws(() => recordRun(conn, { logDir, minutes: 0 }), /minutes must be more than 0/);
  assert.deepEqual(conn.runs, [], 'a refused recording registers nothing');
  await conn.disconnect();
});

test('a disconnect cancels the recording: nothing more is read or recorded, and the file is closed', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  assert.deepEqual(conn.runs, ['record']);
  const ended = run.start();
  await until(() => run.samples >= 3);
  await conn.disconnect();
  assert.equal(await ended, 'cancelled');
  assert.equal(run.csvOpen, false);
  assert.deepEqual(conn.runs, []);
  const csv = readCsv(run.csvPath);
  assert.equal(csv.rows.length, run.samples, 'every recorded sample is in the file, nothing else');
  const sent = t.requests.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sent);
  assert.equal(run.samples, csv.rows.length);
  assert.equal(run.stopReason, null);
});

test('a lost ECU ends the recording with a "connection lost" event on a last row', async () => {
  const { t, conn, logDir } = await connectedBike({ connection: { keepAliveMs: 3 } });
  drive(t); // values that stand still: the mock's own pump flag flips on every read
  const run = recordRun(conn, { logDir, minutes: 1e6 }); // the fake clock runs far ahead of the real keep-alive timer
  const ended = run.start();
  await until(() => run.samples >= 2);
  t.inject('dropReply', { times: 100000 });
  assert.equal(await ended, 'cancelled');
  assert.equal(conn.state, 'lost');
  await tick();
  assert.deepEqual(run.events.map((e) => e.text), ['connection lost']);
  assert.match(run.stopReason, /^connection lost: ECU stopped answering/);
  const csv = readCsv(run.csvPath);
  assert.equal(csv.rows.at(-1).event, 'connection lost');
  assert.equal(run.csvOpen, false);
  await conn.disconnect();
});

test('a recording registers with the connection, replaces an older one, and needs a session', async () => {
  const idle = new Connection({ configPath: path.join(scratch(), 'config.json') });
  assert.throws(() => recordRun(idle, { logDir: scratch() }), /not connected/);
  const { conn, logDir } = await connectedBike();
  const a = recordRun(conn, { logDir });
  const b = recordRun(conn, { logDir });
  assert.equal(a.outcome, 'cancelled');
  assert.notEqual(a.csvPath, b.csvPath, 'two recordings started at the same moment do not share a file');
  await tick();
  assert.equal(a.csvOpen, false, 'the replaced one closed its file');
  assert.equal(b.running, true);
  b.stop();
  await conn.disconnect();
});

// ---- locked ----------------------------------------------------------------------

test('locked, only the OBD values are recorded and the rest says it needs the ECU unlock', async () => {
  const { t, conn, logDir } = await connectedBike({ unlocked: false });
  assert.notEqual(conn.unlockState, 'unlocked');
  const run = recordRun(conn, { logDir });
  const from = t.requests.length;
  for (let i = 0; i < 14; i++) await run.step();
  const all = asked(t, from);
  assert.ok(!all.some((x) => x.startsWith('22:')), 'no 0x22 request while locked');
  // None of the every-cycle list is an OBD value now (rpm takes its turn with the other gauges), so locked, each cycle reads one OBD value of the rotation.
  assert.deepEqual(all, [
    '01:00',
    ...['0c', '0d', '11', '0b', '05', '0f', '04', '0e', '06', '03', '0c', '0d', '11', '0b'].map((pid) => `01:${pid}`),
  ], 'one of the OBD values per cycle, in turn');
  assert.deepEqual(run.locked, [
    'battery', 'gear',
    'neutral', 'clutch', 'startSwitch', 'fuelPump', 'mainRelay', 'sidestand', 'warningLamp', 'engineLamp', 'dashLamp62', 'tipOver', 'dashLamp68', 'o2Heater', 'secondaryAir', 'airFlap',
    'sidestandV', 'rolloverV', 'rpmId', 'injPulse1', 'injPulse2', 'injPulse3', 'ignTiming1', 'ignTiming2', 'ignTiming3',
  ]);
  assert.match(run.view().lockedNote, /^needs the ECU unlock, not available \(/);
  assert.deepEqual(run.notAvailable, [], 'waiting for the unlock is not "not available"');
  assert.equal(run.errors, 0);
  assert.deepEqual(run.battery, { min: null, max: null, last: null });
  const csv = readCsv(run.csvPath);
  const last = csv.rows.at(-1);
  assert.equal(last.rpm, '4000');
  assert.equal(last.coolant, '90');
  for (const key of ['battery', 'gear', 'fuelPump', 'mainRelay', 'startSwitch', 'neutral', 'sidestandV', 'battery_raw']) assert.equal(last[key], '', key);
  assert.deepEqual(run.events, []);
  assert.equal(run.view().live.battery, null);
  run.stop();
  await conn.disconnect();
});

test('unlocking in the middle of a recording adds the unlock-only values from then on', async () => {
  const { t, conn, logDir } = await connectedBike({ connection: { autoUnlock: false } });
  assert.equal(conn.unlockState, 'locked');
  const run = recordRun(conn, { logDir });
  for (let i = 0; i < 3; i++) await run.step();
  assert.deepEqual(run.battery, { min: null, max: null, last: null });
  assert.deepEqual(await conn.unlock(), { state: 'unlocked', reason: null });
  const from = t.requests.length;
  await run.step();
  assert.ok(asked(t, from).includes('22:07'));
  assert.deepEqual(run.locked, []);
  assert.equal(run.battery.last, 13.8);
  assert.equal(readCsv(run.csvPath).rows.at(-1).battery, '13.8');
  run.stop();
  await conn.disconnect();
});

test('one sample time: a live graph point and the CSV row t_ms of the same sample are equal, and so is the replay of the file', async () => {
  const { conn, logDir } = await connectedBike();
  const run = recordRun(conn, { logDir });
  const seen = [];
  run.on('sample', (s) => seen.push(s));
  for (let i = 0; i < 6; i++) await run.step();
  assert.ok(seen.every((s) => s.cycleMs > 0), 'a cycle takes time, so a time stamped at its end would differ');
  const live = run.series().battery; // read in every cycle: one point per sample
  assert.equal(live.length, seen.length);
  const csvTimes = readCsv(run.csvPath).rows.map((r) => Number(r.t_ms));
  assert.deepEqual(live.map((p) => p[0]), csvTimes, 'the live graph and the CSV put each sample at the same moment');
  assert.deepEqual(live.map((p) => p[0]), seen.map((s) => s.t_ms));
  assert.equal(live[0][0], 0, 'the first sample is when its cycle started: at the start');
  run.stop();
  await tick();
  const replay = loadRecording(path.basename(run.csvPath), logDir).series.battery;
  assert.deepEqual(replay, live, 'the replay of the recording is the live graph, point for point');
  await conn.disconnect();
});

test('the recording is a LogSink: a second one in the same instant gets a numbered name and the file keeps the old format', async () => {
  const { conn, logDir } = await connectedBike();
  const a = recordRun(conn, { logDir });
  assert.match(path.basename(a.csvPath), /^record-\d{4}-\d\d-\d\dT[\d-]+Z\.csv$/);
  assert.equal(fs.readFileSync(a.csvPath, 'utf8'), `${HEADER.join(',')}\n`, 'the header is written when the file is opened');
  const b = recordRun(conn, { logDir });
  assert.match(path.basename(b.csvPath), /^record-\d{4}-\d\d-\d\dT[\d-]+Z-2\.csv$/);
  b.stop();
  await conn.disconnect();
});

test('the recorder only ever sends read requests: modes 01 and 22, plus the unlock the connection did', async () => {
  const { t, conn, logDir } = await connectedBike();
  const from = t.requests.length;
  const run = recordRun(conn, { logDir, minutes: 0.2 });
  await run.start();
  const services = new Set(t.requests.slice(from).map((r) => r.service));
  assert.deepEqual([...services].sort(), [0x01, 0x22]);
  await conn.disconnect();
});
