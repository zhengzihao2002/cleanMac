'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createGuard } = require('../src/main/guard');
const { makeFakeHome, cleanupHome } = require('./fixtures');

test('guard allows only cleanable locations', (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const g = createGuard({ home, ownPaths: ['/opt/cleanMac'], platform: 'linux' });
  const H = (...p) => path.join(home, ...p);

  const allowed = [
    H('Library/Caches/com.spotify.client'),
    H('Library/Caches/com.spotify.client/Data'),
    H('Library/Logs/DiagnosticReports'),
    H('Library/Application Support/Slack/Cache'),
    H('Library/Application Support/Slack/Code Cache/js'),
    H('Library/Application Support/Slack/Service Worker/CacheStorage'),
    H('Library/Application Support/Google/Chrome/Default/Code Cache'),
    H('Library/Application Support/Code/CachedData'),
    H('Library/Developer/Xcode/DerivedData/MyApp-abc'),
    H('.npm/_cacache/content-v2'),
    H('Library/iTunes/iPhone Software Updates/iPhone15,2_17.0_Restore.ipsw'),
  ];
  for (const p of allowed) assert.equal(g.check(p).ok, true, `should allow ${p}: ${g.check(p).reason}`);

  const denied = [
    home,
    H('Library'),
    H('Library/Caches'),
    H('Library/Logs'),
    H('Documents/important.txt'),
    H('Documents'),
    H('Desktop'),
    H('Library/Keychains/login.keychain-db'),
    H('Library/Preferences/com.example.plist'),
    H('Library/Mobile Documents/com~apple~CloudDocs'),
    H('Library/Application Support/Slack'),
    H('Library/Application Support/Slack/Local Storage'),
    H('Library/Application Support/Google/Chrome/Default/History'),
    H('Library/Application Support/Code/User'),
    H('Library/Application Support/AddressBook/Cache'),
    H('Library/Caches/../Documents'),
    H('Library/Caches/com.spotify.client/'),
    'Library/Caches/relative',
    '/System/Library/Caches/x',
    '/usr/lib',
    '/Applications/Safari.app',
    '/private/var/vm/swapfile0',
    '/private/var/folders/xy/abc/T',
    '/opt/cleanMac/src',
    '/opt',
    `${H('Library/Caches/com.x')}\n/etc`,
  ];
  for (const p of denied) assert.equal(g.check(p).ok, false, `should deny ${p}`);
});

test('guard refuses paths that pass through a symlink', (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const g = createGuard({ home, platform: 'linux' });
  // ~/Library/Caches/com.evil.symlink -> ~/Documents
  const through = path.join(home, 'Library/Caches/com.evil.symlink/important.txt');
  assert.equal(fs.existsSync(through), true);
  assert.equal(g.check(through).ok, false);
  assert.match(g.check(through).reason, /symbolic link/);
});

test('guard refuses anything inside a real app bundle', (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const bundle = path.join(home, 'Library/Caches/com.vendor.updates/Vendor.app');
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), '<plist/>');
  const g = createGuard({ home, platform: 'linux' });
  assert.equal(g.check(path.join(bundle, 'Contents')).ok, false);
  // A cache folder that merely ends in ".app" (a bundle id) is fine.
  fs.mkdirSync(path.join(home, 'Library/Caches/com.example.app'), { recursive: true });
  assert.equal(g.check(path.join(home, 'Library/Caches/com.example.app')).ok, true);
});

test('guard rejects an invalid home', () => {
  assert.throws(() => createGuard({ home: '/' }));
  assert.throws(() => createGuard({ home: 'relative' }));
});
