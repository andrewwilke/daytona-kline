'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { hex } = require('./kwp');
const svc = require('./services');

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');

// Points kept per channel for the graphs (the newest ones; the recorder's CSV keeps everything).
const HISTORY_POINTS = 2000;

/**
 * A live run: something polled over the connection's session at a pace, with
 * what it saw kept for whoever renders it (the CLI, the GUI server).
 *
 *   const run = gaugeRun(conn, { log: true });  // or blockRun, switchRun, probeRun
 *   run.on('sample', (sample) => draw(sample));
 *   await run.start();                                     // resolves when the run ends
 *   run.stop();                                            // or disconnect / a lost ECU stops it
 *
 * A run registers with the connection when it is created, so disconnect and a
 * lost ECU cancel it; after that no sample is recorded, even one whose read
 * was already in flight. Read errors are counted (`errors`, `lastError`, a
 * 'fault' event) and the run carries on: whether the link is dead is the
 * connection's call, not the run's.
 *
 * What a caller reads: `latest` (the last sample), `min` / `max` (per channel,
 * since the start or `resetRange()`), `changed()`, `cycles`, `samples`,
 * `errors`, `lastError`, `csvPath`, `status()`, and `sampler` for what is
 * specific to the kind of run (see each factory). `outcome` is null while the
 * run is active, then 'finished' (ran to its end) or 'cancelled'. Events:
 * 'sample', 'fault' and 'end' (outcome).
 *
 * A run can also be driven one cycle at a time with `step()` instead of
 * `start()`, for a front-end that polls on its own timer; it is still
 * cancelled with the session.
 *
 * Sampler contract (the kinds of run below implement it):
 *   name, interval            default run name and pause between cycles (ms)
 *   sample(session, ctx)      one cycle -> { channels, ... }; `channels` maps
 *                             a key (byte offset, gauge key, data id) to a
 *                             number and drives min/max. ctx is
 *                             { signal, cycle, error(e) }: `error` records a
 *                             failure the cycle survives.
 *   needsUnlock               optional: true for a run whose reads an ISO 9141
 *                             ECU refuses until it is unlocked; creating it
 *                             while the connection is not unlocked throws a
 *                             NeedsUnlockError (see services.js) and registers
 *                             nothing
 *   finished                  optional: true once there is nothing left to do
 *   csvRow(sample)            optional: { names, values, raw } for the one CSV
 *                             format: `time,<names>,raw`, one row per sample
 */
class LiveRun extends EventEmitter {
  /** Options: name, interval (ms), log (record to logs/run-<time>.csv), logPath (record to this file, appended), logDir. */
  constructor(conn, sampler, { name, interval, log = false, logPath, logDir = DEFAULT_LOG_DIR } = {}) {
    super();
    const wantsLog = log || logPath != null;
    if (wantsLog && !sampler.csvRow) throw new Error('this kind of run has no CSV format');
    if (sampler.needsUnlock) svc.requireUnlock(conn);
    this.conn = conn;
    this.sampler = sampler;
    this.name = name ?? sampler.name;
    this.interval = interval ?? sampler.interval ?? 0;
    this.cycles = 0;
    this.samples = 0;
    this.errors = 0;
    this.lastError = null;
    this.latest = null;
    this.outcome = null;
    this.startedAt = conn.clock.now();
    this.csvPath = null;
    this.resetRange();
    this.history = {}; // key -> [[t_ms, value], ...] newest last, for the graphs
    this._fd = null;
    this._wroteHeader = false;
    this._loop = null;
    this.done = new Promise((resolve) => { this._resolveDone = resolve; });

    this._registration = conn.startRun(this.name);
    this.signal = this._registration.signal;
    this._aborted = new Promise((resolve) => this.signal.addEventListener('abort', resolve, { once: true }));
    this.signal.addEventListener('abort', () => this._end('cancelled'), { once: true });
    if (wantsLog) {
      try {
        this._openLog(logPath ?? path.join(logDir, `run-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}.csv`));
      } catch (e) {
        this._registration.cancel();
        throw e;
      }
    }
  }

