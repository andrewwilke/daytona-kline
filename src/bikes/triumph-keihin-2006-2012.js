'use strict';

// Everything specific to the Triumph Keihin ECUs (2006-2012 Daytona 675 and
// the other triples of that generation). Generic modules read this through
// defineBike() in ./index.js and never hard-code any of it.

// On/off states (clutch, relays, switches) live in this ID range
// (readDataByCommonIdentifier, 0x22), two data bytes [hi, lo] each. These ids
// are refused (7F 33 36) until the ECU is unlocked, hence switchesRequireUnlock:
// the switch monitor only runs on an unlocked connection. Mode 01 has no switch PIDs.
// The ids stay silent (no reply, not a refusal) on this ECU for 0x43, 0x45 and
// 0x65, which other tools list: they are left out so the monitor does not wait
// for them. 0x61 and 0x68 are answered only now and then.
// Decoding (decodeSwitch in src/services.js): a plain id is active when its
// value is not zero, an `inverted` one when its low byte is 00; onText /
// offText are the words for the two states. `confirmation` says how far the
// label is trusted: 'confirmed' (watched flipping on the bike when that input
// was operated), 'consistent' (what the bike showed fits, the input itself not
// yet operated on its own) or 'unconfirmed' (a label from another tool's
// tables). `evidence` is the note of how it was seen on the bike. A label is
// only raised to 'confirmed' after toggling the input on a bike (see CONTRIBUTING.md).
const switches = [
  { id: 0x40, key: 'neutral', name: 'Neutral', inverted: true, onText: 'IN NEUTRAL', offText: 'IN GEAR', confirmation: 'consistent', evidence: 'the dash N lamp; reads 00 00 with the bike in neutral' },
  { id: 0x41, key: 'clutch', name: 'Clutch', inverted: true, onText: 'PULLED', offText: 'RELEASED', confirmation: 'consistent', evidence: '00 ff with the lever released, 00 00 pulled; seen flipping while shifting and starting, the lever alone not tested yet' },
  { id: 0x46, key: 'startSwitch', name: 'Start switch', onText: 'PRESSED', offText: 'RELEASED', confirmation: 'confirmed', evidence: '00 00 -> 00 ff when the starter button is pressed' },
  { id: 0x60, key: 'fuelPump', name: 'Fuel pump', confirmation: 'confirmed', evidence: '00 00 -> 00 ff at key-on (the prime)' },
  { id: 0x69, key: 'mainRelay', name: 'Main relay', confirmation: 'consistent', evidence: 'reads 00 ff with the key on; not seen switching' },
  { id: 0x42, key: 'sidestand', name: 'Sidestand', onText: 'DOWN', offText: 'UP', confirmation: 'confirmed', evidence: 'named by the owner: 00 00 -> 00 ff when the stand was lowered (00 ff = down, 00 00 = up)' },
  { id: 0x44, key: 'warningLamp', name: 'Dash alive (flag 0x44)', onText: 'DASH ON', offText: 'DASH OFF', confirmation: 'unconfirmed', evidence: 'the other tool draws it as a dash lamp, but on the owner\'s bike it reads 00 ff with the dash working and 00 00 with the alarm bypass cap unplugged and again when the dash would not power up with the key on and the ECU alive: it follows the dash\'s power, together with 0x61' },
  { id: 0x61, key: 'engineLamp', name: 'Dash alive (flag 0x61)', onText: 'DASH ON', offText: 'DASH OFF', confirmation: 'unconfirmed', evidence: 'the other tool draws it as the engine lamp, but on the owner\'s bike it reads 00 ff with the dash working and 00 00 with the alarm bypass cap unplugged and when the dash would not power up with the key on: it follows the dash\'s power, together with 0x44. The ECU answers it only now and then' },
  { id: 0x62, key: 'dashLamp62', name: 'Dash lamp (id 0x62)', confirmation: 'unconfirmed', evidence: 'another dash lamp in the other tool\'s table; not tested' },
  // The other tool's table labels 0x63 'start relay', which is wrong on this bike.
  { id: 0x63, key: 'tipOver', name: 'Tip-over sensor', onText: 'NOT TRIPPED', offText: 'TRIPPED', bad: 'off', confirmation: 'confirmed', evidence: 'the owner traced the intermittent no-start and cut-out to the tip-over sensor and identified this tile as it: 00 ff = enabled and good, the ECU lets the bike start; 00 00 = tripped, it will not. The recorder used to read it only once a minute, so brief trips were never caught' },
  { id: 0x68, key: 'dashLamp68', name: 'Dash lamp (id 0x68)', confirmation: 'unconfirmed', evidence: 'a dash lamp in the other tool\'s table; answers only now and then; not tested' },
  { id: 0x64, key: 'o2Heater', name: 'O2 sensor heater', confirmation: 'unconfirmed', evidence: 'label from the other tool\'s table; not tested' },
  { id: 0x66, key: 'secondaryAir', name: 'Secondary air (SAI)', inverted: true, confirmation: 'unconfirmed', evidence: 'label from the other tool\'s table; not tested' },
  { id: 0x70, key: 'airFlap', name: 'Air flap', confirmation: 'unconfirmed', evidence: 'label from the other tool\'s table; not tested' },
];

