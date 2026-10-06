'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { KwpSession, FAILURE } = require('../src/kwp');
const { wakeEcu, tryWakeUp, attemptOrder } = require('../src/wakeup');
const { realClock, waitUntil } = require('../src/clock');
const { defineBike, DEFAULT_BIKE } = require('../src/bikes');
const { MockEcuTransport } = require('./mockecu');
const { frameTargets, FAST_BIKE } = require('./helpers');

const START_COMM_D5 = 'tx:81 d5 f5 81 cc';
const SLOW_33_BIKE = (tries) => defineBike({ id: 'slow-test', name: 'slow', dataBlockId: 0, wake: { attempts: [{ kind: 'slow', address: 0x33, tries }] } });
const breakEdges = (t) => t.events.filter((e) => e.type === 'break');

// ---- fast init ---------------------------------------------------------

test('baud-trick wake-up: idle, 200 ms low, 360-baud 0x00, back to 10400, then StartCommunication', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const r = await wakeEcu(t, { clock: t.clock, bike: FAST_BIKE });

  assert.deepEqual(t.trace(), [
    'flush',
    'baud:360', 'break:on', 'break:off', 'flush', 'tx:00', 'baud:10400',
    'flush', START_COMM_D5,
  ]);
  assert.equal(t.clock.sleeps[0], 320, 'bus idle before the pulse');
  assert.equal(t.gap(2, 3), 200, 'break held 200 ms');
  assert.deepEqual(t.pulses, [{ style: 'baud', idleMs: 320, lowMs: 25, preLowMs: 200, valid: true }]);
  assert.deepEqual(r.keyBytes, [0xea, 0x8f]);
  assert.equal(r.target, 0xd5);
  assert.equal(r.kind, 'fast');
  assert.equal(r.style, 'addressed');
});

test("break-mode wake-up: 25 ms break, then the requested high time", async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  await wakeEcu(t, { clock: t.clock, bike: FAST_BIKE, initMode: 'break', highMs: 30 });

  assert.deepEqual(t.trace(), ['flush', 'break:on', 'break:off', 'flush', START_COMM_D5]);
  assert.deepEqual(t.clock.sleeps, [320, 25, 30]);
  assert.deepEqual(t.pulses.map((p) => [p.style, p.lowMs, p.valid]), [['break', 25, true]]);
});

test('the ECU stays silent unless the wake-up was performed', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const session = new KwpSession(t, { target: 0xd5, source: 0xf5, clock: t.clock });
  await assert.rejects(() => session.startCommunication(), (e) => e.kind === FAILURE.TIMEOUT);
  assert.deepEqual(t.requests, []);
});

test('a pulse that comes too soon after bus traffic is ignored by the ECU', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const { session } = await tryWakeUp(t, { target: 0xd5, source: 0xf5 }, { clock: t.clock });
  // second pulse with no bus idle in front of it
  await t.setBreak(true);
  await t.clock.sleep(25);
  await t.setBreak(false);
  await assert.rejects(() => session.startCommunication(), (e) => e.kind === FAILURE.TIMEOUT);
  assert.equal(t.pulses.at(-1).valid, false);
});

test('Triumph ECUs need the long low: baud-mode wake-up works, plain break does not', async () => {
  const fast = new MockEcuTransport({ target: 0xd5, requireLongLow: true });
  await wakeEcu(fast, { clock: fast.clock, bike: FAST_BIKE, targets: [] });

  const plain = new MockEcuTransport({ target: 0xd5, requireLongLow: true });
  await assert.rejects(() => wakeEcu(plain, { clock: plain.clock, bike: FAST_BIKE, initMode: 'break', targets: [] }), /No ECU answered/);
});

