'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDeepDelete } = require('../src/main/deep-delete');
const { makeTempDir, cleanupHome, write } = require('./fixtures');

function application(dir, name = 'Example', bundleId = 'org.example.App') {
  const target = path.join(dir, name + '.app');
  const info = path.join(target, 'Contents/Info.plist');
  fs.mkdirSync(path.dirname(info), { recursive: true });
  fs.writeFileSync(info, `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>${name}</string></dict></plist>`);
  write(path.join(target, 'Contents/MacOS/example'), 8192);
  return target;
}

function fixture(t, options = {}) {
  const root = makeTempDir('deep-delete-');
  t.after(() => cleanupHome(root));
  const home = path.join(root, 'home');
  const appRoot = path.join(root, 'Applications');
  const library = path.join(root, 'Library');
  const trash = path.join(root, 'Trash');
  for (const dir of [home, appRoot, library, trash]) fs.mkdirSync(dir, { recursive: true });
  let running = [];
  let calls = 0;
  const moved = [];
  const move = async (p) => {
    moved.push(p);
    fs.renameSync(p, path.join(trash, `${moved.length}-${path.basename(p)}`));
  };
  const service = createDeepDelete({ home, appRoots: [appRoot], systemLibrary: library,
    runningApps: async () => { calls++; return running; }, trashItem: move, platform: 'linux', ...options });
  return { root, home, appRoot, library, trash, moved, service, move,
    H: (p) => path.join(home, p), setRunning: (next) => { running = next; }, processCalls: () => calls };
}

async function open(service, name = 'Example') {
  const listing = await service.listApps();
  const app = listing.apps.find((a) => a.name === name);
  assert.ok(app, `Expected ${name} in installed apps`);
  return service.preview(app.id);
}

test('Deep Delete discovers exact app-owned files and leaves all app data unchecked', async (t) => {
  const f = fixture(t);
  const bundle = application(f.appRoot);
  const exact = [
    'Library/Caches/org.example.App/cache', 'Library/Logs/org.example.App/log',
    'Library/Application Support/org.example.App/database', 'Library/Preferences/org.example.App.plist',
    'Library/Saved Application State/org.example.App.savedState/state', 'Library/Containers/org.example.App/Data/Documents/notes',
    'Library/HTTPStorages/org.example.App/data', 'Library/HTTPStorages/org.example.App.binarycookies',
    'Library/WebKit/org.example.App/web', 'Library/Cookies/org.example.App.binarycookies',
    'Library/Application Scripts/org.example.App/script',
    'Library/Preferences/ByHost/org.example.App.AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.plist',
  ];
  for (const file of exact) write(f.H(file), 4096);
  const unrelated = [
    'Library/Caches/org.example.App.Other/cache', 'Library/Caches/org.example.AppExtra/cache',
    'Library/Application Support/Example/user-data', 'Library/Application Support/org.example/Vendor/file',
    'Library/Group Containers/TEAM.org.example.App/shared', 'Library/LaunchAgents/org.example.App.plist',
    'Documents/org.example.App/work.txt', 'Library/Preferences/ByHost/org.example.App.other.plist',
  ];
  for (const file of unrelated) write(f.H(file));
  write(path.join(f.library, 'Caches/org.example.App/file'));
  const preview = await open(f.service);
  assert.equal(preview.app.bundleId, 'org.example.App');
  assert.equal(preview.items.length, exact.length + 2);
  assert.equal(preview.items.find((i) => i.kind === 'application').path, bundle);
  assert.ok(preview.items.find((i) => i.kind === 'application').defaultSelected);
  assert.ok(preview.items.filter((i) => i.kind !== 'application').every((i) => !i.defaultSelected && i.safety === 'review'));
  assert.ok(preview.items.every((i) => i.size > 0 && !('identity' in i)));
  for (const file of unrelated) assert.ok(!preview.items.some((i) => {
    const relative = path.relative(f.home, i.path);
    return file === relative || file.startsWith(relative + '/');
  }), file);
  assert.ok(preview.limitations.some((s) => s.includes('Shared Group Containers')));
  assert.ok(preview.limitations.some((s) => s.includes('original free-space')));
  assert.equal(f.moved.length, 0, 'Discovery is read-only');
});

