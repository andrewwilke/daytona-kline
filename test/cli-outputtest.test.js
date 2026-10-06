'use strict';

// The CLI's outputtest command and the raw send command's refusals (see also outputtests.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../cli');
const { Connection } = require('../src/connection');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const KEYS = ['tachometer', 'coolingFan', 'fuelPump', 'idleSpeedControl', 'purgeValve', 'secondaryAir', 'airFlap', 'exhaustValve'];
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-cli-ot-'));

/** Run a CLI command against `mock`; resolves with what it printed and how many connections it made. */
async function run(command, args, mock, { unlockFile = null } = {}) {
  let connections = 0;
  cli.use({
    connection: (cliArgs) => {
      connections++;
      const dir = scratch();
      if (unlockFile) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify(unlockFile));
      return new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => mock, clock: mock.clock, keepAliveMs: 60_000, autoUnlock: !cliArgs['no-unlock'] });
    },
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
  let error = null;
  try {
    await cli.COMMANDS[command]({ _: [], port: 'MOCK', ...args });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { text: printed.join(''), connections, error };
}

const stoppedMock = (options) => {
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M, ...options });
  t.pids[0x0c] = [0, 0];
  return t;
};
const unlock = { unlockFile: { multiplier: M } };
const commanded = (t) => t.requests.filter((r) => r.service === 0x31 || r.service === 0x32);

test('outputtest list prints the whitelist with what to see and the safety notes, and connects to nothing', async () => {
  const t = stoppedMock();
  const r = await run('outputtest', { _: ['list'] }, t, unlock);
  assert.equal(r.error, null);
  assert.equal(r.connections, 0);
  for (const key of KEYS) assert.match(r.text, new RegExp(`^ {2}${key} `, 'm'), key);
  assert.match(r.text, /you should see: The fan spins\./);
  assert.match(r.text, /safety: Keep hands, tools and cables clear of the fan/);
  assert.match(r.text, /safety: Only with fuel in the tank/);
  assert.match(r.text, /safety: Keep hands and cables clear of the servo/);
  assert.match(r.text, /not yet confirmed on a bike/);
  assert.equal(t.events.length, 0, 'the port was never opened');
});

test('outputtest without --yes says what would happen and the preconditions, and sends nothing', async () => {
  const t = stoppedMock();
  const r = await run('outputtest', { _: ['coolingFan'] }, t, unlock);
  assert.equal(r.error, null);
  assert.equal(r.connections, 0);
  assert.match(r.text, /Cooling fan \(coolingFan\): confirmed/);
  assert.match(r.text, /You should see: The fan spins\./);
  assert.match(r.text, /Safety: Keep hands, tools and cables clear of the fan/);
  assert.match(r.text, /Nothing was sent\./);
  assert.match(r.text, /Preconditions \(checked before anything is sent\):\n {2}- the ECU is unlocked\n {2}- the bike is stationary \(speed 0\) and the engine is off \(rpm 0\), with the key on\n {2}- the battery is at least 10\.5 V/);
  assert.match(r.text, /Re-run with --yes/);
  assert.equal(t.events.length, 0);
});

test('outputtest with an unknown key, or none, refuses and lists the whitelist', async () => {
  for (const key of ['bogus', 'adjustExhaustValve', 'injector1', 'fuelpump', '06']) {
    const t = stoppedMock();
    const r = await run('outputtest', { _: [key], yes: true }, t, unlock);
    assert.match(r.error.message, /unknown output test/, key);
    assert.match(r.text, /is not an output test this tool can run\. The only ones:/);
    for (const k of KEYS) assert.match(r.text, new RegExp(`^ {2}${k} `, 'm'));
    assert.equal(r.connections, 0, key);
    assert.equal(t.events.length, 0);
  }
  const none = await run('outputtest', { _: [] }, stoppedMock(), unlock);
  assert.equal(none.error, null);
  assert.match(none.text, /Usage: node cli\.js outputtest <key\|list> --yes/);
  assert.equal(none.connections, 0);
});

