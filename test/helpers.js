'use strict';

const { MockEcuTransport } = require('./mockecu');
const { tryWakeUp } = require('../src/wakeup');
const { defineBike } = require('../src/bikes');

/**
 * A bike whose ECU takes fast init only (the wake-up order the tool used
 * before slow init): for tests of the addressed protocol style, which should
 * not sit through the real bike's slow-init tries first.
 */
const FAST_BIKE = defineBike({
  id: 'fast-only-test-bike',
  name: 'Fast-init test bike',
  dataBlockId: 0x80,
  diagSession: 0x80,
  wake: {
    attempts: [
      { target: 0xd5, source: 0xf5, addrMode: 'phys' },
      { target: 0x33, addrMode: 'func' },
    ],
  },
});

/**
 * A mock ECU plus a session woken the proper way at `attempt`: its own address
 * by fast init, or for an `iso9141` mock a slow init to its address.
 */
async function awakeSession(mockOptions = {}, attempt = {}) {
  const t = new MockEcuTransport(mockOptions);
  const own = t.iso9141 ? { kind: 'slow', address: t.address } : { target: t.target, addrMode: t.funcOnly ? 'func' : 'phys' };
  const { session } = await tryWakeUp(t, { ...own, ...attempt }, { clock: t.clock });
  return { t, session };
}

/** Collect the first byte of `tx:` frames sent at normal speed, as [target, fmt]. */
const frameTargets = (t) =>
  t.events.filter((e) => e.type === 'write' && e.baud === 10400).map((e) => ({ fmt: e.bytes[0], target: e.bytes[1], source: e.bytes[2] }));

module.exports = { awakeSession, frameTargets, FAST_BIKE };
