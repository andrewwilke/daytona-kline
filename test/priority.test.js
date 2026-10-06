'use strict';

// The session's line lock: ordinary requests go first, background ones (the switch watcher's) wait
// behind them unless they have waited long enough, and nothing is left held afterwards.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { MockEcuTransport } = require('./mockecu');

async function connectedSession() {
  const t = new MockEcuTransport({ target: 0xd5, iso9141: true });
  const conn = new Connection({
    configPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-prio-')), 'config.json'),
    openTransport: async () => t,
    clock: t.clock,
    keepAliveMs: 60_000,
  });
  await conn.connect({ port: 'MOCK' });
  return { t, conn, session: conn.requireSession() };
}

const pid = (n) => [0x01, n];
/** The PIDs the ECU was asked after request number `from`, in order. */
const asked = (t, from) => t.requests.slice(from).filter((r) => r.service === 0x01 && r.data[1] !== 0x00).map((r) => r.data[1]);

test('an ordinary request queued after a background one is served first, background ones keep their order', async () => {
  const { t, conn, session } = await connectedSession();
  session.backgroundAgeMs = 1e9; // never promoted in this test
  const from = t.requests.length;
  const held = session.request(pid(0x0c)); // takes the line at once
  const b1 = session.request(pid(0x05), { background: true });
  const b2 = session.request(pid(0x0f), { background: true });
  const o1 = session.request(pid(0x11));
  const o2 = session.request(pid(0x0b));
  await Promise.all([held, b1, b2, o1, o2]);
  assert.deepEqual(asked(t, from), [0x0c, 0x11, 0x0b, 0x05, 0x0f]);
  await conn.disconnect();
});

test('a background request that has waited longer than backgroundAgeMs goes before a later ordinary one', async () => {
  const { t, conn, session } = await connectedSession();
  session.backgroundAgeMs = 0; // any wait is long enough
  const from = t.requests.length;
  const held = session.request(pid(0x0c));
  const b = session.request(pid(0x05), { background: true });
  const o = session.request(pid(0x11));
  await Promise.all([held, b, o]);
  assert.deepEqual(asked(t, from), [0x0c, 0x05, 0x11]);
  await conn.disconnect();
});

test('ordinary requests keep their order, and the line is free again afterwards', async () => {
  const { t, conn, session } = await connectedSession();
  const from = t.requests.length;
  const order = [0x0c, 0x11, 0x0b, 0x05, 0x0f];
  await Promise.all(order.map((n) => session.request(pid(n))));
  assert.deepEqual(asked(t, from), order);
  assert.equal(session.busy, false);
  assert.equal(session._held, false);
  assert.equal(session._waiters.length, 0);
  // and it still works: a lone background request takes the free line at once
  const r = await session.request(pid(0x05), { background: true });
  assert.ok(r.payload.length);
  assert.equal(session.busy, false);
  await conn.disconnect();
});

test('a failing request releases the line to the next one', async () => {
  const { t, conn, session } = await connectedSession();
  delete t.pids[0x0e];
  const bad = session.request(pid(0x0e), { timeout: 50, retries: 0 }).catch((e) => e);
  const good = session.request(pid(0x0c));
  assert.ok((await bad) instanceof Error);
  assert.ok((await good).payload.length);
  assert.equal(session.busy, false);
  await conn.disconnect();
});
