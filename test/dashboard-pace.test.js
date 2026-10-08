'use strict';

// How fast the dashboard refreshes while the switch watcher runs beside it, the way the page runs them: the real bike
// answers some ids only now and then, and a silent read holds the one K-line for its whole wait. The dashboard's engine
// speed and throttle must not be left waiting behind that, or the needles update every few seconds.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, state } = require('../server');
const { MockEcuTransport } = require('./mockecu');

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json

const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const call = (route, body, query) => routes[route](body ?? {}, query);

async function connectBike() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M });
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = true;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  state.logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-logs-')), 'logs');
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

/** The gaps (ms of the connection's clock) between the dashboard's engine speed readings. */
async function rpmGaps(wantPoints) {
  await until(async () => true);
  let series = {};
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    series = (await call('GET /api/gauges', {}, new URLSearchParams('since=-1'))).series ?? {};
    if ((series.rpm?.length ?? 0) >= wantPoints) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const pts = series.rpm ?? [];
  assert.ok(pts.length >= wantPoints, `only ${pts.length} engine speed readings`);
  return pts.slice(1).map((p, i) => p[0] - pts[i][0]);
}

test('the dashboard keeps its pace while the switch watcher runs with silent ids and the engine is running', async () => {
  const t = await connectBike();
  // the ids the real bike answers only now and then (and one it never serves): each silence costs a full wait
  for (const id of [0x61, 0x68, 0x62, 0x64, 0x66]) t.silentIds.add(id);
  await call('POST /api/runs/reconcile');
  // the page asks for the switch tiles over and over, one scan per request
  let stop = false;
  const page = (async () => {
    while (!stop) {
      try { await call('GET /api/switches', {}, new URLSearchParams('')); } catch { /* the run may be stopping */ }
      await new Promise((r) => setImmediate(r));
    }
  })();
  const gaps = await rpmGaps(14);
  stop = true;
  await page;
  await call('POST /api/runs/stop', { feature: 'dashboard' }).catch(() => {});
  await call('POST /api/disconnect');
  const worst = Math.max(...gaps);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A cycle is engine speed, throttle, the injection pulse, one value in turn, one flag and one switch read in the
  // background: six reads at about 185 ms each on this mock (as on the bike). Before the background reads gave way to the
  // dashboard (and a silent one stopped holding the line for 1.6 s) the median was about 3 s.
  assert.ok(median < 1300, `median gap ${median} ms`);
  assert.ok(worst < 2400, `worst gap ${worst} ms (gaps: ${gaps.join(' ')})`);
});
