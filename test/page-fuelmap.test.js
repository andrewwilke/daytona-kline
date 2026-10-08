'use strict';

// The page's fuel map accumulator (public/js/fuelmap.js), loaded with require() the way the page loads it as a script:
// nearest-bin accumulation, the derived duty and flow metrics, filling gaps, the crosshair and the axes.

const { test } = require('node:test');
const assert = require('node:assert');
const FuelMap = require('../public/js/fuelmap');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const rowOf = (rpm) => FuelMap.RPM.indexOf(rpm);
const colOf = (axis, v) => FuelMap.AXES[axis].cols.indexOf(v);

/** Series with the engine speed, throttle and injection pulse each sampled at the same moments: [t, rpm, tps, pulse]. */
function series(rows, extra = {}) {
  return {
    rpm: rows.map(([t, rpm]) => [t, rpm]),
    tps: rows.map(([t, , tps]) => [t, tps]),
    injPulse1: rows.map(([t, , , pulse]) => [t, pulse]),
    ...extra,
  };
}

test('a sample lands in the cell nearest to its speed and throttle, and a cell is the average of what landed in it', () => {
  const map = FuelMap.create();
  map.ingest(series([
    [0, 3010, 29, 2.0], // nearest speed 3000, nearest throttle 29.4
    [100, 2900, 30, 4.0], // 3000 again, 29.4 again
    [200, 3300, 29.4, 6.0], // 3500 row
  ]));
  const grid = map.values(false);
  const cell = grid[rowOf(3000)][colOf('tps', 29.4)];
  assert.deepEqual([cell.v, cell.n, cell.filled], [3, 2, false]);
  assert.deepEqual(grid[rowOf(3500)][colOf('tps', 29.4)], { v: 6, n: 1, filled: false });
  assert.equal(map.count, 3);
  assert.equal(grid.flat().filter(Boolean).length, 2, 'every other cell is empty');
  assert.equal(grid.length, 29);
  assert.equal(grid[0].length, 21);
});

test('only newer points are added when more arrive; the same points twice count once', () => {
  const map = FuelMap.create();
  const s = series([[0, 3000, 29.4, 2], [100, 3000, 29.4, 4]]);
  map.ingest(s);
  map.ingest(s);
  assert.equal(map.count, 2);
  assert.equal(map.seen, 100);
  const more = series([[0, 3000, 29.4, 2], [100, 3000, 29.4, 4], [200, 3000, 29.4, 6]]);
  map.ingest(more);
  assert.equal(map.count, 3);
  const cell = map.values(false)[rowOf(3000)][colOf('tps', 29.4)];
  assert.deepEqual([cell.v, cell.n], [4, 3]);
});

test('a cranking or stopped engine (below 400 rpm) is not part of the map; 400 is', () => {
  const map = FuelMap.create();
  map.ingest(series([[0, 399, 10, 2], [100, 0, 0, 1], [200, 400, 10, 3]]));
  assert.equal(map.count, 1);
  const cell = map.values(false)[rowOf(500)][colOf('tps', 8.8)]; // 400 rpm is nearest to the 500 row, 10 % to the 8.8 column
  assert.deepEqual([cell.v, cell.n], [3, 1]);
});

test('a sample needs engine speed and throttle that are known and not older than 6 s', () => {
  const map = FuelMap.create();
  map.ingest({ rpm: [[0, 3000]], tps: [[0, 20]], injPulse1: [[6000, 2], [6001, 3]] });
  assert.equal(map.count, 1, 'exactly 6000 ms old still counts, 6001 does not');
  const noTps = FuelMap.create();
  noTps.ingest({ rpm: [[0, 3000]], injPulse1: [[10, 2]] });
  assert.equal(noTps.count, 0);
  const before = FuelMap.create();
  before.ingest({ rpm: [[50, 3000]], tps: [[50, 20]], injPulse1: [[10, 2]] });
  assert.equal(before.count, 0, 'the speed and throttle of a point are the newest at or before it');
  assert.equal(FuelMap.create().ingest({}), undefined, 'no series, no problem');
});

test('the ECU\'s own engine speed is used when there is any, else the OBD one', () => {
  const both = FuelMap.create();
  both.ingest(series([[0, 3000, 29.4, 2]], { rpmId: [[0, 6000]] }));
  assert.ok(both.values(false)[rowOf(6000)][colOf('tps', 29.4)], 'rpmId decided the row');
  assert.equal(both.values(false)[rowOf(3000)][colOf('tps', 29.4)], null);
  const obd = FuelMap.create();
  obd.ingest(series([[0, 3000, 29.4, 2]], { rpmId: [] }));
  assert.ok(obd.values(false)[rowOf(3000)][colOf('tps', 29.4)]);
});

test('other metrics average their own series (fuel trim here), at the same cells', () => {
  const map = FuelMap.create({ key: 'trim' });
  map.ingest({ rpm: [[0, 2000], [100, 2000]], tps: [[0, 14.7], [100, 14.7]], trim: [[0, 2], [100, -4]] });
  const cell = map.values(false)[rowOf(2000)][colOf('tps', 14.7)];
  assert.deepEqual([cell.v, cell.n], [-1, 2]);
});

