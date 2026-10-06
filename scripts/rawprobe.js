'use strict';
// Raw capture of FAST-init variants and other odd handshakes the tool does not
// use, each recording EVERY byte that comes back (our own echo included) so
// "ECU silent" can be told apart from "ECU answered but the parser rejected it".
// The 2012 Daytona 675 is silent on every row here (fast init never answered on
// it; it wakes by slow init, see slowinit.js and obd9141.js): the rows are for
// the other ECUs of the family, and a silent run on this bike is the expected
// result, not a cable fault. The first row replays the tool's own fast-init
// wake-up by hand, so a hit in the other rows can be compared with it; for the
// tool's exact wake-up use sweep.js.
// Read-only: only wake patterns and StartCommunication-style requests.
//
//   node scripts/rawprobe.js [port] [section...]
//
// Sections (default: all but listen): pulses, headers, honda, offsets, listen.
const { runProbe, baudPulse, breakPulse, buildFrame, withChecksum, capture, reportHeard, hex, preciseClock: clock } = require('../src/probekit');

const TRIUMPH = { fmt: 0x80, target: 0xd5, source: 0xf5 };
const startComm = ({ fmt, target, source = 0xf1 }) => buildFrame(fmt, target, source, [0x81]);

// Each row: a pulse (how to wake) and the request that follows it.
const pulses = [
  { label: 'tool wake: 200 ms low + baud pulse, D5/F5', baud: { idleMs: 320, preLowMs: 200, switchAtMs: 'echo' }, req: startComm(TRIUMPH) },
  { label: 'baud pulse, no pre-low, D5/F5', baud: { switchAtMs: 'echo' }, req: startComm(TRIUMPH) },
  ...[[0x80, 0x11], [0xc0, 0x33], [0x80, 0x12], [0x80, 0x10]].map(([fmt, target]) => ({
    label: `baud pulse, fmt ${fmt.toString(16)} target ${target.toString(16)}`,
    baud: { switchAtMs: 'echo' },
    req: startComm({ fmt, target }),
  })),
  { label: 'break pulse 25/25, D5/F5', brk: { lowMs: 25, highMs: 25 }, req: startComm(TRIUMPH) },
];

const headers = [
  ['no-address header  01 81', withChecksum([0x01, 0x81])],
  ['addr 11 src f0', withChecksum([0x81, 0x11, 0xf0, 0x81])],
  ['addr 11 src fe', withChecksum([0x81, 0x11, 0xfe, 0x81])],
  ['addr 11 src 01', withChecksum([0x81, 0x11, 0x01, 0x81])],
  ['addr 12 src f1 (Suzuki style)', withChecksum([0x81, 0x12, 0xf1, 0x81])],
  ['addr 11 tester-present only', withChecksum([0x81, 0x11, 0xf1, 0x3e])],
].map(([label, req]) => ({ label, baud: {}, req }));

// Honda/Keihin style: 70 ms low, 130 ms high, wake bytes, then a request with a two's-complement checksum.
const honda = [0x72, 0x73].map((addr) => ({
  label: `honda init to ${addr.toString(16)}`,
  brk: { lowMs: 70, highMs: 130 },
  wake: [0xfe, 0x04, 0xff, 0xff],
  req: withChecksum([addr, 0x05, 0x00, 0xf0], { twosComplement: true }),
}));

// Where after the pulse StartCommunication goes out (USB adds an unknown 0-2 ms).
const offsets = [];
for (let readyAtMs = 47; readyAtMs <= 58; readyAtMs++) {
  for (const [fmt, target] of [[0x80, 0x11], [0xc0, 0x33]]) {
    offsets.push({ label: `StartComm at +${readyAtMs}ms fmt ${fmt.toString(16)} tgt ${target.toString(16)}`, baud: { switchAtMs: 30, readyAtMs }, req: startComm({ fmt, target }) });
  }
}

const sections = { pulses, headers, honda, offsets };

async function run(t, row) {
  if (row.baud) await baudPulse(t, row.baud);
  else await breakPulse(t, row.brk);
  if (row.wake) {
    await t.write(row.wake);
    await clock.sleep(200);
    await t.flushInput();
  }
  await t.write(row.req);
  const heard = await capture(t, 700);
  reportHeard(`${row.label}  [${hex(row.req)}]`, row.req, heard);
}

runProbe(async ({ t, args }) => {
  const wanted = args.length ? args : ['pulses', 'headers', 'honda', 'offsets'];
  for (const name of wanted) {
    if (name === 'listen') {
      console.log('\n--- passive listen 3 s (any chatter on the line?) ---');
      await t.setBaud(10400);
      await t.flushInput();
      console.log(`heard: ${hex(await capture(t, 3000))}`);
    } else if (sections[name]) {
      console.log(`\n--- ${name} ---`);
      for (const row of sections[name]) await run(t, row);
    } else {
      console.log(`unknown section "${name}"`);
    }
  }
});
