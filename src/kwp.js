'use strict';

const { realClock } = require('./clock');

const SVC = {
  START_COMM: 0x81,
  STOP_COMM: 0x82,
  START_DIAG: 0x10,
  ECU_ID: 0x1a,
  READ_LOCAL_ID: 0x21,
  READ_DTC_BY_STATUS: 0x18,
  CLEAR_DTC: 0x14,
  TESTER_PRESENT: 0x3e,
  NEG_RESPONSE: 0x7f,
};

const NRC_PENDING = 0x78; // requestCorrectlyReceived-ResponsePending

// ISO 9141-2 OBD-II framing: fixed three-byte headers, no length byte, checksum
// = sum of all bytes. A reply ends when the bytes stop for ISO_GAP_MS.
const ISO_REQUEST_HEADER = [0x68, 0x6a, 0xf1];
const ISO_REPLY_HEADER = [0x48, 0x6b, 0xd1];
const ISO_GAP_MS = 60;

/**
 * Per framing style: min gap between our requests (P3), the reply timeout when
 * a request names none, and `ping`, the harmless request that keeps the ECU's
 * session alive (and, for iso9141, proves it after the handshake).
 */
const STYLES = {
  addressed: { p3: 100, timeout: 1500, ping: { data: [0x3e], timeout: 800, intervalMs: 1500 } },
  iso9141: { p3: 60, timeout: 300, ping: { data: [0x01, 0x00], timeout: 800, intervalMs: 2000 } },
};

/** Why a request failed. Every thrown KwpError carries one as `.kind`. */
const FAILURE = Object.freeze({
  TIMEOUT: 'timeout', // no (complete) reply in time
  BAD_CHECKSUM: 'bad-checksum', // a reply frame arrived corrupted
  ECHO_MISMATCH: 'echo-mismatch', // our own frame came back truncated or altered
  NEGATIVE_RESPONSE: 'negative-response', // ECU refused: .service, .code
  WRONG_SERVICE: 'wrong-service', // reply belongs to some other request
});

// Failures of the link itself, as opposed to the ECU answering "no".
const LINK_FAILURES = new Set([FAILURE.TIMEOUT, FAILURE.BAD_CHECKSUM, FAILURE.ECHO_MISMATCH]);

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
/** The frame checksum of both styles: the sum of all bytes, mod 256. */
const checksum = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);

/**
 * One KWP2000 request frame with address bytes: `fmt target source data checksum`, `fmt` being the
 * 0x80 / 0xC0 base the data length is OR-ed into; data over 63 bytes gets a separate length byte.
 * The session builds every addressed request with it, and the probe kit builds its raw ones with it.
 */
function addressedFrame(fmt, target, source, data) {
  const frame = data.length <= 63
    ? [fmt | data.length, target, source, ...data]
    : [fmt, target, source, data.length, ...data];
  frame.push(checksum(frame));
  return frame;
}

class KwpError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'KwpError';
    this.kind = kind;
  }
}

class KwpNegativeResponse extends KwpError {
  constructor(service, code) {
    super(FAILURE.NEGATIVE_RESPONSE, `negative response to service 0x${service.toString(16)}: code 0x${code.toString(16)}`);
    this.service = service;
    this.code = code;
  }
}

/**
 * Who gets the line next. Every request belongs to one class; pass
 * `{ priority }` to request(), or the older `{ background: true }`.
 *   NORMAL      the default: served first, in the order asked
 *   BACKGROUND  reads nobody is watching move (the switch watcher's): served
 *               behind NORMAL ones, unless it has already waited the session's
 *               background wait (see KwpSession.setBackgroundWaitMs)
 */
const PRIORITY = Object.freeze({ NORMAL: 'normal', BACKGROUND: 'background' });

const DEFAULT_BACKGROUND_WAIT_MS = 300;

/**
 * The line lock behind KwpSession: one request on the K-line at a time, and
 * an optional hold that keeps everyone else off it.
 *
 * Interface: `acquire(priority)` resolves a release function (call it once,
 * further calls do nothing); `hold()` returns { acquire, release }; `busy`.
 * Ordering when the line comes free: the oldest BACKGROUND request that has
 * waited at least `backgroundWaitMs`, else the oldest NORMAL one, else the
 * oldest. The line passes straight to the next request, never through "free",
 * so a late arrival cannot cut in. The caller releases after every request,
 * failed or not (KwpSession.request does it in a `finally`).
 *
 * A hold admits only requests made through its own `acquire`; every other
 * acquire() made while it is in place waits, and goes on after it is released.
 * Requests that were already queued or running when hold() was called are not
 * affected: they finish first, which is what lets the holder's first request
 * wait for its turn like any other. On release the parked requests take their
 * turn by the ordering above, as if they had just been queued, so a NORMAL one
 * asked later still beats a BACKGROUND one asked earlier. One hold at a time.
 */
