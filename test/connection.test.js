'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection } = require('../src/connection');
const { FAILURE, KwpNegativeResponse } = require('../src/kwp');
const svc = require('../src/services');
const { MockEcuTransport } = require('./mockecu');
const { FAST_BIKE } = require('./helpers');
const { DEFAULT_BIKE } = require('../src/bikes');

const tmpConfig = (initial) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-')), 'config.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  return file;
};
const savedConfig = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * A Connection wired to `mock` instead of a serial port. The bike defaults to
 * a fast-init-only one; pass `bike: DEFAULT_BIKE` for the real wake-up order.
 */
function connectionTo(mock, { config, ...opts } = {}) {
  const conn = new Connection({
    bike: FAST_BIKE,
    configPath: tmpConfig(config),
    openTransport: async () => mock,
    clock: mock.clock,
    keepAliveMs: 60_000,
    ...opts,
  });
  conn.events = [];
  conn.on('progress', (e) => conn.events.push(e));
  conn.states = [];
  conn.on('state', (s) => conn.states.push(s.state));
  return conn;
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('saved address fails, then the scan finds the ECU and the new address is saved', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK', target: 0x77, source: 0xf1, localId: 0x42 } });
  const info = await conn.connect();

  assert.equal(conn.state, 'connected');
  assert.equal(info.target, 0xd5);
  assert.equal(info.source, 0xf5);
  assert.equal(info.addrMode, 'phys');
  assert.deepEqual(info.keyBytes, [0xea, 0x8f]);
  assert.equal(conn.diagSession, true);
  assert.ok(t.requests.some((r) => r.service === 0x10), 'diagnostic session started');
  assert.deepEqual(savedConfig(conn.configPath), { port: 'MOCK', kind: 'fast', target: 0xd5, source: 0xf5, addrMode: 'phys', localId: 0x42 });
  assert.equal(info.kind, 'fast');
  assert.equal(info.style, 'addressed');

  const steps = conn.events.map((e) => (e.attempt ? `${e.step}:${e.attempt.target.toString(16)}${e.attempt.saved ? '*' : ''}` : e.step));
  assert.deepEqual(steps, ['opening', 'attempt:77*', 'attempt-failed:77*', 'attempt:d5', 'diag-session', 'connected']);
  assert.equal(conn.events.at(-1).saved, false);
  assert.deepEqual(conn.states, ['connecting', 'connected']);
  await conn.disconnect();
});

test('a reconnect replays the saved address and addressing mode: one pulse', async () => {
  const first = new MockEcuTransport({ target: 0x33, funcOnly: true });
  const conn = connectionTo(first, { config: { port: 'MOCK' } });
  await conn.connect();
  assert.equal(savedConfig(conn.configPath).addrMode, 'func');
  await conn.disconnect();

  const second = new MockEcuTransport({ target: 0x33, funcOnly: true });
  const again = new Connection({ bike: FAST_BIKE, configPath: conn.configPath, openTransport: async () => second, clock: second.clock, keepAliveMs: 60_000 });
  again.on('progress', (e) => (again.last = e));
  await again.connect();
  assert.equal(second.pulses.length, 1);
  assert.equal(again.last.saved, true);
  assert.equal(again.addrMode, 'func');
  await again.disconnect();
});

test('no ECU: connect rejects, state and error say so, the port is closed', async () => {
  const t = new MockEcuTransport({ target: 0x99 });
  const conn = connectionTo(t, { config: { port: 'MOCK' } });
  await assert.rejects(() => conn.connect(), /No ECU answered/);
  assert.equal(conn.state, 'disconnected');
  assert.match(conn.error, /No ECU answered/);
  assert.equal(conn.session, null);
  assert.equal(t.closed, true);
  assert.throws(() => conn.requireSession(), /not connected/);
});

test('a port that will not open is reported as the error', async () => {
  const conn = new Connection({ configPath: tmpConfig({ port: 'COM9' }), openTransport: async () => { throw new Error('port busy'); } });
  await assert.rejects(() => conn.connect(), /port busy/);
  assert.equal(conn.error, 'port busy');
  assert.equal(conn.state, 'disconnected');
});

