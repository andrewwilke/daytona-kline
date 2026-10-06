'use strict';

// The output tests: the whitelist in the bike description, the guarded runner (src/outputtests.js)
// against the mock ECU, and the guard that nothing else can build a start or stop request.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { DEFAULT_BIKE, defineBike } = require('../src/bikes');
const outputtests = require('../src/outputtests');
const { MockEcuTransport } = require('./mockecu');

const { runOutputTest, outputTestStatus, OutputTestError, COOLDOWN_MS, WATCH_MS, WATCH_STOP_MS } = outputtests;

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const LOCKED_NOTE = /^needs the ECU unlock, not available \(/;
const WHITELIST = [
  ['tachometer', 0x01], ['coolingFan', 0x06], ['fuelPump', 0x04], ['idleSpeedControl', 0x02],
  ['purgeValve', 0x03], ['secondaryAir', 0x0a], ['airFlap', 0x0c], ['exhaustValve', 0x0d],
];

/**
 * An ISO mock (engine off, bike stationary, 13.8 V, ECU unlocked unless asked otherwise) and a connection to
 * it through the real wake-up and unlock. `logDir` is where the output test log goes.
 */
async function connectBike({ mock = {}, autoUnlock = true, unlockFile = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-ot-'));
  if (unlockFile) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M, ...mock });
  t.pids[0x0c] = [0, 0]; // 0 rpm
  const conn = new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => t, clock: t.clock, keepAliveMs: 60_000, autoUnlock });
  await conn.connect({ port: 'MOCK' });
  return { t, conn, logDir: path.join(dir, 'logs') };
}

const sent = (t, service) => t.requests.filter((r) => r.service === service).map((r) => r.data);
const commanded = (t) => t.requests.filter((r) => r.service === 0x31 || r.service === 0x32);
const logText = (logDir) => {
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => /^output-tests-\d{4}-\d\d-\d\d\.txt$/.test(f)) : [];
  return files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
};
// Time passes in steps with a ping between, as the connection's keep-alive does: the real ECU drops the session after 5 s of silence.
async function idle(t, conn, ms) {
  for (let left = ms; left > 0; left -= 2000) {
    await t.clock.sleep(Math.min(left, 2000));
    await conn.session.request([0x01, 0x00]);
  }
}
const cooldown = (t, conn) => idle(t, conn, COOLDOWN_MS + 500);

async function refused(promise, kind, message) {
  await assert.rejects(promise, (e) => e instanceof OutputTestError && e.kind === kind && (message ? message.test(e.message) : true), `refused as ${kind}`);
}

// ---- The whitelist in the bike description --------------------------------------

test('the bike description lists exactly the 8 output tests, one stop-needing, only the pump with an effect id, with how far each is confirmed on the owner\'s bike', () => {
  const tests = DEFAULT_BIKE.outputTests;
  assert.deepEqual(tests.map((x) => [x.key, x.routine]), WHITELIST);
  assert.deepEqual(tests.filter((x) => x.needsStop).map((x) => x.key), ['idleSpeedControl']);
  assert.deepEqual(tests.filter((x) => x.effectId !== null).map((x) => [x.key, x.effectId]), [['fuelPump', 0x60]]);
  // Run on the owner's 2012 Daytona: tach, fan and pump seen working (confirmed), the idle stepper and
  // the air flap only heard (consistent); purge valve, SAI and exhaust servo are not fitted there (untested).
  assert.deepEqual(Object.fromEntries(tests.map((x) => [x.key, x.confirmation])), {
    tachometer: 'confirmed',
    coolingFan: 'confirmed',
    fuelPump: 'confirmed',
    idleSpeedControl: 'consistent',
    purgeValve: 'unconfirmed',
    secondaryAir: 'unconfirmed',
    airFlap: 'consistent',
    exhaustValve: 'unconfirmed',
  });
  for (const x of tests) {
    assert.ok(x.see.length > 10 && x.safety.length > 10 && x.name, x.key);
  }
  assert.match(tests.find((x) => x.key === 'coolingFan').safety, /hands.*cables.*fan/i);
  assert.match(tests.find((x) => x.key === 'fuelPump').safety, /fuel in the tank/);
  assert.match(tests.find((x) => x.key === 'exhaustValve').safety, /servo/);
  assert.match(tests.find((x) => x.key === 'tachometer').see, /needle sweeps/);
});

