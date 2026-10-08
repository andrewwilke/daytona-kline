'use strict';

// The session's line lock, seen only through its interface: ordinary requests go first, background
// ones (the switch watcher's) wait behind them unless they have waited long enough, hold() keeps
// everyone else off the line, and nothing is left taken afterwards. What the mock ECU is asked, and
// in what order, is the evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { PRIORITY } = require('../src/kwp');
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
  session.setBackgroundWaitMs(1e9); // never promoted in this test
  const from = t.requests.length;
  const first = session.request(pid(0x0c)); // takes the line at once
  const b1 = session.request(pid(0x05), { background: true });
  const b2 = session.request(pid(0x0f), { background: true });
  const o1 = session.request(pid(0x11));
  const o2 = session.request(pid(0x0b));
  await Promise.all([first, b1, b2, o1, o2]);
  assert.deepEqual(asked(t, from), [0x0c, 0x11, 0x0b, 0x05, 0x0f]);
  await conn.disconnect();
});

test('the named priority classes behave like the background flag', async () => {
  const { t, conn, session } = await connectedSession();
  session.setBackgroundWaitMs(1e9);
  const from = t.requests.length;
  await Promise.all([
    session.request(pid(0x0c)),
    session.request(pid(0x05), { priority: PRIORITY.BACKGROUND }),
    session.request(pid(0x11), { priority: PRIORITY.NORMAL }),
  ]);
  assert.deepEqual(asked(t, from), [0x0c, 0x11, 0x05]);
  await conn.disconnect();
});

test('a background request that has waited out the background wait goes before a later ordinary one', async () => {
  const { t, conn, session } = await connectedSession();
  session.setBackgroundWaitMs(0); // any wait is long enough
  const from = t.requests.length;
  const first = session.request(pid(0x0c));
  const b = session.request(pid(0x05), { background: true });
  const o = session.request(pid(0x11));
  await Promise.all([first, b, o]);
  assert.deepEqual(asked(t, from), [0x0c, 0x05, 0x11]);
  await conn.disconnect();
});

test('the background wait can be set by method or by the older backgroundAgeMs property, and is checked', async () => {
  const { conn, session } = await connectedSession();
  assert.equal(session.backgroundAgeMs, 300); // the default
  session.setBackgroundWaitMs(120);
  assert.equal(session.backgroundAgeMs, 120);
  session.backgroundAgeMs = 45;
  assert.equal(session.backgroundAgeMs, 45);
  session.setBackgroundWaitMs(Infinity); // background only runs when nothing ordinary waits
  assert.equal(session.backgroundAgeMs, Infinity);
  assert.throws(() => session.setBackgroundWaitMs(-1), TypeError);
  assert.throws(() => session.setBackgroundWaitMs('soon'), TypeError);
  assert.throws(() => session.setBackgroundWaitMs(NaN), TypeError);
  assert.equal(session.backgroundAgeMs, Infinity); // a refused value changes nothing
  await conn.disconnect();
});

test('ordinary requests keep their order, and the line is free again afterwards', async () => {
  const { t, conn, session } = await connectedSession();
  const from = t.requests.length;
  const order = [0x0c, 0x11, 0x0b, 0x05, 0x0f];
  await Promise.all(order.map((n) => session.request(pid(n))));
  assert.deepEqual(asked(t, from), order);
  assert.equal(session.busy, false);
  // and it still works: a lone background request takes the free line at once
  const r = await session.request(pid(0x05), { background: true });
  assert.ok(r.payload.length);
  assert.equal(session.busy, false);
  await conn.disconnect();
});

test('busy is true while a request is running or queued, false once all are done', async () => {
  const { conn, session } = await connectedSession();
  assert.equal(session.busy, false);
  const a = session.request(pid(0x0c));
  const b = session.request(pid(0x05), { background: true });
  assert.equal(session.busy, true);
  await a;
  assert.equal(session.busy, true); // the background request still waits or runs
  await b;
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

test('requests made during a hold run after its release, in their usual order; the holder goes first', async () => {
  const { t, conn, session } = await connectedSession();
  session.setBackgroundWaitMs(1e9);
  const from = t.requests.length;
  const hold = session.hold();
  const b = session.request(pid(0x05), { background: true });
  const o1 = session.request(pid(0x11));
  const o2 = session.request(pid(0x0b));
  await hold.request(pid(0x0c));
  await hold.request(pid(0x0d));
  assert.deepEqual(asked(t, from), [0x0c, 0x0d]); // nothing else got through
  assert.equal(session.busy, true); // and the held-back requests count as waiting
  hold.release();
  await Promise.all([b, o1, o2]);
  assert.deepEqual(asked(t, from), [0x0c, 0x0d, 0x11, 0x0b, 0x05]);
  assert.equal(session.busy, false);
  await conn.disconnect();
});

test('a request already queued when the hold starts is not held back', async () => {
  const { t, conn, session } = await connectedSession();
  const from = t.requests.length;
  const running = session.request(pid(0x0c)); // has the line
  const queued = session.request(pid(0x11)); // waits for it
  const hold = session.hold();
  const outsider = session.request(pid(0x0b)); // made after the hold began: waits for the release
  const mine = hold.request(pid(0x0d));
  await Promise.all([running, queued, mine]);
  assert.deepEqual(asked(t, from), [0x0c, 0x11, 0x0d]);
  hold.release();
  await outsider;
  assert.deepEqual(asked(t, from), [0x0c, 0x11, 0x0d, 0x0b]);
  await conn.disconnect();
});

test('a holder whose request fails still releases the line when it lets go', async () => {
  const { t, conn, session } = await connectedSession();
  delete t.pids[0x0e];
  const from = t.requests.length;
  const hold = session.hold();
  const outsider = session.request(pid(0x0c));
  try {
    await assert.rejects(hold.request(pid(0x0e), { timeout: 50, retries: 0 }), Error);
  } finally {
    hold.release();
  }
  assert.ok((await outsider).payload.length);
  assert.deepEqual(asked(t, from), [0x0e, 0x0c]);
  assert.equal(session.busy, false);
  await conn.disconnect();
});

test('release may be called twice, and a new hold can follow; a second hold at once is refused', async () => {
  const { conn, session } = await connectedSession();
  const first = session.hold();
  assert.throws(() => session.hold(), /already held/);
  first.release();
  first.release();
  const second = session.hold(); // allowed again
  const outsider = session.request(pid(0x0c));
  second.release();
  assert.ok((await outsider).payload.length);
  // a holder's request after its release is an ordinary request
  const late = await first.request(pid(0x05));
  assert.ok(late.payload.length);
  assert.equal(session.busy, false);
  await conn.disconnect();
});
