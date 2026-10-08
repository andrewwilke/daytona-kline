'use strict';

const { KwpError, KwpNegativeResponse, FAILURE, SVC, hex } = require('./kwp');
const { idText } = require('./format');

const MODE = { LIVE_DATA: 0x01, STORED_DTCS: 0x03, CLEAR_DTCS: 0x04, PENDING_DTCS: 0x07 };

/** The ECU said nothing, or said no: the request is not served (as opposed to a link that is failing). */
const notServed = (e) => e instanceof KwpNegativeResponse || (e instanceof KwpError && e.kind === FAILURE.TIMEOUT);

const round2 = (n) => Math.round(n * 100) / 100;

// ---- The ECU unlock gate -----------------------------------------------------
// On an ISO 9141 session the 0x22 reads (switches, battery, gear), the sensor
// block, its probe and the ECU identity are refused until the connection is
// unlocked (src/unlock.js). The gate reads the connection's own unlock state;
// it never guesses from a refusal. Other session styles are not gated (and a
// connection with no session has nothing to gate: callers ask for the session
// first and fail as "not connected").
//
// needsUnlock is the one predicate. requireUnlock, lockedGauges and
// outputtests.unlockProblem are derived from it and cannot disagree with it:
// the only difference is that unlockProblem asks for `strict`, because an
// output test is a command, not a read, and wants the ECU actually unlocked
// whatever the session style.

class NeedsUnlockError extends Error {
  constructor(why) {
    super(why);
    this.name = 'NeedsUnlockError';
  }
}

/** Is `conn` a connected session of a style that is not gated (anything but ISO 9141)? */
const ungatedStyle = (conn) => conn.style != null && conn.style !== 'iso9141';

/**
 * null when gated reads may go ahead on `conn`, else a one-line reason: "needs the ECU unlock, not available (why)".
 * Gated reads go ahead when the connection is unlocked or its session is not ISO 9141. With
 * `strict` the session style gives no exemption: only an unlocked connection passes (for commands).
 */
function needsUnlock(conn, { strict = false } = {}) {
  if (conn.unlockState === 'unlocked') return null;
  if (!strict && conn.style !== 'iso9141') return null;
  const why = {
    // Off on a non-ISO session means the connection said so itself (see Connection._autoUnlock): its words are better than "no unlock.json".
    unavailable: ungatedStyle(conn) ? conn.unlockReason ?? 'unlock is off' : 'unlock is off: no unlock.json',
    invalid: conn.unlockReason,
    locked: 'not unlocked yet',
    unlocking: 'unlock in progress',
    failed: `unlock failed: ${conn.unlockReason}`,
  }[conn.unlockState] ?? conn.unlockState;
  return `needs the ECU unlock, not available (${why})`;
}

/** Throws NeedsUnlockError unless gated reads may go ahead on `conn`. */
function requireUnlock(conn) {
  const why = needsUnlock(conn);
  if (why) throw new NeedsUnlockError(why);
}

/**
 * Keys of the gauges in `defs` that are not read now: they need the unlock and the gate (needsUnlock) is
 * closed. With no session yet (the dashboard before connecting) the gate is asked strictly, so the
 * unlock-only dials say they wait for the unlock rather than looking readable.
 */
function lockedGauges(conn, defs = conn.bike.gauges) {
  return needsUnlock(conn, { strict: conn.style == null }) === null ? [] : defs.filter((d) => d.requiresUnlock).map((d) => d.key);
}

// ---- Mode 01 (SAE J1979 live data) ---------------------------------------

const FUEL_SYSTEM_BITS = [
  [1, 'open loop, insufficient temperature'],
  [2, 'closed loop'],
  [4, 'open loop, load/deceleration'],
  [8, 'open loop, system failure'],
  [16, 'closed loop with fault'],
];

