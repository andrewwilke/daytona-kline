'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { discoverRun, takeSnapshot, snapshotRun } = require('../src/discover');
const svc = require('../src/services');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-disc-'));

async function connectedBike({ unlocked = true, connection = {} } = {}) {
  const dir = scratch();
  if (unlocked) fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  const conn = new Connection({ configPath: path.join(dir, 'config.json'), openTransport: async () => t, clock: t.clock, keepAliveMs: 60_000, ...connection });
  await conn.connect({ port: 'MOCK' });
  return { t, conn, logDir: path.join(dir, 'logs') };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const tick = () => new Promise((r) => setImmediate(r));

/** The 0x22 ids asked of the mock since request number `from`. */
const askedIds = (t, from = 0) => t.requests.slice(from).filter((r) => r.service === 0x22).map((r) => (r.data[1] << 8) | r.data[2]);

test('a sweep lists every id the ECU answers, with its bytes and the bike\'s name for it; silence and refusals are "not served"', async () => {
  const { t, conn, logDir } = await connectedBike();
  t.silentIds.add(0x05).add(0x06);
  const before = t.requests.length;
  const run = discoverRun(conn, { from: 0x00, to: 0x30, logDir });
  assert.deepEqual(conn.runs, ['discover']);
  assert.equal(await run.start(), 'finished');

  assert.deepEqual(run.found.map((f) => [f.id, f.hex, f.value, f.name]), [
    [0x07, '00 8a', 138, 'Battery'],
    [0x10, '12 34', 0x1234, null],
    [0x11, '00 05', 5, null],
    [0x21, '00 08', 8, 'Gear'],
    [0x26, '00 80', 128, 'Sidestand sensor'],
    [0x28, '02 00', 512, 'Rollover (tip-over) switch'],
  ]);
  const v = run.view();
  assert.deepEqual([v.asked, v.total, v.silent, v.refused, v.failed], [0x31, 0x31, 2, 0x31 - 6 - 2, 0]);
  assert.equal(v.found.length, 6);
  assert.equal(run.errors, 0, 'silence and refusals are no errors');
  assert.equal(conn.session.linkFailures, 0);
  assert.deepEqual(conn.runs, []);

  const sent = t.requests.slice(before);
  assert.ok(sent.every((r) => r.service === 0x22 && r.data.length === 3), 'nothing is ever sent but 22 hi lo');
  assert.deepEqual(askedIds(t, before), Array.from({ length: 0x31 }, (_, i) => i), 'each id once, in order, no resend');
  await conn.disconnect();
});

test('each id is asked with a 300 ms timeout and the session\'s P3 spacing still applies', async () => {
  const { t, conn, logDir } = await connectedBike();
  t.silentIds.add(0x02);
  const before = t.events.length;
  const t0 = t.clock.now();
  const run = discoverRun(conn, { from: 0x00, to: 0x05, logDir });
  await run.start();
  const writes = t.events.slice(before).filter((e) => e.type === 'write' && e.baud === 10400);
  assert.equal(writes.length, 6);
  for (let i = 1; i < writes.length; i++) assert.ok(writes[i].at - writes[i - 1].at >= conn.session.p3, `request ${i} came ${writes[i].at - writes[i - 1].at} ms after the last`);
  const silentGap = writes[3].at - writes[2].at;
  assert.ok(silentGap >= 300 && silentGap < 600, `a silent id costs its 300 ms timeout (${silentGap} ms)`);
  assert.ok(t.clock.now() - t0 < 2000);
  await conn.disconnect();
});

test('the default sweep is 0x0000..0x00ff and takes a few minutes at most', async () => {
  const { t, conn, logDir } = await connectedBike();
  for (let id = 0x80; id <= 0x8f; id++) t.silentIds.add(id);
  const run = discoverRun(conn, { logDir });
  assert.deepEqual([run.from, run.to, run.total], [0, 0xff, 256]);
  const t0 = t.clock.now();
  await run.start();
  const served = Object.keys(t.dataIds).map(Number).filter((id) => id <= 0xff && !t.silentIds.has(id)).sort((a, b) => a - b);
  assert.deepEqual(run.found.map((f) => f.id), served);
  assert.equal(run.view().asked, 256);
  assert.ok(t.clock.now() - t0 < 3 * 60_000, `${t.clock.now() - t0} ms`);
  await conn.disconnect();
});

test('the extended range 0x0100..0x03ff finds the ids above 0xff', async () => {
  const { conn, logDir } = await connectedBike();
  const run = discoverRun(conn, { from: 0x0100, to: 0x0130, logDir });
  await run.start();
  assert.deepEqual(run.found.map((f) => [f.id, f.hex]), [[0x123, '00 01']]);
  await conn.disconnect();
});

test('the result is saved to discovered-ids-<time>.json with what was asked and found', async () => {
  const { conn, logDir } = await connectedBike();
  const run = discoverRun(conn, { from: 0x05, to: 0x12, logDir });
  await run.start();
  assert.equal(path.dirname(run.resultPath), logDir);
  assert.match(path.basename(run.resultPath), /^discovered-ids-\d{4}-\d\d-\d\dT[\d-]+Z\.json$/);
  const saved = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
  assert.deepEqual({ ...saved, startedAt: typeof saved.startedAt, durationMs: typeof saved.durationMs }, {
    startedAt: 'string',
    durationMs: 'number',
    from: '0x0005',
    to: '0x0012',
    outcome: 'finished',
    complete: true,
    stopReason: null,
    asked: 14,
    served: 3,
    silent: 0,
    refused: 11,
    failed: [],
    found: [
      { id: '0x0007', value: 138, hex: '00 8a', name: 'Battery' },
      { id: '0x0010', value: 0x1234, hex: '12 34', name: null },
      { id: '0x0011', value: 5, hex: '00 05', name: null },
    ],
  });
  assert.equal(run.view().resultFile, path.basename(run.resultPath));
  await conn.disconnect();
});

test('a sweep can be cancelled; what it had found is still saved, marked incomplete', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = discoverRun(conn, { from: 0x00, to: 0xff, logDir });
  const ended = run.start();
  await until(() => run.sampler.asked >= 12);
  run.stop();
  assert.equal(await ended, 'cancelled');
  assert.ok(run.sampler.asked < 256);
  const saved = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
  assert.equal(saved.outcome, 'cancelled');
  assert.equal(saved.complete, false);
  assert.equal(saved.asked, run.sampler.asked);
  assert.ok(saved.found.some((f) => f.id === '0x0007'));
  const sent = t.requests.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sent, 'a cancelled sweep asks nothing more');
  await conn.disconnect();
});

