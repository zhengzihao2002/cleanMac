'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

// Exercise the actual main-process handlers with a fake Electron host. No
// filesystem cleanup, privileged helper, or real Trash is invoked here.
async function host(overrides = {}) {
  const handlers = new Map();
  const windows = [];
  const calls = { cleaned: [], invalidated: 0, relaunched: 0, quit: 0, installs: [] };
  const app = new EventEmitter();
  Object.assign(app, {
    getAppPath: () => '/test/cleanMac.app/Contents/Resources/app',
    getVersion: () => '1.0.0',
    setName() {},
    setAboutPanelOptions() {},
    whenReady: async () => {},
    quit: () => calls.quit++,
    relaunch: () => calls.relaunched++,
    exit() {},
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href + '?platform=darwin' };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.isDestroyed = () => false;
      this.loadFile = () => {};
      this.show = () => {};
      windows.push(this);
    }
    static getAllWindows() { return windows; }
  }
  const item = { id: 'i1', name: 'Cache', paths: ['/test/home/Library/Caches/example'], size: 1 };
  const deep = {
    listApps: async () => ({ apps: [], errors: [] }),
    preview: async () => ({ id: 'preview', items: [] }),
    clean: async () => ({ report: [], mode: 'trash' }),
    revealPath: async () => null,
    invalidate: () => calls.invalidated++,
    ...overrides.deep,
  };
  const electron = {
    app, BrowserWindow,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    shell: { trashItem: async () => {}, openPath: async () => {}, openExternal: async () => {}, showItemInFolder() {} },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
    nativeTheme: { shouldUseDarkColors: false },
    session: { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} } },
  };
  const mocks = {
    electron,
    './runtime': {
      configure: () => ({ home: '/test/home', projectRoot: '/test/cleanMac', sessionDir: '/test/session', bundleId: 'local.cleanmac.app' }),
      readSettings: () => overrides.settings || { mode: 'trash' },
      writeSettings() {}, sweepOnExit() {},
    },
    './guard': { createGuard: () => ({}) },
    './scanner': { scan: async () => ({ result: { categories: [] }, items: new Map([['i1', item]]) }) },
    './categories': { CATEGORIES: [] },
    './cleaner': { clean: async (items) => { calls.cleaned.push(items); return []; } },
    './system': {
      diskInfo: async () => ({ total: 100, free: 50, used: 50 }),
      macosVersion: async () => null,
      hasFullDiskAccess: () => false,
      runningApps: async () => [],
      createRunningIndex: () => ({ match: () => null }),
      ...overrides.system,
    },
    './deep-delete': { createDeepDelete: () => deep },
    './updater': { prepareUpdate: async () => ({ application: '/test/update.app', version: '1.1.0' }),
      migrateLegacyUpdate: async () => false, cleanupUpdateCopies: async () => 0,
      launchUpdate: async (...args) => calls.installs.push(args), ...overrides.updater },
  };
  const filename = path.resolve(__dirname, '../src/main/main.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => mocks[name] || require(name),
    __dirname: path.dirname(filename), process, URL, AbortController,
  }, { filename });
  await new Promise((resolve) => setImmediate(resolve));
  const window = windows[0];
  assert.ok(window);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const invoke = (channel, ...args) => handlers.get(channel)(event, ...args);
  return { app, window, handlers, event, invoke, calls };
}

test('IPC only accepts the exact renderer in the owning main frame', async () => {
  const h = await host();
  await assert.rejects(h.handlers.get('deep:apps')({ ...h.event, sender: {} }), /Untrusted/);
  await assert.rejects(h.handlers.get('deep:apps')({ ...h.event, senderFrame: { url: h.event.senderFrame.url } }), /Untrusted/);
  h.event.senderFrame.url = 'file:///untrusted/renderer/index.html';
  await assert.rejects(h.invoke('deep:apps'), /Untrusted/);
});

test('Deep Delete preview excludes overlapping scan and cleanup operations', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = await host({ deep: { preview: () => pending } });
  const preview = h.invoke('deep:preview', 'app');
  await assert.rejects(h.invoke('scan:start'), /current operation/);
  await assert.rejects(h.invoke('clean:start', { ids: ['i1'] }), /current operation/);
  await assert.rejects(h.invoke('app:relaunch'), /current operation/);
  finish({ id: 'preview', items: [] });
  await preview;
  await h.invoke('scan:start');
});

test('cleanup deduplicates item IDs and Deep Delete invalidates stale scan IDs', async () => {
  const h = await host();
  await h.invoke('scan:start');
  await h.invoke('clean:start', { ids: ['i1', 'i1', '/arbitrary/path'] });
  assert.equal(h.calls.cleaned.length, 1);
  assert.equal(h.calls.cleaned[0].length, 1);
  assert.equal(h.calls.cleaned[0][0].id, 'i1');
  await h.invoke('deep:remove', { previewId: 'p', ids: ['d1'] });
  const result = await h.invoke('clean:start', { ids: ['i1'] });
  assert.equal(result.report.length, 0);
  assert.equal(h.calls.cleaned.length, 1);
});

test('window close, quit and relaunch cannot interrupt a cleanup', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = await host({ deep: { clean: () => pending } });
  const removal = h.invoke('deep:remove', { previewId: 'p', ids: ['d1'] });
  let prevented = 0;
  h.window.emit('close', { preventDefault: () => prevented++ });
  h.app.emit('before-quit', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  await assert.rejects(h.invoke('app:relaunch'), /current operation/);
  finish({ report: [], mode: 'trash' });
  await removal;
  await h.invoke('app:relaunch');
  assert.equal(h.calls.relaunched, 1);
});

test('invalid persisted cleanup modes fall back to Trash', async () => {
  const h = await host({ settings: { mode: 'unexpected' } });
  assert.equal((await h.invoke('settings:get')).mode, 'trash');
});

test('cleanup fails closed if running applications cannot be verified', async () => {
  const h = await host({ system: { runningApps: async () => { throw new Error('Process list unavailable'); } } });
  await h.invoke('scan:start');
  await assert.rejects(h.invoke('clean:start', { ids: ['i1'] }), /Process list unavailable/);
  assert.equal(h.calls.cleaned.length, 0);
  await h.invoke('deep:apps');
});

test('up-to-date updates neither install nor quit the app', async () => {
  const h = await host({ updater: { prepareUpdate: async () => ({ upToDate: true }) } });
  assert.equal((await h.invoke('update:start')).upToDate, true);
  assert.equal(h.calls.installs.length, 0);
  assert.equal(h.calls.quit, 0);
});

test('clicking update also cleans local legacy copies when no new build exists', async () => {
  let cleaned = false;
  const h = await host({ updater: { prepareUpdate: async () => ({ upToDate: true }),
    cleanupUpdateCopies: async () => { cleaned = true; return 3; } } });
  const result = await h.invoke('update:start');
  assert.equal(cleaned, true);
  assert.equal(result.removedCopies, 3);
  assert.equal(h.calls.installs.length, 0);
});

test('updates target the running app location and quit only after scheduling installation', async () => {
  const h = await host();
  await h.invoke('update:start');
  assert.deepEqual(h.calls.installs[0], ['/test/update.app', '/test/cleanMac/cleanMac.app']);
  assert.equal(h.calls.quit, 1);
});
