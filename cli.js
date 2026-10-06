#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const { SerialTransport } = require('./src/transport');
const { hex } = require('./src/kwp');
const { Connection } = require('./src/connection');
const svc = require('./src/services');
const { blockRun, gaugeRun, switchRun, probeRun } = require('./src/liverun');
const { recordRun } = require('./src/recorder');
const { discoverRun, takeSnapshot, DEFAULT_FROM, DEFAULT_TO, EXTENDED_FROM, EXTENDED_TO } = require('./src/discover');
const { DEFAULT_BIKE } = require('./src/bikes');
const outputtests = require('./src/outputtests');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

/** Print the connection's progress as the CLI's status lines. */
function renderProgress(e) {
  const hexAddr = (n) => '0x' + n.toString(16);
  if (e.step === 'attempt') {
    process.stderr.write(`${e.attempt.saved ? 'saved wake-up: ' : ''}${e.attempt.text}...\n`);
  } else if (e.step === 'attempt-failed') {
    process.stderr.write(`  no answer (${e.message})\n`);
  } else if (e.step === 'connected') {
    const how = e.kind === 'slow' ? 'slow init' : 'fast init';
    console.log(`Connected to ECU ${hexAddr(e.target)} by ${how} (key bytes: ${hex(e.keyBytes)})`);
  }
}

/** Call `onLine(text)` for every line typed on the console; returns a function that stops listening. */
let readLines = (onLine) => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', onLine);
  return () => rl.close();
};

/** Resolves when Enter is pressed (or the console input ends). */
let waitForEnter = (prompt) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', resolve);
  rl.question(prompt, () => rl.close());
});

let makeConnection = (args) => new Connection({ debug: !!args.debug, autoUnlock: !args['no-unlock'] });

/** The one line saying how the ECU unlock stands (src/unlock.js), printed after connecting. */
function unlockLine(conn) {
  const reason = conn.unlockReason;
  switch (conn.unlockState) {
    case 'unlocked': return 'ECU unlock: unlocked (switches, battery, gear, sensor block and identity can be read)';
    case 'failed': return `ECU unlock: failed (${reason}); the reads that need it stay off`;
    case 'invalid': return `ECU unlock: not used, ${reason}`;
    case 'locked': return 'ECU unlock: not tried (--no-unlock); the reads that need it stay off';
    default: return `ECU unlock: off (${reason})`;
  }
}

/** Connect (saved wake-up first, then the bike's order), run `fn(conn)`, always disconnect. */
async function withEcu(args, fn) {
  const conn = makeConnection(args);
  if (!(args.port || conn.config().port)) {
    console.error('No COM port set. Run: node cli.js ports   then: node cli.js scan --port COM3');
    process.exit(1);
  }
  conn.on('progress', renderProgress);
  await conn.connect({
    port: args.port,
    kind: typeof args.kind === 'string' ? args.kind : undefined,
    target: args.target ? parseInt(args.target, 16) : undefined,
    source: args.source ? parseInt(args.source, 16) : undefined,
    initMode: args.init || 'baud',
    targets: args.targets ? args.targets.split(',').map((s) => parseInt(s, 16)) : undefined,
  });
  console.log(unlockLine(conn));
  try {
    return await fn(conn);
  } finally {
    await conn.disconnect();
  }
}

/** Throw why a run ended early (connection lost) instead of returning quietly. */
function endedEarly(conn) {
  if (conn.state === 'lost') throw new Error(conn.error);
}

const intervalFlag = (args, fallback) => (args.interval ? parseInt(args.interval, 10) : fallback);
const cyclesFlag = (args) => (args.cycles ? parseInt(args.cycles, 10) : Infinity);

/**
 * Render each sample of `run` until it ends. Read errors are tolerated (the
 * connection decides when the ECU is lost) unless the very first reads all
 * fail, which means the request itself is wrong.
 */
async function follow(conn, run, render, cycles = Infinity) {
  run.on('sample', render);
  run.on('sample', () => {
    if (run.cycles >= cycles) run.stop();
  });
  run.on('fault', () => {
    if (!run.samples && run.errors >= 3) run.stop();
  });
  await run.start();
  endedEarly(conn);
  if (!run.samples && run.errors) throw new Error(run.lastError);
}

