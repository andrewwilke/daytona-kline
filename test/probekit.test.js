'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const kit = require('../src/probekit');
const { wakeEcu } = require('../src/wakeup');
const { MockEcuTransport, fakeClock } = require('./mockecu');
const { FAST_BIKE } = require('./helpers');

/** A K-line with nobody on it: bytes written come back through `echo(bytes)`. */
function stubLine(echo) {
  const buf = [];
  return {
    async flushInput() { buf.length = 0; },
    async write(bytes) { buf.push(...echo(bytes)); },
    async readByte() { return buf.length ? buf.shift() : null; },
  };
}

test('frame building matches the frames the tool sends', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  await wakeEcu(t, { clock: t.clock });
  const sent = t.events.find((e) => e.type === 'write' && e.baud === 10400).bytes;
  assert.deepEqual(kit.buildFrame(0x80, 0xd5, 0xf5, [0x81]), sent);
  assert.deepEqual(kit.buildFrame(0xc0, 0x33, 0xf1, [0x81]), [0xc1, 0x33, 0xf1, 0x81, 0x66]);
  // the same function the session builds its requests with, so a probe cannot drift from the tool
  const { addressedFrame, checksum } = require('../src/kwp');
  assert.equal(kit.buildFrame, addressedFrame);
  assert.equal(kit.checksum, checksum);
  const long = Array.from({ length: 64 }, (_, i) => i);
  const frame = kit.buildFrame(0x80, 0x11, 0xf1, long);
  assert.deepEqual(frame.slice(0, 4), [0x80, 0x11, 0xf1, 64], 'data over 63 bytes gets a separate length byte');
  assert.equal(frame.at(-1), checksum(frame.slice(0, -1)));
  assert.deepEqual(kit.withChecksum([0x72, 0x05, 0x00, 0xf0], { twosComplement: true }), [0x72, 0x05, 0x00, 0xf0, 0x99]);
  assert.equal(kit.hex([]), '(nothing)');
  assert.equal(kit.hex([0x0a, 0xff]), '0a ff');
});

test('stripEcho has one meaning: leading zeros and our own frame go, the rest is the ECU', () => {
  const req = [0x81, 0x11, 0xf1, 0x81, 0x04];
  assert.deepEqual(kit.stripEcho(req, [0x00, ...req, 0xc1, 0xea]), { ecu: [0xc1, 0xea], echoed: true });
  assert.deepEqual(kit.stripEcho(req, req), { ecu: [], echoed: true });
  assert.deepEqual(kit.stripEcho(req, [0x81, 0x11]), { ecu: [0x81, 0x11], echoed: false }, 'a cut-off echo is not stripped');
  assert.deepEqual(kit.stripEcho([0x00, 0x55], [0x00, 0x55, 0x01]).ecu, [0x01], 'a request that starts with 0x00 keeps its zero');

  const lines = [];
  assert.equal(kit.reportHeard('row', req, req, (l) => lines.push(l)), false);
  assert.equal(kit.reportHeard('row', req, [...req, 0x7f], (l) => lines.push(l)), true);
  assert.match(lines[0], /silent$/);
  assert.match(lines[1], /ECU BYTES -> 7f {3}<=== ANSWERED$/);
});

test('power check: clean echo, no echo and garbled echo are told apart', async () => {
  const mock = new MockEcuTransport();
  const ok = await kit.checkPower(mock, { clock: mock.clock });
  assert.equal(ok.verdict, 'ok');
  assert.deepEqual(ok.heard, ok.sent);

  const dead = await kit.checkPower(stubLine(() => []), { clock: fakeClock() });
  assert.equal(dead.verdict, 'none');

  const noisy = await kit.checkPower(stubLine((b) => b.map((x) => x ^ 1)), { clock: fakeClock() });
  assert.equal(noisy.verdict, 'garbled');

  await assert.rejects(() => kit.requirePower(stubLine(() => []), { clock: fakeClock() }), kit.ProbeError);
  await kit.requirePower(new MockEcuTransport(), { clock: fakeClock() });
});

