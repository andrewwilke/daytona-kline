'use strict';

const fs = require('fs');
const path = require('path');
const { LiveRun } = require('./liverun');
const svc = require('./services');
const { hex } = require('./kwp');

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');
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
const EVERY_CYCLE = ['battery', 'rpmId', 'startSwitch', 'fuelPump', 'injPulse1', 'tipOver', 'warningLamp', 'engineLamp'];

// A value that never gave an answer, this many reads in a row, is not served (the ECU now
// and then skips a request, so one silence is not enough to give a value up). Every-cycle
// values get 3 reads (silence costs a 500 ms wait, twice, with the resend), the values that
// take turns 2 and a shorter wait (a silent one costs about 2 x 250 ms when its turn comes).
const SILENT_STRIKES = 3;
const ROTATING_STRIKES = 2;
const ROTATING_TIMEOUT_MS = 250;

// An every-cycle value that did answer once but is silent this many reads in a row is not read
// every cycle any more (each cycle would wait out 2 x 500 ms for it): it takes turns with the
// rotating values, with their short wait, and goes back to every cycle when it answers again.
const DEMOTE_STRIKES = 3;

// When the every-cycle reads of a cycle took longer than max(1200 ms, 300 ms per every-cycle
// value) the rotating read of that cycle is skipped: the ECU is slow or silent on something and
// a cycle has to stay short enough to catch a 2-3 s crank. (300 ms per value, because the 8 values
// at a real read's ~190 ms take 1.5 s when all is well.)
const SLOW_CYCLE_MS = 1200;
const SLOW_CYCLE_MS_PER_VALUE = 300;

// The supported-PID read, once it has failed, is tried again only every this many cycles (it is
// 2 x 360 ms of waiting for nothing when the ECU is not answering PID 00).
const SUPPORTED_RETRY_CYCLES = 10;

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

