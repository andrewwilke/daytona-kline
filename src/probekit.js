'use strict';

/**
 * Probe kit: what the hardware experiment scripts in scripts/ share, so a
 * script is only a table of the variants it tries. Everything goes through
 * the transport's interface (write, readByte, flushInput, setBaud, setBreak,
 * setControlLines) and a clock, so the same helpers run against the mock
 * adapter in tests.
 *
 * The default wake-up, `wake()`, IS the tool's wake-up (src/wakeup.js): a
 * probe that stays silent there predicts that `scan` stays silent. The
 * pulse and slow-init helpers are the raw, deliberately odd variants an
 * experiment may need on top of it; they send nothing but wake patterns and
 * the frames the experiment names.
 */

const { realClock, waitUntil } = require('./clock');
const { hex: kwpHex } = require('./kwp');
const {
  tryWakeUp, addressBits, bitBang, listenForKeyBytes,
  SETTLE_MS, SLOW_BIT_MS, SLOW_IDLE_MS, SLOW_RETRY_MS, SLOW_ACK_MS,
} = require('./wakeup');

/**
 * Real time with a sub-millisecond clock for sub-millisecond edges:
 * setTimeout rounds to ~16 ms steps on Windows, which is the size of the
 * windows being measured. `waitUntil` sleeps coarsely and spins the last 30 ms.
 */
const preciseClock = {
  now: () => Number(process.hrtime.bigint()) / 1e6,
  sleep: realClock.sleep,
  async waitUntil(at) {
    const coarse = at - 30 - this.now();
    if (coarse > 0) await realClock.sleep(coarse);
    while (this.now() < at) { /* busy-wait */ }
  },
};

const hex = (bytes) => (bytes.length ? kwpHex(bytes) : '(nothing)');

const checksum = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);

/** Append a checksum: the sum of the bytes (KWP2000), or its two's complement (Honda style). */
const withChecksum = (body, { twosComplement = false } = {}) => [
  ...body,
  twosComplement ? (0x100 - checksum(body)) & 0xff : checksum(body),
];

/** A KWP frame with address bytes; `fmt` is the 0x80/0xC0 base, the data length is OR-ed in. */
const buildFrame = (fmt, target, source, data) => withChecksum([fmt | data.length, target, source, ...data]);

/** Bytes waiting right now. */
async function drain(t) {
  const out = [];
  for (let b = await t.readByte(0); b !== null; b = await t.readByte(0)) out.push(b);
  return out;
}

/**
 * Every byte heard in the next `ms`, as [{ b, at }] with `at` relative to `from`
 * (default: now). With `max` the capture also ends once that many bytes are in.
 */
async function captureTimed(t, ms, { clock = preciseClock, from, max = Infinity } = {}) {
  const start = from ?? clock.now();
  const end = clock.now() + ms;
  const out = [];
  while (out.length < max) {
    const left = end - clock.now();
    if (left <= 0) break;
    const b = await t.readByte(left);
    if (b === null) break;
    out.push({ b, at: clock.now() - start });
  }
  return out;
}

/** Every byte heard in the next `ms`. */
async function capture(t, ms, opts) {
  return (await captureTimed(t, ms, opts)).map((x) => x.b);
}

class ProbeError extends Error {}

/**
 * The K-line is pulled up through the bike, so the cable hears its own bytes
 * only when it is plugged into a powered connector with the switch in the
 * right position. Resolves with { verdict: 'ok' | 'none' | 'garbled', sent, heard }.
 */
async function checkPower(t, { clock = preciseClock, ms = 300, probe = [0x55, 0xaa, 0x0f, 0xf0] } = {}) {
  await t.flushInput();
  await t.write(probe);
  const heard = await capture(t, ms, { clock });
  const verdict = heard.length === 0 ? 'none' : heard.length === probe.length && heard.every((b, i) => b === probe[i]) ? 'ok' : 'garbled';
  return { verdict, sent: probe, heard };
}

/** checkPower that throws a ProbeError (exit code 2 under runProbe) unless the echo is clean. */
async function requirePower(t, opts) {
  const r = await checkPower(t, opts);
  if (r.verdict !== 'ok') {
    throw new ProbeError('Cable is not powered (no clean echo). Plug it into the bike with the key ON, then rerun.');
  }
  return r;
}

/**
 * Split what was heard after a request into our own echo and the ECU's
 * bytes: leading 0x00s (pulse echo, break artefacts) are dropped unless the
 * request itself starts with 0x00, then the request if it came back whole.
 * Resolves with { ecu, echoed }.
 */
function stripEcho(sent, heard) {
  let rest = [...heard];
  if (sent[0] !== 0x00) while (rest[0] === 0x00) rest.shift();
  const echoed = sent.length > 0 && sent.every((b, i) => rest[i] === b);
  if (echoed) rest = rest.slice(sent.length);
  return { ecu: rest, echoed };
}

