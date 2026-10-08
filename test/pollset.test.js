'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  pollset, PollSet,
  GAUGE_STRIKES, SWITCH_STRIKES, SILENT_STRIKES, ROTATING_STRIKES, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES,
} = require('../src/pollset');

// No ECU here: a fake `read(key, cycle)` says what each item returns (a value, or null for silence), and a
// small driver does what a sampler does: plan, read the batch, report each outcome.
const item = (key, extra = {}) => ({ key, pid: null, gated: false, ...extra });
const ctxOf = (cycle, errors = []) => ({ cycle, error: (e) => errors.push(e.message) });

/** Run one cycle: every-cycle items first, then `turns` rotating ones. Returns the keys read, in order. */
async function cycle(set, read, n, { turns = 1, errors } = {}) {
  const plan = await set.plan(null, ctxOf(n, errors));
  const batch = [...plan.every, ...plan.turns(turns)];
  for (const it of batch) set.report(it.key, read(it.key, n));
  return batch.map((it) => it.key);
}

const never = () => null;

test('the thresholds are named constants, one place, with the numbers the samplers always used', () => {
  assert.deepEqual(
    [GAUGE_STRIKES, SWITCH_STRIKES, SILENT_STRIKES, ROTATING_STRIKES, DEMOTE_STRIKES, SUPPORTED_RETRY_CYCLES],
    [3, 6, 3, 2, 3, 10],
  );
});

test('an item that never answers is dropped after its threshold, and not before; the others carry on', async () => {
  const set = pollset({ items: [item('a'), item('ghost')], every: ['a', 'ghost'], dropAfter: { every: 3 } });
  const read = (key) => (key === 'ghost' ? null : 1);
  for (let n = 0; n < 2; n++) await cycle(set, read, n);
  assert.deepEqual(set.view().unsupported, [], 'two silent reads are not enough');
  assert.deepEqual(set.view().served, ['a', 'ghost']);
  assert.deepEqual(await cycle(set, read, 2), ['a', 'ghost'], 'it is still asked in the cycle that gives it up');
  assert.deepEqual(set.view().unsupported, ['ghost'], 'the third silent read in a row');
  assert.deepEqual(set.view().served, ['a']);
  assert.deepEqual(await cycle(set, read, 3), ['a'], 'and it is not asked again');
});

test('the threshold belongs to the item group: every-cycle and rotating items can differ', async () => {
  const set = pollset({
    items: [item('fast'), item('slow')],
    every: ['fast'],
    dropAfter: { every: 3, rotation: 2 },
  });
  for (let n = 0; n < 2; n++) await cycle(set, never, n);
  assert.deepEqual(set.view().unsupported, ['slow'], 'a rotating item: two reads (it was asked in both cycles)');
  await cycle(set, never, 2);
  assert.deepEqual(set.view().unsupported, ['slow', 'fast'], 'an every-cycle item: three reads');
});

test('with no threshold given an item is never dropped', async () => {
  const set = pollset({ items: [item('a')], every: ['a'] });
  for (let n = 0; n < 50; n++) await cycle(set, never, n);
  assert.deepEqual(set.view().unsupported, []);
});

test('strikes are counted per item; one that has answered is never dropped', async () => {
  const set = pollset({ items: [item('a')], every: ['a'], dropAfter: { every: 3 } });
  set.report('a', null);
  set.report('a', null);
  assert.deepEqual(set.view().unsupported, []);
  set.report('a', 7); // it answered: from now on it is never dropped
  for (let n = 0; n < 10; n++) set.report('a', null);
  assert.deepEqual(set.view().unsupported, []);
  assert.deepEqual(set.view().stale, ['a']);
});

