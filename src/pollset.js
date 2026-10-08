'use strict';

// ---- How long the ECU gets to prove it serves something ----------------------------
// The one place for the thresholds. A "strike" is one read that got no answer (silence,
// or a refusal the sampler did not call final). An item that never answered is not served
// once it has this many strikes in a row; one that answered once is never dropped (it keeps
// its last value, marked stale). The numbers differ on purpose, each for its own cost:

// The dashboard: a silent PID costs the session's default wait in a cycle that has to stay short
// and a dead gauge only needs three misses to be called dead.
const GAUGE_STRIKES = 3;

// The switch watcher reads every id once per scan, in the background, and the ECU answers
// some ids (0x61, 0x68) only now and then: a scan is cheap, so an id gets six of them.
const SWITCH_STRIKES = 6;

// The recorder's every-cycle values: silence costs a 500 ms wait twice (with the resend) in every
// cycle, so they get 3 reads. The values that take turns get 2 and a shorter wait (about 2 x 250 ms
// when their turn comes).
const SILENT_STRIKES = 3;
const ROTATING_STRIKES = 2;

// An every-cycle value that did answer once but is silent this many reads in a row is not read
// every cycle any more (each cycle would wait out 2 x 500 ms for it): it takes turns with the
// rotating values, with their short wait, and goes back to every cycle when it answers again.
const DEMOTE_STRIKES = 3;

// The supported-PID read, once it has failed, is tried again only every this many cycles (it is
// 2 x 360 ms of waiting for nothing when the ECU is not answering PID 00).
const SUPPORTED_RETRY_CYCLES = 10;

/**
 * A set of items polled over the K-line: the policy "an item that never answered is dropped, one
 * that answered keeps its last value (stale)" and the rotation "serve one item per cycle in turn"
 * written once. It knows nothing about requests: a sampler asks it what to read, reads it its own
 * way and reports what came back.
 *
 *   const set = pollset({ items, every: ['rpm', 'tps'], dropAfter: { every: 3, rotation: 3 }, gate: () => unlocked });
 *   const plan = await set.plan(session, ctx);                // once per cycle, before any read
 *   for (const item of [...plan.every, ...plan.turns(1)]) {   // the items to read now, in this order
 *     set.report(item.key, await read(item));                 // a value (answered) or null (no answer)
 *   }
 *   set.view();   // { values, unsupported, stale, demoted, locked, served, supported }
 *
 * Items: objects the caller owns and gets back as they are. The set reads three fields of them:
 * `key` (unique within the set; a string or a number), `gated` (true: only asked while the
 * unlock gate is open) and `pid` (a mode 01 PID number, or null / absent for an id). Everything
 * else (the bike's definition, a read kind) is the caller's.
 *
 * Options:
 *   items        every item, in the order `view().locked` lists them
 *   every        keys read in every cycle, in this order (default none)
 *   rotation     keys that take turns, in this order (default: the items not in `every`, in item order)
 *   dropAfter    { every, rotation }: strikes in a row before an item that never answered is
 *                unsupported (default Infinity: never). Per group, so the threshold is a property
 *                of the item, not of the read.
 *   demoteAfter  strikes in a row before an every-cycle item that answered once moves to the end
 *                of the rotation until it answers again (default Infinity: never). Strikes start
 *                again from 0 at the move.
 *   gate         () => true while gated items may be asked; called once per plan(). Default: always open.
 *   listSupported  async (session) => Set of PIDs the ECU serves, read by the first plan() that
 *                gets to (the supported-PID bootstrap): an item with a `pid` that is not in it is
 *                unsupported without being asked.
 *   supportedRetryCycles  null (default): a failed bootstrap makes plan() reject, so the next cycle
 *                tries again. A number: the failure goes to ctx.error(e), the cycle carries on
 *                without the list, and it is tried again only after that many cycles.
 *
 * Interface notes (what a caller must know):
 *   - plan(session, ctx) takes ctx = { cycle, error(e) } (the LiveRun sampler's ctx). It decides
 *     the batch from a snapshot taken at that moment: items dropped or demoted by the reports
 *     that follow take effect in the next plan, not in the batch in hand.
 *   - plan.turns(n) advances the rotation by the items it returns, so call it only when you will
 *     read them (a cycle that skips its rotating read leaves the rotation where it was).
 *   - report(key, value): value null / undefined is "no answer". report(key, v) with a value
 *     stores it as it is (add a cycle stamp yourself if you want one).
 *   - refuse(key): the ECU said no in a way that is final for this item (a refusal of an id
 *     gauge): unsupported at once, even if it answered before.
 *   - an unsupported item stays unsupported for the life of the set; it keeps its last value.
 *   - locked items (gated while the gate is closed) are skipped and left untouched: no strikes,
 *     no change of state. They are picked up by the first plan() after the gate opens.
 */