/** Print one result line and return whether the ECU said anything. */
function reportHeard(label, sent, heard, out = console.log) {
  const { ecu } = stripEcho(sent, heard);
  out(`${label.padEnd(44)} ${ecu.length ? 'ECU BYTES -> ' + hex(ecu) + '   <=== ANSWERED' : 'silent'}`);
  return ecu.length > 0;
}

/**
 * Wake-up exactly as the tool does it (src/wakeup.js tryWakeUp), followed by the
 * same settle pause scan takes after a failure. Resolves with
 * { answered: true, keyBytes, session, tries } or
 * { answered: false, error, heard, tries } where `heard` is whatever was left
 * on the line after the last try.
 *
 * attempt: { kind: 'fast', target, source?, addrMode? } (kind may be left out)
 * or { kind: 'slow', address }. A slow attempt is made up to `tries` times
 * (default 1) with the tool's spacing (`idleMs` before the first, default 3 s,
 * then 6 s); `onTry(n, tries, previousError)` runs before each. A slow attempt
 * counts as answered only when the whole handshake completes, ~address included.
 * Other options: initMode 'baud'|'break' and highMs (the fast pulse), p3, debug, clock.
 */
async function wake(t, attempt, { clock = preciseClock, tries = 1, onTry, idleMs = SLOW_IDLE_MS, ...opts } = {}) {
  const count = attempt.kind === 'slow' ? tries : 1;
  let last;
  for (let n = 1; ; n++) {
    onTry?.(n, count, last);
    try {
      const { session, keyBytes } = await tryWakeUp(t, attempt, { ...opts, idleMs: n === 1 ? idleMs : SLOW_RETRY_MS, clock });
      return { answered: true, keyBytes, session, tries: n };
    } catch (error) {
      last = error;
      if (n < count) continue;
      const heard = await drain(t);
      await clock.sleep(SETTLE_MS);
      return { answered: false, error, heard, tries: n };
    }
  }
}

/** Start a write without waiting for it to leave the UART, so the next line event can be timed against it. */
const sendNow = (t, bytes) => t.write(bytes, { drain: false });

/**
 * Raw fast-init pulse: a 0x00 byte at 360 baud (25 ms low, timed by the UART).
 *
 *   idleMs      bus idle before the pulse
 *   preLowMs    break held first (the tool uses 200 for Triumph ECUs; 0 = none)
 *   switchAtMs  when to go back to 10400 baud, measured from the write: a
 *               number of ms, or 'echo' to wait for the byte's loopback echo
 *               (what the tool does)
 *   readyAtMs   when to return, measured from the write (ignored for 'echo')
 *
 * Returns the clock time of the write.
 */
async function baudPulse(t, { idleMs = 400, preLowMs = 0, switchAtMs = 30, readyAtMs = 51, clock = preciseClock } = {}) {
  await t.setBaud(360);
  await clock.sleep(idleMs);
  if (preLowMs) {
    await t.setBreak(true);
    await clock.sleep(preLowMs);
    await t.setBreak(false);
  }
  await t.flushInput();
  const tw = clock.now();
  if (switchAtMs === 'echo') {
    await t.write([0x00]);
    await t.readByte(200);
    await t.setBaud(10400);
    return tw;
  }
  await sendNow(t, [0x00]);
  await waitUntil(clock, tw + switchAtMs);
  await t.setBaud(10400);
  await waitUntil(clock, tw + readyAtMs);
  return tw;
}

/** Raw low/high pulse made with a serial break (25/25 ms is the fast-init shape; Honda wants 70/130). */
async function breakPulse(t, { idleMs = 400, lowMs = 25, highMs = 25, clock = preciseClock } = {}) {
  await t.setBaud(10400);
  await clock.sleep(idleMs);
  await t.flushInput();
  const t0 = clock.now();
  await t.setBreak(true);
  await waitUntil(clock, t0 + lowMs);
  await t.setBreak(false);
  await waitUntil(clock, t0 + lowMs + highMs);
  return t0;
}

/**
 * Slow init, raw: the address byte at 5 baud on the break line (src/wakeup.js
 * bitBang, which the tool uses too), then listens for the ECU's 0x55 sync
 * byte and key bytes. It returns the moment KB2 has arrived, so the caller
 * can acknowledge inside the 25-50 ms W4 window (a later ~KB2 is ignored).
 * When nothing syncs it waits the whole `listenMs` and reports what it heard.
 * It does not wait for bus idle first (the ECU wants 3 s) and does not
 * acknowledge; see slowHandshake for the whole exchange.
 *
 *   bitMs     bit time (default 196, the real bike's; nominal is 200)
 *   precise   edges on absolute times (default) or plain sleeps between
 *   parity    'none' (default), 'odd' or 'even': a parity bit before the stop bit
 *
 * Resolves with { heard, edgeError, sync } where `sync` is { kb1, kb2 } or
 * null, `heard` is every byte received and `edgeError` the worst bit edge
 * error in ms (null without `precise`).
 */
