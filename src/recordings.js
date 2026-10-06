'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');
const NAME_RE = /^record-[A-Za-z0-9._-]+\.csv$/; // what the recorder writes; keeps a page from asking for any other file

/** Splits CSV text into rows of cells (quoted cells may hold commas, quotes and line breaks). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** The recordings in the log folder, newest first: { name, bytes, modified }. */
function listRecordings(logDir = DEFAULT_LOG_DIR) {
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => NAME_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(logDir, name));
      return { name, bytes: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified || (a.name < b.name ? 1 : -1));
}

/**
 * One recording as graph data: { name, durationMs, series: { key: [[t_ms, value], ...] },
 * events: [{ t_ms, text }], markers: [{ t_ms, text }] }. A cell that is blank (not read yet,
 * or not served) makes no point; the `_raw` columns are left out.
 */
function loadRecording(name, logDir = DEFAULT_LOG_DIR) {
  if (!NAME_RE.test(String(name))) throw new Error('not a recording file name');
  let text;
  try {
    text = fs.readFileSync(path.join(logDir, name), 'utf8');
  } catch {
    throw new Error(`no recording named ${name}`);
  }
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('the recording is empty');
  const header = rows[0];
  const iT = header.indexOf('t_ms');
  const iMarker = header.indexOf('marker');
  const iEvent = header.indexOf('event');
  if (iT < 0) throw new Error('not a recording: no t_ms column');
  const channels = header
    .map((key, i) => ({ key, i }))
    .filter(({ key }) => key !== 't_ms' && key !== 'cycle_ms' && key !== 'marker' && key !== 'event' && !key.endsWith('_raw'));
  const series = Object.fromEntries(channels.map(({ key }) => [key, []]));
  const events = [];
  const markers = [];
  let durationMs = 0;
  for (const row of rows.slice(1)) {
    const t = Number(row[iT]);
    if (!Number.isFinite(t)) continue;
    durationMs = Math.max(durationMs, t);
    for (const { key, i } of channels) {
      const cell = row[i];
      if (cell === undefined || cell === '') continue;
      const v = Number(cell);
      if (Number.isFinite(v)) series[key].push([t, v]);
    }
    if (iMarker >= 0 && row[iMarker]) markers.push({ t_ms: t, text: row[iMarker] });
    if (iEvent >= 0 && row[iEvent]) for (const e of row[iEvent].split('; ')) events.push({ t_ms: t, text: e });
  }
  for (const key of Object.keys(series)) if (!series[key].length) delete series[key];
  return { name, durationMs, series, events, markers };
}

module.exports = { listRecordings, loadRecording, parseCsv, NAME_RE };
