'use strict';
// Slow init as a timing experiment: the address byte at 5 baud, bit-banged with
// the break line, then the 0x55 sync, key bytes and ~KB2 acknowledgement. Shows
// how far setTimeout overshoots here, then runs the same init with bit edges
// placed by a busy-wait (what the tool does, 196 ms bits), with the nominal 200
// ms bit time, and with plain sleeps between edges (what a Windows timer gives
// you), each up to `tries` times.
//
//   node scripts/slowinit.js [port] [address] [tries]    address default 0x33, tries default 3
//
// On this bike (2012 Daytona 675) the 0x33 init works but the ECU answers only
// about one try in three, so a variant that fails once proves nothing: judge a
// variant by the try it answered on, and give it several. The first try of a
// variant waits 3 s of bus idle, the next ones 6 s. Passing another address
// (11, 12, 10) probes an ECU that is not this bike's.
// Read-only: only the address byte and the ~KB2 acknowledgement are sent. For the
// whole session after the handshake use obd9141.js.
const { runProbe, slowHandshake, timerAccuracy, hex } = require('../src/probekit');
const { SLOW_IDLE_MS, SLOW_RETRY_MS } = require('../src/wakeup');

const variants = [
  { label: 'precise, 196 ms bits (the tool)', bitMs: 196, precise: true },
  { label: 'precise, 200 ms bits (nominal)', bitMs: 200, precise: true },
  { label: 'sleeps,  196 ms bits (Windows timer)', bitMs: 196, precise: false },
];

const h = (n) => n.toString(16);

runProbe(async ({ t, args }) => {
  const addr = args[0] ? parseInt(args[0], 16) : 0x33;
  const tries = args[1] ? parseInt(args[1], 10) : 3;

  console.log('--- timer accuracy ---');
  for (const ms of [25, 200]) {
    console.log(`sleep(${ms}) actually took: ${(await timerAccuracy(ms)).map((x) => x.toFixed(1)).join(', ')} ms`);
  }

  console.log(`\n--- slow init to 0x${h(addr)}, up to ${tries} tries per variant ---`);
  let first = true;
  for (const v of variants) {
    const r = await slowHandshake(t, addr, { ...v, tries, idleMs: first ? SLOW_IDLE_MS : SLOW_RETRY_MS });
    first = false;
    const edges = r.edgeError != null ? ` (worst edge error ${r.edgeError.toFixed(1)} ms)` : '';
    if (!r.sync) {
      console.log(`${v.label.padEnd(36)} no sync in ${r.tries} tries${edges}${r.heard.length ? `; last try heard ${hex(r.heard)}  <-- ECU sent something` : ''}`);
      continue;
    }
    console.log(`${v.label.padEnd(36)} SYNC + KEY BYTES on try ${r.tries}/${tries} (KB1 ${h(r.sync.kb1)} KB2 ${h(r.sync.kb2)})${edges}  <===`);
    console.log(`   sent ~KB2 ${h(r.ack)}, echo ${r.echoed ? 'ok' : 'missing'}, ECU then said ${r.reply === null ? '(nothing)' : h(r.reply)} (expect ~addr ${h(~addr & 0xff)})${r.completed ? '' : '  <-- handshake not completed'}`);
  }
});
