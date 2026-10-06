'use strict';
// Wiring check for a multimeter: toggles the K-line between LOW and HIGH in
// 10-second blocks for one minute. Back-probe pin 7 (K-line) to pin 4 (GND)
// on the bike's connector while this runs: the meter should swing between
// ~0 V (LOW) and ~11 V (HIGH). If it sits at ~11 V the whole time, the cable
// is not driving the bike's pin 7.
const { runProbe, preciseClock: clock } = require('../src/probekit');

runProbe(async ({ t }) => {
  try {
    for (let cycle = 1; cycle <= 3; cycle++) {
      await t.setBreak(true);
      console.log(`[${cycle}/3] K-line held LOW  for 10 s  -> meter should read ~0 V`);
      await clock.sleep(10000);
      await t.setBreak(false);
      console.log(`[${cycle}/3] K-line released HIGH for 10 s -> meter should read ~11 V`);
      await clock.sleep(10000);
    }
  } finally {
    await t.setBreak(false).catch(() => {});
  }
  console.log('done, line released');
}, { power: false });