test('injector duty cycle is pulse ms x rpm / 1200, in percent', () => {
  near(FuelMap.derive('injDuty', 3, 6000, 0), 15);
  near(FuelMap.derive('injDuty', 2.4, 5000, 0), 10);
  const map = FuelMap.create({ key: 'injDuty' });
  map.ingest(series([[0, 6000, 29.4, 3], [100, 6000, 29.4, 4.5]]));
  const cell = map.values(false)[rowOf(6000)][colOf('tps', 29.4)];
  near(cell.v, (15 + 22.5) / 2);
  assert.equal(cell.n, 2);
});

test('estimated fuel flow is duty / 100 x the injector size x 3 cylinders, and needs the size', () => {
  near(FuelMap.derive('injFlow', 3, 6000, 250), 15 / 100 * 250 * 3); // 112.5 cc/min
  const map = FuelMap.create({ key: 'injFlow', flow: 250 });
  map.ingest(series([[0, 6000, 29.4, 3]]));
  near(map.values(false)[rowOf(6000)][colOf('tps', 29.4)].v, 112.5);

  assert.equal(FuelMap.derive('injFlow', 3, 6000, 0), null, 'no injector size: no flow');
  const noSize = FuelMap.create({ key: 'injFlow' });
  noSize.ingest(series([[0, 6000, 29.4, 3]]));
  assert.equal(noSize.count, 0);
  assert.equal(noSize.flow, 0);
  assert.equal(FuelMap.derive('injPulse1', 3, 6000, 250), 3, 'a plain metric adds the value itself');
});

test('the derived metrics are read from the cylinder 1 pulse, whatever else is in the series', () => {
  const map = FuelMap.create({ key: 'injDuty' });
  map.ingest({ rpm: [[0, 3000]], tps: [[0, 20]], injDuty: [[0, 999]], injPulse1: [[0, 2]] });
  const q = map.values(false).flat().find(Boolean);
  near(q.v, 5); // 2 ms x 3000 / 1200
});

test('manifold pressure can go across the top instead of the throttle; anything else means throttle', () => {
  const map = FuelMap.create({ axis: 'map' });
  assert.equal(map.axis, 'map');
  assert.equal(map.cols, FuelMap.AXES.map.cols);
  map.ingest({ rpm: [[0, 4000]], map: [[0, 1004]], tps: [[0, 50]], injPulse1: [[0, 2]] });
  const cell = map.values(false)[rowOf(4000)][colOf('map', 1000)];
  assert.deepEqual([cell.v, cell.n], [2, 1]);
  assert.equal(FuelMap.AXES.tps.cols.length, FuelMap.AXES.map.cols.length, 'the same number of columns either way');
  assert.equal(FuelMap.create({ axis: 'nonsense' }).axis, 'tps');
});

test('fill gaps: empty cells near data take a distance-weighted average of their neighbours, marked filled, and the rest stay empty', () => {
  const map = FuelMap.create();
  map.ingest(series([[0, 3000, 29.4, 2], [100, 4000, 29.4, 6]]));
  const r3 = rowOf(3000), r4 = rowOf(4000), c = colOf('tps', 29.4);
  const plain = map.values(false);
  assert.equal(plain[rowOf(3500)][c], null);
  const filled = map.values(true);
  assert.deepEqual(filled[r3][c], { v: 2, n: 1, filled: false }, 'real cells are untouched');
  // 3500 is two rows from both: equal weights, the average of 2 and 6
  const mid = filled[rowOf(3500)][c];
  assert.equal(mid.filled, true);
  assert.equal(mid.n, 0);
  near(mid.v, 4);
  // one row above data takes the weight of a single neighbour at distance 1 and one at distance 3 (out of reach): just 2
  near(filled[r3 - 1][c].v, 2);
  assert.equal(filled[r3 - 3][c], null, 'more than two cells from any data stays empty');
  assert.equal(filled[r3][c + 3], null);
  assert.equal(filled[rowOf(3500)][c + 3], null);
  // beside the 3000 cell: it (distance 1, weight 1) and the 4000 cell (two rows and one column away, weight 1/5)
  near(filled[r3][c + 1].v, (2 + 6 / 5) / (1 + 1 / 5));
  assert.equal(map.values(true).flat().filter((q) => q && !q.filled).length, 2);
});

test('fill gaps does nothing for a map with no samples', () => {
  const map = FuelMap.create();
  assert.equal(map.values(true).flat().filter(Boolean).length, 0);
});