test('Deep Delete protects Apple apps, own app, invalid IDs, and system roots', async (t) => {
  const f = fixture(t);
  application(f.appRoot, 'Apple', 'com.apple.Example');
  application(f.appRoot, 'CleanMac', 'local.cleanmac.app');
  application(f.appRoot, 'Invalid', '../Documents');
  const self = application(f.appRoot, 'OwnPath', 'org.example.Self');
  application(f.appRoot, 'Normal');
  const systemRoot = path.join(f.root, 'SystemApps');
  application(systemRoot, 'System', 'org.example.System');
  const service = createDeepDelete({ home: f.home, appRoots: [f.appRoot, { dir: systemRoot, protected: true }],
    ownPaths: [self], systemLibrary: null, runningApps: async () => [] });
  const listing = await service.listApps();
  assert.equal(listing.apps.length, 6, 'Own app does not prevent listing its sibling apps');
  for (const app of listing.apps.filter((a) => a.name !== 'Normal')) {
    assert.equal(app.protected, true, app.name);
    assert.ok(app.reason);
    await assert.rejects(service.preview(app.id));
  }
  assert.equal(listing.apps.find((a) => a.name === 'Normal').protected, false);
});

test('Deep Delete excludes shared leftovers when another installed copy has the same identifier', async (t) => {
  const f = fixture(t);
  application(f.appRoot);
  application(f.appRoot, 'SecondCopy');
  write(f.H('Library/Caches/org.example.App/cache'));
  const preview = await open(f.service);
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].kind, 'application');
  assert.ok(preview.notices.some((s) => s.includes('Another installed copy')));
});

test('Deep Delete still discovers sibling apps in a folder containing cleanMac', async (t) => {
  const f = fixture(t);
  const utilities = path.join(f.appRoot, 'Utilities');
  const own = application(utilities, 'CleanMac', 'local.cleanmac.app');
  application(utilities, 'Example');
  const service = createDeepDelete({ home: f.home, appRoots: [f.appRoot], ownPaths: [own],
    systemLibrary: null, runningApps: async () => [] });
  const listing = await service.listApps();
  assert.equal(listing.apps.length, 2);
  assert.equal(listing.apps.find((a) => a.name === 'CleanMac').protected, true);
  assert.equal(listing.apps.find((a) => a.name === 'Example').protected, false);
});

test('Deep Delete only moves selected preview IDs to Trash and preserves unchecked data', async (t) => {
  const f = fixture(t);
  const app = application(f.appRoot);
  const cache = f.H('Library/Caches/org.example.App');
  const support = f.H('Library/Application Support/org.example.App/important.db');
  write(path.join(cache, 'cache'));
  write(support);
  const preview = await open(f.service);
  const chosen = preview.items.filter((i) => ['cache', 'application'].includes(i.kind));
  const appId = chosen.find((i) => i.kind === 'application').id;
  const report = await f.service.clean({ previewId: preview.id, ids: [...chosen.map((i) => i.id), appId] });
  assert.equal(report.report.length, 2);
  assert.ok(report.report.every((r) => r.ok && r.trashedBytes > 0));
  assert.equal(report.appRemoved, true);
  assert.equal(report.reclaimedBytes, 0, 'Trash does not promise reclaimed disk capacity');
  assert.equal(report.mode, 'trash');
  assert.deepEqual(f.moved, [cache, app]);
  assert.ok(fs.existsSync(support));
  assert.ok(!fs.existsSync(app));
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: [appId] }), /expired/);
});

test('Deep Delete refuses forged IDs and invalidates stale previews after refreshing apps', async (t) => {
  const f = fixture(t);
  const app = application(f.appRoot);
  const preview = await open(f.service);
  await assert.rejects(f.service.preview(app), /Application not found/);
  await assert.rejects(f.service.clean({ previewId: 'forged', ids: [] }), /expired/);
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: [app] }), /current Deep Delete preview/);
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: [] }), /Choose files/);
  assert.equal(f.moved.length, 0);
  await f.service.listApps();
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: [preview.items[0].id] }), /expired/);
  assert.ok(fs.existsSync(app));
});

test('Deep Delete blocks apps that start running after preview and fails closed on process discovery failure', async (t) => {
  const f = fixture(t);
  const appPath = application(f.appRoot);
  write(f.H('Library/Caches/org.example.App/file'));
  const preview = await open(f.service);
  f.setRunning([{ bundleId: 'org.example.App', name: 'Example', path: appPath }]);
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: preview.items.map((i) => i.id) }), /Quit Example/);
  assert.equal(f.moved.length, 0);
  const runningPreview = await f.service.preview(preview.app.id);
  assert.equal(runningPreview.running, 'Example');
  assert.ok(runningPreview.items.every((i) => !i.defaultSelected));
  let fail = false;
  const strict = createDeepDelete({ home: f.home, appRoots: [f.appRoot], systemLibrary: null, trashItem: f.move,
    runningApps: async () => { if (fail) throw new Error('Process lookup failed'); return []; } });
  const safe = await open(strict);
  fail = true;
  await assert.rejects(strict.clean({ previewId: safe.id, ids: [safe.items[0].id] }), /Process lookup failed/);
  assert.equal(f.moved.length, 0);
});

