#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SerialTransport } = require('./src/transport');
const { hex } = require('./src/kwp');
const { Connection } = require('./src/connection');
const svc = require('./src/services');
const { createRuns, panelAnalogs, SWITCHES_NOTE } = require('./src/runs');
const recordings = require('./src/recordings');
const { takeSnapshot } = require('./src/discover');
const outputtests = require('./src/outputtests');

const PORT = 3675;

const conn = new Connection();

/**
 * Every run the page can start (dashboard, switch watcher, recording, id scan, sensor block read,
 * probe) lives in the run coordinator: who may use the K-line and in what order is decided there
 * (src/runs.js), and this file only routes to it and renders what a run reports.
 */
const runs = createRuns(conn);

/**
 * What is left of the old run state, as a compatibility export for the tests: the run behind each
 * page feature, read from the coordinator (`live` is cleared when its run ends, the others keep their
 * last results; assigning null to `discover` forgets the scan's results), `logDir` (where the recorder,
 * the id scan and the output test log write; the project's logs folder unless a test sets it) and
 * `liveError`. `snapshot` ({ a, b, changes, note } of the "Find more IDs" panel) and `outputTestToken`
 * (handed out by 'POST /api/outputtest/enable' to the one page that enabled output tests; starting a
 * test needs it) are not runs and live here.
 */
const state = {
  snapshot: null,
  outputTestToken: null,
};
const runView = (key, feature) => Object.defineProperty(state, key, {
  enumerable: true,
  get: () => runs.get(feature),
  set(value) {
    if (value !== null) throw new TypeError(`state.${key} is owned by the run coordinator: only null (forget it) can be assigned`);
    runs.forget(feature);
  },
});
runView('gauges', 'dashboard');
runView('switches', 'switches');
runView('record', 'recording');
runView('discover', 'scan');
runView('live', 'sensor');
runView('probe', 'probe');
Object.defineProperties(state, {
  liveError: { enumerable: true, get: () => runs.notes.sensor ?? null }, // why the last sensor block run gave up on its own
  logDir: { enumerable: true, get: () => runs.logDir, set: (dir) => { runs.logDir = dir; } },
});

// A page's "enabled" does not outlive the session: a new connection starts with the feature off.
conn.on('state', ({ state: s }) => {
  if (s !== 'connected') state.outputTestToken = null;
});

/**
 * A route for a read the ECU refuses until it is unlocked: needs a session, then
 * answers `{ locked: true, note }` (plus `whenLocked`) without sending anything
 * if the connection's unlock state says the ECU is still locked.
 */
function gated(route, whenLocked = {}) {
  return async (body) => {
    conn.requireSession();
    const why = svc.needsUnlock(conn);
    if (why) return { ...whenLocked, locked: true, note: why };
    return route(body);
  };
}

/** Per-byte min/max as the arrays the page indexes by offset. */
const perByte = (byKey, length = 0) => Array.from({ length }, (_, i) => byKey[i]);

const probeView = (run) => run && {
  running: run.running,
  current: run.sampler.current,
  found: run.sampler.found,
  cancelled: run.outcome === 'cancelled',
  biggest: run.outcome === 'finished' ? run.sampler.biggest?.id : undefined,
  error: run.lastError ?? undefined,
  unavailable: run.sampler.blocked ?? undefined,
};

/** The analog extras of a switch run as tiles: the value, or `available: false` once the ECU stayed silent on one. */
const analogView = (run) => panelAnalogs(conn).map((def) => {
  const r = run.sampler.analogs[def.key];
  const available = !!r && !run.sampler.analogsUnavailable.includes(def.key);
  return { key: def.key, label: def.label, id: def.id, unit: def.unit, note: def.note ?? null, verified: !!def.verified, available, value: available ? r.value : null, hex: available ? r.hex : null };
});