test('defineBike refuses a malformed or duplicated output test', () => {
  const base = { id: 'x', name: 'X', dataBlockId: 1 };
  const good = { key: 'a', name: 'A', routine: 1, needsStop: false, see: 's', safety: 's', effectId: null, confirmation: 'unconfirmed' };
  assert.deepEqual(defineBike(base).outputTests, []);
  assert.equal(defineBike({ ...base, outputTests: [good] }).outputTests.length, 1);
  assert.throws(() => defineBike({ ...base, outputTests: [{ ...good, routine: 256 }] }), /output test/);
  assert.throws(() => defineBike({ ...base, outputTests: [{ ...good, safety: undefined }] }), /output test/);
  assert.throws(() => defineBike({ ...base, outputTests: [{ ...good, confirmation: 'sure' }] }), /output test/);
  assert.throws(() => defineBike({ ...base, outputTests: [good, { ...good, routine: 2 }] }), /"a" is listed twice/);
  assert.throws(() => defineBike({ ...base, outputTests: [good, { ...good, key: 'b' }] }), /routine 0x1 is listed twice/);
});

// ---- A successful test for every key -------------------------------------------

test('each of the 8 tests sends exactly [31, routine] once, never retried, and only the idle speed control is ever stopped', async () => {
  const { t, conn, logDir } = await connectBike();
  for (const [key, routine] of WHITELIST) {
    const before = sent(t, 0x31).length;
    const run = await runOutputTest(conn, key, { confirmed: true, logDir });
    assert.equal(run.view().reply, `71 ${routine.toString(16).padStart(2, '0')}`, key);
    const v = await run.done;
    assert.deepEqual([v.state, v.outcome, v.running], ['finished', 'completed', false], key);
    assert.deepEqual(sent(t, 0x31).slice(before), [[0x31, routine]], `${key}: one start, no resend`);
    const limit = key === 'idleSpeedControl' ? WATCH_STOP_MS : WATCH_MS;
    assert.equal(v.watchMs, limit);
    assert.ok(v.elapsedMs >= limit && v.elapsedMs <= limit + 1500, `${key}: the watch ends at its bound (${v.elapsedMs} ms)`);
    await cooldown(t, conn);
  }
  assert.deepEqual(t.routinesStarted, WHITELIST.map(([, b]) => b));
  assert.equal(sent(t, 0x31).length, 8);
  assert.deepEqual(sent(t, 0x32), [[0x32, 0x02]], 'one stop, for the idle speed control only');
  assert.deepEqual(t.routinesStopped, [0x02]);
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('the idle speed control gets its stop after the watch and the view says so', async () => {
  const { t, conn, logDir } = await connectBike();
  const run = await runOutputTest(conn, 'idleSpeedControl', { confirmed: true, logDir });
  const v = await run.done;
  assert.deepEqual([v.stopSent, v.stopReply, v.stopError], [true, '72 02', null]);
  assert.deepEqual(t.routinesStopped, [0x02]);
  await conn.disconnect();
});

test('Stop ends the watch early: the idle speed control is stopped, every other test is just no longer watched', async () => {
  const { t, conn, logDir } = await connectBike();
  const idle = await runOutputTest(conn, 'idleSpeedControl', { confirmed: true, logDir });
  const v = await idle.stop();
  assert.deepEqual([v.outcome, v.stopSent, v.stopReply], ['stopped', true, '72 02']);
  assert.ok(v.elapsedMs < 2000);
  assert.deepEqual(sent(t, 0x32), [[0x32, 0x02]]);

  await cooldown(t, conn);
  const fan = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir });
  const w = await fan.stop();
  assert.deepEqual([w.outcome, w.stopSent], ['stopped', false]);
  assert.deepEqual(sent(t, 0x32), [[0x32, 0x02]], 'nothing was sent to stop the fan: it ends by itself');
  await fan.stop(); // a second press changes nothing
  assert.equal(sent(t, 0x32).length, 1);
  await conn.disconnect();
});

