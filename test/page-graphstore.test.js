'use strict';

// The page's graph store (public/js/graphstore.js), loaded with require() the way the page loads it as a script:
// the re-basing of run time onto the page clock, the cursors, a new run, the window and the replay.

const { test } = require('node:test');
const assert = require('node:assert');
const GraphStore = require('../public/js/graphstore');

/** A store on a clock the test moves by hand. */
function storeAt(start = 100_000, options = {}) {
  const clock = { t: start };
  const store = GraphStore.create({ now: () => clock.t, ...options });
  return { store, clock };
}

test('points are re-based onto the page clock: page time = now - elapsed + t', () => {
  const { store, clock } = storeAt(100_000);
  assert.equal(store.ingest('gauges', { rpm: [[0, 1000], [200, 1100]], tps: [[100, 5]] }, 300), true);
  assert.deepEqual(store.live.series.rpm, [[99_700, 1000], [99_900, 1100]]);
  assert.deepEqual(store.live.series.tps, [[99_800, 5]]);

  clock.t = 100_500; // 500 ms later the run is 800 ms old: the same run time lands on the same page time
  store.ingest('gauges', { rpm: [[300, 1200]] }, 800);
  assert.deepEqual(store.live.series.rpm.map((p) => p[0]), [99_700, 99_900, 100_000]);
});

test('the cursor is the newest run time seen, per source, and starts at -1', () => {
  const { store } = storeAt();
  assert.equal(store.since('gauges'), -1);
  assert.equal(store.since('record'), -1);
  store.ingest('gauges', { rpm: [[0, 1], [150, 2]], tps: [[400, 3]] }, 500);
  assert.equal(store.since('gauges'), 400, 'the newest t of any channel');
  assert.equal(store.since('record'), -1, 'another source has its own cursor');
  store.ingest('gauges', { rpm: [[600, 4]] }, 700);
  assert.equal(store.since('gauges'), 600);
});

test('a run that starts over (elapsed goes back) resets the cursor, and what it brought is left for the next poll', () => {
  const { store, clock } = storeAt();
  store.ingest('gauges', { rpm: [[0, 1], [4000, 2]] }, 4100);
  assert.equal(store.since('gauges'), 4000);
  const before = store.live.series.rpm.length;

  clock.t += 1000;
  assert.equal(store.ingest('gauges', { rpm: [[10, 9]] }, 50), false, 'the answer of a new run was cut at the old cursor: not taken');
  assert.equal(store.since('gauges'), -1, 'the next poll asks for everything');
  assert.equal(store.live.series.rpm.length, before, 'nothing of it was added');

  assert.equal(store.ingest('gauges', { rpm: [[10, 9], [60, 8]] }, 100), true);
  assert.equal(store.since('gauges'), 60);
  assert.equal(store.live.series.rpm.length, before + 2, 'the earlier run stays in the store');
});

test('resetCursor: a run is about to start, and its first answer is taken (not mistaken for a new run)', () => {
  const { store } = storeAt();
  store.ingest('record', { rpm: [[0, 1], [90_000, 2]] }, 90_100);
  store.resetCursor('record');
  assert.equal(store.since('record'), -1);
  assert.equal(store.ingest('record', { rpm: [[0, 5]] }, 600), true);
  assert.equal(store.since('record'), 0);
});

test('nothing is taken without a series or an elapsed time', () => {
  const { store } = storeAt();
  assert.equal(store.ingest('gauges', undefined, 100), false);
  assert.equal(store.ingest('gauges', { rpm: [[0, 1]] }, undefined), false);
  assert.equal(store.ingest('gauges', { rpm: [[0, 1]] }, null), false);
  assert.deepEqual(store.live.series, {});
  assert.equal(store.since('gauges'), -1);
});

