'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMultiplier, unlockSession, UnlockError } = require('../src/unlock');
const { KwpNegativeResponse } = require('../src/kwp');
const svc = require('../src/services');
const { tryWakeUp } = require('../src/wakeup');
const { awakeSession } = require('./helpers');

// Made-up values: the real multiplier is never in this repository.
const M = 0x1234;
const iso = (opts) => awakeSession({ iso9141: true, unlockMultiplier: M, ...opts });
const sent = (t, service) => t.requests.filter((r) => r.service === service);
const keyFor = (seed, m) => Number((BigInt(seed) * BigInt(m)) % 65536n);

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-unlock-'));
const fileWith = (text) => {
  const file = path.join(scratch(), 'unlock.json');
  fs.writeFileSync(file, text);
  return file;
};

// ---- loadMultiplier ---------------------------------------------------------

test('loadMultiplier: a valid file gives the multiplier, boundaries included', () => {
  assert.deepEqual(loadMultiplier(fileWith('{"multiplier": 4660}')), { multiplier: 4660 });
  assert.deepEqual(loadMultiplier(fileWith('{"multiplier": 1}')), { multiplier: 1 });
  assert.deepEqual(loadMultiplier(fileWith('{"multiplier": 65535, "note": "extra keys are fine"}')), { multiplier: 65535 });
  assert.deepEqual(loadMultiplier(fileWith('{"multiplier": 1e3}')), { multiplier: 1000 });
  assert.deepEqual(loadMultiplier(fileWith('﻿{"multiplier": 7}')), { multiplier: 7 }, 'a byte order mark is tolerated');
});

test('loadMultiplier: no file, or no path, is unavailable, not an error', () => {
  const r = loadMultiplier(path.join(scratch(), 'unlock.json'));
  assert.deepEqual(Object.keys(r), ['unavailable']);
  assert.match(r.unavailable, /no unlock file/);
  assert.deepEqual(Object.keys(loadMultiplier(null)), ['unavailable']);
  assert.deepEqual(Object.keys(loadMultiplier(undefined)), ['unavailable']);
});

test('loadMultiplier: anything that cannot be used is invalid, with a message that does not repeat the file', () => {
  const bad = {
    'not JSON': 'multiplier = 4660',
    'empty': '',
    'a bare number': '4660',
    'null': 'null',
    'an array': '[4660]',
    'no multiplier': '{"mult": 4660}',
    'zero': '{"multiplier": 0}',
    'too big': '{"multiplier": 65536}',
    'negative': '{"multiplier": -5}',
    'fraction': '{"multiplier": 4660.5}',
    'a string': '{"multiplier": "4660"}',
    'a hex string': '{"multiplier": "0x1234"}',
    'null multiplier': '{"multiplier": null}',
    'a boolean': '{"multiplier": true}',
    'a list': '{"multiplier": [4660]}',
  };
  for (const [what, text] of Object.entries(bad)) {
    const r = loadMultiplier(fileWith(text));
    assert.deepEqual(Object.keys(r), ['invalid'], what);
    assert.match(r.invalid, /multiplier/, what);
  }
  const leak = loadMultiplier(fileWith('{"multiplier": 987654}'));
  assert.ok(!leak.invalid.includes('987654'), 'the value is not echoed');
  assert.deepEqual(Object.keys(loadMultiplier(scratch())), ['invalid'], 'a directory is not a file');
});

// ---- unlockSession ----------------------------------------------------------

test('the right multiplier unlocks: one seed request, one key = seed * multiplier mod 65536', async () => {
  const { t, session } = await iso({ seed: 0x1a2b });
  assert.deepEqual(await unlockSession(session, M), { state: 'unlocked' });
  assert.deepEqual(sent(t, 0x27).map((r) => r.data), [[0x27, 0x05], [0x27, 0x06, keyFor(0x1a2b, M) >> 8, keyFor(0x1a2b, M) & 0xff]]);
  assert.equal(t.keyAttempts, 1);
  assert.equal(t.unlocked, true);
});

test('the key is the low 16 bits of the product, however large the product', async () => {
  const { t, session } = await iso({ seed: 0xffff, unlockMultiplier: 0xffff });
  await unlockSession(session, 0xffff);
  assert.deepEqual(t.keysReceived, [0x0001]); // 0xffff * 0xffff = 0xfffe0001
});

test('service 0x22 is refused before the unlock and served after it', async () => {
  const { t, session } = await iso();
  await assert.rejects(() => svc.readCommonId(session, 0x07), (e) => e instanceof KwpNegativeResponse && e.service === 0x22 && e.code === 0x36);
  await unlockSession(session, M);
  assert.deepEqual([...(await svc.readCommonId(session, 0x07))], [0, 138], 'battery');
  assert.deepEqual([...(await svc.readCommonId(session, 0x21))], [0, 8], 'gear');
  const clutch = [];
  for (let i = 0; i < 3; i++) clutch.push((await svc.readCommonId(session, 0x41))[1]);
  assert.deepEqual(clutch, [0xfe, 0xff, 0xfe], 'a switch id toggles from read to read');
  await assert.rejects(() => svc.readCommonId(session, 0x7777), (e) => e instanceof KwpNegativeResponse && e.code === 0x31, 'an id the ECU does not have');
  assert.equal(sent(t, 0x22).length, 7, 'every read reached the ECU, none was resent');
});