// ---- Refusals: nothing is sent ----------------------------------------------------

test('refused while locked or without an unlock file, saying "needs the ECU unlock, not available", and nothing is sent', async () => {
  for (const options of [{ autoUnlock: false }, { unlockFile: false }]) {
    const { t, conn, logDir } = await connectBike(options);
    assert.notEqual(conn.unlockState, 'unlocked');
    await refused(runOutputTest(conn, 'fuelPump', { confirmed: true, logDir }), 'locked', LOCKED_NOTE);
    assert.equal(commanded(t).length, 0);
    assert.equal(sent(t, 0x01).filter((d) => d[1] === 0x0c).length, 0, 'it did not even read the engine speed');
    await conn.disconnect();
  }
});

test('refused unless the caller says confirmed: true, and when not connected', async () => {
  const { t, conn, logDir } = await connectBike();
  for (const options of [{}, { confirmed: false }, { confirmed: 'yes' }, { confirmed: 1 }, { confirmed: undefined }]) {
    await refused(runOutputTest(conn, 'coolingFan', { ...options, logDir }), 'not-confirmed', /not confirmed/);
  }
  await refused(runOutputTest(conn, 'coolingFan', { logDir }), 'not-confirmed');
  assert.equal(commanded(t).length, 0);
  await conn.disconnect();
  await refused(runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }), 'not-connected', /not connected/);
  assert.equal(commanded(t).length, 0);
});

test('the whitelist is closed: no key outside the bike table can be sent', async () => {
  const { t, conn, logDir } = await connectBike();
  const outsiders = ['injector1', 'coil1', 'throttle', 'adjustExhaustValve', 'adjustIdle', 'resetAdaptation', 'resetTps', 'idleFuelTrim',
    'toString', 'constructor', '__proto__', 'hasOwnProperty', 'FuelPump', 'fuel pump', '', undefined, null, 4, 0x04, '04', 0x31, {}, ['fuelPump']];
  for (const key of outsiders) await refused(runOutputTest(conn, key, { confirmed: true, logDir }), 'unknown-test', /not an output test this tool can run/);
  assert.equal(commanded(t).length, 0);
  await conn.disconnect();
});

test('refused while the engine runs, when the engine speed cannot be read, while moving and when the speed cannot be read', async () => {
  const cases = [
    ['engine-running', (t) => { t.pids[0x0c] = [0x3e, 0x80]; }, /engine is running \(4000 rpm\)/],
    ['engine-running', (t) => { t.pids[0x0c] = [0, 1]; }, /0\.25 rpm/],
    ['engine-unknown', (t) => { delete t.pids[0x0c]; }, /cannot be read/],
    ['moving', (t) => { t.pids[0x0d] = [5]; }, /moving \(5 km\/h\)/],
    ['speed-unknown', (t) => { delete t.pids[0x0d]; }, /cannot be read/],
  ];
  for (const [kind, set, message] of cases) {
    const { t, conn, logDir } = await connectBike();
    set(t);
    await refused(runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }), kind, message);
    assert.equal(commanded(t).length, 0, kind);
    assert.deepEqual(conn.runs, []);
    await conn.disconnect();
  }
});

test('battery: below 10.5 V or unreadable is refused, 10.5 to 11.5 V runs with a warning, 11.5 V and up runs plainly', async () => {
  for (const [dataId, kind] of [[[0, 100], 'battery-low'], [[0, 104], 'battery-low'], [null, 'battery-unknown']]) {
    const { t, conn, logDir } = await connectBike();
    if (dataId) t.dataIds[0x07] = dataId;
    else t.silentIds.add(0x07);
    await refused(runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }), kind, dataId ? /below 10\.5 V/ : /cannot be read/);
    assert.equal(commanded(t).length, 0, kind);
    await conn.disconnect();
  }
  {
    const { t, conn, logDir } = await connectBike();
    delete t.dataIds[0x07]; // the ECU refuses the id
    await refused(runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }), 'battery-unknown');
    await conn.disconnect();
  }
  for (const [raw, warns] of [[105, true], [110, true], [114, true], [115, false], [138, false]]) {
    const { t, conn, logDir } = await connectBike();
    t.dataIds[0x07] = [0, raw];
    const run = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir });
    const v = await run.done;
    assert.equal(v.warnings.length, warns ? 1 : 0, `${raw / 10} V`);
    if (warns) assert.match(v.warnings[0], /ECU may reset/);
    assert.equal(v.outcome, 'completed');
    assert.equal(sent(t, 0x31).length, 1);
    assert.match(logText(logDir), warns ? /WARNING: battery/ : /^(?!.*WARNING)/s);
    await conn.disconnect();
  }
});

