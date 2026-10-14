'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createGuard } = require('../src/main/guard');
const { scan } = require('../src/main/scanner');
const { clean } = require('../src/main/cleaner');
const { CATEGORIES } = require('../src/main/categories');
const { makeFakeHome, makeTempDir, cleanupHome, fakeContext } = require('./fixtures');

// Only the per-user categories; system-wide ones would read the real /Library.
const USER_CATEGORIES = CATEGORIES.filter((c) => ['app-caches', 'web-caches', 'logs', 'developer', 'containers', 'ios'].includes(c.id));

async function runScan(home, opts = {}) {
  const guard = createGuard({ home, platform: 'linux' });
  const events = [];
  const out = await scan({
    home,
    guard,
    emit: (e) => events.push(e),
    context: fakeContext(home, opts),
    categories: USER_CATEGORIES,
  });
  return { ...out, guard, events };
}

const allItems = (result) => result.categories.flatMap((c) => c.items);
const byName = (result, name) => allItems(result).find((i) => i.name === name);

test('scan finds caches, logs and developer junk with correct safety', async (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const { result, items, events } = await runScan(home);

  const spotify = byName(result, 'Spotify');
  assert.ok(spotify, 'Spotify cache found');
  assert.equal(spotify.safety, 'safe');
  assert.equal(spotify.defaultSelected, true);
  assert.ok(spotify.size >= 300 * 1024);

  const bird = byName(result, 'iCloud Drive');
  assert.ok(bird, 'iCloud Drive cache listed');
  assert.equal(bird.safety, 'review');
  assert.equal(bird.defaultSelected, false);

  // Symlinked cache folder and empty folder are not offered.
  assert.equal(allItems(result).some((i) => /com\.evil\.symlink/.test(i.location)), false);
  assert.equal(allItems(result).some((i) => /com\.example\.empty/.test(i.location)), false);
  assert.ok(allItems(result).some((i) => /com\.example\.links$/.test(i.location)), 'sanity: other caches are listed');

  // Slack's Chromium caches are grouped; offline data is "review".
  const web = result.categories.find((c) => c.id === 'web-caches');
  const slackSafe = web.items.find((i) => i.name === 'Slack' && i.safety === 'safe');
  const slackReview = web.items.find((i) => i.name === 'Slack' && i.safety === 'review');
  assert.ok(slackSafe && slackReview);
  assert.equal(slackSafe.count, 4); // Cache, Code Cache, GPUCache, ScriptCache
  assert.ok(web.items.find((i) => i.name === 'Google Chrome'));
  assert.ok(web.items.find((i) => i.name === 'Visual Studio Code'), 'VS Code caches found');
  // "SomeApp/Cache" lacks a Chromium signature.
  assert.equal(web.items.some((i) => i.name === 'SomeApp'), false);

  // No private item path points at user data.
  for (const it of items.values()) {
    for (const p of it.paths) {
      assert.doesNotMatch(p, /Local Storage|History$|\/User\/|Documents|Keychains|Preferences/);
    }
  }

  assert.ok(byName(result, 'Xcode DerivedData'));
  assert.ok(byName(result, 'npm cache'));
  assert.ok(byName(result, 'Go module downloads'));
  assert.ok(byName(result, 'iPhone software update'));
  assert.ok(byName(result, 'Crash & diagnostic reports'));
  assert.ok(byName(result, 'Other log files'));

  // Sandboxed caches need Full Disk Access.
  assert.equal(result.categories.find((c) => c.id === 'containers').status, 'locked');

  assert.ok(events.some((e) => e.type === 'start'));
  assert.ok(events.some((e) => e.type === 'category' && e.status === 'done'));
});

test('items owned by a running app are not preselected', async (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const { result } = await runScan(home, { running: [{ bundleId: 'com.spotify.client', name: 'Spotify' }, { bundleId: null, name: 'Slack' }] });
  const spotify = byName(result, 'Spotify');
  assert.equal(spotify.running, 'Spotify');
  assert.equal(spotify.defaultSelected, false);
  const web = result.categories.find((c) => c.id === 'web-caches');
  assert.equal(web.items.find((i) => i.name === 'Slack' && i.safety === 'safe').running, 'Slack');
});

