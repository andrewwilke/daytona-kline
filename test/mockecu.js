'use strict';

const { DEFAULT_BIKE } = require('../src/bikes');

const tick = () => new Promise((r) => setImmediate(r));

/** A clock that never waits: sleeping just moves time forward. */
function fakeClock() {
  const clock = {
    t: 1_000_000,
    sleeps: [],
    now: () => clock.t,
    async sleep(ms) {
      clock.sleeps.push(ms);
      clock.t += ms;
      await tick();
    },
  };
  return clock;
}

const WAKE_IDLE_MS = 300; // bus idle the ECU wants before a wake-up pulse (ISO 14230-2 W5 min)
const WAKE_LOW_MS = 24; // shortest low pulse it accepts (nominal 25)
const LONG_LOW_MS = 190; // the Triumph ECU's long pre-low (nominal 200), when required
const LONG_BREAK_MS = 100; // a break held longer than this at 10400 baud is a bit of a 5-baud address, not a fast-init pulse

// Slow init (ISO 9141-2), as the real bike does it
const SLOW_IDLE_MS = 3000; // bus idle required before the address
const SLOW_BIT_MIN_MS = 180; // 5 baud is 200 ms per bit; accept +-10 %
const SLOW_BIT_MAX_MS = 220;
const SLOW_ACK_MIN_MS = 20; // ~KB2 must arrive this long after KB2 was sent...
const SLOW_ACK_MAX_MS = 100; // ...and no later: a late acknowledgement is ignored
const SLOW_W4_MS = 30; // ECU sends ~address this long after the acknowledgement
const ECU_P3MAX_MS = 5000; // the ECU drops an ISO 9141 session after this much silence
const ISO_REQUEST_HEADER = [0x68, 0x6a, 0xf1];
const ISO_REPLY_HEADER = [0x48, 0x6b, 0xd1];

const sum = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);

/**
 * In-memory transport that behaves like the FTDI cable + a Keihin-ish ECU.
 * It is a recording adapter at the transport seam: every line event (baud
 * change, break, flush, write) lands in `events` with a clock timestamp, and
 * the ECU only answers StartCommunication after a wake-up pulse it actually
 * observed: bus idle, then either a 0x00 byte at 360 baud followed by a
 * return to 10400, or a break held for ~25 ms. Everything is echoed back
 * (K-line loopback).
 *
 * Options:
 *   target             ECU address (default 0x10)
 *   funcOnly           only answer functional-addressed frames (fmt 0xC0|len)
 *   requireLongLow     Triumph quirk: wake-up must start with a ~200 ms low
 *   obd                answer OBD modes 03/04/07
 *   unaddressedReplies reply with headers that carry no address bytes
 *   clock              clock to timestamp events with (default: a fakeClock)
 *   dataBlockId        local id of the one sensor block it serves (default: the
 *                      bike's real block id)
 *
 * ISO 9141 mode (`iso9141: true`) models the real 2012 Daytona 675: fast init
 * is ignored, slow init works. The ECU decodes the 5-baud address from the
 * break events and their timestamps (start low, 8 data bits LSB first, stop
 * high, no parity, bit time 200 ms +-10 %, after 3 s of bus idle), answers
 * 0x55 0x08 0x08 after W1, requires ~KB2 20-100 ms after KB2, answers ~address
 * and then speaks ISO 9141-2 OBD-II (echo, then 48 6B D1 ... with a sum
 * checksum and no length byte). Every init is logged in `slowInits`, every
 * acknowledgement judged in `acks`. Extra options:
 *   address        slow-init address it answers (default 0x33)
 *   answerOnTry    answers only the Nth valid init (default 1: the first), silent before
 *   w1Ms           delay between the address and 0x55 (default 100, ISO says 60-300)
 *   replyMs        delay before a reply (default 20)
 *   frameGapMs     gap between reply frames of a multi-frame answer (default 40;
 *                  over 60 ms the tester sees separate bursts)
 *   keyBytes       [KB1, KB2], default [0x08, 0x08]
 *   unlockMultiplier  turns on security access: 27 05 answers 67 05 <seed>, 27 06 <key>
 *                  answers 67 06 when key = (seed * multiplier) & 0xFFFF and 7F 27 35
 *                  otherwise (without this option 27 gets no reply at all)
 *   seed           the 16-bit seed it hands out (default 0x1a2b); 0 means "already
 *                  unlocked" and unlocks at once. An unlocked ECU answers the seed
 *                  request with 0000.
 * Security access state: `unlocked`, `keyAttempts` (every 27 06 received),
 * `seedRequests`, `keysReceived`. Service 0x22 is refused (7F 33 36) until unlocked;
 * after that it serves `dataIds` (id -> data bytes after "62 <hi> <lo>", or a function
 * returning them), anything else 7F 33 31, except the ids in `silentIds` (a Set), which
 * get no reply at all, as some ids do on the real bike. A new slow init or P3max of silence
 * locks it again.
 * Output tests (services 0x31 start / 0x32 stop, one routine byte): refused 7F 33 36 until
 * unlocked; then exactly the 8 bytes in `outputRoutines` are answered (71 <b> / 72 <b>) and any
 * other byte gets 7F 31 12 (7F 32 12). `routinesStarted` / `routinesStopped` record every byte
 * accepted. Starting the fuel pump routine (04) makes data id 0x60 read 00 ff for 3 s of clock
 * time, then it goes back to what it was. Fault options: `outputTestsSilent` (no reply at all to
 * 31 and 32) and `outputTestsRefuse` (a code: every valid start is refused with 7F 31 <code>).
 * Its OBD data is table driven: `pids` (PID -> data bytes after "41 <pid>", or a
 * function returning them; PID 00's bitmap is derived from the keys),
 * `storedCodes` (mode 03, raw 16-bit codes) and `modes` (mode -> handler(...data)
 * returning a reply payload, an array of payloads for a multi-frame reply, or
 * null for silence). Modes 07 and 09 are absent, so they get no reply.
 */