test('connect needs a port from the options or the saved config', async () => {
  const conn = connectionTo(new MockEcuTransport(), {});
  await assert.rejects(() => conn.connect(), /No COM port set/);
});

test('keep-alive sends TesterPresent while connected', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' }, keepAliveMs: 3 });
  await conn.connect();
  await until(() => t.requests.filter((r) => r.service === 0x3e).length >= 3);
  assert.equal(conn.state, 'connected');
  await conn.disconnect();
});

test("keep-alive that keeps failing turns the state to 'lost', with the reason, and cancels runs", async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' }, keepAliveMs: 3, keepAliveLimit: 3 });
  await conn.connect();
  const run = conn.startRun('live');
  t.inject('dropReply', { service: 0x3e, times: 1000 });

  await until(() => conn.state === 'lost');
  assert.match(conn.error, /ECU stopped answering \(3 failed requests in a row; last: no response to \[3e\]\)/);
  assert.equal(conn.session, null);
  assert.equal(run.signal.aborted, true);
  assert.throws(() => conn.requireSession(), /connection lost: ECU stopped answering/);
  assert.deepEqual(conn.states, ['connecting', 'connected', 'lost']);

  await conn.disconnect();
  assert.equal(conn.state, 'disconnected');
  assert.equal(conn.error, null);
  assert.equal(t.closed, true);
});

test('failures of ordinary requests count too, so a busy session still notices a dead ECU', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' }, keepAliveMs: 3, keepAliveLimit: 2 });
  await conn.connect();
  t.inject('dropReply', { service: 0x21, times: 1000 });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => svc.readLocalId(conn.session, conn.dataBlockId(), { timeout: 100 }), (e) => e.kind === FAILURE.TIMEOUT);
  }
  await until(() => conn.state === 'lost');
  await conn.disconnect();
});

test('disconnect mid-run cancels the run, sends StopCommunication and closes the port', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' } });
  await conn.connect();

  const run = conn.startRun('probe');
  let last = 0;
  const probing = svc.probeLocalIds(conn.session, { signal: run.signal, onProgress: (id) => { last = id; } });
  await until(() => last >= 5);
  assert.deepEqual(conn.runs, ['probe']);

  await conn.disconnect();
  const found = await probing;

  assert.ok(last < 0xff, `probe stopped early at 0x${last.toString(16)}`);
  assert.ok(found.every((f) => f.id <= last), 'only what was read before the cancel is reported');
  assert.equal(run.signal.aborted, true);
  assert.deepEqual(conn.runs, []);
  assert.equal(conn.state, 'disconnected');
  assert.equal(t.closed, true);
  assert.equal(t.requests.at(-1).service, 0x82, 'StopCommunication was the last thing sent');
  const sentThen = t.requests.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requests.length, sentThen, 'nothing runs after disconnect');
});

test('every registered run stops on disconnect, loops included', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' } });
  await conn.connect();
  const loops = ['live', 'gauges', 'switches'].map((name) => {
    const run = conn.startRun(name);
    let reads = 0;
    const done = (async () => {
      while (!run.signal.aborted) {
        await svc.readLocalId(conn.session, conn.dataBlockId()).catch(() => {});
        reads++;
      }
    })();
    return { run, done, reads: () => reads };
  });
  await until(() => loops.every((l) => l.reads() >= 2));
  assert.deepEqual(conn.runs, ['live', 'gauges', 'switches']);

  await conn.disconnect();
  await Promise.all(loops.map((l) => l.done));
  assert.ok(loops.every((l) => l.run.signal.aborted));
  assert.deepEqual(conn.runs, []);
});

test('starting a run under a name already in use cancels the old one; runs need a session', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' } });
  assert.throws(() => conn.startRun('live'), /not connected/);
  await conn.connect();
  const a = conn.startRun('live');
  const b = conn.startRun('live');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  b.end();
  assert.deepEqual(conn.runs, []);
  assert.equal(b.signal.aborted, false, 'end() is not a cancel');
  await conn.disconnect();
});

