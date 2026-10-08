// The page's fuel map accumulator: a table of engine speed (rows) against throttle or manifold pressure
// (columns) in which each cell holds the average of the chosen value seen there.
//
// A plain script for the page (it sets the global `FuelMap`) that also works with require() in Node.
// No DOM and no drawing: it takes graph series as GraphStore keeps them ({ key: [[t, value], ...] }, t in
// ms on one clock) and answers cell values and where the engine is; the page paints them.
//
// Interface (everything a caller must know):
//
//   const map = FuelMap.create({ key = 'injPulse1', axis = 'tps', flow = 0 });
//       key   what each cell averages: a series key, or one of the two derived metrics
//             'injDuty' (injector duty cycle, % = pulse ms x rpm / 1200: a cylinder injects once per two turns) and
//             'injFlow' (estimated fuel flow of all three cylinders, cc/min = duty / 100 x flow x 3), both worked
//             out from the injection pulse of cylinder 1 ('injPulse1') and the engine speed
//       axis  'tps' (throttle, %) or 'map' (manifold pressure, hPa) across the top; anything else means 'tps'
//       flow  the size of one injector in cc/min; 'injFlow' collects nothing while it is 0
//   map.ingest(series)   adds the points of the map's value that are newer than the last one it saw (`map.seen`).
//                        A point counts only if the engine speed and the axis value are known for it (the newest
//                        point at or before it, not older than MAX_AGE) and the engine runs (rpm >= MIN_RPM).
//                        It lands in the cell nearest to its rpm row and axis column. Engine speed is the ECU's
//                        own (`rpmId`) when there is any, else the OBD one (`rpm`).
//   map.skipSeen(series) everything so far counts as seen: only newer points will be added ("Clear map")
//   map.values(fill)     the R x C grid of { v, n, filled } (null where there is no data); with `fill`, empty cells
//                        within two cells of data take a distance-weighted average of their neighbours
//                        ({ v, n: 0, filled: true })
//   map.count            samples added; map.rows / map.cols: the speed and axis values of the grid
//   FuelMap.crosshair(series, at, axis)
//                        where the engine is at time `at`: { rpm, value, row, col, rowFrac, colFrac } (the nearest
//                        cell and the fractional position on the axes for the crosshair), or null if unknown
//   FuelMap.range(grid)  { lo, hi } of the values in a grid ({ lo: Infinity, hi: -Infinity } when it is empty)
//   FuelMap.color(f, alpha)  the map's blue-purple-red-orange scale for f in 0..1 as an rgba() string
//   FuelMap.derive(key, pulseMs, rpm, flow)  the value a point of metric `key` adds, or null if it cannot
//   FuelMap.nearest(arr, v), FuelMap.frac(arr, v), FuelMap.lookup(pts, t)   the helpers behind these
//   FuelMap.METRICS      the metrics the page offers: { key, unit, derived }
//   FuelMap.RPM, FuelMap.AXES, FuelMap.MIN_RPM, FuelMap.MAX_AGE, FuelMap.STOPS   the tables

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FuelMap = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RPM = Array.from({ length: 29 }, (_, i) => i * 500); // 0 .. 14000
  const TPS = [0, 0.7, 1.5, 2.9, 4.4, 5.9, 7.4, 8.8, 11.8, 14.7, 22.1, 29.4, 36.8, 44.1, 51.5, 58.9, 66.2, 73.6, 81, 88.3, 100];
  const MAP = [150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150]; // hPa
  // What goes across the top: throttle (like a tuning program's map) or manifold pressure (a load-based map). Same number of columns.
  const AXES = {
    tps: { key: 'tps', cols: TPS, label: 'Throttle position (%)', short: 'throttle', unit: '%' },
    map: { key: 'map', cols: MAP, label: 'Manifold pressure (hPa)', short: 'manifold pressure', unit: 'hPa' },
  };
  const MIN_RPM = 400; // below this the engine is cranking or stopped: not part of the map
  const MAX_AGE = 6000; // the speed and throttle of a sample are the newest ones within this many ms
  const STOPS = [[0, [31, 111, 229]], [0.4, [91, 63, 216]], [0.65, [176, 47, 192]], [0.85, [226, 65, 47]], [1, [242, 162, 42]]];
  const METRICS = [
    { key: 'injPulse1', unit: 'ms', derived: false },
    { key: 'injDuty', unit: '%', derived: true },
    { key: 'injFlow', unit: 'cc/min', derived: true },
    { key: 'injPulse2', unit: 'ms', derived: false },
    { key: 'injPulse3', unit: 'ms', derived: false },
    { key: 'ignTiming1', unit: '°', derived: false },
    { key: 'trim', unit: '%', derived: false },
    { key: 'map', unit: 'hPa', derived: false },
    { key: 'load', unit: '%', derived: false },
  ];
  const isDerived = (key) => key === 'injDuty' || key === 'injFlow';

  /** Index of the entry of `arr` nearest to v. */
  function nearest(arr, v) {
    let best = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
    return best;
  }

  /** Fractional index of v on `arr` (where to put the crosshair), clamped to the ends. */
  function frac(arr, v) {
    if (v <= arr[0]) return 0;
    for (let i = 1; i < arr.length; i++) if (v <= arr[i]) return i - 1 + (v - arr[i - 1]) / (arr[i] - arr[i - 1]);
    return arr.length - 1;
  }

  /** The newest value of a point list at or before t, if it is not older than MAX_AGE. */
  function lookup(pts, t) {
    if (!pts?.length) return null;
    let lo = 0, hi = pts.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at < 0 || t - pts[at][0] > MAX_AGE ? null : pts[at][1];
  }

  const rpmOf = (series) => (series.rpmId?.length ? series.rpmId : series.rpm);

  /** What one point of metric `key` adds to a cell: the value itself, or the duty / flow worked out from the pulse; null if it cannot be. */
  function derive(key, pulse, rpm, flow) {
    if (!isDerived(key)) return pulse;
    const duty = pulse * rpm / 1200;
    if (key === 'injDuty') return duty;
    return flow ? duty / 100 * flow * 3 : null;
  }

  function color(f, alpha = 1) {
    const x = Math.min(1, Math.max(0, f));
    let k = 1;
    while (k < STOPS.length - 1 && x > STOPS[k][0]) k++;
    const [a, ca] = STOPS[k - 1], [b, cb] = STOPS[k];
    const u = (x - a) / (b - a);
    const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * u));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  function range(grid) {
    let lo = Infinity, hi = -Infinity;
    for (const row of grid) for (const q of row) if (q) { lo = Math.min(lo, q.v); hi = Math.max(hi, q.v); }
    return { lo, hi };
  }

  function crosshair(series, at, axis) {
    const ax = AXES[axis] ?? AXES.tps;
    const rpm = lookup(rpmOf(series), at), value = lookup(series[ax.key], at);
    if (rpm === null || value === null) return null;
    return {
      rpm, value,
      row: nearest(RPM, rpm), col: nearest(ax.cols, value),
      rowFrac: frac(RPM, rpm), colFrac: frac(ax.cols, value),
    };
  }

  function create({ key = 'injPulse1', axis = 'tps', flow = 0 } = {}) {
    const ax = AXES[axis] ?? AXES.tps;
    const R = RPM.length, C = ax.cols.length;
    // The series the metric is read from: the derived ones come from the injection pulse of cylinder 1.
    const sourceKey = isDerived(key) ? 'injPulse1' : key;
    const sum = new Float64Array(R * C);
    const n = new Uint32Array(R * C);
    const map = {
      key, axis: ax.key, flow, rows: RPM, cols: ax.cols, count: 0, seen: -1,

      ingest(series) {
        const pts = series[sourceKey];
        if (!pts?.length) return;
        const rpmPts = rpmOf(series), axisPts = series[ax.key];
        for (const [t, v] of pts) {
          if (t <= map.seen) continue;
          const rpm = lookup(rpmPts, t), at = lookup(axisPts, t);
          if (rpm === null || at === null || rpm < MIN_RPM) continue;
          const value = derive(key, v, rpm, flow);
          if (value === null) continue;
          const i = nearest(RPM, rpm) * C + nearest(ax.cols, at);
          sum[i] += value;
          n[i]++;
          map.count++;
        }
        map.seen = pts[pts.length - 1][0];
      },

      skipSeen(series) {
        const pts = series[sourceKey];
        map.seen = pts?.length ? pts[pts.length - 1][0] : -1;
      },

      values(fill) {
        const avg = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => (n[r * C + c] ? { v: sum[r * C + c] / n[r * C + c], n: n[r * C + c], filled: false } : null)));
        if (!fill || !map.count) return avg;
        const out = avg.map((row) => row.slice());
        for (let r = 0; r < R; r++) {
          for (let c = 0; c < C; c++) {
            if (avg[r][c]) continue;
            let sw = 0, sv = 0;
            for (let dr = -2; dr <= 2; dr++) {
              for (let dc = -2; dc <= 2; dc++) {
                const q = avg[r + dr]?.[c + dc];
                if (!q) continue;
                const wgt = 1 / (dr * dr + dc * dc);
                sw += wgt; sv += wgt * q.v;
              }
            }
            if (sw) out[r][c] = { v: sv / sw, n: 0, filled: true };
          }
        }
        return out;
      },
    };
    return map;
  }

  return { create, crosshair, range, color, derive, nearest, frac, lookup, rpmOf, METRICS, RPM, AXES, MIN_RPM, MAX_AGE, STOPS };
}));
