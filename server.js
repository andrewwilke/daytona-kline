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
const { blockRun, gaugeRun, switchRun, probeRun } = require('./src/liverun');
const { recordRun } = require('./src/recorder');
const recordings = require('./src/recordings');
const { discoverRun, takeSnapshot } = require('./src/discover');
const outputtests = require('./src/outputtests');

const PORT = 3675;

const conn = new Connection();

/** The run behind each page feature; `live` is cleared when its run ends, the others keep their last results. */
const state = {
  gauges: null,
  live: null,
  liveError: null, // why the last sensor block run gave up on its own
  probe: null,
  switches: null,
  record: null,
  discover: null,
  snapshot: null, // { a, b, changes, note } of the "Find more IDs" panel
  logDir: undefined, // where the recorder, the id scan and the output test log write; the project's logs folder unless a test sets it
  outputTestToken: null, // handed out by 'POST /api/outputtest/enable' to the one page that enabled output tests; starting a test needs it
};

// A page's "enabled" does not outlive the session: a new connection starts with the feature off.
conn.on('state', ({ state: s }) => {
  if (s !== 'connected') state.outputTestToken = null;
});

const SWITCHES_NOTE = 'This bike description names no switch IDs, not available.';

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

function startLive(id, { log = false, interval = 150 } = {}) {
  const run = blockRun(conn, { id, interval, log });
  state.live = run;
  state.liveError = null;
  // Reads that fail from the very start mean the request itself is refused: stop and say so.
  run.on('fault', () => {
    if (!run.samples && run.errors >= 3) {
      state.liveError = `${run.lastError} (the sensor block read is an advanced tool; the ECU may not serve it)`;
      run.stop();
    }
  });
  run.on('end', () => {
    if (state.live === run) state.live = null;
  });
  run.start();
}

/** Per-byte min/max as the arrays the page indexes by offset. */
const series = (byKey, length = 0) => Array.from({ length }, (_, i) => byKey[i]);

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
const panelAnalogs = () => conn.bike.analogs.filter((a) => a.panel !== false); // `panel: false` ones are only recorded
const analogView = (run) => panelAnalogs().map((def) => {
  const r = run.sampler.analogs[def.key];
  const available = !!r && !run.sampler.analogsUnavailable.includes(def.key);
  return { key: def.key, label: def.label, id: def.id, unit: def.unit, note: def.note ?? null, verified: !!def.verified, available, value: available ? r.value : null, hex: available ? r.hex : null };
});

/** Starting a recording or an id scan while the other one runs would double the traffic on the one K-line. */
function refuseWhileRunning(other) {
  if (state[other]?.running) throw new Error(`${other === 'record' ? 'a recording' : 'the id scan'} is running: stop it first`);
}

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