test('fast order: D5/F5, functional 0x33, then the generic targets, settling between attempts', async () => {
  const t = new MockEcuTransport({ target: 0x51 });
  const progress = [];
  const r = await wakeEcu(t, { clock: t.clock, bike: FAST_BIKE, onProgress: (e) => progress.push(`${e.step}:${e.attempt.target.toString(16)}:${e.attempt.addrMode}`) });

  const sent = frameTargets(t);
  assert.deepEqual(
    sent.map((f) => `${f.fmt.toString(16)}/${f.target.toString(16)}`),
    ['81/d5', 'c1/33', '81/11', '81/10', '81/12', '81/2', '81/1', '81/33', '81/3f', '81/51']
  );
  assert.deepEqual([sent[0].source, sent[1].source, sent[2].source], [0xf5, 0xf1, 0xf1]);
  assert.equal(t.clock.sleeps.filter((ms) => ms === 350).length, 9, 'settle after each failed attempt');
  assert.equal(t.pulses.length, 10);
  assert.ok(t.pulses.every((p) => p.idleMs >= 320));
  assert.equal(r.target, 0x51);
  assert.equal(r.saved, false);
  assert.equal(progress[0], 'attempt:d5:phys');
  assert.equal(progress[1], 'attempt-failed:d5:phys');
  assert.equal(progress.at(-1), 'attempt:51:phys');
});

test('the result carries the addressing mode that worked, and replaying it connects on the first pulse', async () => {
  const first = new MockEcuTransport({ target: 0x33, funcOnly: true });
  const r = await wakeEcu(first, { clock: first.clock, bike: FAST_BIKE });
  assert.equal(r.addrMode, 'func');
  assert.equal(r.target, 0x33);
  assert.equal(r.session.addrMode, 'func');
  assert.deepEqual(r.replay, { kind: 'fast', target: 0x33, source: 0xf1, addrMode: 'func' });

  const again = new MockEcuTransport({ target: 0x33, funcOnly: true });
  const r2 = await wakeEcu(again, { clock: again.clock, bike: FAST_BIKE, prefer: r.replay });
  assert.equal(again.pulses.length, 1);
  assert.equal(r2.saved, true);
  assert.equal(r2.addrMode, 'func');

  // the same address in the wrong mode would have needed a scan
  const wrong = new MockEcuTransport({ target: 0x33, funcOnly: true });
  const r3 = await wakeEcu(wrong, { clock: wrong.clock, bike: FAST_BIKE, prefer: { target: 0x33, addrMode: 'phys' } });
  assert.equal(r3.saved, false);
  assert.ok(wrong.pulses.length > 1);
});

test('a saved address that fails falls through to the normal scan order', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const r = await wakeEcu(t, { clock: t.clock, bike: FAST_BIKE, prefer: { target: 0x77, addrMode: 'phys' } });
  assert.deepEqual(
    frameTargets(t).map((f) => f.target),
    [0x77, 0xd5]
  );
  assert.equal(r.saved, false);
  assert.equal(r.target, 0xd5);
});

test('no answer anywhere: error lists every attempt', async () => {
  const t = new MockEcuTransport({ target: 0x99 });
  await assert.rejects(
    () => wakeEcu(t, { clock: t.clock, bike: FAST_BIKE }),
    (e) => /No ECU answered/.test(e.message) && e.attempts.length === 10 && /^fast init 0xd5 \(phys\): no response/.test(e.attempts[0])
  );
});

// ---- slow init (ISO 9141-2) -------------------------------------------------