  get running() {
    return this.outcome === null;
  }

  /** Poll until the run finishes, is stopped, or the session ends. Resolves with `outcome`. */
  start() {
    if (this._loop) throw new Error('run already started');
    this._loop = this._poll();
    return this.done;
  }

  stop() {
    this._registration.cancel();
  }

  /** Run one cycle now and return its sample. Throws what the cycle threw (also counted). */
  async step() {
    if (this._loop && this.running) throw new Error('run is polling by itself');
    const sample = await this._cycle();
    if (!sample) throw new Error(`${this.name} run stopped`);
    return sample;
  }

  /** Forget min/max so far (the next sample becomes the baseline). */
  resetRange() {
    this.min = {};
    this.max = {};
  }

  /**
   * The graph points of every channel newer than `since` (ms since the run started): { key: [[t_ms, value], ...] }.
   * A page asks again with the newest t it has, so each poll carries only what is new.
   */
  series(since = -1) {
    const out = {};
    for (const [k, pts] of Object.entries(this.history)) {
      let i = pts.length;
      while (i > 0 && pts[i - 1][0] > since) i--;
      if (i < pts.length) out[k] = pts.slice(i);
    }
    return out;
  }

  /** Keys of the channels whose value has varied since the baseline. */
  changed() {
    return Object.keys(this.min).filter((k) => this.min[k] !== this.max[k]);
  }

  status() {
    const { name, running, outcome, cycles, samples, errors, lastError, csvPath, startedAt } = this;
    return { name, running, outcome, cycles, samples, errors, lastError, csvPath, startedAt };
  }

  async _poll() {
    try {
      while (this.running && !this.sampler.finished) {
        try {
          await this._cycle();
        } catch {
          // counted by _cycle; the next cycle tries again
        }
        if (this.running && !this.sampler.finished) await this._pause();
      }
    } finally {
      this._end('finished');
      this._resolveDone(this.outcome);
    }
  }

  async _pause() {
    if (this.interval <= 0) {
      await new Promise((r) => setImmediate(r));
      return;
    }
    await Promise.race([this.conn.clock.sleep(this.interval), this._aborted]);
  }

  /** One sample, recorded; null if the run ended while it was being read. */
  async _cycle() {
    if (!this.running) throw new Error(`${this.name} run stopped`);
    let sample;
    try {
      sample = await this.sampler.sample(this.conn.requireSession(), {
        signal: this.signal,
        cycle: this.cycles,
        error: (e) => this._fail(e),
      });
    } catch (e) {
      if (!this.running) return null;
      this.cycles++;
      this._fail(e);
      throw e;
    }
    if (!this.running) return null;
    this.cycles++;
    this.samples++;
    this.latest = sample;
    this._track(sample.channels);
    this._record(sample);
    this.emit('sample', sample);
    return sample;
  }

  _fail(e) {
    this.errors++;
    this.lastError = e.message;
    this.emit('fault', e);
  }

  _track(channels, t = this.conn.clock.now() - this.startedAt) {
    for (const k of Object.keys(channels)) {
      const v = channels[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const pts = (this.history[k] ??= []);
        pts.push([t, v]);
        if (pts.length > HISTORY_POINTS) pts.splice(0, pts.length - HISTORY_POINTS);
      }
      this.min[k] = Math.min(this.min[k] ?? v, v);
      this.max[k] = Math.max(this.max[k] ?? v, v);
    }
  }

  _openLog(file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this._fd = fs.openSync(file, 'a');
    this.csvPath = file;
  }

  _record(sample) {
    if (this._fd === null) return;
    const row = this.sampler.csvRow(sample);
    let text = '';
    if (!this._wroteHeader) {
      text += `time,${row.names.join(',')},raw\n`;
      this._wroteHeader = true;
    }
    text += `${new Date(this.conn.clock.now()).toISOString()},${row.values.join(',')},${row.raw}\n`;
    try {
      fs.writeSync(this._fd, text);
    } catch (e) {
      this._fail(new Error(`log write failed: ${e.message}`));
      this._closeLog();
    }
  }