const routes = {
  'GET /api/status': async () => {
    const cfg = conn.config();
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
      live: state.live
        ? {
            id: state.live.sampler.id,
            samples: state.live.samples,
            errors: state.live.errors,
            lastError: state.live.lastError,
            csvPath: state.live.csvPath,
          }
        : null,
      probe: probeView(state.probe),
    };
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
  'POST /api/gauges/start': async () => {
    conn.requireSession();
    if (!state.gauges?.running) {
      state.gauges = gaugeRun(conn);
      state.gauges.start();
    }
    return {};
  },
  'POST /api/gauges/stop': async () => { state.gauges?.stop(); return {}; },
  'GET /api/gauges': async (body, query = new URLSearchParams()) => {
    const g = state.gauges;
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
  // are behind the ECU unlock; `available: false` otherwise (with `locked: true` when that is why).
  'GET /api/switches': gated(async () => {
    if (!conn.bike.switchIds.length) return { available: false, rows: [], note: SWITCHES_NOTE };
    if (!state.switches?.running) state.switches = switchRun(conn, { analogs: panelAnalogs() });
    await state.switches.step();
    const rows = svc.switchTiles(conn.bike, state.switches.latest.rows);
    const analogs = analogView(state.switches);
    return rows.length ? { available: true, rows, analogs } : { available: false, rows, analogs, note: 'The ECU served none of the switch IDs, not available.' };
  }, { available: false, rows: [], analogs: [] }),
  // The recorder works locked too (OBD values only; `view().locked` and `lockedNote` say what is skipped).
  'POST /api/record/start': async (body) => {
    conn.requireSession();
    if (state.record?.running) return {};
    refuseWhileRunning('discover');
    state.gauges?.stop();
    state.switches?.stop();
    state.record = recordRun(conn, { minutes: body.minutes ?? undefined, logDir: state.logDir });
    state.record.start();
    return {};
  },
  'POST /api/record/stop': async () => { state.record?.stop(); return {}; },
  'POST /api/record/mark': async (body) => {
    if (!state.record?.running) throw new Error('not recording');
    const marker = state.record.mark(body.text);
    if (!marker) throw new Error('type a note to mark');
    return { marker };
  },
  'GET /api/record': async (body, query = new URLSearchParams()) => (state.record
    ? { active: true, ...state.record.view(), ...(query.has('since') ? { series: state.record.series(Number(query.get('since'))) } : {}) }
    : { active: false }),
  // The channels a graph can show: the bike description's gauges, analogs and switches (flags draw as steps).
  'GET /api/graphs': async () => ({
    channels: [
      ...conn.bike.gauges.filter((d) => d.type !== 'text' && d.type !== 'bitpos').map((d) => ({ key: d.key, label: d.label, unit: d.unit, kind: 'value', min: d.min ?? null, max: d.max ?? null })),
      ...conn.bike.analogs.map((d) => ({ key: d.key, label: d.label, unit: d.unit, kind: 'value', min: null, max: null })),
      ...conn.bike.switches.map((d) => ({ key: d.key, label: d.name, unit: '', kind: 'flag', bad: d.bad ?? null, onText: d.onText ?? 'ON', offText: d.offText ?? 'OFF' })),
    ],
  }),
  'GET /api/recordings': async () => ({ recordings: recordings.listRecordings(state.logDir) }),
  'GET /api/recordings/load': async (body, query = new URLSearchParams()) => recordings.loadRecording(query.get('name'), state.logDir),
  'POST /api/discover/start': gated(async (body) => {
    if (state.discover?.running) return {};
    refuseWhileRunning('record');
    state.discover = discoverRun(conn, { from: body.from ?? undefined, to: body.to ?? undefined, logDir: state.logDir });
    state.discover.start();
    return {};
  }),
  'POST /api/discover/stop': async () => { state.discover?.stop(); return {}; },
  'GET /api/discover': async () => ({ active: !!state.discover, ...(state.discover?.view() ?? {}), snapshot: snapshotView() }),
  // Snapshot A reads the ids the last scan found (or the ones the bike table names, before any scan); B reads the same ids
  // again and answers with the ids whose value changed. Each takes a second or two.
  'POST /api/snapshot': gated(async (body) => {
    if (state.record?.running || state.discover?.running) throw new Error('stop the recording or the id scan first');
    if (body.which === 'a') {
      const scanned = state.discover?.found.map((f) => f.id) ?? [];
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
    if (state.probe?.running) return {};
    state.probe = probeRun(conn, { from: body.from ?? 0x01, to: body.to ?? 0xff });
    state.probe.start();
    return {};
  }),
  'POST /api/live/start': gated(async (body) => {
    startLive(conn.dataBlockId(body.id), {
      log: !!body.log,
      interval: body.interval ?? 150,
    });
    return {};
  }),
  'POST /api/live/stop': async () => { state.live?.stop(); return {}; },
  'POST /api/live/reset': async () => { state.live?.resetRange(); return {}; },
  'GET /api/live/latest': async () => {
    const run = state.live;
    if (!run) return { active: false, error: state.liveError ?? undefined };
    const data = run.latest?.data;
    return {
      active: true,
      id: run.sampler.id,
      samples: run.samples,
      errors: run.errors,
      lastError: run.lastError,
      csvPath: run.csvPath,
      raw: data ? [...data] : null,
      min: series(run.min, data?.length),
      max: series(run.max, data?.length),
      fields: run.latest?.fields ?? [],
    };
  },
};

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

module.exports = { routes, conn, state, server };