test('one at a time: a second start while one runs is refused, and so is a start inside the cooldown after it', async () => {
  const { t, conn, logDir } = await connectBike();
  const first = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir });
  assert.equal(first.view().running, true);
  await refused(runOutputTest(conn, 'tachometer', { confirmed: true, logDir }), 'busy', /another output test is running \(Cooling fan\)/);
  assert.deepEqual(sent(t, 0x31), [[0x31, 0x06]]);
  assert.equal(outputTestStatus(conn).running, true);
  await first.done;

  await refused(runOutputTest(conn, 'tachometer', { confirmed: true, logDir }), 'cooldown', /wait \d s/);
  assert.equal(sent(t, 0x31).length, 1);
  assert.ok(outputTestStatus(conn).cooldownMs > 0);
  await idle(t, conn, COOLDOWN_MS - 1500);
  await refused(runOutputTest(conn, 'tachometer', { confirmed: true, logDir }), 'cooldown');
  await idle(t, conn, 2000);
  assert.equal(outputTestStatus(conn).cooldownMs, 0);
  const second = await runOutputTest(conn, 'tachometer', { confirmed: true, logDir });
  assert.equal((await second.done).outcome, 'completed');
  await conn.disconnect();
});

test('a clock that jumps back never makes the cooldown longer than it is', async () => {
  const { t, conn, logDir } = await connectBike();
  await (await runOutputTest(conn, 'tachometer', { confirmed: true, logDir })).done;
  t.clock.t -= 3_600_000;
  assert.equal(outputTestStatus(conn).cooldownMs, COOLDOWN_MS);
  await conn.disconnect();
});

test('two starts at the same moment: one goes ahead, the other is refused', async () => {
  const { t, conn, logDir } = await connectBike();
  const results = await Promise.allSettled([
    runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }),
    runOutputTest(conn, 'airFlap', { confirmed: true, logDir }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.kind, 'busy');
  assert.equal(sent(t, 0x31).length, 1);
  await results[0].value.done;
  await conn.disconnect();
});

// ---- What the ECU says -------------------------------------------------------------

test('a negative response is reported once with its code, no retry, and a failed idle speed test is not stopped', async () => {
  const { t, conn, logDir } = await connectBike({ mock: { } });
  t.outputTestsRefuse = 0x22;
  const run = await runOutputTest(conn, 'idleSpeedControl', { confirmed: true, logDir });
  const v = run.view();
  assert.deepEqual([v.state, v.outcome, v.code, v.running], ['failed', 'refused-by-ecu', 0x22, false]);
  assert.match(v.error, /the ECU refused the test \(negative response, code 0x22\)/);
  assert.deepEqual(sent(t, 0x31), [[0x31, 0x02]], 'asked once');
  assert.equal(sent(t, 0x32).length, 0);
  assert.deepEqual(conn.runs, []);
  assert.deepEqual((await run.done).outcome, 'refused-by-ecu');
  assert.equal(logText(logDir).split('\n').filter((l) => /Idle speed control/.test(l)).length, 1, 'reported once in the log');
  await refused(runOutputTest(conn, 'coolingFan', { confirmed: true, logDir }), 'cooldown');
  await conn.disconnect();
});

test('silence is "no answer", reported once, not resent', async () => {
  const { t, conn, logDir } = await connectBike();
  t.outputTestsSilent = true;
  const run = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir });
  const v = run.view();
  assert.deepEqual([v.state, v.outcome], ['failed', 'no-answer']);
  assert.match(v.error, /^no answer from the ECU/);
  assert.deepEqual(sent(t, 0x31), [[0x31, 0x06]]);
  assert.equal(commanded(t).length, 1);
  assert.deepEqual(conn.runs, []);
  assert.equal(logText(logDir).split('\n').filter((l) => /no answer/.test(l)).length, 1);
  await conn.disconnect();
});

