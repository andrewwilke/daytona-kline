// The page's graph store: the points every strip chart, the vitals strip and the fuel map are drawn from.
//
// A plain script for the page (it sets the global `GraphStore`) that also works with require() in Node,
// so the tests cross the same interface the page does. No DOM, no network, no timers: the page gives it
// what the server answered and reads back what to draw.
//
// Interface (everything a caller must know):
//
//   const store = GraphStore.create({ now = Date.now, keepMs = 20 min });
//
//   store.since(source)                    the `?since=` for the next poll of 'gauges' or 'record' (-1: send everything)
//   store.ingest(source, series, elapsedMs)
//       Takes one poll's answer: `series` is { key: [[t_ms, value], ...] } with t in ms since that run started and
//       `elapsedMs` how long the run has been going when the answer was made. Points are re-based onto the page's
//       clock (page time = now - elapsedMs + t) so a dashboard run and a recording can share one time axis, appended
//       per channel, and points older than keepMs are dropped. Returns true if points were taken.
//       A run is told to be new by its elapsedMs going back below the last one seen for that source: the cursor
//       is reset to -1 so the next poll brings the whole new run, and this answer is ignored (returns false; it
//       was cut at the old cursor). Points of the earlier run stay in the store. Ignored too: no series, or no elapsedMs.
//   store.resetCursor(source)              a run of that source is about to start: the next poll takes it all, and its
//                                          first answer is taken (not mistaken for a new run)
//   store.setMarks(v)                      the recorder's events and notes (`v.events`, `v.markers` of { t_ms, text },
//                                          `v.elapsedMs`) re-based onto the page clock; replaces the live marks
//   store.live                             { series, marks } of what the page was fed (marks: { t, text, kind: 'ev' | 'mk' })
//   store.openReplay({ name, durationMs, series, events, markers })   a saved recording: its own series and marks, times
//                                          as ms since its start (nothing is re-based)
//   store.closeReplay();  store.replay     the open recording or null
//   store.source()                         the replay if one is open, else live: { series, marks }
//   store.view({ windowMs, paused, scrub })
//       The time range on show, { t0, t1 } in page-clock ms, or null while there is nothing to show. Live and not
//       paused it follows now over `windowMs` (0: everything the store has). Paused, or in a replay, it is placed by
//       `scrub` (0..1000, the slider) inside the data: the newest data at 1000.
//   store.laneSeries(lane)                 [{ key, pts }] of the lane's keys that have points (only the first one when
//                                          `lane.first`) from source()
//   store.latest(keys)                     { key, pts, t, v } for the key of `keys` whose newest live point is newest, or null
//   GraphStore.valueAt(pts, t)             the newest point at or before t, or null

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GraphStore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEEP_MS = 20 * 60 * 1000;

  /** The newest point of an ordered point list at or before t, or null. */
  function valueAt(pts, t) {
    let best = null;
    for (const p of pts) { if (p[0] <= t) best = p; else break; }
    return best;
  }

  function create({ now = Date.now, keepMs = KEEP_MS } = {}) {
    const cursors = {}; // source -> { since, lastElapsed }
    const cursor = (source) => (cursors[source] ??= { since: -1, lastElapsed: 0 });
    const live = { series: {}, marks: [] };
    let replay = null;

    const store = {
      live,
      get replay() { return replay; },

      since: (source) => cursor(source).since,

      resetCursor(source) {
        const c = cursor(source);
        c.since = -1;
        c.lastElapsed = 0;
      },

      ingest(source, series, elapsedMs) {
        if (!series || elapsedMs == null) return false;
        const c = cursor(source);
        if (elapsedMs < c.lastElapsed) { // a new run: take it all next time
          c.since = -1;
          c.lastElapsed = elapsedMs;
          return false;
        }
        c.lastElapsed = elapsedMs;
        const offset = now() - elapsedMs;
        for (const [key, pts] of Object.entries(series)) {
          const list = (live.series[key] ??= []);
          for (const [t, v] of pts) {
            list.push([offset + t, v]);
            c.since = Math.max(c.since, t);
          }
        }
        const cutoff = now() - keepMs;
        for (const pts of Object.values(live.series)) {
          let drop = 0;
          while (drop < pts.length && pts[drop][0] < cutoff) drop++;
          if (drop) pts.splice(0, drop);
        }
        return true;
      },

      setMarks(v) {
        if (v.elapsedMs == null) return;
        const offset = now() - v.elapsedMs;
        live.marks = [
          ...v.events.map((e) => ({ t: offset + e.t_ms, text: e.text, kind: 'ev' })),
          ...v.markers.map((m) => ({ t: offset + m.t_ms, text: m.text, kind: 'mk' })),
        ];
      },

      openReplay({ name, durationMs, series, events, markers }) {
        replay = {
          name,
          durationMs,
          series,
          marks: [
            ...events.map((e) => ({ t: e.t_ms, text: e.text, kind: 'ev' })),
            ...markers.map((m) => ({ t: m.t_ms, text: m.text, kind: 'mk' })),
          ],
        };
        return replay;
      },

      closeReplay() { replay = null; },

      source: () => replay ?? live,

      view({ windowMs = 0, paused = false, scrub = 1000 } = {}) {
        const src = store.source();
        const all = Object.values(src.series).filter((p) => p.length);
        if (!all.length) return null;
        const first = Math.min(...all.map((p) => p[0][0]));
        const last = Math.max(...all.map((p) => p[p.length - 1][0]));
        if (!replay && !paused) {
          const span = windowMs || Math.max(1000, last - first);
          return { t0: now() - span, t1: now() };
        }
        const total = Math.max(1, last - first);
        const span = windowMs && windowMs < total ? windowMs : total;
        const t1 = first + span + (total - span) * (scrub / 1000);
        return { t0: t1 - span, t1 };
      },

      laneSeries(lane) {
        const src = store.source().series;
        const have = lane.keys.filter((k) => src[k]?.length);
        const use = lane.first ? have.slice(0, 1) : have;
        return use.map((k) => ({ key: k, pts: src[k] }));
      },

      latest(keys) {
        let best = null;
        for (const key of keys) {
          const pts = live.series[key];
          if (!pts?.length) continue;
          const [t, v] = pts[pts.length - 1];
          if (!best || t > best.t) best = { key, pts, t, v };
        }
        return best;
      },
    };
    return store;
  }

  return { create, valueAt, KEEP_MS };
}));
