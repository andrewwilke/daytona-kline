'use strict';

// What the CLI shares with the GUI server: the "first reads all fail, so stop" rule of a run, the bike a
// connection carries, the no-switch wording and plain-ASCII scan messages.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../cli');
const { Connection } = require('../src/connection');
const { DEFAULT_BIKE } = require('../src/bikes');
const { SWITCHES_NOTE } = require('../src/runs');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-cli-shared-'));

/** Run a CLI command against `mock`; resolves with what it printed, the connections made and any error thrown. */
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
  return { text: printed.join(''), connections: made.length, made, error };
}

test('scan prints plain ASCII for its session and config messages', async () => {
  const iso = await run('scan', {}, new MockEcuTransport({ iso9141: true }));
  assert.match(iso.text, /Saved to config\.json; future commands will use this automatically\./);
  assert.ok(!/[^\x00-\x7f]/.test(iso.text), 'no stray non-ASCII characters in the scan output');
});

test('a run whose first reads all fail stops by itself with the ECU error (the run\'s own failingFromStart rule)', async () => {
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  // The mock does not serve the sensor block (service 0x21): every read of it fails.
  const r = await run('live', { cycles: '50' }, t, { unlockFile: { multiplier: M } });
  assert.ok(r.error, 'the command ends with an error instead of polling forever');
  assert.ok(r.error.message.length > 0);
  const reads = t.requests.filter((q) => q.service === 0x21).length;
  assert.ok(reads >= 3 && reads <= 8, `the run gave up after its first three failed reads (${reads} requests sent)`);
});

test('a connection made by the CLI carries the CLI\'s bike, and switches with no switch ids use the shared wording', async () => {
  const r = await run('scan', {}, new MockEcuTransport({ iso9141: true }));
  assert.equal(r.made[0].bike, DEFAULT_BIKE);

  const saved = DEFAULT_BIKE.switchIds;
  Object.defineProperty(DEFAULT_BIKE, 'switchIds', { value: [], configurable: true });
  try {
    const none = await run('switches', {}, new MockEcuTransport({ iso9141: true }));
    assert.equal(none.error, null);
    assert.equal(none.connections, 0, 'nothing to poll: nothing connected');
    assert.ok(none.text.includes(SWITCHES_NOTE), none.text);
  } finally {
    Object.defineProperty(DEFAULT_BIKE, 'switchIds', { value: saved, configurable: true });
  }
});