/** PID 03 byte (a bitmask) in words. */
function fuelSystemText(code) {
  if (!code) return 'not reported';
  const words = FUEL_SYSTEM_BITS.filter(([bit]) => code & bit).map(([, w]) => w);
  const unknown = code & ~FUEL_SYSTEM_BITS.reduce((a, [bit]) => a | bit, 0);
  if (unknown) words.push(`unknown 0x${unknown.toString(16)}`);
  return words.join('; ');
}

/**
 * The mode 01 PIDs this tool can decode. `size` is how many data bytes a
 * reply carries; `value` turns them (A, B) into the number in `unit`; `text`
 * is a words form for PIDs that are a state rather than a measurement.
 * Formulas are SAE J1979; none of them has been compared with the dash on the
 * bike yet.
 */
const PIDS = {
  0x03: { name: 'fuel system status', size: 2, value: ([a]) => a, text: ([a, b]) => (b ? `${fuelSystemText(a)}; bank 2: ${fuelSystemText(b)}` : fuelSystemText(a)) },
  0x04: { name: 'engine load', unit: '%', size: 1, value: ([a]) => (a * 100) / 255 },
  0x05: { name: 'coolant temperature', unit: '°C', size: 1, value: ([a]) => a - 40 },
  0x06: { name: 'short-term fuel trim', unit: '%', size: 1, value: ([a]) => ((a - 128) * 100) / 128 },
  0x0b: { name: 'manifold pressure', unit: 'kPa', size: 1, value: ([a]) => a },
  0x0c: { name: 'engine speed', unit: 'rpm', size: 2, value: ([a, b]) => (256 * a + b) / 4 },
  0x0d: { name: 'vehicle speed', unit: 'km/h', size: 1, value: ([a]) => a },
  0x0e: { name: 'timing advance', unit: '°', size: 1, value: ([a]) => a / 2 - 64 },
  0x0f: { name: 'intake air temperature', unit: '°C', size: 1, value: ([a]) => a - 40 },
  0x11: { name: 'throttle position', unit: '%', size: 1, value: ([a]) => (a * 100) / 255 },
  0x14: { name: 'oxygen sensor 1', unit: 'V', size: 2, value: ([a]) => a / 200 },
};

/**
 * Decode the data bytes of a mode 01 reply (what readPid returns) into
 * { pid, name, value, unit, text? }. `text` is there for PIDs that have a
 * words form; for oxygen sensor 1 `trim` is the short-term trim in % carried
 * in the second byte, or null when the ECU marks it unused (0xFF). Throws for
 * a PID not in the table and for a reply shorter than the PID needs.
 */
function decodePid(pid, bytes) {
  const def = PIDS[pid];
  if (!def) throw new Error(`no decoder for mode 01 PID 0x${pid.toString(16)}`);
  if (bytes.length < def.size) {
    throw new Error(`PID 0x${pid.toString(16)} reply has ${bytes.length} data byte(s), needs ${def.size}`);
  }
  const out = { pid, name: def.name, value: def.value(bytes), unit: def.unit ?? '' };
  if (def.text) out.text = def.text(bytes);
  if (pid === 0x14) out.trim = bytes[1] === 0xff ? null : ((bytes[1] - 128) * 100) / 128;
  return out;
}

/**
 * Read one mode 01 PID. Resolves with its data bytes (after `41 <pid>`), or
 * null when the ECU does not serve it: no reply at all, or a refusal. It
 * throws only for a failing link (bad checksum, cut-off echo) or a reply that
 * is not for this PID. Silence does not count against the connection's
 * keep-alive, whose own request tells whether the ECU is still there.
 */
async function readPid(session, pid, { timeout } = {}) {
  try {
    const { payload } = await session.request([MODE.LIVE_DATA, pid], { timeout, allowSilence: true });
    if (payload[1] !== pid) throw new Error(`reply [${hex(payload)}] is not for PID 0x${pid.toString(16)}`);
    return payload.slice(2);
  } catch (e) {
    if (notServed(e)) return null;
    throw e;
  }
}

