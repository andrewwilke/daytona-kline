'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SerialTransport } = require('./transport');
const { wakeEcu } = require('./wakeup');
const { hex } = require('./kwp');
const { realClock } = require('./clock');
const { DEFAULT_BIKE, resolveDataBlockId } = require('./bikes');
const { loadMultiplier, unlockSession } = require('./unlock');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

async function openSerial(port) {
  const t = new SerialTransport(port);
  await t.open();
  return t;
}

/**
 * A ready ECU session and its lifetime; the CLI and the GUI server both
 * start from here.
 *
 *   const conn = new Connection();
 *   conn.on('progress', render);          // { step, ... } while connecting
 *   await conn.connect({ port: 'COM3' }); // saved wake-up first, then the bike's order
 *   conn.session                          // KwpSession, ready, keep-alive running
 *   const run = conn.startRun('live');    // loops register here, see startRun
 *   await conn.disconnect();
 *
 * `state` is 'disconnected' | 'connecting' | 'connected' | 'lost'; `error` is
 * the reason for the last failure (connect error, or why the link was lost).
 * Events: 'progress' (step: opening | attempt | attempt-failed | diag-session
 * | first-request | connected) and 'state' ({ state, error }). 'attempt' and
 * 'attempt-failed' carry `attempt` with a `text` such as "slow init 0x33, try
 * 2/6" (see wakeEcu in src/wakeup.js).
 *
 * The wake-up that worked (config.json: port, kind, target, source, addrMode;
 * kind 'slow' | 'fast', and for slow `target` is the ECU address) is tried
 * first on every connect and rewritten after each success; if it fails the
 * bike's whole order follows.
 *
 * How a session becomes ready depends on its style (src/kwp.js). Addressed
 * (KWP2000): the manufacturer diagnostic session the bike names, if any.
 * ISO 9141: no diagnostic session; the first request, mode 01 PID 00, must be
 * answered before the state turns 'connected'. The keep-alive is the style's
 * own ping (TesterPresent, or mode 01 PID 00 every ~2 s).
 *
 * `bike` is the description (src/bikes) that supplies the wake-up order and
 * diagnostic session; `dataBlockId(flag)` resolves which sensor block to read:
 * the bike's default, overridden by the id `probe` saved, overridden by `flag`.
 *
 * Unlock (ISO 9141 sessions only, src/unlock.js): the ECU refuses service 0x22
 * until security access. `unlockState` (with `unlockReason`) is 'unavailable'
 * (no unlock file, or not an ISO 9141 session: no request is ever sent),
 * 'invalid' (file unusable), 'locked' (file present, not tried), 'unlocking',
 * 'unlocked' or 'failed'. The multiplier comes from unlock.json next to
 * config.json and is read only when an attempt is made; it is never kept on the
 * Connection. Once the state turns 'connected' one attempt is made, and connect()
 * resolves after it (a failure never rejects connect). A failed attempt is never
 * repeated by the Connection: `await conn.unlock()` tries again, one key per
 * call, from 'locked' or 'failed' only. Losing or ending the session, or
 * connecting again, starts over at 'locked' / 'unavailable'. A change of
 * unlock state emits 'unlock' ({ state, reason }), not 'state'; 'state' events
 * and info() carry the current `unlock` and `unlockReason`. While an attempt
 * runs, every other request on the session (keep-alive, runs, routes) waits, so
 * nothing is sent between the seed request and the key.
 *
 * Constructor options double as public fields so tests can swap them:
 * bike, configPath, openTransport(port) -> transport, clock, keepAliveMs
 * (default: the style's interval), keepAliveLimit (consecutive link failures
 * that mean 'lost'), p3, debug, unlockPath (default: unlock.json beside
 * configPath), autoUnlock (default true; false skips the attempt after
 * connecting and leaves the state 'locked' until `unlock()` is called).
 */
class Connection extends EventEmitter {
  constructor({
    bike = DEFAULT_BIKE,
    configPath = DEFAULT_CONFIG_PATH,
    openTransport = openSerial,
    clock = realClock,
    keepAliveMs = null,
    keepAliveLimit = 3,
    p3,
    debug = false,
    unlockPath = null,
    autoUnlock = true,
  } = {}) {
    super();
    Object.assign(this, { bike, configPath, openTransport, clock, keepAliveMs, keepAliveLimit, p3, debug, unlockPath, autoUnlock });
    this.state = 'disconnected';
    this.error = null;
    this.progress = null; // last progress event
    this.transport = null;
    this.port = null;
    this.kind = null; // 'slow' | 'fast': the wake-up that worked
    this.style = null; // the session's framing style
    this.target = null;
    this.source = null;
    this.addrMode = null;
    this.keyBytes = null;
    this.diagSession = false; // ECU accepted the manufacturer diagnostic session
    this._session = null;
    this._runs = new Map();
    this._keepAlive = null;
    this._connecting = null;
    this.unlockState = 'unavailable';
    this.unlockReason = null;
    this._resetUnlock();
  }

  /** The live KwpSession, or null unless state is 'connected'. */
  get session() {
    return this.state === 'connected' ? this._session : null;
  }