/**
 * Run `fn` only if the connection's unlock state allows the reads the 2012
 * Daytona refuses until it is unlocked (switches, sensor block, probe, identity);
 * otherwise say "needs the ECU unlock" and do nothing.
 */
async function unlockedOnly(conn, what, fn) {
  const why = svc.needsUnlock(conn);
  if (why) {
    console.log(`\n${what}: ${why}`);
    return undefined;
  }
  return fn();
}

/** Run an advanced tool (the sensor block, switch IDs) on an unlocked connection, explaining a refusal or silence. */
function advanced(conn, what, fn) {
  return unlockedOnly(conn, what, async () => {
    try {
      return await fn();
    } catch (e) {
      if (conn.style !== 'iso9141') throw e;
      throw new Error(`${e.message}. The ECU is unlocked but did not serve this advanced read; "gauges" and "dtc" do not need it.`);
    }
  });
}

const errorNote = (run) => (run.errors ? `   (${run.errors} read errors: ${run.lastError})` : '');

/**
 * The text view of a gauge run: one line per gauge ("Engine   4000 rpm ?", a ?
 * meaning the bike description still marks it unverified; "not available" for a
 * PID the ECU does not serve; "needs the ECU unlock" for a gauge waiting for it;
 * "..." until first read), then a status line.
 */
function gaugeLines(run) {
  const { defs, values, unsupported, supported } = run.sampler;
  const locked = svc.lockedGauges(run.conn, defs);
  const lines = defs.map((d) => {
    const v = values[d.key];
    let shown = '...';
    if (locked.includes(d.key)) shown = 'needs the ECU unlock';
    else if (unsupported.includes(d.key)) shown = 'not available';
    else if (v) shown = d.type === 'text' ? v.text : d.type === 'bitpos' ? String(v.value || 'N').padStart(8) : `${String(v.value).padStart(8)} ${d.unit}`.trimEnd();
    return `${d.label.padEnd(22)} ${shown}${v && !d.verified && !unsupported.includes(d.key) ? ' ?' : ''}`;
  });
  const pids = supported ? `   ECU serves PIDs: ${[...supported].sort((a, b) => a - b).map((p) => p.toString(16).padStart(2, '0')).join(' ')}` : '';
  lines.push(`cycle ${run.cycles}${pids}${errorNote(run)}`);
  return lines;
}

/** The bike's sensor block map, or the one in the JSON file given as --map. */
function loadMap(args, conn) {
  return args.map ? JSON.parse(fs.readFileSync(args.map, 'utf8')) : conn.bike.sensorBlock;
}

const blockIdFlag = (args) => (args.id ? parseInt(args.id, 16) : undefined);

const logDirFlag = (args) => (typeof args['log-dir'] === 'string' ? args['log-dir'] : undefined);
const idText = (id) => `0x${id.toString(16).padStart(4, '0')}`;

/** The --from / --to flags (hex ids, default 0..ff; --extended: 100..3ff) as [from, to]. */
function idRange(args) {
  const hexFlag = (v, fallback) => (v === undefined ? fallback : parseInt(String(v), 16));
  const from = hexFlag(args.from, args.extended ? EXTENDED_FROM : DEFAULT_FROM);
  const to = hexFlag(args.to, args.extended ? EXTENDED_TO : DEFAULT_TO);
  if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) || from > to) {
    throw new Error('--from and --to need hex ids from 0 to ffff, the first not above the last');
  }
  return [from, to];
}

/** m:ss.s of a time in ms. */
const clockText = (ms) => `${Math.floor(ms / 60_000)}:${(Math.floor(ms / 100) / 10 % 60).toFixed(1).padStart(4, '0')}`;

