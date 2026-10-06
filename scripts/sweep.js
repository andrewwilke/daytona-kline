'use strict';
// Wake-up sweep, stopping at the first thing the ECU answers. Each attempt is
// the tool's own wake-up (src/wakeup.js), so a variant that stays silent here
// would also stay silent in `scan`.
//
//   node scripts/sweep.js [port] [slowTries]      slowTries default 6
//
// 1. Slow init to the bike's addresses first (0x33 on the 2012 Daytona 675),
//    up to `slowTries` times each with the tool's spacing: the ECU answers
//    only about one try in three, so a single silent try means nothing.
// 2. Then every fast-init pulse variant (break high-times and the baud trick)
//    against the bike's fast addresses and generic ones. This bike never
//    answers any of these; they are for the other ECUs of the family.
// Read-only: only wake patterns, ~KB2, StartCommunication (81) and StopCommunication (82).
const { runProbe, wake, hex } = require('../src/probekit');
const { attemptOrder } = require('../src/wakeup');

const order = attemptOrder({ targets: [0x11, 0x12, 0x10] });
const slowAttempts = order.filter((a) => a.kind === 'slow');
const fastAttempts = order.filter((a) => a.kind === 'fast');
const pulses = [
  ...[0, 10, 20, 25, 35].map((highMs) => ({ initMode: 'break', highMs })),
  { initMode: 'baud' },
];

const h = (n) => '0x' + n.toString(16);

runProbe(async ({ t, args }) => {
  const tries = Number(args[0]) || 6;

  for (const a of slowAttempts) {
    const label = `slow init ${h(a.address)}`;
    const r = await wake(t, a, {
      tries,
      onTry: (n, of, previous) => {
        if (previous) console.log(`  try ${n - 1}/${of}: ${previous.message}`);
        console.log(`${label}, try ${n}/${of} ...`);
      },
    });
    if (r.answered) {
      console.log(`ANSWERED  ${label} on try ${r.tries}  key bytes ${hex(r.keyBytes)}`);
      return;
    }
    console.log(`  try ${r.tries}/${tries}: ${r.error.message}`);
    console.log(`no answer ${label} in ${r.tries} tries${r.heard.length ? '  (heard: ' + hex(r.heard) + ')' : ''}`);
  }

  for (const pulse of pulses) {
    for (const a of fastAttempts) {
      const label = `${pulse.initMode}${pulse.highMs != null ? ' high=' + pulse.highMs + 'ms' : ''}  target ${h(a.target)} ${a.addrMode}`;
      const r = await wake(t, a, { ...pulse, p3: 0 });
      if (r.answered) {
        console.log(`ANSWERED  ${label}  key bytes ${hex(r.keyBytes)}`);
        await r.session.stop().catch(() => {});
        return;
      }
      console.log(`no answer ${label}${r.heard.length ? '  (heard: ' + hex(r.heard) + ')' : ''}`);
    }
  }
  console.log('\nNothing answered on any combination.');
});