test('an item that answered once is never dropped, but is marked stale while it is silent and keeps its last value', async () => {
  const set = pollset({ items: [item('a'), item('b')], every: ['a', 'b'], dropAfter: { every: 2 } });
  await cycle(set, (key, n) => ({ key, n }), 0);
  assert.deepEqual(set.view().stale, []);
  const first = set.view().values.a;
  for (let n = 1; n <= 20; n++) await cycle(set, (key) => (key === 'a' ? null : { key, n }), n);
  const view = set.view();
  assert.deepEqual(view.unsupported, [], 'however long the ECU is silent on it');
  assert.deepEqual(view.stale, ['a']);
  assert.strictEqual(view.values.a, first, 'its last value, as it was reported');
  assert.strictEqual(set.value('a'), first);
  assert.equal(view.values.b.n, 20);
  assert.deepEqual(view.served, ['a', 'b']);

  await cycle(set, (key, n) => ({ key, n }), 21);
  assert.deepEqual(set.view().stale, [], 'live again once it answers');
  assert.equal(set.value('a').n, 21);
});

test('a value is stored as it is reported, and an item that never answered has none', async () => {
  const set = pollset({ items: [item(0x41), item(0x60)], every: [0x41, 0x60] });
  const row = { id: 0x41, value: 254 };
  await cycle(set, (key) => (key === 0x41 ? row : null), 0);
  assert.strictEqual(set.value(0x41), row);
  assert.equal(set.value(0x60), undefined);
  assert.equal(set.value('no such item'), undefined);
  assert.deepEqual(Object.keys(set.view().values), ['65'], 'keys can be numbers (ids)');
});

test('refuse: the item is unsupported at once, even one that answered before', async () => {
  const set = pollset({ items: [item('a'), item('b')], every: ['a', 'b'], dropAfter: { every: 3 } });
  await cycle(set, () => 5, 0);
  set.refuse('a');
  set.refuse('a');
  assert.deepEqual(set.view().unsupported, ['a'], 'once, in the order dropped');
  assert.equal(set.value('a'), 5, 'it keeps its last value');
  assert.deepEqual(await cycle(set, () => 5, 1), ['b']);
});

test('demotion: an every-cycle item that answered and then goes silent moves to the rotation, and back when it answers', async () => {
  const set = pollset({
    items: [item('pump'), item('lamp'), item('x'), item('y')],
    every: ['pump', 'lamp'],
    rotation: ['x', 'y'],
    dropAfter: { every: 3, rotation: 2 },
    demoteAfter: 3,
  });
  let lampOn = true;
  const read = (key) => (key === 'lamp' && !lampOn ? null : key);
  await cycle(set, read, 0, { turns: 0 });
  lampOn = false;
  for (let n = 1; n <= 2; n++) await cycle(set, read, n, { turns: 0 });
  assert.deepEqual(set.view().demoted, [], 'two silent reads: still every cycle');
  assert.deepEqual((await set.plan(null, ctxOf(3))).every.map((i) => i.key), ['pump', 'lamp']);
  await cycle(set, read, 3, { turns: 0 });
  assert.deepEqual(set.view().demoted, ['lamp'], 'three in a row');
  assert.deepEqual(set.view().unsupported, [], 'it answered once: never dropped');

  const plan = await set.plan(null, ctxOf(4));
  assert.deepEqual(plan.every.map((i) => i.key), ['pump'], 'no longer read every cycle');
  assert.deepEqual(plan.turns(3).map((i) => i.key), ['x', 'y', 'lamp'], 'it waits at the end of the rotation');

  for (let n = 5; n < 12; n++) await cycle(set, read, n, { turns: 3 });
  assert.deepEqual(set.view().demoted, ['lamp'], 'silent in the rotation: still there, not dropped');

  lampOn = true;
  await cycle(set, read, 12, { turns: 3 });
  assert.deepEqual(set.view().demoted, [], 'it answered in the rotation');
  assert.deepEqual((await set.plan(null, ctxOf(13))).every.map((i) => i.key), ['pump', 'lamp'], 'every cycle again');
});

test('demotion starts counting from zero again, so a demoted item that stays silent is not demoted twice', async () => {
  const set = pollset({ items: [item('a'), item('r')], every: ['a'], rotation: ['r'], demoteAfter: 2 });
  await cycle(set, () => 1, 0, { turns: 0 });
  for (let n = 1; n <= 2; n++) await cycle(set, never, n, { turns: 0 });
  assert.deepEqual(set.view().demoted, ['a']);
  set.report('a', null);
  set.report('a', null);
  set.report('a', null);
  assert.deepEqual(set.view().demoted, ['a'], 'one entry');
});

