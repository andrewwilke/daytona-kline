#!/usr/bin/env node
'use strict';

// Builds the portable Windows download: this project's files, its dependencies already installed, and the official
// Node.js runtime, in one zip. Unzip it, double-click start.bat, nothing else to install.
//
//   node scripts/build-portable.js [outDir]        (default outDir: ./dist, which is git-ignored)
//
// Needs internet (the Node.js download and npm), and `tar` (Windows 10 and later have it, in System32). The Node.js download is
// checked against the SHA-256 list nodejs.org publishes for that release, and the file is only used if it matches.
// Uses the Node version that runs this script, so the bundle runs what was tested.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const nodeVersion = process.version; // for example v24.19.0
const nodeZipName = `node-${nodeVersion}-win-x64.zip`;
const base = `https://nodejs.org/dist/${nodeVersion}`;
const bundleName = `daytona-kline-${pkg.version}-windows`;

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(res.headers.location));
    if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', reject);
});

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
// Windows' own tar (bsdtar) reads C:\paths and writes real zips; a GNU tar earlier on the PATH (Git for Windows) does neither.
const winTar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
const TAR = winTar && fs.existsSync(winTar) ? winTar : 'tar';

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kline-portable-'));
  const stage = path.join(work, bundleName);
  fs.mkdirSync(stage, { recursive: true });

  // 1. the project's own files, exactly as committed (no secrets, no logs, no node_modules)
  const archive = path.join(work, 'src.tar');
  run('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: root });
  run(TAR, ['-xf', archive, '-C', stage]);
  fs.rmSync(path.join(stage, 'test'), { recursive: true, force: true }); // the tests are not needed to run it
  fs.rmSync(path.join(stage, 'start.sh'), { force: true });
  const bat = path.join(stage, 'start.bat'); // a batch file must have Windows line endings
  fs.writeFileSync(bat, fs.readFileSync(bat, 'utf8').split(/\r?\n/).join('\r\n'));

  // 2. dependencies, production only, with the other platforms' binaries left out
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, shell: process.platform === 'win32' });
  const prebuilds = path.join(stage, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const d of fs.readdirSync(prebuilds)) if (!d.startsWith('win32-x64')) fs.rmSync(path.join(prebuilds, d), { recursive: true, force: true });
  }

  // 3. the official Node.js runtime, checked against nodejs.org's published hash
  console.log(`downloading ${nodeZipName} ...`);
  const zip = await get(`${base}/${nodeZipName}`);
  const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === nodeZipName)?.[0];
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (!expected || expected !== actual) throw new Error(`the Node.js download does not match nodejs.org's SHA-256 (${actual} vs ${expected}); not using it`);
  console.log(`SHA-256 of ${nodeZipName} matches nodejs.org`);
  const nodeZip = path.join(work, nodeZipName);
  fs.writeFileSync(nodeZip, zip);
  run(TAR, ['-xf', nodeZip, '-C', work]);
  const unpacked = path.join(work, `node-${nodeVersion}-win-x64`);
  fs.mkdirSync(path.join(stage, 'node'), { recursive: true });
  fs.copyFileSync(path.join(unpacked, 'node.exe'), path.join(stage, 'node', 'node.exe'));
  fs.copyFileSync(path.join(unpacked, 'LICENSE'), path.join(stage, 'node', 'LICENSE-nodejs.txt')); // the runtime's own licence travels with it

  // 4. a short readme for people who unzip it
  fs.writeFileSync(path.join(stage, 'START-HERE.txt'), [
    'Daytona K-line tool (portable, Windows)',
    '',
    '1. Plug the diagnostic cable into the bike and into USB. Ignition on, kill switch at RUN.',
    '2. Double-click start.bat. A page opens in your browser (http://localhost:3675).',
    '3. Pick the cable (the FTDI port) at the top and press Connect. It can take up to a minute.',
    '',
    'Nothing is installed: delete the folder to remove it. If Windows says "protected your PC",',
    'choose More info, then Run anyway (the file is not code-signed). Read README.md first:',
    'it explains what the tool does, its safety notes and what has and has not been tested.',
    `This download carries the official Node.js ${nodeVersion} in the "node" folder (see node\\LICENSE-nodejs.txt).`,
    '',
  ].join('\r\n'));

  // 5. zip it
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${bundleName}.zip`);
  fs.rmSync(out, { force: true });
  run(TAR, ['-a', '-cf', out, '-C', work, bundleName]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  fs.writeFileSync(`${out}.sha256`, `${sha}  ${path.basename(out)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nbuilt ${out} (${Math.round(fs.statSync(out).size / 1024 / 1024)} MB)\nsha256 ${sha}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
