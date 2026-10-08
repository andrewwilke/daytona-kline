'use strict';

const { KwpSession, KwpError, FAILURE, hex } = require('./kwp');
const { realClock, waitUntil } = require('./clock');
const { DEFAULT_BIKE } = require('./bikes');

// ISO 14230-2 W5: bus idle before the wake-up pulse.
const IDLE_MS = 320;
// Pause after a failed attempt so the ECU's bus timers expire before the next pulse.
const SETTLE_MS = 350;

// Slow init (ISO 9141-2 / 14230-2): the ECU's address is sent at 5 baud.
// Nominal bit time is 200 ms; 196 is what the real bike answered to.
const SLOW_BIT_MS = 196;
// Bus idle before the first try, and before each later one: the ECU only
// answers about one try in three, and TuneECU retries every ~6 s.
const SLOW_IDLE_MS = 3000;
const SLOW_RETRY_MS = 6000;
const SLOW_TRIES = 6;
// W4: the tester's ~KB2 must follow KB2 within 25-50 ms; a late one is ignored.
const SLOW_ACK_MS = 28;
const SLOW_STYLE_KB2 = 0x08; // KB2 that means ISO 9141-2 OBD-II framing

// Target addresses seen on KWP2000 motorcycle ECUs, tried after the bike's own
// addresses when an ECU's address isn't known.
const GENERIC_TARGETS = [0x11, 0x10, 0x12, 0x02, 0x01, 0x33, 0x3f, 0x51];

const hexAddr = (n) => '0x' + n.toString(16);

/**
 * Wake-up attempts, normalised. Two kinds:
 *   { kind: 'fast', target, source?, addrMode: 'phys'|'func' }   ISO 14230 fast init
 *   { kind: 'slow', address, tries }                             5-baud slow init
 * A bike description may leave out `kind` for fast attempts.
 */
function normalise(a) {
  if (a.kind === 'slow') return { kind: 'slow', address: a.address, tries: a.tries ?? SLOW_TRIES, bitMs: a.bitMs, saved: a.saved };
  return { kind: 'fast', target: a.target, source: a.source, addrMode: a.addrMode ?? 'phys', saved: a.saved };
}

const sameAttempt = (a, b) =>
  a.kind === b.kind &&
  (a.kind === 'slow'
    ? a.address === b.address
    : a.target === b.target && (a.source ?? 0xf1) === (b.source ?? 0xf1) && a.addrMode === b.addrMode);

/**
 * Attempts to make, in order: the preferred (saved) one if given, the bike's
 * own wake-up attempts (`bike.wake.attempts`) minus a repeat of the preferred
 * one, then fast init to each generic target.
 */
function attemptOrder({ bike = DEFAULT_BIKE, targets = GENERIC_TARGETS, prefer } = {}) {
  const preferred = prefer ? { ...normalise(prefer), saved: true } : null;
  const order = [
    ...bike.wake.attempts.map(normalise),
    ...targets.map((target) => normalise({ target, addrMode: 'phys' })),
  ].filter((a) => !preferred || !sameAttempt(a, preferred));
  if (preferred) order.unshift(preferred);
  return order;
}

/**
 * Fast-init wake-up pulse. Nothing may touch the line between the pulse and the
 * StartCommunication request that follows, so flushes happen before it.
 *
 * 'baud' (default): transmit a 0x00 byte at 360 baud. Start bit plus eight
 * zero data bits = 9 bits * 2.78 ms = exactly 25 ms low, timed by the UART
 * hardware instead of the OS scheduler. The 200 ms low before it is a
 * wake-up quirk of the Triumph Keihin ECUs, harmless for ECUs that only need
 * the pulse, so it is sent to every bike.
 *
 * 'break': hold a serial break for 25 ms using OS timers. Less precise
 * (Windows timer jitter), kept as a fallback for adapters that reject the
 * 360 baud rate.
 */
async function pulse(t, mode, { highMs = 24, clock }) {
  if (mode === 'baud') {
    await t.setBaud(360);
    await t.setBreak(true);
    await clock.sleep(200);
    await t.setBreak(false);
    await t.flushInput();
    await t.write([0x00]);
    // The K-line loopback echo of the 0x00 proves the byte has fully left
    // the UART; switching baud before that would truncate the low pulse.
    // The echo lands ~20 ms after the pulse ends (USB latency), which is
    // about the 25 ms high time the ECU wants.
    await t.readByte(200);
    await t.setBaud(10400);
  } else {
    await t.setBreak(true);
    await clock.sleep(25);
    await t.setBreak(false);
    await clock.sleep(highMs);
  }
}

/** The 10 bits of an address byte at 5 baud: start (0), eight data bits LSB first, stop (1). A 0 bit is the break line on. */
function addressBits(address) {
  const bits = [0];
  for (let i = 0; i < 8; i++) bits.push((address >> i) & 1);
  bits.push(1);
  return bits;
}