test('a disconnect cancels the sweep', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = discoverRun(conn, { logDir });
  const ended = run.start();
  await until(() => run.sampler.asked >= 5);
  await conn.disconnect();
  assert.equal(await ended, 'cancelled');
  assert.ok(run.resultPath && !run.saveError);
  assert.equal(JSON.parse(fs.readFileSync(run.resultPath, 'utf8')).complete, false);
  const sent = t.requests.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sent);
});

test('the total duration is bounded: a sweep that is not done in time ends and says where', async () => {
  const { t, conn, logDir } = await connectedBike();
  for (let id = 0; id < 0x100; id++) t.silentIds.add(id); // every id costs the full timeout
  const run = discoverRun(conn, { logDir, maxMs: 5000 });
  assert.equal(await run.start(), 'finished');
  assert.match(run.sampler.stopReason, /^time limit of 5 s reached at 0x00[0-9a-f]{2}, \d+ id\(s\) not asked$/);
  assert.ok(run.sampler.asked < 256 && run.sampler.asked >= 10, `${run.sampler.asked} asked`);
  assert.ok(t.clock.now() - run.startedAt < 6500);
  const saved = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
  assert.equal(saved.complete, false);
  assert.equal(saved.stopReason, run.sampler.stopReason);
  assert.equal(run.view().stopReason, run.sampler.stopReason);

  const roomy = discoverRun(conn, { logDir, from: 0, to: 3, maxMs: 60_000 });
  await roomy.start();
  assert.equal(roomy.sampler.stopReason, null);
  await conn.disconnect();
});

