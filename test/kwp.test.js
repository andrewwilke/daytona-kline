'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { KwpError, KwpNegativeResponse, FAILURE } = require('../src/kwp');
const svc = require('../src/services');
const { awakeSession } = require('./helpers');

const count = (t, service) => t.requests.filter((r) => r.service === service).length;
const kind = (k) => (e) => e instanceof KwpError && e.kind === k;

test('request returns the first reply as payload and, by default, only that frame', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const reply = await session.request([0x3e]);
  assert.deepEqual(reply.payload, [0x7e]);
  assert.deepEqual(reply.frames, [[0x7e]]);
});

test('multiFrame collects every reply frame of an OBD mode 03 answer', async () => {
  const { t, session } = await awakeSession({ target: 0xd5, obd: true }, { source: 0xf5 });
  const one = await session.request([0x03]);
  assert.equal(one.frames.length, 1);
  const all = await session.request([0x03], { multiFrame: true });
  assert.equal(all.frames.length, 2);
  assert.ok(all.frames.every((f) => f[0] === 0x43));
  assert.equal(count(t, 0x03), 2);
});

test('responsePending (7F xx 78) extends the wait for the real answer', async () => {
  const { session } = await awakeSession({ target: 0x10 });
  const { payload } = await session.request([0x18, 0, 0, 0]);
  assert.equal(payload[0], 0x58);
});

test('a negative response throws with service and code, and is never retried', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  await assert.rejects(() => session.request([0x1a, 0x81]), (e) => {
    assert.ok(e instanceof KwpNegativeResponse);
    assert.equal(e.kind, FAILURE.NEGATIVE_RESPONSE);
    assert.equal(e.service, 0x1a);
    assert.equal(e.code, 0x12);
    return true;
  });
  assert.equal(count(t, 0x1a), 1);
});

test('a reply to some other service is rejected as wrong-service, not retried', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('wrongService', { service: 0x1a });
  await assert.rejects(() => session.request([0x1a, 0x80]), kind(FAILURE.WRONG_SERVICE));
  assert.equal(count(t, 0x1a), 1);
});

test('dropped reply: retried once by default, then timeout', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('dropReply', { service: 0x1a });
  const ok = await session.request([0x1a, 0x80]);
  assert.equal(ok.payload[0], 0x5a);
  assert.equal(count(t, 0x1a), 2);

  t.inject('dropReply', { service: 0x1a, times: 2 });
  await assert.rejects(() => session.request([0x1a, 0x80]), kind(FAILURE.TIMEOUT));
  assert.equal(count(t, 0x1a), 4);
});

test('retries: 0 sends once', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('dropReply', { service: 0x3e });
  await assert.rejects(() => session.request([0x3e], { retries: 0 }), kind(FAILURE.TIMEOUT));
  assert.equal(count(t, 0x3e), 1);
});

test('corrupted reply checksum: named bad-checksum after retries are used up', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('badChecksum', { service: 0x3e });
  assert.deepEqual((await session.request([0x3e])).payload, [0x7e]);
  assert.equal(count(t, 0x3e), 2);

  t.inject('badChecksum', { service: 0x3e, times: 2 });
  await assert.rejects(() => session.request([0x3e]), kind(FAILURE.BAD_CHECKSUM));
});

test('partial echo: named echo-mismatch after retries are used up', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('partialEcho', { service: 0x3e });
  assert.deepEqual((await session.request([0x3e])).payload, [0x7e]);

  t.inject('partialEcho', { service: 0x3e, times: 2 });
  await assert.rejects(() => session.request([0x3e]), kind(FAILURE.ECHO_MISMATCH));
});

test('destructive requests are never resent, whatever retries says', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('dropReply', { service: 0x14, times: 3 });
  await assert.rejects(() => session.request([0x14, 0, 0], { destructive: true, retries: 5 }), kind(FAILURE.TIMEOUT));
  assert.equal(count(t, 0x14), 1);
});

test('clearDtcs does not resend after a timeout', async () => {
  const { t, session } = await awakeSession({ target: 0xd5, obd: true }, { source: 0xf5 });
  t.inject('dropReply', { service: 0x04, times: 3 });
  await assert.rejects(() => svc.clearDtcs(session), kind(FAILURE.TIMEOUT));
  assert.equal(count(t, 0x04), 1);
});