class PollSet {
  constructor({
    items = [], every = [], rotation, dropAfter = {}, demoteAfter = Infinity,
    gate = null, listSupported = null, supportedRetryCycles = null,
  } = {}) {
    this._state = new Map();
    for (const item of items) {
      if (this._state.has(item.key)) throw new Error(`the poll set has the key "${item.key}" twice`);
      this._state.set(item.key, { item, group: null, strikes: 0, answered: false, value: undefined, stale: false, unsupported: false, demoted: false });
    }
    const group = (keys, name) => keys.map((key) => {
      const s = this._state.get(key);
      if (!s) throw new Error(`the poll set has no item "${key}"`);
      if (s.group) throw new Error(`the poll set reads "${key}" both every cycle and in turn`);
      s.group = name;
      return s;
    });
    this._every = group(every, 'every');
    this._rotation = group(rotation ?? items.map((it) => it.key).filter((k) => !this._state.get(k).group), 'rotation');
    this._dropAfter = { every: dropAfter.every ?? Infinity, rotation: dropAfter.rotation ?? Infinity };
    this._demoteAfter = demoteAfter;
    this._gate = gate;
    this._listSupported = listSupported;
    this._retryCycles = supportedRetryCycles;
    this._values = {};
    this._unsupported = new Set(); // keys, in the order they were dropped
    this._demoted = new Set();
    this._locked = [];
    this._supported = null;
    this._failedAt = null; // the cycle the last failed bootstrap was in
    this._turn = 0;
  }

  /**
   * Decide this cycle's reads. Runs the supported-PID bootstrap if it is due and asks the gate once.
   * Resolves { every, turns(n = 1), locked }: `every` the items to read first (served, not demoted,
   * in order); `turns(n)` the next n items of the rotation (the rotating items that are served, then
   * the demoted every-cycle ones); `locked` the keys held back by the gate.
   */
  async plan(session, ctx) {
    await this._bootstrap(session, ctx);
    const open = this._gate ? !!this._gate() : true;
    this._locked = open ? [] : [...this._state.values()].filter((s) => s.item.gated).map((s) => s.item.key);
    const served = (s) => !s.unsupported && (open || !s.item.gated);
    const pool = [
      ...this._rotation.filter(served),
      ...this._every.filter((s) => served(s) && s.demoted),
    ].map((s) => s.item);
    return {
      every: this._every.filter((s) => served(s) && !s.demoted).map((s) => s.item),
      locked: [...this._locked],
      turns: (n = 1) => {
        const out = [];
        for (let i = 0; i < Math.min(n, pool.length); i++) out.push(pool[this._turn++ % pool.length]);
        return out;
      },
    };
  }

  /** What came back for `key`: a value (it answered) or null (no answer). */
  report(key, value) {
    const s = this._need(key);
    if (value !== null && value !== undefined) {
      s.strikes = 0;
      s.answered = true;
      s.stale = false;
      s.value = value;
      this._values[key] = value;
      s.demoted = false;
      this._demoted.delete(key);
      return;
    }
    s.strikes++;
    s.stale = s.answered;
    if (!s.answered) {
      if (s.strikes >= (this._dropAfter[s.group] ?? Infinity)) this._drop(s);
    } else if (s.group === 'every' && !s.demoted && s.strikes >= this._demoteAfter) {
      s.demoted = true;
      s.strikes = 0;
      this._demoted.add(key);
    }
  }

  /** The ECU said no to `key` for good: unsupported at once (see the notes above). */
  refuse(key) {
    this._drop(this._need(key));
  }

  /** The newest value reported for `key`, or undefined if it never answered (or there is no such item). */
  value(key) {
    return this._state.get(key)?.value;
  }

  /**
   * Plain data, as of now: `values` ({ key: newest value } for the items that answered), `unsupported`
   * (keys, in the order they were dropped), `stale` (answered once, silent on the latest read),
   * `demoted` (every-cycle keys that take turns for now), `locked` (gated keys held back at the last
   * plan), `served` (keys not unsupported, whether or not the gate is open) and `supported` (the
   * bootstrap's Set, null until it has been read).
   */
  view() {
    const all = [...this._state.values()];
    return {
      values: { ...this._values },
      unsupported: [...this._unsupported],
      stale: all.filter((s) => s.stale).map((s) => s.item.key),
      demoted: [...this._demoted],
      locked: [...this._locked],
      served: all.filter((s) => !s.unsupported).map((s) => s.item.key),
      supported: this._supported,
    };
  }

  async _bootstrap(session, ctx) {
    if (!this._listSupported || this._supported) return;
    if (this._failedAt !== null && ctx.cycle - this._failedAt < this._retryCycles) return;
    try {
      this._supported = await this._listSupported(session);
    } catch (e) {
      if (this._retryCycles === null) throw e;
      this._failedAt = ctx.cycle; // asked again only after supportedRetryCycles cycles
      ctx.error(e);
      return;
    }
    for (const s of this._state.values()) {
      if (s.item.pid != null && !this._supported.has(s.item.pid)) this._drop(s);
    }
  }

  _drop(s) {
    s.unsupported = true;
    this._unsupported.add(s.item.key);
  }

  _need(key) {
    const s = this._state.get(key);
    if (!s) throw new Error(`the poll set has no item "${key}"`);
    return s;
  }
}

function pollset(options) {
  return new PollSet(options);
}

module.exports = {
  PollSet, pollset,
  GAUGE_STRIKES, SWITCH_STRIKES, SILENT_STRIKES, ROTATING_STRIKES, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES,
};