class LineLock {
  constructor(clock, backgroundWaitMs = DEFAULT_BACKGROUND_WAIT_MS) {
    this.clock = clock;
    this.backgroundWaitMs = backgroundWaitMs;
    this._taken = false; // a request has the line
    this._waiters = []; // { resolve, priority, since } for the requests waiting their turn
    this._parked = []; // the same, for requests kept off the line by a hold
    this._pending = 0; // requests running or waiting, parked or queued
    this._holding = null; // the hold in place, if any
    this._deferring = false; // a background request is waiting one turn of the event loop for an ordinary one to arrive
  }

  /** True while a request is running or waiting. */
  get busy() {
    return this._pending > 0;
  }

  async acquire(priority = PRIORITY.NORMAL, hold = null) {
    this._pending++;
    const entry = (resolve) => ({ resolve, priority, since: this.clock.now() });
    if (this._holding && this._holding !== hold) await new Promise((resolve) => this._parked.push(entry(resolve)));
    else if (this._taken) await new Promise((resolve) => this._waiters.push(entry(resolve)));
    else this._taken = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._pending--;
      this._handOver();
    };
  }

  hold() {
    if (this._holding) throw new Error('the line is already held');
    const hold = {};
    this._holding = hold;
    return {
      acquire: (priority) => this.acquire(priority, hold),
      release: () => {
        if (this._holding !== hold) return;
        this._holding = null;
        // The parked requests join the queue in the order they asked and the usual rules pick among them.
        this._waiters.push(...this._parked.splice(0));
        if (!this._taken && this._waiters.length) {
          this._taken = true;
          this._handOver();
        }
      },
    };
  }

  /** The line is free: pick who goes next. `settled` is true once the one-turn wait for an ordinary request is over. */
  _handOver(settled = false) {
    const now = this.clock.now();
    let i = this._waiters.findIndex((w) => w.priority === PRIORITY.BACKGROUND && now - w.since >= this.backgroundWaitMs);
    if (i < 0) i = this._waiters.findIndex((w) => w.priority !== PRIORITY.BACKGROUND);
    if (i < 0 && this._waiters.length && settled) i = 0;
    if (i < 0 && this._waiters.length) {
      // Only background requests wait, none of them for long. The caller that just released the line is
      // usually about to ask for its next read (the dashboard asks back to back): the line is left free for
      // one turn of the event loop so that request can take it, and only then does the oldest background
      // one go. Without this the line is handed to the background request before the next ordinary one is
      // even queued, and the two take turns one for one.
      this._taken = false;
      if (!this._deferring) {
        this._deferring = true;
        setImmediate(() => {
          this._deferring = false;
          if (!this._taken && this._waiters.length) {
            this._taken = true;
            this._handOver(true);
          }
        });
      }
      return;
    }
    if (i < 0) {
      this._taken = false;
      return;
    }
    this._waiters.splice(i, 1)[0].resolve(); // the line stays taken, handed to that request
  }
}

/**
 * One diagnostic session with a single ECU, over an already awake K-line
 * (src/wakeup.js does the waking and chooses the style from how it went).
 *
 * style 'addressed' (default, KWP2000 / ISO 14230): requests use the "with
 * address information" header: fmt, target, source; replies carry their own
 * length. style 'iso9141' (slow init, KB2 = 0x08): OBD-II frames 68 6A F1 ...
 * with no length byte and a reply that ends when the line goes quiet; target,
 * source and addrMode are fixed by the standard (`addrMode` reads 'obd'),
 * there is no StartCommunication / StopCommunication, and a request that
 * draws no reply at all fails with kind 'timeout' (the caller decides whether
 * that means "unsupported", see `allowSilence` on request()).
 *
 * `ping` is the style's keep-alive request: { data, timeout, intervalMs }.
 */