test('points older than the keep time are dropped; newer ones stay in order', () => {
  const { store, clock } = storeAt(1_000_000, { keepMs: 10_000 });
  store.ingest('gauges', { rpm: [[0, 1], [1000, 2], [5000, 3]] }, 5000);
  assert.equal(store.live.series.rpm.length, 3);
  clock.t += 8000; // the first point is now 13 s old, the second 12 s, the last 8 s
  store.ingest('gauges', { rpm: [[5500, 4]] }, 5500 + 8000 - 500);
  assert.deepEqual(store.live.series.rpm.map((p) => p[1]), [3, 4]);
});

test('the recorder\'s events and notes become marks on the page clock; a replay\'s stay on its own', () => {
  const { store } = storeAt(50_000);
  store.setMarks({ elapsedMs: 10_000, events: [{ t_ms: 2000, text: 'engine stopped' }], markers: [{ t_ms: 9000, text: 'Died' }] });
  assert.deepEqual(store.live.marks, [
    { t: 42_000, text: 'engine stopped', kind: 'ev' },
    { t: 49_000, text: 'Died', kind: 'mk' },
  ]);
  store.setMarks({ events: [], markers: [] }); // no elapsed time: left alone
  assert.equal(store.live.marks.length, 2);

  const replay = store.openReplay({ name: 'record-x.csv', durationMs: 5000, series: { rpm: [[0, 1], [5000, 2]] }, events: [{ t_ms: 1000, text: 'fuel pump ON' }], markers: [{ t_ms: 2000, text: 'Started' }] });
  assert.equal(store.replay, replay);
  assert.deepEqual(replay.marks, [{ t: 1000, text: 'fuel pump ON', kind: 'ev' }, { t: 2000, text: 'Started', kind: 'mk' }]);
  assert.equal(store.source(), replay);
  assert.equal(store.live.marks.length, 2, 'the live store is untouched');
  store.closeReplay();
  assert.equal(store.replay, null);
  assert.equal(store.source(), store.live);
});

test('view: live and following now it is the window up to now; 0 means all there is (at least a second)', () => {
  const { store, clock } = storeAt(100_000);
  assert.equal(store.view({ windowMs: 60_000 }), null, 'nothing to show yet');
  store.ingest('gauges', { rpm: [[0, 1], [20_000, 2]] }, 20_000); // page times 80_000 .. 100_000
  assert.deepEqual(store.view({ windowMs: 30_000 }), { t0: 70_000, t1: 100_000 });
  assert.deepEqual(store.view({ windowMs: 0 }), { t0: 80_000, t1: 100_000 });
  clock.t = 130_000;
  assert.deepEqual(store.view({ windowMs: 0 }), { t0: 110_000, t1: 130_000 }, 'the span is what the data covers, ending at now');
  const one = storeAt(5000);
  one.store.ingest('gauges', { rpm: [[0, 1]] }, 0);
  assert.deepEqual(one.store.view({ windowMs: 0 }), { t0: 4000, t1: 5000 });
});

test('view: paused it is placed inside the data by the slider, newest at 1000; a window longer than the data shows all of it', () => {
  const { store, clock } = storeAt(200_000);
  store.ingest('gauges', { rpm: [[0, 1], [100_000, 2]] }, 100_000); // page times 100_000 .. 200_000
  clock.t = 999_999; // paused: now does not matter
  assert.deepEqual(store.view({ windowMs: 30_000, paused: true, scrub: 1000 }), { t0: 170_000, t1: 200_000 });
  assert.deepEqual(store.view({ windowMs: 30_000, paused: true, scrub: 0 }), { t0: 100_000, t1: 130_000 });
  assert.deepEqual(store.view({ windowMs: 30_000, paused: true, scrub: 500 }), { t0: 135_000, t1: 165_000 });
  assert.deepEqual(store.view({ windowMs: 0, paused: true, scrub: 300 }), { t0: 100_000, t1: 200_000 }, 'all: the slider has nothing to slide');
  assert.deepEqual(store.view({ windowMs: 300_000, paused: true, scrub: 0 }), { t0: 100_000, t1: 200_000 });
});

