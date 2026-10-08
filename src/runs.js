'use strict';

const svc = require('./services');
const { blockRun, gaugeRun, switchRun, probeRun } = require('./liverun');
const { recordRun } = require('./recorder');
const { discoverRun } = require('./discover');

/**
 * Who may use the K-line, and in what order: the one home of that rule.
 *
 * There is one line to the ECU, so only one thing at a time may really talk
 * on it. Every feature the GUI offers is a run (src/liverun.js) and falls in
 * one of three roles:
 *
 *   exclusive    a recording ('recording') or an id scan ('scan'). It wants
 *                the line to itself: starting one while the other runs is
 *                refused, and every background run yields to it.
 *   background   the dashboard ('dashboard') and the switch watcher
 *                ('switches'). They run all the time, from the moment the
 *                bike is connected (the switch watcher once the ECU is
 *                unlocked), unless the owner stopped them. While an exclusive
 *                run is on they are not started (the request is remembered,
 *                `paused` says so) and one that was running is stopped; when
 *                the exclusive run ends, whatever yielded or was held back
 *                comes back.
 *   tool         the sensor block read ('sensor') and the block probe
 *                ('probe'): advanced tools the owner starts and stops, which
 *                do not take part in any of this.
 *
 * Interface (what a caller must know):
 *
 *   const runs = createRuns(conn, { logDir });
 *   runs.start(name, opts)    -> { run, started, paused?, unavailable? }
 *       The owner asks for a feature. Needs a session (throws as conn.requireSession does).
 *       Idempotent: a feature already running is left alone (`started: false`), except the
 *       sensor block read, which a new start replaces. A background feature started while an
 *       exclusive run is on does not start: `paused: { by, why, note }`, and it starts when
 *       the exclusive run ends. One that cannot run now (the switch watcher while the ECU is
 *       locked) answers `unavailable: <why>` and runs nothing. An exclusive feature started
 *       while the other exclusive one runs throws "<it> is running: stop it first"; started
 *       otherwise it stops the background runs (to be brought back later) first. A start by
 *       the owner also clears the owner's stop of that feature.
 *   runs.ensure(name)         -> { run } | { paused }
 *       For the switch watcher's polling page: the run to take a cycle from, or why not now.
 *       Never clears the owner's stop (a late poll must not undo the owner's Stop).
 *   runs.stop(name)           the owner stops a feature. For the dashboard and the switch
 *       watcher it is remembered (`stoppedByOwner`) until the next connection, so nothing
 *       restores it behind the owner's back. Stopping something that is not running is fine.
 *   runs.reconcile()          -> [names started]
 *       Start what should be running and is not: the background features that the owner did not
 *       stop, that nothing blocks and that can run now. The page calls it once it is connected
 *       (and after the unlock), instead of keeping its own flags.
 *   runs.status()             what is running, what is paused and why, what the owner stopped,
 *       what is waiting for something else (the unlock): plain data for GET /api/runs.
 *   runs.get(name) / runs.active(name)   the latest run of a feature (kept after it ended, for
 *       the view of its results; `sensor` is dropped when it ends) / only if it is running.
 *   runs.requireNoExclusive(message)     throws while a recording or an id scan runs (a brief
 *       read that must not share the line, such as a snapshot).
 *   runs.reset()              forget the owner's stops and what was held back. Done by itself
 *       whenever the connection leaves 'connected' (disconnect, lost, a new connect), so every
 *       connection starts with the owner's stops cleared.
 *   runs.logDir, runs.notes   where recordings and scans write (undefined: the project's logs
 *       folder); notes.sensor is why the last sensor block read gave up on its own.
 *
 * Restoring after an exclusive run waits one microtask and checks that the session is still there:
 * a disconnect or a lost ECU cancels every run first, and nothing may be started into a dying
 * connection.
 *
 * Line priority. How long a waiting background read may be overtaken by the dashboard's reads is
 * tuning of the one shared line, so it lives here too (the dashboard run itself only reads and
 * reports): while the engine runs (rpm above RUNNING_RPM) background reads, the switch watcher's,
 * wait BACKGROUND_WAIT_RUNNING_MS before they go ahead of the dashboard's, so the needles keep up
 * with the throttle; otherwise they wait the session's default. See backgroundWaitFor().
 *
 * Depth: the callers (routes, a page) name a feature and say what the owner did; the exclusivity,
 * the order of yielding and coming back, the owner's stops and the start policy are behind that.
 * The seam is the feature table (a run factory per name): the default table builds the real runs,
 * tests give it fake ones.
 */

// While the engine runs, the background reads (the switch watcher) wait this long for the line, so the
// gauges refresh quickly; otherwise they get it after the session's default wait.
const RUNNING_RPM = 400;
const BACKGROUND_WAIT_RUNNING_MS = 800;
const BACKGROUND_WAIT_IDLE_MS = 300; // the session's default (KwpSession)

/** The background wait (ms) for a dashboard that last read engine speed `rpm` (undefined: not read yet). */
const backgroundWaitFor = (rpm) => (rpm > RUNNING_RPM ? BACKGROUND_WAIT_RUNNING_MS : BACKGROUND_WAIT_IDLE_MS);

