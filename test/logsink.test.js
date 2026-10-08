'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openLogSink, logStamp, DEFAULT_LOG_DIR } = require('../src/logsink');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ecu-sink-'));
const text = (sink) => fs.readFileSync(sink.path, 'utf8');

test('the default log directory is the project\'s logs folder, defined here', () => {
  assert.equal(DEFAULT_LOG_DIR, path.join(__dirname, '..', 'logs'));
  for (const file of ['liverun', 'recorder', 'recordings', 'discover']) {
    assert.ok(!/DEFAULT_LOG_DIR\s*=\s*path\.join/.test(fs.readFileSync(path.join(__dirname, '..', 'src', `${file}.js`), 'utf8')), `${file}.js does not define its own`);
  }
});

test('logStamp is the ISO time with the characters a file name cannot have replaced', () => {
  assert.equal(logStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '2026-01-02T03-04-05-006Z');
});

test('a new file is created in a missing folder under <prefix>-<stamp>.csv: header, then one line per row, then closed', () => {
  const dir = path.join(scratch(), 'a', 'logs');
  const sink = openLogSink({ dir, prefix: 'run', stamp: '2026-01-01T00-00-00-000Z' });
  assert.equal(sink.path, path.join(dir, 'run-2026-01-01T00-00-00-000Z.csv'));
  assert.equal(sink.isOpen, true);
  assert.equal(sink.header('a,b'), true);
  assert.equal(sink.row('1,2'), true);
  assert.equal(sink.row('3,4'), true);
  assert.equal(text(sink), 'a,b\n1,2\n3,4\n');
  assert.equal(sink.bytes, 12);
  sink.close();
  assert.equal(sink.isOpen, false);
  assert.equal(sink.row('5,6'), false, 'nothing is written after close');
  assert.equal(text(sink), 'a,b\n1,2\n3,4\n');
  assert.equal(sink.bytes, 12, 'the size is still readable after close');
  sink.close(); // twice is fine
});

test('the header is written once only', () => {
  const sink = openLogSink({ dir: scratch(), prefix: 'x', stamp: 's' });
  assert.equal(sink.headerWritten, false);
  assert.equal(sink.header('h'), true);
  assert.equal(sink.headerWritten, true);
  assert.equal(sink.header('again'), false);
  sink.row('r');
  sink.close();
  assert.equal(text(sink), 'h\nr\n');
});

test('an existing file is never overwritten or appended to: the name gets a number', () => {
  const dir = scratch();
  const opts = { dir, prefix: 'record', stamp: 'T' };
  const a = openLogSink(opts);
  a.row('first');
  const b = openLogSink(opts);
  const c = openLogSink(opts);
  assert.deepEqual([a, b, c].map((s) => path.basename(s.path)), ['record-T.csv', 'record-T-2.csv', 'record-T-3.csv']);
  b.row('second');
  for (const s of [a, b, c]) s.close();
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first\n');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'second\n');
  assert.equal(fs.readFileSync(c.path, 'utf8'), '');
});

test('the extension can differ, and it gives up after 99 names', () => {
  const dir = scratch();
  const first = openLogSink({ dir, prefix: 'n', stamp: 'T', ext: '.txt' });
  assert.equal(path.basename(first.path), 'n-T.txt');
  first.close();
  const sinks = [];
  for (let i = 0; i < 99; i++) sinks.push(openLogSink({ dir, prefix: 'many', stamp: 'T' }));
  assert.throws(() => openLogSink({ dir, prefix: 'many', stamp: 'T' }), (e) => e.code === 'EEXIST');
  for (const s of sinks) s.close();
});

test('an explicit file is appended to, its folders created', () => {
  const file = path.join(scratch(), 'deep', 'er', 'mine.csv');
  const a = openLogSink({ file });
  assert.equal(a.path, file);
  a.row('one');
  a.close();
  const b = openLogSink({ file });
  b.row('two');
  b.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n');
});

test('the byte cap refuses a row that would pass it, keeps the file as it is, and still takes a shorter row that fits', () => {
  const sink = openLogSink({ dir: scratch(), prefix: 'cap', stamp: 'T', maxBytes: 20 });
  assert.equal(sink.header('0123456789'), true); // 11 bytes; the header is not subject to the cap
  assert.equal(sink.row('abcdefgh'), true); // 9 more: 20 exactly
  assert.equal(sink.capped, false);
  assert.equal(sink.row('x'), false); // 2 more would be 22
  assert.equal(sink.capped, true);
  assert.equal(sink.bytes, 20);
  assert.equal(sink.isOpen, true, 'a refused row does not close the file');
  sink.close();
  assert.equal(text(sink), '0123456789\nabcdefgh\n');
  assert.ok(sink.bytes <= 20);
});

test('the cap counts bytes, not characters', () => {
  const sink = openLogSink({ dir: scratch(), prefix: 'cap', stamp: 'T', maxBytes: 5 });
  assert.equal(sink.row('éé'), true); // 4 bytes + newline
  assert.equal(sink.row(''), false);
  assert.equal(sink.capped, true);
  sink.close();
});

test('close(last) writes one closing line (subject to the cap like a row), then closes', () => {
  const sink = openLogSink({ dir: scratch(), prefix: 'c', stamp: 'T' });
  sink.row('a');
  sink.close('last');
  assert.equal(sink.isOpen, false);
  assert.equal(text(sink), 'a\nlast\n');

  const small = openLogSink({ dir: scratch(), prefix: 'c', stamp: 'T', maxBytes: 4 });
  small.row('a');
  small.close('too long for the cap');
  assert.equal(small.capped, true);
  assert.equal(small.isOpen, false);
  assert.equal(text(small), 'a\n');
});

test('a failed write closes the sink, is reported once through onError and never throws', () => {
  const errors = [];
  const sink = openLogSink({ dir: scratch(), prefix: 'f', stamp: 'T', onError: (e) => errors.push(e.message) });
  sink.row('ok');
  const realWrite = fs.writeSync;
  fs.writeSync = () => { throw new Error('disk full'); };
  try {
    assert.equal(sink.row('lost'), false);
  } finally {
    fs.writeSync = realWrite;
  }
  assert.deepEqual(errors, ['log write failed: disk full']);
  assert.equal(sink.isOpen, false);
  assert.equal(sink.error.message, 'log write failed: disk full');
  assert.equal(sink.row('after'), false);
  sink.close('x');
  assert.deepEqual(errors.length, 1, 'reported once');
  assert.equal(text(sink), 'ok\n');
  assert.equal(sink.bytes, 3, 'only what was written is counted');
});

test('a file that cannot be opened throws from openLogSink', () => {
  const blocker = path.join(scratch(), 'file');
  fs.writeFileSync(blocker, 'x');
  assert.throws(() => openLogSink({ dir: path.join(blocker, 'logs'), prefix: 'r', stamp: 'T' }));
  assert.throws(() => openLogSink({ file: path.join(blocker, 'x.csv') }));
});
