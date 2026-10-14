'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const runtime = require('./runtime');

// Redirect every Electron/Chromium storage location before anything else.
const env = runtime.configure(app);

const { createGuard } = require('./guard');
const { scan } = require('./scanner');
const { CATEGORIES } = require('./categories');
const { clean } = require('./cleaner');
const system = require('./system');

const isMac = process.platform === 'darwin';
const DEBUG = process.env.CLEANMAC_DEBUG === '1';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const HELPER = path.join(__dirname, 'admin-helper.sh');
const DEFAULT_SETTINGS = { mode: 'trash' };

app.setName('cleanMac');

let mainWindow = null;
let settings = runtime.readSettings(env.settingsFile, DEFAULT_SETTINGS);
let scanState = { items: new Map(), controller: null, running: false };
let cleaning = false;

const guard = createGuard({
  home: env.home,
  ownPaths: [env.projectRoot, env.sessionDir].filter(Boolean),
});

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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
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
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://') && url.includes('/renderer/index.html');
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
    if (scanState.running) throw new Error('A scan is already running');
    if (cleaning) throw new Error('Cleaning is in progress');
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
    if (cleaning) throw new Error('Already cleaning');
    if (scanState.running) throw new Error('Wait for the scan to finish');
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.filter((x) => typeof x === 'string') : [];
    const mode = payload && payload.mode === 'delete' ? 'delete' : 'trash';
    const items = ids.map((id) => scanState.items.get(id)).filter(Boolean);
    if (items.length === 0) return { report: [], diskBefore: null, diskAfter: null, mode };

    cleaning = true;
    try {
      const diskBefore = await system.diskInfo(env.home);
      const report = await clean(items, {
        mode,
        guard,
        helperPath: HELPER,
        trashItem: (p) => shell.trashItem(p),
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
    // app.exit() skips 'will-quit', so sweep explicitly.
    runtime.sweepOnExit(env.sessionDir);
    app.relaunch();
    app.exit(0);
  });

  handle('settings:get', async () => ({ ...settings }));

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
  copyright: 'Runs entirely on your Mac. No network access, no tracking.',
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

app.on('will-quit', () => {
  if (scanState.controller) scanState.controller.abort();
  runtime.sweepOnExit(env.sessionDir);
});