  _closeLog() {
    if (this._fd === null) return;
    try {
      fs.closeSync(this._fd);
    } catch {
      // nothing more to do for a log that will not close
    }
    this._fd = null;
  }

  _end(outcome) {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this._closeLog();
    this._registration.end();
    if (!this._loop) this._resolveDone(outcome);
    this.emit('end', outcome);
  }
}

/**
 * Read one sensor data block (readDataByLocalIdentifier) and decode it with
 * the bike's field map. Sample: { channels: [byte...], data, fields }, with
 * one channel per byte offset; CSV rows are the decoded values plus raw hex.
 * Options: id (default: the connection's data block id), map, interval (150),
 * timeout, name ('live'), plus the LiveRun log options. `sampler.id` is the block.
 * Needs the ECU unlock on an ISO 9141 connection.
 */
function blockRun(conn, { id = conn.dataBlockId(), map = conn.bike.sensorBlock, interval = 150, timeout = 1000, name = 'live', ...opts } = {}) {
  const sampler = {
    name,
    interval,
    id,
    needsUnlock: true,
    async sample(session) {
      const data = await svc.readLocalId(session, id, { timeout });
      return { channels: [...data], data, fields: svc.decodeBlock(data, map) };
    },
    csvRow: ({ data, fields }) => ({ names: fields.map((f) => f.name), values: fields.map((f) => f.value), raw: hex(data) }),
  };
  return new LiveRun(conn, sampler, opts);
}

// A gauge whose PID the ECU listed but never answered, this many cycles in a
// row, is treated as not served.
const GAUGE_STRIKES = 3;

/**
 * Poll the dashboard gauges (mode 01 PIDs): the `fast` ones every cycle plus
 * one of the others per cycle, in turn. The first cycle reads the ECU's list of
 * supported PIDs (`sampler.supported`, a Set): a gauge whose PID is not on it
 * is marked unsupported without being asked, and one that is on it but gets no
 * answer GAUGE_STRIKES cycles in a row, without ever having answered, is marked
 * too (a gauge that did answer once is never dropped: a silent ECU is the
 * connection's business, and the page shows that gauge's last value as stale). A gauge marked
 * unsupported (`sampler.unsupported`, gauge keys) is not polled again for the
 * rest of the run, and it is never an error; a failed read is counted and the
 * cycle goes on. `sampler.values` holds the newest { value, raw, text?, at } per
 * gauge key (`at` is the cycle it was read in); channels are keyed by gauge key
 * (for a text gauge the channel is its number, `text` the words). The CSV has
 * one column per gauge (the latest value, blank until read) and the PIDs (or, for
 * an id gauge, `22:<id>`) read in that cycle as raw. Gauges that `requiresUnlock`
 * (0x22 reads) are polled only while the connection is unlocked, judged by its
 * unlock state each cycle (`svc.lockedGauges`): until then they are simply not
 * asked, and a refusal of one marks it unsupported at once. Options: defs
 * (default: the bike's gauges), interval (0: back to back), plus the LiveRun
 * log options.
 */
// Read-only extras the dashboard graphs besides the gauges, once the ECU is unlocked: the injection
// pulse (what the fuel graph and map are about, read every cycle with engine speed and throttle) and
// the flags that show a cut-out (one of them per cycle, taking turns). Keys of the bike description.
const GRAPH_EXTRAS = ['injPulse1', 'fuelPump', 'tipOver'];
const EXTRAS_EVERY_CYCLE = ['injPulse1'];

// While the engine runs, the background reads (the switch watcher) wait this long for the line, so the
// gauges refresh quickly; otherwise they get it after the default wait.
const RUNNING_RPM = 400;
const BACKGROUND_AGE_RUNNING_MS = 800;