test('a seed of 0000 means already unlocked: no key is sent', async () => {
  const { t, session } = await iso({ seed: 0 });
  assert.deepEqual(await unlockSession(session, M), { state: 'unlocked', alreadyUnlocked: true });
  assert.equal(t.keyAttempts, 0);
  assert.equal(sent(t, 0x27).length, 1);
  assert.deepEqual([...(await svc.readCommonId(session, 0x07))], [0, 138]);
});

test('an unlocked ECU hands out 0000, so a second unlock sends no key either', async () => {
  const { t, session } = await iso();
  await unlockSession(session, M);
  assert.deepEqual(await unlockSession(session, M), { state: 'unlocked', alreadyUnlocked: true });
  assert.equal(t.keyAttempts, 1);
});

test('a wrong multiplier is key-rejected after exactly one key, with the ECU\'s code, and nothing is retried', async () => {
  const { t, session } = await iso();
  await assert.rejects(() => unlockSession(session, M + 1), (e) => e instanceof UnlockError && e.kind === 'key-rejected' && e.code === 0x35 && /refused the key \(code 0x35\)/.test(e.message));
  assert.equal(t.keyAttempts, 1);
  assert.equal(sent(t, 0x27).length, 2, 'one seed request, one key');
  assert.equal(t.unlocked, false);
  await assert.rejects(() => svc.readCommonId(session, 0x07), KwpNegativeResponse);
});

test('a refused seed request is seed-refused and no key is sent', async () => {
  const { t, session } = await iso();
  t.modes[0x27] = () => [0x7f, 0x27, 0x22];
  await assert.rejects(() => unlockSession(session, M), (e) => e.kind === 'seed-refused' && e.code === 0x22);
  assert.equal(sent(t, 0x27).length, 1);
});

test('a reply that is not a seed is bad-seed-reply: wrong service, wrong level, or the wrong length', async () => {
  for (const reply of [[0x50, 0x80], [0x67, 0x06, 0x12, 0x34], [0x67, 0x05, 0x12], [0x67, 0x05, 0x12, 0x34, 0x56]]) {
    const { t, session } = await iso();
    t.modes[0x27] = () => reply;
    await assert.rejects(() => unlockSession(session, M), (e) => e instanceof UnlockError && e.kind === 'bad-seed-reply', reply.join());
    assert.equal(sent(t, 0x27).length, 1, 'no key after a reply that is not a seed');
  }
});

test('silence to the seed request is no-reply, and the request is not resent', async () => {
  const { t, session } = await iso();
  t.inject('dropReply', { service: 0x27, times: 5 });
  await assert.rejects(() => unlockSession(session, M), (e) => e.kind === 'no-reply');
  assert.equal(sent(t, 0x27).length, 1);
  assert.equal(t.keyAttempts, 0);
});

test('silence to the key is no-reply, and the key is not resent', async () => {
  const { t, session } = await iso();
  const handler = t.modes[0x27];
  t.modes[0x27] = (level, ...rest) => (level === 0x06 ? (handler(level, ...rest), null) : handler(level, ...rest));
  await assert.rejects(() => unlockSession(session, M), (e) => e.kind === 'no-reply' && /not resent/.test(e.message));
  assert.equal(t.keyAttempts, 1);
});

test('a corrupted seed reply is no-reply as well: no key follows', async () => {
  const { t, session } = await iso();
  t.inject('badChecksum', { service: 0x27, times: 1 });
  await assert.rejects(() => unlockSession(session, M), (e) => e.kind === 'no-reply');
  assert.equal(sent(t, 0x27).length, 1);
  assert.equal(t.keyAttempts, 0);
});

test('an answer to the key that is not acceptance is key-rejected', async () => {
  for (const reply of [[0x67, 0x05], [0x50, 0x80]]) {
    const { t, session } = await iso();
    const handler = t.modes[0x27];
    t.modes[0x27] = (level, ...rest) => (level === 0x06 ? reply : handler(level, ...rest));
    await assert.rejects(() => unlockSession(session, M), (e) => e instanceof UnlockError && e.kind === 'key-rejected', reply.join());
    assert.equal(sent(t, 0x27).length, 2);
  }
});

test('only levels 05 and 06 of service 0x27 are ever sent', async () => {
  const { t, session } = await iso();
  await unlockSession(session, M).catch(() => {});
  await unlockSession(session, M + 7).catch(() => {});
  assert.ok(sent(t, 0x27).every((r) => r.data[1] === 0x05 || r.data[1] === 0x06));
  assert.ok(t.requests.every((r) => [0x01, 0x27].includes(r.service)), 'nothing but mode 01 and security access');
});

test('a new slow init locks the ECU again', async () => {
  const { t, session } = await iso();
  await unlockSession(session, M);
  assert.equal(t.unlocked, true);
  await tryWakeUp(t, { kind: 'slow', address: t.address }, { clock: t.clock });
  assert.equal(t.unlocked, false);
  await assert.rejects(() => svc.readCommonId(session, 0x07), KwpNegativeResponse);
});

test('unlockSession refuses what it is not for: other session styles, bad multipliers', async () => {
  const addressed = await awakeSession({ target: 0xd5 });
  await assert.rejects(() => unlockSession(addressed.session, M), /only works on ISO 9141/);
  assert.equal(sent(addressed.t, 0x27).length, 0);

  const { t, session } = await iso();
  for (const bad of [0, 65536, -1, 1.5, '4660', null, undefined, NaN]) {
    await assert.rejects(() => unlockSession(session, bad), TypeError, String(bad));
  }
  assert.equal(sent(t, 0x27).length, 0, 'nothing is sent for a multiplier that cannot be one');
});
