'use strict';

// The GUI server's output test routes (see also outputtests.test.js for the runner itself).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { routes, conn, state } = require('../server');
const outputtests = require('../src/outputtests');
const { MockEcuTransport, fakeClock } = require('./mockecu');

const clock = fakeClock(); // one clock for every mock: the server's connection (and its cooldown) outlives each of them

const M = 0x1234; // a made-up unlock multiplier; the real one lives in the user's own unlock.json
const KEYS = ['tachometer', 'coolingFan', 'fuelPump', 'idleSpeedControl', 'purgeValve', 'secondaryAir', 'airFlap', 'exhaustValve'];
const LOCKED_NOTE = /^needs the ECU unlock, not available \(/;

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const call = (route, body) => routes[route](body ?? {});
const commanded = (t) => t.requests.filter((r) => r.service === 0x31 || r.service === 0x32);

async function connectBike({ autoUnlock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-'));
  fs.writeFileSync(path.join(dir, 'unlock.json'), JSON.stringify({ multiplier: M }));
  const t = new MockEcuTransport({ iso9141: true, unlockMultiplier: M, clock });
  t.pids[0x0c] = [0, 0];
  conn.configPath = path.join(dir, 'config.json');
  conn.autoUnlock = autoUnlock;
  conn.openTransport = async () => t;
  conn.clock = t.clock;
  conn.keepAliveMs = 60_000;
  state.logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-logs-')), 'logs');
  await call('POST /api/connect', { port: 'MOCK' });
  return t;
}

/** Enable output tests the way the page does and wait out any cooldown of an earlier test on the shared connection. */
async function enable(t) {
  const { token } = await call('POST /api/outputtest/enable', { acknowledged: true });
  for (let i = 0; i < 3; i++) { // in steps with a ping between: the ECU drops the session after 5 s of silence
    await t.clock.sleep(2000);
    await conn.session.request([0x01, 0x00]);
  }
  return token;
}

test('the list route is the whitelist with what to see and the safety notes, plus the preconditions', async () => {
  const r = await call('GET /api/outputtest/list');
  assert.deepEqual(r.tests.map((x) => x.key), KEYS);
  assert.ok(r.tests.every((x) => x.see && x.safety && ['confirmed', 'consistent', 'unconfirmed'].includes(x.confirmation) && typeof x.routine === 'number'));
  assert.equal(r.tests.find((x) => x.key === 'idleSpeedControl').needsStop, true);
  assert.ok(r.preconditions.some((p) => /battery is at least 10\.5 V/.test(p)));
  assert.equal(r.cooldownMs, 5000);
});

test('the status route says not connected, then locked, and sends nothing in either case', async () => {
  await call('POST /api/disconnect');
  const off = await call('GET /api/outputtest/status');
  assert.deepEqual([off.available, off.note, off.running, off.current], [false, 'not connected', false, null]);

  const t = await connectBike({ autoUnlock: false });
  const locked = await call('GET /api/outputtest/status');
  assert.equal(locked.available, false);
  assert.match(locked.note, LOCKED_NOTE);

  const { token } = await call('POST /api/outputtest/enable', { acknowledged: true });
  const r = await call('POST /api/outputtest/start', { key: 'fuelPump', confirmed: true, token });
  assert.equal(r.locked, true);
  assert.match(r.note, LOCKED_NOTE);
  assert.equal(commanded(t).length, 0);
  assert.equal(t.requests.filter((q) => q.service === 0x22).length, 0);
  await call('POST /api/disconnect');
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'fuelPump', confirmed: true, token }), /not connected/);
});

test('a test can only be started by a page that enabled output tests, with confirmed: true', async () => {
  const t = await connectBike();
  await assert.rejects(() => call('POST /api/outputtest/enable', {}), /after the preconditions are acknowledged/);
  await assert.rejects(() => call('POST /api/outputtest/enable', { acknowledged: 'yes' }), /acknowledged/);
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed: true }), /not enabled on this page/);
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed: true, token: 'guess' }), /not enabled on this page/);

  const token = await enable(t);
  for (const confirmed of [false, undefined, 'true', 1]) {
    await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed, token }), /not confirmed/);
  }
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'adjustExhaustValve', confirmed: true, token }), /not an output test this tool can run/);
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed: true, token: 'x'.repeat(32) }), /not enabled on this page/);
  assert.equal(commanded(t).length, 0);

  const newer = (await call('POST /api/outputtest/enable', { acknowledged: true })).token;
  assert.notEqual(newer, token);
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed: true, token }), /not enabled on this page/, 'only the page that enabled last');
  assert.equal(commanded(t).length, 0);
  await call('POST /api/disconnect');
});

