'use strict';

/**
 * Time source used by the protocol stack. Anything that waits (idle time,
 * P3 spacing, settle delays) goes through a clock so tests can swap in one
 * that advances instantly.
 *
 * A clock may also offer `waitUntil(at)`, which resolves at clock time `at`
 * to within about a millisecond. Use the module-level waitUntil() below: it
 * falls back to sleep() on clocks that do not.
 */

// setTimeout can overshoot by a full timer tick (~16 ms on Windows), so the
// last stretch of a precise wait is a busy-wait.
const SPIN_MS = 30;

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitUntil(at) {
    const coarse = at - SPIN_MS - Date.now();
    if (coarse > 0) await realClock.sleep(coarse);
    while (Date.now() < at) { /* busy-wait */ }
  },
};

/** Wait until `clock` reads `at` (precisely, where the clock can). Returns at once if it already does. */
async function waitUntil(clock, at) {
  if (clock.waitUntil) await clock.waitUntil(at);
  else if (at > clock.now()) await clock.sleep(at - clock.now());
}

module.exports = { realClock, waitUntil };