/**
 * The PIDs the ECU says it serves, as a Set of numbers. Reads PID 00 and, only
 * while the bitmap says the next range exists (PID 20, 40, ...), the following
 * ones. Throws if PID 00 itself goes unanswered: that is a dead link, not an
 * ECU with nothing to offer.
 */
async function supportedPids(session) {
  const set = new Set();
  for (let base = 0x00; base <= 0xc0; base += 0x20) {
    const bytes = await readPid(session, base);
    if (!bytes) {
      if (base === 0) throw new Error('the ECU did not answer mode 01 PID 00 (supported PIDs)');
      break;
    }
    if (bytes.length < 4) throw new Error(`PID 0x${base.toString(16)} bitmap has ${bytes.length} byte(s), needs 4`);
    for (let i = 0; i < 32; i++) {
      if (bytes[i >> 3] & (0x80 >> (i & 7))) set.add(base + 1 + i);
    }
    if (!set.has(base + 0x20)) break;
  }
  return set;
}

/**
 * Mode 01 PID 01 as { milOn, dtcCount, raw }: the warning light state and how
 * many stored codes the ECU says it has, to compare with what mode 03 gave.
 * null if the ECU does not serve it.
 */
async function readStatus(session) {
  const bytes = await readPid(session, 0x01);
  if (!bytes) return null;
  if (bytes.length < 4) throw new Error(`PID 01 reply has ${bytes.length} data byte(s), needs 4`);
  return { milOn: (bytes[0] & 0x80) !== 0, dtcCount: bytes[0] & 0x7f, raw: hex(bytes) };
}

/**
 * A bike's `gauges` entry applied to the data bytes of its PID or common id:
 * { value, raw, text? }. A PID gauge is the SAE formula times the entry's `scale`;
 * an id gauge (requiresUnlock) is the big-endian reply times `scale` plus `add`,
 * rounded down to a multiple of `step` if it has one, or for type 'bitpos' the
 * position of the highest set bit. Values are rounded to 2 decimals.
 */
function decodeGauge(def, bytes) {
  if (def.pid == null) {
    const raw = bytes.reduce((a, b) => a * 256 + b, 0);
    if (def.type === 'bitpos') return { value: raw ? raw.toString(2).length : 0, raw: [...bytes] };
    let value = raw * (def.scale ?? 1) + (def.add ?? 0);
    if (def.step) value = Math.floor(value / def.step) * def.step;
    return { value: round2(value), raw: [...bytes] };
  }
  const d = decodePid(def.pid, bytes);
  const out = { value: round2(d.value * (def.scale ?? 1)), raw: [...bytes] };
  if (def.type === 'text') out.text = d.text;
  return out;
}

/**
 * Read and decode one gauge. Returns null if the ECU does not serve it: no
 * answer to a PID, or a refusal (for an id gauge only a refusal; silence there
 * is a failing link and throws). An id gauge is only asked on an unlocked
 * connection: the caller checks (see lockedGauges).
 */
async function readGauge(session, def, { timeout } = {}) {
  if (def.pid != null) {
    const bytes = await readPid(session, def.pid, { timeout });
    return bytes ? decodeGauge(def, bytes) : null;
  }
  const { bytes } = await askId(session, def.id, { timeout: timeout ?? 600, allowSilence: false });
  return bytes?.length ? decodeGauge(def, bytes) : null;
}

// ---- Fault codes -----------------------------------------------------------

// An ISO 9141 ECU that is silent to this many options in a row is not going to
// serve the rest: stop instead of waiting out all of them.
const ID_GIVE_UP = 3;

/**
 * ReadEcuIdentification across the common option bytes. Each answer is
 * { option, hex, ascii }. On an ISO 9141 session, whose ECU serves this only
 * once unlocked (the caller checks, see needsUnlock), silence is "not served"
 * rather than a failure: it does not count against the link, and after
 * ID_GIVE_UP silent options in a row the read ends with what it has.
 */