/**
 * Put `bits` on the K-line with the break line, `bitMs` each, then release it
 * and flush the receive buffer (the break edges leave garbage bytes in it).
 * With `precise` every edge is placed against an absolute time, so USB latency
 * does not accumulate; without it each bit is a plain sleep after the edge (a
 * deliberately sloppy variant for probes). Resolves with the time of each
 * edge in ms after the first.
 */
async function bitBang(t, bits, { bitMs = SLOW_BIT_MS, clock, precise = true }) {
  const t0 = clock.now();
  const edges = [];
  for (let i = 0; i < bits.length; i++) {
    if (precise) await waitUntil(clock, t0 + i * bitMs);
    await t.setBreak(bits[i] === 0);
    edges.push(clock.now() - t0);
    if (!precise) await clock.sleep(bitMs);
  }
  if (precise) await waitUntil(clock, t0 + bits.length * bitMs);
  await t.setBreak(false);
  await t.flushInput();
  return edges;
}

/**
 * After the address: skip bytes until the 0x55 sync (each wait is `syncMs`),
 * then read KB1 and KB2 (200 ms each). Returns as soon as the key bytes are in,
 * so the caller can acknowledge inside the 25-50 ms W4 window. Resolves with
 * { heard, keyBytes: [KB1, KB2] | null, why } where `heard` is every byte
 * received and `why` says what is missing when `keyBytes` is null.
 */
async function listenForKeyBytes(t, { syncMs = 1500 } = {}) {
  const heard = [];
  let b = await t.readByte(syncMs);
  while (b !== null && b !== 0x55) {
    heard.push(b);
    b = await t.readByte(syncMs);
  }
  if (b === null) return { heard, keyBytes: null, why: `no 0x55 sync${heard.length ? ` (heard ${hex(heard)})` : ''}` };
  heard.push(b);
  const kb1 = await t.readByte(200);
  const kb2 = await t.readByte(200);
  for (const k of [kb1, kb2]) if (k !== null) heard.push(k);
  if (kb1 === null || kb2 === null) return { heard, keyBytes: null, why: 'sync but no key bytes' };
  return { heard, keyBytes: [kb1, kb2], why: null };
}

/**
 * Send ~KB2, `delayMs` after the call (default SLOW_ACK_MS, inside the 25-50 ms W4 window; a later one
 * is ignored), after flushing what the receive buffer holds. Resolves with the byte sent. The tool's
 * slow init and the probe kit's raw one both end their handshake with it.
 */
async function acknowledgeKb2(t, kb2, { delayMs = SLOW_ACK_MS, clock }) {
  await waitUntil(clock, clock.now() + delayMs);
  await t.flushInput();
  const ack = ~kb2 & 0xff;
  await t.write([ack]);
  return ack;
}

/**
 * Slow init: after `idleMs` of bus idle, send `address` at 5 baud (start bit
 * low, eight data bits LSB first, stop bit high, no parity) by bit-banging the
 * break line. Then the ECU answers 0x55 (sync), KB1, KB2; we acknowledge with
 * ~KB2 inside the W4 window and the ECU ends with ~address. Throws a KwpError
 * (timeout) naming the step that failed. Resolves with the key bytes [KB1, KB2].
 */
async function slowInit(t, address, { bitMs = SLOW_BIT_MS, idleMs = SLOW_IDLE_MS, clock }) {
  await clock.sleep(idleMs);
  await bitBang(t, addressBits(address), { bitMs, clock });

  const fail = (why) => new KwpError(FAILURE.TIMEOUT, why);
  const { keyBytes, why } = await listenForKeyBytes(t);
  if (!keyBytes) throw fail(why);
  const [kb1, kb2] = keyBytes;

  const ack = await acknowledgeKb2(t, kb2, { clock });
  // The cable echoes our own byte first, then the ECU sends ~address.
  let reply = await t.readByte(400);
  if (reply === ack) reply = await t.readByte(400);
  const inverted = ~address & 0xff;
  if (reply !== inverted) {
    throw fail(`key bytes ${hex([kb1, kb2])} but the acknowledgement drew ${reply === null ? 'no reply' : hex([reply])} (expected ${hex([inverted])})`);
  }
  return [kb1, kb2];
}

/**
 * One try of one wake-up attempt. Resolves with `{ session, keyBytes, style }`
 * (a KwpSession on the awake line, see KwpSession for the styles); rejects
 * with the KwpError of the failed try.
 *
 *   fast: bus idle, pulse, StartCommunication; style 'addressed'.
 *   slow: idle, 5-baud address, key bytes, acknowledgement; style 'iso9141'.
 *         `idleMs` overrides the idle before the try (default 3 s; wakeEcu
 *         passes the 6 s retry spacing for later tries).
 */