test('slow init: the address goes out at 5 baud on the break line on absolute edges, ~KB2 follows inside W4', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  const progress = [];
  const r = await wakeEcu(t, { clock: t.clock, onProgress: (e) => progress.push(`${e.step}:${e.attempt.text}`) });

  // 0x33 = 00110011: start 0, data 1 1 0 0 1 1 0 0 (LSB first), stop 1
  assert.deepEqual(t.trace(), [
    'break:on', 'break:off', 'break:off', 'break:on', 'break:on', 'break:off', 'break:off', 'break:on', 'break:on', 'break:off',
    'break:off', 'flush', 'flush', 'tx:f7',
  ]);
  const edges = breakEdges(t);
  assert.deepEqual(edges.map((e) => e.at - edges[0].at), [0, 196, 392, 588, 784, 980, 1176, 1372, 1568, 1764, 1960]);
  assert.equal(t.clock.sleeps[0], 3000, 'bus idle before the first try');

  assert.equal(t.slowInits.length, 1);
  assert.deepEqual(
    { ...t.slowInits[0], at: undefined },
    { at: undefined, address: 0x33, idleMs: 3000, valid: true, why: null, answered: true, ackDelayMs: 28, acknowledged: true }
  );
  assert.equal(t.pulses.length, 0, 'no fast-init pulse was made');
  assert.deepEqual(progress, ['attempt:slow init 0x33, try 1/6']);

  assert.equal(r.kind, 'slow');
  assert.equal(r.style, 'iso9141');
  assert.equal(r.session.style, 'iso9141');
  assert.equal(r.address, 0x33);
  assert.equal(r.target, 0x33);
  assert.equal(r.saved, false);
  assert.deepEqual(r.keyBytes, [0x08, 0x08]);
  assert.deepEqual(r.session.keyBytes, [0x08, 0x08]);
  assert.deepEqual(r.replay, { kind: 'slow', address: 0x33 });
  assert.equal((await r.session.request([0x01, 0x00])).payload.length, 6, 'the session is usable right away');
});

test('a late acknowledgement is ignored by the ECU, so the wake-up fails and says why', async () => {
  const t = new MockEcuTransport({ iso9141: true });
  // The tester stalls 1.2 s between reading KB2 and sending ~KB2, like a helper that kept capturing for a fixed window first.
  const stalled = {
    flushInput: () => t.flushInput(),
    readByte: (ms) => t.readByte(ms),
    setBreak: (on) => t.setBreak(on),
    setBaud: (b) => t.setBaud(b),
    write: async (bytes) => {
      t.clock.t += 1200;
      return t.write(bytes);
    },
  };
  await assert.rejects(
    () => wakeEcu(stalled, { clock: t.clock, bike: SLOW_33_BIKE(2), targets: [] }),
    (e) => e.attempts.length === 2 && /slow init 0x33, try 2\/2: key bytes 08 08 but the acknowledgement drew no reply/.test(e.attempts[1])
  );
  assert.equal(t.acks.length, 2);
  assert.ok(t.acks.every((a) => !a.ok && a.delayMs >= 1200));
});

test('the mock ECU only answers a well formed 5-baud address after enough bus idle', async () => {
  const send = async (address, { bitMs = 196, parityBit = null, idleMs = 3000 } = {}) => {
    const t = new MockEcuTransport({ iso9141: true });
    await t.clock.sleep(idleMs);
    const bits = [0, ...Array.from({ length: 8 }, (_, i) => (address >> i) & 1), ...(parityBit === null ? [] : [parityBit]), 1];
    const t0 = t.clock.now();
    for (let i = 0; i < bits.length; i++) {
      await waitUntil(t.clock, t0 + i * bitMs);
      await t.setBreak(bits[i] === 0);
    }
    await waitUntil(t.clock, t0 + bits.length * bitMs);
    await t.setBreak(false);
    await t.flushInput();
    return { heard: await t.readByte(1500), t };
  };

  assert.equal((await send(0x33)).heard, 0x55);
  assert.equal((await send(0x33, { bitMs: 182 })).heard, 0x55, 'inside +-10 %');
  assert.equal((await send(0x33, { bitMs: 217 })).heard, 0x55, 'inside +-10 %');
  assert.equal((await send(0x33, { bitMs: 150 })).heard, null, 'bit time too short');
  assert.equal((await send(0x33, { bitMs: 240 })).heard, null, 'bit time too long');
  assert.equal((await send(0x33, { parityBit: 0 })).heard, null, 'a parity bit that is low breaks the framing: the ECU wants no parity');
  const wrong = await send(0x34);
  assert.equal(wrong.heard, null);
  assert.match(wrong.t.slowInits[0].why, /address 0x34 is not ours/);
  const early = await send(0x33, { idleMs: 2900 });
  assert.equal(early.heard, null);
  assert.match(early.t.slowInits[0].why, /bus idle only 2900 ms/);
});