test('Clear map: skipSeen makes only newer samples count, for the derived metrics too (they follow the pulse series)', () => {
  for (const key of ['injPulse1', 'injDuty']) {
    const map = FuelMap.create({ key });
    const s = series([[0, 3000, 29.4, 2], [100, 3000, 29.4, 2]]);
    map.skipSeen(s);
    assert.equal(map.seen, 100, key);
    map.ingest(s);
    assert.equal(map.count, 0, `${key}: what was there before does not count`);
    map.ingest(series([[0, 3000, 29.4, 2], [100, 3000, 29.4, 2], [200, 3000, 29.4, 2]]));
    assert.equal(map.count, 1, key);
  }
  const empty = FuelMap.create();
  empty.skipSeen({});
  assert.equal(empty.seen, -1);
});

test('the crosshair: the nearest cell and the fractional position of the engine at a moment', () => {
  const s = { rpm: [[0, 3250], [1000, 6000]], tps: [[0, 25.75], [1000, 100]] };
  const c = FuelMap.crosshair(s, 500, 'tps');
  assert.equal(c.rpm, 3250);
  assert.equal(c.value, 25.75);
  assert.equal(c.row, rowOf(3000), 'a tie between 3000 and 3500 goes to the lower');
  assert.equal(c.col, colOf('tps', 22.1));
  near(c.rowFrac, 6.5);
  near(c.colFrac, 10.5); // half way between 22.1 and 29.4
  const end = FuelMap.crosshair(s, 1000, 'tps');
  assert.deepEqual([end.row, end.col, end.rowFrac, end.colFrac], [rowOf(6000), 20, rowOf(6000), 20]);
  const map = FuelMap.crosshair({ rpm: [[0, 3000]], map: [[0, 120]] }, 0, 'map');
  assert.deepEqual([map.col, map.colFrac], [0, 0], 'below the first column: clamped');
  assert.equal(FuelMap.crosshair({ rpm: [[0, 3000]], map: [[0, 5000]] }, 0, 'map').colFrac, 20, 'above the last: clamped');
});

test('the crosshair needs known speed and axis value no older than 6 s, and uses rpmId when there is any', () => {
  assert.equal(FuelMap.crosshair({ rpm: [[0, 3000]], tps: [[0, 20]] }, 6001, 'tps'), null);
  assert.ok(FuelMap.crosshair({ rpm: [[0, 3000]], tps: [[0, 20]] }, 6000, 'tps'));
  assert.equal(FuelMap.crosshair({ rpm: [[0, 3000]] }, 0, 'tps'), null);
  assert.equal(FuelMap.crosshair({ tps: [[0, 20]] }, 0, 'tps'), null);
  assert.equal(FuelMap.crosshair({ rpm: [[100, 3000]], tps: [[100, 20]] }, 50, 'tps'), null, 'nothing yet at that moment');
  assert.equal(FuelMap.crosshair({ rpm: [[0, 3000]], rpmId: [[0, 7000]], tps: [[0, 20]] }, 0, 'tps').rpm, 7000);
  assert.equal(FuelMap.crosshair({ rpm: [[0, 3000]], tps: [[0, 20]] }, 0, 'nonsense').value, 20, 'an unknown axis is throttle');
});

test('range, colour scale, and the helpers behind them', () => {
  assert.deepEqual(FuelMap.range([[null, { v: 2 }], [{ v: -1 }, { v: 7 }]]), { lo: -1, hi: 7 });
  assert.deepEqual(FuelMap.range([[null]]), { lo: Infinity, hi: -Infinity });
  assert.equal(FuelMap.color(0), 'rgba(31,111,229,1)');
  assert.equal(FuelMap.color(1, 0.5), 'rgba(242,162,42,0.5)');
  assert.equal(FuelMap.color(-3), FuelMap.color(0), 'clamped');
  assert.equal(FuelMap.color(9), FuelMap.color(1));
  assert.equal(FuelMap.nearest([0, 10, 20], 14), 1);
  assert.equal(FuelMap.nearest([0, 10, 20], 15), 1, 'a tie goes to the lower');
  assert.equal(FuelMap.frac([0, 10, 20], -5), 0);
  near(FuelMap.frac([0, 10, 20], 12.5), 1.25);
  assert.equal(FuelMap.frac([0, 10, 20], 99), 2);
  assert.equal(FuelMap.lookup([[0, 'a'], [10, 'b']], 5), 'a');
  assert.equal(FuelMap.lookup([[0, 'a'], [10, 'b']], -1), null);
  assert.equal(FuelMap.lookup([], 0), null);
  assert.equal(FuelMap.lookup(undefined, 0), null);
});

test('the metrics offered: the injection pulses, duty, flow, ignition timing, trim, manifold pressure and load, with their units', () => {
  assert.deepEqual(FuelMap.METRICS.map((m) => m.key), ['injPulse1', 'injDuty', 'injFlow', 'injPulse2', 'injPulse3', 'ignTiming1', 'trim', 'map', 'load']);
  assert.deepEqual(FuelMap.METRICS.filter((m) => m.derived).map((m) => m.key), ['injDuty', 'injFlow']);
  assert.equal(FuelMap.METRICS.find((m) => m.key === 'injFlow').unit, 'cc/min');
});