class KwpSession {
  constructor(transport, { target = 0x11, source, debug = false, p3, addrMode = 'phys', style = 'addressed', clock = realClock } = {}) {
    const spec = STYLES[style];
    if (!spec) throw new Error(`unknown KWP session style "${style}"`);
    this.t = transport;
    this.style = style;
    if (style === 'iso9141') {
      this.target = ISO_REQUEST_HEADER[1];
      this.source = ISO_REQUEST_HEADER[2];
      this.addrMode = 'obd';
    } else {
      this.target = target;
      this.source = source ?? 0xf1;
      this.addrMode = addrMode;
    }
    // 'phys' -> header fmt 0x80|len; 'func' -> 0xC0|len (ISO 14230-4 OBD-style
    // functional addressing, e.g. the classic C1 33 F1 81 66 wake-up)
    this.fmtBase = addrMode === 'func' ? 0xc0 : 0x80;
    this.debug = debug;
    this.p3 = p3 ?? spec.p3; // min gap between our messages, ms
    this.defaultTimeout = spec.timeout;
    this.ping = spec.ping;
    this.clock = clock;
    this.lastExchange = 0;
    this.keyBytes = null;
    // Consecutive requests that failed on the link (not ECU refusals); reset
    // by any reply. The connection watches this to notice a dead ECU.
    this.linkFailures = 0;
    this.lastLinkFailure = null;
    this._line = new LineLock(clock);
    this._queued = []; // reply frames already read but not yet handed out
  }

  /** True while a request is running or queued (or waiting out a hold). */
  get busy() {
    return this._line.busy;
  }

