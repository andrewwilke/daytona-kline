'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../cli');
const { Connection } = require('../src/connection');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-cli-'));
// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run a CLI command against `mock`; resolves with everything it printed (stdout and stderr). */
async function run(command, args, mock, { unlockFile = null } = {}) {
  const made = [];
  cli.use({
    connection: (cliArgs) => {
      const dir = scratch();
      if (unlockFile) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify(unlockFile));
      const conn = new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => mock, clock: mock.clock, keepAliveMs: 60_000, autoUnlock: !cliArgs['no-unlock'] });
      made.push(conn);
      return conn;
    },
  });
  const printed = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  // The test runner reports to the same stream in binary: only the CLI's own text is taken.
  const take = (original) => function write(chunk, ...rest) {
    if (typeof chunk !== 'string') return original.call(this, chunk, ...rest);
    printed.push(chunk);
    return true;
  };
  process.stdout.write = take(out);
  process.stderr.write = take(err);
  try {
    await cli.COMMANDS[command]({ _: [], port: 'MOCK', ...args });
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { text: printed.join(''), connections: made.length };
}

test('gauges prints one line per gauge and a status line, redrawing in place, and records a CSV', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  const csv = path.join(scratch(), 'gauges.csv');
  const { text } = await run('gauges', { cycles: '10', log: csv }, t);

  assert.match(text, /slow init 0x33, try 1\/6\.\.\./);
  assert.match(text, /Connected to ECU 0x33 by slow init \(key bytes: 08 08\)/);
  const frames = text.split(/\x1b\[13A/); // the cursor goes back up over the 13 lines of the last frame
  assert.equal(frames.length, 10, 'one frame per reading, each redrawn over the last');
  const last = plain(frames.at(-1)).split('\n').filter(Boolean);
  assert.equal(last.length, 13);
  const line = (label) => last.find((l) => l.startsWith(label));
  assert.match(line('Engine'), /^Engine\s+4000 rpm \?$/);
  assert.match(line('Speed'), /^Speed\s+0 mph \?$/);
  assert.match(line('Throttle'), /^Throttle\s+50\.2 % \?$/);
  assert.match(line('Manifold pressure'), /^Manifold pressure\s+1010 hPa \?$/);
  assert.match(line('Coolant'), /^Coolant\s+90 °C \?$/);
  assert.match(line('Intake air'), /^Intake air\s+22 °C \?$/);
  assert.match(line('Engine load'), /^Engine load\s+40 % \?$/);
  assert.match(line('Timing advance'), /^Timing advance\s+12 ° \?$/);
  assert.match(line('Short-term fuel trim'), /^Short-term fuel trim\s+0 % \?$/);
  assert.match(line('Fuel system'), /^Fuel system\s+closed loop \?$/);
  assert.match(line('Battery'), /^Battery\s+needs the ECU unlock$/);
  assert.match(line('Gear'), /^Gear\s+needs the ECU unlock$/);
  assert.equal(last.at(-1), 'cycle 10   ECU serves PIDs: 01 03 04 05 06 0b 0c 0d 0e 0f 11 14 1c');
  assert.ok(!frames[0].includes('\x1b[13A'));
  assert.match(text, /ECU unlock: off \(no unlock file at /, 'the unlock state is printed after connecting');

  const rows = fs.readFileSync(csv, 'utf8').trim().split('\n');
  assert.equal(rows[0], 'time,rpm,speed,tps,map,coolant,airtemp,load,timing,trim,fuelSystem,battery,gear,raw');
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.at(-1).split(',').slice(1, 13), ['4000', '0', '50.2', '1010', '90', '22', '40', '12', '0', '2', '', '']);
  assert.equal(t.requests.filter((r) => r.service === 0x22).length, 0, 'locked: no 0x22 request');
});