test('Deep Delete rechecks processes before every move and retains app if a later process check fails', async (t) => {
  let checks = 0;
  let moved = 0;
  const f = fixture(t, { runningApps: async () => { checks++; return moved ? [{ bundleId: 'org.example.App', name: 'Example' }] : []; },
    trashItem: async (p) => { moved++; fs.renameSync(p, p + '.trashed'); } });
  const app = application(f.appRoot);
  write(f.H('Library/Caches/org.example.App/cache'));
  const preview = await open(f.service);
  const result = await f.service.clean({ previewId: preview.id, ids: preview.items.map((i) => i.id) });
  assert.equal(result.report.filter((r) => r.ok).length, 1);
  assert.equal(result.appRemoved, false);
  assert.match(result.report.find((r) => !r.ok).errors.join(' '), /Quit Example/);
  assert.ok(fs.existsSync(app));
  assert.ok(checks >= 5);
});

test('Deep Delete rejects replaced paths and changed application metadata', async (t) => {
  const f = fixture(t);
  const app = application(f.appRoot);
  const cache = f.H('Library/Caches/org.example.App');
  write(path.join(cache, 'cache'));
  const preview = await open(f.service);
  const cacheItem = preview.items.find((i) => i.kind === 'cache');
  fs.renameSync(cache, cache + '.old');
  write(path.join(cache, 'replacement'));
  const result = await f.service.clean({ previewId: preview.id, ids: [cacheItem.id] });
  assert.equal(result.report[0].ok, false);
  assert.match(result.report[0].errors[0], /changed after the preview/);
  assert.equal(f.moved.length, 0);
  const second = await f.service.preview(preview.app.id);
  const info = path.join(app, 'Contents/Info.plist');
  fs.writeFileSync(info, fs.readFileSync(info, 'utf8').replace('org.example.App', 'org.example.Other'));
  await assert.rejects(f.service.clean({ previewId: second.id, ids: [second.items[0].id] }), /identity changed/);
});

test('Deep Delete excludes symlink candidates and rejects symlinked ancestors replaced after preview', async (t) => {
  const f = fixture(t);
  application(f.appRoot);
  const docs = f.H('Documents');
  write(path.join(docs, 'important.txt'), 4096);
  fs.mkdirSync(f.H('Library/Caches'), { recursive: true });
  fs.symlinkSync(docs, f.H('Library/Caches/org.example.App'));
  fs.symlinkSync(path.join(f.appRoot, 'Example.app'), path.join(f.appRoot, 'Linked.app'));
  const listing = await f.service.listApps();
  assert.equal(listing.apps.length, 1, 'App aliases are not traversed');
  let preview = await f.service.preview(listing.apps[0].id);
  assert.equal(preview.items.length, 1);
  assert.ok(preview.notices.some((s) => /Symbolic links/.test(s)));
  fs.unlinkSync(f.H('Library/Caches/org.example.App'));
  write(f.H('Library/Caches/org.example.App/cache'));
  preview = await f.service.preview(listing.apps[0].id);
  const cache = preview.items.find((i) => i.kind === 'cache');
  fs.renameSync(f.H('Library/Caches'), f.H('Library/Caches.previous'));
  fs.symlinkSync(docs, f.H('Library/Caches'));
  const result = await f.service.clean({ previewId: preview.id, ids: [cache.id] });
  assert.equal(result.report[0].ok, false);
  assert.match(result.report[0].errors[0], /Symbolic links/);
  assert.equal(f.moved.length, 0);
  assert.equal(fs.readFileSync(path.join(docs, 'important.txt')).length, 4096);
});

test('Deep Delete moves internal symlinks without following or deleting their targets', async (t) => {
  const f = fixture(t);
  application(f.appRoot);
  const target = f.H('Documents/important.txt');
  write(target, 8192);
  const cache = f.H('Library/Caches/org.example.App');
  write(path.join(cache, 'blob'));
  fs.symlinkSync(path.dirname(target), path.join(cache, 'document-link'));
  const preview = await open(f.service);
  const item = preview.items.find((i) => i.kind === 'cache');
  const result = await f.service.clean({ previewId: preview.id, ids: [item.id] });
  assert.equal(result.report[0].ok, true);
  assert.equal(fs.readFileSync(target).length, 8192);
  assert.ok(fs.lstatSync(path.join(f.trash, '1-org.example.App/document-link')).isSymbolicLink());
});