const SWITCHES_NOTE = 'This bike description names no switch IDs, not available.';

/** The analog extras of the bike that the switches panel shows; `panel: false` ones are only recorded. */
const panelAnalogs = (conn) => conn.bike.analogs.filter((a) => a.panel !== false);

/**
 * The features and how to make a run for each. A feature is { role, label, create(conn, opts, env) } and
 * optionally: `auto` (a background feature that starts by itself, reconcile), `polled` (the run is not
 * started: a page takes its cycles with step()), `replace` (starting it again replaces the old run),
 * `keep: false` (forget the run when it ends), `unavailable(conn)` (why it cannot run now, or null) and
 * `attach(run, env)` (wire the run to its surroundings once, before it starts). env is
 * { conn, logDir, note(text) }.
 */
const FEATURES = {
  dashboard: {
    role: 'background',
    auto: true,
    label: 'the dashboard',
    create: (conn) => gaugeRun(conn),
    attach(run, { conn }) {
      // The line priority policy (see the top of this file): follow the engine speed the dashboard reads.
      run.on('sample', () => conn.session?.setBackgroundWaitMs(backgroundWaitFor(run.sampler.values.rpm?.value)));
      run.on('end', () => conn.session?.setBackgroundWaitMs(BACKGROUND_WAIT_IDLE_MS));
    },
  },
  switches: {
    role: 'background',
    auto: true,
    polled: true,
    label: 'the switch watcher',
    unavailable: (conn) => (conn.bike.switchIds.length ? svc.needsUnlock(conn) : SWITCHES_NOTE),
    create: (conn) => switchRun(conn, { analogs: panelAnalogs(conn) }),
  },
  recording: {
    role: 'exclusive',
    label: 'a recording',
    create: (conn, opts, { logDir }) => recordRun(conn, { minutes: opts.minutes ?? undefined, logDir }),
  },
  scan: {
    role: 'exclusive',
    label: 'the id scan',
    create: (conn, opts, { logDir }) => discoverRun(conn, { from: opts.from ?? undefined, to: opts.to ?? undefined, logDir }),
  },
  sensor: {
    role: 'tool',
    label: 'the sensor block read',
    replace: true,
    keep: false,
    create: (conn, { id, log = false, interval = 150 }) => blockRun(conn, { id, interval, log }),
    attach(run, { note }) {
      // Reads that fail from the very start mean the request itself is refused: stop and say so.
      run.on('fault', () => {
        if (!run.samples && run.errors >= 3) {
          note(`${run.lastError} (the sensor block read is an advanced tool; the ECU may not serve it)`);
          run.stop();
        }
      });
    },
  },
  probe: {
    role: 'tool',
    label: 'the block probe',
    create: (conn, { from, to }) => probeRun(conn, { from, to }),
  },
};

class Runs {
  constructor(conn, { features = FEATURES, logDir } = {}) {
    this.conn = conn;
    this.features = features;
    this.logDir = logDir;
    this.notes = {};
    this._runs = new Map(); // feature -> its latest run
    this._ownerStopped = new Set(); // background features the owner stopped, until the next connection
    this._deferred = new Set(); // background features to bring back when the exclusive run ends
    conn.on('state', ({ state }) => {
      if (state !== 'connected') this.reset();
    });
  }

  reset() {
    this._ownerStopped.clear();
    this._deferred.clear();
  }

  /** The latest run of a feature (or null), also after it ended. */
  get(name) {
    this._feature(name);
    return this._runs.get(name) ?? null;
  }

  /** The run of a feature if it is running, else null. */
  active(name) {
    const run = this.get(name);
    return run?.running ? run : null;
  }

  /** Forget the kept run of a feature (its results are no longer shown). A run that is still going is left alone, just not kept. */
  forget(name) {
    this._feature(name);
    this._runs.delete(name);
  }

  start(name, opts = {}) {
    const f = this._feature(name);
    this.conn.requireSession();
    if (f.auto) this._ownerStopped.delete(name);
    const current = this.active(name);
    if (current && !f.replace) return { run: current, started: false };
    if (f.role === 'background') {
      const paused = this._pausedBy(name);
      if (paused) {
        this._deferred.add(name);
        return { run: null, started: false, paused };
      }
      const unavailable = f.unavailable?.(this.conn);
      if (unavailable) return { run: null, started: false, unavailable };
    }
    current?.stop();
    return { run: this._launch(name, opts), started: true };
  }

  ensure(name) {
    const f = this._feature(name);
    this.conn.requireSession();
    if (this._ownerStopped.has(name)) {
      return { paused: { by: 'owner', why: `${f.label} was stopped`, note: `${f.label} was stopped: start it again to resume` } };
    }
    const current = this.active(name);
    if (current) return { run: current };
    const paused = this._pausedBy(name);
    if (paused) {
      this._deferred.add(name);
      return { paused };
    }
    return { run: this._launch(name, {}) };
  }