// The output tests: the ONLY things this tool ever commands the ECU to do besides
// clearing codes, and the complete whitelist (src/outputtests.js looks a test up
// here by key and sends nothing that is not in this table). `routine` is the one
// parameter byte of the test request; `needsStop` is true only for a test that
// runs until it is stopped (the idle speed control stepper), every other test ends
// by itself. `effectId` is the 0x22 id expected to change while the test runs (null
// when there is none to watch). `confirmation` and `evidence` follow the switch table:
// nothing here has been run on a bike yet. No injector or coil tests (this ECU has
// none), no throttle motor, and none of the adjust / reset routines (they change
// stored values): do not add them (see CONTRIBUTING.md).
const outputTests = [
  { key: 'tachometer', name: 'Tachometer', routine: 0x01, needsStop: false, see: 'The tach needle sweeps.', safety: 'Only the dash needle moves.', effectId: null, confirmation: 'confirmed', evidence: "ran on the owner's 2012 Daytona: the tach needle moved" },
  { key: 'coolingFan', name: 'Cooling fan', routine: 0x06, needsStop: false, see: 'The fan spins.', safety: 'Keep hands, tools and cables clear of the fan: it can start without warning.', effectId: null, confirmation: 'confirmed', evidence: "ran on the owner's 2012 Daytona: the fan spun" },
  { key: 'fuelPump', name: 'Fuel pump', routine: 0x04, needsStop: false, see: 'You hear the pump run for a few seconds, and the Fuel pump switch (id 0x60) turns on.', safety: 'Only with fuel in the tank (a pump run dry is damaged), and only for the few seconds it runs.', effectId: 0x60, confirmation: 'confirmed', evidence: "ran on the owner's 2012 Daytona: the pump ran" },
  { key: 'idleSpeedControl', name: 'Idle speed control', routine: 0x02, needsStop: true, see: 'You may hear the idle speed stepper motor move.', safety: 'This test runs until it is stopped: the tool sends the stop when the watch ends (15 s) or when you press Stop (Ctrl+C in the CLI).', effectId: null, confirmation: 'consistent', evidence: "ran on the owner's 2012 Daytona and was heard working; the stepper was not seen moving" },
  { key: 'purgeValve', name: 'Purge control valve', routine: 0x03, needsStop: false, see: 'You hear the purge valve click or buzz.', safety: 'Only the valve solenoid is driven.', effectId: null, confirmation: 'unconfirmed', evidence: "nothing to hear on the owner's 2012 Daytona: the part is probably removed from that bike; untested elsewhere" },
  { key: 'secondaryAir', name: 'Secondary air injection (SAI)', routine: 0x0a, needsStop: false, see: 'You hear the secondary air valve click or buzz.', safety: 'Only the air injection valve is driven.', effectId: null, confirmation: 'unconfirmed', evidence: "nothing to hear on the owner's 2012 Daytona: the part is probably removed from that bike; untested elsewhere" },
  { key: 'airFlap', name: 'Air flap', routine: 0x0c, needsStop: false, see: 'The air flap moves; you can hear its actuator.', safety: 'Keep fingers and cables clear of the flap and its linkage.', effectId: null, confirmation: 'consistent', evidence: "ran on the owner's 2012 Daytona and was heard working; the flap was not seen moving" },
  { key: 'exhaustValve', name: 'Exhaust valve', routine: 0x0d, needsStop: false, see: 'The exhaust valve cable moves (the exhaust butterfly servo pulls and releases it).', safety: 'Keep hands and cables clear of the servo and the valve cable: it moves with force.', effectId: null, confirmation: 'unconfirmed', evidence: "nothing to hear on the owner's 2012 Daytona: the servo is probably removed from that bike, which would also explain fault P0078; untested elsewhere" },
];