test('linkFailures counts consecutive link failures; any reply resets it', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  t.inject('dropReply', { service: 0x3e, times: 2 });
  await assert.rejects(() => session.request([0x3e]));
  assert.equal(session.linkFailures, 1);
  assert.equal(session.lastLinkFailure.kind, FAILURE.TIMEOUT);
  await assert.rejects(() => session.request([0x1a, 0x81]), kind(FAILURE.NEGATIVE_RESPONSE));
  assert.equal(session.linkFailures, 0, 'a negative response proves the link works');
});

test('requests over 63 bytes use the separate length byte, both ways', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  const body = Array.from({ length: 70 }, (_, i) => i);
  const { payload } = await session.request([0x77, ...body]);
  assert.equal(payload[0], 0xb7);
  assert.deepEqual(payload.slice(1), body);

  const sent = t.events.filter((e) => e.type === 'write').at(-1).bytes;
  assert.deepEqual(sent.slice(0, 4), [0x80, 0x10, 0xf1, 71], 'fmt carries no length, length byte follows the header');
  assert.equal(sent.length, 3 + 1 + 71 + 1);
});

test('replies with no address bytes are parsed, short and long', async () => {
  const { session } = await awakeSession({ target: 0x10, unaddressedReplies: true });
  assert.deepEqual((await session.request([0x3e])).payload, [0x7e]);

  const body = Array.from({ length: 80 }, (_, i) => 255 - i);
  const { payload } = await session.request([0x77, ...body]);
  assert.deepEqual(payload.slice(1), body);
});

test('requests are serialised and spaced by P3', async () => {
  const { t, session } = await awakeSession({ target: 0x10 });
  const order = [];
  const a = session.request([0x3e]).then(() => order.push('a'));
  const b = session.request([0x1a, 0x80]).then(() => order.push('b'));
  assert.equal(session.busy, true);
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(session.busy, false);
  assert.ok(t.clock.sleeps.includes(100), 'P3 gap between requests');
});

// ---- ISO 9141-2 OBD-II framing (slow init, KB2 = 0x08) ---------------------

const iso = (opts) => awakeSession({ iso9141: true, ...opts });
const lastTx = (t) => t.events.filter((e) => e.type === 'write').at(-1).bytes;
const requestTimes = (t) => t.events.filter((e) => e.type === 'write' && e.bytes[0] === 0x68).map((e) => e.at);

test('iso9141: requests are 68 6A F1 + data + sum, the echo is consumed, the reply payload comes back', async () => {
  const { t, session } = await iso();
  assert.equal(session.style, 'iso9141');
  assert.equal(session.addrMode, 'obd');

  const pids = await session.request([0x01, 0x00]);
  assert.deepEqual(lastTx(t), [0x68, 0x6a, 0xf1, 0x01, 0x00, 0xc4]);
  assert.deepEqual(pids.payload, [0x41, 0x00, 0xbc, 0x3e, 0x90, 0x10]);
  assert.deepEqual(pids.frames, [pids.payload]);

  const status = await session.request([0x01, 0x01]);
  assert.deepEqual(lastTx(t), [0x68, 0x6a, 0xf1, 0x01, 0x01, 0xc5]);
  assert.deepEqual(status.payload, [0x41, 0x01, 0x82, 0x00, 0x00, 0xff]);

  const rpm = await session.request([0x01, 0x0c]);
  assert.deepEqual(rpm.payload, [0x41, 0x0c, 0x3e, 0x80], 'a reply of any length is read until the line goes quiet');
});

test('iso9141: mode 03 answers three code slots in one frame', async () => {
  const { session } = await iso();
  const { payload } = await session.request([0x03]);
  assert.deepEqual(payload, [0x43, 0x00, 0x78, 0x11, 0x08, 0x00, 0x00]);
});