async function readEcuId(session) {
  const results = [];
  const iso = session.style === 'iso9141';
  let silent = 0;
  for (const opt of [0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b]) {
    try {
      const { payload } = await session.request([SVC.ECU_ID, opt], { timeout: 800, retries: 0, allowSilence: iso });
      const data = payload.slice(2);
      const ascii = data.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      results.push({ option: opt, hex: hex(data), ascii });
      silent = 0;
    } catch (e) {
      if (e instanceof KwpNegativeResponse) {
        silent = 0;
      } else if (iso && e instanceof KwpError && e.kind === FAILURE.TIMEOUT) {
        if (++silent >= ID_GIVE_UP) break;
      } else {
        throw e;
      }
    }
  }
  return results;
}

/** Decode a 2-byte DTC into the standard P/C/B/U code string. */
function dtcToString(hi, lo) {
  const letters = ['P', 'C', 'B', 'U'];
  const letter = letters[(hi >> 6) & 0x03];
  const d1 = (hi >> 4) & 0x03;
  const d2 = hi & 0x0f;
  return `${letter}${d1}${d2.toString(16).toUpperCase()}${((lo >> 4) & 0x0f).toString(16).toUpperCase()}${(lo & 0x0f).toString(16).toUpperCase()}`;
}

/**
 * Every DTC result has this one shape, whichever protocol path produced it:
 *   { code: 'P0515', status: 'stored' | 'pending' | 'reported',
 *     statusByte: number | null, description: string | null }
 * `reported` is a KWP 0x18 entry, whose ECU status byte is in `statusByte`;
 * `description` is the bike's meaning of the code, null if it has none.
 */
const dtcEntry = (bike, code, status, statusByte = null) => ({
  code,
  status,
  statusByte,
  description: bike?.describeDtc(code) ?? null,
});

/**
 * OBD-II style DTC read (mode 03 stored / 07 pending): each reply is
 * 0x43|0x47 + three 2-byte codes, 00 00 = empty slot, and more codes arrive as
 * further reply frames. `allowSilence`: no reply at all is an answer (the
 * mode is not served) for the caller to interpret.
 */
async function readObdDtcs(session, bike, mode, { allowSilence = false } = {}) {
  const timeout = session.style === 'iso9141' ? undefined : 2000; // the session's own default: the bike answers within 300 ms
  const { frames } = await session.request([mode], { timeout, multiFrame: true, allowSilence });
  const dtcs = [];
  for (const f of frames) {
    for (let i = 1; i + 1 < f.length; i += 2) {
      if (f[i] === 0 && f[i + 1] === 0) continue;
      dtcs.push(dtcEntry(bike, dtcToString(f[i], f[i + 1]), mode === MODE.STORED_DTCS ? 'stored' : 'pending'));
    }
  }
  return { count: dtcs.length, dtcs, raw: frames.map(hex).join(' | ') };
}

/** readDiagnosticTroubleCodesByStatus. */
async function readKwpDtcs(session, bike) {
  const { payload: resp } = await session.request([SVC.READ_DTC_BY_STATUS, 0x00, 0x00, 0x00], { timeout: 2000 });
  const dtcs = [];
  for (let i = 0; i < resp[1]; i++) {
    const off = 2 + i * 3;
    if (off + 2 >= resp.length + 1) break;
    dtcs.push(dtcEntry(bike, dtcToString(resp[off], resp[off + 1]), 'reported', resp[off + 2]));
  }
  return { count: dtcs.length, dtcs, raw: hex(resp), pendingSupported: null };
}

