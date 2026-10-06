'use strict';

const fs = require('fs');
const path = require('path');
const { LiveRun } = require('./liverun');
const svc = require('./services');

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');
const DEFAULT_FROM = 0x0000;
const DEFAULT_TO = 0x00ff;
const EXTENDED_FROM = 0x0100;
const EXTENDED_TO = 0x03ff;
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_MAX_MS = 10 * 60_000;

const idText = (id) => `0x${id.toString(16).padStart(4, '0')}`;
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/**
 * Sweep service 0x22 over an id range and list every id this ECU answers (read-only: the
 * only thing it ever sends is `22 hi lo`, once per id, no retries). Silence and refusals
 * both mean "not served here"; a failing link (bad checksum) is counted as an error and the
 * sweep goes on. It is a LiveRun, one id per cycle, so the connection's keep-alive and the
 * session's P3 spacing apply as for everything else, a disconnect cancels it, and it needs
 * the ECU unlock (creating it while locked throws a NeedsUnlockError).
 *
 *   const run = discoverRun(conn, { from: 0, to: 0xff });
 *   await run.start();
 *   run.found                // [{ id, value, hex, bytes, name }] (name: the bike's own, or null)
 *
 * Options: from (0x0000), to (0x00ff), timeout per id in ms (300), maxMs (10 minutes: a
 * sweep that is not done by then ends with `stopReason`), logDir. When the run ends, however
 * it ends, what it found is saved to <logDir>/discovered-ids-<time>.json (`resultPath`; if that
 * fails, `saveError`).
 */
class Discovery extends LiveRun {
  constructor(conn, { from = DEFAULT_FROM, to = DEFAULT_TO, timeout = DEFAULT_TIMEOUT_MS, maxMs = DEFAULT_MAX_MS, logDir = DEFAULT_LOG_DIR, interval = 0 } = {}) {
    if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) || from > to) {
      throw new Error('the id range must be whole numbers from 0x0000 to 0xffff, first not above last');
    }
    const began = conn.clock.now();
    let next = from;
    const sampler = {
      name: 'discover',
      interval,
      needsUnlock: true,
      current: from,
      asked: 0,
      silent: 0,
      refused: 0,
      failed: [],
      found: [],
      stopReason: null,
      get finished() {
        return next > to || this.stopReason !== null;
      },
      async sample(session, ctx) {
        const id = next++;
        sampler.current = id;
        let result = { hit: null, why: 'failed' };
        try {
          result = await svc.probeCommonId(session, id, { timeout });
        } catch (e) {
          ctx.error(e);
          sampler.failed.push(id);
        }
        if (ctx.signal.aborted) return { channels: {}, id, hit: null, why: null }; // the run is over: this read is not counted
        sampler.asked++;
        if (result.hit) sampler.found.push({ ...result.hit, name: svc.knownIdName(conn.bike, id) });
        else if (result.why === 'silent') sampler.silent++;
        else if (result.why === 'refused') sampler.refused++;
        if (next <= to && conn.clock.now() - began >= maxMs) {
          sampler.stopReason = `time limit of ${Math.round(maxMs / 1000)} s reached at ${idText(next - 1)}, ${to - next + 1} id(s) not asked`;
        }
        return { channels: {}, id, hit: result.hit, why: result.why };
      },
    };
    super(conn, sampler, { name: 'discover', interval });
    this.from = from;
    this.to = to;
    this.logDir = logDir;
    this.resultPath = null;
    this.saveError = null;
    this.on('end', (outcome) => this._save(outcome));
  }

  get found() {
    return this.sampler.found;
  }

  get total() {
    return this.to - this.from + 1;
  }

  /** What a page shows, as plain data. */
  view() {
    const s = this.sampler;
    return {
      running: this.running,
      outcome: this.outcome,
      from: this.from,
      to: this.to,
      current: s.current,
      asked: s.asked,
      total: this.total,
      found: s.found.map(({ id, value, hex, name }) => ({ id, value, hex, name })),
      silent: s.silent,
      refused: s.refused,
      failed: s.failed.length,
      elapsedMs: this.conn.clock.now() - this.startedAt,
      stopReason: s.stopReason,
      resultFile: this.resultPath ? path.basename(this.resultPath) : null,
      resultPath: this.resultPath,
      saveError: this.saveError,
      errors: this.errors,
      lastError: this.lastError,
    };
  }

  _save(outcome) {
    const s = this.sampler;
    const file = path.join(this.logDir, `discovered-ids-${stamp(this.startedAt)}.json`);
    const result = {
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: this.conn.clock.now() - this.startedAt,
      from: idText(this.from),
      to: idText(this.to),
      outcome,
      complete: s.asked === this.total,
      stopReason: s.stopReason,
      asked: s.asked,
      served: s.found.length,
      silent: s.silent,
      refused: s.refused,
      failed: s.failed.map(idText),
      found: s.found.map((f) => ({ id: idText(f.id), value: f.value, hex: f.hex, name: f.name })),
    };
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      this.resultPath = file;
    } catch (e) {
      this.saveError = e.message;
    }
  }
}

function discoverRun(conn, opts) {
  return new Discovery(conn, opts);
}

/**
 * Read a list of 0x22 ids once each (what a snapshot is), one per cycle, with the same care as
 * the sweep: only `22 hi lo`, no retries, silence and refusals are "not served". `sampler.values`
 * holds { [id]: { hex, value } } for the ids that answered. Needs the ECU unlock. Options: ids,
 * timeout (300), interval (0).
 */
function snapshotRun(conn, { ids, timeout = DEFAULT_TIMEOUT_MS, interval = 0 } = {}) {
  let i = 0;
  const sampler = {
    name: 'snapshot',
    interval,
    needsUnlock: true,
    values: {},
    get finished() {
      return i >= ids.length;
    },
    async sample(session, ctx) {
      const id = ids[i++];
      try {
        const { hit } = await svc.probeCommonId(session, id, { timeout });
        if (hit && !ctx.signal.aborted) sampler.values[id] = { hex: hit.hex, value: hit.value };
      } catch (e) {
        ctx.error(e);
      }
      return { channels: {}, id };
    },
  };
  return new LiveRun(conn, sampler, { name: 'snapshot', interval });
}

/** One snapshot of `ids`: { at, ids, values: { [id]: { hex, value } } }. Throws if it was cut short (disconnect). */
async function takeSnapshot(conn, ids, opts) {
  const run = snapshotRun(conn, { ids, ...opts });
  if ((await run.start()) !== 'finished') throw new Error('the snapshot was cancelled');
  return { at: run.startedAt, ids: [...ids], values: run.sampler.values };
}

module.exports = { Discovery, discoverRun, snapshotRun, takeSnapshot, DEFAULT_FROM, DEFAULT_TO, EXTENDED_FROM, EXTENDED_TO, DEFAULT_MAX_MS };
