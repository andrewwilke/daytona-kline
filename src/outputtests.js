'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { KwpError, KwpNegativeResponse, FAILURE, hex } = require('./kwp');
const svc = require('./services');

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');

// The only two requests in this tool that make the ECU drive something. They are
// built here and nowhere else (test/outputtests.test.js greps the source tree for
// it), and only from a routine byte of the bike's `outputTests` table.
const SERVICE_START = 0x31;
const SERVICE_STOP = 0x32;

const WATCH_MS = 8000;
const WATCH_STOP_MS = 15000; // a test that has to be stopped gets a longer look
const WATCH_PAUSE_MS = 250;
const COOLDOWN_MS = 5000;
const BATTERY_MIN_V = 10.5;
const BATTERY_WARN_V = 11.5;
const REPLY_TIMEOUT_MS = 1000;

/** What has to be true before a test is sent, in words (the CLI and the page show these). */
const PRECONDITIONS = [
  'the ECU is unlocked',
  'the bike is stationary (speed 0) and the engine is off (rpm 0), with the key on',
  `the battery is at least ${BATTERY_MIN_V} V (below ${BATTERY_WARN_V} V the ECU may reset)`,
  'no other output test is running, and the last one ended at least a few seconds ago',
  'you have clear access to the fan and the exhaust valve and understand the test makes the bike move or run parts',
];

/** Why a test was refused, in `.kind`: unknown-test, not-confirmed, not-connected, locked, busy, cooldown, engine-running, engine-unknown, moving, speed-unknown, battery-low, battery-unknown. */
class OutputTestError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'OutputTestError';
    this.kind = kind;
  }
}