module.exports = {
  id: 'triumph-keihin-2006-2012',
  name: 'Triumph Daytona 675 (2006-2012, Keihin)',

  // Wake-up attempts, tried after the saved one, in this order. Verified on a
  // real 2012 Daytona 675: fast init (25 ms pulse, StartCommunication) is
  // silent every time, while a slow init to 0x33 works (KB1 = KB2 = 0x08 and
  // ISO 9141-2 OBD-II framing afterwards) but the ECU answers only about one
  // try in three, so it gets 6 tries. The fast attempts stay as a fallback for
  // other ECUs of the family: target 0xD5 with the tester calling itself 0xF5
  // (the Triumph pair other tools use), and the OBD-style functional request
  // C1 33 F1 81.
  wake: {
    attempts: [
      { kind: 'slow', address: 0x33, tries: 6 },
      { target: 0xd5, source: 0xf5, addrMode: 'phys' },
      { target: 0x33, addrMode: 'func' },
    ],
  },

  // Manufacturer diagnostic session some ECUs of the family want before serving
  // data (StartDiagnosticSession 10 80); harmless if refused. Only sent on
  // addressed (KWP2000) sessions, never in the ISO 9141 framing of the 2012 bike.
  diagSession: 0x80,

  // Advanced, not the main path (the dashboard uses the gauges below): the
  // readDataByLocalIdentifier block holding every sensor in one response. The
  // 2012 bike is not known to serve it; the tool only tries once the ECU is
  // unlocked (the other reads of this kind are refused until then).
  // Starting guess for a fresh install: `probe` finds the real one and saves
  // it to config.json, and a CLI --id flag overrides both.
  dataBlockId: 0x80,

  // Layout of the sensor block above. Offsets are 0-based into the data
  // AFTER the leading 0x61 <id> bytes are stripped; value = raw * scale + add
  // and u16 is high*256+low. Only fields marked verified:true have been
  // confirmed on a real bike. The TPS entry follows a forum report that the
  // Triumph block resembles Suzuki SDS, with throttle as the 3rd value scaled
  // /51: treat it as a starting guess. Use `watch` to find the rest, then add
  // fields here.
  sensorBlock: {
    fields: [
      { name: 'TPS', offset: 4, type: 'u16', scale: 0.0196078, unit: '%', verified: false },
    ],
  },

  // Dashboard gauges: standard OBD-II mode 01 PIDs (SAE J1979), which this ECU
  // serves without any unlock (the supported ones are listed by PID 00, and the
  // dashboard reads that list before polling). `pid` picks the PID and its
  // formula (src/services.js); `scale` converts the unit, here kPa to hPa for
  // the manifold pressure. The formulas have NOT been compared with the dash on
  // this bike yet: every gauge shows 'unverified' until verified is set to
  // true. `fast` gauges are polled every cycle, the rest take turns; type
  // 'text' is a state shown in words, not a dial. Battery voltage (PID 42) and
  // gear are not served by mode 01: see the requiresUnlock gauges at the end.
  gauges: [
    { key: 'rpm', label: 'Engine', pid: 0x0c, unit: 'rpm', min: 0, max: 14000, redline: 13000, fast: true, verified: false },
    { key: 'speed', label: 'Speed', pid: 0x0d, scale: 0.621371, unit: 'mph', min: 0, max: 180, verified: false },
    { key: 'tps', label: 'Throttle', pid: 0x11, unit: '%', min: 0, max: 100, fast: true, verified: false },
    { key: 'map', label: 'Manifold pressure', pid: 0x0b, scale: 10, unit: 'hPa', min: 0, max: 1100, verified: false },
    { key: 'coolant', label: 'Coolant', pid: 0x05, unit: '°C', min: -20, max: 120, redline: 105, verified: false },
    { key: 'airtemp', label: 'Intake air', pid: 0x0f, unit: '°C', min: -20, max: 80, verified: false },
    { key: 'load', label: 'Engine load', pid: 0x04, unit: '%', min: 0, max: 100, verified: false },
    { key: 'timing', label: 'Timing advance', pid: 0x0e, unit: '°', min: -10, max: 50, verified: false },
    { key: 'trim', label: 'Short-term fuel trim', pid: 0x06, unit: '%', min: -25, max: 25, verified: false },
    { key: 'fuelSystem', label: 'Fuel system', pid: 0x03, type: 'text', unit: '', verified: false },
    // Unlock-only gauges (requiresUnlock): readDataByCommonIdentifier (0x22) with
    // a 2-byte `id` instead of a `pid`. This ECU refuses every 0x22 request
    // (7F 33 36) until it is unlocked with security access, so they are polled
    // only while the connection is unlocked (src/unlock.js). The value is the
    // big-endian reply times `scale`; type 'bitpos' reports the position of the
    // highest set bit (gear, 0 = neutral). The ids and formulas come from other
    // tools and are not confirmed on this bike.
    { key: 'battery', label: 'Battery', id: 7, scale: 0.1, unit: 'V', min: 8, max: 16, requiresUnlock: true, verified: false },
    { key: 'gear', label: 'Gear', id: 33, type: 'bitpos', unit: '', requiresUnlock: true, verified: false },
  ],

  switches,
  switchIds: switches.map((s) => s.id),
  switchesRequireUnlock: true,

  // Voltages on 0x22 ids, shown as small tiles next to the switches (not dials).
  // value = the 16-bit big-endian reply times `scale`. Both come from the other
  // tool's table and are unconfirmed: `note` says how to confirm them. The ECU
  // may stay silent on them, then they are not available.
  analogs: [
    { key: 'sidestandV', label: 'Sidestand sensor', id: 0x26, scale: 1 / 51, unit: 'V', requiresUnlock: true, verified: false, note: 'To confirm: watch this while lifting and lowering the sidestand.' },
    { key: 'rolloverV', label: 'Rollover (tip-over) switch', id: 0x28, scale: 4.887 / 1000, unit: 'V', requiresUnlock: true, verified: false, note: 'To confirm: engine off, key on, tilt the bike and watch this.' },
    // Recorded only (`panel: false`: not tiles in the Switches panel, which would slow its scan).
    // They show whether the ECU commands fuel and spark while the engine cranks: the injection
    // pulse is raw/1000 ms, the ignition timing raw/2 - 64 degrees. Ids and formulas are from the
    // other tool's table, unconfirmed; the pulse should read 0 with the engine off and a few ms
    // while it cranks or runs.
    // The ECU's own engine speed (id 0x100): raw * 0.25 rpm, rounded down to a multiple of 10
    // (decodeGauge `step`). The OBD rpm (PID 0C) may not report cranking speed; this one may.
    { key: 'rpmId', label: 'Engine speed (ECU id 0x100)', id: 0x100, scale: 0.25, step: 10, unit: 'rpm', panel: false, requiresUnlock: true, verified: false },
    { key: 'injPulse1', label: 'Injection pulse, cylinder 1', id: 0x110, scale: 0.001, unit: 'ms', panel: false, requiresUnlock: true, verified: false },
    { key: 'injPulse2', label: 'Injection pulse, cylinder 2', id: 0x111, scale: 0.001, unit: 'ms', panel: false, requiresUnlock: true, verified: false },
    { key: 'injPulse3', label: 'Injection pulse, cylinder 3', id: 0x112, scale: 0.001, unit: 'ms', panel: false, requiresUnlock: true, verified: false },
    { key: 'ignTiming1', label: 'Ignition timing, cylinder 1', id: 0x120, scale: 0.5, add: -64, unit: '°', panel: false, requiresUnlock: true, verified: false },
    { key: 'ignTiming2', label: 'Ignition timing, cylinder 2', id: 0x121, scale: 0.5, add: -64, unit: '°', panel: false, requiresUnlock: true, verified: false },
    { key: 'ignTiming3', label: 'Ignition timing, cylinder 3', id: 0x122, scale: 0.5, add: -64, unit: '°', panel: false, requiresUnlock: true, verified: false },
  ],

  outputTests,

  // Fault code meanings (common Triumph/Keihin codes). The P1xxx ones are
  // Triumph-specific; only confirmed meanings belong there.
  dtcs: {
    P0107: 'MAP sensor low', P0108: 'MAP sensor high', P0112: 'Intake air temp low', P0113: 'Intake air temp high',
    P0117: 'Coolant temp sensor low', P0118: 'Coolant temp sensor high', P0122: 'TPS low', P0123: 'TPS high',
    P0131: 'O2 sensor low', P0132: 'O2 sensor high', P0201: 'Injector 1 circuit', P0202: 'Injector 2 circuit',
    P0203: 'Injector 3 circuit', P0230: 'FUEL PUMP circuit', P0335: 'Crank position sensor', P0351: 'Ignition coil 1',
    P0352: 'Ignition coil 2', P0353: 'Ignition coil 3', P0505: 'Idle speed control', P0560: 'System voltage',
    P0654: 'Tacho output', P0078: 'Exhaust valve actuator circuit', P0705: 'Gear position sensor',
    P1632: 'TIP-OVER (fall detection) sensor circuit high or open',
    P1508: 'IMMOBILISER: ECU and immobiliser not matched',
    P1650: 'IMMOBILISER/ALARM: ECU lost communication with the immobiliser',
  },
};