class MockEcuTransport {
  constructor({
    target = 0x10, obd = false, funcOnly = false, requireLongLow = false, unaddressedReplies = false, clock = fakeClock(), dataBlockId = DEFAULT_BIKE.dataBlockId,
    iso9141 = false, address = 0x33, answerOnTry = 1, w1Ms = 100, replyMs = 20, frameGapMs = 40, keyBytes = [0x08, 0x08],
    unlockMultiplier, seed = 0x1a2b,
  } = {}) {
    this.unlockMultiplier = unlockMultiplier;
    this.seed = seed;
    this.unlocked = false;
    this.keyAttempts = 0;
    this.seedRequests = 0;
    this.keysReceived = [];
    this._seedIssued = false;
    this._switchReads = { 0x41: 0, 0x60: 0 };
    this.outputRoutines = [0x01, 0x02, 0x03, 0x04, 0x06, 0x0a, 0x0c, 0x0d];
    this.routinesStarted = [];
    this.routinesStopped = [];
    this.outputTestsSilent = false;
    this.outputTestsRefuse = null;
    this._pumpTest = null; // { until, before }: id 0x60 is held on until `until`
    this.dataBlockId = dataBlockId;
    this.iso9141 = iso9141;
    this.address = address;
    this.answerOnTry = answerOnTry;
    this.w1Ms = w1Ms;
    this.replyMs = replyMs;
    this.frameGapMs = frameGapMs;
    this.keyBytes = keyBytes;
    this.target = target;
    this.obd = obd;
    this.funcOnly = funcOnly;
    this.requireLongLow = requireLongLow;
    this.unaddressedReplies = unaddressedReplies;
    this.clock = clock;
    // Raw values as the ECU would send them, keyed by data ID (the bike's gauges)
    this.rpmRaw = 4000 * 4; // 4000 rpm -> raw/4
    this.gauges = {
      0x100: () => this.rpmRaw, // rpm = floor(raw/40)*10
      0x01: () => 128, // tps ~ 50 %
      0x17: () => 101, // map 1010 hPa
      0x09: () => 130, // coolant 90 C
      0x11: () => 62, // intake air 22 C
      0x07: () => 138, // battery 13.8 V
      0x21: () => 8, // highest bit 4 -> gear 4
    };
    // ISO 9141 OBD data (see the class comment)
    this.pids = {
      0x01: [0x82, 0x00, 0x00, 0xff], // MIL on, 2 stored codes
      0x03: [0x02, 0x00], // fuel system status: closed loop
      0x04: [102], // load ~40 %
      0x05: [130], // coolant 90 C
      0x06: [128], // short-term fuel trim 0 %
      0x0b: [101], // MAP 101 kPa
      0x0c: [0x3e, 0x80], // 4000 rpm
      0x0d: [0], // speed 0
      0x0e: [152], // timing advance 12 deg
      0x0f: [62], // intake air 22 C
      0x11: [128], // throttle ~50 %
      0x14: [0x5a, 0xff], // O2 sensor 1: 0.45 V, trim unused
      0x1c: [0x06], // OBD standard
    };
    this.storedCodes = [0x0078, 0x1108]; // P0078, P1108
    this.modes = {
      0x01: (pid) => {
        if (pid === 0x00) return [0x41, 0x00, ...this._pidBitmap()];
        const v = this.pids[pid];
        return v === undefined ? null : [0x41, pid, ...(typeof v === 'function' ? v() : v)];
      },
      0x03: () => {
        const frames = [];
        for (let i = 0; i < Math.max(this.storedCodes.length, 1); i += 3) {
          const slots = [0, 1, 2].flatMap((k) => {
            const c = this.storedCodes[i + k] ?? 0;
            return [c >> 8, c & 0xff];
          });
          frames.push([0x43, ...slots]);
        }
        return frames;
      },
      0x31: (routine) => this._routine('start', routine),
      0x32: (routine) => this._routine('stop', routine),
      0x22: (hi, lo) => {
        if (!this.unlocked) return [0x7f, 0x33, 0x36]; // refusal whose second byte is not the service
        this._endPumpTest();
        if (this.silentIds.has((hi << 8) | lo)) return null; // the real bike says nothing at all for some ids
        const v = this.dataIds[(hi << 8) | lo];
        return v === undefined ? [0x7f, 0x33, 0x31] : [0x62, hi, lo, ...(typeof v === 'function' ? v() : v)];
      },
      0x27: (level, ...key) => this._securityAccess(level, key),
    };
    this.dataIds = {
      0x07: [0, 138], // battery 13.8 V
      0x21: [0, 8], // gear: highest bit 4 -> gear 4
      0x41: () => [0, this._switchReads[0x41]++ % 2 ? 0xff : 0xfe], // clutch lever, flips on every read
      0x60: () => [0, this._switchReads[0x60]++ % 2 ? 0x00 : 0x01], // a relay, flips on every read
      // The rest of the bike's switch table, standing still (a test makes one move by assigning a function)
      0x40: [0, 0x00], // neutral (inverted: 00 = in neutral)
      0x42: [0, 0xff],
      0x44: [0, 0xff],
      0x46: [0, 0x00], // start switch: released
      0x62: [0, 0xff],
      0x64: [0, 0xff],
      0x66: [0, 0xff], // inverted: ff = off
      0x69: [0, 0xff], // main relay on
      0x70: [0, 0xff],
      0x26: [0, 128], // sidestand sensor: 128 / 51 = 2.51 V
      0x28: [2, 0], // rollover switch: 512 * 4.887 / 1000 = 2.5 V
      // ids with no name in the bike's table, for the discovery sweep
      0x10: [0x12, 0x34],
      0x11: [0, 5],
      0x80: [0xab, 0xcd],
      0x123: [0, 1],
    };
    this.silentIds = new Set(); // 0x22 ids the unlocked ECU does not answer at all (as opposed to refusing them)
    this.slowInits = []; // every 5-baud address the ECU decoded: { at, address, idleMs, valid, why, answered, ackDelayMs, acknowledged }
    this.acks = []; // ~KB2 bytes judged: { delayMs, ok }
    this._edges = []; // break line edges of the address being received: { on, at }
    this._low = false;
    this._slowState = 'idle'; // 'idle' | 'await-ack' | 'session'
    this._validInits = 0;
    this._slowBusAt = clock.now();
    this._groupIdleMs = 0;
    this._kb2At = 0;
    this._lastRequestAt = 0;
    this._currentInit = null;
    this._sched = []; // bytes the ECU will send, { at, byte }, in time order
    this.rxBuf = [];
    this.events = []; // line events, see trace()
    this.requests = []; // requests the awake ECU received: { service, data }
    this.pulses = []; // wake-up pulses the ECU observed: { style, idleMs, lowMs, preLowMs, valid }
    this.faults = [];
    this.baud = 10400;
    this.closed = false;
    this.sensorTick = 0;
    this.dtcsCleared = false;
    this.pendingOnce = true; // first 0x18 request answers 7F..78 then the real thing
    this.woken = false; // a valid pulse was seen and nothing has been sent since
    this.inSession = false; // StartCommunication accepted
    this._lastBusAt = clock.now(); // the bus was just busy: idle has to come from the tester
    this._pulseStart = null;
    this._breakAt = null;
    this._preLowMs = 0;
    this._zeroAt360 = null;
  }

