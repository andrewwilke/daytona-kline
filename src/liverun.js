'use strict';

const { EventEmitter } = require('events');
const { hex } = require('./kwp');
const { hexNum } = require('./format');
const svc = require('./services');
const { pollset, GAUGE_STRIKES, SWITCH_STRIKES } = require('./pollset');
const { openLogSink, logStamp, DEFAULT_LOG_DIR } = require('./logsink');

// Points kept per channel for the graphs (the newest ones; the recorder's CSV keeps everything).
const HISTORY_POINTS = 2000;

// A run whose first reads all fail this many times in a row has a request the ECU does not serve (see `failingFromStart`).
const FIRST_READS_FAIL = 3;

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
 * Sample time. A sample's time is when its cycle STARTED, in ms since the run
 * started (`startedAt`), read once by the run before it calls the sampler and
 * handed out as `ctx.t`; the run stamps it on the sample as `sample.t_ms`.
 * Everything that carries a time for a sample uses that one value: the graph
 * history (`history`, `series()`), the run CSV's `time` column (startedAt +
 * t_ms) and the recorder's `t_ms` column. So a live graph and the replay of
 * the same recording put a sample at the same moment. (A cycle takes time, so
 * the values in a sample were read after its time; the recorder's `cycle_ms`
 * says how long.) A sampler never reads the clock for a sample time itself.
 *
 * Log. With `log` / `logPath` a run writes its CSV through one LogSink
 * (src/logsink.js): the run owns opening it, its failure (a 'fault' event) and
 * closing it when the run ends. A subclass that writes its own rows (the
 * recorder) passes `logSpec` and writes through `this._sink`.
 *
 * Sampler contract (the kinds of run below implement it):
 *   name, interval            default run name and pause between cycles (ms)
 *   sample(session, ctx)      one cycle -> { channels, ... }; `channels` maps
 *                             a key (byte offset, gauge key, data id) to a
 *                             number and drives min/max. ctx is
 *                             { signal, cycle, t, error(e) }: `t` is the sample
 *                             time above; `error` records a failure the cycle
 *                             survives.
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
  /**
   * Options: name, interval (ms), log (record to logs/run-<time>.csv, a numbered name if it exists), logPath
   * (record to this file, appended), logDir, and for a subclass that writes its own rows `logSpec`
   * { prefix, header, maxBytes }: a new `<logDir>/<prefix>-<time>.csv` with that header line and size limit.
   */
  constructor(conn, sampler, { name, interval, log = false, logPath, logDir = DEFAULT_LOG_DIR, logSpec = null } = {}) {
    super();
    const wantsLog = log || logPath != null;
    if (wantsLog && !logSpec && !sampler.csvRow) throw new Error('this kind of run has no CSV format');
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
    this.endedAt = null;
    this.csvPath = null;
    this.resetRange();
    this.history = {}; // key -> [[t_ms, value], ...] newest last, for the graphs (t_ms: the sample time, see above)
    this._sink = null;
    this._loop = null;
    this.done = new Promise((resolve) => { this._resolveDone = resolve; });

    this._registration = conn.startRun(this.name);
    this.signal = this._registration.signal;
    this._aborted = new Promise((resolve) => this.signal.addEventListener('abort', resolve, { once: true }));
    this.signal.addEventListener('abort', () => this._end('cancelled'), { once: true });
    if (wantsLog || logSpec) {
      try {
        const where = logSpec ? { dir: logDir, prefix: logSpec.prefix, stamp: logStamp(this.startedAt) }
          : logPath != null ? { file: logPath }
            : { dir: logDir, prefix: 'run', stamp: logStamp(this.startedAt) };
        this._sink = openLogSink({ ...where, maxBytes: logSpec?.maxBytes, onError: (e) => this._fail(e) });
        this.csvPath = this._sink.path;
        if (logSpec?.header !== undefined) this._sink.header(logSpec.header);
      } catch (e) {
        this._registration.cancel();
        throw e;
      }
    }
  }

  get running() {
    return this.outcome === null;
  }

  /**
   * True once the run's first FIRST_READS_FAIL reads all failed and none succeeded: the request itself is
   * refused (or not served), not a flaky link. A front-end that wants to give up in that case (the CLI's
   * `follow`, the sensor block feature of src/runs.js) stops the run on its 'fault' event when this is true
   * and says `lastError`; the rule lives here once so they cannot drift apart.
   */
  get failingFromStart() {
    return !this.samples && this.errors >= FIRST_READS_FAIL;
  }

  /** ms since the run started (frozen when it ends). */
  get elapsedMs() {
    return (this.endedAt ?? this.conn.clock.now()) - this.startedAt;
  }

  /** Bytes written to the CSV so far (0 without one). */
  get csvBytes() {
    return this._sink?.bytes ?? 0;
  }

  /** True while the CSV file is open (it is closed as soon as the run has ended). */
  get csvOpen() {
    return this._sink?.isOpen ?? false;
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
    const t = this.conn.clock.now() - this.startedAt; // the sample time: when this cycle starts
    try {
      sample = await this.sampler.sample(this.conn.requireSession(), {
        signal: this.signal,
        cycle: this.cycles,
        t,
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
    sample.t_ms = t;
    this.latest = sample;
    this._track(sample.channels, t);
    this._record(sample);
    this.emit('sample', sample);
    return sample;
  }

  _fail(e) {
    this.errors++;
    this.lastError = e.message;
    this.emit('fault', e);
  }

  /** Keep the channels of the sample at time `t` (its t_ms) for the graphs and min/max. */
  _track(channels, t) {
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

  /** The run CSV: `time,<names>,raw`, one row per sample, `time` being the sample time (ISO). A run whose subclass writes its own rows (no csvRow) records nothing here. */
  _record(sample) {
    if (!this._sink || !this.sampler.csvRow) return;
    const row = this.sampler.csvRow(sample);
    if (!this._sink.headerWritten) this._sink.header(`time,${row.names.join(',')},raw`);
    this._sink.row(`${new Date(this.startedAt + sample.t_ms).toISOString()},${row.values.join(',')},${row.raw}`);
  }

  /** What happens to the log when the run ends: it is closed. A subclass that still has to write its last rows overrides this and closes the sink itself. */
  _endLog() {
    this._sink?.close();
  }

  _end(outcome) {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.endedAt = this.conn.clock.now();
    this._endLog();
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
 * log options. The strike policy and the rotation belong to the polled-item set
 * (src/pollset.js); this only reads and reports.
 */
// Read-only extras the dashboard graphs besides the gauges, once the ECU is unlocked: the injection
// pulse (what the fuel graph and map are about, read every cycle with engine speed and throttle) and
// the flags that show a cut-out (one of them per cycle, taking turns). Keys of the bike description.
const GRAPH_EXTRAS = ['injPulse1', 'fuelPump', 'tipOver'];
const EXTRAS_EVERY_CYCLE = ['injPulse1'];
// The recorder's EVERY_CYCLE (src/recorder.js) overlaps these three keys on purpose but is not derived from
// them: it answers a different question (what shows a stall, 8 values read every cycle, in that order) and a
// cycle of the dashboard has to stay short enough for the needles, so each list is its own decision.

// While engine speed or throttle is changing (a blip of the throttle, a rev), the dashboard reads only what the
// needles and the fuel map need (engine speed, throttle and the injection pulse) for a few cycles, so they follow
// the movement; once everything has been steady for that long the full rotation of the other values is back.
const MOVING_RPM = 150;
const MOVING_TPS = 1;
const MOVING_CYCLES = 4;
// An extra that is silent is skipped at once, not asked twice (the ECU skips a request now and then; the next cycle asks again).
const EXTRA_TIMEOUT_MS = 350;

function gaugeRun(conn, { defs = conn.bike.gauges, interval = 0, extras = GRAPH_EXTRAS, ...opts } = {}) {
  const extraDefs = extras
    .map((k) => [...conn.bike.analogs, ...conn.bike.switches].find((d) => d.key === k))
    .filter(Boolean);
  const gauges = pollset({
    items: defs.map((def) => ({ key: def.key, pid: def.pid ?? null, gated: !!def.requiresUnlock, def })),
    every: defs.filter((d) => d.fast).map((d) => d.key),
    dropAfter: { every: GAUGE_STRIKES, rotation: GAUGE_STRIKES },
    // Open unless an unlock-only gauge is held back: lockedGauges is the one rule for that (it is strict while there is no session yet).
    gate: () => svc.lockedGauges(conn, defs).length === 0,
    listSupported: svc.supportedPids, // a failure fails the cycle, and the next one asks again
  });
  // The graph extras are best effort: never dropped, never reported on (a silent one is just skipped), so
  // the set only does their gating and rotation. All of them are 0x22 reads, asked while the unlock gate is open.
  const extraSet = pollset({
    items: extraDefs.map((def) => ({ key: def.key, pid: null, gated: true, def })),
    every: extraDefs.filter((d) => EXTRAS_EVERY_CYCLE.includes(d.key)).map((d) => d.key),
    gate: () => svc.needsUnlock(conn) === null,
  });
  let movingLeft = 0; // cycles still in the short, fast form
  const sampler = {
    name: 'gauges',
    interval,
    defs,
    get moving() {
      return movingLeft > 0;
    },
    get values() {
      return gauges.view().values;
    },
    get unsupported() {
      return gauges.view().unsupported;
    },
    get supported() {
      return gauges.view().supported;
    },
    async sample(session, ctx) {
      const plan = await gauges.plan(session, ctx);
      const fastCycle = movingLeft > 0;
      const before = { rpm: gauges.view().values.rpm?.value, tps: gauges.view().values.tps?.value };
      const batch = fastCycle ? [...plan.every] : [...plan.every, ...plan.turns(1)];
      const channels = {};
      const reads = [];
      for (const { def } of batch) {
        if (ctx.signal.aborted) break;
        try {
          const r = await svc.readGauge(session, def);
          if (r) {
            gauges.report(def.key, { ...r, at: ctx.cycle });
            channels[def.key] = r.value;
            reads.push(`${def.pid != null ? hexNum(def.pid) : `22:${hexNum(def.id, 4)}`}=${hex(r.raw)}`);
          } else if (def.pid == null) {
            gauges.refuse(def.key); // a refusal is an answer
          } else {
            gauges.report(def.key, null);
          }
        } catch (e) {
          ctx.error(e);
        }
      }
      const extraPlan = await extraSet.plan(session, ctx);
      for (const { def } of fastCycle ? [...extraPlan.every] : [...extraPlan.every, ...extraPlan.turns(1)]) {
        if (ctx.signal.aborted) break;
        try {
          const bytes = await svc.readIdBytes(session, def.id, { timeout: EXTRA_TIMEOUT_MS });
          if (bytes && bytes.length) {
            const value = conn.bike.switches.includes(def) ? svc.decodeSwitch(def, bytes).active : svc.decodeGauge(def, bytes).value;
            if (value !== null && value !== undefined) channels[def.key] = Number(value);
          }
        } catch (e) {
          ctx.error(e);
        }
      }
      const after = gauges.view().values;
      const moved = (a, b, limit) => a !== undefined && b !== undefined && Math.abs(a - b) >= limit;
      if (moved(before.rpm, after.rpm?.value, MOVING_RPM) || moved(before.tps, after.tps?.value, MOVING_TPS)) movingLeft = MOVING_CYCLES;
      else if (movingLeft > 0) movingLeft--;
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

/**
 * Poll the switch / relay data ids (readDataByCommonIdentifier, 0x22). On a bike
 * whose description says `switchesRequireUnlock` (the 2012 Daytona) this needs
 * the ECU unlock on an ISO 9141 connection. An id that has answered once keeps
 * its row for the rest of the run (`stale: true` and its last value while the ECU
 * is silent on it); an id that never answered in the first SWITCH_STRIKES
 * scans is dropped. Sample: { rows: [{ id, value, hex, stale? }],
 * channels } channels keyed by id; `changed()`
 * lists the ones that moved. Options: ids (default: the bike's switchIds; an id named twice
 * is asked once), analogs
 * (bike `analogs` entries to read as well, default none: each is read once per cycle,
 * and one the ECU does not answer is dropped; `sampler.analogs` holds the newest
 * { value, raw, hex } per analog key and `sampler.analogsUnavailable` the dropped keys; they
 * are not channels, so `changed()` is about the switches only), interval (0).
 */
function switchRun(conn, { ids = conn.bike.switchIds, analogs = [], interval = 0, ...opts } = {}) {
  // Every id and every analog is read in every scan, and the same strike count drops either kind.
  const idKeys = [...new Set(ids)];
  const idSet = pollset({
    items: idKeys.map((id) => ({ key: id, pid: null, gated: false })),
    every: idKeys,
    dropAfter: { every: SWITCH_STRIKES },
  });
  const analogSet = pollset({
    items: analogs.map((def) => ({ key: def.key, pid: null, gated: false, def })),
    every: analogs.map((d) => d.key),
    dropAfter: { every: SWITCH_STRIKES },
  });
  const sampler = {
    name: 'switches',
    interval,
    needsUnlock: conn.bike.switchesRequireUnlock,
    get analogs() {
      return analogSet.view().values;
    },
    get analogsUnavailable() {
      return analogSet.view().unsupported;
    },
    get ids() {
      return idSet.view().served;
    },
    async sample(session, ctx) {
      // The ECU now and then does not answer a request. An id that has answered once keeps its
      // row for the rest of the run (the last value, marked stale while it is silent); only an id
      // that never answered in the first SWITCH_STRIKES scans is dropped.
      const plan = await idSet.plan(session, ctx);
      const fresh = await svc.readSwitches(session, plan.every.map((it) => it.key), { background: true });
      for (const r of fresh) idSet.report(r.id, r.value !== null ? r : null);
      const { stale } = idSet.view();
      const rows = [];
      for (const r of fresh) {
        const row = idSet.value(r.id);
        if (row) rows.push(stale.includes(r.id) ? { ...row, stale: true } : row);
      }
      const analogPlan = await analogSet.plan(session, ctx);
      for (const { def } of analogPlan.every) {
        analogSet.report(def.key, await svc.readAnalog(session, def, { background: true }));
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
