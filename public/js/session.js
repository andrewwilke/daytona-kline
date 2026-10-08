// What the page does about the server's runs: the dashboard and the switch watcher that run by themselves
// once connected, the owner's Start and Stop of them, and what happens around a recording.
//
// A plain script for the page (it sets the global `SessionState`) that also works with require() in Node.
// No DOM and no fetch of its own: the page gives it `api` (the page's JSON fetch) and a handle on its polling
// timers, and the server decides who may use the K-line (src/runs.js). The page keeps no exclusivity or
// owner-stop flags of its own: it asks `GET /api/runs` and does what the facts say.
//
// Interface (everything a caller must know):
//
//   SessionState.decide(facts) -> actions                  (pure)
//     facts = {
//       connected        the page's view of the session (GET /api/status)
//       unlock           the unlock state ('unlocked' is the one the switch watcher needs)
//       runs             the answer of GET /api/runs, or null if the server was not asked yet
//       ui: { dashboard, switches }   whether the page is polling that feature now
//     }
//     actions, in order:
//       { type: 'reconcile' }                    POST /api/runs/reconcile: the server starts what should run
//       { type: 'poll', feature, on }            attach the page's poll of a feature, or detach it
//     Rules: nothing is started or attached before the server has been asked (runs null). While a recording or
//     an id scan holds the line nothing is started (the server holds the background runs back and brings them
//     back when it ends) and the polls are detached. Otherwise the page polls what the server runs (the switch
//     watcher once unlocked) and asks for a reconcile when the dashboard, or once unlocked the switch watcher,
//     is not running although the owner did not stop it. A page that has just loaded while a recording runs
//     therefore starts nothing. Owner stops are the server's (`stoppedByOwner`): a stopped feature is left off
//     until the owner starts it or the next connection, which starts the server's list afresh.
//
//   SessionState.createPlanner() -> { plan(facts) }
//     decide() with one memory: a reconcile that was asked for for the same facts is not asked again (a start
//     that fails is not retried every poll; it is when the facts change: unlock, a run ends, ...). Reset when
//     the page is not connected.
//
//   SessionState.createController({ api, ui }) -> controller
//     api(method, url, body) -> the server's JSON answer (throws when it says not ok); ui.polling(feature) -> boolean and
//     ui.setPolling(feature, on) are the page's timers. Everything is run one after the other.
//     controller.sync({ connected, unlock })   the one reconcile step: ask GET /api/runs, plan, do the actions, and
//                                               plan again on what the server answered. The page calls it once
//                                               connected (after the status says what the unlock is), when the unlock
//                                               changes, when a recording or a scan ends, and on its status poll.
//                                               Resolves with the runs the server last reported (null if not connected).
//     controller.toggle(feature, facts?)       the owner's button for 'dashboard' or 'switches': Stop when the page
//                                               polls it (POST /api/runs/stop), else Start (POST /api/runs/start).
//                                               Resolves { stopped } or { started, paused, unavailable, note }:
//                                               `paused` while a recording or scan runs (it starts when that ends).
//     controller.afterOutputTestStart(facts?)  a test is running: start whatever the page is not polling so the dials
//                                               and the tiles refresh (the owner's Start, as the buttons were pressed
//                                               before); nothing while a recording or scan holds the line
//     controller.runs                          the last runs the server reported
//     `facts?` is { connected, unlock }; without it the ones of the last sync are used.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionState = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FEATURES = ['dashboard', 'switches'];

  const names = (list, pick = (x) => x) => (list ?? []).map(pick).sort();

  function decide({ connected, unlock, runs, ui = {} }) {
    const actions = [];
    const poll = (feature, on) => { if (!!ui[feature] !== on) actions.push({ type: 'poll', feature, on }); };
    if (!connected || (runs && !runs.connected)) {
      for (const f of FEATURES) poll(f, false);
      return actions;
    }
    if (!runs) return actions; // ask the server first
    if (runs.exclusive) {
      for (const f of FEATURES) poll(f, false);
      return actions;
    }
    const running = new Set(names(runs.running, (r) => r.feature));
    const stopped = new Set(runs.stoppedByOwner);
    const unlocked = unlock === 'unlocked';
    const wanted = { dashboard: true, switches: unlocked };
    if (FEATURES.some((f) => wanted[f] && !running.has(f) && !stopped.has(f))) actions.push({ type: 'reconcile' });
    poll('dashboard', running.has('dashboard'));
    poll('switches', running.has('switches') && unlocked);
    return actions;
  }

  /** What a reconcile asked for depends on: the unlock, what the server runs, what the owner stopped and what waits. */
  const signature = ({ unlock, runs }) => JSON.stringify([
    unlock, runs.exclusive, names(runs.running, (r) => r.feature), names(runs.stoppedByOwner), names(runs.waiting, (w) => w.feature),
  ]);

  function createPlanner() {
    let asked = null; // the signature of the facts the last reconcile was asked for
    return {
      plan(facts) {
        if (!facts.connected) asked = null;
        return decide(facts).filter((a) => {
          if (a.type !== 'reconcile') return true;
          const sig = signature(facts);
          if (sig === asked) return false;
          asked = sig;
          return true;
        });
      },
    };
  }

  function createController({ api, ui }) {
    const planner = createPlanner();
    let facts = { connected: false, unlock: 'unavailable' };
    let runs = null;
    let chain = Promise.resolve();
    const serial = (fn) => {
      const result = chain.then(fn);
      chain = result.catch(() => {});
      return result;
    };
    const uiFacts = () => ({ dashboard: ui.polling('dashboard'), switches: ui.polling('switches') });
    const take = (answer) => { if (answer?.runs) runs = answer.runs; return answer; };
    const remember = (next) => { if (next) facts = { connected: !!next.connected, unlock: next.unlock }; };

    /** Plan on what the server last said, do it, and plan again on what it answered, until there is nothing left to do. */
    async function settle() {
      for (let round = 0; round < 3; round++) {
        const actions = planner.plan({ ...facts, runs, ui: uiFacts() });
        let reconciled = false;
        for (const a of actions) {
          if (a.type === 'poll') ui.setPolling(a.feature, a.on);
          else if (a.type === 'reconcile') {
            reconciled = true;
            try { take(await api('POST', '/api/runs/reconcile')); } catch { /* cannot start now: the next sync tries again when the facts change */ }
          }
        }
        if (!reconciled) break;
      }
    }

    const refresh = async () => { runs = await api('GET', '/api/runs'); };

    return {
      get runs() { return runs; },

      sync(next) {
        return serial(async () => {
          remember(next);
          if (!facts.connected) {
            runs = null;
            await settle();
            return null;
          }
          await refresh();
          await settle();
          return runs;
        });
      },

      toggle(feature, next) {
        if (!FEATURES.includes(feature)) throw new Error(`feature must be one of: ${FEATURES.join(', ')}`);
        return serial(async () => {
          remember(next);
          if (ui.polling(feature)) {
            take(await api('POST', '/api/runs/stop', { feature }));
            await settle();
            return { stopped: true };
          }
          const r = take(await api('POST', '/api/runs/start', { feature }));
          await settle();
          return { started: r.started, paused: !!r.paused, unavailable: !!r.unavailable, note: r.note };
        });
      },

      afterOutputTestStart(next) {
        return serial(async () => {
          remember(next);
          await refresh();
          if (runs.exclusive) return;
          for (const feature of FEATURES) {
            if (ui.polling(feature)) continue;
            take(await api('POST', '/api/runs/start', { feature }));
          }
          await settle();
        });
      },
    };
  }

  return { decide, createPlanner, createController, FEATURES };
}));