test('connecting again while connected reconnects; two simultaneous connects are refused', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const conn = connectionTo(t, { config: { port: 'MOCK' } });
  const first = conn.connect();
  await assert.rejects(() => conn.connect(), /already connecting/);
  await first;
  const run = conn.startRun('live');
  await conn.connect();
  assert.equal(run.signal.aborted, true, 'reconnect ends the old session first');
  assert.equal(conn.state, 'connected');
  await conn.disconnect();
});

// ---- ISO 9141 (the real bike's wake-up: slow init to 0x33) -------------------

/** A Connection with the real bike's description on an ISO 9141 mock ECU. */
function isoConnection(mockOptions, opts) {
  const t = new MockEcuTransport({ iso9141: true, ...mockOptions });
  return { t, conn: connectionTo(t, { bike: DEFAULT_BIKE, config: { port: 'MOCK' }, ...opts }) };
}
const stepText = (e) => (e.attempt ? `${e.step}:${e.attempt.text}` : e.step);
const writes = (t) => t.events.filter((e) => e.type === 'write').length;

test('iso9141: connects by slow init; the first request, mode 01 PID 00, is what makes it connected; no diagnostic session', async () => {
  const { t, conn } = isoConnection();
  const info = await conn.connect();

  assert.equal(conn.state, 'connected');
  assert.deepEqual({ kind: info.kind, style: info.style, target: info.target, source: info.source, addrMode: info.addrMode, diagSession: info.diagSession }, {
    kind: 'slow', style: 'iso9141', target: 0x33, source: 0xf1, addrMode: 'obd', diagSession: false,
  });
  assert.deepEqual(info.keyBytes, [0x08, 0x08]);
  assert.deepEqual(t.requests.map((r) => r.data), [[0x01, 0x00]], 'PID 00 was the only request, no 10 80');
  assert.deepEqual(conn.events.map(stepText), ['opening', 'attempt:slow init 0x33, try 1/6', 'first-request', 'connected']);
  assert.deepEqual(conn.states, ['connecting', 'connected']);
  assert.deepEqual(savedConfig(conn.configPath), { port: 'MOCK', kind: 'slow', target: 0x33, source: 0xf1, addrMode: 'obd' });
  assert.equal(conn.session.style, 'iso9141');

  const before = writes(t);
  await conn.disconnect();
  assert.equal(writes(t), before, 'nothing is sent to end an ISO 9141 session');
  assert.equal(t.closed, true);
});

test('iso9141: an ECU that answers on the third try connects, and progress names each try', async () => {
  const { conn } = isoConnection({ answerOnTry: 3 });
  await conn.connect();
  assert.equal(conn.state, 'connected');
  assert.deepEqual(conn.events.map(stepText), [
    'opening',
    'attempt:slow init 0x33, try 1/6', 'attempt-failed:slow init 0x33, try 1/6',
    'attempt:slow init 0x33, try 2/6', 'attempt-failed:slow init 0x33, try 2/6',
    'attempt:slow init 0x33, try 3/6',
    'first-request', 'connected',
  ]);
  await conn.disconnect();
});

test('iso9141: a handshake without an answer to the first request is not a connection', async () => {
  const { t, conn } = isoConnection();
  t.inject('dropReply', { service: 0x01, times: 10 });
  await assert.rejects(() => conn.connect(), /completed the handshake but did not answer the first request \[01 00\]/);
  assert.equal(conn.state, 'disconnected');
  assert.deepEqual(conn.states, ['connecting', 'disconnected']);
  assert.equal(t.closed, true);
  assert.equal(conn.session, null);
});

