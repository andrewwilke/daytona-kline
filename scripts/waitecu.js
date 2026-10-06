'use strict';
// Catches an ECU that only answers now and then. Keeps cycling through the
// wake-up methods at a relaxed pace until one gets a reply, and restarts the
// cycle whenever the K-line comes alive (key switched on) so the first seconds
// after power-up are covered. Turn the key off and on while it runs.
//
//   node scripts/waitecu.js [port] [seconds]     default 150 s
//
// This bike (2012 Daytona 675) never answers fast init but answers slow init to
// 0x33 about one try in three, so the cycle is: fast init to D5/F5 (the tool's
// fast wake-up, expected silent), slow init to 0x33 (the one that works), fast
// again, slow init to 0xD5 (expected silent). Use obd9141.js for the full
// session once the ECU has answered.
// Read-only: only wake patterns, the ~KB2 acknowledgement and StartCommunication.
const { runProbe, checkPower, slowHandshake, wake, hex, preciseClock: clock } = require('../src/probekit');
const { SLOW_IDLE_MS } = require('../src/wakeup');

const h = (n) => n.toString(16);

// Each method says how long the bus is left idle before it (the power check just
// before already touched the line); a fresh ECU gets `firstIdleMs` to boot.
const fast = {
  name: 'fast init D5/F5',
  idleMs: 2500,
  firstIdleMs: 1000,
  async run(t) {
    const r = await wake(t, { target: 0xd5, source: 0xf5, addrMode: 'phys' }, { initMode: 'baud' });
    if (r.answered) {
      await r.session.stop().catch(() => {});
      return { answered: true, detail: `StartCommunication answered, key bytes ${hex(r.keyBytes)}` };
    }
    return { answered: false, detail: `silent${r.heard.length ? ' (heard ' + hex(r.heard) + ')' : ''}` };
  },
};

const slow = (addr) => ({
  name: `slow init 0x${h(addr)}`,
  idleMs: SLOW_IDLE_MS, // the ECU ignores an address that follows less than 3 s of idle
  async run(t) {
    // idleMs 0: the loop below already waited
    const r = await slowHandshake(t, addr, { idleMs: 0 });
    if (!r.sync) {
      return { answered: r.heard.length > 0, detail: r.heard.length ? `heard ${hex(r.heard)} but no 55 sync + key bytes` : 'silent' };
    }
    return {
      answered: true,
      detail: `SYNC 55, KB1 ${h(r.sync.kb1)} KB2 ${h(r.sync.kb2)}; sent ~KB2 ${h(r.ack)}, echo ${r.echoed ? 'ok' : 'missing'}, then ${r.reply === null ? '(nothing)' : h(r.reply)} (expect ${h(~addr & 0xff)})`,
    };
  },
});

const methods = [fast, slow(0x33), fast, slow(0xd5)];

runProbe(async ({ t, args }) => {
  const seconds = Number(args[0]) || 150;
  const t0 = clock.now();
  const stamp = () => `[${Math.round((clock.now() - t0) / 1000).toString().padStart(3)}s]`;
  console.log(`Listening for ${seconds} s. Turn the key OFF for ~5 s and back ON at any point.\n`);

  let alive = null;
  let turn = 0;
  while (clock.now() - t0 < seconds * 1000) {
    const power = await checkPower(t, { ms: 200 });
    const nowAlive = power.verdict === 'ok';
    if (nowAlive !== alive) {
      console.log(`${stamp()} K-line ${nowAlive ? 'ALIVE (ECU powered)' : 'DEAD (key off, or cable unplugged)'}`);
      alive = nowAlive;
      turn = 0;
    }
    if (!alive) {
      await clock.sleep(400);
      continue;
    }
    const m = methods[turn % methods.length];
    await clock.sleep(turn === 0 ? m.firstIdleMs ?? m.idleMs : m.idleMs);
    turn++;
    const r = await m.run(t);
    console.log(`${stamp()} ${m.name.padEnd(18)} ${r.answered ? '<=== ' : ''}${r.detail}`);
    if (r.answered) {
      console.log('\nGot an answer. Everything above is what to compare with TuneECU.');
      return;
    }
  }
  console.log('\nNothing answered in that time.');
}, { power: false });