test('a sweep needs the unlock: locked it refuses to start and sends nothing', async () => {
  const { t, conn, logDir } = await connectedBike({ unlocked: false });
  const before = t.requests.length;
  assert.throws(() => discoverRun(conn, { logDir }), (e) => e instanceof svc.NeedsUnlockError && /needs the ECU unlock, not available/.test(e.message));
  assert.throws(() => snapshotRun(conn, { ids: [1] }), svc.NeedsUnlockError);
  assert.equal(t.requests.length, before);
  assert.deepEqual(conn.runs, []);
  assert.equal(fs.existsSync(logDir), false, 'no file either');
  await conn.disconnect();
});

test('the id range is checked', async () => {
  const { conn, logDir } = await connectedBike();
  for (const range of [{ from: 5, to: 4 }, { from: -1, to: 4 }, { from: 0, to: 0x10000 }, { from: 1.5, to: 4 }, { from: 'a', to: 4 }]) {
    assert.throws(() => discoverRun(conn, { logDir, ...range }), /id range must be whole numbers/, JSON.stringify(range));
  }
  assert.deepEqual(conn.runs, []);
  await conn.disconnect();
});

test('a failing link during the sweep is counted as an error and the sweep goes on', async () => {
  const { t, conn, logDir } = await connectedBike();
  const run = discoverRun(conn, { from: 0x05, to: 0x08, logDir });
  t.inject('badChecksum', { service: 0x22 });
  await run.start();
  assert.equal(run.errors, 1);
  assert.deepEqual(run.sampler.failed, [0x05]);
  assert.equal(run.sampler.asked, 4);
  assert.deepEqual(run.found.map((f) => f.id), [0x07], 'the later ids were still asked');
  assert.deepEqual(JSON.parse(fs.readFileSync(run.resultPath, 'utf8')).failed, ['0x0005']);
  await conn.disconnect();
});

// ---- snapshots -------------------------------------------------------------------

test('a snapshot reads the given ids once each; the diff finds the id that changed, with before and after', async () => {
  const { t, conn } = await connectedBike();
  let sidestand = 0;
  t.dataIds[0x55] = () => [0, sidestand];
  t.dataIds[0x56] = [0x01, 0x02];
  const ids = [0x07, 0x40, 0x55, 0x56, 0x99];
  const before = t.requests.length;
  const a = await takeSnapshot(conn, ids);
  assert.deepEqual(Object.keys(a.values).map(Number), [0x07, 0x40, 0x55, 0x56], 'the id the ECU refuses has no value');
  assert.deepEqual(a.values[0x55], { hex: '00 00', value: 0 });
  assert.deepEqual(askedIds(t, before), ids, 'each id asked once');
  assert.deepEqual(conn.runs, []);

  sidestand = 0xff; // lift the sidestand
  const b = await takeSnapshot(conn, ids);
  assert.deepEqual(svc.diffSnapshots(a.values, b.values, conn.bike), [{ id: 0x55, name: null, before: '00 00', after: '00 ff' }]);
  assert.deepEqual(svc.diffSnapshots(b.values, b.values, conn.bike), []);

  t.dataIds[0x40] = [0, 0xff]; // the bike's neutral switch: named
  t.silentIds.add(0x56);
  const c = await takeSnapshot(conn, ids);
  assert.deepEqual(svc.diffSnapshots(b.values, c.values, conn.bike), [
    { id: 0x40, name: 'Neutral', before: '00 00', after: '00 ff' },
    { id: 0x56, name: null, before: '01 02', after: null },
  ]);
  assert.ok(t.requests.slice(before).every((r) => r.service === 0x22));
  await conn.disconnect();
});

test('a snapshot cut short by a disconnect is an error, not a half result', async () => {
  const { conn } = await connectedBike();
  const taking = takeSnapshot(conn, Array.from({ length: 60 }, (_, i) => i));
  await tick();
  await conn.disconnect();
  await assert.rejects(() => taking, /snapshot was cancelled/);
});
