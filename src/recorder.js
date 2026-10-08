'use strict';

const path = require('path');
const { LiveRun } = require('./liverun');
const svc = require('./services');
const { hex } = require('./kwp');
const { pollset, SILENT_STRIKES, ROTATING_STRIKES, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES } = require('./pollset');
const { DEFAULT_LOG_DIR } = require('./logsink');

const DEFAULT_MINUTES = 10;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

// What shows a stall, a cut-out or a crank is read in every cycle (keys of the bike
// description, in this order); everything else takes turns so a cycle stays short.
// The ECU's own engine speed (0x22 id 0x100, `rpmId`) is the rpm source here: the OBD one
// (PID 0C, `rpm`) may not report cranking speed and takes turns in the rotation (the event
// snapshot falls back to it when rpmId is refused). `tipOver` (0x63) is the tip-over (fall
// detection) sensor: a trip can last well under a second, so it is read every cycle (in the
// rotation, one read in ~27 cycles missed brief trips). `warningLamp` (0x44) and `engineLamp`
// (0x61) are the ECU's two flags of whether the dash is powered, so a glitch in the dash feed
// shows up there (0x61 is answered only now and then and stays last).
// (The dashboard's graph extras in src/liverun.js, GRAPH_EXTRAS, share three of these keys but are a smaller,
// separate list on purpose: the dashboard has to stay quick for the needles, the recorder to catch a crank.)
const EVERY_CYCLE = ['battery', 'rpmId', 'startSwitch', 'fuelPump', 'injPulse1', 'tipOver', 'warningLamp', 'engineLamp'];

// How many silent reads in a row give a value up (SILENT_STRIKES for the every-cycle ones,
// ROTATING_STRIKES for the ones that take turns), when an every-cycle value that did answer is
// demoted to the rotation (DEMOTE_STRIKES) and how often a failed supported-PID read is tried
// again (SUPPORTED_RETRY_CYCLES) are the polled-item set's (src/pollset.js, with the reason for
// each number); the wait a rotating read gets for an answer is the recorder's own.
const ROTATING_TIMEOUT_MS = 250;

// When the every-cycle reads of a cycle took longer than max(1200 ms, 300 ms per every-cycle
// value) the rotating read of that cycle is skipped: the ECU is slow or silent on something and
// a cycle has to stay short enough to catch a 2-3 s crank. (300 ms per value, because the 8 values
// at a real read's ~190 ms take 1.5 s when all is well.)
const SLOW_CYCLE_MS = 1200;
const SLOW_CYCLE_MS_PER_VALUE = 300;

const ENGINE_RUNNING_RPM = 400;
const ENGINE_STOPPED_RPM = 100;
const ENGINE_STOP_WINDOW_MS = 2000;
const BATTERY_DIP_V = 9.5;

/**
 * Finds the moments worth a note in a stream of samples. `push(snapshot)` takes
 * { t, rpm, battery, fuelPump, mainRelay, startSwitch, tipOver, warningLamp, engineLamp }
 * (t in ms; the others are the newest value known, null if never read; the flags are
 * true / false) and returns the texts of the events that happened at this sample:
 *   engine stopped                  rpm fell from above 400 to below 100 within 2 s
 *   fuel pump OFF while running     the pump flag turned off while rpm is above 0
 *   fuel pump ON                    the pump flag turned on
 *   main relay OFF                  the relay flag turned off
 *   start switch pressed / released
 *   battery dip <v> V               the voltage went below 9.5 V (once per dip)
 *   tip-over sensor TRIPPED / OK again   the tip-over flag turned off / on (on = good, the bike may start)
 *   dash power flags disagree (0x44 x, 0x61 y)   the two dash flags changed into disagreement
 *                                   (once per disagreement); dash power flags agree again
 * A value seen for the first time is a baseline, not a change.
 */
class EventDetector {
  constructor() {
    this.prev = null;
    this._rpm = []; // { t, rpm } within the stop window
    this._engineSeen = false;
    this._dipping = false;
    this._dashDisagree = null; // null until both dash flags have been seen
  }