/** The reads of the bike description as items: { key, kind: 'gauge' | 'switch' | 'analog', def, id, gated }. */
function itemsOf(bike) {
  const items = [
    ...bike.gauges.map((def) => ({ key: def.key, kind: 'gauge', def, id: def.id ?? null, gated: !!def.requiresUnlock })),
    ...bike.switches.map((def) => ({ key: def.key, kind: 'switch', def, id: def.id, gated: !!bike.switchesRequireUnlock })),
    ...bike.analogs.map((def) => ({ key: def.key, kind: 'analog', def, id: def.id, gated: def.requiresUnlock ?? true })),
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

    const st = {
      startedAt: 0,
      values: {}, // newest { value, bytes, text?, active?, at } per key
      na: new Set(),
      supported: null,
      locked: [],
      cells: null,
      lastCycleMs: 0,
      maxCycleMs: 0,
      supportedFailedAt: null, // the cycle the last failed supported-PID read was in
      demoted: new Set(), // every-cycle keys that take turns for now
      skipped: 0, // cycles whose rotating read was skipped
    };
    let turn = 0;
    const cells = () => [
      ...columns.map((k) => {
        const v = byKey.get(k).kind === 'switch' ? st.values[k]?.active : st.values[k]?.value;
        return typeof v === 'boolean' ? Number(v) : v ?? '';
      }),
      ...rawItems.map((it) => (st.values[it.key] ? hex(st.values[it.key].bytes) : '')),
    ];
    const sampler = {
      name: 'record',
      interval,
      finished: false,
      items,
      async sample(session, ctx) {
        const began = conn.clock.now();
        const t_ms = began - st.startedAt;
        if (!st.supported && (st.supportedFailedAt === null || ctx.cycle - st.supportedFailedAt >= SUPPORTED_RETRY_CYCLES)) {
          try {
            st.supported = await svc.supportedPids(session);
            for (const it of items) if (it.kind === 'gauge' && it.def.pid != null && !st.supported.has(it.def.pid)) st.na.add(it.key);
          } catch (e) {
            st.supportedFailedAt = ctx.cycle; // asked again only after SUPPORTED_RETRY_CYCLES cycles
            ctx.error(e);
          }
        }
        const open = svc.needsUnlock(conn) === null;
        st.locked = open ? [] : items.filter((it) => it.gated).map((it) => it.key);
        const served = (it) => !st.na.has(it.key) && (open || !it.gated);
        const every = critical.filter((it) => served(it) && !st.demoted.has(it.key));
        const pool = [...rotation.filter(served), ...critical.filter((it) => served(it) && st.demoted.has(it.key))];
        const channels = {};
        const read = [];
        const readOne = async (it, rotating) => {
          try {
            const r = await readItem(session, it, rotating ? ROTATING_TIMEOUT_MS : undefined);
            if (r) {
              it.answered = true;
              it.strikes = 0;
              st.demoted.delete(it.key);
              st.values[it.key] = { ...r, at: ctx.cycle };
              channels[it.key] = r.value;
              read.push(it.key);
              return;
            }
            it.strikes = (it.strikes ?? 0) + 1;
            if (!it.answered) {
              if (it.strikes >= (rotating ? ROTATING_STRIKES : SILENT_STRIKES)) st.na.add(it.key);
            } else if (!rotating && it.strikes >= DEMOTE_STRIKES) {
              st.demoted.add(it.key);
              it.strikes = 0;
            }
          } catch (e) {
            ctx.error(e);
          }
        };
        const everyStart = conn.clock.now();
        for (const it of every) {
          if (ctx.signal.aborted) break;
          await readOne(it, false);
        }
        const skip = conn.clock.now() - everyStart > Math.max(SLOW_CYCLE_MS, SLOW_CYCLE_MS_PER_VALUE * every.length);
        if (skip) {
          st.skipped++;
        } else {
          for (let i = 0; i < Math.min(perCycle, pool.length); i++) {
            if (ctx.signal.aborted) break;
            await readOne(pool[turn++ % pool.length], true);
          }
        }
        st.cells = cells();
        const v = (k) => st.values[k]?.value ?? null;
        const flag = (k) => st.values[k]?.active ?? null;
        st.lastCycleMs = conn.clock.now() - began;
        st.maxCycleMs = Math.max(st.maxCycleMs, st.lastCycleMs);
        return {
          t_ms,
          cycleMs: st.lastCycleMs,
          skipped: skip,
          channels,
          read,
          cells: st.cells,
          snapshot: { t: t_ms, rpm: v('rpmId') ?? v('rpm'), battery: v('battery'), fuelPump: flag('fuelPump'), mainRelay: flag('mainRelay'), startSwitch: flag('startSwitch'), tipOver: flag('tipOver'), warningLamp: flag('warningLamp'), engineLamp: flag('engineLamp') },
        };
      },
    };

    super(conn, sampler, { name: 'record', interval });
    st.startedAt = this.startedAt;
    this._st = st;
    this._header = header;
    this._blank = header.slice(2, -2).map(() => '');
    this.minutes = minutes;
    this.maxMs = minutes * 60_000;
    this.maxBytes = maxBytes;
    this.events = [];
    this.markers = [];
    this.stopReason = null;
    this.csvBytes = 0;
    this.endedAt = null;
    this._pending = [];
    this._detector = new EventDetector();
    this._csvFd = null;
    this._finished = false;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
      for (let n = 1; this._csvFd === null; n++) {
        const file = path.join(logDir, `record-${stamp}${n > 1 ? `-${n}` : ''}.csv`);
        try {
          this._csvFd = fs.openSync(file, 'wx'); // never over an earlier recording
          this.csvPath = file;
        } catch (e) {
          if (e.code !== 'EEXIST' || n >= 99) throw e;
        }
      }
      this._write(`${header.map(csvCell).join(',')}\n`);
    } catch (e) {
      this._closeCsv();
      this._registration.cancel();
      throw e;
    }
    this.on('sample', (sample) => this._accept(sample));
    this.on('end', () => {
      this.endedAt = this.conn.clock.now();
      queueMicrotask(() => this._finish()); // the connection marks itself 'lost' right after it cancels the runs
    });
  }

  /** ms since the recording was created. */
  get elapsedMs() {
    return (this.endedAt ?? this.conn.clock.now()) - this.startedAt;
  }

  /** { min, max, last } of the battery voltage seen (null until read). */
  get battery() {
    return { min: this.min.battery ?? null, max: this.max.battery ?? null, last: this._st.values.battery?.value ?? null };
  }

  /** True while the CSV file is open (it is closed as soon as the run has ended). */
  get csvOpen() {
    return this._csvFd !== null;
  }

  /** Keys of the values that need the ECU unlock and are not being read now. */
  get locked() {
    return this._st.locked;
  }

  /** Keys of the values the ECU does not serve (marked once, not asked again). */
  get notAvailable() {
    return [...this._st.na];
  }

  /** Keys of the every-cycle values that went silent after answering and now take turns (until they answer again). */
  get demoted() {
    return [...this._st.demoted];
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
    const marker = { t_ms: this.conn.clock.now() - this.startedAt, text: clean };
    this._pending.push(marker);
    this.markers.push(marker);
    this.emit('mark', marker);
    return marker;
  }

  /** What a page shows, as plain data. */
  view() {
    const v = this._st.values;
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
    if (this.stopReason === null && this.conn.clock.now() - this.startedAt >= this.maxMs) {
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

  _writeRow(t_ms, cycleMs, cells, marker, event) {
    const line = [t_ms, cycleMs, ...cells, marker, event].map(csvCell).join(',');
    this._write(`${line}\n`, true);
  }

  _write(text, isRow = false) {
    if (this._csvFd === null) return;
    const size = Buffer.byteLength(text);
    if (isRow && this.csvBytes + size > this.maxBytes) {
      if (this.stopReason === null) this._stop(`CSV size limit reached (${megabytes(this.maxBytes)}): recording stopped`);
      return;
    }
    try {
      fs.writeSync(this._csvFd, text);
      this.csvBytes += size;
    } catch (e) {
      this._fail(new Error(`log write failed: ${e.message}`));
      this._closeCsv();
    }
  }

  _closeCsv() {
    if (this._csvFd === null) return;
    try {
      fs.closeSync(this._csvFd);
    } catch {
      // nothing more to do for a file that will not close
    }
    this._csvFd = null;
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
    if (lost || this._pending.length) {
      const marker = this._pending.splice(0).map((m) => m.text).join(' | ');
      this._writeRow(t_ms, '', this._st.cells ?? this._blank, marker, lost ? 'connection lost' : '');
    }
    this._closeCsv();
  }
}

function recordRun(conn, opts) {
  return new Recording(conn, opts);
}

module.exports = {
  Recording, recordRun, EventDetector, EVERY_CYCLE, DEFAULT_MINUTES, DEFAULT_MAX_BYTES,
  SILENT_STRIKES, ROTATING_STRIKES, ROTATING_TIMEOUT_MS, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES,
};