test('iso9141: a reconnect replays the saved slow init first; a saved one that fails falls back to the full order', async () => {
  const first = isoConnection();
  await first.conn.connect();
  await first.conn.disconnect();
  const config = first.conn.configPath;

  const second = isoConnection();
  second.conn.configPath = config;
  await second.conn.connect();
  assert.equal(second.t.slowInits.length, 1);
  assert.equal(second.conn.events.at(-1).saved, true);
  assert.equal(second.conn.events.find((e) => e.step === 'attempt').attempt.saved, true);
  await second.conn.disconnect();

  // the ECU changed: the saved slow wake-up fails once over, then the bike's order finds it
  const other = new MockEcuTransport({ target: 0xd5 });
  const swapped = connectionTo(other, { bike: DEFAULT_BIKE });
  swapped.configPath = config;
  await swapped.connect();
  assert.equal(swapped.state, 'connected');
  assert.equal(swapped.kind, 'fast');
  assert.equal(swapped.style, 'addressed');
  assert.equal(swapped.diagSession, true);
  assert.equal(swapped.events.filter((e) => e.step === 'attempt' && e.attempt.kind === 'slow').length, 6, 'six tries of the saved slow init, not twelve');
  assert.deepEqual(savedConfig(config), { port: 'MOCK', kind: 'fast', target: 0xd5, source: 0xf5, addrMode: 'phys' });
  await swapped.disconnect();
});

test('iso9141: the keep-alive is mode 01 PID 00, never TesterPresent or a diagnostic session', async () => {
  const { t, conn } = isoConnection({}, { keepAliveMs: 3 });
  await conn.connect();
  await until(() => t.requests.filter((r) => r.data[0] === 0x01 && r.data[1] === 0x00).length >= 4);
  assert.equal(conn.state, 'connected');
  assert.ok(t.requests.every((r) => r.service === 0x01));
  await conn.disconnect();
});

test('iso9141: the keep-alive comes about every 2 s by default', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = new MockEcuTransport({ iso9141: true });
    const conn = new Connection({ bike: DEFAULT_BIKE, configPath: tmpConfig({ port: 'MOCK' }), openTransport: async () => t, clock: t.clock });
    await conn.connect();
    assert.equal(t.requests.length, 1);
    mock.timers.tick(1999);
    await new Promise((r) => setImmediate(r));
    assert.equal(t.requests.length, 1);
    mock.timers.tick(1);
    await until(() => t.requests.length === 2);
    await conn.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test("iso9141: losing the keep-alive turns the state to 'lost'", async () => {
  const { t, conn } = isoConnection({}, { keepAliveMs: 3, keepAliveLimit: 3 });
  await conn.connect();
  const run = conn.startRun('live');
  t.inject('dropReply', { service: 0x01, times: 1000 });

  await until(() => conn.state === 'lost');
  assert.match(conn.error, /ECU stopped answering \(3 failed requests in a row; last: no response to \[01 00\]\)/);
  assert.equal(run.signal.aborted, true);
  assert.equal(conn.session, null);
  assert.deepEqual(conn.states, ['connecting', 'connected', 'lost']);
  await conn.disconnect();
  assert.equal(conn.state, 'disconnected');
});

test('iso9141: requests the ECU leaves unanswered on purpose do not make the link look lost', async () => {
  const { t, conn } = isoConnection({}, { keepAliveMs: 3, keepAliveLimit: 3 });
  await conn.connect();
  const pings = () => t.requests.filter((r) => r.data[1] === 0x00).length;
  const before = pings();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => conn.session.request([0x07], { allowSilence: true, retries: 0 }), (e) => e.kind === FAILURE.TIMEOUT);
  }
  await until(() => pings() >= before + 3);
  assert.equal(conn.state, 'connected');
  await conn.disconnect();
});

// ---- Unlock (security access, ISO 9141 only) -----------------------------------
// Multipliers here are made up; the real one lives in the user's own unlock.json.

const M = 0x1234;
const writeUnlock = (conn, body) => fs.writeFileSync(path.join(path.dirname(conn.configPath), 'unlock.json'), typeof body === 'string' ? body : JSON.stringify(body));
const unlockConnection = ({ file = { multiplier: M }, mock: mockOptions, ...opts } = {}) => {
  const configPath = tmpConfig({ port: 'MOCK' });
  if (file !== null) fs.writeFileSync(path.join(path.dirname(configPath), 'unlock.json'), typeof file === 'string' ? file : JSON.stringify(file));
  const { t, conn } = isoConnection({ unlockMultiplier: M, ...mockOptions }, { configPath, ...opts });
  conn.unlockEvents = [];
  conn.on('unlock', (e) => conn.unlockEvents.push(e.state));
  return { t, conn };
};
const ofService = (t, service) => t.requests.filter((r) => r.service === service);
const pings = (t) => t.requests.filter((r) => r.data[0] === 0x01 && r.data[1] === 0x00).length;