test('a rotating item is never demoted, only an every-cycle one', async () => {
  const set = pollset({ items: [item('r')], rotation: ['r'], demoteAfter: 2, dropAfter: { rotation: 5 } });
  await cycle(set, () => 1, 0);
  for (let n = 1; n < 10; n++) await cycle(set, never, n);
  assert.deepEqual(set.view().demoted, []);
  assert.deepEqual(set.view().stale, ['r']);
});

test('locked items are skipped while the gate is closed, untouched, and picked up by the first plan after it opens', async () => {
  let open = false;
  const items = [item('rpm'), item('battery', { gated: true }), item('gear', { gated: true }), item('map')];
  const set = pollset({ items, every: ['rpm', 'battery'], rotation: ['gear', 'map'], dropAfter: { every: 2, rotation: 2 }, gate: () => open });

  const asked = [];
  const read = (key) => { asked.push(key); return key === 'battery' ? null : 1; };
  for (let n = 0; n < 6; n++) await cycle(set, read, n);
  assert.ok(!asked.includes('battery') && !asked.includes('gear'), 'a locked item is not asked');
  assert.deepEqual(set.view().locked, ['battery', 'gear'], 'in item order');
  assert.deepEqual(set.view().unsupported, [], 'waiting for the unlock is not "not available"');
  assert.deepEqual(set.view().served, ['rpm', 'battery', 'gear', 'map'], 'a locked item is still served in principle');
  assert.deepEqual(asked.filter((k) => k === 'map').length, 6, 'the rotation is only the unlocked items');

  open = true;
  asked.length = 0;
  assert.deepEqual(await cycle(set, read, 6), ['rpm', 'battery', 'gear'], 'picked up mid-run: battery every cycle, gear takes its turn');
  assert.deepEqual(set.view().locked, []);
  assert.deepEqual(await cycle(set, read, 7), ['rpm', 'battery', 'map']);
  assert.deepEqual(set.view().unsupported, ['battery'], 'and from then on the usual strikes count (two silent reads)');
});

test('closing the gate again holds the items back again, and their state is as it was', async () => {
  let open = true;
  const set = pollset({ items: [item('b', { gated: true })], every: ['b'], dropAfter: { every: 3 }, gate: () => open });
  await cycle(set, never, 0);
  await cycle(set, never, 1);
  open = false;
  for (let n = 2; n < 8; n++) assert.deepEqual(await cycle(set, never, n), []);
  assert.deepEqual(set.view().unsupported, []);
  open = true;
  await cycle(set, never, 8);
  assert.deepEqual(set.view().unsupported, ['b'], 'the strikes from before the lock still count (2 + 1)');
});

test('with no gate every item is open, gated or not', async () => {
  const set = pollset({ items: [item('b', { gated: true })], every: ['b'] });
  assert.deepEqual(await cycle(set, () => 1, 0), ['b']);
  assert.deepEqual(set.view().locked, []);
});

test('the rotation serves one item per cycle in turn, in the order given', async () => {
  const set = pollset({ items: [item('f'), item('a'), item('b'), item('c')], every: ['f'], rotation: ['c', 'a', 'b'] });
  const seen = [];
  for (let n = 0; n < 7; n++) seen.push(await cycle(set, () => 1, n));
  assert.deepEqual(seen, [['f', 'c'], ['f', 'a'], ['f', 'b'], ['f', 'c'], ['f', 'a'], ['f', 'b'], ['f', 'c']]);
});

test('the rotation defaults to the items that are not every-cycle, in item order', async () => {
  const set = pollset({ items: [item('a'), item('f'), item('b')], every: ['f'] });
  const seen = [];
  for (let n = 0; n < 4; n++) seen.push((await cycle(set, () => 1, n)).pop());
  assert.deepEqual(seen, ['a', 'b', 'a', 'b']);
});