test('the mock ECU wants ~KB2 20-100 ms after KB2 and nothing else will do', async () => {
  const handshake = async (ackAfterMs, ack = 0xf7) => {
    const t = new MockEcuTransport({ iso9141: true });
    await t.clock.sleep(3000);
    const bits = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
    const t0 = t.clock.now();
    for (let i = 0; i < bits.length; i++) {
      await waitUntil(t.clock, t0 + i * 196);
      await t.setBreak(bits[i] === 0);
    }
    await waitUntil(t.clock, t0 + 1960);
    await t.setBreak(false);
    await t.flushInput();
    assert.deepEqual([await t.readByte(1500), await t.readByte(200), await t.readByte(200)], [0x55, 0x08, 0x08]);
    await t.clock.sleep(ackAfterMs);
    await t.flushInput();
    await t.write([ack]);
    assert.equal(await t.readByte(400), ack, 'own echo');
    return t.readByte(400);
  };
  assert.equal(await handshake(28), 0xcc);
  assert.equal(await handshake(20), 0xcc);
  assert.equal(await handshake(100), 0xcc);
  assert.equal(await handshake(10), null, 'early');
  assert.equal(await handshake(150), null, 'late');
  assert.equal(await handshake(1500), null, 'very late');
  assert.equal(await handshake(28, 0xf8), null, 'wrong byte');
});

test('an ECU that answers only the third try: found there, tries spaced 6 s, first after 3 s idle', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 3 });
  const progress = [];
  const r = await wakeEcu(t, { clock: t.clock, onProgress: (e) => progress.push(`${e.step}:${e.attempt.text}`) });

  assert.deepEqual(progress, [
    'attempt:slow init 0x33, try 1/6', 'attempt-failed:slow init 0x33, try 1/6',
    'attempt:slow init 0x33, try 2/6', 'attempt-failed:slow init 0x33, try 2/6',
    'attempt:slow init 0x33, try 3/6',
  ]);
  assert.deepEqual(t.clock.sleeps.filter((ms) => ms === 3000 || ms === 6000), [3000, 6000, 6000]);
  assert.deepEqual(t.slowInits.map((i) => i.answered), [false, false, true]);
  assert.ok(t.slowInits.every((i) => i.valid));
  assert.equal(t.slowInits[0].idleMs, 3000);
  // start to start: the 1960 ms address + 1500 ms waiting for a sync that never comes + the 6 s retry spacing
  assert.deepEqual([t.slowInits[1].at - t.slowInits[0].at, t.slowInits[2].at - t.slowInits[1].at], [9460, 9460]);
  assert.equal(t.pulses.length, 0);
  assert.equal(r.kind, 'slow');
});

test('slow init that never gets an answer: six tries, then the fast attempts, then the generic targets', async () => {
  const t = new MockEcuTransport({ iso9141: true, answerOnTry: 99 });
  const kinds = [];
  await assert.rejects(
    () => wakeEcu(t, { clock: t.clock, onProgress: (e) => e.step === 'attempt' && kinds.push(e.attempt.text) }),
    (e) => {
      assert.equal(e.attempts.length, 6 + 2 + 8);
      assert.match(e.attempts[0], /^slow init 0x33, try 1\/6: no 0x55 sync$/);
      assert.match(e.attempts[6], /^fast init 0xd5 \(phys\): no response/);
      return true;
    }
  );
  assert.deepEqual(kinds.slice(0, 7), [1, 2, 3, 4, 5, 6].map((n) => `slow init 0x33, try ${n}/6`).concat('fast init 0xd5 (phys)'));
  assert.deepEqual(kinds.slice(7, 9), ['fast init 0x33 (func)', 'fast init 0x11 (phys)']);
  assert.deepEqual(t.requests, [], 'fast init is silent on this ECU, as on the bike');
});