  /**
   * Queue a fault for the next `times` requests that reach the ECU (limited to
   * one service byte if `service` is given). kind:
   *   'dropReply'    the ECU stays silent
   *   'badChecksum'  the reply's checksum byte is corrupted
   *   'partialEcho'  only the first half of our frame is echoed, no reply
   *   'wrongService' the reply answers a different service
   */
  inject(kind, { times = 1, service } = {}) {
    this.faults.push({ kind, times, service });
  }

  /** Compact view of the line events: 'baud:360', 'break:on', 'flush', 'tx:00', ... */
  trace() {
    return this.events.map((e) => {
      switch (e.type) {
        case 'baud': return `baud:${e.baud}`;
        case 'break': return `break:${e.on ? 'on' : 'off'}`;
        case 'flush': return 'flush';
        case 'write': return `tx:${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
        default: return e.type;
      }
    });
  }

  /** Clock time between two events (indexes into `events`). */
  gap(from, to) {
    return this.events[to].at - this.events[from].at;
  }

  _record(event) {
    this.events.push({ ...event, at: this.clock.now() });
  }

  async open() {
    this._record({ type: 'open' });
  }

  async close() {
    this.closed = true;
    this._record({ type: 'close' });
  }

  async setBaud(baud) {
    this._record({ type: 'baud', baud });
    const wasAt360 = this.baud === 360;
    this.baud = baud;
    if (wasAt360 && baud === 10400 && this._zeroAt360 !== null) {
      // 0x00 at 360 baud is a 25 ms low (9 bit times); the line is back high now.
      this._finishPulse({ style: 'baud', lowMs: 25, preLowMs: this._preLowMs });
      this._zeroAt360 = null;
      this._preLowMs = 0;
    }
  }

  async setBreak(on) {
    this._record({ type: 'break', on });
    if (this.baud !== 360) this._lineEdge(on);
    if (on) {
      if (this._breakAt === null) {
        this._breakAt = this.clock.now();
        if (this._pulseStart === null) this._pulseStart = this._breakAt;
      }
    } else if (this._breakAt !== null) {
      const held = this.clock.now() - this._breakAt;
      this._breakAt = null;
      if (this.baud === 360) {
        this._preLowMs = held; // long low ahead of the 0x00 byte
      } else if (held > LONG_BREAK_MS) {
        this._pulseStart = null; // a bit of a slow-init address, not a wake-up pulse
      } else {
        this._finishPulse({ style: 'break', lowMs: held, preLowMs: 0 });
      }
    }
  }

  /** Track the break line as the ECU's receiver sees it (state changes only). */
  _lineEdge(on) {
    if (on === this._low) return;
    const now = this.clock.now();
    if (on && this._edges.length === 0) this._groupIdleMs = now - this._slowBusAt;
    this._low = on;
    this._edges.push({ on, at: now });
    this._slowBusAt = now;
    if (on) {
      this._slowState = 'idle'; // a new address aborts whatever was going on
      this._lock();
    } else if (this.iso9141) this.rxBuf.push(0x00); // the end of a break shows up as a garbage byte
  }

  /** Decode a finished 5-baud address (the line is released) and, if it is ours and well formed, start answering. */
  _decodeAddress() {
    const edges = this._edges;
    this._edges = [];
    if (!this.iso9141) return;
    const t0 = edges[0].at;
    const now = this.clock.now();
    const level = (x) => edges.reduce((low, e) => (e.at <= x ? e.on : low), false) ? 0 : 1;
    let decoded = null;
    // Longest bit time that fits wins, so the answer never starts before the address has really ended.
    for (let bitMs = SLOW_BIT_MAX_MS; bitMs >= SLOW_BIT_MIN_MS && !decoded; bitMs--) {
      const bit = (i) => level(t0 + (i + 0.5) * bitMs);
      if (bit(0) !== 0 || bit(9) !== 1 || now < t0 + 9.5 * bitMs) continue; // start low, stop high, address finished
      decoded = { bitMs, address: [...Array(8).keys()].reduce((a, i) => a | (bit(1 + i) << i), 0) };
    }
    const init = { at: t0, address: decoded?.address ?? null, idleMs: this._groupIdleMs, valid: false, why: null, answered: false, ackDelayMs: null, acknowledged: false };
    this.slowInits.push(init);
    if (!decoded) init.why = 'framing: not start low / 8 data bits / stop high at 5 baud +-10 %';
    else if (decoded.address !== this.address) init.why = `address 0x${decoded.address.toString(16)} is not ours`;
    else if (init.idleMs < SLOW_IDLE_MS) init.why = `bus idle only ${init.idleMs} ms, need ${SLOW_IDLE_MS}`;
    else {
      init.valid = true;
      this._validInits++;
      if (this._validInits < this.answerOnTry) {
        init.why = 'valid, but this one is skipped (answerOnTry)';
        return;
      }
      init.answered = true;
      const end = t0 + 10 * decoded.bitMs;
      const sync = end + this.w1Ms;
      this._sendAt(sync, [0x55]);
      this._sendAt(sync + 10, [this.keyBytes[0]]);
      this._kb2At = sync + 20;
      this._sendAt(this._kb2At, [this.keyBytes[1]]);
      this._slowState = 'await-ack';
      this._currentInit = init;
    }
  }

  /** The ECU sends `bytes` at clock time `at`. */
  _sendAt(at, bytes) {
    this._slowBusAt = Math.max(this._slowBusAt, at);
    for (const byte of bytes) {
      const i = this._sched.findIndex((x) => x.at > at);
      this._sched.splice(i < 0 ? this._sched.length : i, 0, { at, byte });
    }
  }

  _deliverDue() {
    const now = this.clock.now();
    while (this._sched.length && this._sched[0].at <= now) this.rxBuf.push(this._sched.shift().byte);
  }

  /** Whatever is pending before the tester touches the receive side or the line: a finished address gets decoded. */
  _settle() {
    if (this._edges.length && !this._low) this._decodeAddress();
    this._deliverDue();
  }

  _lock() {
    this.unlocked = false;
    this._seedIssued = false;
  }

  /** Service 0x27, levels 05 (seed) and 06 (key) only. Returns a reply payload, or null for silence. */
  _securityAccess(level, key) {
    if (this.unlockMultiplier === undefined) return null;
    if (level === 0x05) {
      this.seedRequests++;
      this._seedIssued = true;
      const seed = this.unlocked ? 0 : this.seed;
      if (seed === 0) this.unlocked = true;
      return [0x67, 0x05, seed >> 8, seed & 0xff];
    }
    if (level === 0x06) {
      this.keyAttempts++;
      if (key.length !== 2) return [0x7f, 0x27, 0x13];
      const sent = (key[0] << 8) | key[1];
      this.keysReceived.push(sent);
      if (!this._seedIssued) return [0x7f, 0x27, 0x24]; // requestSequenceError
      if (sent !== ((this.seed * this.unlockMultiplier) & 0xffff)) return [0x7f, 0x27, 0x35];
      this.unlocked = true;
      return [0x67, 0x06];
    }
    return [0x7f, 0x27, 0x12];
  }

  /** Services 0x31 / 0x32. Returns a reply payload, or null for silence. */
  _routine(kind, routine) {
    if (!this.unlocked) return [0x7f, 0x33, 0x36];
    if (this.outputTestsSilent) return null;
    const service = kind === 'start' ? 0x31 : 0x32;
    if (!this.outputRoutines.includes(routine)) return [0x7f, service, 0x12];
    if (kind === 'start' && this.outputTestsRefuse !== null) return [0x7f, service, this.outputTestsRefuse];
    (kind === 'start' ? this.routinesStarted : this.routinesStopped).push(routine);
    if (kind === 'start' && routine === 0x04) {
      this._pumpTest ??= { before: this.dataIds[0x60] };
      this._pumpTest.until = this.clock.now() + 3000;
      this.dataIds[0x60] = [0, 0xff];
    }
    return [service + 0x40, routine];
  }

  _endPumpTest() {
    if (this._pumpTest && this.clock.now() >= this._pumpTest.until) {
      this.dataIds[0x60] = this._pumpTest.before;
      this._pumpTest = null;
    }
  }

  _pidBitmap() {
    const bytes = [0, 0, 0, 0];
    for (let pid = 1; pid < 0x20; pid++) {
      if (this.pids[pid] !== undefined) bytes[(pid - 1) >> 3] |= 0x80 >> ((pid - 1) & 7);
    }
    return bytes;
  }

  _finishPulse({ style, lowMs, preLowMs }) {
    const idleMs = this._pulseStart - this._lastBusAt;
    const valid =
      idleMs >= WAKE_IDLE_MS &&
      lowMs >= WAKE_LOW_MS &&
      (!this.requireLongLow || preLowMs >= LONG_LOW_MS);
    this.pulses.push({ style, idleMs, lowMs, preLowMs, valid });
    this.woken = valid && !this.iso9141;
    this.inSession = false;
    this._pulseStart = null;
  }

  flushInput() {
    this._record({ type: 'flush' });
    this._settle();
    this.rxBuf.length = 0;
    return Promise.resolve();
  }

  unshift(bytes) {
    this.rxBuf.unshift(...bytes);
  }

  async readByte(timeoutMs) {
    this._settle();
    if (this.rxBuf.length) return this.rxBuf.shift();
    const deadline = this.clock.now() + timeoutMs;
    const next = this._sched[0];
    if (next && next.at <= deadline) {
      this.clock.t = Math.max(this.clock.now(), next.at); // wait (in fake time) for the ECU's byte
      await tick();
      this._deliverDue();
      return this.rxBuf.shift();
    }
    this.clock.t = deadline; // nothing arrives: the whole wait passes (in fake time)
    await tick();
    return null;
  }

  frame(data, to = 0xf1) {
    let f;
    if (this.unaddressedReplies) {
      f = data.length <= 63 ? [data.length, ...data] : [0x00, data.length, ...data];
    } else {
      f = data.length <= 63 ? [0x80 | data.length, to, this.target, ...data] : [0x80, to, this.target, data.length, ...data];
    }
    f.push(f.reduce((a, b) => (a + b) & 0xff, 0));
    return f;
  }

  _takeFault(service) {
    const i = this.faults.findIndex((f) => f.service === undefined || f.service === service);
    if (i < 0) return null;
    const f = this.faults[i];
    if (--f.times <= 0) this.faults.splice(i, 1);
    return f.kind;
  }

  async write(bytes) {
    await tick();
    this._record({ type: 'write', bytes: [...bytes], baud: this.baud });

    if (this.baud === 360) {
      // wake-up pulse byte; the loopback echoes it
      if (bytes.length === 1 && bytes[0] === 0x00) {
        if (this._pulseStart === null) this._pulseStart = this.clock.now();
        this._zeroAt360 = this.clock.now();
      }
      this.rxBuf.push(...bytes);
      return;
    }

    this._settle();
    this._lastBusAt = this._slowBusAt = this.clock.now();
    if (this.iso9141) return this._writeIso(bytes);
    // A pulse only covers the first frame that follows it, whoever it is for.
    const justWoken = this.woken;
    this.woken = false;

    // parse request: fmt tgt src [len] data... cs
    const fmt = bytes[0];
    let len = fmt & 0x3f;
    let at = 3;
    if (len === 0) {
      len = bytes[3];
      at = 4;
    }
    const data = bytes.slice(at, at + len);
    const csOk = bytes[at + len] === (bytes.slice(0, at + len).reduce((a, b) => (a + b) & 0xff, 0));
    const addressed = bytes[1] === this.target && (!this.funcOnly || (fmt & 0xc0) === 0xc0);

    const fault = addressed && csOk ? this._takeFault(data[0]) : null;
    if (fault === 'partialEcho') {
      this.rxBuf.push(...bytes.slice(0, Math.ceil(bytes.length / 2)));
    } else {
      this.rxBuf.push(...bytes); // echo first (loopback)
    }
    if (!addressed || !csOk) return; // not us: stay silent
    if (justWoken && data[0] === 0x81) this.inSession = true;
    if (!this.inSession) return; // ECU asleep: silent
    this.requests.push({ service: data[0], data });
    if (fault === 'dropReply' || fault === 'partialEcho') return;

    const reply = this._respond(data, bytes[2]);
    if (!reply) return;
    if (fault === 'wrongService') reply[0] = (reply[0] + 1) & 0xff;
    const out = this.frame(reply, bytes[2]);
    if (fault === 'badChecksum') out[out.length - 1] ^= 0xff;
    this.rxBuf.push(...out);
  }

  /** ISO 9141 mode: the ~KB2 acknowledgement, then OBD-II frames. Anything else is echoed and ignored. */
  _writeIso(bytes) {
    const now = this.clock.now();
    if (this._slowState === 'await-ack') {
      this.rxBuf.push(...bytes);
      const delayMs = now - this._kb2At;
      const ok = bytes.length === 1 && bytes[0] === (~this.keyBytes[1] & 0xff) && delayMs >= SLOW_ACK_MIN_MS && delayMs <= SLOW_ACK_MAX_MS;
      this.acks.push({ delayMs, ok });
      Object.assign(this._currentInit, { ackDelayMs: delayMs, acknowledged: ok });
      if (ok) {
        this._slowState = 'session';
        this._lastRequestAt = now;
        this._sendAt(now + SLOW_W4_MS, [~this.address & 0xff]);
      } else {
        this._slowState = 'idle'; // the ECU gives up on the init
      }
      return;
    }
    if (this._slowState === 'session' && now - this._lastRequestAt > ECU_P3MAX_MS) {
      this._slowState = 'idle';
      this._lock();
    }

    const mine = this._slowState === 'session' && bytes.length >= 5 && ISO_REQUEST_HEADER.every((h, i) => bytes[i] === h) && bytes.at(-1) === sum(bytes.slice(0, -1));
    const data = mine ? bytes.slice(3, -1) : null;
    const fault = mine ? this._takeFault(data[0]) : null;
    this.rxBuf.push(...(fault === 'partialEcho' ? bytes.slice(0, Math.ceil(bytes.length / 2)) : bytes)); // echo first (loopback)
    if (!mine) return;
    this._lastRequestAt = now;
    this.requests.push({ service: data[0], data });
    if (fault === 'dropReply' || fault === 'partialEcho') return;

    const handler = this.modes[data[0]];
    const result = handler?.(...data.slice(1));
    if (!result) return; // unsupported: the real ECU says nothing at all
    const payloads = Array.isArray(result[0]) ? result.map((p) => [...p]) : [[...result]];
    if (fault === 'wrongService') payloads[0][0] = (payloads[0][0] + 1) & 0xff;
    payloads.forEach((payload, i) => {
      const frame = [...ISO_REPLY_HEADER, ...payload];
      frame.push(sum(frame));
      if (fault === 'badChecksum' && i === 0) frame[frame.length - 1] ^= 0xff;
      this._sendAt(now + this.replyMs + i * this.frameGapMs, frame);
    });
  }

  /** Service logic; extra frames (responsePending, multi-frame) go straight to rxBuf. */
  _respond(data, to) {
    const [svc, ...p] = data;
    let resp = null;
    switch (svc) {
      case 0x81:
        resp = [0xc1, 0xea, 0x8f];
        break;
      case 0x82:
        resp = [0xc2];
        this.inSession = false;
        break;
      case 0x3e:
        resp = [0x7e];
        break;
      case 0x10:
        resp = [0x50, p[0]];
        break;
      case 0x1a:
        if (p[0] === 0x80) resp = [0x5a, 0x80, ...Buffer.from('1290350-T675-KEIHIN')];
        else resp = [0x7f, 0x1a, 0x12];
        break;
      case 0x21:
        if (p[0] === this.dataBlockId) {
          this.sensorTick++;
          const block = new Array(64).fill(0);
          block[4] = 0x01; // TPS hi
          block[5] = (this.sensorTick * 7) & 0xff; // TPS lo, moves every poll
          block[10] = 90; // pretend coolant
          resp = [0x61, this.dataBlockId, ...block];
        } else resp = [0x7f, 0x21, 0x12];
        break;
      case 0x18:
        if (this.pendingOnce) {
          this.pendingOnce = false;
          this.rxBuf.push(...this.frame([0x7f, 0x18, 0x78], to));
        }
        resp = this.dtcsCleared
          ? [0x58, 0x00]
          : [0x58, 0x02, 0x05, 0x15, 0xe0, 0x11, 0x13, 0x60]; // P0515, P1113
        break;
      case 0x14:
        this.dtcsCleared = true;
        resp = [0x54];
        break;
      case 0x22: {
        const id = (p[0] << 8) | p[1];
        if (id === 0x41) {
          this.clutch = !this.clutch; // toggles each read, like a lever being worked
          resp = [0x62, p[0], p[1], 0x00, this.clutch ? 0xfe : 0xff];
        } else if (id === 0x60) {
          resp = [0x62, p[0], p[1], 0x00, 0x01];
        } else if (this.gauges && id in this.gauges) {
          const raw = this.gauges[id]();
          resp = [0x62, p[0], p[1], (raw >> 8) & 0xff, raw & 0xff];
        } else {
          resp = [0x7f, 0x22, 0x31];
        }
        break;
      }
      case 0x03:
        if (!this.obd) { resp = [0x7f, 0x03, 0x11]; break; }
        if (this.dtcsCleared) { resp = [0x43, 0, 0, 0, 0, 0, 0]; break; }
        // four stored codes -> two reply frames
        this.rxBuf.push(...this.frame([0x43, 0x00, 0x78, 0x01, 0x35, 0x05, 0x05], to));
        resp = [0x43, 0x01, 0x22, 0, 0, 0, 0];
        break;
      case 0x07:
        if (!this.obd) { resp = [0x7f, 0x07, 0x11]; break; }
        resp = this.dtcsCleared ? [0x47, 0, 0, 0, 0, 0, 0] : [0x47, 0x00, 0x78, 0x03, 0x35, 0, 0];
        break;
      case 0x04:
        if (!this.obd) { resp = [0x7f, 0x04, 0x11]; break; }
        this.dtcsCleared = true;
        resp = [0x44];
        break;
      case 0x77: // test service: answers with its own payload (exercises >63-byte frames both ways)
        resp = [0xb7, ...p];
        break;
      default:
        resp = [0x7f, svc, 0x11];
    }
    return resp;
  }
}

module.exports = { MockEcuTransport, fakeClock };