  stop(name) {
    const f = this._feature(name);
    if (f.auto) {
      this._ownerStopped.add(name);
      this._deferred.delete(name);
    }
    this._runs.get(name)?.stop();
  }

  reconcile() {
    const started = [];
    if (!this.conn.session) return started;
    for (const name of this._autoFeatures()) {
      if (this._ownerStopped.has(name) || this.active(name)) continue;
      if (this._pausedBy(name)) {
        this._deferred.add(name);
        continue;
      }
      if (this.unavailable(name)) continue;
      try {
        this._launch(name, {});
        started.push(name);
      } catch {
        // cannot start right now: it stays off until the next reconcile
      }
    }
    return started;
  }

  /** Why a feature cannot run now apart from another run holding the line (not connected, locked...), or null. */
  unavailable(name) {
    const f = this._feature(name);
    if (!this.conn.session) return 'not connected';
    return f.unavailable?.(this.conn) ?? null;
  }

  /** Throws while an exclusive run (a recording, an id scan) holds the line; `message` replaces the default words. */
  requireNoExclusive(message) {
    const by = this._exclusive();
    if (by) throw new Error(message ?? `${this.features[by].label} is running: stop it first`);
  }

  status() {
    const running = [...this._runs].filter(([, run]) => run.running).map(([feature, run]) => ({
      feature,
      role: this.features[feature].role,
      run: run.name,
      startedAt: run.startedAt ?? null,
    }));
    const paused = [...this._deferred].map((feature) => ({ feature, ...this._pausedBy(feature) })).filter((p) => p.by);
    const waiting = this._autoFeatures()
      .filter((n) => this.conn.session && !this._ownerStopped.has(n) && !this.active(n) && !this._pausedBy(n) && this.unavailable(n))
      .map((feature) => ({ feature, why: this.unavailable(feature) }));
    return {
      connected: !!this.conn.session,
      exclusive: this._exclusive(),
      running,
      paused,
      stoppedByOwner: [...this._ownerStopped],
      waiting,
    };
  }

  _feature(name) {
    const f = this.features[name];
    if (!f) throw new Error(`unknown feature "${name}"`);
    return f;
  }

  _autoFeatures() {
    return Object.keys(this.features).filter((n) => this.features[n].auto);
  }

  /** The feature name of the exclusive run that is on, or null. */
  _exclusive() {
    return Object.keys(this.features).find((n) => this.features[n].role === 'exclusive' && this.active(n)) ?? null;
  }

  /** { by, why, note } while an exclusive run keeps the background feature `name` off the line, else null. */
  _pausedBy(name) {
    const by = this._exclusive();
    if (!by) return null;
    const why = `${this.features[by].label} is running`;
    return { by, why, note: `${why}: ${this.features[name].label} starts again when it ends` };
  }

  /** Make the run of a feature, wire it, start it (unless a page takes its cycles) and keep it. */
  _launch(name, opts) {
    const f = this.features[name];
    const env = { conn: this.conn, logDir: this.logDir, note: (text) => { this.notes[name] = text; } };
    if (f.role === 'exclusive') {
      const other = this._exclusive();
      if (other && other !== name) throw new Error(`${this.features[other].label} is running: stop it first`);
      this._yieldTheLine();
    }
    this.notes[name] = null;
    let run;
    try {
      run = f.create(this.conn, opts, env);
    } catch (e) {
      if (f.role === 'exclusive') this._restore(); // the line was cleared for a run that never came
      throw e;
    }
    this._runs.set(name, run);
    f.attach?.(run, env);
    run.on('end', () => this._ended(name, run));
    if (!f.polled) run.start();
    return run;
  }

  /** An exclusive run is about to start: the background runs stop and are remembered to come back. */
  _yieldTheLine() {
    for (const name of Object.keys(this.features)) {
      if (this.features[name].role !== 'background') continue;
      const run = this.active(name);
      if (!run) continue;
      this._deferred.add(name);
      run.stop();
    }
  }

  _ended(name, run) {
    const f = this.features[name];
    if (f.keep === false && this._runs.get(name) === run) this._runs.delete(name);
    if (f.role === 'exclusive') queueMicrotask(() => this._restore());
  }

  /** The exclusive run is over: bring back what yielded or was held back, unless the owner stopped it meanwhile or the session is gone. */
  _restore() {
    if (this._exclusive() || !this.conn.session) return;
    for (const name of [...this._deferred]) {
      this._deferred.delete(name);
      if (this._ownerStopped.has(name) || this.active(name) || this.unavailable(name)) continue;
      try {
        this._launch(name, {});
      } catch {
        // cannot come back right now: the next start or reconcile brings it
      }
    }
  }
}

function createRuns(conn, options) {
  return new Runs(conn, options);
}

module.exports = {
  createRuns, Runs, FEATURES, SWITCHES_NOTE, panelAnalogs, backgroundWaitFor,
  RUNNING_RPM, BACKGROUND_WAIT_RUNNING_MS, BACKGROUND_WAIT_IDLE_MS,
};
