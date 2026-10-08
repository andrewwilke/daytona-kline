'use strict';

// The GUI server serves the page's scripts (public/js/*.js) and nothing else from the folder tree: exactly those
// files, with the right content type; every other path, and every way of climbing out of the folder, is not found.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { server } = require('../server');

const PUBLIC = path.join(__dirname, '..', 'public');
let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** One request with the path exactly as given (no normalising on the way). */
const get = (rawPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

const scriptFiles = () => fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => fs.statSync(path.join(PUBLIC, 'js', f)).isFile());

test('every script in public/js is served as JavaScript, byte for byte', async () => {
  const files = scriptFiles();
  assert.ok(files.length >= 4, 'the page has its modules');
  for (const name of files) {
    const r = await get(`/js/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.type, 'text/javascript; charset=utf-8', name);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
    assert.deepEqual(r.body, fs.readFileSync(path.join(PUBLIC, 'js', name)), name);
  }
  assert.equal((await get('/js/app.js?v=2')).status, 200, 'a query string does not matter');
});

test('every file in public/js has a name the server will serve (so a script cannot be added and silently not found)', () => {
  for (const name of scriptFiles()) assert.match(name, /^[a-z0-9-]+\.js$/, `${name}: only plain lower-case .js names are served`);
  assert.deepEqual(fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => fs.statSync(path.join(PUBLIC, 'js', f)).isDirectory()), [], 'no sub-folders');
});

test('every script the page loads is served', async () => {
  const html = (await get('/')).body.toString('utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs.map((s) => s.replace(/^\/js\//, '')), ['graphstore.js', 'fuelmap.js', 'session.js', 'app.js'], 'the modules first, the page last');
  for (const src of srcs) assert.equal((await get(src)).status, 200, src);
  assert.equal((await get('/index.html')).status, 200);
});

test('other paths in the tree are not found: folders, other files, other types, other places', async () => {
  const paths = [
    '/js', '/js/', '/js/nothere.js', '/js/app', '/js/app.js/', '/js/app.js.map', '/js/APP.js', '/js/.js', '/js/app.JS',
    '/js/con.js', '/js/nul.js', '/js/aux.js', '/js/app.json', '/js/app.html', '/js/app.js%00.txt', '/js/app.js%00', '/js/sub/app.js', '/js//app.js', '//js/app.js',
    '/public/js/app.js', '/public/index.html', '/public/', '/app.js', '/graphstore.js',
    '/server.js', '/cli.js', '/package.json', '/README.md', '/config.json', '/unlock.json', '/unlock.example.json', '/logs/', '/src/runs.js', '/node_modules/serialport/package.json', '/test/helpers.js',
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} is refused`);
    assert.equal(r.body.toString(), 'not found', p);
  }
});

test('path traversal is refused, in every spelling', async () => {
  const paths = [
    '/js/../server.js', '/js/../../server.js', '/js/../public/js/app.js', '/js/./app.js', '/js/..',
    '/js/%2e%2e/server.js', '/js/%2E%2E/server.js', '/js/..%2fserver.js', '/js/%2e%2e%2fserver.js', '/js/..%5cserver.js',
    '/js/..\\server.js', '/js/%252e%252e/server.js', '/js/....//server.js', '/js/app.js/../../server.js',
    '/js/../unlock.json', '/js/../config.json', '/js/../logs/', '/js/..%2f..%2fwindows/win.ini',
    '/%2e%2e/server.js', '/js%2fapp.js', '/js\\app.js', '/js/C:\\Windows\\win.ini', '/js/c:/windows/win.ini',
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} is refused`);
    assert.doesNotMatch(r.body.toString(), /require\(|multiplier|createRuns/, `${p} gave nothing of the other files`);
  }
});

test('only GET reads a script', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const r = await get('/js/app.js', method);
    assert.equal(r.status, 404, method);
  }
});

test('the API routes still answer next to the static files', async () => {
  const r = await get('/api/runs');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
  assert.equal((await get('/api/nothing')).status, 404);
});