test('outputtest --yes while locked or without the unlock says "needs the ECU unlock, not available" and sends nothing', async () => {
  for (const [mock, files, extra] of [[stoppedMock(), unlock, { 'no-unlock': true }], [stoppedMock(), {}, {}]]) {
    const r = await run('outputtest', { _: ['fuelPump'], yes: true, ...extra }, mock, files);
    assert.equal(r.error, null);
    assert.match(r.text, /outputtest: needs the ECU unlock, not available \(/);
    assert.equal(commanded(mock).length, 0);
    assert.equal(mock.requests.filter((q) => q.service === 0x22).length, 0);
  }
});

test('outputtest --yes runs the test, shows the effect as it changes and where it was logged', async () => {
  const t = stoppedMock();
  t.dataIds[0x60] = [0, 0x00];
  const logDir = path.join(scratch(), 'logs');
  const r = await run('outputtest', { _: ['fuelPump'], yes: true, 'log-dir': logDir }, t, unlock);
  assert.equal(r.error, null);
  assert.match(r.text, /ECU unlock: unlocked/);
  assert.match(r.text, /ECU answered 71 04: the test is running\. Watching for 8 s at most\./);
  assert.match(r.text, /\[\+0\.0 s\] Fuel pump: 00 00 \(off\)/);
  assert.match(r.text, /\[\+\d\.\d s\] Fuel pump: 00 ff \(on\)/);
  assert.match(r.text, /Test completed after \d\.\d s\. Effect: Fuel pump: 00 00 \(OFF\) -> 00 ff \(ON\)/);
  assert.match(r.text, /Logged to .*output-tests-.*\.txt/);
  assert.deepEqual(commanded(t).map((q) => q.data), [[0x31, 0x04]]);
  assert.ok(fs.readdirSync(logDir).some((f) => /^output-tests-/.test(f)));
});

test('outputtest --yes on the idle speed control sends and reports its stop', async () => {
  const t = stoppedMock();
  const r = await run('outputtest', { _: ['idleSpeedControl'], yes: true, 'log-dir': scratch() }, t, unlock);
  assert.equal(r.error, null);
  assert.match(r.text, /Watching for 15 s at most\./);
  assert.match(r.text, /Stop sent, the ECU answered 72 02\./);
  assert.deepEqual(commanded(t).map((q) => q.data), [[0x31, 0x02], [0x32, 0x02]]);
});

test('outputtest --yes with the engine running, a low battery, a refusal or silence ends with an error and the reason', async () => {
  const running = new MockEcuTransport({ iso9141: true, unlockMultiplier: M }); // the default mock is at 4000 rpm
  const a = await run('outputtest', { _: ['coolingFan'], yes: true, 'log-dir': scratch() }, running, unlock);
  assert.match(a.error.message, /the engine is running \(4000 rpm\)/);
  assert.equal(commanded(running).length, 0);

  const flat = stoppedMock();
  flat.dataIds[0x07] = [0, 100];
  const b = await run('outputtest', { _: ['coolingFan'], yes: true, 'log-dir': scratch() }, flat, unlock);
  assert.match(b.error.message, /battery is at 10 V, below 10\.5 V/);
  assert.equal(commanded(flat).length, 0);

  const refusing = stoppedMock();
  refusing.outputTestsRefuse = 0x22;
  const c = await run('outputtest', { _: ['coolingFan'], yes: true, 'log-dir': scratch() }, refusing, unlock);
  assert.match(c.error.message, /the ECU refused the test \(negative response, code 0x22\)/);
  assert.equal(commanded(refusing).length, 1);

  const silent = stoppedMock();
  silent.outputTestsSilent = true;
  const d = await run('outputtest', { _: ['coolingFan'], yes: true, 'log-dir': scratch() }, silent, unlock);
  assert.match(d.error.message, /no answer from the ECU/);
  assert.equal(commanded(silent).length, 1);
});

test('outputtest warns on a low battery and goes ahead', async () => {
  const t = stoppedMock();
  t.dataIds[0x07] = [0, 110];
  const r = await run('outputtest', { _: ['tachometer'], yes: true, 'log-dir': scratch() }, t, unlock);
  assert.equal(r.error, null);
  assert.match(r.text, /WARNING: battery 11 V is low: the ECU may reset during the test/);
  assert.match(r.text, /Effect: no switch to watch for this test/);
});

test('the raw send command refuses the output test services, security access and everything else that is not a read, before connecting', async () => {
  for (const payload of ['31 06', '32 02', '0x31 04', '27 05', '27 06 12 34', '04', '14 00 00', '10 80', '2e 00 41 00', '34', '3d', '81', '82', 'ff']) {
    const t = stoppedMock();
    const r = await run('send', { _: [payload] }, t, unlock);
    assert.match(r.error?.message ?? '', /send only sends reads .* refused and nothing was sent/, payload);
    assert.equal(r.connections, 0, payload);
    assert.equal(t.requests.length, 0, payload);
    assert.equal(t.events.length, 0, payload);
  }
  const a = await run('send', { _: ['31 06'] }, stoppedMock(), unlock);
  assert.match(a.error.message, /service 0x31 is refused .*output tests are only run by the outputtest command/);
  const b = await run('send', { _: ['04'] }, stoppedMock(), unlock);
  assert.match(b.error.message, /cleardtc --yes erases codes/);
});

test('the raw send command still sends reads', async () => {
  for (const [payload, reply] of [['01 0c', 'response: 41 0c 00 00'], ['01 00', /^response: 41 00 /m], ['22 00 07', 'response: 62 00 07 00 8a'], ['3e', null]]) {
    const t = stoppedMock();
    const r = await run('send', { _: [payload] }, t, unlock);
    if (payload === '3e') {
      assert.match(r.error.message, /negative response|no response/, 'the mock does not answer TesterPresent: an error, but it was sent');
      assert.equal(t.requests.at(-1).service, 0x3e);
      continue;
    }
    assert.equal(r.error, null, payload);
    if (typeof reply === 'string') assert.ok(r.text.includes(reply), `${payload}: ${r.text}`);
    else assert.match(r.text, reply);
  }
});
