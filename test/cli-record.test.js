'use strict';

// The CLI's record, discover and snapshot commands and the named switches view (see also cli.test.js).

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

/**
 * Run a CLI command against `mock`; resolves with everything it printed. `lines` is how the console's
 * typed lines arrive (a function taking the handler), `enter` what waiting for Enter does.
 */
async function run(command, args, mock, { unlockFile = null, lines = () => () => {}, enter = async () => {} } = {}) {
  cli.use({
    connection: (cliArgs) => {
      const dir = scratch();
      if (unlockFile) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify(unlockFile));
      return new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => mock, clock: mock.clock, keepAliveMs: 60_000, autoUnlock: !cliArgs['no-unlock'] });
    },
    lines,
    enter,
  });
  const printed = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
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
  return { text: plain(printed.join('')), raw: printed.join('') };
}

const lockedMock = () => new MockEcuTransport({ iso9141: true });
const unlockableMock = () => new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
const unlock = { unlockFile: { multiplier: M } };
const NEEDS = (command) => new RegExp(`${command}: needs the ECU unlock, not available`);
const services = (t) => new Set(t.requests.map((r) => r.service));

// ---- record ----------------------------------------------------------------------

test('record writes the CSV, prints events and notes as they happen, takes typed lines as markers and ends with a summary', async () => {
  const t = unlockableMock();
  t.dataIds[0x100] = [0x3e, 0x80]; // the ECU's own engine speed (the every-cycle rpm source): raw 16000 * 0.25 = 4000 rpm, as the mock's OBD rpm
  const logDir = path.join(scratch(), 'logs');
  const { text } = await run('record', { minutes: '0.1', 'log-dir': logDir }, t, {
    ...unlock,
    lines: (onLine) => {
      onLine('Cranking'); // typed at once
      return () => {};
    },
  });

  assert.match(text, /Recording to .*record-.*\.csv \(stops after 0\.1 min\)\. Ctrl\+C to stop earlier\./);
  assert.match(text, /Type a note and press Enter to mark the moment/);
  assert.match(text, /\[0:00\.0\] mark: Cranking/);
  assert.match(text, /\[\d:\d\d\.\d\] fuel pump OFF while running/, 'the mock\'s pump flag flips on every read');
  assert.match(text, /rpm 4000 {3}battery 13\.8 V {3}pump (ON|off) {3}relay ON {3}start off {3}\d+ samples/, 'the status line');
  assert.match(text, /Recording ended after \d:\d\d\.\d: \d+ samples in .*record-.*\.csv/);
  assert.match(text, /time limit of 0\.1 minutes reached/);
  assert.match(text, /Battery: lowest 13\.8 V, highest 13\.8 V/);
  assert.match(text, /Events:\n( {4}\[\d:\d\d\.\d\] .+\n)+/);
  assert.doesNotMatch(text, /needs the ECU unlock/);

  const file = fs.readdirSync(logDir).find((f) => /^record-.*\.csv$/.test(f));
  const rows = fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n');
  assert.ok(rows[0].startsWith('t_ms,cycle_ms,rpm,'));
  assert.ok(rows.some((r) => r.includes(',Cranking,')), 'the typed line is in the marker column');
  assert.deepEqual([...services(t)].filter((s) => s !== 0x27).sort(), [0x01, 0x22], 'only reads');
});

test('record while locked says what is skipped and records the OBD values only', async () => {
  const t = lockedMock();
  const logDir = path.join(scratch(), 'logs');
  const { text } = await run('record', { minutes: '0.05', 'log-dir': logDir }, t);
  assert.match(text, /needs the ECU unlock, not available \(.*\): battery, switch flags and analog values are skipped, only the OBD values are recorded\./);
  assert.match(text, /rpm 4000 {3}battery n\/a {3}pump \? {3}relay \? {3}start \?/);
  assert.match(text, /Battery: not read \(needs the ECU unlock\)/);
  assert.match(text, /Skipped, needs the ECU unlock, not available \(.*\): battery, gear, neutral/);
  assert.equal(t.requests.filter((r) => r.service === 0x22).length, 0);
  assert.ok(fs.readdirSync(logDir).some((f) => f.endsWith('.csv')));
});

test('record needs a sensible --minutes and connects to nothing otherwise', async () => {
  const t = unlockableMock();
  for (const minutes of ['0', 'abc', '-3', true]) {
    await assert.rejects(() => run('record', { minutes }, t, unlock), /--minutes needs a number above 0/, String(minutes));
  }
  assert.equal(t.requests.length, 0);
});

// ---- discover and snapshot ---------------------------------------------------------

test('discover lists the ids the ECU answers with their bytes and names, and where the result was saved', async () => {
  const t = unlockableMock();
  const logDir = path.join(scratch(), 'logs');
  const { text } = await run('discover', { from: '0', to: '30', 'log-dir': logDir }, t, unlock);
  assert.match(text, /asking service 0x22 for ids 0x0000\.\.0x0030 \(read-only, nothing else is sent\)/);
  assert.match(text, /Asked 49 of 49 id\(s\) in \d+ s: 6 answered, 43 refused, 0 silent\./);
  assert.match(text, /0x0007 +138 +00 8a +Battery/);
  assert.match(text, /0x0010 +4660 +12 34$/m, 'an id the bike does not name has no name');
  assert.match(text, /0x0028 +512 +02 00 +Rollover \(tip-over\) switch/);
  const saved = text.match(/Saved to (.*discovered-ids-.*\.json)/)[1];
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).served, 6);
  assert.ok(t.requests.filter((r) => r.service === 0x22).every((r) => r.data.length === 3), 'only 22 hi lo');
});