test('unlock: no unlock file means unavailable, and not one security access request is ever sent', async () => {
  const { t, conn } = unlockConnection({ file: null, keepAliveMs: 3 });
  assert.equal(conn.unlockState, 'unavailable');
  const info = await conn.connect();
  assert.equal(info.unlock, 'unavailable');
  assert.match(info.unlockReason, /no unlock file/);
  await until(() => pings(t) >= 4);
  await assert.rejects(() => conn.unlock(), /unlock is unavailable: no unlock file/);
  assert.equal(ofService(t, 0x27).length, 0);
  assert.equal(conn.state, 'connected');
  assert.deepEqual(conn.unlockEvents, [], 'it never left unavailable');
  await conn.disconnect();
});

test('unlock: a file with the right multiplier is tried once after connecting and unlocks; 0x22 is served; the keep-alive runs on', async () => {
  const { t, conn } = unlockConnection({ keepAliveMs: 3 });
  assert.equal(conn.unlockState, 'locked');
  const info = await conn.connect();

  assert.equal(info.unlock, 'unlocked', 'connect resolves once the attempt is over');
  assert.equal(info.unlockReason, null);
  assert.deepEqual(conn.unlockEvents, ['unlocking', 'unlocked']);
  assert.equal(t.keyAttempts, 1);
  assert.equal(t.unlocked, true);
  assert.deepEqual([...(await svc.readCommonId(conn.session, 0x07))], [0, 138]);
  const before = pings(t);
  await until(() => pings(t) >= before + 3);
  assert.equal(conn.state, 'connected');
  assert.equal(conn.unlockState, 'unlocked');
  assert.equal(t.keyAttempts, 1, 'the keep-alive does not try again');
  assert.equal(ofService(t, 0x27).length, 2);
  assert.ok(!JSON.stringify(conn.info()).includes(String(M)), 'the multiplier is not in info()');
  await assert.rejects(() => conn.unlock(), /already unlocked/);
  await conn.disconnect();
});

test("unlock: 'state' events and info() carry the unlock state", async () => {
  const { conn } = unlockConnection();
  const seen = [];
  conn.on('state', (e) => seen.push(`${e.state}/${e.unlock}`));
  await conn.connect();
  assert.deepEqual(seen, ['connecting/locked', 'connected/locked']);
  assert.equal(conn.events.at(-1).unlock, 'locked', "the 'connected' progress event is sent before the attempt");
  assert.equal(conn.info().unlock, 'unlocked');
  await conn.disconnect();
  assert.equal(seen.at(-1), 'disconnected/locked');
});

test('unlock: a wrong multiplier fails with one key; neither the keep-alive nor time tries again; unlock() tries once per call', async () => {
  const { t, conn } = unlockConnection({ file: { multiplier: M + 1 }, keepAliveMs: 3 });
  const info = await conn.connect();
  assert.equal(conn.state, 'connected', 'a failed unlock does not fail the connection');
  assert.equal(info.unlock, 'failed');
  assert.match(info.unlockReason, /refused the key \(code 0x35\)/);
  assert.equal(t.keyAttempts, 1);
  assert.deepEqual(conn.unlockEvents, ['unlocking', 'failed']);

  const before = pings(t);
  await until(() => pings(t) >= before + 4);
  assert.equal(t.keyAttempts, 1, 'no retry on later keep-alives');
  assert.equal(t.seedRequests, 1);
  await assert.rejects(() => svc.readCommonId(conn.session, 0x07), KwpNegativeResponse, 'still locked');

  assert.deepEqual(await conn.unlock(), { state: 'failed', reason: conn.unlockReason });
  assert.equal(t.keyAttempts, 2, 'asked once, tried once');
  assert.equal(t.seedRequests, 2);

  writeUnlock(conn, { multiplier: M });
  assert.deepEqual(await conn.unlock(), { state: 'unlocked', reason: null }, 'the file is read again for each attempt');
  assert.equal(t.keyAttempts, 3);
  assert.deepEqual([...(await svc.readCommonId(conn.session, 0x07))], [0, 138]);
  await conn.disconnect();
});