test('iso9141: any reply starting 7F is a refusal, whatever its second byte', async () => {
  const { t, session } = await iso();
  await assert.rejects(() => session.request([0x22, 0x01, 0x00]), (e) => {
    assert.ok(e instanceof KwpNegativeResponse);
    assert.equal(e.kind, FAILURE.NEGATIVE_RESPONSE);
    assert.equal(e.service, 0x22, 'the service we asked, not the 0x33 the ECU put in the second byte');
    assert.equal(e.code, 0x36);
    return true;
  });
  assert.equal(count(t, 0x22), 1, 'a refusal is not retried');
  assert.equal(session.linkFailures, 0, 'it proves the link works');
});

test('iso9141: no reply at all is a timeout; allowSilence keeps it out of linkFailures', async () => {
  const { t, session } = await iso();
  await assert.rejects(() => session.request([0x07]), kind(FAILURE.TIMEOUT));
  assert.equal(count(t, 0x07), 2, 'retried once like any link failure');
  assert.equal(session.linkFailures, 1);

  await assert.rejects(() => session.request([0x09, 0x00], { allowSilence: true, retries: 0 }), kind(FAILURE.TIMEOUT));
  await assert.rejects(() => session.request([0x01, 0x42], { allowSilence: true, retries: 0 }), kind(FAILURE.TIMEOUT));
  assert.equal(session.linkFailures, 1, 'silence the caller expected is not counted');

  await session.request([0x01, 0x00]);
  assert.equal(session.linkFailures, 0);
});

test('iso9141: the reply must answer the service asked (request + 0x40)', async () => {
  const { t, session } = await iso();
  t.inject('wrongService', { service: 0x01 });
  await assert.rejects(() => session.request([0x01, 0x05]), kind(FAILURE.WRONG_SERVICE));
  assert.equal(count(t, 0x01), 1, 'not retried');
});

test('iso9141: dropped reply is retried once, a corrupt checksum and a cut-off echo are named', async () => {
  const { t, session } = await iso();
  t.inject('dropReply', { service: 0x01 });
  assert.equal((await session.request([0x01, 0x05])).payload[2], 130);
  assert.equal(count(t, 0x01), 2);

  t.inject('badChecksum', { service: 0x01 });
  assert.equal((await session.request([0x01, 0x05])).payload[2], 130, 'retried and fine');
  t.inject('badChecksum', { service: 0x01, times: 2 });
  await assert.rejects(() => session.request([0x01, 0x05]), kind(FAILURE.BAD_CHECKSUM));

  t.inject('partialEcho', { service: 0x01, times: 2 });
  await assert.rejects(() => session.request([0x01, 0x05]), kind(FAILURE.ECHO_MISMATCH));
});

test('iso9141: multiFrame collects replies sent back to back and replies after a pause; without it only the first counts', async () => {
  for (const frameGapMs of [40, 120]) {
    const { t, session } = await iso({ frameGapMs });
    t.storedCodes = [0x0078, 0x1108, 0x0201, 0x0301];

    const all = await session.request([0x03], { multiFrame: true });
    assert.deepEqual(all.frames, [[0x43, 0x00, 0x78, 0x11, 0x08, 0x02, 0x01], [0x43, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00]], `gap ${frameGapMs} ms`);

    const one = await session.request([0x03]);
    assert.deepEqual(one.frames, [one.payload]);
    // the second frame of that answer must not be taken for the reply to the next request
    assert.deepEqual((await session.request([0x01, 0x05])).payload, [0x41, 0x05, 130]);
  }
});

test('iso9141: requests are at least 60 ms apart and serialised', async () => {
  const { t, session } = await iso();
  await Promise.all([session.request([0x01, 0x05]), session.request([0x01, 0x0f]), session.request([0x01, 0x0d])]);
  const times = requestTimes(t);
  assert.equal(times.length, 3, 'one frame per request');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 60, `gap ${times[i] - times[i - 1]}`);
});

test('iso9141: there is no StopCommunication to send, and the keep-alive is mode 01 PID 00', async () => {
  const { t, session } = await iso();
  const before = t.events.length;
  await session.stop();
  assert.equal(t.events.length, before, 'stop() puts nothing on the line');
  assert.deepEqual(session.ping.data, [0x01, 0x00]);
  assert.equal(session.ping.intervalMs, 2000);
});
