'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const runtime = require('./runtime');

// Redirect every Electron/Chromium storage location before anything else.
const env = runtime.configure(app);

const { createGuard } = require('./guard');
const { scan } = require('./scanner');
const { CATEGORIES } = require('./categories');
const { clean } = require('./cleaner');
const system = require('./system');
const { prepareUpdate, launchUpdate } = require('./updater');
const { createDeepDelete } = require('./deep-delete');

const isMac = process.platform === 'darwin';
const DEBUG = process.env.CLEANMAC_DEBUG === '1';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const HELPER = path.join(__dirname, 'admin-helper.sh');
const DEFAULT_SETTINGS = { mode: 'trash' };

app.setName('cleanMac');

let mainWindow = null;
let settings = runtime.readSettings(env.settingsFile, DEFAULT_SETTINGS);
settings = { mode: settings.mode === 'delete' ? 'delete' : 'trash' };
let scanState = { items: new Map(), controller: null, running: false };
let cleaning = false;
let deepBusy = false;
let updating = false;

const guard = createGuard({
  home: env.home,
  ownPaths: [env.projectRoot, env.sessionDir].filter(Boolean),
});
const deep = createDeepDelete({
  home: env.home,
  ownPaths: [env.projectRoot, env.sessionDir, app.getAppPath()].filter(Boolean),
  ownBundleIds: [env.bundleId],
  trashItem: (p) => shell.trashItem(p),
});

function requireIdle() {
  if (updating) throw new Error('Wait for the update to finish.');
  if (scanState.running) throw new Error('Wait for the scan to finish.');
  if (cleaning || deepBusy) throw new Error('Wait for the current operation to finish.');
}