async function tryWakeUp(transport, attempt, { initMode = 'baud', highMs, idleMs, clock = realClock, debug = false, p3 } = {}) {
  const a = normalise(attempt);
  if (a.kind === 'slow') {
    const keyBytes = await slowInit(transport, a.address, { bitMs: a.bitMs, idleMs, clock });
    if (keyBytes[1] !== SLOW_STYLE_KB2) {
      throw new Error(`ECU ${hexAddr(a.address)} answered with key bytes ${hex(keyBytes)}; only KB2 08 (ISO 9141-2 framing) is supported`);
    }
    const session = new KwpSession(transport, { style: 'iso9141', debug, p3, clock });
    session.keyBytes = keyBytes;
    session.lastExchange = clock.now(); // P3 counts from the end of the handshake
    return { session, keyBytes, style: session.style };
  }
  const session = new KwpSession(transport, { target: a.target, source: a.source, addrMode: a.addrMode, debug, p3, clock });
  await clock.sleep(IDLE_MS);
  await transport.flushInput();
  await pulse(transport, initMode, { highMs, clock });
  const keyBytes = await session.startCommunication();
  return { session, keyBytes, style: session.style };
}

/** What a progress event and the result say about one try. */
function describe(a, n, tries) {
  if (a.kind === 'slow') {
    return {
      kind: 'slow', address: a.address, target: a.address, addrMode: 'obd', try: n, tries, saved: !!a.saved,
      text: `slow init ${hexAddr(a.address)}, try ${n}/${tries}`,
    };
  }
  return {
    kind: 'fast', address: null, target: a.target, source: a.source ?? 0xf1, addrMode: a.addrMode, try: 1, tries: 1, saved: !!a.saved,
    text: `fast init ${hexAddr(a.target)} (${a.addrMode})`,
  };
}

/**
 * Wake the ECU: try the preferred wake-up, then the bike's order, then scan
 * the generic targets. A slow attempt is tried up to `tries` times, the first
 * after 3 s of bus idle and each retry after 6 s.
 *
 * Resolves with
 *   { session, keyBytes, kind, style, address, target, source, addrMode, saved, replay }
 * `kind` 'slow' | 'fast'; `style` is the session's framing style; for slow,
 * `address` is the ECU address and target/source/addrMode are what the session
 * reports ('obd'); `saved` says the preferred wake-up was the one that
 * answered; `replay` is what a reconnect passes back as `prefer`:
 * { kind: 'slow', address } or { kind: 'fast', target, source, addrMode }.
 *
 * Options: bike (a defineBike() description, default DEFAULT_BIKE), prefer
 * (a replay object; one without `kind` is a fast attempt), targets (generic
 * fast address list), initMode 'baud'|'break' and highMs (fast init pulse),
 * clock, debug, p3, and
 * onProgress({ step: 'attempt' | 'attempt-failed', attempt, message? }) where
 * `attempt` is { kind, address, target, source?, addrMode, try, tries, saved,
 * text } and `text` reads like "slow init 0x33, try 2/6".
 */
async function wakeEcu(transport, { bike = DEFAULT_BIKE, prefer, targets, initMode = 'baud', highMs, clock = realClock, debug = false, p3, onProgress } = {}) {
  const errors = [];
  for (const attempt of attemptOrder({ bike, targets, prefer })) {
    const tries = attempt.kind === 'slow' ? attempt.tries : 1;
    for (let n = 1; n <= tries; n++) {
      const where = describe(attempt, n, tries);
      onProgress?.({ step: 'attempt', attempt: where });
      try {
        const idleMs = n === 1 ? SLOW_IDLE_MS : SLOW_RETRY_MS;
        const { session, keyBytes, style } = await tryWakeUp(transport, attempt, { initMode, highMs, idleMs, clock, debug, p3 });
        const slow = attempt.kind === 'slow';
        return {
          session, keyBytes, style, kind: attempt.kind,
          address: slow ? attempt.address : null,
          target: slow ? attempt.address : attempt.target,
          source: session.source,
          addrMode: session.addrMode,
          saved: where.saved,
          replay: slow
            ? { kind: 'slow', address: attempt.address }
            : { kind: 'fast', target: attempt.target, source: session.source, addrMode: session.addrMode },
        };
      } catch (e) {
        errors.push(`${where.text}: ${e.message}`);
        onProgress?.({ step: 'attempt-failed', attempt: where, message: e.message });
        if (n < tries) continue; // the retry spacing is the settle time
        await clock.sleep(SETTLE_MS);
      }
    }
  }
  const err = new Error(
    'No ECU answered on any candidate address.\n' +
      errors.map((e) => '  ' + e).join('\n') +
      '\nCheck: ignition ON, kill switch at RUN, cable seated, correct COM port.'
  );
  err.attempts = errors;
  throw err;
}

module.exports = {
  wakeEcu, tryWakeUp, attemptOrder, GENERIC_TARGETS, IDLE_MS, SETTLE_MS,
  SLOW_BIT_MS, SLOW_IDLE_MS, SLOW_RETRY_MS, SLOW_ACK_MS,
  addressBits, bitBang, listenForKeyBytes, acknowledgeKb2,
};
