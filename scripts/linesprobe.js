'use strict';
// DTR/RTS lines test: the tool's own wake-up (src/wakeup.js) under every
// DTR/RTS combination. Some KKL cables use these control lines internally
// (receiver enable / K-L switching).
//
//   node scripts/linesprobe.js [port] [slowTries]      slowTries default 3
//
// For each combination whose echo is clean: slow init to the bike's address
// (0x33 on the 2012 Daytona 675, which answers only about one try in three, so
// it gets `slowTries` tries), then the fast-init pulses (baud and break) to the
// bike's fast addresses and one generic one. This bike never answers fast init;
// the fast rows are for the other ECUs of the family.
// Read-only: only wake patterns, ~KB2 and StartCommunication (81).
const { runProbe, openTransport, checkPower, wake, hex, preciseClock: clock } = require('../src/probekit');
const { attemptOrder } = require('../src/wakeup');

const lineStates = [true, false].flatMap((dtr) => [true, false].map((rts) => ({ dtr, rts })));
const pulses = [{ initMode: 'baud' }, { initMode: 'break' }];
const order = attemptOrder({ targets: [0x11] });
const slowAttempts = order.filter((a) => a.kind === 'slow');
const fastAttempts = order.filter((a) => a.kind === 'fast');

const h = (n) => n.toString(16);
const verdict = (r) => (r.answered ? 'ECU ANSWERED, key bytes ' + hex(r.keyBytes) + '   <=== ANSWERED' : 'silent' + (r.heard.length ? ' (heard ' + hex(r.heard) + ')' : ''));

runProbe(async ({ port, args }) => {
  const tries = Number(args[0]) || 3;
  let answered = false;
  for (const lines of lineStates) {
    const t = await openTransport(port, lines);
    try {
      await clock.sleep(300); // let the cable settle after a control-line change
      const tag = `DTR=${lines.dtr ? 'on ' : 'off'} RTS=${lines.rts ? 'on ' : 'off'}`;
      const power = await checkPower(t);
      if (power.verdict !== 'ok') {
        console.log(`${tag}: no clean echo (${hex(power.heard)}) - cable TX/RX disabled in this state`);
        continue;
      }
      for (const a of slowAttempts) {
        const r = await wake(t, a, { tries });
        const where = `${tag} slow init ${h(a.address)} (${r.tries} ${r.tries === 1 ? 'try' : 'tries'})`;
        console.log(`${where.padEnd(44)} ${verdict(r)}`);
        if (r.answered) answered = true;
      }
      for (const pulse of pulses) {
        for (const a of fastAttempts) {
          const r = await wake(t, a, { ...pulse, p3: 0 });
          const where = `${tag} ${pulse.initMode} target ${h(a.target)} ${a.addrMode}`;
          console.log(`${where.padEnd(44)} ${verdict(r)}`);
          if (r.answered) {
            answered = true;
            await r.session.stop().catch(() => {});
          }
        }
      }
    } finally {
      await t.close();
    }
    await clock.sleep(500);
  }
  console.log(answered ? '\nAt least one combination got an answer (see above).' : '\nNo combination answered.');
}, { open: false });