test('Deep Delete reports permission failures and keeps app available for retry', async (t) => {
  const f = fixture(t, { trashItem: async () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; } });
  const app = application(f.appRoot);
  write(f.H('Library/Preferences/org.example.App.plist'));
  const preview = await open(f.service);
  const result = await f.service.clean({ previewId: preview.id, ids: preview.items.map((i) => i.id) });
  assert.ok(result.report.every((r) => !r.ok));
  assert.match(result.report[0].errors[0], /macOS denied access/);
  assert.match(result.report[1].errors[0], /application was kept/);
  assert.equal(result.trashedBytes, 0);
  assert.equal(result.appRemoved, false);
  assert.ok(fs.existsSync(app));
});

test('Deep Delete disables incompletely measured items and validates reveal requests', async (t) => {
  const f = fixture(t, { measurePath: async () => ({ bytes: 12, partial: true }) });
  application(f.appRoot);
  const preview = await open(f.service);
  assert.equal(preview.items[0].selectable, false);
  assert.equal(preview.items[0].defaultSelected, false);
  await assert.rejects(f.service.clean({ previewId: preview.id, ids: [preview.items[0].id] }), /incomplete previews/);
  assert.equal(await f.service.revealPath(preview.id, preview.items[0].id), preview.items[0].path);
  assert.equal(await f.service.revealPath(preview.id, '/etc/passwd'), null);
  f.service.invalidate();
  assert.equal(await f.service.revealPath(preview.id, preview.items[0].id), null);
});

test('Deep Delete does not report success when a Trash implementation leaves the source untouched', async (t) => {
  const f = fixture(t, { trashItem: async () => {} });
  const app = application(f.appRoot);
  const preview = await open(f.service);
  const result = await f.service.clean({ previewId: preview.id, ids: [preview.items[0].id] });
  assert.equal(result.report[0].ok, false);
  assert.match(result.report[0].errors[0], /original location/);
  assert.equal(result.trashedBytes, 0);
  assert.ok(fs.existsSync(app));
});

test('Deep Delete detects app catalog changes, including newly created app roots', async (t) => {
  const f = fixture(t);
  application(f.appRoot);
  const missingRoot = path.join(f.root, 'new-applications');
  const service = createDeepDelete({ home: f.home, appRoots: [f.appRoot, missingRoot], systemLibrary: null,
    runningApps: async () => [], trashItem: f.move });
  write(f.H('Library/Caches/org.example.App/cache'));
  const preview = await open(service);
  application(missingRoot, 'Duplicate');
  await assert.rejects(service.clean({ previewId: preview.id, ids: preview.items.map((i) => i.id) }), /Installed applications changed/);
  assert.equal(f.moved.length, 0);
});

test('Deep Delete distinguishes case-sensitive app paths even with darwin safety settings', async (t) => {
  const f = fixture(t, { platform: 'darwin' });
  application(f.appRoot, 'Example');
  application(f.appRoot, 'example');
  write(f.H('Library/Caches/org.example.App/cache'));
  const listing = await f.service.listApps();
  assert.equal(listing.apps.length, 2);
  const preview = await f.service.preview(listing.apps[0].id);
  assert.equal(preview.items.length, 1);
  assert.ok(preview.notices.some((n) => n.includes('Another installed copy')));
});

test('Deep Delete uses explicit app-specific support mappings without deleting vendor siblings', async (t) => {
  const f = fixture(t);
  application(f.appRoot, 'Google Chrome', 'com.google.Chrome');
  const profile = f.H('Library/Application Support/Google/Chrome');
  const sibling = f.H('Library/Application Support/Google/Drive/user-data');
  write(path.join(profile, 'Default/History'));
  write(sibling);
  const preview = await open(f.service, 'Google Chrome');
  const support = preview.items.find((i) => i.path === profile);
  assert.ok(support);
  assert.equal(support.defaultSelected, false);
  assert.match(support.note, /saved work/);
  const report = await f.service.clean({ previewId: preview.id, ids: [support.id] });
  assert.equal(report.report[0].ok, true);
  assert.ok(fs.existsSync(sibling));
  assert.ok(fs.existsSync(path.dirname(profile)), 'Vendor parent survives');
});