test('gauges on an unlocked ECU show battery and gear too', async () => {
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  const { text } = await run('gauges', { cycles: '12' }, t, { unlockFile: { multiplier: M } });
  assert.match(text, /ECU unlock: unlocked/);
  const last = plain(text.split(/\x1b\[13A/).at(-1)).split('\n').filter(Boolean);
  assert.match(last.find((l) => l.startsWith('Battery')), /^Battery\s+13\.8 V \?$/);
  assert.match(last.find((l) => l.startsWith('Gear')), /^Gear\s+4 \?$/);
  assert.ok(!last.some((l) => /needs the ECU unlock/.test(l)));
});

test('gauges shows "not available" for a PID the ECU does not serve and "..." until a gauge is first read', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  delete t.pids[0x0e];
  const { text } = await run('gauges', { cycles: '1' }, t);
  const last = plain(text).split('\n');
  assert.ok(last.some((l) => /^Timing advance\s+not available$/.test(l)));
  assert.ok(last.some((l) => /^Coolant\s+\.\.\.$/.test(l)), 'the slow gauge whose turn has not come yet');
  assert.ok(last.some((l) => /^Engine\s+4000 rpm \?$/.test(l)));
});

test('dtc prints the warning light, compares the ECU\'s code count with the codes read, and says mode 07 is not served', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  const { text } = await run('dtc', {}, t);
  assert.match(text, /Warning light \(MIL\): ON/);
  assert.match(text, /Warning light ON; the ECU reports 2 stored codes and 2 were read\./);
  assert.match(text, /Fault codes read: 2/);
  assert.match(text, /P0078 {2}\(stored\) {2}Exhaust valve actuator circuit/);
  assert.match(text, /P1108 {2}\(stored\)\n/);
  assert.match(text, /Pending codes \(mode 07\): not supported by this ECU\./);

  t.storedCodes = [0x0078];
  assert.match((await run('dtc', {}, t)).text, /reports 2 stored codes but 1 was read: the list may be incomplete/);
});

test('cleardtc without --yes connects to nothing; with --yes it sends mode 04', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  t.modes[0x04] = () => {
    t.storedCodes = [];
    return [0x44];
  };
  const no = await run('cleardtc', {}, t);
  assert.match(no.text, /Re-run with --yes to confirm/);
  assert.equal(no.connections, 0);
  assert.equal(t.requests.length, 0);

  const yes = await run('cleardtc', { yes: true }, t);
  assert.match(yes.text, /Fault codes cleared\./);
  assert.deepEqual(t.requests.filter((r) => r.service === 0x04).map((r) => r.data), [[0x04]]);
});


// ---- The ECU unlock: the commands that need it ---------------------------------

const lockedMock = () => new MockEcuTransport({ iso9141: true });
const unlockableMock = () => {
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  t.modes[0x1a] = (option) => (option === 0x80 ? [0x5a, 0x80, ...Buffer.from('T675-KEIHIN')] : [0x7f, 0x1a, 0x12]);
  return t;
};
const unlockFile = { unlockFile: { multiplier: M } };
const NEEDS = (command) => new RegExp(`${command}: needs the ECU unlock, not available`);