function gaugeRun(conn, { defs = conn.bike.gauges, interval = 0, extras = GRAPH_EXTRAS, ...opts } = {}) {
  const extraDefs = extras
    .map((k) => [...conn.bike.analogs, ...conn.bike.switches].find((d) => d.key === k))
    .filter(Boolean);
  const fast = defs.filter((d) => d.fast);
  const slow = defs.filter((d) => !d.fast);
  const strikes = {};
  let turn = 0;
  let extraTurn = 0;
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const sampler = {
    name: 'gauges',
    interval,
    defs,
    values: {},
    unsupported: [],
    supported: null,
    markUnsupported(key) {
      if (!sampler.unsupported.includes(key)) sampler.unsupported.push(key);
    },
    async sample(session, ctx) {
      if (!sampler.supported) {
        sampler.supported = await svc.supportedPids(session);
        for (const d of defs) if (d.pid != null && !sampler.supported.has(d.pid)) sampler.markUnsupported(d.key);
      }
      const locked = svc.lockedGauges(conn, defs);
      const served = (d) => !sampler.unsupported.includes(d.key) && !locked.includes(d.key);
      const batch = fast.filter(served);
      const others = slow.filter(served);
      if (others.length) batch.push(others[turn++ % others.length]);
      const channels = {};
      const reads = [];
      for (const def of batch) {
        if (ctx.signal.aborted) break;
        try {
          const r = await svc.readGauge(session, def);
          if (r) {
            strikes[def.key] = 0;
            sampler.values[def.key] = { ...r, at: ctx.cycle };
            channels[def.key] = r.value;
            reads.push(`${def.pid != null ? hex2(def.pid) : `22:${def.id.toString(16).padStart(4, '0')}`}=${hex(r.raw)}`);
          } else if (def.pid == null) {
            sampler.markUnsupported(def.key); // a refusal is an answer
          } else if (!sampler.values[def.key] && (strikes[def.key] = (strikes[def.key] ?? 0) + 1) >= GAUGE_STRIKES) {
            sampler.markUnsupported(def.key);
          }
        } catch (e) {
          ctx.error(e);
        }
      }
      if (svc.needsUnlock(conn) === null) {
        const turns = extraDefs.filter((d) => !EXTRAS_EVERY_CYCLE.includes(d.key));
        const now = extraDefs.filter((d) => EXTRAS_EVERY_CYCLE.includes(d.key));
        if (turns.length) now.push(turns[extraTurn++ % turns.length]);
        for (const def of now) {
          if (ctx.signal.aborted) break;
          try {
            const bytes = await svc.readIdBytes(session, def.id, { retries: 1 });
            if (bytes && bytes.length) {
              const value = conn.bike.switches.includes(def) ? svc.decodeSwitch(def, bytes).active : svc.decodeGauge(def, bytes).value;
              if (value !== null && value !== undefined) channels[def.key] = Number(value);
            }
          } catch (e) {
            ctx.error(e);
          }
        }
      }
      session.backgroundAgeMs = sampler.values.rpm?.value > RUNNING_RPM ? BACKGROUND_AGE_RUNNING_MS : 300;
      return { channels, reads };
    },
    csvRow: ({ reads }) => ({
      names: defs.map((d) => d.key),
      values: defs.map((d) => sampler.values[d.key]?.value ?? ''),
      raw: reads.join('|'),
    }),
  };
  return new LiveRun(conn, sampler, opts);
}

// An id the ECU never answered in this many full scans is not served: stop asking it.
const NEVER_ANSWERED_SCANS = 6;

/**
 * Poll the switch / relay data ids (readDataByCommonIdentifier, 0x22). On a bike
 * whose description says `switchesRequireUnlock` (the 2012 Daytona) this needs
 * the ECU unlock on an ISO 9141 connection. An id that has answered once keeps
 * its row for the rest of the run (`stale: true` and its last value while the ECU
 * is silent on it); an id that never answered in the first NEVER_ANSWERED_SCANS
 * scans is dropped. Sample: { rows: [{ id, value, hex, stale? }],
 * channels } channels keyed by id; `changed()`
 * lists the ones that moved. Options: ids (default: the bike's switchIds), analogs
 * (bike `analogs` entries to read as well, default none: each is read once per cycle,
 * and one the ECU does not answer is dropped; `sampler.analogs` holds the newest
 * { value, raw, hex } per analog key and `sampler.analogsUnavailable` the dropped keys; they
 * are not channels, so `changed()` is about the switches only), interval (0).
 */
