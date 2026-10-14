'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { friendlyName, cacheSafety } = require('../src/main/rules');
const { adminPlan } = require('../src/main/cleaner');
const { readBinary, readXmlStrings } = require('../src/main/plist');

test('friendly names', () => {
  const apps = new Map([
    ['com.tinyspeck.slackmacgap', 'Slack'],
    ['com.google.Chrome', 'Google Chrome'],
  ]);
  assert.equal(friendlyName('com.tinyspeck.slackmacgap', apps), 'Slack');
  assert.equal(friendlyName('com.google.Chrome.helper', apps), 'Google Chrome');
  assert.equal(friendlyName('com.microsoft.VSCode.ShipIt', apps), 'Visual Studio Code updates');
  assert.equal(friendlyName('com.apple.helpd', apps), 'Help Viewer');
  assert.equal(friendlyName('com.acme.super-tool', apps), 'Super Tool');
  assert.equal(friendlyName('io.example.desktop', apps), 'Example');
  assert.equal(friendlyName('Homebrew', apps), 'Homebrew downloads');
  assert.equal(friendlyName('RandomFolder', apps), 'RandomFolder');
});

test('cache safety', () => {
  assert.equal(cacheSafety('com.spotify.client').safety, 'safe');
  assert.equal(cacheSafety('com.apple.bird').safety, 'review');
  assert.equal(cacheSafety('CloudKit').safety, 'review');
  assert.equal(cacheSafety('com.apple.iCloudHelper').safety, 'review');
  assert.equal(cacheSafety('com.apple.Safari').safety, 'safe');
});

test('admin plan only contains validated system paths', () => {
  // A permissive guard: this test checks the plan's own, independent filter.
  const guard = { check: () => ({ ok: true }) };
  const { lines, refused } = adminPlan(
    [
      { id: 'a', action: 'contents', paths: ['/Library/Caches/com.vendor.app'] },
      { id: 'b', action: 'remove', paths: ['/private/var/log/system.log.0.gz'] },
      { id: 'c', action: 'contents', paths: ['/Library/Preferences'] },
      { id: 'd', action: 'snapshot', meta: { date: '2024-01-15-123456' }, paths: [] },
      { id: 'e', action: 'snapshot', meta: { date: '2024; rm -rf /' }, paths: [] },
      { id: 'f', action: 'contents', paths: ['/Users/test/Library/Caches/x'] },
    ],
    guard,
  );
  assert.deepEqual(lines, [
    'a\tcontents\t/Library/Caches/com.vendor.app',
    'b\tremove\t/private/var/log/system.log.0.gz',
    'd\tsnapshot\t2024-01-15-123456',
  ]);
  assert.deepEqual([...refused.keys()].sort(), ['c', 'e', 'f']);
});

test('plist reader handles XML and binary plists', () => {
  const xml = `<?xml version="1.0"?><plist><dict>
    <key>CFBundleIdentifier</key><string>com.example.app</string>
    <key>CFBundleName</key><string>Tom &amp; Jerry</string></dict></plist>`;
  assert.deepEqual(readXmlStrings(xml), { CFBundleIdentifier: 'com.example.app', CFBundleName: 'Tom & Jerry' });

  // Generated with Python: plistlib.dumps({...}, fmt=plistlib.FMT_BINARY)
  const b64 =
    'YnBsaXN0MDDXAQIDBAUGBwgJCg0ODxJfEBJDRkJ1bmRsZUlkZW50aWZpZXJUTmFtZVNhcnJTYmlnUW5WbmVzdGVkUm9rXxAPY29tLmV4YW1wbGUuYXBwZgBDAGEAZgDpACAmFaILDFFhUWITAAABAAAAAAAQKtEQEVFrUXYJCBcsMTU5O0JFV2RnaWt0dnl7fQAAAAAAAAEBAAAAAAAAABMAAAAAAAAAAAAAAAAAAAB+';
  const obj = readBinary(Buffer.from(b64, 'base64'));
  assert.equal(obj.CFBundleIdentifier, 'com.example.app');
  assert.equal(obj.Name, 'Café ☕');
  assert.equal(obj.n, 42);
  assert.equal(obj.ok, true);
  assert.equal(obj.big, 2 ** 40);
  assert.deepEqual(obj.arr, ['a', 'b']);
  assert.deepEqual(obj.nested, { k: 'v' });
});