/** The one status line of a recording: time, the safety-critical values, what is skipped. */
function recordStatus(run) {
  const v = run.view();
  const flag = (x, on, off) => (x === null ? '?' : x ? on : off);
  const parts = [
    clockText(v.elapsedMs),
    `rpm ${v.live.rpm ?? '?'}`,
    `battery ${v.live.battery === null ? 'n/a' : `${v.live.battery} V`}`,
    `pump ${flag(v.live.fuelPump, 'ON', 'off')}`,
    `relay ${flag(v.live.mainRelay, 'ON', 'off')}`,
    `start ${flag(v.live.startSwitch, 'PRESSED', 'off')}`,
    `${v.samples} samples`,
  ];
  return parts.join('   ');
}

function printRecordSummary(run) {
  const v = run.view();
  console.log(`Recording ended after ${clockText(v.elapsedMs)}: ${v.samples} samples in ${v.csvPath}`);
  if (v.stopReason) console.log(`  ${v.stopReason}`);
  if (v.battery.min !== null) console.log(`  Battery: lowest ${v.battery.min} V, highest ${v.battery.max} V`);
  else console.log('  Battery: not read (needs the ECU unlock)');
  if (v.locked.length) console.log(`  Skipped, ${v.lockedNote}: ${v.locked.join(', ')}`);
  if (v.notAvailable.length) console.log(`  Not available (the ECU did not serve them): ${v.notAvailable.join(', ')}`);
  console.log(v.events.length ? '  Events:' : '  Events: none');
  for (const e of v.events) console.log(`    [${clockText(e.t_ms)}] ${e.text}`);
  if (v.errors) console.log(`  ${v.errors} read error(s), last: ${v.lastError}`);
}

function printDiscovered(v) {
  console.log(`\nAsked ${v.asked} of ${v.total} id(s) in ${Math.round(v.elapsedMs / 1000)} s: ${v.found.length} answered, ${v.refused} refused, ${v.silent} silent.`);
  if (v.stopReason) console.log(v.stopReason);
  else if (v.outcome === 'cancelled') console.log('Stopped before the end.');
  for (const f of v.found) {
    console.log(`  ${idText(f.id)}  ${String(f.value ?? '').padStart(6)}  ${f.hex.padEnd(8)} ${f.name ?? ''}`.trimEnd());
  }
  if (v.resultPath) console.log(`\nSaved to ${v.resultPath}`);
  if (v.saveError) console.log(`\nCould not save the result: ${v.saveError}`);
  if (v.errors) console.log(`${v.errors} read error(s), last: ${v.lastError}`);
}

// The raw `send` command only does reads: the standard modes, the identification and data reads and
// TesterPresent. Everything else is refused before anything is connected or sent: the output tests have
// their own command (outputtest), clearing codes has cleardtc, and security access is the tool's own unlock.
const RAW_SEND_SERVICES = new Set([0x01, 0x02, 0x03, 0x07, 0x09, 0x18, 0x1a, 0x21, 0x22, 0x3e]);

function rawSendRefusal(service) {
  const hexService = `0x${service.toString(16).padStart(2, '0')}`;
  if (RAW_SEND_SERVICES.has(service)) return null;
  const pointer = service === 0x04 || service === 0x14 ? 'cleardtc --yes erases codes'
    : 'output tests are only run by the outputtest command, from its whitelist';
  return `send only sends reads (services ${[...RAW_SEND_SERVICES].map((n) => n.toString(16).padStart(2, '0')).join(' ')}); service ${hexService} is refused and nothing was sent (${pointer}; the unlock is done by the tool itself)`;
}

/** The whitelist as lines: key, name, what you should see, the safety note. */
function printOutputTests(bike) {
  for (const t of outputtests.listTests(bike)) {
    console.log(`  ${t.key.padEnd(18)} ${t.name}`);
    console.log(`  ${' '.repeat(18)} you should see: ${t.see}`);
    console.log(`  ${' '.repeat(18)} safety: ${t.safety}`);
    console.log(`  ${' '.repeat(18)} ${t.confirmation === 'unconfirmed' ? 'not yet confirmed on a bike' : t.confirmation}`);
  }
}

function printPreconditions() {
  console.log('Preconditions (checked before anything is sent):');
  for (const p of outputtests.PRECONDITIONS) console.log(`  - ${p}`);
}

