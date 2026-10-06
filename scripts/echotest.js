'use strict';
// K-line health check, no ECU needed.
// The cable's TX and RX both sit on the K-line, and the line is pulled up to
// battery voltage THROUGH THE BIKE. If we hear our own bytes echoed back, the
// cable is plugged into a powered connector and the switch position is right.
// Silence means: no 12V on the connector, wrong switch position, or not plugged in.
//
//   node scripts/echotest.js [port]          echo check
//   node scripts/echotest.js [port] pulse    also check the wake-up pulses electrically
//
// Pulse check, baud trick: at 360 baud a 0x00 byte holds the line low 25 ms, so
// its echo should be 0x00 arriving ~25-50 ms after the write (a clone chip that
// can't really do 360 baud returns garbage or odd timing). Break: a 25 ms
// break reaches the wire if the receiver sees a 0x00 (the driver may drop the
// framing-error byte, which makes that inconclusive).
const { runProbe, checkPower, captureTimed, hex, preciseClock: clock } = require('../src/probekit');

const timed = (got) => `echo: ${hex(got.map((g) => g.b))}  timing: ${got.map((g) => Math.round(g.at) + 'ms').join(', ') || '-'}`;

runProbe(async ({ t, args }) => {
  const { verdict, sent, heard } = await checkPower(t);
  console.log(`sent:     ${hex(sent)}`);
  console.log(`received: ${hex(heard)}`);
  if (verdict === 'ok') {
    console.log("ECHO OK - K-line is powered and the switch position is correct. The ECU just isn't answering.");
  } else if (verdict === 'none') {
    console.log('NO ECHO - the K-line is dead from where the cable sits. Ignition off, wrong switch position, or connector has no 12V.');
  } else {
    console.log('PARTIAL/GARBLED ECHO - noisy line or marginal connection.');
  }
  if (args[0] !== 'pulse') return;

  console.log('\n--- 360-baud pulse test ---');
  await t.flushInput();
  await t.setBaud(360);
  const t0 = clock.now();
  await t.write([0x00]);
  const got = await captureTimed(t, 200, { clock, from: t0 });
  console.log(timed(got));
  console.log(
    got.length === 1 && got[0].b === 0x00 && got[0].at >= 20 && got[0].at <= 80
      ? 'PULSE OK: the 25 ms low pulse is really on the wire.'
      : 'PULSE SUSPECT: echo should be a single 0x00 arriving ~25-50 ms after write.'
  );
  await t.setBaud(10400);

  console.log('\n--- break pulse test ---');
  await t.flushInput();
  const t1 = clock.now();
  await t.setBreak(true);
  await clock.sleep(25);
  await t.setBreak(false);
  const got2 = await captureTimed(t, 200, { clock, from: t1 });
  console.log(timed(got2));
  console.log(got2.length ? 'Break reaches the wire.' : 'No echo from break: driver may suppress framing-error bytes (inconclusive), or break not supported.');
}, { power: false });