test('capture collects what arrives inside the window, with timing, and drain empties the buffer', async () => {
  const t = new MockEcuTransport();
  await t.write([1, 2, 3]);
  const before = t.clock.now();
  const timed = await kit.captureTimed(t, 100, { clock: t.clock });
  assert.deepEqual(timed.map((x) => x.b), [1, 2, 3]);
  assert.ok(timed.every((x) => x.at === 0));
  assert.equal(t.clock.now() - before, 100, 'the window is waited out when the line goes quiet');

  await t.write([9, 8]);
  assert.deepEqual(await kit.capture(t, 10, { clock: t.clock }), [9, 8]);
  await t.write([7]);
  assert.deepEqual(await kit.drain(t), [7]);
  assert.deepEqual(await kit.drain(t), []);
});

test('wake() is the tool wake-up: same line events, same answer', async () => {
  const viaTool = new MockEcuTransport({ target: 0xd5 });
  await wakeEcu(viaTool, { clock: viaTool.clock, targets: [], bike: FAST_BIKE });

  const viaKit = new MockEcuTransport({ target: 0xd5 });
  const r = await kit.wake(viaKit, { target: 0xd5, source: 0xf5 }, { clock: viaKit.clock });
  assert.equal(r.answered, true);
  assert.deepEqual(r.keyBytes, [0xea, 0x8f]);
  assert.deepEqual(viaKit.trace(), viaTool.trace());
  assert.deepEqual(viaKit.pulses, viaTool.pulses);
});

test('wake() reports silence the way scan would hit it, then settles before the next attempt', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const r = await kit.wake(t, { target: 0x11 }, { clock: t.clock });
  assert.equal(r.answered, false);
  assert.equal(r.error.kind, 'timeout');
  assert.deepEqual(r.heard, []);
  assert.equal(t.clock.sleeps.at(-1), 350);

  // Triumph ECUs need the long low: a "silent" break-mode wake predicts a silent scan
  const triumph = new MockEcuTransport({ target: 0xd5, requireLongLow: true });
  const plain = await kit.wake(triumph, { target: 0xd5, source: 0xf5 }, { clock: triumph.clock, initMode: 'break' });
  assert.equal(plain.answered, false);
  const baud = await kit.wake(triumph, { target: 0xd5, source: 0xf5 }, { clock: triumph.clock });
  assert.equal(baud.answered, true);
});

test('raw baud pulse: the variants differ from the tool wake-up exactly as asked', async () => {
  const req = kit.buildFrame(0x80, 0xd5, 0xf5, [0x81]);
  const probe = async (mockOpts, pulse) => {
    const t = new MockEcuTransport({ target: 0xd5, ...mockOpts });
    await kit.baudPulse(t, { clock: t.clock, ...pulse });
    await t.write(req);
    const heard = await kit.capture(t, 700, { clock: t.clock });
    return { t, ecu: kit.stripEcho(req, heard).ecu };
  };

  const toolLike = await probe({ requireLongLow: true }, { idleMs: 320, preLowMs: 200, switchAtMs: 'echo' });
  assert.deepEqual(toolLike.t.pulses, [{ style: 'baud', idleMs: 320, lowMs: 25, preLowMs: 200, valid: true }]);
  assert.ok(toolLike.ecu.length > 0, 'ECU answers a pulse with the 200 ms pre-low');

  const noPreLow = await probe({ requireLongLow: true }, { switchAtMs: 'echo' });
  assert.deepEqual(noPreLow.ecu, [], 'without the pre-low a Triumph ECU stays silent');

  const timed = await probe({}, { switchAtMs: 30, readyAtMs: 51 });
  assert.ok(timed.ecu.length > 0);
  const i = timed.t.events.findIndex((e) => e.type === 'write' && e.bytes[0] === 0x00);
  assert.equal(timed.t.gap(i, i + 1), 30, 'back to 10400 baud 30 ms after the 0x00 byte');
  assert.equal(timed.t.events[i + 1].baud, 10400);
});

test('raw break pulse holds the line low and high for the asked times', async () => {
  const t = new MockEcuTransport();
  await kit.breakPulse(t, { clock: t.clock, idleMs: 400, lowMs: 70, highMs: 130 });
  const on = t.events.findIndex((e) => e.type === 'break' && e.on);
  assert.equal(t.gap(on, on + 1), 70);
  assert.equal(t.clock.now() - t.events[on].at, 200);
  assert.deepEqual(t.pulses.map((p) => [p.style, p.lowMs, p.idleMs >= 400]), [['break', 70, true]]);
});

/** A K-line with nobody on it, plus bytes that appear on the first read after the address has gone out. */
function lineWithBytes(bytes) {
  const t = new MockEcuTransport();
  const realRead = t.readByte.bind(t);
  let injected = false;
  t.readByte = async (ms) => {
    if (!injected) { injected = true; t.rxBuf.push(...bytes); }
    return realRead(ms);
  };
  return t;
}