/** The live lines of a running output test: what changed since the last update. */
function followOutputTest(test) {
  let shown = 0;
  test.on('update', (v) => {
    const samples = v.effect.samples;
    for (; shown < samples.length; shown++) {
      const s = samples[shown];
      if (shown === 0 || s.hex !== samples[shown - 1].hex) console.log(`  [+${(s.t_ms / 1000).toFixed(1)} s] ${v.effect.name ?? `id 0x${v.effect.id.toString(16)}`}: ${s.hex}${s.active === null ? '' : s.active ? ' (on)' : ' (off)'}`);
    }
  });
}

const COMMANDS = {
  async ports() {
    const list = await SerialTransport.listPorts();
    if (!list.length) return console.log('No serial ports found. Is the cable plugged in?');
    for (const p of list) {
      console.log(`${p.path}  ${p.manufacturer || ''} ${p.serialNumber ? '(' + p.serialNumber + ')' : ''}${/ftdi/i.test(p.manufacturer || '') ? '  <-- FTDI, likely your cable' : ''}`);
    }
  },

  async scan(args) {
    await withEcu(args, (conn) => {
      if (conn.style === 'addressed') {
        // Many Keihin ECUs want a manufacturer diagnostic session before
        // serving data; harmless if refused.
        console.log(conn.diagSession
          ? 'Manufacturer diagnostic session started (10 80 accepted).'
          : 'Diagnostic session request refused � plain session is fine for reads.');
      } else {
        console.log('ISO 9141-2 OBD-II session: live data and fault codes use the standard modes 01 and 03.');
      }
      console.log('Saved to config.json � future commands will use this automatically.');
    });
  },

  async id(args) {
    await withEcu(args, (conn) => unlockedOnly(conn, 'id', async () => {
      const results = await svc.readEcuId(conn.session);
      if (!results.length) console.log('ECU accepted no ReadEcuIdentification options.');
      for (const r of results) {
        console.log(`option 0x${r.option.toString(16)}:  ${r.ascii}`);
        console.log(`            ${r.hex}`);
      }
    }));
  },

  async dtc(args) {
    await withEcu(args, async (conn) => {
      const result = await svc.readDtcs(conn.session, conn.bike);
      const { count, dtcs, raw, status, pendingSupported } = result;
      console.log(`\nWarning light (MIL): ${status ? (status.milOn ? 'ON' : 'off') : 'not reported by the ECU'}`);
      console.log(svc.faultSummary(result));
      console.log(`\nFault codes read: ${count}`);
      for (const d of dtcs) {
        const byte = d.statusByte == null ? '' : ` 0x${d.statusByte.toString(16).padStart(2, '0')}`;
        console.log(`  ${d.code}  (${d.status}${byte})${d.description ? '  ' + d.description : ''}`);
      }
      if (pendingSupported === false) console.log('\nPending codes (mode 07): not supported by this ECU.');
      if (args.debug) console.log(`raw: ${raw}${status ? `   status: ${status.raw}` : ''}`);
    });
  },

  async cleardtc(args) {
    if (!args.yes) {
      console.log('This erases all stored fault codes from the ECU. Re-run with --yes to confirm.');
      return;
    }
    await withEcu(args, async (conn) => {
      await svc.clearDtcs(conn.session);
      console.log('Fault codes cleared.');
    });
  },

  async gauges(args) {
    await withEcu(args, async (conn) => {
      const interval = intervalFlag(args, 0);
      const cycles = cyclesFlag(args);
      const run = gaugeRun(conn, {
        interval,
        log: !!args.log,
        logPath: typeof args.log === 'string' ? args.log : undefined,
      });
      console.log('Standard OBD-II live data (mode 01). Ctrl+C to stop.');
      if (run.csvPath) console.log(`Recording to ${run.csvPath}`);
      console.log();
      let drawn = 0;
      run.on('sample', () => {
        const lines = gaugeLines(run);
        // Redraw in place: back up over the previous frame, clearing each line's tail.
        process.stdout.write((drawn ? `\x1b[${drawn}A` : '') + lines.map((l) => `${l}\x1b[K\n`).join(''));
        drawn = lines.length;
        if (run.cycles >= cycles) run.stop();
      });
      await follow(conn, run, () => {});
    });
  },

  async probe(args) {
    await withEcu(args, (conn) => unlockedOnly(conn, 'probe', async () => {
      const from = args.from ? parseInt(args.from, 16) : 0x01;
      const to = args.to ? parseInt(args.to, 16) : 0xff;
      const run = probeRun(conn, { from, to });
      console.log(`Advanced: probing readDataByLocalIdentifier 0x${from.toString(16)}..0x${to.toString(16)} (read-only)...`);
      await follow(conn, run, ({ id }) => process.stderr.write(`\r  0x${id.toString(16).padStart(2, '0')} `));
      process.stderr.write('\r');
      if (run.sampler.blocked) return console.log(`\nProbe stopped early: ${run.sampler.blocked}.`);
      const { found, biggest } = run.sampler;
      console.log(`\nSupported data blocks: ${found.length}`);
      for (const f of found) {
        console.log(`  id 0x${f.id.toString(16).padStart(2, '0')}  ${f.length} bytes: ${f.hex}`);
      }
      if (biggest) {
        console.log(`\nBiggest block is id 0x${biggest.id.toString(16)} — that's almost certainly the live sensor block.`);
        console.log(`Try:  node cli.js watch --id ${biggest.id.toString(16)}`);
      }
    }));
  },

  async live(args) {
    const interval = intervalFlag(args, 150);
    await withEcu(args, (conn) => advanced(conn, 'live', async () => {
      const run = blockRun(conn, {
        id: conn.dataBlockId(blockIdFlag(args)),
        map: loadMap(args, conn),
        interval,
        log: !!args.log,
        logPath: typeof args.log === 'string' ? args.log : undefined,
      });
      console.log(`Reading block 0x${run.sampler.id.toString(16)} every ${interval} ms. Ctrl+C to stop.`);
      if (run.csvPath) console.log(`Recording to ${run.csvPath}`);
      console.log();
      await follow(conn, run, ({ data, fields }) => {
        const line = fields
          .map((f) => `${f.name}: ${f.value}${f.unit}${f.verified ? '' : '?'}`)
          .join('   ');
        process.stdout.write(`\r${line}   [${data.length}B]${errorNote(run)}   `);
      }, cyclesFlag(args));
    }));
  },

  async watch(args) {
    await withEcu(args, (conn) => advanced(conn, 'watch', async () => {
      const run = blockRun(conn, { id: conn.dataBlockId(blockIdFlag(args)), interval: intervalFlag(args, 200), name: 'watch' });
      const id = run.sampler.id;
      console.log(`Watching block 0x${id.toString(16)}. Bytes that changed since start are highlighted;`);
      console.log(`blip the throttle / watch the temps and note which offsets move. Ctrl+C to stop.\n`);
      await follow(conn, run, ({ data }) => {
        let out = '';
        for (let i = 0; i < data.length; i++) {
          const cell = data[i].toString(16).padStart(2, '0');
          out += run.min[i] !== run.max[i] ? `\x1b[1;33m${cell}\x1b[0m` : cell;
          out += (i + 1) % 4 === 0 ? '  ' : ' ';
          if ((i + 1) % 16 === 0) out += '\n';
        }
        const changedList = run.changed().map((i) => `[${i}] ${run.min[i]}..${run.max[i]}`);
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen
        console.log(`block 0x${id.toString(16)} (${data.length} bytes), offsets 0-based:\n`);
        console.log(out);
        console.log(`\nchanging bytes: ${changedList.join('   ') || '(none yet)'}${errorNote(run)}`);
      }, cyclesFlag(args));
    }));
  },

  async switches(args) {
    const ids = typeof args.ids === 'string' ? args.ids.split(',').map((s) => parseInt(s, 16)) : null;
    if (!ids && !DEFAULT_BIKE.switchIds.length) {
      console.log('This bike description names no switch IDs. Advanced: name IDs to try with --ids 41,60 (hex).');
      return;
    }
    await withEcu(args, (conn) => advanced(conn, 'switches', async () => {
      const run = switchRun(conn, { ids: ids ?? conn.bike.switchIds, interval: intervalFlag(args, 0) });
      console.log('Polling switch states. Pull the clutch, flick the kill switch, put it in');
      console.log('neutral, etc. — IDs that change are highlighted. Ctrl+C to stop.\n');
      await follow(conn, run, ({ rows }) => {
        if (!rows.length) {
          run.stop();
          console.log('The ECU did not serve any of those IDs.');
          return;
        }
        const changed = new Set(run.changed().map(Number));
        const out = svc.switchTiles(conn.bike, rows).map((t) => {
          const cell = `${idText(t.id)}=${t.hex.padEnd(6)}`;
          const words = `${t.named ? t.name.padEnd(28) : ''}${t.state ?? ''}${t.confirmation === 'unconfirmed' ? ' ?' : ''}`;
          return `${changed.has(t.id) ? `\x1b[1;33m${cell}\x1b[0m` : cell}  ${words}`.trimEnd();
        }).join('\n');
        process.stdout.write('\x1b[2J\x1b[H' + out + '\n\nchanged so far: ' +
          ([...changed].map(idText).join(', ') || '(none)') + errorNote(run) + '\n');
      }, cyclesFlag(args));
    }));
  },

  async record(args) {
    const minutes = typeof args.minutes === 'string' ? Number(args.minutes) : undefined;
    if (args.minutes !== undefined && !(minutes > 0)) throw new Error('--minutes needs a number above 0');
    await withEcu(args, async (conn) => {
      const run = recordRun(conn, { minutes, logDir: logDirFlag(args) });
      const locked = svc.needsUnlock(conn);
      console.log(`Recording to ${run.csvPath} (stops after ${run.maxMs / 60_000} min). Ctrl+C to stop earlier.`);
      if (locked) console.log(`${locked}: battery, switch flags and analog values are skipped, only the OBD values are recorded.`);
      console.log('Type a note and press Enter to mark the moment (cranking, started, died...).\n');
      const line = (text) => process.stdout.write(`\r\x1b[K${text}\n`);
      run.on('event', (e) => line(`[${clockText(e.t_ms)}] ${e.text}`));
      run.on('mark', (m) => line(`[${clockText(m.t_ms)}] mark: ${m.text}`));
      let drawn = -Infinity;
      run.on('sample', ({ t_ms }) => {
        if (t_ms - drawn < 500) return;
        drawn = t_ms;
        process.stdout.write(`\r${recordStatus(run)}\x1b[K`);
      });
      const stopTyping = readLines((text) => run.mark(text));
      const interrupt = () => run.stop();
      process.once('SIGINT', interrupt);
      try {
        await run.start();
      } finally {
        process.off('SIGINT', interrupt);
        stopTyping();
      }
      process.stdout.write('\r\x1b[K');
      printRecordSummary(run);
      endedEarly(conn);
    });
  },

  async discover(args) {
    const [from, to] = idRange(args);
    await withEcu(args, (conn) => unlockedOnly(conn, 'discover', async () => {
      const run = discoverRun(conn, { from, to, logDir: logDirFlag(args) });
      console.log(`Advanced: asking service 0x22 for ids ${idText(from)}..${idText(to)} (read-only, nothing else is sent). Ctrl+C to stop.`);
      await follow(conn, run, ({ id }) => process.stderr.write(`\r  ${idText(id)}  ${run.sampler.found.length} answered `));
      process.stderr.write('\r\x1b[K');
      printDiscovered(run.view());
    }));
  },

  async snapshot(args) {
    const typed = typeof args.ids === 'string' ? args.ids.split(',').map((s) => parseInt(s, 16)) : null;
    if (typed && typed.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) throw new Error('--ids needs hex ids, such as 41,60');
    const [from, to] = idRange(args);
    await withEcu(args, (conn) => unlockedOnly(conn, 'snapshot', async () => {
      let ids = typed;
      let a;
      if (ids) {
        console.log(`Snapshot A: reading ${ids.length} id(s)...`);
        a = await takeSnapshot(conn, ids);
      } else {
        console.log(`Snapshot A: asking every id ${idText(from)}..${idText(to)} (read-only). This takes a while; pass --ids 41,60 to read a few ids only.`);
        const run = discoverRun(conn, { from, to, logDir: logDirFlag(args) });
        await follow(conn, run, ({ id }) => process.stderr.write(`\r  ${idText(id)}  ${run.sampler.found.length} answered `));
        process.stderr.write('\r\x1b[K');
        ids = run.found.map((f) => f.id);
        a = { values: Object.fromEntries(run.found.map((f) => [f.id, { hex: f.hex, value: f.value }])) };
      }
      console.log(`Snapshot A taken: ${Object.keys(a.values).length} id(s) answered.`);
      await waitForEnter('Now do the thing (lift the sidestand, flip the kill switch, tilt the bike...), then press Enter for snapshot B. ');
      const b = await takeSnapshot(conn, ids);
      const changes = svc.diffSnapshots(a.values, b.values, conn.bike);
      console.log(`\nSnapshot B taken: ${Object.keys(b.values).length} id(s) answered.`);
      if (!changes.length) return console.log('No id changed between A and B.');
      console.log(`${changes.length} id(s) changed:`);
      for (const c of changes) console.log(`  ${idText(c.id)}  ${(c.name ?? '(not named)').padEnd(28)} ${c.before ?? 'no answer'}  ->  ${c.after ?? 'no answer'}`);
    }));
  },

  async outputtest(args) {
    const key = args._[0];
    const bike = DEFAULT_BIKE;
    if (key === 'list') {
      console.log('Output tests this tool can run (the complete list; nothing else is ever commanded):');
      console.log();
      printOutputTests(bike);
      console.log();
      console.log('These make the bike move or run parts. Run one with: node cli.js outputtest <key> --yes');
      return;
    }
    const test = outputtests.findTest(bike, key);
    if (!test) {
      console.log(key ? `"${key}" is not an output test this tool can run. The only ones:` : 'Usage: node cli.js outputtest <key|list> --yes');
      console.log();
      printOutputTests(bike);
      if (key) throw new Error(`unknown output test "${key}"`);
      return;
    }
    console.log(`${test.name} (${test.key}): ${test.confirmation === 'unconfirmed' ? 'not yet confirmed on a bike' : test.confirmation}`);
    console.log(`  You should see: ${test.see}`);
    console.log(`  Safety: ${test.safety}`);
    if (!args.yes) {
      console.log();
      console.log('This makes the bike drive that output. Nothing was sent.');
      printPreconditions();
      console.log();
      console.log('Re-run with --yes to connect and run it.');
      return;
    }
    await withEcu(args, async (conn) => {
      const locked = outputtests.unlockProblem(conn);
      if (locked) {
        console.log();
        console.log(`outputtest: ${locked}`);
        return;
      }
      console.log();
      console.log('Running the test (--yes given). Ctrl+C ends the watch early.');
      const run = await outputtests.runOutputTest(conn, key, { confirmed: true, logDir: logDirFlag(args) });
      followOutputTest(run);
      const interrupt = () => run.stop();
      process.once('SIGINT', interrupt);
      let v;
      try {
        v = run.view();
        if (v.running) console.log(`ECU answered ${v.reply}: the test is running. Watching for ${v.watchMs / 1000} s at most.`);
        for (const w of v.warnings) console.log(`WARNING: ${w}`);
        v = await run.done;
      } finally {
        process.off('SIGINT', interrupt);
      }
      endedEarly(conn);
      if (v.state === 'failed') throw new Error(v.error);
      console.log();
      console.log(`Test ${v.outcome} after ${(v.elapsedMs / 1000).toFixed(1)} s. Effect: ${v.effect.text}`);
      if (v.needsStop) console.log(v.stopError ? `Stop was NOT acknowledged: ${v.stopError}` : `Stop sent, the ECU answered ${v.stopReply}.`);
      console.log(v.logFile ? `Logged to ${v.logFile}` : `Could not write the log (${v.logError})`);
    });
  },

  async send(args) {
    const bytes =(args._[0] || '').match(/[0-9a-fA-F]{2}/g)?.map((h) => parseInt(h, 16));
    if (!bytes?.length) {
      console.log('Usage: node cli.js send "01 0c"   (hex request payload, header/checksum added for you; reads only)');
      return;
    }
    const refusal = rawSendRefusal(bytes[0]);
    if (refusal) throw new Error(refusal);
    await withEcu(args, async (conn) => {
      // Unknown service: never resend it automatically.
      const { frames } = await conn.session.request(bytes, { timeout: 3000, destructive: true, multiFrame: true });
      for (const f of frames) console.log(`response: ${hex(f)}`);
    });
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || !COMMANDS[cmd]) {
    console.log(`daytona-kline — read-only diagnostics for the Daytona 675 (OBD-II over the K-line)

Usage: node cli.js <command> [options]

  ports                      List serial ports (find your FTDI cable)
  scan   --port COM3         Find the ECU (slow init first, then fast), saves config
  gauges [--log [run.csv]]   Live engine data: rpm, speed, throttle, pressure, temperatures,
                             load, timing, fuel trim, fuel system status (standard OBD-II
                             mode 01), plus battery and gear once the ECU is unlocked; --log records to logs/run-<time>.csv or appends to the
                             file named
  dtc                        Read fault codes, with the warning light (MIL) and the ECU's code count
  cleardtc --yes             Erase stored fault codes
  id                         Read ECU identification strings (needs the ECU unlock)
  record [--minutes 10]      Record the gauges, switches and analog values together with timestamps into
                             logs/record-<time>.csv, with events (engine stopped, fuel pump OFF while
                             running, battery dip...); type a note + Enter to mark a moment. Works locked
                             too (OBD values only)

Needs the ECU unlock (your own unlock.json, see unlock.example.json; tried once after connecting):
  probe                      Find which data blocks the ECU serves (read-only)
  watch  [--id 80]           Hex view highlighting bytes that change — for mapping sensors
  live   [--id 80] [--log [run.csv]]  Decoded sensor block using the bike's sensor map
                             (src/bikes/triumph-keihin-2006-2012.js, or --map file.json)
  switches [--ids 41,60]     Live on/off states by data ID (hex; default: the bike's list), with names
  discover [--from 0 --to ff] [--extended]
                             Ask every 0x22 id in the range which ones this ECU answers (read-only,
                             a few minutes at most; --extended: 100..3ff); saved to logs/discovered-ids-<time>.json
  snapshot [--ids 41,60]     Read the ids (default: sweep the range first), wait for Enter while you do
                             something to the bike, read them again and print what changed
  send   "01 0c"             Send a raw read request payload (reads only: anything else is refused)

Optional, makes the bike move or run parts (needs the ECU unlock; see "Output tests" in the README):
  outputtest list            The whitelist of output tests and what you should see
  outputtest <key> [--yes]   Run one (tachometer, coolingFan, fuelPump, ...); without --yes it only prints
                             what would happen and the preconditions. Needs: engine off, bike stationary,
                             battery at least 10.5 V

Common options: --port COMx  --kind slow|fast  --target 33  --init baud|break  --debug
                --no-unlock  do not try the ECU unlock after connecting
                --log-dir <folder>  where record and discover write (default: logs)
gauges, watch, live and switches also take --interval <ms> between reads and --cycles <n> to stop after n readings`);
    return;
  }
  try {
    await COMMANDS[cmd](args);
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  }
}

/** For tests: replace how a connection is made (the default opens the serial port named in config.json or --port). */
function use({ connection, lines, enter }) {
  if (connection) makeConnection = connection;
  if (lines) readLines = lines;
  if (enter) waitForEnter = enter;
}

if (require.main === module) main();

module.exports = { COMMANDS, gaugeLines, parseArgs, use };