async function readCodes(session, bike) {
  let stored;
  try {
    stored = await readObdDtcs(session, bike, MODE.STORED_DTCS);
  } catch (e) {
    // An ISO 9141 session speaks OBD-II only: a refusal there is the answer.
    if (!(e instanceof KwpNegativeResponse) || session.style === 'iso9141') throw e;
    return readKwpDtcs(session, bike);
  }
  let pending = { dtcs: [] };
  let pendingSupported = true;
  try {
    pending = await readObdDtcs(session, bike, MODE.PENDING_DTCS, { allowSilence: true });
  } catch (e) {
    if (!notServed(e)) throw e;
    pendingSupported = false;
  }
  const seen = new Set(stored.dtcs.map((d) => d.code));
  const dtcs = [...stored.dtcs, ...pending.dtcs.filter((d) => !seen.has(d.code))];
  return { count: dtcs.length, dtcs, raw: stored.raw, pendingSupported };
}

/**
 * Stored codes (mode 03) plus pending ones (mode 07), falling back to KWP 0x18
 * on an addressed session whose ECU refuses mode 03, and the warning light
 * state to go with them. Resolves with
 *   { count, dtcs, raw, pendingSupported, status }
 * see dtcEntry for each code; `pendingSupported` is false when mode 07 got no
 * answer (the Daytona does not serve it: that is not an error) and null when
 * the KWP fallback was used; `status` is readStatus() or null. Pass the bike
 * (src/bikes) to get descriptions.
 */
async function readDtcs(session, bike) {
  const result = await readCodes(session, bike);
  let status = null;
  try {
    status = await readStatus(session);
  } catch (e) {
    if (!(e instanceof KwpError)) throw e; // the codes are worth more than the light
  }
  return { ...result, status };
}

/** One line comparing the warning light and the ECU's stored-code count with the codes read (a result of readDtcs). */
function faultSummary({ dtcs, status }) {
  const read = dtcs.filter((d) => d.status !== 'pending').length;
  const plural = (n) => `${n} stored code${n === 1 ? '' : 's'}`;
  if (!status) return `${plural(read)} read; the ECU does not report its warning light or code count.`;
  const light = status.milOn ? 'Warning light ON' : 'Warning light off';
  if (status.dtcCount === read) return `${light}; the ECU reports ${plural(status.dtcCount)} and ${read} ${read === 1 ? 'was' : 'were'} read.`;
  return `${light}; the ECU reports ${plural(status.dtcCount)} but ${read} ${read === 1 ? 'was' : 'were'} read: the list may be incomplete.`;
}

/**
 * Erase the stored codes (mode 04; KWP 0x14 on an addressed session whose ECU
 * refuses it). Changes ECU state, so it is never resent: callers must have
 * the user's confirmation first.
 */
async function clearDtcs(session) {
  try {
    return (await session.request([MODE.CLEAR_DTCS], { timeout: 3000, destructive: true })).payload;
  } catch (e) {
    if (!(e instanceof KwpNegativeResponse) || session.style === 'iso9141') throw e;
  }
  return (await session.request([SVC.CLEAR_DTC, 0x00, 0x00], { timeout: 3000, destructive: true })).payload;
}

// ---- Advanced: the ECU's own data blocks and IDs ----------------------------
// The 2012 Daytona refuses service 0x22 (7F 33 36) until it is unlocked, and
// nothing shows it serves 0x21 even then. Callers gate these on needsUnlock().

/** Try one readDataByLocalIdentifier id. { hit: { id, length, hex } | null, why: null | 'refused' | 'silent' | 'failed' }. */
async function probeLocalId(session, id) {
  try {
    const { payload } = await session.request([SVC.READ_LOCAL_ID, id], { timeout: 500, retries: 0, allowSilence: true });
    return { hit: { id, length: payload.length - 2, hex: hex(payload.slice(2)) }, why: null };
  } catch (e) {
    if (e instanceof KwpNegativeResponse) return { hit: null, why: 'refused' };
    if (e instanceof KwpError && e.kind === FAILURE.TIMEOUT) return { hit: null, why: 'silent' };
    return { hit: null, why: 'failed' };
  }
}