  push(s) {
    const out = [];
    const edge = (key) => (this.prev && this.prev[key] != null && s[key] != null && this.prev[key] !== s[key] ? s[key] : null);
    if (s.rpm != null) {
      this._rpm.push({ t: s.t, rpm: s.rpm });
      while (this._rpm.length && s.t - this._rpm[0].t > ENGINE_STOP_WINDOW_MS) this._rpm.shift();
      if (s.rpm > ENGINE_RUNNING_RPM) {
        this._engineSeen = true;
      } else if (s.rpm < ENGINE_STOPPED_RPM && this._engineSeen && this._rpm.some((r) => r.rpm > ENGINE_RUNNING_RPM)) {
        out.push('engine stopped');
        this._engineSeen = false; // armed again by the next time it runs
      }
    }
    const pump = edge('fuelPump');
    if (pump === true) out.push('fuel pump ON');
    if (pump === false && s.rpm > 0) out.push('fuel pump OFF while running');
    if (edge('mainRelay') === false) out.push('main relay OFF');
    const start = edge('startSwitch');
    if (start === true) out.push('start switch pressed');
    if (start === false) out.push('start switch released');
    const tip = edge('tipOver');
    // The flag is on (00 ff) while the sensor is good and lets the bike start; off (00 00) means tripped.
    if (tip === false) out.push('tip-over sensor TRIPPED');
    if (tip === true) out.push('tip-over sensor OK again');
    if (typeof s.warningLamp === 'boolean' && typeof s.engineLamp === 'boolean') {
      const disagree = s.warningLamp !== s.engineLamp;
      if (this._dashDisagree !== null && disagree !== this._dashDisagree) {
        out.push(disagree
          ? `dash power flags disagree (0x44 ${s.warningLamp ? 'on' : 'off'}, 0x61 ${s.engineLamp ? 'on' : 'off'})`
          : 'dash power flags agree again');
      }
      this._dashDisagree = disagree; // the first time both are known is the baseline
    }
    if (s.battery != null) {
      if (s.battery < BATTERY_DIP_V) {
        if (!this._dipping) out.push(`battery dip ${s.battery.toFixed(1)} V`);
        this._dipping = true;
      } else {
        this._dipping = false;
      }
    }
    this.prev = { ...s };
    return out;
  }
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const megabytes = (bytes) => (bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${bytes} bytes`);

/** The reads of the bike description as polled items: { key, kind: 'gauge' | 'switch' | 'analog', def, id, pid, gated }. */
function itemsOf(bike) {
  const items = [
    ...bike.gauges.map((def) => ({ key: def.key, kind: 'gauge', def, id: def.id ?? null, pid: def.pid ?? null, gated: !!def.requiresUnlock })),
    ...bike.switches.map((def) => ({ key: def.key, kind: 'switch', def, id: def.id, pid: null, gated: !!bike.switchesRequireUnlock })),
    ...bike.analogs.map((def) => ({ key: def.key, kind: 'analog', def, id: def.id, pid: null, gated: def.requiresUnlock ?? true })),
  ];
  const keys = new Set();
  for (const it of items) {
    if (keys.has(it.key)) throw new Error(`the bike description uses the key "${it.key}" twice`);
    keys.add(it.key);
  }
  return items;
}

/** One read of an item: { value, bytes, text?, active? } or null when the ECU does not serve it. `timeout`: the silence wait in ms (the session's default for an OBD value, 500 ms for an id). */
async function readItem(session, item, timeout) {
  const { def } = item;
  if (item.kind === 'gauge' && def.pid != null) {
    const r = await svc.readGauge(session, def, { timeout });
    return r && { value: r.value, text: r.text, bytes: r.raw };
  }
  const bytes = await svc.readIdBytes(session, def.id, { timeout, retries: 1 });
  if (!bytes || !bytes.length) return null;
  if (item.kind === 'switch') {
    const { active } = svc.decodeSwitch(def, bytes);
    return { value: Number(active), active, bytes };
  }
  return { value: svc.decodeGauge(def, bytes).value, bytes };
}

/**
 * One recording: the OBD gauges, the unlock-only gauges, the analog extras and the switch
 * states together, one sample per cycle with a timestamp (ms since the start), into one
 * CSV, with the markers you set and the events found along the way.
 *
 *   const rec = recordRun(conn, { minutes: 10 });
 *   rec.on('sample', (s) => ...);     // s: { t_ms, channels, read, marker, events, ... }
 *   rec.on('event', ({ t_ms, text }) => ...);
 *   rec.mark('Cranking');             // lands on the next sample's marker column
 *   await rec.start();                // resolves 'finished' or 'cancelled'
 *
 * It is a LiveRun (see liverun.js): registered with the connection at creation, so a
 * disconnect or a lost ECU cancels it, and read errors are counted and the cycle goes on.
 * The run's sample time (when the cycle started, ms since the start; `ctx.t`) is the `t_ms`
 * of the sample and of its CSV row, and the run's graph history uses the same value. The CSV
 * is a LogSink (src/logsink.js) owned by the run: opened as record-<time>.csv without ever
 * overwriting an earlier one, capped at `maxBytes`, closed when the run ends.
 * The first cycle reads the ECU's list of supported PIDs; a gauge whose PID is not on it is not
 * available without being asked (if that read fails it is tried again every SUPPORTED_RETRY_CYCLES
 * cycles, not every cycle). Every cycle reads the values in EVERY_CYCLE (silence wait 500 ms);
 * the others take turns, `perCycle` of them per cycle (default 1), with a shorter silence wait
 * (ROTATING_TIMEOUT_MS), and their turn is skipped in a cycle whose every-cycle reads were slow.
 * An id read is resent once when the ECU stays silent. A value that never answered is marked not
 * available and not asked again: after SILENT_STRIKES reads in a row for an every-cycle value,
 * ROTATING_STRIKES for the others. One that answered once is never dropped (it keeps its last
 * value while the ECU skips a request), but an every-cycle value silent DEMOTE_STRIKES cycles in
 * a row moves to the rotation until it answers again, so it cannot slow every cycle.
 * Silence is never a link failure. While the connection is not unlocked, the 0x22
 * values (battery, gear, switches, analogs) are skipped (`locked` lists them) and only the OBD values
 * are recorded; unlocking mid-run adds them.
 *
 * The CSV (logs/record-<time>.csv): t_ms, cycle_ms (how long the cycle of that row took, blank on
 * the closing row of a marker or a lost connection), a column per gauge and per analog (the newest value,
 * blank until read or when not available), a column per switch (1 = active, 0 = not, by its
 * decode rule), `<key>_raw` (the data bytes in hex) per 0x22 value, marker, event. The file is
 * closed when the run ends however it ends; a marker set after the last sample, and a lost
 * connection, get a final row.
 *
 * Ends by itself after `minutes` (default 10) or when the file would pass `maxBytes`
 * (default 50 MB): outcome 'finished' with `stopReason` saying which.
 *
 * Reads: `events` ({ t_ms, text }), `markers`, `battery` ({ min, max, last }), `elapsedMs`,
 * `locked`, `notAvailable`, `csvPath`, `stopReason`, `view()` (everything a page shows).
 */
class Recording extends LiveRun {
  constructor(conn, { minutes = DEFAULT_MINUTES, maxBytes = DEFAULT_MAX_BYTES, perCycle = 1, interval = 0, logDir = DEFAULT_LOG_DIR } = {}) {
    if (!(minutes > 0)) throw new Error('minutes must be more than 0');
    const items = itemsOf(conn.bike);
    const byKey = new Map(items.map((it) => [it.key, it]));
    const critical = EVERY_CYCLE.map((k) => byKey.get(k)).filter(Boolean);
    const rotation = [
      ...items.filter((it) => it.kind === 'switch' && !critical.includes(it)),
      ...items.filter((it) => it.kind === 'gauge' && !critical.includes(it)),
      ...items.filter((it) => it.kind === 'analog' && !critical.includes(it)),
    ];
    const columns = [
      ...items.filter((it) => it.kind === 'gauge').map((it) => it.key),
      ...items.filter((it) => it.kind === 'analog').map((it) => it.key),
      ...items.filter((it) => it.kind === 'switch').map((it) => it.key),
    ];
    const rawItems = items.filter((it) => it.id != null);
    const header = ['t_ms', 'cycle_ms', ...columns, ...rawItems.map((it) => `${it.key}_raw`), 'marker', 'event'];

    // The polled-item set owns what is served, the strikes, the demotion, the rotation and the
    // supported-PID bootstrap (src/pollset.js); the recorder reads and reports. A failed bootstrap
    // is an error of the cycle, not the end of it, and is retried only every SUPPORTED_RETRY_CYCLES.
    const set = pollset({
      items,
      every: critical.map((it) => it.key),
      rotation: rotation.map((it) => it.key),
      dropAfter: { every: SILENT_STRIKES, rotation: ROTATING_STRIKES },
      demoteAfter: DEMOTE_STRIKES,
      gate: () => svc.needsUnlock(conn) === null,
      listSupported: svc.supportedPids,
      supportedRetryCycles: SUPPORTED_RETRY_CYCLES,
    });
    const st = {
      cells: null,
      lastCycleMs: 0,
      maxCycleMs: 0,
      skipped: 0, // cycles whose rotating read was skipped
    };
    const cells = () => [
      ...columns.map((k) => {
        const s = set.value(k);
        const v = byKey.get(k).kind === 'switch' ? s?.active : s?.value;
        return typeof v === 'boolean' ? Number(v) : v ?? '';
      }),
      ...rawItems.map((it) => (set.value(it.key) ? hex(set.value(it.key).bytes) : '')),
    ];
    const sampler = {
      name: 'record',
      interval,
      finished: false,
      items,
      async sample(session, ctx) {
        const began = conn.clock.now();
        const t_ms = ctx.t;
        const plan = await set.plan(session, ctx);
        const channels = {};
        const read = [];
        const readOne = async (it, rotating) => {
          try {
            const r = await readItem(session, it, rotating ? ROTATING_TIMEOUT_MS : undefined);
            set.report(it.key, r && { ...r, at: ctx.cycle });
            if (r) {
              channels[it.key] = r.value;
              read.push(it.key);
            }
          } catch (e) {
            ctx.error(e);
          }
        };
        const everyStart = conn.clock.now();
        for (const it of plan.every) {
          if (ctx.signal.aborted) break;
          await readOne(it, false);
        }
        const skip = conn.clock.now() - everyStart > Math.max(SLOW_CYCLE_MS, SLOW_CYCLE_MS_PER_VALUE * plan.every.length);
        if (skip) {
          st.skipped++;
        } else {
          for (const it of plan.turns(perCycle)) {
            if (ctx.signal.aborted) break;
            await readOne(it, true);
          }
        }
        st.cells = cells();
        const v = (k) => set.value(k)?.value ?? null;
        const flag = (k) => set.value(k)?.active ?? null;
        st.lastCycleMs = conn.clock.now() - began;
        st.maxCycleMs = Math.max(st.maxCycleMs, st.lastCycleMs);
        return {
          cycleMs: st.lastCycleMs,
          skipped: skip,
          channels,
          read,
          cells: st.cells,
          snapshot: { t: t_ms, rpm: v('rpmId') ?? v('rpm'), battery: v('battery'), fuelPump: flag('fuelPump'), mainRelay: flag('mainRelay'), startSwitch: flag('startSwitch'), tipOver: flag('tipOver'), warningLamp: flag('warningLamp'), engineLamp: flag('engineLamp') },
        };
      },
    };

    // The run owns the log: it opens record-<time>.csv with the header line, enforces the cap and
    // reports a failed write as a fault. Rows and the closing row are this class's.
    super(conn, sampler, { name: 'record', interval, logDir, logSpec: { prefix: 'record', header: header.map(csvCell).join(','), maxBytes } });
    this._st = st;
    this._set = set;
    this._blank = header.slice(2, -2).map(() => '');
    this.minutes = minutes;
    this.maxMs = minutes * 60_000;
    this.maxBytes = maxBytes;
    this.events = [];
    this.markers = [];
    this.stopReason = null;
    this._pending = [];
    this._detector = new EventDetector();
    this._finished = false;
    this.on('sample', (sample) => this._accept(sample));
  }

  /** { min, max, last } of the battery voltage seen (null until read). */
  get battery() {
    return { min: this.min.battery ?? null, max: this.max.battery ?? null, last: this._set.value('battery')?.value ?? null };
  }

  /** Keys of the values that need the ECU unlock and are not being read now. */
  get locked() {
    return this._set.view().locked;
  }

  /** Keys of the values the ECU does not serve (marked once, not asked again). */
  get notAvailable() {
    return this._set.view().unsupported;
  }

  /** Keys of the every-cycle values that went silent after answering and now take turns (until they answer again). */
  get demoted() {
    return this._set.view().demoted;
  }

  /** How many cycles had their rotating read skipped because the every-cycle reads were slow. */
  get skippedRotations() {
    return this._st.skipped;
  }

  /** Clock time of the longest cycle so far (ms). */
  get longestCycleMs() {
    return this._st.maxCycleMs;
  }

  /** Stamp `text` on the next sample's marker column. Returns the marker, or null if empty or the run is over. */
  mark(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean || !this.running) return null;
    const marker = { t_ms: this.elapsedMs, text: clean };
    this._pending.push(marker);
    this.markers.push(marker);
    this.emit('mark', marker);
    return marker;
  }

  /** What a page shows, as plain data. */
  view() {
    const v = this._set.view().values;
    return {
      running: this.running,
      outcome: this.outcome,
      elapsedMs: this.elapsedMs,
      samples: this.samples,
      cycles: this.cycles,
      errors: this.errors,
      lastError: this.lastError,
      csvPath: this.csvPath,
      csvFile: this.csvPath ? path.basename(this.csvPath) : null,
      events: this.events,
      markers: this.markers,
      battery: this.battery,
      locked: this.locked,
      lockedNote: this.locked.length ? svc.needsUnlock(this.conn) : null,
      notAvailable: this.notAvailable,
      stopReason: this.stopReason,
      cycle_ms: this._st.lastCycleMs, // the newest cycle, as in the CSV column
      cycleMs: { last: this._st.lastCycleMs, longest: this._st.maxCycleMs },
      demoted: this.demoted,
      skippedRotations: this._st.skipped,
      live: {
        rpm: v.rpmId?.value ?? v.rpm?.value ?? null,
        throttle: v.tps?.value ?? null,
        battery: v.battery?.value ?? null,
        fuelPump: v.fuelPump?.active ?? null,
        mainRelay: v.mainRelay?.active ?? null,
        startSwitch: v.startSwitch?.active ?? null,
      },
    };
  }

  _accept(sample) {
    const markers = this._pending.splice(0);
    sample.marker = markers.map((m) => m.text).join(' | ');
    sample.events = this._detector.push(sample.snapshot);
    for (const text of sample.events) this._addEvent(sample.t_ms, text);
    this._writeRow(sample.t_ms, sample.cycleMs, sample.cells, sample.marker, sample.events.join('; '));
    if (this.stopReason === null && this.elapsedMs >= this.maxMs) {
      this._stop(`time limit of ${this.minutes} minute${this.minutes === 1 ? '' : 's'} reached`);
    }
  }

  _addEvent(t_ms, text) {
    const event = { t_ms, text };
    this.events.push(event);
    this.emit('event', event);
  }

  _stop(reason) {
    this.stopReason = reason;
    this.sampler.finished = true;
  }

  _rowText(t_ms, cycleMs, cells, marker, event) {
    return [t_ms, cycleMs, ...cells, marker, event].map(csvCell).join(',');
  }

  _writeRow(t_ms, cycleMs, cells, marker, event) {
    this._sink.row(this._rowText(t_ms, cycleMs, cells, marker, event));
    this._noteCap();
  }

  /** A row the size limit refused ends the recording (once, with the message). */
  _noteCap() {
    if (this._sink.capped && this.stopReason === null) this._stop(`CSV size limit reached (${megabytes(this.maxBytes)}): recording stopped`);
  }

  /** The run's log is not closed at once: the connection marks itself 'lost' right after it cancels the runs, and that gets a last row first. */
  _endLog() {
    if (!this._sink) return; // the log could not be opened: nothing to finish
    queueMicrotask(() => this._finish());
  }

  /** After the run has ended: the connection loss and any marker still waiting get their row, then the file is closed. */
  _finish() {
    if (this._finished) return;
    this._finished = true;
    const t_ms = this.endedAt - this.startedAt;
    const lost = this.conn.state === 'lost';
    if (lost) {
      this._addEvent(t_ms, 'connection lost');
      this.stopReason ??= `connection lost: ${this.conn.error}`;
    }
    let closing;
    if (lost || this._pending.length) {
      const marker = this._pending.splice(0).map((m) => m.text).join(' | ');
      closing = this._rowText(t_ms, '', this._st.cells ?? this._blank, marker, lost ? 'connection lost' : '');
    }
    this._sink.close(closing);
    this._noteCap();
  }
}

function recordRun(conn, opts) {
  return new Recording(conn, opts);
}

module.exports = {
  Recording, recordRun, EventDetector, EVERY_CYCLE,
  SILENT_STRIKES, ROTATING_STRIKES, ROTATING_TIMEOUT_MS, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES,
};