test('unlock: a second unlock() while one is running is refused', async () => {
  const { t, conn } = unlockConnection({ file: { multiplier: M + 1 } });
  await conn.connect();
  const first = conn.unlock();
  assert.equal(conn.unlockState, 'unlocking');
  await assert.rejects(() => conn.unlock(), /already in progress/);
  await first;
  assert.equal(t.keyAttempts, 2);
  await conn.disconnect();
});

test('unlock: unlock() needs a connection', async () => {
  const { conn } = unlockConnection();
  await assert.rejects(() => conn.unlock(), /not connected/);
});

test('unlock: a seed of 0000 is already unlocked, no key is sent', async () => {
  const { t, conn } = unlockConnection({ mock: { seed: 0 } });
  await conn.connect();
  assert.equal(conn.unlockState, 'unlocked');
  assert.equal(t.keyAttempts, 0);
  assert.deepEqual([...(await svc.readCommonId(conn.session, 0x21))], [0, 8]);
  await conn.disconnect();
});

test('unlock: an ECU that never answers security access fails once: one seed request, nothing resent', async () => {
  const { t, conn } = unlockConnection({ mock: { unlockMultiplier: undefined } });
  await conn.connect();
  assert.equal(conn.unlockState, 'failed');
  assert.match(conn.unlockReason, /no usable reply to the seed request/);
  assert.equal(ofService(t, 0x27).length, 1);
  assert.equal(conn.state, 'connected');
  await conn.disconnect();
});

test('unlock: an unusable file is invalid; nothing is sent and unlock() says why', async () => {
  const { t, conn } = unlockConnection({ file: '{"multiplier": "abc"}' });
  assert.equal(conn.unlockState, 'invalid');
  const info = await conn.connect();
  assert.equal(info.unlock, 'invalid');
  assert.match(info.unlockReason, /must be a whole number from 1 to 65535/);
  assert.equal(conn.state, 'connected');
  await assert.rejects(() => conn.unlock(), /unlock is invalid: .*whole number/);
  assert.equal(ofService(t, 0x27).length, 0);

  writeUnlock(conn, { multiplier: M });
  assert.equal((await conn.connect()).unlock, 'unlocked', 'fixing the file and connecting again is enough');
  await conn.disconnect();
});

test('unlock: a file that goes bad between connect and unlock() is refused, not sent', async () => {
  const { t, conn } = unlockConnection({ file: { multiplier: M + 1 } });
  await conn.connect();
  assert.equal(conn.unlockState, 'failed');
  writeUnlock(conn, 'not json');
  await assert.rejects(() => conn.unlock(), /unlock is invalid/);
  assert.equal(conn.unlockState, 'invalid');
  assert.equal(t.keyAttempts, 1);
  await conn.disconnect();
});

test('unlock: every new connection starts locked and tries once more', async () => {
  const { t, conn } = unlockConnection({ file: { multiplier: M + 1 } });
  await conn.connect();
  assert.equal(conn.unlockState, 'failed');
  assert.equal(t.keyAttempts, 1);

  await conn.disconnect();
  assert.equal(conn.unlockState, 'locked', 'ending the session starts over');

  writeUnlock(conn, { multiplier: M });
  await conn.connect();
  assert.equal(conn.unlockState, 'unlocked');
  assert.equal(t.keyAttempts, 2, 'one more attempt, for the new connection');
  assert.equal(t.slowInits.filter((i) => i.answered).length, 2);

  await conn.connect(); // connecting again while connected reconnects
  assert.equal(conn.unlockState, 'unlocked');
  assert.equal(t.keyAttempts, 3, 'the new wake-up locked the ECU, so it was unlocked again');
  await conn.disconnect();
  assert.deepEqual(conn.unlockEvents, ['unlocking', 'failed', 'locked', 'unlocking', 'unlocked', 'locked', 'unlocking', 'unlocked', 'locked']);
});

