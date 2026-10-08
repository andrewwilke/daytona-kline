'use strict';

const fs = require('fs');
const path = require('path');

// The project's logs folder: the one place that names it. Everything that writes or lists logs
// (runs, recordings, the id sweep) defaults to this.
const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');

/** A time as it appears in a log file name: the ISO text with ':' and '.' made file-safe. */
const logStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

const NUMBERED_NAME_TRIES = 99;

/**
 * One log file, as a module: it knows how a file is opened without overwriting anything, how big
 * it may get and when it is closed, and nothing about what is written into it. Callers hand it
 * finished lines of text.
 *
 *   const sink = openLogSink({ dir, prefix: 'run', stamp: logStamp(now), maxBytes, onError });
 *   sink.header('time,rpm,raw');        // once, at the top
 *   sink.row('2026-...,3000,0c=3e 80'); // one line per call; false when it was not written
 *   sink.close('last words');           // optionally one closing line, then the file is closed
 *
 * Interface (what a caller must know):
 *   openLogSink(options)  Throws if the file cannot be opened. Options:
 *       dir, prefix, stamp, ext   a NEW file `<dir>/<prefix>-<stamp><ext>` (ext default '.csv'); if
 *                                 that name exists, `<prefix>-<stamp>-2<ext>`, -3 ... up to 99, so
 *                                 a file is never overwritten or appended to by accident. The
 *                                 folder is created when missing.
 *       file                      instead of the above: append to exactly this file (created
 *                                 with its folders if missing), for a caller that names the file.
 *       maxBytes                  rows that would take the file past this size are refused
 *                                 (default: no limit).
 *       onError(error)            called once if a write fails, with Error('log write failed: ...');
 *                                 the sink has closed itself by then.
 *   sink.path, sink.bytes (written so far, header and closing line included, still readable after
 *   close), sink.isOpen, sink.capped (a row was refused for the size limit; sticky),
 *   sink.headerWritten, sink.error (the Error of a failed write, else null).
 *   sink.header(line)   Writes the line the first time only, and not subject to the size limit
 *                       (a file that cannot hold its header is not worth opening).
 *   sink.row(line)      Appends the line plus a newline. Returns true when written. False when the
 *                       sink is closed, when a write failed, or when the line would pass `maxBytes`
 *                       (then `capped` is set and the file stays as it is; a later, shorter line
 *                       that still fits is written).
 *   sink.close(last)    Writes `last` like `row` if given, then closes. Safe to call twice.
 *
 * Ordering: header before rows; nothing is written after close. A failed write never throws
 * to the caller: it closes the sink, sets `error` and calls `onError` once.
 */
class LogSink {
  constructor(fd, file, { maxBytes = Infinity, onError } = {}) {
    this._fd = fd;
    this._maxBytes = maxBytes;
    this._onError = onError;
    this.path = file;
    this.bytes = 0;
    this.capped = false;
    this.headerWritten = false;
    this.error = null;
  }

  get isOpen() {
    return this._fd !== null;
  }

  header(line) {
    if (this.headerWritten) return false;
    const ok = this._append(`${line}\n`);
    this.headerWritten = ok;
    return ok;
  }

  row(line) {
    const text = `${line}\n`;
    if (this._fd === null) return false;
    if (this.bytes + Buffer.byteLength(text) > this._maxBytes) {
      this.capped = true;
      return false;
    }
    return this._append(text);
  }

  close(last) {
    if (last !== undefined) this.row(last);
    this._closeFd();
  }

  _append(text) {
    if (this._fd === null) return false;
    try {
      fs.writeSync(this._fd, text);
    } catch (e) {
      this.error = new Error(`log write failed: ${e.message}`);
      this._closeFd();
      if (this._onError) this._onError(this.error);
      return false;
    }
    this.bytes += Buffer.byteLength(text);
    return true;
  }

  _closeFd() {
    if (this._fd === null) return;
    try {
      fs.closeSync(this._fd);
    } catch {
      // nothing more to do for a file that will not close
    }
    this._fd = null;
  }
}

function openLogSink({ dir, prefix, stamp, ext = '.csv', file, maxBytes, onError } = {}) {
  if (file != null) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    return new LogSink(fs.openSync(file, 'a'), file, { maxBytes, onError });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${prefix}-${stamp}${n > 1 ? `-${n}` : ''}${ext}`);
    try {
      return new LogSink(fs.openSync(candidate, 'wx'), candidate, { maxBytes, onError }); // never over an earlier log
    } catch (e) {
      if (e.code !== 'EEXIST' || n >= NUMBERED_NAME_TRIES) throw e;
    }
  }
}

module.exports = { openLogSink, logStamp, DEFAULT_LOG_DIR };