test('connecting prints how the unlock stands: off, unlocked, failed, unusable, or skipped with --no-unlock', async () => {
  const off = await run('scan', {}, lockedMock());
  assert.match(off.text, /ECU unlock: off \(no unlock file at /);

  const t = unlockableMock();
  assert.match((await run('scan', {}, t, unlockFile)).text, /ECU unlock: unlocked \(switches, battery, gear, sensor block and identity can be read\)/);
  assert.equal(t.keyAttempts, 1);

  const wrong = unlockableMock();
  const failed = await run('scan', {}, wrong, { unlockFile: { multiplier: M + 1 } });
  assert.match(failed.text, /ECU unlock: failed \(the ECU refused the key \(code 0x35\)\); the reads that need it stay off/);
  assert.equal(wrong.keyAttempts, 1, 'one key, never retried');

  const bad = await run('scan', {}, unlockableMock(), { unlockFile: { multiplier: 'abc' } });
  assert.match(bad.text, /ECU unlock: not used, "multiplier" in .* must be a whole number from 1 to 65535/);

  const skipped = unlockableMock();
  const no = await run('scan', { 'no-unlock': true }, skipped, unlockFile);
  assert.match(no.text, /ECU unlock: not tried \(--no-unlock\)/);
  assert.equal(skipped.requests.filter((r) => r.service === 0x27).length, 0, '--no-unlock sends no security access request');
});

test('switches say they need the ECU unlock while locked, and ask the ECU for no switch', async () => {
  for (const [mock, options, args] of [[lockedMock(), {}, {}], [unlockableMock(), unlockFile, { 'no-unlock': true }], [unlockableMock(), { unlockFile: { multiplier: M + 1 } }, {}]]) {
    const r = await run('switches', args, mock, options);
    assert.match(r.text, NEEDS('switches'));
    assert.equal(r.connections, 1);
    assert.equal(mock.requests.filter((q) => q.service === 0x22).length, 0);
  }
});

test('switches work once unlocked and highlight what changes', async () => {
  const t = unlockableMock();
  const { text } = await run('switches', { cycles: '4' }, t, unlockFile);
  assert.doesNotMatch(text, /needs the ECU unlock, not available/);
  const last = plain(text.split('\x1b[2J\x1b[H').at(-1));
  assert.match(last, /0x0041=/);
  assert.match(last, /0x0060=/);
  assert.match(text, /\x1b\[1;33m0x0041=/, 'the clutch flips on every read, so it is highlighted');
  assert.match(last, /changed so far: 0x0041, 0x0060/);
  assert.match(last, /0x0042=00 ff {3}Sidestand {19}DOWN(?!\s*\?)/m, 'the sidestand (00 ff = stand down) is named and confirmed, so no ?');
  assert.doesNotMatch(last, /0x0061|0x0063|0x0068/, 'the table ids the mock never serves are not printed');
  assert.ok(!t.requests.some((r) => r.service === 0x27 && r.data[1] !== 0x05 && r.data[1] !== 0x06), 'only levels 05 and 06 ever sent');
});

test('the advanced sensor block commands need the unlock; unlocked, an ECU that does not serve the block is explained', async () => {
  const locked = lockedMock();
  for (const command of ['live', 'watch']) {
    const r = await run(command, { interval: '1', cycles: '1' }, locked);
    assert.match(r.text, NEEDS(command));
  }
  assert.equal(locked.requests.filter((r) => r.service === 0x21).length, 0);

  const t = unlockableMock();
  await assert.rejects(() => run('live', { interval: '1' }, t, unlockFile), /no response to \[21 80\]\. The ECU is unlocked but did not serve this advanced read/);
});

test('probe needs the unlock; unlocked on the bike it stops early and says so', async () => {
  const locked = lockedMock();
  const r = await run('probe', {}, locked);
  assert.match(r.text, NEEDS('probe'));
  assert.doesNotMatch(r.text, /Supported data blocks/);
  assert.equal(locked.requests.filter((q) => q.service === 0x21).length, 0);

  const { text } = await run('probe', {}, unlockableMock(), unlockFile);
  assert.match(text, /Probe stopped early: not available: the ECU served none of the first 8 block ids, even unlocked/);
  assert.doesNotMatch(text, /Supported data blocks/);
});

test('id needs the unlock and sends nothing while locked', async () => {
  const t = lockedMock();
  const { text } = await run('id', {}, t);
  assert.match(text, NEEDS('id'));
  assert.equal(t.requests.filter((r) => r.service === 0x1a).length, 0);
});

test('id on an unlocked ECU prints what it answers, or says it accepted no option', async () => {
  const { text } = await run('id', {}, unlockableMock(), unlockFile);
  assert.match(text, /option 0x80: {2}T675-KEIHIN/);

  const silent = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  const quiet = await run('id', {}, silent, unlockFile);
  assert.match(quiet.text, /ECU accepted no ReadEcuIdentification options\./);
  assert.equal(silent.requests.filter((r) => r.service === 0x1a).length, 3, 'it gives up after three silent options');
});

test('there is no command that writes, programs or flashes (the output tests are the one command that drives anything)', () => {
  assert.deepEqual(Object.keys(cli.COMMANDS).sort(), ['cleardtc', 'discover', 'dtc', 'gauges', 'id', 'live', 'outputtest', 'ports', 'probe', 'record', 'scan', 'send', 'snapshot', 'switches', 'watch']);
});