const breakLevels = (t) => t.events.filter((e) => e.type === 'break').map((e) => (e.on ? 0 : 1));

test('slow init bit-bangs the address LSB first on the break line, edges on time', async () => {
  const t = new MockEcuTransport();
  const r = await kit.slowInit(t, 0x33, { clock: t.clock, bitMs: 200, listenMs: 100 });
  // start 0, bits 1 1 0 0 1 1 0 0 (LSB first), stop 1; a 0 bit is break on
  assert.deepEqual(breakLevels(t).slice(0, 10), [0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const first = t.events.find((x) => x.type === 'break').at;
  const edges = t.events.filter((e) => e.type === 'break').slice(0, 10).map((e) => e.at - first);
  assert.deepEqual(edges, [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]);
  assert.equal(r.edgeError, 0);
  assert.equal(r.sync, null);
  assert.deepEqual(r.heard, []);

  const bike = new MockEcuTransport();
  await kit.slowInit(bike, 0x33, { clock: bike.clock, listenMs: 10 });
  const at = bike.events.filter((e) => e.type === 'break').map((e) => e.at);
  assert.equal(at[1] - at[0], 196, 'the default bit time is the one the real bike answered to');

  const sleepy = new MockEcuTransport();
  const s = await kit.slowInit(sleepy, 0x11, { clock: sleepy.clock, listenMs: 10, precise: false });
  assert.equal(s.edgeError, null);
  assert.equal(sleepy.events.filter((e) => e.type === 'break').length, 11);
});

test('slow init can add a parity bit before the stop bit', async () => {
  // 0x33 has four 1 bits: odd parity needs a 1, even a 0
  const odd = new MockEcuTransport();
  await kit.slowInit(odd, 0x33, { clock: odd.clock, listenMs: 10, parity: 'odd' });
  assert.deepEqual(breakLevels(odd).slice(0, 11), [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
  const even = new MockEcuTransport();
  await kit.slowInit(even, 0x33, { clock: even.clock, listenMs: 10, parity: 'even' });
  assert.deepEqual(breakLevels(even).slice(0, 11), [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1]);
});

test('slow init recognises the sync byte and acknowledges with ~KB2', async () => {
  const t = lineWithBytes([0x55, 0xea, 0x8f]);
  const r = await kit.slowInit(t, 0x33, { clock: t.clock, listenMs: 100 });
  assert.deepEqual(r.sync, { kb1: 0xea, kb2: 0x8f });
  assert.deepEqual(r.heard, [0x55, 0xea, 0x8f]);
  const a = await kit.ackKb2(t, r.sync.kb2, { clock: t.clock });
  assert.equal(a.ack, 0x70);
  assert.deepEqual(a.heard, [0x70], 'the K-line echoes the acknowledgement');
});

test('slow init skips junk before the sync, and with no sync it waits the whole window and reports what it heard', async () => {
  const junk = lineWithBytes([0x00, 0xfe, 0x55, 0x08, 0x08]);
  const r = await kit.slowInit(junk, 0x33, { clock: junk.clock, listenMs: 100 });
  assert.deepEqual(r.sync, { kb1: 0x08, kb2: 0x08 });
  assert.deepEqual(r.heard, [0x00, 0xfe, 0x55, 0x08, 0x08]);

  const none = lineWithBytes([0x00, 0xfe]);
  const before = none.clock.now();
  const q = await kit.slowInit(none, 0x33, { clock: none.clock, listenMs: 1500 });
  assert.equal(q.sync, null);
  assert.deepEqual(q.heard, [0x00, 0xfe]);
  assert.ok(none.clock.now() - before >= 1960 + 1500, 'the listen window runs out after the last byte');

  const half = lineWithBytes([0x55, 0x08]);
  assert.equal((await kit.slowInit(half, 0x33, { clock: half.clock, listenMs: 100 })).sync, null, 'sync without both key bytes is not a sync');
});

test('slow init returns as soon as the key bytes are in, so ~KB2 lands inside the W4 window', async () => {
  const t = new MockEcuTransport({ iso9141: true, w1Ms: 150 });
  await t.clock.sleep(3000); // the ECU wants bus idle before an address
  const r = await kit.slowInit(t, 0x33, { clock: t.clock });
  assert.deepEqual(r.sync, { kb1: 0x08, kb2: 0x08 });
  assert.deepEqual(r.heard, [0x55, 0x08, 0x08], 'the break garbage was flushed, nothing is waited out after KB2');

  const a = await kit.ackKb2(t, r.sync.kb2, { clock: t.clock, stopAfter: 2 });
  assert.equal(t.acks.length, 1);
  assert.equal(t.acks[0].delayMs, 28);
  assert.equal(t.acks[0].ok, true);
  assert.deepEqual(a.heard, [0xf7, 0xcc], 'our echo, then ~address from the ECU');
  assert.equal(t.slowInits[0].acknowledged, true);
});

test('ackKb2 measures its delay from the call, and an acknowledgement sent late is ignored by the ECU', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  await t.clock.sleep(3000);
  const r = await kit.slowInit(t, 0x33, { clock: t.clock });
  const a = await kit.ackKb2(t, r.sync.kb2, { clock: t.clock, delayMs: 1200, listenMs: 300 });
  assert.equal(t.acks[0].delayMs, 1200);
  assert.equal(t.acks[0].ok, false);
  assert.deepEqual(a.heard, [0xf7], 'only our own echo comes back');
});

test('capture can stop after a number of bytes', async () => {
  const t = new MockEcuTransport();
  await t.write([1, 2, 3]);
  assert.deepEqual(await kit.capture(t, 100, { clock: t.clock, max: 2 }), [1, 2]);
  assert.deepEqual(await kit.capture(t, 100, { clock: t.clock, max: 0 }), []);
});

test('slowHandshake retries like the tool and reports the whole exchange', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 3 });
  const tries = [];
  const r = await kit.slowHandshake(t, 0x33, { clock: t.clock, tries: 6, onTry: (n, of) => tries.push([n, of]) });
  assert.equal(r.tries, 3);
  assert.deepEqual(tries, [[1, 6], [2, 6], [3, 6]]);
  assert.deepEqual(r.sync, { kb1: 0x08, kb2: 0x08 });
  assert.deepEqual([r.ack, r.echoed, r.reply, r.completed], [0xf7, true, 0xcc, true]);
  assert.deepEqual(t.slowInits.map((i) => i.valid), [true, true, true]);
  assert.ok(t.slowInits[0].idleMs >= 3000 && t.slowInits[1].idleMs >= 6000);
  assert.deepEqual(t.acks.map((a) => a.ok), [true]);

  const dead = new MockEcuTransport({ iso9141: true, answerOnTry: 9 });
  const d = await kit.slowHandshake(dead, 0x33, { clock: dead.clock, tries: 2 });
  assert.deepEqual([d.tries, d.sync, d.ack, d.completed], [2, null, null, false]);

  const late = new MockEcuTransport({ iso9141: true });
  const l = await kit.slowHandshake(late, 0x33, { clock: late.clock, delayMs: 1200 });
  assert.deepEqual(l.sync, { kb1: 0x08, kb2: 0x08 });
  assert.deepEqual([l.ack, l.reply, l.completed], [0xf7, null, false], 'key bytes came, the ECU never answered the late ~KB2');

  const wrong = new MockEcuTransport({ iso9141: true, address: 0x11 });
  const w = await kit.slowHandshake(wrong, 0x33, { clock: wrong.clock });
  assert.equal(w.sync, null, 'an ECU at another address stays silent');
});

test('wake() makes a slow attempt the way the tool does, with retries', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 2 });
  const r = await kit.wake(t, { kind: 'slow', address: 0x33 }, { clock: t.clock, tries: 3 });
  assert.equal(r.answered, true);
  assert.equal(r.tries, 2);
  assert.deepEqual(r.keyBytes, [0x08, 0x08]);
  assert.equal(r.session.style, 'iso9141');

  const dead = new MockEcuTransport({ iso9141: true, answerOnTry: 9 });
  const d = await kit.wake(dead, { kind: 'slow', address: 0x33 }, { clock: dead.clock, tries: 2 });
  assert.equal(d.answered, false);
  assert.equal(d.tries, 2);
  assert.equal(d.error.kind, 'timeout');
  assert.equal(dead.clock.sleeps.at(-1), 350);
  assert.equal(dead.slowInits.length, 2);
});

test('timer accuracy reports what sleep really took', async () => {
  const clock = fakeClock();
  assert.deepEqual(await kit.timerAccuracy(25, 3, { clock }), [25, 25, 25]);
});