function switchRun(conn, { ids = conn.bike.switchIds, analogs = [], interval = 0, ...opts } = {}) {
  let live = [...ids];
  let liveAnalogs = [...analogs];
  const lastGood = new Map(); // id -> the newest row that answered
  let scans = 0;
  const sampler = {
    name: 'switches',
    interval,
    needsUnlock: conn.bike.switchesRequireUnlock,
    analogs: {},
    analogsUnavailable: [],
    get ids() {
      return live;
    },
    async sample(session) {
      // The ECU now and then does not answer a request. An id that has answered once keeps its
      // row for the rest of the run (the last value, marked stale while it is silent); only an id
      // that never answered in the first NEVER_ANSWERED_SCANS scans is dropped.
      const fresh = await svc.readSwitches(session, live, { background: true });
      scans++;
      const rows = [];
      for (const r of fresh) {
        if (r.value !== null) {
          lastGood.set(r.id, r);
          rows.push(r);
        } else if (lastGood.has(r.id)) {
          rows.push({ ...lastGood.get(r.id), stale: true });
        }
      }
      if (scans >= NEVER_ANSWERED_SCANS) live = live.filter((id) => lastGood.has(id));
      for (const def of [...liveAnalogs]) {
        const r = await svc.readAnalog(session, def, { background: true });
        if (r) {
          sampler.analogs[def.key] = r;
        } else if (!sampler.analogs[def.key] && scans >= NEVER_ANSWERED_SCANS) {
          liveAnalogs = liveAnalogs.filter((d) => d !== def);
          sampler.analogsUnavailable.push(def.key);
        }
      }
      return { rows, channels: Object.fromEntries(rows.map((r) => [r.id, r.value])) };
    },
  };
  return new LiveRun(conn, sampler, opts);
}

// An ISO 9141 (OBD-II) ECU that serves none of the first few block ids is not
// going to serve the rest either: stop instead of asking 255 times.
const PROBE_GIVE_UP = 8;

/**
 * Find which data blocks the ECU serves, one id per cycle (read-only). The run
 * finishes by itself after `to`; if it found any block the biggest is saved as
 * the connection's sensor block id. `sampler.current`, `sampler.found`
 * ([{ id, length, hex }]) and `sampler.biggest` report progress and the result.
 * Needs the ECU unlock on an ISO 9141 connection. On an ISO 9141 session, when
 * none of the first PROBE_GIVE_UP ids is served the run ends early with
 * `sampler.blocked` set to why (an explanation for the user, not an error).
 * Options: from (1), to (0xff).
 */
function probeRun(conn, { from = 0x01, to = 0xff, ...opts } = {}) {
  let next = from;
  let tried = 0;
  const sampler = {
    name: 'probe',
    interval: 0,
    needsUnlock: true,
    current: from,
    found: [],
    blocked: null,
    get finished() {
      return next > to || this.blocked !== null;
    },
    get biggest() {
      return this.found.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
    },
    async sample(session) {
      const id = next++;
      sampler.current = id;
      const { hit, why } = await svc.probeLocalId(session, id);
      tried++;
      if (hit) sampler.found.push(hit);
      if (session.style === 'iso9141' && !sampler.found.length && tried >= PROBE_GIVE_UP && why !== 'failed') {
        sampler.blocked = `not available: the ECU served none of the first ${PROBE_GIVE_UP} block ids, even unlocked`;
      }
      return { channels: {}, id, hit: hit ?? null };
    },
  };
  const run = new LiveRun(conn, sampler, opts);
  run.on('end', (outcome) => {
    if (outcome === 'finished' && sampler.biggest) conn.saveConfig({ localId: sampler.biggest.id });
  });
  return run;
}

module.exports = { LiveRun, blockRun, gaugeRun, switchRun, probeRun };