test('a reply for another routine is not taken as a start', async () => {
  const { t, conn, logDir } = await connectBike();
  t.modes[0x31] = () => [0x71, 0x0d];
  const run = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir });
  assert.deepEqual([run.view().state, run.view().outcome], ['failed', 'link-error']);
  assert.match(run.view().error, /unexpected reply \[71 0d\]/);
  await conn.disconnect();
});

// ---- The effect and the watch -------------------------------------------------------

test('the fuel pump test: the pump switch is seen flipping on and back off, and the watch ends within its bound', async () => {
  const { t, conn, logDir } = await connectBike();
  t.dataIds[0x60] = [0, 0x00];
  const updates = [];
  const run = await runOutputTest(conn, 'fuelPump', { confirmed: true, logDir });
  run.on('update', (v) => updates.push(v.effect.sawActive));
  const v = await run.done;
  assert.deepEqual(v.effect.samples.slice(0, 1).map((s) => [s.hex, s.active]), [['00 00', false]], 'the baseline before the start');
  assert.equal(v.effect.sawActive, true);
  assert.ok(v.effect.changes >= 2, 'on, then off again');
  assert.equal(v.effect.samples.at(-1).hex, '00 00');
  assert.match(v.effect.text, /^Fuel pump: 00 00 \(OFF\) -> 00 ff \(ON\) at \+\d\.\d s -> 00 00 \(OFF\) at \+\d\.\d s$/);
  assert.ok(updates.includes(true), 'the page can see it while it runs');
  assert.ok(v.elapsedMs <= WATCH_MS + 1500);
  assert.deepEqual([v.battery.min, v.battery.max], [13.8, 13.8]);
  await conn.disconnect();
});

test('a test with no effect id says there is nothing to watch, and the watch still polls so the ECU stays awake', async () => {
  const { t, conn, logDir } = await connectBike();
  const before = t.requests.length;
  const run = await runOutputTest(conn, 'exhaustValve', { confirmed: true, logDir });
  const v = await run.done;
  assert.match(v.effect.text, /no switch to watch/);
  assert.equal(v.effect.samples.length, 0);
  const polls = t.requests.slice(before).filter((r) => r.service === 0x22);
  assert.ok(polls.length >= 10, `${polls.length} polls of the battery during the watch`);
  assert.ok(polls.every((r) => r.data[2] === 0x07));
  await conn.disconnect();
});

// ---- Disconnect ----------------------------------------------------------------------

test('a disconnect during the idle speed control test ends it and sends its stop; a disconnect during any other test sends nothing', async () => {
  const idle = await connectBike();
  const run = await runOutputTest(idle.conn, 'idleSpeedControl', { confirmed: true, logDir: idle.logDir });
  await idle.conn.disconnect();
  const v = await run.done;
  assert.equal(v.outcome, 'cancelled');
  assert.deepEqual(idle.t.routinesStopped, [0x02]);
  assert.equal(v.stopSent, true);
  assert.deepEqual(idle.conn.runs, []);
  assert.match(logText(idle.logDir), /ended: cancelled/);

  const fan = await connectBike();
  const other = await runOutputTest(fan.conn, 'coolingFan', { confirmed: true, logDir: fan.logDir });
  await fan.conn.disconnect();
  assert.equal((await other.done).outcome, 'cancelled');
  assert.equal(sent(fan.t, 0x32).length, 0);
  assert.equal(sent(fan.t, 0x31).length, 1);
});

test('a lost ECU cancels the test too, and a stop that gets no answer is reported, not resent', async () => {
  const { t, conn, logDir } = await connectBike();
  const run = await runOutputTest(conn, 'idleSpeedControl', { confirmed: true, logDir });
  t.outputTestsSilent = true; // the ECU stops answering the stop
  conn._lose(conn._session);
  const v = await run.done;
  assert.equal(v.outcome, 'cancelled');
  assert.equal(sent(t, 0x32).length, 1, 'one stop, no resend');
  assert.match(v.stopError, /no response/);
  assert.match(logText(logDir), /stop NOT acknowledged/);
  await conn.disconnect();
});