test('a fast-init-only ECU is still found, after the slow tries fail', async () => {
  const t = new MockEcuTransport({ target: 0xd5 });
  const r = await wakeEcu(t, { clock: t.clock });
  assert.equal(r.kind, 'fast');
  assert.equal(r.style, 'addressed');
  assert.equal(r.address, null);
  assert.equal(r.target, 0xd5);
  assert.deepEqual(r.replay, { kind: 'fast', target: 0xd5, source: 0xf5, addrMode: 'phys' });
  assert.equal(t.clock.sleeps.filter((ms) => ms === 3000).length, 1);
  assert.equal(t.clock.sleeps.filter((ms) => ms === 6000).length, 5);
  assert.equal(t.pulses.length, 1);
});

test('slow init answering with key bytes other than KB2 = 08 is refused', async () => {
  const t = new MockEcuTransport({ iso9141: true, keyBytes: [0x8f, 0x8f] });
  await assert.rejects(
    () => wakeEcu(t, { clock: t.clock, bike: SLOW_33_BIKE(1), targets: [] }),
    (e) => /only KB2 08 \(ISO 9141-2 framing\) is supported/.test(e.attempts[0])
  );
});

test('replaying a saved slow init connects on the first try; if it fails the bike order follows without repeating it', async () => {
  const first = new MockEcuTransport({ iso9141: true });
  const r = await wakeEcu(first, { clock: first.clock });

  const again = new MockEcuTransport({ iso9141: true });
  const r2 = await wakeEcu(again, { clock: again.clock, prefer: r.replay });
  assert.equal(again.slowInits.length, 1);
  assert.equal(r2.saved, true);
  assert.deepEqual(r2.replay, r.replay);

  const gone = new MockEcuTransport({ target: 0xd5 });
  const r3 = await wakeEcu(gone, { clock: gone.clock, prefer: r.replay });
  assert.equal(r3.saved, false);
  assert.equal(r3.kind, 'fast');
  assert.equal(gone.clock.sleeps.filter((ms) => ms === 3000).length, 1, 'the saved slow init was tried once over, not repeated by the bike order');
  assert.equal(gone.clock.sleeps.filter((ms) => ms === 6000).length, 5);
});

test('attemptOrder: saved first, then the bike, then generic fast targets; a repeat of the saved one is dropped', () => {
  const show = (order) =>
    order.map((a) => (a.kind === 'slow' ? `slow/${a.address.toString(16)}x${a.tries}` : `${a.target.toString(16)}/${a.addrMode}`) + (a.saved ? '*' : ''));

  assert.deepEqual(show(attemptOrder({ targets: [0x10] })), ['slow/33x6', 'd5/phys', '33/func', '10/phys']);
  assert.deepEqual(show(attemptOrder({ bike: FAST_BIKE, prefer: { target: 0x11, addrMode: 'phys' }, targets: [0x10] })), ['11/phys*', 'd5/phys', '33/func', '10/phys']);
  assert.deepEqual(show(attemptOrder({ prefer: { kind: 'slow', address: 0x33 }, targets: [] })), ['slow/33x6*', 'd5/phys', '33/func']);
  assert.deepEqual(show(attemptOrder({ prefer: { kind: 'fast', target: 0xd5, source: 0xf5, addrMode: 'phys' }, targets: [] })), ['d5/phys*', 'slow/33x6', '33/func']);
  assert.equal(DEFAULT_BIKE.wake.attempts[0].kind, 'slow');
});

test('waitUntil: sleeps the difference on a plain clock, spins to the minute on the real one', async () => {
  const t = new MockEcuTransport();
  const at = t.clock.now() + 196;
  await waitUntil(t.clock, at);
  assert.equal(t.clock.now(), at);
  await waitUntil(t.clock, at - 50);
  assert.equal(t.clock.now(), at, 'a time already past is not waited for');

  const target = realClock.now() + 35;
  await waitUntil(realClock, target);
  assert.ok(realClock.now() >= target);
});