test('start with confirmed true runs the test; the status shows it live and then done, with the effect and the cooldown', async () => {
  const t = await connectBike();
  t.dataIds[0x60] = [0, 0x00];
  const token = await enable(t);
  const r = await call('POST /api/outputtest/start', { key: 'fuelPump', confirmed: true, token });
  assert.deepEqual([r.test.key, r.test.state, r.test.reply, r.test.running], ['fuelPump', 'running', '71 04', true]);
  assert.equal((await call('GET /api/outputtest/status')).running, true);
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'coolingFan', confirmed: true, token }), /another output test is running \(Fuel pump\)/);

  await until(() => !outputtests.currentTest(conn).running);
  const s = await call('GET /api/outputtest/status');
  assert.equal(s.running, false);
  assert.equal(s.current.outcome, 'completed');
  assert.equal(s.current.effect.sawActive, true);
  assert.match(s.current.effect.text, /^Fuel pump: 00 00 \(OFF\) -> 00 ff \(ON\)/);
  assert.ok(s.cooldownMs > 0);
  assert.deepEqual(commanded(t).map((q) => q.data), [[0x31, 0x04]]);
  assert.match(path.basename(s.current.logFile), /^output-tests-/);
  assert.equal(path.dirname(s.current.logFile), state.logDir);
  await call('POST /api/disconnect');
});

test('the stop route ends the idle speed control test with its stop; a disconnect clears the page\'s enabling', async () => {
  const t = await connectBike();
  const token = await enable(t);
  await call('POST /api/outputtest/start', { key: 'idleSpeedControl', confirmed: true, token });
  const r = await call('POST /api/outputtest/stop');
  assert.deepEqual([r.test.outcome, r.test.stopSent, r.test.stopReply], ['stopped', true, '72 02']);
  assert.deepEqual(commanded(t).map((q) => q.data), [[0x31, 0x02], [0x32, 0x02]]);
  assert.equal((await call('POST /api/outputtest/stop')).test.outcome, 'stopped', 'a second press changes nothing');
  assert.equal(commanded(t).length, 2);

  assert.ok(state.outputTestToken);
  await call('POST /api/disconnect');
  assert.equal(state.outputTestToken, null);
  const again = await connectBike();
  await assert.rejects(() => call('POST /api/outputtest/start', { key: 'tachometer', confirmed: true, token }), /not enabled on this page/);
  assert.equal(commanded(again).length, 0);
  await call('POST /api/disconnect');
});

test('the page: the output tests panel is explanation + checkbox + enable button, confirm() before each test, nothing remembered, and its script compiles', () => {
  // The panel's markup is in index.html; its script is the page's own file (public/js/app.js).
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(html.includes('The bike is stationary, the engine is off, the key is on, I have clear access to the fan and exhaust valve, and I understand these tests make the bike move or run parts'));
  assert.match(html, /<button class="danger" id="btnOutEnable" disabled>Enable output tests<\/button>/);
  assert.match(html, /<input type="checkbox" id="outAck"/);
  assert.match(script, /if \(!confirm\(`Run the \$\{t\.name\} test now\?/);
  assert.match(script, /confirmed: true, token: outToken/);
  const from = script.indexOf('// ---- Output tests'), to = script.indexOf('// ---- Vitals and tabs');
  assert.ok(from > 0 && to > from, 'the output tests region of the page script is found');
  assert.doesNotMatch(script.slice(from, to), /localStorage|sessionStorage|document\.cookie/, 'enabling is per page session, not remembered (the tab memory below it is only the selected tab)');
  new (require('vm').Script)(script); // throws on a syntax error
});