  /**
   * How long a BACKGROUND request waits behind NORMAL ones before it goes
   * next regardless (default 300 ms): the live gauges get most of the line,
   * the background reads still advance. 0 = no waiting at all, Infinity =
   * background requests only run when no NORMAL one is queued. Takes effect
   * for the next time the line comes free.
   */
  setBackgroundWaitMs(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) throw new TypeError('background wait must be a number of milliseconds, 0 or more');
    this._line.backgroundWaitMs = ms;
  }

  /** The background wait in ms (see setBackgroundWaitMs). Also readable and writable as `backgroundAgeMs`, its old name. */
  get backgroundAgeMs() {
    return this._line.backgroundWaitMs;
  }

  set backgroundAgeMs(ms) {
    this.setBackgroundWaitMs(ms);
  }

  /**
   * Keep every other request off the line until `release()`, for an exchange
   * that must not be interleaved (the security access seed and key). Returns
   * `{ request, release }`: `request(data, opts)` is request() for the holder
   * and is not held back; `release()` lets the rest go, in their usual order,
   * and may be called more than once. Requests already queued or running when
   * this is called go first, the holder's own queue behind them. Call release
   * in a `finally`: a holder that never releases starves the session. Only
   * one hold at a time (a second hold() throws).
   */
  hold() {
    const h = this._line.hold();
    return { request: (data, opts) => this._send(data, opts, h.acquire), release: h.release };
  }

  log(...args) {
    if (this.debug) console.error('[kwp]', ...args);
  }

  _buildFrame(data) {
    if (this.style === 'iso9141') return [...ISO_REQUEST_HEADER, ...data, checksum([...ISO_REQUEST_HEADER, ...data])];
    return addressedFrame(this.fmtBase, this.target, this.source, data);
  }

  /** Read and discard the echo of what we just transmitted (K-line loopback). */
  async _consumeEcho(sent) {
    const got = [];
    for (let i = 0; i < sent.length; i++) {
      const b = await this.t.readByte(200);
      if (b === null) {
        if (got.length === 0) return; // adapter without loopback
        throw new KwpError(FAILURE.ECHO_MISMATCH, `echo cut off after ${got.length} of ${sent.length} bytes`);
      }
      got.push(b);
      if (b !== sent[i]) {
        if (i === 0) {
          // Not our echo: adapter without loopback. Hand the bytes to the reply parser.
          this.t.unshift(got);
          return;
        }
        throw new KwpError(FAILURE.ECHO_MISMATCH, `echo [${hex(got)}] differs from sent [${hex(sent)}]`);
      }
    }
  }

  /**
   * Read one complete frame. Accepts headers with or without address bytes
   * and with or without a separate length byte. Returns the payload (service
   * byte onward); throws TIMEOUT or BAD_CHECKSUM.
   */
  async _readFrame(timeoutMs) {
    const truncated = () => new KwpError(FAILURE.TIMEOUT, 'frame cut off mid-way');
    const first = await this.t.readByte(timeoutMs);
    if (first === null) throw new KwpError(FAILURE.TIMEOUT, 'no reply');

    const header = [first];
    let len = first & 0x3f;
    if ((first & 0x80) !== 0) {
      const tgt = await this.t.readByte(50);
      const src = await this.t.readByte(50);
      if (tgt === null || src === null) throw truncated();
      header.push(tgt, src);
    }
    if (len === 0) {
      const lenByte = await this.t.readByte(50);
      if (lenByte === null) throw truncated();
      header.push(lenByte);
      len = lenByte;
    }

    const data = [];
    for (let i = 0; i < len; i++) {
      const b = await this.t.readByte(60);
      if (b === null) throw truncated();
      data.push(b);
    }
    const cs = await this.t.readByte(60);
    if (cs === null) throw truncated();

    const expected = checksum([...header, ...data]);
    if (expected !== cs) {
      const msg = `checksum mismatch: frame=[${hex([...header, ...data, cs])}] expected=${expected.toString(16)}`;
      this.log(msg);
      throw new KwpError(FAILURE.BAD_CHECKSUM, msg);
    }
    this.log(`rx [${hex([...header, ...data, cs])}]`);
    return data;
  }

  /**
   * ISO 9141 replies have no length byte: read until the line is quiet for
   * ISO_GAP_MS, then cut the burst into frames. Frames the ECU sends back to
   * back (a short gap, no length byte) are told apart by their checksum
   * followed by the next reply header. Returns the payloads.
   */
  async _readBurst(timeoutMs) {
    const first = await this.t.readByte(timeoutMs);
    if (first === null) throw new KwpError(FAILURE.TIMEOUT, 'no reply');
    const bytes = [first];
    for (let b = await this.t.readByte(ISO_GAP_MS); b !== null; b = await this.t.readByte(ISO_GAP_MS)) bytes.push(b);

    const bad = (why) => {
      const msg = `${why}: frame=[${hex(bytes)}]`;
      this.log(msg);
      return new KwpError(FAILURE.BAD_CHECKSUM, msg);
    };
    const startsReply = (at) => ISO_REPLY_HEADER.every((h, i) => bytes[at + i] === h);
    const payloads = [];
    let start = 0;
    while (start < bytes.length) {
      if (!startsReply(start)) throw bad('unexpected reply header');
      let end = -1;
      for (let e = start + ISO_REPLY_HEADER.length + 2; e <= bytes.length; e++) {
        if (e < bytes.length && !startsReply(e)) continue;
        if (checksum(bytes.slice(start, e - 1)) === bytes[e - 1]) {
          end = e;
          break;
        }
      }
      if (end < 0) throw bad('checksum mismatch or cut-off reply');
      payloads.push(bytes.slice(start + ISO_REPLY_HEADER.length, end - 1));
      start = end;
    }
    this.log(`rx [${hex(bytes)}]`);
    return payloads;
  }

  /** The next reply payload: one already read, or the next frame / burst off the line. */
  async _nextFrame(timeoutMs) {
    if (this._queued.length) return this._queued.shift();
    if (this.style !== 'iso9141') return this._readFrame(timeoutMs);
    this._queued.push(...(await this._readBurst(timeoutMs)));
    return this._queued.shift();
  }

  async _exchange(data, { timeout, multiFrame }) {
    const gap = this.p3 - (this.clock.now() - this.lastExchange);
    if (gap > 0) await this.clock.sleep(gap);

    const frame = this._buildFrame(data);
    this.log(data[0] === 0x27 && data[1] === 0x06 ? 'tx [security access key, not logged]' : `tx [${hex(frame)}]`); // the key and the seed give the multiplier away
    this._queued = [];
    try {
      // KWP is strictly request-response: anything still in the buffer is
      // stale (late keep-alive reply, tail of a corrupted frame) - drop it.
      await this.t.flushInput();
      await this.t.write(frame);
      await this._consumeEcho(frame);

      let deadline = this.clock.now() + timeout;
      let first = null;
      while (first === null) {
        const left = deadline - this.clock.now();
        if (left <= 0) throw new KwpError(FAILURE.TIMEOUT, `no response to [${hex(data)}]`);
        const resp = await this._nextFrame(left).catch((e) => {
          if (e.kind === FAILURE.TIMEOUT) e.message = `no response to [${hex(data)}]`;
          throw e;
        });
        if (this.style === 'addressed' && resp[0] === SVC.NEG_RESPONSE && resp[1] === data[0] && resp[2] === NRC_PENDING) {
          deadline = this.clock.now() + 5000; // ECU asked for more time
          continue;
        }
        first = resp;
      }

      if (this.style === 'iso9141') {
        // This ECU's refusals do not name the service in the second byte (7F 33 36
        // to a 0x22 request), so any 7F is a refusal of the request we sent.
        if (first[0] === SVC.NEG_RESPONSE && first.length >= 2) throw new KwpNegativeResponse(data[0], first[2] ?? first[1]);
      } else if (first[0] === SVC.NEG_RESPONSE && first.length >= 3 && first[1] === data[0]) {
        throw new KwpNegativeResponse(first[1], first[2]);
      }
      const positive = data[0] + 0x40;
      if (first[0] !== positive) {
        throw new KwpError(
          FAILURE.WRONG_SERVICE,
          `reply [${hex(first)}] does not answer service 0x${data[0].toString(16)} (expected 0x${positive.toString(16)} or a negative response)`
        );
      }

      const frames = [first];
      if (multiFrame) {
        for (;;) {
          let more;
          try {
            more = await this._nextFrame(150);
          } catch (e) {
            if (e.kind === FAILURE.TIMEOUT) break;
            throw e;
          }
          if (more[0] !== positive) break;
          frames.push(more);
        }
      }
      return { payload: first, frames };
    } finally {
      this.lastExchange = this.clock.now();
    }
  }

  /**
   * Send a request payload (service byte first) and return
   * `{ payload, frames }`: `payload` is the first positive reply (service
   * byte onward), `frames` every reply frame collected.
   *
   * Options:
   *   timeout      ms to wait for the reply (responsePending extends it);
   *                default depends on the style (1500 addressed, 300 iso9141)
   *   retries      resends after a link failure (timeout, bad checksum, echo
   *                mismatch); default 1
   *   destructive  the request changes ECU state: never resent, whatever
   *                `retries` says
   *   multiFrame   keep collecting further reply frames of the same service
   *                until the ECU goes quiet (OBD modes 03/07)
   *   allowSilence the caller treats "no reply at all" as an answer (an
   *                unsupported mode): the timeout is still thrown, but does
   *                not count in linkFailures
   *   priority     PRIORITY.NORMAL (default) or PRIORITY.BACKGROUND: who gets
   *                the line first when several requests wait (see PRIORITY)
   *   background   shorthand for priority: PRIORITY.BACKGROUND; for reads
   *                nobody is watching move
   *
   * Requests are served one at a time, normal ones first in the order asked;
   * the line is released after every request, whether it succeeded or threw.
   * While a hold() is in place a request made outside it waits for the release.
   *
   * Throws KwpError with a `.kind` from FAILURE; KwpNegativeResponse (also a
   * KwpError) adds `.service` and `.code`. Negative responses are never retried.
   */
  request(data, opts) {
    return this._send(data, opts, (priority) => this._line.acquire(priority));
  }

  /** request() taking the line with `acquire(priority)`: the lock's own, or a hold's. */
  async _send(data, { timeout = this.defaultTimeout, retries = 1, destructive = false, multiFrame = false, allowSilence = false, background = false, priority = PRIORITY.NORMAL } = {}, acquire) {
    const maxRetries = destructive ? 0 : retries;
    const release = await acquire(background ? PRIORITY.BACKGROUND : priority);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const reply = await this._exchange(data, { timeout, multiFrame });
          this.linkFailures = 0;
          return reply;
        } catch (e) {
          if (!(e instanceof KwpError)) throw e;
          if (LINK_FAILURES.has(e.kind)) {
            if (attempt < maxRetries) continue;
            if (!(allowSilence && e.kind === FAILURE.TIMEOUT)) {
              this.linkFailures++;
              this.lastLinkFailure = e;
            }
          } else {
            this.linkFailures = 0;
          }
          throw e;
        }
      }
    } finally {
      release();
    }
  }

  /** Send StartCommunication on an awake line; sets and returns the key bytes. */
  async startCommunication() {
    const { payload } = await this.request([SVC.START_COMM], { timeout: 600, retries: 0 });
    this.keyBytes = payload.slice(1);
    return this.keyBytes;
  }

  async startDiagSession(mode) {
    return (await this.request([SVC.START_DIAG, mode], { timeout: 1000 })).payload;
  }

  async stop() {
    if (this.style === 'iso9141') return; // no StopCommunication in ISO 9141: the ECU drops the session after P3max of silence
    try {
      await this.request([SVC.STOP_COMM], { timeout: 500, retries: 0 });
    } catch {
      // ECU drops the session on its own after P3max anyway
    }
  }
}

module.exports = { KwpSession, KwpError, KwpNegativeResponse, FAILURE, PRIORITY, SVC, STYLES, hex, checksum, addressedFrame };