/**
 * Probe readDataByLocalIdentifier across all 255 ids to find which blocks
 * this ECU serves (read-only service; unsupported ids just return a
 * negative response). Nothing in the tool itself calls this any more (the
 * probe run in liverun.js asks one id per cycle with probeLocalId); it is
 * kept only because test/connection.test.js drives a cancelled run with it.
 */
async function probeLocalIds(session, { from = 0x01, to = 0xff, onProgress, signal } = {}) {
  const found = [];
  for (let id = from; id <= to && !signal?.aborted; id++) {
    onProgress?.(id);
    const { hit } = await probeLocalId(session, id);
    if (hit) found.push(hit);
  }
  return found;
}

async function readLocalId(session, id, { timeout = 1200 } = {}) {
  const { payload } = await session.request([SVC.READ_LOCAL_ID, id], { timeout });
  return payload.slice(2); // strip 0x61 <id>
}

/**
 * readDataByCommonIdentifier (0x22): some ECUs serve each sensor and switch
 * under its own 2-byte ID. Returns the value bytes. The strict read: a refusal
 * throws KwpNegativeResponse and silence throws a timeout, unless `allowSilence`.
 * The tolerant reads (readIdBytes, readSwitches, readAnalog, probeCommonId) all go
 * through askId instead.
 */
async function readCommonId(session, id, { timeout = 800, allowSilence = false, retries = 0, background = false } = {}) {
  const { payload } = await session.request([0x22, (id >> 8) & 0xff, id & 0xff], { timeout, retries, allowSilence, background });
  return payload.slice(3); // strip 0x62 <id hi> <id lo>
}

/**
 * The one place that decides what "the ECU does not serve this 0x22 id" means.
 * Sends `22 hi lo` (resent `retries` times on silence, 0 by default) and says
 * what came back, as
 *   { payload, bytes, why: null }     the ECU answered: its whole reply and the data bytes after 62 hi lo
 *   { payload: null, bytes: null, why: 'refused' }   a negative response (7F)
 *   { payload: null, bytes: null, why: 'silent' }    no reply at all
 * Silence is "not served" only with `allowSilence` (the default), and then it
 * does not count against the link; without it silence is a failing link and
 * throws, as does anything else that is not a refusal (bad checksum, cut-off
 * echo). Callers decide what a refusal or silence means to them; they never
 * catch the errors themselves. `timeout` is the request's own default if omitted.
 */
async function askId(session, id, { timeout, retries = 0, allowSilence = true, background = false } = {}) {
  try {
    const { payload } = await session.request([0x22, (id >> 8) & 0xff, id & 0xff], { timeout, retries, allowSilence, background });
    return { payload, bytes: payload.slice(3), why: null };
  } catch (e) {
    if (e instanceof KwpNegativeResponse) return { payload: null, bytes: null, why: 'refused' };
    if (allowSilence && e instanceof KwpError && e.kind === FAILURE.TIMEOUT) return { payload: null, bytes: null, why: 'silent' };
    throw e;
  }
}

// A background read (the switch watcher's) must not hold the one K-line for long: a silent id costs the
// whole wait, and the dashboard's reads queue behind it. So its wait is short, and the "ask once more"
// for an id the ECU ignored is a separate request that goes back to the end of the queue, not a resend
// inside the first one.
const BACKGROUND_ID_TIMEOUT_MS = 350;

async function askIdInBackground(session, id) {
  const ask = () => askId(session, id, { timeout: BACKGROUND_ID_TIMEOUT_MS, retries: 0, background: true });
  const first = await ask();
  return first.why === 'silent' ? ask() : first;
}

/**
 * Read every common ID once. The ECU says no to an ID it does not have either
 * with a refusal or by staying silent, so both come back as null (silence does
 * not count against the link). Rows: { id, value, hex, bytes }.
 */