test('view: a saved recording is always placed by the slider, in its own time, whatever the window or the clock', () => {
  const { store } = storeAt(777);
  store.openReplay({ name: 'r.csv', durationMs: 60_000, series: { rpm: [[0, 1], [60_000, 2]], tps: [[1000, 3]] }, events: [], markers: [] });
  assert.deepEqual(store.view({ windowMs: 0, paused: false, scrub: 1000 }), { t0: 0, t1: 60_000 });
  assert.deepEqual(store.view({ windowMs: 10_000, paused: false, scrub: 1000 }), { t0: 50_000, t1: 60_000 });
  assert.deepEqual(store.view({ windowMs: 10_000, paused: false, scrub: 0 }), { t0: 0, t1: 10_000 });
  store.closeReplay();
  assert.equal(store.view({ windowMs: 10_000 }), null, 'back to live: nothing fed yet');
});

test('laneSeries: the lane\'s channels that have points; only the first for a "first" lane; the replay when one is open', () => {
  const { store } = storeAt();
  store.ingest('gauges', { rpm: [[0, 3000]], injPulse1: [[0, 2]], injPulse3: [[0, 2.1]] }, 100);
  const inj = { keys: ['injPulse1', 'injPulse2', 'injPulse3'] };
  assert.deepEqual(store.laneSeries(inj).map((s) => s.key), ['injPulse1', 'injPulse3'], 'no points for cylinder 2: no line');
  const speed = { keys: ['rpmId', 'rpm'], first: true };
  assert.deepEqual(store.laneSeries(speed).map((s) => s.key), ['rpm']);
  store.ingest('gauges', { rpmId: [[50, 3100]] }, 100);
  assert.deepEqual(store.laneSeries(speed).map((s) => s.key), ['rpmId'], 'the ECU\'s own speed wins when there is any');
  assert.deepEqual(store.laneSeries({ keys: ['battery'] }), []);

  store.openReplay({ name: 'r.csv', durationMs: 1, series: { battery: [[0, 12.5]] }, events: [], markers: [] });
  assert.deepEqual(store.laneSeries({ keys: ['battery'] }), [{ key: 'battery', pts: [[0, 12.5]] }]);
  assert.deepEqual(store.laneSeries(speed), [], 'the live points are not mixed into a replay');
});

test('latest: the newest live point among alternative channels (the first wins a tie), with its points', () => {
  const { store } = storeAt(100_000);
  assert.equal(store.latest(['rpmId', 'rpm']), null);
  store.ingest('gauges', { rpm: [[0, 900], [500, 950]] }, 1000);
  assert.deepEqual(store.latest(['rpmId', 'rpm']), { key: 'rpm', pts: store.live.series.rpm, t: 99_500, v: 950 });
  store.ingest('gauges', { rpmId: [[200, 1000]] }, 1000); // older than the OBD one
  assert.equal(store.latest(['rpmId', 'rpm']).key, 'rpm');
  store.ingest('gauges', { rpmId: [[500, 1010]] }, 1000); // same moment: the first key listed
  assert.equal(store.latest(['rpmId', 'rpm']).key, 'rpmId');
  assert.equal(store.latest(['rpmId', 'rpm']).v, 1010);
  store.openReplay({ name: 'r.csv', durationMs: 1, series: { battery: [[0, 12]] }, events: [], markers: [] });
  assert.equal(store.latest(['battery']), null, 'the vitals are always the live ones');
});

test('valueAt: the newest point at or before t', () => {
  const pts = [[10, 'a'], [20, 'b'], [30, 'c']];
  assert.equal(GraphStore.valueAt(pts, 5), null);
  assert.deepEqual(GraphStore.valueAt(pts, 10), [10, 'a']);
  assert.deepEqual(GraphStore.valueAt(pts, 29.9), [20, 'b']);
  assert.deepEqual(GraphStore.valueAt(pts, 1000), [30, 'c']);
  assert.equal(GraphStore.valueAt([], 5), null);
});