// ---- The log ---------------------------------------------------------------------------

test('every attempt is appended to logs/output-tests-<date>.txt: what, when, the reply and the effect, and refusals too', async () => {
  const { t, conn, logDir } = await connectBike();
  t.dataIds[0x60] = [0, 0x00];
  await refused(runOutputTest(conn, 'fuelPump', { confirmed: false, logDir }), 'not-confirmed');
  const run = await runOutputTest(conn, 'fuelPump', { confirmed: true, logDir });
  const v = await run.done;
  assert.match(path.basename(v.logFile), /^output-tests-1970-01-01\.txt$/, 'dated by the connection clock');
  const lines = logText(logDir).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1970-01-01T\d\d:\d\d:\d\d\.\d{3}Z {2}Fuel pump \(routine 0x04\) {2}REFUSED \(not-confirmed\): /);
  assert.match(lines[1], /Fuel pump \(routine 0x04, confirmed\) {2}sent 31 04 {2}reply 71 04 {2}started; rpm 0, speed 0, battery 13\.8 V$/);
  assert.match(lines[2], /ended: completed after \d\.\d s; effect: Fuel pump: 00 00 \(OFF\) -> 00 ff \(ON\) at \+\d\.\d s -> 00 00 \(OFF\) at \+\d\.\d s; battery 13\.8-13\.8 V$/);
  await cooldown(t, conn);
  const idle = await runOutputTest(conn, 'idleSpeedControl', { confirmed: true, logDir });
  await idle.done;
  assert.match(logText(logDir), /Idle speed control .*; stop sent, reply 72 02/);
  await conn.disconnect();
});

test('an unwritable log does not stop the test and is reported', async () => {
  const { conn } = await connectBike();
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-ot-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const run = await runOutputTest(conn, 'coolingFan', { confirmed: true, logDir: path.join(blocker, 'logs') });
  const v = await run.done;
  assert.equal(v.outcome, 'completed');
  assert.equal(v.logFile, null);
  assert.ok(v.logError);
  await conn.disconnect();
});

// ---- Status ----------------------------------------------------------------------------

test('the status says why the feature is not available: not connected, locked; and is available when unlocked', async () => {
  const { conn, logDir } = await connectBike({ autoUnlock: false });
  const locked = outputTestStatus(conn);
  assert.equal(locked.available, false);
  assert.match(locked.note, LOCKED_NOTE);
  await conn.unlock();
  assert.deepEqual(outputTestStatus(conn), { available: true, note: null, running: false, current: null, cooldownMs: 0 });
  const run = await runOutputTest(conn, 'tachometer', { confirmed: true, logDir });
  assert.equal(outputTestStatus(conn).current.key, 'tachometer');
  await run.done;
  assert.equal(outputTestStatus(conn).current.outcome, 'completed');
  await conn.disconnect();
  assert.deepEqual([outputTestStatus(conn).available, outputTestStatus(conn).note], [false, 'not connected']);
});

// ---- Nothing else can build a start or stop request ---------------------------------

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'logs', 'test', '.git'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('no code outside the runner builds a 0x31 or 0x32 request; the runner does not export the service bytes', () => {
  const root = path.join(__dirname, '..');
  const runner = path.join(root, 'src', 'outputtests.js');
  const building = /\[\s*(0x3[12]|49|50)\s*[,\]]|[:=]\s*0x3[12]\b|\bSVC\.\w+\s*[,\]]\s*(?=.*0x3[12])/;
  const offenders = sourceFiles(root).filter((f) => f !== runner && building.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
  assert.ok(sourceFiles(root).length > 15, 'the walk found the source tree');
  assert.ok(building.test('const r = [0x31, 6];') && building.test('x = [0x32, b]') && building.test('SERVICE = 0x31'), 'the pattern catches what it should');
  const text = fs.readFileSync(runner, 'utf8');
  assert.equal((text.match(/session\.request\(/g) ?? []).length, 2, 'the runner has exactly the start and the stop request');
  assert.deepEqual(Object.keys(outputtests).filter((k) => /^(SERVICE|START|STOP)/i.test(k)), []);
});
