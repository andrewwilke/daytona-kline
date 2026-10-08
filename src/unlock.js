'use strict';

const fs = require('fs');
const { KwpError, KwpNegativeResponse, FAILURE, hex } = require('./kwp');
const { hex0x } = require('./format');

const SVC_SECURITY_ACCESS = 0x27;
const LEVEL_SEED = 0x05; // the only levels this tool ever sends
const LEVEL_KEY = 0x06;
const REPLY_TIMEOUT_MS = 1000;

/**
 * Why an unlock attempt failed; `.kind` is one of:
 *   'seed-refused'   the ECU answered the seed request with a refusal
 *   'bad-seed-reply' the reply to the seed request was not a seed
 *   'key-rejected'   the ECU did not accept the key (or answered it with something else)
 *   'no-reply'       the link gave nothing usable back (silence, corrupt frame)
 * A refusal also carries `.code`, the ECU's reason byte.
 */
class UnlockError extends Error {
  constructor(kind, message, code) {
    super(message);
    this.name = 'UnlockError';
    this.kind = kind;
    if (code !== undefined) this.code = code;
  }
}

const isMultiplier = (m) => Number.isInteger(m) && m >= 1 && m <= 0xffff;

/**
 * Read the unlock multiplier from a JSON file, { "multiplier": <integer 1..65535> }.
 * Returns exactly one of
 *   { multiplier }          usable
 *   { unavailable: reason } no file (the feature is simply off) or no path
 *   { invalid: reason }     a file that cannot be used; the reason says what to fix
 * Never throws, and no reason ever repeats the file's contents.
 */
function loadMultiplier(file) {
  if (!file) return { unavailable: 'no unlock file configured' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { unavailable: `no unlock file at ${file}` };
    return { invalid: `cannot read the unlock file ${file} (${e.code ?? 'read error'})` };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, '')); // Windows editors and PowerShell add a byte order mark
  } catch {
    return { invalid: `the unlock file ${file} is not valid JSON; expected {"multiplier": <integer 1 to 65535>}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !('multiplier' in data)) {
    return { invalid: `the unlock file ${file} has no "multiplier"; expected {"multiplier": <integer 1 to 65535>}` };
  }
  if (!isMultiplier(data.multiplier)) {
    return { invalid: `"multiplier" in ${file} must be a whole number from 1 to 65535` };
  }
  return { multiplier: data.multiplier };
}

function refused(e, kind, what) {
  return new UnlockError(kind, `the ECU refused ${what} (code ${hex0x(e.code)})`, e.code);
}

/**
 * Security access on an ISO 9141 session: ask for the seed (27 05), answer with
 * key = (seed * multiplier) mod 65536 (27 06). Resolves { state: 'unlocked' }, plus
 * `alreadyUnlocked: true` when the ECU's seed was 0000 (no key is sent then).
 * Throws UnlockError (see above).
 *
 * The ECU may count wrong keys and lock out, so this sends at most one key per
 * call and nothing is ever resent: both requests are `destructive`. The caller
 * must not loop on a failure.
 */
async function unlockSession(session, multiplier) {
  if (session.style !== 'iso9141') throw new Error(`unlock only works on ISO 9141 sessions, not "${session.style}"`);
  if (!isMultiplier(multiplier)) throw new TypeError('multiplier must be a whole number from 1 to 65535');

  const ask = (data) => session.request(data, { timeout: REPLY_TIMEOUT_MS, retries: 0, destructive: true });

  let seedReply;
  try {
    seedReply = (await ask([SVC_SECURITY_ACCESS, LEVEL_SEED])).payload;
  } catch (e) {
    if (e instanceof KwpNegativeResponse) throw refused(e, 'seed-refused', 'the seed request');
    if (e instanceof KwpError && e.kind === FAILURE.WRONG_SERVICE) throw new UnlockError('bad-seed-reply', `the reply to the seed request was not a seed: ${e.message}`);
    if (e instanceof KwpError) throw new UnlockError('no-reply', `no usable reply to the seed request (${e.message})`);
    throw e;
  }
  if (seedReply.length !== 4 || seedReply[1] !== LEVEL_SEED) {
    throw new UnlockError('bad-seed-reply', `the reply to the seed request was not a seed: [${hex(seedReply)}]`);
  }
  const seed = (seedReply[2] << 8) | seedReply[3];
  if (seed === 0) return { state: 'unlocked', alreadyUnlocked: true };

  const key = (seed * multiplier) % 0x10000;
  let keyReply;
  try {
    keyReply = (await ask([SVC_SECURITY_ACCESS, LEVEL_KEY, key >> 8, key & 0xff])).payload;
  } catch (e) {
    if (e instanceof KwpNegativeResponse) throw refused(e, 'key-rejected', 'the key');
    if (e instanceof KwpError && e.kind === FAILURE.WRONG_SERVICE) throw new UnlockError('key-rejected', `the ECU answered the key with something other than acceptance: ${e.message}`);
    if (e instanceof KwpError) throw new UnlockError('no-reply', `no usable reply to the key (${e.message}); the key was sent once and is not resent`);
    throw e;
  }
  if (keyReply[1] !== LEVEL_KEY) {
    throw new UnlockError('key-rejected', `the ECU answered the key with something other than acceptance: [${hex(keyReply)}]`);
  }
  return { state: 'unlocked' };
}

module.exports = { loadMultiplier, unlockSession, UnlockError };