async function readSwitches(session, ids, { background = false } = {}) {
  const out = [];
  for (const id of ids) {
    // The ECU now and then ignores a request it would normally answer: ask once more before calling it silent.
    const { bytes } = background ? await askIdInBackground(session, id) : await askId(session, id, { timeout: 800, retries: 1 });
    if (!bytes) {
      out.push({ id, value: null, hex: 'n/a', bytes: [] });
      continue;
    }
    const v = [...bytes];
    out.push({ id, value: v.length ? v.reduce((a, b) => a * 256 + b, 0) : null, hex: hex(v), bytes: v });
  }
  return out;
}

/**
 * One 0x22 read whose silence or refusal means "not served here": the data
 * bytes, or null. Only a failing link (bad checksum, cut-off echo) throws.
 * Resent `retries` times on silence (0 by default); silence never counts against the link.
 */
async function readIdBytes(session, id, { timeout = 500, retries = 0, background = false } = {}) {
  const { bytes } = await askId(session, id, { timeout, retries, background });
  return bytes ? [...bytes] : null;
}

// ---- Switches (0x22 ids with two data bytes) -----------------------------------

/**
 * A bike's `switches` entry applied to the data bytes of its id: { active, raw }.
 * A plain id is active when its value is not zero (the low byte reads FF); an
 * `inverted` id is active when its low byte is 00. `active` is null when the
 * reply carried no data.
 */
function decodeSwitch(def, bytes) {
  const raw = [...bytes];
  if (!raw.length) return { active: null, raw };
  return { active: def.inverted ? raw[raw.length - 1] === 0x00 : raw.some((b) => b !== 0), raw };
}

/** The words for a switch state: the entry's own (Clutch: PULLED / RELEASED) or ON / OFF. */
function switchState(def, active) {
  if (active === null || active === undefined) return null;
  return active ? def.onText ?? 'ON' : def.offText ?? 'OFF';
}

/**
 * One switch tile for the page and the CLI. `def` is the bike's entry, or null for an id
 * the table does not name (then only the raw bytes are known).
 */
function describeSwitch(def, id, bytes) {
  const raw = [...bytes];
  const decoded = def && raw.length ? decodeSwitch(def, raw) : { active: null, raw };
  return {
    id,
    key: def?.key ?? null,
    named: !!def,
    name: def?.name ?? `ID ${idText(id)}`,
    inverted: !!def?.inverted,
    confirmation: def?.confirmation ?? null,
    evidence: def?.evidence ?? null,
    active: decoded.active,
    state: def ? switchState(def, decoded.active) : null,
    // The state that means trouble (a tripped tip-over sensor): the page shows it in red.
    bad: !!def?.bad && decoded.active !== null && decoded.active === (def.bad === 'on'),
    raw,
    hex: raw.length ? hex(raw) : 'n/a',
  };
}

/**
 * The rows of readSwitches as tiles: the ids the bike's table names first, in table
 * order, then the others by id.
 */
function switchTiles(bike, rows) {
  const byId = new Map(rows.filter((r) => r.value !== null).map((r) => [r.id, r]));
  const tile = (def, id) => ({ ...describeSwitch(def, id, byId.get(id).bytes), stale: !!byId.get(id).stale });
  const named = (bike.switches ?? []).filter((d) => byId.has(d.id)).map((d) => tile(d, d.id));
  const known = new Set((bike.switches ?? []).map((d) => d.id));
  const other = [...byId.keys()].filter((id) => !known.has(id)).sort((a, b) => a - b).map((id) => tile(null, id));
  return [...named, ...other];
}

/** Read and decode one of the bike's `analogs` (a voltage on a 0x22 id): { value, raw, hex } or null if not served. */
async function readAnalog(session, def, { timeout, background = false } = {}) {
  const read = background ? await askIdInBackground(session, def.id) : { bytes: await readIdBytes(session, def.id, { timeout, retries: 1 }) };
  const bytes = read.bytes ? [...read.bytes] : null;
  if (!bytes || !bytes.length) return null;
  return { ...decodeGauge(def, bytes), hex: hex(bytes) };
}