  /** Names of the runs currently registered. */
  get runs() {
    return [...this._runs.keys()];
  }

  config() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Merge `patch` into config.json; returns the merged config. */
  saveConfig(patch) {
    const merged = { ...this.config(), ...patch };
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  /** Sensor data block id: bike default, then config.json (saved by probe), then `flag`. */
  dataBlockId(flag) {
    return resolveDataBlockId(this.bike, { saved: this.config().localId, flag });
  }

  info() {
    return {
      state: this.state,
      error: this.error,
      port: this.port,
      kind: this.kind,
      style: this.style,
      target: this.target,
      source: this.source,
      addrMode: this.addrMode,
      keyBytes: this.keyBytes,
      diagSession: this.diagSession,
      unlock: this.unlockState,
      unlockReason: this.unlockReason,
    };
  }

  /** The session if connected; otherwise throws saying why not. */
  requireSession() {
    if (this.state === 'connected') return this._session;
    throw new Error(this.state === 'lost' ? `connection lost: ${this.error}` : 'not connected');
  }

  /**
   * Register a run (probe, live read, gauge loop...) that must stop when the
   * session ends. Returns { name, signal, cancel(), end() }: `signal` aborts on
   * disconnect, on 'lost' or on cancel(); call end() when the run finishes by
   * itself. Starting a run under a name already in use cancels the old one.
   */
  startRun(name) {
    this.requireSession();
    this._runs.get(name)?.cancel();
    const ac = new AbortController();
    const run = {
      name,
      signal: ac.signal,
      cancel: () => {
        run.end();
        ac.abort();
      },
      end: () => {
        if (this._runs.get(name) === run) this._runs.delete(name);
      },
    };
    this._runs.set(name, run);
    return run;
  }

  /**
   * Open the port, wake the ECU (saved wake-up first, then the bike's order),
   * make the session ready and start the keep-alive. Options: port (default:
   * saved), kind/target/source/addrMode (override the saved wake-up; a target
   * without a kind means fast init), targets, initMode, debug. Resolves with
   * info(); rejects with state 'disconnected' and `error` set.
   */
  async connect(opts = {}) {
    if (this._connecting) throw new Error('already connecting');
    const attempt = this._connect(opts);
    this._connecting = attempt.catch(() => {});
    try {
      return await attempt;
    } finally {
      this._connecting = null;
    }
  }

  async _connect(opts) {
    await this._teardown();
    this._setState('connecting', null);
    let transport = null;
    try {
      const cfg = this.config();
      const port = opts.port ?? cfg.port;
      if (!port) throw new Error('No COM port set. Run: node cli.js ports   then: node cli.js scan --port COM3');
      this._emit({ step: 'opening', port });
      transport = await this.openTransport(port);

      const kind = opts.kind ?? (opts.target != null ? 'fast' : cfg.kind ?? 'fast');
      const saved = (cfg.kind ?? 'fast') === kind ? cfg : {}; // a saved slow wake-up has no fast source/addrMode
      const target = opts.target ?? saved.target;
      const prefer = target == null ? undefined
        : kind === 'slow' ? { kind, address: target }
        : { kind, target, source: opts.source ?? saved.source, addrMode: opts.addrMode ?? saved.addrMode ?? 'phys' };
      const r = await wakeEcu(transport, {
        bike: this.bike,
        prefer,
        targets: opts.targets,
        initMode: opts.initMode,
        debug: opts.debug ?? this.debug,
        clock: this.clock,
        p3: this.p3,
        onProgress: (e) => this._emit(e),
      });

      let diag = false;
      if (r.style === 'iso9141') {
        this._emit({ step: 'first-request' });
        try {
          await r.session.request(r.session.ping.data, { timeout: r.session.ping.timeout });
        } catch (e) {
          throw new Error(`ECU completed the handshake but did not answer the first request [${hex(r.session.ping.data)}]: ${e.message}`);
        }
      } else {
        if (this.bike.diagSession != null) {
          try {
            await r.session.startDiagSession(this.bike.diagSession);
            diag = true;
          } catch {
            // plain session is fine for reads
          }
        }
        this._emit({ step: 'diag-session', accepted: diag });
      }

      this.saveConfig({ port, kind: r.kind, target: r.target, source: r.source, addrMode: r.addrMode });
      Object.assign(this, {
        transport, port, kind: r.kind, style: r.style, target: r.target, source: r.source, addrMode: r.addrMode,
        keyBytes: r.keyBytes, diagSession: diag, _session: r.session,
      });
      this._startKeepAlive(r.session);
      this._setState('connected', null);
      this._emit({ step: 'connected', ...this.info(), saved: r.saved });
      await this._autoUnlock(r.session);
      return this.info();
    } catch (e) {
      await this._closeTransport(transport);
      this._clearSessionFields();
      this._setState('disconnected', e.message);
      throw e;
    }
  }

  /** End the session: cancel runs, StopCommunication, close the port. Safe to call in any state. */
  async disconnect() {
    if (this._connecting) await this._connecting;
    const was = this.state;
    await this._teardown();
    if (was !== 'disconnected') this._setState('disconnected', null);
  }

  async _teardown() {
    this._stopKeepAlive();
    this._cancelRuns();
    const { _session: session, transport, state } = this;
    this._clearSessionFields();
    if (session && state === 'connected') await session.stop();
    await this._closeTransport(transport);
  }

  async _closeTransport(transport) {
    if (!transport) return;
    try {
      await transport.close();
    } catch {
      // closing a dead port is not worth reporting
    }
  }

  _clearSessionFields() {
    Object.assign(this, {
      transport: null, port: null, kind: null, style: null, target: null, source: null, addrMode: null,
      keyBytes: null, diagSession: false, _session: null,
    });
    this._resetUnlock();
  }

  _unlockFile() {
    return this.unlockPath ?? path.join(path.dirname(this.configPath), 'unlock.json');
  }

  _setUnlock(state, reason = null) {
    if (state === this.unlockState && reason === this.unlockReason) return;
    this.unlockState = state;
    this.unlockReason = reason;
    this.emit('unlock', { state, reason });
  }

  /** Read the unlock file and set the state it implies ('locked', 'invalid' or 'unavailable'). */
  _resetUnlock() {
    const r = loadMultiplier(this._unlockFile());
    if (r.multiplier !== undefined) this._setUnlock('locked');
    else if (r.invalid !== undefined) this._setUnlock('invalid', r.invalid);
    else this._setUnlock('unavailable', r.unavailable);
  }

  /** After 'connected': one attempt if there is something to try. Never throws. */
  async _autoUnlock(session) {
    if (session.style !== 'iso9141') {
      this._setUnlock('unavailable', `unlock is only for ISO 9141 sessions (this one is ${session.style})`);
      return;
    }
    if (this.unlockState === 'locked' && this.autoUnlock) await this._attemptUnlock(session);
  }

  /** One attempt: re-reads the file, ends 'unlocked' or 'failed'; never throws. */
  async _attemptUnlock(session) {
    const { multiplier, invalid, unavailable } = loadMultiplier(this._unlockFile());
    if (multiplier === undefined) {
      this._setUnlock(invalid !== undefined ? 'invalid' : 'unavailable', invalid ?? unavailable);
      return;
    }
    // Requests already queued go first; anything new waits until the key is answered.
    const hold = session.hold();
    this._setUnlock('unlocking');
    let outcome;
    try {
      await unlockSession({ style: session.style, request: hold.request }, multiplier);
      outcome = ['unlocked'];
    } catch (e) {
      outcome = ['failed', e.message];
    } finally {
      hold.release();
    }
    if (this._session === session && this.state === 'connected') this._setUnlock(...outcome);
  }

  /**
   * Try the unlock now (the user asked): one seed request and at most one key.
   * Allowed while connected from 'locked' or 'failed', after re-reading the
   * unlock file; throws if not connected or the state is 'unavailable',
   * 'invalid', 'unlocking' or 'unlocked'. Resolves { state, reason }: 'unlocked'
   * or 'failed' (a failed attempt is a result, not an exception).
   */
  async unlock() {
    const session = this.requireSession();
    const { unlockState: state, unlockReason: reason } = this;
    if (state === 'unlocking') throw new Error('unlock already in progress');
    if (state === 'unlocked') throw new Error('already unlocked');
    if (state === 'unavailable' || state === 'invalid') throw new Error(`unlock is ${state}: ${reason}`);
    await this._attemptUnlock(session);
    if (this.unlockState === 'unavailable' || this.unlockState === 'invalid') throw new Error(`unlock is ${this.unlockState}: ${this.unlockReason}`);
    return { state: this.unlockState, reason: this.unlockReason };
  }

  _cancelRuns() {
    for (const run of [...this._runs.values()]) run.cancel();
  }

  _startKeepAlive(session) {
    let ticking = false;
    const { data, timeout, intervalMs } = session.ping;
    this._keepAlive = setInterval(async () => {
      if (ticking || this._session !== session || this.state !== 'connected') return;
      ticking = true;
      try {
        if (session.linkFailures < this.keepAliveLimit && !session.busy) {
          try {
            await session.request(data, { timeout, retries: 0 });
          } catch {
            // counted in session.linkFailures
          }
        }
        if (this._session === session && this.state === 'connected' && session.linkFailures >= this.keepAliveLimit) {
          this._lose(session);
        }
      } finally {
        ticking = false;
      }
    }, this.keepAliveMs ?? intervalMs);
    this._keepAlive.unref?.();
  }

  _stopKeepAlive() {
    clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  _lose(session) {
    this._stopKeepAlive();
    this._cancelRuns();
    const why = session.lastLinkFailure?.message ?? 'no reply';
    this._resetUnlock();
    this._setState('lost', `ECU stopped answering (${session.linkFailures} failed requests in a row; last: ${why})`);
  }

  _setState(state, error) {
    this.state = state;
    this.error = error;
    this.emit('state', { state, error, unlock: this.unlockState, unlockReason: this.unlockReason });
  }

  _emit(event) {
    this.progress = event;
    this.emit('progress', event);
  }
}

module.exports = { Connection };
