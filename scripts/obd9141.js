'use strict';
// The verified end-to-end session with this bike (2012 Daytona 675): slow init
// to 0x33 with retries, the acknowledgement inside the W4 window, then standard
// read-only OBD-II requests in ISO 9141-2 framing (68 6A F1 ... checksum),
// printing every raw byte. Independent of the tool's reply parser, so it shows
// what the ECU really sends when `scan` or `dtc` misbehave.
//
//   node scripts/obd9141.js [port] [address] [tries]    address default 0x33, tries default 8
//
// The ECU answers only about one slow init in three; the tool and TuneECU retry
// every ~6 s, the first try after 3 s of bus idle. The break line gives garbage
// bytes on receive (the kit flushes them); our own bytes are echoed on RX.
// Replies have no length byte: one ends when the bytes stop (60 ms gap).
// Silence for modes 07 and 09 means unsupported, and service 22 draws a
// refusal (7F 33 36: security access needed), neither is an error.
//
// Read-only: the address byte, ~KB2, and OBD modes 01, 03, 07, 09 and
// readDataByCommonIdentifier (22). Never mode 04 (clear codes).
const { runProbe, slowHandshake, withChecksum, waitUntil, hex, preciseClock: clock } = require('../src/probekit');

async function readUntilGap(t, firstMs, gapMs) {
  const out = [];
  let b = await t.readByte(firstMs);
  while (b !== null) {
    out.push(b);
    b = await t.readByte(gapMs);
  }
  return out;
}

async function obd(t, data, { firstMs = 300, gapMs = 60 } = {}) {
  await waitUntil(clock, clock.now() + 60); // P3
  await t.flushInput();
  const frame = withChecksum([0x68, 0x6a, 0xf1, ...data]);
  await t.write(frame);
  const heard = await readUntilGap(t, firstMs, gapMs);
  const echoed = frame.every((x, i) => heard[i] === x);
  const resp = echoed ? heard.slice(frame.length) : heard;
  return { frame, echoed, resp };
}

const h = (n) => n.toString(16);
const failure = (r) => (r.heard.length ? `heard ${hex(r.heard)} but no 55 sync + key bytes` : 'silent');

runProbe(async ({ t, args }) => {
  const addr = args[0] ? parseInt(args[0], 16) : 0x33;
  const tries = args[1] ? parseInt(args[1], 10) : 8;
  const r = await slowHandshake(t, addr, {
    tries,
    onTry: (n, of, last) => {
      if (last) console.log(`  failed: ${failure(last)}`);
      console.log(`slow init to 0x${h(addr)} (try ${n}/${of}) ...`);
    },
  });
  if (!r.sync) {
    console.log(`  failed: ${failure(r)}`);
    console.log('No handshake in any try.');
    return;
  }
  console.log(`sync 55, KB1 ${h(r.sync.kb1)} KB2 ${h(r.sync.kb2)}; ack ${h(r.ack)} echo ${r.echoed ? h(r.ack) : '-'}; ECU said ${r.reply === null ? '(nothing)' : h(r.reply)} (expect ${h(~addr & 0xff)})\n`);
  if (r.sync.kb2 !== 0x08) console.log('KB2 is not 08: frames below use the OBD-II header anyway, answers may be absent.\n');

  const requests = [
    ['mode 01 PID 00  supported PIDs', [0x01, 0x00]],
    ['mode 01 PID 01  monitor status', [0x01, 0x01]],
    ['mode 03         stored codes', [0x03]],
    ['mode 07         pending codes', [0x07]],
    ['mode 09 PID 00  info supported', [0x09, 0x00]],
    ['22 0100         rpm id', [0x22, 0x01, 0x00]],
    ['22 0001         throttle id', [0x22, 0x00, 0x01]],
    ['22 0009         coolant id', [0x22, 0x00, 0x09]],
  ];
  for (const [label, data] of requests) {
    const q = await obd(t, data);
    console.log(`${label.padEnd(34)} tx ${hex(q.frame)}`);
    console.log(`${''.padEnd(34)} ${q.echoed ? 'echo ok, ' : 'NO CLEAN ECHO, '}reply: ${hex(q.resp)}`);
  }
});