test('turns(n) takes n items and moves the rotation on by n; asking for more than there are returns each once', async () => {
  const set = pollset({ items: ['a', 'b', 'c', 'd', 'e'].map((k) => item(k)), rotation: ['a', 'b', 'c', 'd', 'e'] });
  const plan = await set.plan(null, ctxOf(0));
  assert.deepEqual(plan.turns(2).map((i) => i.key), ['a', 'b']);
  assert.deepEqual(plan.turns(2).map((i) => i.key), ['c', 'd']);
  assert.deepEqual(plan.turns(2).map((i) => i.key), ['e', 'a']);
  assert.deepEqual((await set.plan(null, ctxOf(1))).turns(9).map((i) => i.key), ['b', 'c', 'd', 'e', 'a']);
});

test('a cycle that does not ask for its turn leaves the rotation where it was', async () => {
  const set = pollset({ items: [item('a'), item('b')], rotation: ['a', 'b'] });
  assert.deepEqual((await set.plan(null, ctxOf(0))).turns(1).map((i) => i.key), ['a']);
  await set.plan(null, ctxOf(1)); // a slow cycle: no turns() call
  assert.deepEqual((await set.plan(null, ctxOf(2))).turns(1).map((i) => i.key), ['b']);
});

test('dropped items leave the rotation and the others keep taking turns', async () => {
  const set = pollset({ items: [item('a'), item('ghost'), item('b')], rotation: ['a', 'ghost', 'b'], dropAfter: { rotation: 1 } });
  const read = (key) => (key === 'ghost' ? null : 1);
  const seen = [];
  for (let n = 0; n < 6; n++) seen.push((await cycle(set, read, n)).join());
  assert.deepEqual(seen, ['a', 'ghost', 'a', 'b', 'a', 'b']);
});

test('an empty rotation gives no turns, and an empty set is fine', async () => {
  const set = pollset({ items: [item('f')], every: ['f'] });
  assert.deepEqual(await cycle(set, () => 1, 0), ['f']);
  const none = new PollSet();
  const plan = await none.plan(null, ctxOf(0));
  assert.deepEqual([plan.every, plan.turns(1), plan.locked], [[], [], []]);
  assert.deepEqual(none.view(), { values: {}, unsupported: [], stale: [], demoted: [], locked: [], served: [], supported: null });
});

test('a plan is a snapshot: what the reports of this cycle change takes effect in the next plan', async () => {
  const set = pollset({ items: [item('a'), item('b')], every: ['a', 'b'], dropAfter: { every: 1 } });
  const plan = await set.plan(null, ctxOf(0));
  set.report('a', null);
  assert.deepEqual(plan.every.map((i) => i.key), ['a', 'b'], 'the batch in hand does not change');
  assert.deepEqual((await set.plan(null, ctxOf(1))).every.map((i) => i.key), ['b']);
});

test('the items come back as the caller gave them, and the set does not touch them', async () => {
  const mine = { key: 'a', pid: null, gated: false, def: { label: 'A' } };
  const before = JSON.stringify(mine);
  const set = pollset({ items: [mine], every: ['a'], dropAfter: { every: 1 } });
  const plan = await set.plan(null, ctxOf(0));
  assert.strictEqual(plan.every[0], mine);
  set.report('a', null);
  assert.equal(JSON.stringify(mine), before);
});

test('the supported-PID bootstrap marks the PIDs the ECU does not list, once, and leaves ids alone', async () => {
  let calls = 0;
  const set = pollset({
    items: [item('rpm', { pid: 0x0c }), item('timing', { pid: 0x0e }), item('battery', { gated: true }), item('tps', { pid: 0x11 })],
    every: ['rpm', 'tps'],
    gate: () => true,
    listSupported: async () => { calls++; return new Set([0x0c, 0x11]); },
  });
  assert.equal(set.view().supported, null, 'nothing before the first plan');
  const plan = await set.plan('the session', ctxOf(0));
  assert.deepEqual(set.view().unsupported, ['timing']);
  assert.deepEqual([...set.view().supported], [0x0c, 0x11]);
  assert.deepEqual(plan.every.map((i) => i.key), ['rpm', 'tps']);
  assert.deepEqual(plan.turns(5).map((i) => i.key), ['battery'], 'the unlisted PID is not in the rotation, the id is');
  await set.plan('the session', ctxOf(1));
  assert.equal(calls, 1, 'read once');
});