const hex2 = (n) => `0x${n.toString(16).padStart(2, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The bike's whitelist as plain descriptions (no function, nothing a caller could send). */
function listTests(bike) {
  return (bike.outputTests ?? []).map(({ key, name, routine, needsStop, see, safety, effectId, confirmation, evidence }) =>
    ({ key, name, routine, needsStop, see, safety, effectId, confirmation, evidence }));
}

/** The test with this key in the bike's table, or undefined. Nothing else is ever looked up. */
function findTest(bike, key) {
  return typeof key === 'string' ? (bike.outputTests ?? []).find((t) => t.key === key) : undefined;
}

/** null when the connection is unlocked, else "needs the ECU unlock, not available (why)". */
function unlockProblem(conn) {
  if (conn.unlockState === 'unlocked') return null;
  return svc.needsUnlock(conn) ?? `needs the ECU unlock, not available (${conn.unlockReason ?? `unlock is ${conn.unlockState}`})`;
}

const controllers = new WeakMap();

/** What survives between tests on one connection: the running test (or the last one) and when the last one ended. */
function controllerOf(conn) {
  let c = controllers.get(conn);
  if (!c) {
    c = { claimed: false, current: null, endedAt: null };
    controllers.set(conn, c);
  }
  return c;
}

function cooldownLeftMs(conn) {
  const { endedAt } = controllerOf(conn);
  return endedAt === null ? 0 : Math.min(COOLDOWN_MS, Math.max(0, COOLDOWN_MS - (conn.clock.now() - endedAt))); // a clock that jumped back never waits longer than the cooldown
}

function appendLog(conn, logDir, text) {
  const file = path.join(logDir, `output-tests-${iso(conn.clock.now()).slice(0, 10)}.txt`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(file, `${text}\n`);
    return { file };
  } catch (e) {
    return { file: null, error: e.message };
  }
}

async function readNumber(read) {
  try {
    return await read();
  } catch {
    return null; // a failing link is "cannot be read" here: the caller refuses
  }
}

async function readEngineValue(session, pid) {
  return readNumber(async () => {
    const bytes = await svc.readPid(session, pid);
    return bytes ? svc.decodePid(pid, bytes).value : null;
  });
}

async function readBattery(conn, session) {
  const def = conn.bike.gauges.find((g) => g.key === 'battery' && g.id != null);
  if (!def) return null;
  return readNumber(async () => (await svc.readGauge(session, def))?.value ?? null);
}

/**
 * One output test, from the moment the ECU was asked until the watch ended.
 * `done` resolves (never rejects) with the view when it is over; `stop()` ends it
 * early. Events: 'update' (view) whenever something changed, 'end' (view).
 */
class OutputTest extends EventEmitter {
  constructor(conn, def, { session, registration, logDir, controller, preconditions, warnings }) {
    super();
    this.conn = conn;
    this.def = def;
    this.session = session;
    this.registration = registration;
    this.logDir = logDir;
    this.controller = controller;
    this.preconditions = preconditions;
    this.warnings = warnings;
    this.state = 'starting'; // 'starting' | 'running' | 'finished' | 'failed'
    this.outcome = null; // 'completed' | 'stopped' | 'cancelled' | 'refused-by-ecu' | 'no-answer' | 'link-error'
    this.reply = null;
    this.code = null;
    this.error = null;
    this.startedAt = conn.clock.now();
    this.endedAt = null;
    this.watchMs = def.needsStop ? WATCH_STOP_MS : WATCH_MS;
    this.stopSent = false;
    this.stopReply = null;
    this.stopError = null;
    this.logFile = null;
    this.logError = null;
    this.battery = { min: null, max: null };
    this.effectDef = def.effectId == null ? null : conn.bike.switches.find((s) => s.id === def.effectId) ?? null;
    this.effect = { id: def.effectId, name: this.effectDef?.name ?? null, samples: [] };
    this._started = false;
    this._stopRequested = false;
    this._stopPromise = null;
    this._wake = new Promise((resolve) => { this._wakeUp = resolve; });
    this.done = new Promise((resolve) => { this._resolve = resolve; });
    this.signal = registration.signal;
    this.signal.addEventListener('abort', () => {
      this._wakeUp();
      this._sendStop(); // the connection closes the port right after cancelling runs: best effort
    }, { once: true });
  }

  get running() {
    return this.state === 'starting' || this.state === 'running';
  }

  /** Ends the watch early; the tests that end by themselves are not sent anything, the idle speed control gets its stop. */
  stop() {
    if (this.running) {
      this._stopRequested = true;
      this._wakeUp();
    }
    return this.done;
  }

  view() {
    const samples = this.effect.samples;
    const changes = samples.filter((s, i) => i > 0 && s.hex !== samples[i - 1].hex).length;
    return {
      key: this.def.key,
      name: this.def.name,
      routine: this.def.routine,
      needsStop: this.def.needsStop,
      see: this.def.see,
      safety: this.def.safety,
      confirmation: this.def.confirmation,
      state: this.state,
      running: this.running,
      outcome: this.outcome,
      reply: this.reply,
      code: this.code,
      error: this.error,
      warnings: this.warnings,
      preconditions: this.preconditions,
      startedAt: this.startedAt,
      elapsedMs: (this.endedAt ?? this.conn.clock.now()) - this.startedAt,
      watchMs: this.watchMs,
      battery: this.battery,
      effect: { ...this.effect, changes, sawActive: samples.some((s) => s.active === true), text: this._effectText() },
      stopSent: this.stopSent,
      stopReply: this.stopReply,
      stopError: this.stopError,
      logFile: this.logFile,
      logError: this.logError,
    };
  }

  _effectText() {
    const { id, name, samples } = this.effect;
    if (id == null) return 'no switch to watch for this test: check it by eye or ear';
    if (!samples.length) return `${name ?? `id 0x${id.toString(16)}`}: not read`;
    const state = (s) => (s.active === null || s.active === undefined ? '' : ` (${svc.switchState(this.effectDef, s.active)})`);
    const parts = [`${samples[0].hex}${state(samples[0])}`];
    samples.forEach((s, i) => {
      if (i > 0 && s.hex !== samples[i - 1].hex) parts.push(`${s.hex}${state(s)} at +${seconds(s.t_ms)}`);
    });
    return `${name ?? `id 0x${id.toString(16)}`}: ${parts.join(' -> ')}${parts.length === 1 ? ' (no change seen)' : ''}`;
  }

  _log(text) {
    const r = appendLog(this.conn, this.logDir, `${iso(this.conn.clock.now())}  ${this.def.name} (routine ${hex2(this.def.routine)}, ${this.def.confirmation})  ${text}`);
    this.logFile ??= r.file;
    if (r.error) this.logError = r.error;
  }

  _fail(outcome, error, extra = {}) {
    this.state = 'failed';
    this.outcome = outcome;
    this.error = error;
    Object.assign(this, extra);
    this._log(`sent ${hex([SERVICE_START, this.def.routine])}  ${error}`);
    this._finish();
  }

  /** Baseline read, the one start request, its reply; on success the watch carries on by itself. */
  async begin() {
    await this._readEffect(true);
    let payload;
    try {
      ({ payload } = await this.session.request([SERVICE_START, this.def.routine], { timeout: REPLY_TIMEOUT_MS, retries: 0, destructive: true }));
    } catch (e) {
      if (e instanceof KwpNegativeResponse) {
        const why = e.code === 0x36 ? ' (the ECU is locked)' : '';
        this._fail('refused-by-ecu', `the ECU refused the test (negative response, code ${hex2(e.code)})${why}`, { code: e.code });
      } else if (e instanceof KwpError && e.kind === FAILURE.TIMEOUT) {
        this._fail('no-answer', 'no answer from the ECU (the test was sent once and is not resent)');
      } else {
        this._fail('link-error', `the request failed: ${e.message}`);
      }
      return this;
    }
    this.reply = hex(payload);
    if (payload[1] !== this.def.routine) {
      this._fail('link-error', `unexpected reply [${this.reply}]: not the test that was asked for`);
      return this;
    }
    this._started = true;
    this.state = 'running';
    this._log(`sent ${hex([SERVICE_START, this.def.routine])}  reply ${this.reply}  started; ${this.preconditions.text}${this.warnings.length ? `; WARNING: ${this.warnings.join('; ')}` : ''}`);
    this.emit('update', this.view());
    this._watch().catch((e) => {
      if (!this.running) return;
      this.state = 'failed';
      this.outcome = 'link-error';
      this.error = e.message;
      this._finish();
    });
    return this;
  }

  async _watch() {
    const clock = this.conn.clock;
    const deadline = this.startedAt + this.watchMs;
    while (!this.signal.aborted && !this._stopRequested && clock.now() < deadline) {
      await this._readEffect(false);
      await this._readBattery();
      this.emit('update', this.view());
      if (this.signal.aborted || this._stopRequested) break;
      await Promise.race([clock.sleep(WATCH_PAUSE_MS), this._wake]);
    }
    await this._end(this.signal.aborted ? 'cancelled' : this._stopRequested ? 'stopped' : 'completed');
  }

  async _readEffect(baseline) {
    if (this.effect.id == null || this.signal.aborted) return;
    let bytes = null;
    try {
      bytes = await svc.readIdBytes(this.session, this.effect.id);
    } catch {
      // a failed read leaves a gap in the samples; the watch carries on
    }
    if (!bytes?.length) return;
    this.effect.samples.push({
      t_ms: baseline ? 0 : this.conn.clock.now() - this.startedAt,
      hex: hex(bytes),
      active: this.effectDef ? svc.decodeSwitch(this.effectDef, bytes).active : null,
    });
  }

  async _readBattery() {
    if (this.signal.aborted) return;
    const v = await readBattery(this.conn, this.session);
    if (v === null) return;
    this.battery = { min: Math.min(this.battery.min ?? v, v), max: Math.max(this.battery.max ?? v, v) };
  }

  _sendStop() {
    if (!this.def.needsStop || !this._started) return Promise.resolve();
    if (!this._stopPromise) {
      this.stopSent = true;
      this._stopPromise = this.session.request([SERVICE_STOP, this.def.routine], { timeout: REPLY_TIMEOUT_MS, retries: 0, destructive: true })
        .then(({ payload }) => { this.stopReply = hex(payload); })
        .catch((e) => { this.stopError = e.message; });
    }
    return this._stopPromise;
  }

  async _end(outcome) {
    await this._sendStop();
    this.state = 'finished';
    this.outcome = outcome;
    const stop = this.def.needsStop ? `; stop ${this.stopError ? `NOT acknowledged (${this.stopError})` : `sent, reply ${this.stopReply}`}` : '';
    const volts = this.battery.min === null ? '' : `; battery ${this.battery.min.toFixed(1)}-${this.battery.max.toFixed(1)} V`;
    this._log(`ended: ${outcome} after ${seconds(this.conn.clock.now() - this.startedAt)}; effect: ${this._effectText()}${volts}${stop}`);
    this._finish();
  }

  _finish() {
    this.endedAt = this.conn.clock.now();
    this.controller.endedAt = this.endedAt;
    this.registration.end();
    const view = this.view();
    this.emit('update', view);
    this.emit('end', view);
    this._resolve(view);
  }
}

/**
 * Drive one of the bike's output tests (src/bikes: `outputTests`) and watch the effect.
 *
 *   const test = await runOutputTest(conn, 'fuelPump', { confirmed: true });
 *   test.view()          // state, the reply, the effect seen, warnings...
 *   await test.done      // resolves with the view once the watch is over
 *   test.stop()          // end it now (the idle speed control then gets its stop)
 *
 * This is the one place in the tool that commands the ECU to do something, so it refuses
 * (throws an OutputTestError, after writing the attempt to the log) unless ALL of these hold:
 * `confirmed` is exactly true (the caller has asked the human; this never prompts), the key is a
 * test of the bike's table, the connection is connected and unlocked, no other test is running or
 * has ended in the last COOLDOWN_MS, the engine speed (PID 0C) and vehicle speed (PID 0D) can be
 * read and are 0, and the battery (0x22 id 7) can be read and is at least 10.5 V. Below 11.5 V the
 * test goes ahead with a warning. The request is `destructive` (never resent, no retries) and sent
 * once; a negative response or silence ends the test as a failed one (`view().outcome`), reported
 * once. The watch (8 s, 15 s for a test that needs its stop) polls the effect id and the battery,
 * which also keeps the session busy enough for the ECU; a disconnect or a lost ECU cancels it, and the
 * stop request of a test that needs one is sent then on a best-effort basis. Options: confirmed,
 * logDir (default logs/; one file per day, output-tests-<date>.txt).
 */
async function runOutputTest(conn, key, { confirmed = false, logDir = DEFAULT_LOG_DIR } = {}) {
  const controller = controllerOf(conn);
  const def = findTest(conn.bike, key);
  const what = def ? `${def.name} (routine ${hex2(def.routine)})` : `unknown test ${JSON.stringify(String(key))}`;
  const refuse = (kind, message) => {
    appendLog(conn, logDir, `${iso(conn.clock.now())}  ${what}  REFUSED (${kind}): ${message}`);
    throw new OutputTestError(kind, message);
  };

  if (!def) {
    const keys = (conn.bike.outputTests ?? []).map((t) => t.key).join(', ');
    refuse('unknown-test', `"${key}" is not an output test this tool can run. The only ones: ${keys || '(none)'}`);
  }
  if (confirmed !== true) refuse('not-confirmed', 'output test not confirmed: the person at the bike has to say yes first');
  if (conn.state !== 'connected') refuse('not-connected', 'not connected');
  const locked = unlockProblem(conn);
  if (locked) refuse('locked', locked);
  if (controller.claimed || controller.current?.running) {
    refuse('busy', `another output test is running${controller.current?.running ? ` (${controller.current.def.name})` : ''}: wait for it to end`);
  }
  const wait = cooldownLeftMs(conn);
  if (wait > 0) refuse('cooldown', `the last output test ended a moment ago: wait ${Math.ceil(wait / 1000)} s`);

  controller.claimed = true;
  let test;
  try {
    const session = conn.requireSession();
    const rpm = await readEngineValue(session, 0x0c);
    if (rpm === null) refuse('engine-unknown', 'the engine speed (PID 0C) cannot be read: a test is only sent when the engine is known to be stopped');
    if (rpm > 0) refuse('engine-running', `the engine is running (${rpm} rpm): stop it first`);
    const speed = await readEngineValue(session, 0x0d);
    if (speed === null) refuse('speed-unknown', 'the vehicle speed (PID 0D) cannot be read: a test is only sent when the bike is known to be stationary');
    if (speed > 0) refuse('moving', `the bike is moving (${speed} km/h)`);
    const volts = await readBattery(conn, session);
    if (volts === null) refuse('battery-unknown', 'the battery voltage cannot be read (needs the ECU unlock): a test is only sent when it is known');
    if (volts < BATTERY_MIN_V) refuse('battery-low', `the battery is at ${volts} V, below ${BATTERY_MIN_V} V: charge it or connect a charger first`);
    const warnings = volts < BATTERY_WARN_V ? [`battery ${volts} V is low: the ECU may reset during the test`] : [];
    if (conn.state !== 'connected' || conn.session !== session) refuse('not-connected', 'the connection ended while the checks were running');

    test = new OutputTest(conn, def, {
      session,
      registration: conn.startRun('outputtest'),
      logDir,
      controller,
      preconditions: { rpm, speed, battery: volts, text: `rpm ${rpm}, speed ${speed}, battery ${volts} V` },
      warnings,
    });
    controller.current = test;
  } finally {
    controller.claimed = false;
  }
  return test.begin();
}

/** The running test, or the last one (an OutputTest), or null. */
function currentTest(conn) {
  return controllerOf(conn).current;
}

/** What a page or the CLI shows about the feature right now: whether it can be used, the running or last test, the cooldown. */
function outputTestStatus(conn) {
  const c = controllerOf(conn);
  const note = conn.state === 'connected' ? unlockProblem(conn) : (conn.state === 'lost' ? `connection lost: ${conn.error}` : 'not connected');
  return {
    available: note === null,
    note,
    running: !!c.current?.running,
    current: c.current?.view() ?? null,
    cooldownMs: cooldownLeftMs(conn),
  };
}

module.exports = {
  runOutputTest,
  outputTestStatus,
  currentTest,
  listTests,
  findTest,
  unlockProblem,
  OutputTestError,
  PRECONDITIONS,
  WATCH_MS,
  WATCH_STOP_MS,
  COOLDOWN_MS,
  BATTERY_MIN_V,
  BATTERY_WARN_V,
};