const snapshotView = () => {
  const s = state.snapshot;
  const brief = (x) => x && { at: x.at, count: Object.keys(x.values).length };
  return { a: brief(s?.a) ?? null, b: brief(s?.b) ?? null, changes: s?.changes ?? null, note: s?.note ?? null };
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * The routes: `'METHOD /path': async (body, query) => object`, answered as `{ ok: true, ...object }` (or
 * `{ ok: false, error }` when it throws). Each is a thin front for a module; none keeps run state of its own.
 *
 * Who may use the K-line is decided by the run coordinator (src/runs.js), not by the page:
 *   - a recording or an id scan stops the dashboard and the switch watcher and brings them back when it ends;
 *   - 'POST /api/gauges/start' while one of them runs answers `{ paused: true, note }` and the dashboard
 *     starts when it ends; 'GET /api/switches' answers its usual shape plus `paused: true` and a `note`
 *     (and no tiles) instead of starting a switch run.
 *
 * Added for the page to say what the owner did (all of them JSON, all needing a session):
 *   GET  /api/runs             what is running (`running`: feature, role, run, startedAt), what is paused and
 *                              why (`paused`: feature, by, why, note), which features the owner stopped
 *                              (`stoppedByOwner`), what is waiting for the unlock (`waiting`), which exclusive
 *                              run is on (`exclusive`: 'recording', 'scan' or null) and `connected`. Read-only.
 *   POST /api/runs/start       { feature: 'dashboard' | 'switches' }: the owner starts it (clears the owner's
 *                              stop). Answers `started`, `paused: true` + `note` while a recording or scan runs
 *                              (it starts when that ends), or `unavailable: true` + `note` (the unlock), and
 *                              `runs`, the answer of GET /api/runs.
 *   POST /api/runs/stop        { feature: 'dashboard' | 'switches' }: the owner stopped it; nothing starts it
 *                              again until the owner starts it or the next connection. Answers `runs`.
 *   POST /api/runs/reconcile   start what should be running: the dashboard, and the switch watcher once
 *                              unlocked, unless the owner stopped them or a recording or scan is on. Answers
 *                              `started` (feature names) and `runs`. The page calls it once connected.
 * 'POST /api/gauges/stop' is the owner's Stop of the dashboard (same as runs/stop with 'dashboard').
 */
const OWNER_FEATURES = ['dashboard', 'switches'];
const ownerFeature = (body) => {
  if (!OWNER_FEATURES.includes(body.feature)) throw new Error(`feature must be one of: ${OWNER_FEATURES.join(', ')}`);
  return body.feature;
};

const routes = {
  'GET /api/status': async () => {
    const cfg = conn.config();
    const live = runs.get('sensor');
    return {
      connected: conn.state === 'connected',
      state: conn.state,
      error: conn.error,
      unlock: conn.unlockState,
      unlockReason: conn.unlockReason,
      progress: conn.progress,
      comPort: conn.port ?? cfg.port ?? null,
      kind: conn.kind,
      style: conn.style,
      target: conn.target,
      addrMode: conn.addrMode,
      keyBytes: conn.keyBytes ? hex(conn.keyBytes) : null,
      dataBlockId: conn.dataBlockId(),
      live: live
        ? {
            id: live.sampler.id,
            samples: live.samples,
            errors: live.errors,
            lastError: live.lastError,
            csvPath: live.csvPath,
          }
        : null,
      probe: probeView(runs.get('probe')),
    };
  },
  'GET /api/runs': async () => runs.status(),
  'POST /api/runs/start': async (body) => {
    const r = runs.start(ownerFeature(body));
    return {
      started: r.started,
      ...(r.paused ? { paused: true, note: r.paused.note } : {}),
      ...(r.unavailable ? { unavailable: true, note: r.unavailable } : {}),
      runs: runs.status(),
    };
  },
  'POST /api/runs/stop': async (body) => {
    runs.stop(ownerFeature(body));
    return { runs: runs.status() };
  },
  'POST /api/runs/reconcile': async () => {
    conn.requireSession();
    return { started: runs.reconcile(), runs: runs.status() };
  },
  'GET /api/ports': async () => ({ ports: await SerialTransport.listPorts() }),
  'POST /api/connect': async (body) => {
    const r = await conn.connect({ port: body.port });
    return { target: '0x' + r.target.toString(16), keyBytes: hex(r.keyBytes), addrMode: r.addrMode, kind: r.kind };
  },
  'POST /api/disconnect': async () => { await conn.disconnect(); return {}; },
  // One attempt per call (one seed request, at most one key); the page offers it only from 'locked' or 'failed'.
  'POST /api/unlock': async () => {
    const { state: unlock, reason } = await conn.unlock();
    return { unlock, unlockReason: reason };
  },
  'GET /api/id': gated(async () => ({ results: await svc.readEcuId(conn.requireSession()) }), { results: [] }),
  // Codes with their meanings, the warning light state (`status`, null if the ECU does not report it) and a one-line `summary` comparing the two.
  'GET /api/dtc': async () => {
    const result = await svc.readDtcs(conn.requireSession(), conn.bike);
    return { ...result, summary: svc.faultSummary(result) };
  },
  'POST /api/cleardtc': async () => {
    await svc.clearDtcs(conn.requireSession());
    return {};
  },
  // While a recording or an id scan runs the dashboard does not start now: `{ paused: true, note }`, and it starts when that ends.
  'POST /api/gauges/start': async () => {
    const { paused } = runs.start('dashboard');
    return paused ? { paused: true, note: paused.note } : {};
  },
  'POST /api/gauges/stop': async () => { runs.stop('dashboard'); return {}; },
  'GET /api/gauges': async (body, query = new URLSearchParams()) => {
    const g = runs.get('dashboard');
    return {
      running: !!g?.running,
      defs: conn.bike.gauges,
      values: g?.sampler.values ?? {},
      cycles: g?.cycles ?? 0,
      errors: g?.errors ?? 0,
      lastError: g?.lastError ?? null,
      unsupported: g?.sampler.unsupported ?? [],
      locked: svc.lockedGauges(conn), // gauges that need the ECU unlock and are not polled until it is done
      supported: g?.sampler.supported ? [...g.sampler.supported].sort((a, b) => a - b) : null,
      ...(query.has('since') ? { series: g?.series(Number(query.get('since'))) ?? {}, elapsedMs: g ? conn.clock.now() - g.startedAt : 0 } : {}),
    };
  },
  // The page paces this one itself: each request is one cycle of a switch run. The Daytona's switch IDs
  // are behind the ECU unlock; `available: false` otherwise (with `locked: true` when that is why). While a
  // recording or an id scan holds the line, or after the owner stopped the watcher, it answers the same shape with
  // `paused: true` and a `note` and starts nothing.
  'GET /api/switches': gated(async () => {
    if (!conn.bike.switchIds.length) return { available: false, rows: [], note: SWITCHES_NOTE };
    const { run, paused } = runs.ensure('switches');
    if (paused) return { available: false, rows: [], analogs: [], paused: true, note: paused.note };
    await run.step();
    const rows = svc.switchTiles(conn.bike, run.latest.rows);
    const analogs = analogView(run);
    return rows.length ? { available: true, rows, analogs } : { available: false, rows, analogs, note: 'The ECU served none of the switch IDs, not available.' };
  }, { available: false, rows: [], analogs: [] }),
  // The recorder works locked too (OBD values only; `view().locked` and `lockedNote` say what is skipped).
  // The coordinator stops the dashboard and the switch watcher for it and brings them back afterwards.
  'POST /api/record/start': async (body) => {
    runs.start('recording', { minutes: body.minutes });
    return {};
  },
  'POST /api/record/stop': async () => { runs.stop('recording'); return {}; },
  'POST /api/record/mark': async (body) => {
    const rec = runs.active('recording');
    if (!rec) throw new Error('not recording');
    const marker = rec.mark(body.text);
    if (!marker) throw new Error('type a note to mark');
    return { marker };
  },
  'GET /api/record': async (body, query = new URLSearchParams()) => {
    const rec = runs.get('recording');
    return rec
      ? { active: true, ...rec.view(), ...(query.has('since') ? { series: rec.series(Number(query.get('since'))) } : {}) }
      : { active: false };
  },
  'GET /api/recordings': async () => ({ recordings: recordings.listRecordings(state.logDir) }),
  'GET /api/recordings/load': async (body, query = new URLSearchParams()) => recordings.loadRecording(query.get('name'), state.logDir),
  // An id scan, like a recording, holds the line alone: the coordinator refuses it while a recording runs and
  // stops the dashboard and the switch watcher for it.
  'POST /api/discover/start': gated(async (body) => {
    runs.start('scan', { from: body.from, to: body.to });
    return {};
  }),
  'POST /api/discover/stop': async () => { runs.stop('scan'); return {}; },
  'GET /api/discover': async () => {
    const scan = runs.get('scan');
    return { active: !!scan, ...(scan?.view() ?? {}), snapshot: snapshotView() };
  },
  // Snapshot A reads the ids the last scan found (or the ones the bike table names, before any scan); B reads the same ids
  // again and answers with the ids whose value changed. Each takes a second or two.
  'POST /api/snapshot': gated(async (body) => {
    runs.requireNoExclusive('stop the recording or the id scan first');
    if (body.which === 'a') {
      const scanned = runs.get('scan')?.found.map((f) => f.id) ?? [];
      const ids = scanned.length ? scanned : svc.knownIds(conn.bike);
      state.snapshot = {
        a: await takeSnapshot(conn, ids),
        b: null,
        changes: null,
        note: scanned.length ? null : 'No scan has been run yet, so only the ids the bike table names were read. Scan first to include unknown ids.',
      };
    } else if (body.which === 'b') {
      if (!state.snapshot?.a) throw new Error('take snapshot A first');
      const b = await takeSnapshot(conn, state.snapshot.a.ids);
      state.snapshot = { ...state.snapshot, b, changes: svc.diffSnapshots(state.snapshot.a.values, b.values, conn.bike) };
    } else {
      throw new Error('which must be "a" or "b"');
    }
    return snapshotView();
  }),
  // Output tests: the one feature that makes the bike do something. A page has to enable it (the token
  // comes back only to the page that asked, so another web page cannot start a test by posting to this
  // port), and every start needs `confirmed: true`, which the page sends after asking the person.
  'GET /api/outputtest/list': async () => ({
    tests: outputtests.listTests(conn.bike),
    preconditions: outputtests.PRECONDITIONS,
    cooldownMs: outputtests.COOLDOWN_MS,
  }),
  'GET /api/outputtest/status': async () => outputtests.outputTestStatus(conn),
  'POST /api/outputtest/enable': async (body) => {
    if (body.acknowledged !== true) throw new Error('output tests are enabled only after the preconditions are acknowledged');
    state.outputTestToken = crypto.randomBytes(16).toString('hex');
    return { token: state.outputTestToken };
  },
  'POST /api/outputtest/start': gated(async (body) => {
    if (!state.outputTestToken || body.token !== state.outputTestToken) {
      throw new Error('output tests are not enabled on this page: enable them first');
    }
    const test = await outputtests.runOutputTest(conn, body.key, { confirmed: body.confirmed === true, logDir: state.logDir });
    return { test: test.view() };
  }),
  'POST /api/outputtest/stop': async () => {
    const test = outputtests.currentTest(conn);
    if (test?.running) await test.stop();
    return { test: test?.view() ?? null };
  },
  'POST /api/probe': gated(async (body) => {
    runs.start('probe', { from: body.from ?? 0x01, to: body.to ?? 0xff });
    return {};
  }),
  'POST /api/live/start': gated(async (body) => {
    runs.start('sensor', { id: conn.dataBlockId(body.id), log: !!body.log, interval: body.interval ?? 150 });
    return {};
  }),
  'POST /api/live/stop': async () => { runs.stop('sensor'); return {}; },
  'POST /api/live/reset': async () => { runs.get('sensor')?.resetRange(); return {}; },
  'GET /api/live/latest': async () => {
    const run = runs.get('sensor');
    if (!run) return { active: false, error: runs.notes.sensor ?? undefined };
    const data = run.latest?.data;
    return {
      active: true,
      id: run.sampler.id,
      samples: run.samples,
      errors: run.errors,
      lastError: run.lastError,
      csvPath: run.csvPath,
      raw: data ? [...data] : null,
      min: perByte(run.min, data?.length),
      max: perByte(run.max, data?.length),
      fields: run.latest?.fields ?? [],
    };
  },
};

/**
 * The page's scripts (public/js/*.js) are the only static files served besides the page itself. A request
 * is answered only when its whole path is `/js/<name>.js` with a plain name (lower case letters, digits and
 * dashes: no dots, slashes, percent signs or backslashes, so nothing can climb out of the folder) and that
 * name is a file in public/js; everything else, directories and sub-folders included, is not found.
 */
const PAGE_SCRIPT_DIR = path.join(__dirname, 'public', 'js');
const PAGE_SCRIPT_PATH = /^\/js\/([a-z0-9-]+\.js)$/;
function pageScript(pathname) {
  const m = PAGE_SCRIPT_PATH.exec(pathname);
  if (!m) return null;
  const file = path.join(PAGE_SCRIPT_DIR, m[1]);
  try {
    // the name must be an entry of the folder as listed (never a device name or anything the file system resolves for us)
    if (!fs.readdirSync(PAGE_SCRIPT_DIR).includes(m[1])) return null;
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const [pathname, queryText = ''] = req.url.split('?');
  const key = `${req.method} ${pathname}`;
  if (routes[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      json(res, 200, { ok: true, ...(await routes[key](body, new URLSearchParams(queryText))) });
    } catch (e) {
      json(res, 200, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  const script = req.method === 'GET' ? pageScript(pathname) : null;
  if (script) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(script);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/** Opens the page in the default browser (only with --open, which `npm start` and the start scripts pass). */
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // no browser to open: the address is printed
  }
}

if (require.main === module) {
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${PORT} is already in use: is the tool already running? Open http://localhost:${PORT} (or close the other copy first).`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`daytona-kline GUI: ${url}`);
    if (process.argv.includes('--open')) openBrowser(url);
  });
}

module.exports = { routes, conn, runs, state, server };