test('the bootstrap is given the session', async () => {
  let got;
  const set = pollset({ items: [], listSupported: async (session) => { got = session; return new Set(); } });
  await set.plan('S', ctxOf(0));
  assert.equal(got, 'S');
});

test('a failed bootstrap with no retry setting fails the plan, marks nothing, and is asked again next cycle', async () => {
  let fail = true;
  let calls = 0;
  const set = pollset({
    items: [item('rpm', { pid: 0x0c }), item('timing', { pid: 0x0e })],
    every: ['rpm', 'timing'],
    listSupported: async () => { calls++; if (fail) throw new Error('no answer to PID 00'); return new Set([0x0c]); },
  });
  await assert.rejects(() => set.plan(null, ctxOf(0)), /no answer to PID 00/);
  await assert.rejects(() => set.plan(null, ctxOf(1)), /no answer to PID 00/);
  assert.equal(calls, 2, 'every cycle');
  assert.deepEqual(set.view().unsupported, [], 'nothing is marked on a dead link');
  assert.equal(set.view().supported, null);
  fail = false;
  await set.plan(null, ctxOf(2));
  assert.deepEqual(set.view().unsupported, ['timing']);
});

test('a failed bootstrap with a retry setting is an error of the cycle, which carries on; it is tried again only after that many cycles', async () => {
  let fail = true;
  const set = pollset({
    items: [item('rpm', { pid: 0x0c }), item('timing', { pid: 0x0e })],
    every: ['rpm', 'timing'],
    listSupported: async () => { if (fail) throw new Error('silent'); return new Set([0x0c]); },
    supportedRetryCycles: 4,
  });
  const errors = [];
  const plan0 = await set.plan(null, ctxOf(0, errors));
  assert.deepEqual(errors, ['silent'], 'reported through ctx.error, not thrown');
  assert.deepEqual(plan0.every.map((i) => i.key), ['rpm', 'timing'], 'the cycle goes on without the list');
  assert.equal(set.view().supported, null);

  fail = false; // the ECU would answer now, but it is not asked until cycle 4
  for (let n = 1; n <= 3; n++) await set.plan(null, ctxOf(n, errors));
  assert.equal(set.view().supported, null, "cycles 1-3: not asked yet");
  assert.deepEqual(set.view().unsupported, []);
  await set.plan(null, ctxOf(4, errors));
  assert.deepEqual(set.view().unsupported, ['timing'], 'asked again 4 cycles after the failure');
  assert.deepEqual(errors, ['silent'], 'no further error');
});

test('the retry is counted from the cycle of the failure, and every failure waits again', async () => {
  const set = pollset({
    items: [item('rpm', { pid: 0x0c })],
    listSupported: async () => { throw new Error('silent'); },
    supportedRetryCycles: SUPPORTED_RETRY_CYCLES,
  });
  const failedIn = [];
  for (let n = 0; n < 25; n++) {
    await set.plan(null, { cycle: n, error: () => failedIn.push(n) });
  }
  assert.deepEqual(failedIn, [0, 10, 20]);
});

test('duplicate keys, keys that are not items and an item in both groups are refused', () => {
  assert.throws(() => pollset({ items: [item('a'), item('a')] }), /twice/);
  assert.throws(() => pollset({ items: [item('a')], every: ['b'] }), /no item "b"/);
  assert.throws(() => pollset({ items: [item('a')], every: ['a'], rotation: ['a'] }), /both every cycle and in turn/);
  const set = pollset({ items: [item('a')] });
  assert.throws(() => set.report('nope', 1), /no item "nope"/);
  assert.throws(() => set.refuse('nope'), /no item "nope"/);
});

test('view() is plain data: changing what it returned does not change the set', async () => {
  const set = pollset({ items: [item('a')], every: ['a'] });
  await cycle(set, () => 1, 0);
  const view = set.view();
  view.values.a = 99;
  view.unsupported.push('a');
  view.served.length = 0;
  assert.equal(set.value('a'), 1);
  assert.deepEqual(set.view().unsupported, []);
  assert.deepEqual(set.view().served, ['a']);
});