test('delete mode removes junk and nothing else', async (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const { items, guard } = await runScan(home);
  const H = (...p) => path.join(home, ...p);

  const all = [...items.values()];
  const report = await clean(all, { mode: 'delete', guard, trashItem: () => assert.fail('no trash in delete mode') });
  const failed = report.filter((r) => !r.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.ok(report.every((r) => r.freed > 0));

  // Cleaned.
  assert.deepEqual(fs.readdirSync(H('Library/Caches/com.spotify.client')), []);
  assert.deepEqual(fs.readdirSync(H('Library/Application Support/Slack/Cache')), []);
  assert.deepEqual(fs.readdirSync(H('Library/Developer/Xcode/DerivedData')), []);
  assert.deepEqual(fs.readdirSync(H('go/pkg/mod/cache/download')), []); // read-only folders handled
  assert.equal(fs.existsSync(H('Library/iTunes/iPhone Software Updates/iPhone15,2_17.0_Restore.ipsw')), false);
  assert.equal(fs.existsSync(H('Library/Logs/install.log')), false);
  assert.equal(fs.existsSync(H('Library/Caches/com.example.links/docs')), false); // the link itself

  // Untouched.
  assert.equal(fs.readFileSync(H('Documents/important.txt')).length, 4096);
  assert.ok(fs.existsSync(H('Library/Keychains/login.keychain-db')));
  assert.ok(fs.existsSync(H('Library/Preferences/com.example.plist')));
  assert.ok(fs.existsSync(H('Library/Mobile Documents/com~apple~CloudDocs/doc.pages')));
  assert.ok(fs.existsSync(H('Library/Application Support/Slack/Local Storage/leveldb/000003.log')));
  assert.ok(fs.existsSync(H('Library/Application Support/Google/Chrome/Default/History')));
  assert.ok(fs.existsSync(H('Library/Application Support/Code/User/settings.json')));
  assert.ok(fs.existsSync(H('Library/Application Support/SomeApp/Cache/notes.txt')));
  assert.ok(fs.existsSync(H('Library/Application Support/MobileSync/Backup/00008030-ABC/Info.plist')));
  assert.ok(fs.lstatSync(H('Library/Caches/com.evil.symlink')).isSymbolicLink());
  // Folders themselves are kept, only their contents go.
  assert.ok(fs.existsSync(H('Library/Caches/com.spotify.client')));
});

test('trash mode hands every removed path to the Trash', async (t) => {
  const home = makeFakeHome();
  const trash = makeTempDir('trash-');
  t.after(() => {
    cleanupHome(home);
    cleanupHome(trash);
  });
  const { items, guard } = await runScan(home);
  const moved = [];
  const trashItem = async (p) => {
    moved.push(p);
    fs.renameSync(p, path.join(trash, `${moved.length}-${path.basename(p)}`));
  };
  const spotify = [...items.values()].find((i) => i.name === 'Spotify');
  const report = await clean([spotify], { mode: 'trash', guard, trashItem });
  assert.equal(report[0].ok, true);
  assert.deepEqual(moved, [path.join(home, 'Library/Caches/com.spotify.client/Data')]);
  assert.ok(report[0].freed >= 300 * 1024);
});

test('cleaner re-checks paths with the guard before removing', async (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const guard = createGuard({ home, platform: 'linux' });
  const forged = {
    id: 'x1',
    name: 'Forged',
    category: 'app-caches',
    action: 'contents',
    safety: 'safe',
    size: 4096,
    paths: [path.join(home, 'Documents')],
  };
  const report = await clean([forged], { mode: 'delete', guard, trashItem: () => {} });
  assert.equal(report[0].ok, false);
  assert.ok(fs.existsSync(path.join(home, 'Documents/important.txt')));

  const protectedItem = { ...forged, id: 'x2', action: 'none', safety: 'protected', paths: [path.join(home, 'Library/Caches/Homebrew')] };
  const report2 = await clean([protectedItem], { mode: 'delete', guard, trashItem: () => {} });
  assert.deepEqual(report2, []);
  assert.ok(fs.existsSync(path.join(home, 'Library/Caches/Homebrew/downloads/pkg.tar.gz')));
});

test('folders locked by macOS are not offered', async (t) => {
  const home = makeFakeHome();
  t.after(() => cleanupHome(home));
  const guard = createGuard({ home, platform: 'linux' });
  const lockedDir = path.join(home, 'Library/Caches/com.spotify.client');
  const { result } = await scan({
    home,
    guard,
    context: fakeContext(home),
    categories: USER_CATEGORIES,
    lockedPaths: async (paths) => new Set(paths.filter((p) => p === lockedDir)),
  });
  assert.equal(allItems(result).some((i) => i.location && i.location.endsWith('com.spotify.client')), false);
  assert.ok(byName(result, 'Homebrew downloads'));
});