/* ------------------------------------------------------------- window */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'cleanMac',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    backgroundColor: isMac ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: DEBUG || !app.isPackaged,
    },
  });

  mainWindow.loadFile(RENDERER, { query: { platform: process.platform } });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (cleaning || updating) {
      event.preventDefault();
      send('app:notice', 'Please wait for cleanup or the update to finish before closing cleanMac.');
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    try {
      if (fileURLToPath(new URL(url)) !== RENDERER) e.preventDefault();
    } catch {
      e.preventDefault();
    }
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildMenu() {
  const nav = (view) => () => send('app:navigate', view);
  const template = [
    ...(isMac
      ? [
          {
            label: 'cleanMac',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: nav('settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    { role: 'editMenu' },
    {
      label: 'Scan',
      submenu: [
        { label: 'Start Scan', accelerator: 'CmdOrCtrl+R', click: () => send('app:command', 'scan') },
        { label: 'Overview', accelerator: 'CmdOrCtrl+1', click: nav('home') },
        { label: 'Deep Delete', accelerator: 'CmdOrCtrl+2', click: nav('deep-delete') },
      ],
    },
    ...(DEBUG || !app.isPackaged ? [{ role: 'viewMenu' }] : []),
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'How cleanMac Decides What Is Safe', click: nav('settings') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- IPC */

function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'file:' && fileURLToPath(url) === RENDERER;
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted sender');
    return fn(event, ...args);
  });
}

function registerIpc() {
  handle('system:info', async () => {
    const [disk, version] = await Promise.all([system.diskInfo(env.home), system.macosVersion()]);
    return {
      platform: process.platform,
      home: env.home,
      user: require('os').userInfo().username,
      macos: version,
      disk,
      fda: system.hasFullDiskAccess(env.home),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        projectRoot: env.projectRoot,
        settingsPersisted: !!env.settingsFile,
      },
    };
  });

  handle('categories:list', async () =>
    CATEGORIES.map((c) => ({
      id: c.id,
      title: c.title,
      blurb: c.blurb,
      icon: c.icon,
      color: c.color,
      requires: c.requires || null,
      informational: !!c.informational,
    })),
  );

  handle('scan:start', async () => {
    requireIdle();
    deep.invalidate();
    const controller = new AbortController();
    scanState = { items: new Map(), controller, running: true };
    try {
      const { result, items } = await scan({
        home: env.home,
        guard,
        signal: controller.signal,
        emit: (p) => send('scan:progress', p),
      });
      scanState.items = items;
      return result;
    } finally {
      scanState.running = false;
      scanState.controller = null;
    }
  });

  handle('scan:cancel', async () => {
    if (scanState.controller) scanState.controller.abort();
    return true;
  });

  handle('clean:start', async (_e, payload) => {
    requireIdle();
    const ids = Array.isArray(payload && payload.ids) ? [...new Set(payload.ids.filter((x) => typeof x === 'string'))] : [];
    const mode = payload && payload.mode === 'delete' ? 'delete' : 'trash';
    const items = ids.map((id) => scanState.items.get(id)).filter(Boolean);
    if (items.length === 0) return { report: [], diskBefore: null, diskAfter: null, mode };

    cleaning = true;
    deep.invalidate();
    try {
      const running = system.createRunningIndex(await system.runningApps(env.home, { strict: true }));
      const diskBefore = await system.diskInfo(env.home);
      const report = await clean(items, {
        mode,
        guard,
        helperPath: HELPER,
        trashItem: (p) => shell.trashItem(p),
        running,
        onProgress: (p) => send('clean:progress', p),
      });
      for (const r of report) {
        if (r.ok) scanState.items.delete(r.id);
        else if (r.remaining != null && scanState.items.has(r.id)) scanState.items.get(r.id).size = r.remaining;
      }
      const diskAfter = await system.diskInfo(env.home);
      return { report, diskBefore, diskAfter, mode };
    } finally {
      cleaning = false;
    }
  });

  handle('deep:apps', async () => {
    requireIdle();
    deepBusy = true;
    try {
      return await deep.listApps();
    } finally {
      deepBusy = false;
    }
  });

  handle('deep:preview', async (_e, appId) => {
    requireIdle();
    deepBusy = true;
    try {
      return await deep.preview(appId);
    } finally {
      deepBusy = false;
    }
  });

  handle('deep:remove', async (_e, payload) => {
    requireIdle();
    cleaning = true;
    try {
      const diskBefore = await system.diskInfo(env.home);
      const result = await deep.clean({
        previewId: payload && payload.previewId,
        ids: payload && payload.ids,
        onProgress: (p) => send('deep:progress', p),
      });
      // A preview may overlap a Smart Scan. Those old capabilities must not
      // remain usable after any files have been moved or changed.
      scanState.items.clear();
      const diskAfter = await system.diskInfo(env.home);
      return { ...result, diskBefore, diskAfter };
    } finally {
      cleaning = false;
    }
  });

  handle('deep:reveal', async (_e, payload) => {
    const target = await deep.revealPath(payload && payload.previewId, payload && payload.id);
    if (target) shell.showItemInFolder(target);
    return !!target;
  });

  handle('item:reveal', async (_e, id) => {
    const item = scanState.items.get(id);
    const target = item && (item.paths[0] || item.location);
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    else if (item && item.location && fs.existsSync(item.location)) shell.openPath(item.location);
    return true;
  });

  handle('app:open-fda', async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return true;
  });

  handle('app:open-trash', async () => {
    await shell.openPath(path.join(env.home, '.Trash'));
    return true;
  });

  handle('app:open-project', async () => {
    if (env.projectRoot && fs.existsSync(env.projectRoot)) await shell.openPath(env.projectRoot);
    return true;
  });

  handle('app:relaunch', async () => {
    requireIdle();
    // app.exit() skips 'will-quit', so sweep explicitly.
    runtime.sweepOnExit(env.sessionDir);
    app.relaunch();
    app.exit(0);
  });

  handle('settings:get', async () => ({ ...settings }));

  handle('update:start', async () => {
    requireIdle();
    updating = true;
    try {
      const result = await prepareUpdate({ projectRoot: env.projectRoot, appPath: app.getAppPath(), currentVersion: app.getVersion(),
        progress: (message) => send('update:progress', message) });
      if (result.upToDate) return result;
      send('update:progress', `Opening cleanMac ${result.version}…`);
      await launchUpdate(result.application);
      updating = false;
      app.quit();
      return { version: result.version };
    } finally { updating = false; }
  });

  handle('settings:set', async (_e, patch) => {
    if (patch && (patch.mode === 'trash' || patch.mode === 'delete')) settings.mode = patch.mode;
    runtime.writeSettings(env.settingsFile, settings);
    return { ...settings };
  });
}

/* ---------------------------------------------------------- lifecycle */

app.setAboutPanelOptions({
  applicationName: 'cleanMac',
  applicationVersion: app.getVersion(),
  version: `Electron ${process.versions.electron}`,
  copyright: 'Cleanup runs locally. Network access only for requested updates. No tracking.',
});

app.whenReady().then(() => {
  // No network: cleanMac never talks to the internet.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) =>
    cb({ cancel: true }),
  );
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// Closing the window or using Cmd+Q must not terminate a filesystem operation
// halfway through its reviewed selection.
app.on('before-quit', (event) => {
  if (cleaning || updating) {
    event.preventDefault();
    send('app:notice', 'Please wait for cleanup or the update to finish before quitting cleanMac.');
  }
});

app.on('will-quit', () => {
  if (scanState.controller) scanState.controller.abort();
  runtime.sweepOnExit(env.sessionDir);
});
