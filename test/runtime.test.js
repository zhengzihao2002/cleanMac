'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTempDir, cleanupHome } = require('./fixtures');
const { createSessionDir, removeStaleSessions } = require('../src/main/runtime');
const { readXmlStrings, readBinary } = require('../src/main/plist');
const { walkBytes, measure } = require('../src/main/sizer');

test('runtime creates unique private sessions without following a predictable symlink', (t) => {
  const root = makeTempDir('sessions-');
  t.after(() => cleanupHome(root));
  const elsewhere = path.join(root, 'unrelated');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, `cleanmac-session-${process.pid}`));
  const first = createSessionDir(root);
  const second = createSessionDir(root);
  assert.notEqual(first, second);
  assert.equal(fs.lstatSync(first).isDirectory(), true);
  assert.equal(fs.statSync(first).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('stale session cleanup leaves links, unrelated names and live sessions alone', (t) => {
  const root = makeTempDir('stale-sessions-');
  t.after(() => cleanupHome(root));
  const stale = path.join(root, 'cleanmac-session-2147483647-dead');
  const live = path.join(root, `cleanmac-session-${process.pid}-live`);
  const unrelated = path.join(root, 'cleanmac-session-2147483647not-a-pid');
  const data = path.join(root, 'important');
  for (const dir of [stale, live, unrelated, data]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(data, 'keep'), 'important');
  const link = path.join(root, 'cleanmac-session-2147483647-link');
  fs.symlinkSync(data, link);
  removeStaleSessions(root);
  assert.equal(fs.existsSync(stale), false);
  for (const dir of [live, unrelated, data]) assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(data, 'keep'), 'utf8'), 'important');
});

test('XML plist identity comes only from the root dictionary', () => {
  const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
    <!-- <key>CFBundleIdentifier</key><string>com.fake.comment</string> -->
    <key>Nested</key><dict><key>CFBundleIdentifier</key><string>com.fake.nested</string></dict>
    <key>Array</key><array><dict><key>CFBundleName</key><string>Wrong name</string></dict></array>
    <key>CFBundleIdentifier</key><string>com.correct.app</string>
    <key>CFBundleName</key><string><![CDATA[Example <App>]]> &amp; Tools</string>
    <key>Empty</key><string/>
    <key>Enabled</key><true/><string>Must not become Enabled</string>
  </dict></plist>`;
  assert.deepEqual(readXmlStrings(xml), {
    CFBundleIdentifier: 'com.correct.app', CFBundleName: 'Example <App> & Tools', Empty: '',
  });
  assert.throws(() => readXmlStrings('<plist><dict><key>Broken</dict></plist>'), /Malformed/);
});

test('binary plist rejects out-of-bounds collection lengths', () => {
  // One dictionary object claiming a huge payload, followed by a valid trailer.
  const object = Buffer.from([0xdf, 0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const tableOffset = 8 + object.length;
  const trailer = Buffer.alloc(32);
  trailer[6] = trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8);
  trailer.writeBigUInt64BE(BigInt(tableOffset), 24);
  const bytes = Buffer.concat([Buffer.from('bplist00'), object, Buffer.from([8]), trailer]);
  assert.throws(() => readBinary(bytes), /bplist/);
});

test('strict running-app checks fail closed if ps cannot complete', async () => {
  const childProcess = require('child_process');
  const systemPath = require.resolve('../src/main/system');
  const previousModule = require.cache[systemPath];
  const originalExecFile = childProcess.execFile;
  let system;
  try {
    childProcess.execFile = (_cmd, _args, _opts, callback) => {
      callback(Object.assign(new Error('ps failed'), { code: 1 }), '', 'ps failed');
    };
    delete require.cache[systemPath];
    system = require(systemPath);
  } finally {
    childProcess.execFile = originalExecFile;
    if (previousModule) require.cache[systemPath] = previousModule;
    else delete require.cache[systemPath];
  }
  assert.deepEqual(await system.runningApps('/fake-home'), []);
  await assert.rejects(system.runningApps('/fake-home', { strict: true }), /Could not verify running applications/);
});

test('size fallback counts allocated blocks, does not follow links, and marks cancellation partial', async (t) => {
  const root = makeTempDir('sizing-');
  t.after(() => cleanupHome(root));
  const sparse = path.join(root, 'sparse');
  const fd = fs.openSync(sparse, 'w');
  fs.ftruncateSync(fd, 128 * 1024 * 1024);
  fs.closeSync(fd);
  const st = fs.lstatSync(sparse);
  assert.equal((await walkBytes(sparse)).bytes, st.blocks * 512);
  const link = path.join(root, 'link');
  fs.symlinkSync(sparse, link);
  assert.equal((await walkBytes(link)).bytes, fs.lstatSync(link).blocks * 512);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await walkBytes(root, controller.signal)).partial, true);
  assert.equal((await measure(root, { signal: controller.signal })).partial, true);
});