/** What the bike's description calls the 0x22 id (a switch, an id gauge or an analog), or null. */
function knownIdName(bike, id) {
  return bike.switches?.find((d) => d.id === id)?.name
    ?? bike.gauges?.find((d) => d.id === id)?.label
    ?? bike.analogs?.find((d) => d.id === id)?.label
    ?? null;
}

/** Every 0x22 id the bike's description names (switch list, id gauges, analogs). */
function knownIds(bike) {
  return [...new Set([
    ...(bike.switchIds ?? []),
    ...(bike.gauges ?? []).filter((d) => d.id != null).map((d) => d.id),
    ...(bike.analogs ?? []).map((d) => d.id),
  ])].sort((a, b) => a - b);
}

// ---- Find more IDs (read-only sweep of service 0x22) ---------------------------

/**
 * Ask one 0x22 id and say what came back: { hit: { id, bytes, hex, value } | null, why: null |
 * 'refused' | 'silent' }. Silence and refusals are "not served"; a failing link throws.
 * Sends nothing but 22 hi lo, once.
 */
async function probeCommonId(session, id, { timeout = 300 } = {}) {
  const { payload, bytes, why } = await askId(session, id, { timeout });
  if (why) return { hit: null, why };
  // A sweep reads many ids in a row, so a reply that is for another id would be taken as this one's value: refuse it.
  if (payload[1] !== ((id >> 8) & 0xff) || payload[2] !== (id & 0xff)) throw new Error(`reply [${hex(payload)}] is not for id 0x${id.toString(16)}`);
  return { hit: { id, bytes, hex: hex(bytes), value: bytes.length ? bytes.reduce((a, b) => a * 256 + b, 0) : null }, why: null };
}

/**
 * The ids whose value differs between two snapshots ({ id: { hex, value } } objects), each as
 * { id, name, before, after } with before / after the hex or null where the id was not answered.
 */
function diffSnapshots(a, b, bike) {
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].sort((x, y) => x - y);
  return ids
    .filter((id) => (a[id]?.hex ?? null) !== (b[id]?.hex ?? null))
    .map((id) => ({ id, name: bike ? knownIdName(bike, id) : null, before: a[id]?.hex ?? null, after: b[id]?.hex ?? null }));
}

/** Apply a field map (a bike's `sensorBlock`) to a raw sensor block. */
function decodeBlock(data, map) {
  const out = [];
  for (const f of map.fields) {
    let raw;
    if (f.type === 'u16') {
      if (f.offset + 1 >= data.length) continue;
      raw = data[f.offset] * 256 + data[f.offset + 1];
    } else {
      if (f.offset >= data.length) continue;
      raw = data[f.offset];
    }
    const value = raw * (f.scale ?? 1) + (f.add ?? 0);
    out.push({ name: f.name, value: Math.round(value * 100) / 100, unit: f.unit ?? '', raw, verified: !!f.verified });
  }
  return out;
}

module.exports = {
  NeedsUnlockError,
  needsUnlock,
  requireUnlock,
  lockedGauges,
  PIDS,
  readEcuId,
  readPid,
  decodePid,
  supportedPids,
  readStatus,
  readGauge,
  decodeGauge,
  readDtcs,
  faultSummary,
  clearDtcs,
  probeLocalId,
  probeLocalIds,
  readLocalId,
  readCommonId,
  readSwitches,
  readIdBytes,
  decodeSwitch,
  switchState,
  describeSwitch,
  switchTiles,
  readAnalog,
  knownIdName,
  knownIds,
  probeCommonId,
  diffSnapshots,
  decodeBlock,
  dtcToString,
};