test("unlock: losing the connection resets the unlock to 'locked'", async () => {
  const { t, conn } = unlockConnection({ keepAliveMs: 3, keepAliveLimit: 3 });
  await conn.connect();
  assert.equal(conn.unlockState, 'unlocked');
  t.inject('dropReply', { service: 0x01, times: 1000 });
  await until(() => conn.state === 'lost');
  assert.equal(conn.unlockState, 'locked');
  assert.equal(conn.info().unlock, 'locked');
  await assert.rejects(() => conn.unlock(), /connection lost/);
  await conn.disconnect();
});

test('unlock: other session styles are unavailable even with a good file, and nothing is sent', async () => {
  const t = new MockEcuTransport({ target: 0xd5, unlockMultiplier: M });
  const configPath = tmpConfig({ port: 'MOCK' });
  fs.writeFileSync(path.join(path.dirname(configPath), 'unlock.json'), JSON.stringify({ multiplier: M }));
  const conn = connectionTo(t, { configPath });
  assert.equal(conn.unlockState, 'locked', 'before connecting, the file is all there is to go on');
  const info = await conn.connect();
  assert.equal(info.style, 'addressed');
  assert.equal(info.unlock, 'unavailable');
  assert.match(info.unlockReason, /only for ISO 9141 sessions \(this one is addressed\)/);
  await assert.rejects(() => conn.unlock(), /unlock is unavailable/);
  assert.equal(ofService(t, 0x27).length, 0);
  await conn.disconnect();
});

test('unlock: the file is looked for beside config.json unless unlockPath says otherwise', async () => {
  const { conn } = unlockConnection({ file: null });
  const elsewhere = path.join(path.dirname(tmpConfig()), 'mine.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ multiplier: M }));
  conn.unlockPath = elsewhere;
  assert.equal((await conn.connect()).unlock, 'unlocked');
  await conn.disconnect();
});

test('unlock: nothing is sent between the seed request and the key, however busy the session is', async () => {
  const { t, conn } = unlockConnection({ file: { multiplier: M }, keepAliveMs: 2 });
  conn.autoUnlock = false;
  await conn.connect();
  assert.equal(conn.unlockState, 'locked');

  let going = true;
  const flood = () => (async () => {
    while (going) await conn.session.request([0x01, 0x0c], { allowSilence: true });
  })();
  const floods = [flood(), flood(), flood()];
  await until(() => t.requests.length >= 10);

  assert.deepEqual(await conn.unlock(), { state: 'unlocked', reason: null });
  const sentAfter = t.requests.length;
  await until(() => t.requests.length >= sentAfter + 6);
  going = false;
  await Promise.all(floods);

  const seed = t.requests.findIndex((r) => r.service === 0x27);
  assert.deepEqual(t.requests.slice(seed, seed + 2).map((r) => [r.service, r.data[1]]), [[0x27, 0x05], [0x27, 0x06]], 'the key follows the seed at once');
  assert.equal(ofService(t, 0x27).length, 2);
  assert.ok(t.requests.length > seed + 2, 'held requests went through afterwards');
  assert.equal(conn.state, 'connected');
  await conn.disconnect();
});

test('unlock: the attempt made on connecting is also not interrupted by the keep-alive', async () => {
  const { t, conn } = unlockConnection({ keepAliveMs: 1 });
  await conn.connect();
  assert.equal(conn.unlockState, 'unlocked');
  const seed = t.requests.findIndex((r) => r.service === 0x27);
  assert.equal(t.requests[seed + 1].data[1], 0x06);
  await conn.disconnect();
});

test('unlock: a request made while an unlock is under way waits and is answered after it', async () => {
  const { t, conn } = unlockConnection({ autoUnlock: false });
  await conn.connect();
  const unlocking = conn.unlock();
  const read = svc.readCommonId(conn.session, 0x07); // would be refused if it ran before the key
  assert.deepEqual([...(await read)], [0, 138]);
  await unlocking;
  assert.deepEqual(t.requests.slice(-3).map((r) => r.service), [0x27, 0x27, 0x22]);
  await conn.disconnect();
});
