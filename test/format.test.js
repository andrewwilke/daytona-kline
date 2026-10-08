'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { hexNum, hex0x, idText } = require('../src/format');

test('hexNum pads to the width, lower case; hex0x adds the prefix; idText is a 0x22 id in four digits', () => {
  assert.equal(hexNum(12), '0c');
  assert.equal(hexNum(255), 'ff');
  assert.equal(hexNum(256), '100', 'a value wider than the width is not cut');
  assert.equal(hexNum(256, 4), '0100');
  assert.equal(hex0x(12), '0x0c');
  assert.equal(hex0x(0x3ff, 4), '0x03ff');
  assert.equal(idText(0x41), '0x0041');
  assert.equal(idText(0x100), '0x0100');
});

test('no other module keeps its own copy of these formatters', () => {
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'cli.js'), ...['discover', 'liverun', 'outputtests'].map((f) => path.join(root, 'src', `${f}.js`))];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/const (hex2|idText)\s*=/.test(source), `${path.basename(file)} defines its own hex2 / idText`);
  }
});
