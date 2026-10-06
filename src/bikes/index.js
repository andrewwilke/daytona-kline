'use strict';

/**
 * A bike description is a plain object (see triumph-keihin-2006-2012.js for
 * the fields). defineBike() checks the required ones, fills in empty defaults
 * and adds describeDtc(code), which returns the meaning or null.
 */
const CONFIRMATION = ['confirmed', 'consistent', 'unconfirmed'];

function defineBike(desc) {
  for (const key of ['id', 'name', 'dataBlockId']) {
    if (desc[key] == null) throw new Error(`bike description is missing "${key}"`);
  }
  const dtcs = desc.dtcs ?? {};
  for (const a of desc.wake?.attempts ?? []) {
    if (a.kind === 'slow' ? a.address == null : a.target == null) {
      throw new Error(`wake attempt ${JSON.stringify(a)} needs ${a.kind === 'slow' ? 'an address' : 'a target'}`);
    }
  }
  for (const g of desc.gauges ?? []) {
    // A mode 01 PID, or a 0x22 common id, which this kind of ECU only serves once unlocked.
    if (g.key == null || (g.pid == null && !(g.id != null && g.requiresUnlock))) {
      throw new Error(`gauge ${JSON.stringify(g)} needs a key and a PID (or an id with requiresUnlock)`);
    }
  }
  const seen = new Set();
  for (const s of desc.switches ?? []) {
    if (s.id == null || s.key == null || s.name == null || !CONFIRMATION.includes(s.confirmation)) {
      throw new Error(`switch ${JSON.stringify(s)} needs an id, a key, a name and a confirmation (${CONFIRMATION.join(' | ')})`);
    }
    if (seen.has(s.id)) throw new Error(`switch id 0x${s.id.toString(16)} is listed twice`);
    seen.add(s.id);
  }
  for (const a of desc.analogs ?? []) {
    if (a.key == null || a.id == null || a.scale == null) throw new Error(`analog ${JSON.stringify(a)} needs a key, an id and a scale`);
  }
  const testKeys = new Set();
  const routines = new Set();
  for (const t of desc.outputTests ?? []) {
    const ok = typeof t.key === 'string' && t.key && typeof t.name === 'string' && Number.isInteger(t.routine) && t.routine >= 0 && t.routine <= 0xff &&
      typeof t.needsStop === 'boolean' && typeof t.see === 'string' && typeof t.safety === 'string' && CONFIRMATION.includes(t.confirmation) &&
      (t.effectId === null || Number.isInteger(t.effectId));
    if (!ok) {
      throw new Error(`output test ${JSON.stringify(t)} needs a key, a name, a routine byte, needsStop, a see and a safety text, an effectId (or null) and a confirmation (${CONFIRMATION.join(' | ')})`);
    }
    if (testKeys.has(t.key)) throw new Error(`output test "${t.key}" is listed twice`);
    if (routines.has(t.routine)) throw new Error(`output test routine 0x${t.routine.toString(16)} is listed twice`);
    testKeys.add(t.key);
    routines.add(t.routine);
  }
  return {
    diagSession: null,
    sensorBlock: { fields: [] },
    gauges: [],
    switches: [],
    analogs: [],
    outputTests: [],
    switchesRequireUnlock: false,
    ...desc,
    switchIds: desc.switchIds ?? (desc.switches ?? []).map((s) => s.id),
    wake: { attempts: [], ...desc.wake },
    dtcs,
    describeDtc: (code) => dtcs[String(code).toUpperCase()] ?? null,
  };
}

/**
 * The one precedence rule for the sensor data block id: what the bike
 * defaults to, overridden by what probe found and saved in config.json,
 * overridden by an explicit flag. `saved` and `flag` may be undefined.
 */
function resolveDataBlockId(bike, { saved, flag } = {}) {
  return flag ?? saved ?? bike.dataBlockId;
}

const DEFAULT_BIKE = defineBike(require('./triumph-keihin-2006-2012'));

module.exports = { defineBike, resolveDataBlockId, DEFAULT_BIKE, CONFIRMATION };