test('discover --extended sweeps 0x0100..0x03ff', async () => {
  const t = unlockableMock();
  const { text } = await run('discover', { extended: true, to: '130', 'log-dir': scratch() }, t, unlock);
  assert.match(text, /ids 0x0100\.\.0x0130/);
  assert.match(text, /0x0123 +1 +00 01/);
});

test('discover needs the unlock and a sensible range; locked it sends nothing', async () => {
  const locked = lockedMock();
  const r = await run('discover', {}, locked);
  assert.match(r.text, NEEDS('discover'));
  assert.equal(locked.requests.filter((q) => q.service === 0x22).length, 0);
  for (const range of [{ from: 'zz' }, { from: '20', to: '10' }, { to: '10000' }, { from: true }]) {
    await assert.rejects(() => run('discover', range, unlockableMock(), unlock), /--from and --to need hex ids/, JSON.stringify(range));
  }
});

test('snapshot reads the ids, waits for Enter, reads them again and prints what changed', async () => {
  const t = unlockableMock();
  let prompt = null;
  const { text } = await run('snapshot', { ids: '10,11,99' }, t, {
    ...unlock,
    enter: async (p) => {
      prompt = p;
      t.dataIds[0x10] = [0xff, 0xff]; // the thing that was done to the bike
    },
  });
  assert.match(prompt, /lift the sidestand, flip the kill switch, tilt the bike.*press Enter for snapshot B/);
  assert.match(text, /Snapshot A: reading 3 id\(s\)/);
  assert.match(text, /Snapshot A taken: 2 id\(s\) answered\./);
  assert.match(text, /Snapshot B taken: 2 id\(s\) answered\./);
  assert.match(text, /1 id\(s\) changed:\n {2}0x0010 {2}\(not named\) +12 34 {2}->  ff ff/);
  assert.doesNotMatch(text, /0x0011 {2}\(/, 'the one that did not change is not listed');
});

test('snapshot without --ids sweeps the range first, and names the ids it knows', async () => {
  const t = unlockableMock();
  const { text } = await run('snapshot', { from: '0', to: '30', 'log-dir': scratch() }, t, {
    ...unlock,
    enter: async () => {
      t.dataIds[0x28] = [3, 0xff];
      t.dataIds[0x21] = [0, 16];
    },
  });
  assert.match(text, /Snapshot A: asking every id 0x0000\.\.0x0030/);
  assert.match(text, /Snapshot A taken: 6 id\(s\) answered\./);
  assert.match(text, /2 id\(s\) changed:/);
  assert.match(text, /0x0021 {2}Gear +00 08 {2}-> {2}00 10/);
  assert.match(text, /0x0028 {2}Rollover \(tip-over\) switch +02 00 {2}-> {2}03 ff/);
});

test('snapshot says when nothing changed, needs the unlock and takes no Enter while locked', async () => {
  const t = unlockableMock();
  const same = await run('snapshot', { ids: '10' }, t, unlock);
  assert.match(same.text, /No id changed between A and B\./);

  let asked = false;
  const locked = lockedMock();
  const r = await run('snapshot', { ids: '10' }, locked, { enter: async () => { asked = true; } });
  assert.match(r.text, NEEDS('snapshot'));
  assert.equal(asked, false);
  assert.equal(locked.requests.filter((q) => q.service === 0x22).length, 0);
  await assert.rejects(() => run('snapshot', { ids: 'zz' }, unlockableMock(), unlock), /--ids needs hex ids/);
});

// ---- switches, named ------------------------------------------------------------

test('switches print the names and states, a ? on the labels nobody has confirmed, and the id alone for an id the table does not name', async () => {
  const t = unlockableMock();
  const { raw } = await run('switches', { cycles: '2' }, t, unlock);
  const last = plain(raw.split('\x1b[2J\x1b[H').at(-1));
  assert.match(last, /0x0040=00 00 +Neutral +IN NEUTRAL$/m, 'consistent labels carry no ?');
  assert.match(last, /0x0046=00 00 +Start switch +RELEASED$/m, 'a confirmed label is plain');
  assert.match(last, /0x0042=00 ff +Sidestand +DOWN$/m, 'named by the owner (00 ff is down), confirmed: no ?');
  assert.match(last, /0x0044=00 ff +Dash alive \(flag 0x44\) +DASH ON \?$/m, 'an unconfirmed label carries the ?');
  assert.match(last, /0x0066=00 ff +Secondary air \(SAI\) +OFF \?$/m, 'an inverted id: ff is off');
  assert.match(last, /0x0069=00 ff +Main relay +ON$/m);

  const some = await run('switches', { cycles: '1', ids: '10,41' }, unlockableMock(), unlock);
  assert.match(some.text, /0x0010=12 34 *$/m);
  assert.match(some.text, /0x0041=00 f[ef] +Clutch +RELEASED$/m);
});