async function slowInit(t, addr, { bitMs = SLOW_BIT_MS, precise = true, parity = 'none', listenMs = 1500, clock = preciseClock } = {}) {
  const bits = addressBits(addr);
  if (parity !== 'none') {
    const ones = bits.slice(1, 9).reduce((a, b) => a + b, 0);
    bits.splice(9, 0, parity === 'odd' ? 1 - (ones % 2) : ones % 2);
  }
  const edges = await bitBang(t, bits, { bitMs, clock, precise });
  const { heard, keyBytes } = await listenForKeyBytes(t, { syncMs: listenMs });
  return {
    heard,
    sync: keyBytes && { kb1: keyBytes[0], kb2: keyBytes[1] },
    edgeError: precise ? Math.max(...edges.map((e, i) => Math.abs(e - i * bitMs))) : null,
  };
}

/**
 * Finish a slow init: send ~KB2 `delayMs` after the call (call it right after
 * slowInit returns, so that is measured from KB2; the window is 25-50 ms).
 * Resolves with the ack byte and what came back: our own echo, then the ECU's
 * ~address. The capture lasts `listenMs`, or ends after `stopAfter` bytes.
 */
async function ackKb2(t, kb2, { delayMs = SLOW_ACK_MS, listenMs = 400, stopAfter, clock = preciseClock } = {}) {
  await waitUntil(clock, clock.now() + delayMs);
  await t.flushInput();
  const ack = ~kb2 & 0xff;
  await t.write([ack]);
  return { ack, heard: await capture(t, listenMs, { clock, max: stopAfter }) };
}

/**
 * The whole raw slow-init exchange, tolerant of a partial one so a probe can
 * show where it stopped: bus idle, slowInit, ackKb2 (ends with the ECU's reply
 * byte), up to `tries` times with the tool's spacing (`idleMs` before the first
 * try, default 3 s, then `retryMs`, default 6 s) until the key bytes arrive.
 * `onTry(n, tries, previous)` runs before each try with the previous try's
 * result (undefined for the first). Options for one try are slowInit's
 * (bitMs, precise, parity, listenMs) plus delayMs for the acknowledgement.
 *
 * Resolves with the last try's { tries (used), sync, heard, edgeError, ack,
 * echoed, reply, completed }: `ack` is null unless key bytes arrived, `reply`
 * the ECU's byte after our echo (null if none), `completed` says it was
 * ~address.
 */
async function slowHandshake(t, addr, { tries = 1, idleMs = SLOW_IDLE_MS, retryMs = SLOW_RETRY_MS, onTry, delayMs, clock = preciseClock, ...initOpts } = {}) {
  let r;
  for (let n = 1; n <= tries; n++) {
    onTry?.(n, tries, r);
    await clock.sleep(n === 1 ? idleMs : retryMs);
    const init = await slowInit(t, addr, { ...initOpts, clock });
    r = { tries: n, ...init, ack: null, echoed: false, reply: null, completed: false };
    if (!init.sync) continue;
    const a = await ackKb2(t, init.sync.kb2, { delayMs, stopAfter: 2, clock });
    const { ecu, echoed } = stripEcho([a.ack], a.heard);
    Object.assign(r, { ack: a.ack, echoed, reply: ecu[0] ?? null, completed: ecu[0] === (~addr & 0xff) });
    break;
  }
  return r;
}

/** How long sleep(ms) really takes, `runs` times. */
async function timerAccuracy(ms, runs = 5, { clock = preciseClock } = {}) {
  const took = [];
  for (let i = 0; i < runs; i++) {
    const a = clock.now();
    await clock.sleep(ms);
    took.push(clock.now() - a);
  }
  return took;
}

async function openTransport(port, options) {
  const { SerialTransport } = require('./transport');
  const t = new SerialTransport(port, options);
  await t.open();
  return t;
}

/**
 * Script wrapper: parses `<script> [port] [args...]` (port defaults to
 * COM5), opens the port, runs main({ port, args, t }), always closes the
 * port and reports errors. A ProbeError (e.g. from requirePower) exits 2.
 *
 * Options: open: false (the script opens its own transports), power: false
 * (skip the power check that otherwise runs before main).
 */
function runProbe(main, { open = true, power = true } = {}) {
  const port = process.argv[2] || 'COM5';
  const args = process.argv.slice(3);
  (async () => {
    const t = open ? await openTransport(port) : null;
    try {
      if (t && power) {
        await requirePower(t);
        console.log('cable powered (echo OK)\n');
      }
      await main({ port, args, t });
    } finally {
      if (t) await t.close();
    }
  })().catch((e) => {
    if (e instanceof ProbeError) {
      console.log(e.message);
      process.exit(2);
    }
    console.error('error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  preciseClock,
  waitUntil,
  hex,
  checksum,
  withChecksum,
  buildFrame,
  drain,
  capture,
  captureTimed,
  checkPower,
  requirePower,
  ProbeError,
  stripEcho,
  reportHeard,
  wake,
  baudPulse,
  breakPulse,
  slowInit,
  ackKb2,
  slowHandshake,
  timerAccuracy,
  openTransport,
  runProbe,
};
