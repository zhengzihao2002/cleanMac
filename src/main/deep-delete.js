'use strict';

/*
 * Deep Delete has its own narrow allow-list: unlike cache cleaning, removing
 * an application can also remove its preferences and private data. The UI
 * receives opaque IDs, never authority to submit a filesystem path.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { readPlistStrings } = require('./plist');
const { measure } = require('./sizer');
const system = require('./system');
const { BUNDLE_ID } = require('./runtime');

const ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const UUID_RE = '[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}';
// Explicit app-specific folders only: never remove the vendor parent or
// infer ownership from an application's display name.
const SUPPORT_FOLDERS = {
  'com.google.Chrome': 'Google/Chrome',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.Browser': 'BraveSoftware/Brave-Browser',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'discord',
  'com.microsoft.VSCode': 'Code',
};
const LIMITATIONS = [
  'Files are matched by exact bundle identifiers or explicit known app-specific folder mappings in Library locations. Files stored elsewhere may remain.',
  'Shared Group Containers, vendor folders, privileged helpers, launch services and personal documents are not included.',
  'App data, preferences and containers may contain saved work or sign-in information. They are unchecked until you choose them.',
  'Everything is moved to Trash. Disk space is recovered after you empty Trash; the original free-space amount cannot be guaranteed.',
];

function contains(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

function fileIdentity(st) {
  return [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(':');
}

function message(error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'macOS denied access. Check file permissions or Full Disk Access.';
  if (error.code === 'ENOENT') return 'The file no longer exists. Scan the application again.';
  return error.message || 'The file could not be accessed.';
}

/**
 * Dependencies are injectable so tests use an isolated macOS-shaped tree.
 * appRoots: strings or {dir, depth, protected}; systemLibrary may be null.
 * runningApps must return an array, and throw when process discovery fails.
 */
function createDeepDelete({
  home = os.homedir(),
  appRoots,
  systemLibrary = '/Library',
  ownPaths = [],
  ownBundleIds = [],
  runningApps = () => system.runningApps(home, { strict: true }),
  trashItem,
  measurePath = measure,
  platform = process.platform,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || path.normalize(home) === '/') throw new Error('Invalid home folder.');
  home = fs.realpathSync(home);
  const insensitive = platform === 'darwin';
  const key = (p) => insensitive ? p.toLowerCase() : p;
  const roots = (appRoots || [
    { dir: '/Applications', depth: 3 },
    { dir: path.join(home, 'Applications'), depth: 3 },
    { dir: '/System/Applications', depth: 3, protected: true },
    { dir: '/System/Library/CoreServices', depth: 2, protected: true },
  ]).map((r) => typeof r === 'string' ? { dir: r, depth: 3 } : { depth: 3, ...r })
    .filter((r) => typeof r.dir === 'string' && path.isAbsolute(r.dir))
    .map((r) => ({ ...r, dir: path.resolve(r.dir), depth: Math.min(6, Math.max(1, r.depth || 1)) }));
  const own = ownPaths.filter((p) => typeof p === 'string' && path.isAbsolute(p)).map((p) => {
    try { return key(fs.realpathSync(p)); } catch { return key(path.resolve(p)); }
  });
  const ownIds = new Set([BUNDLE_ID, ...ownBundleIds].map((id) => String(id).toLowerCase()));
  const apps = new Map();
  const previews = new Map();
  let appDirectories = new Map();
  let catalogComplete = true;
  let listing = false;
  let cleaning = false;

  function ownsPath(target) {
    const p = key(target);
    return own.some((o) => contains(o, p) || contains(p, o));
  }

  // lstat every segment, including the leaf. Merely resolving the parent
  // would allow an app or its data folder to be replaced with a symlink.
  async function inspect(target, { protectOwn = true } = {}) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || /[\0\r\n\t]/.test(target) || path.normalize(target) !== target) {
      throw new Error('Unsupported filesystem path.');
    }
    if (protectOwn && ownsPath(target)) throw new Error('This location belongs to cleanMac.');
    const segments = target.split(path.sep).filter(Boolean);
    let current = path.parse(target).root;
    let st;
    for (const part of segments) {
      current = path.join(current, part);
      st = await fsp.lstat(current);
      if (st.isSymbolicLink()) throw new Error('Symbolic links are excluded from Deep Delete.');
    }
    if (!st || (!st.isDirectory() && !st.isFile())) throw new Error('Unsupported file type.');
    return { st, identity: fileIdentity(st) };
  }

  async function readApp(bundlePath) {
    const infoFile = path.join(bundlePath, 'Contents', 'Info.plist');
    const metadata = await inspect(infoFile);
    const info = readPlistStrings(infoFile);
    const bundleId = info && info.CFBundleIdentifier;
    return { bundleId: ID_RE.test(bundleId || '') ? bundleId : null, metadataIdentity: metadata.identity };
  }

  async function processes() {
    const result = await runningApps();
    if (!Array.isArray(result)) throw new Error('Could not verify which applications are running. Try again.');
    return result;
  }

  function runningName(app, running) {
    const found = running.find((r) => (r.bundleId && app.bundleId && r.bundleId.toLowerCase() === app.bundleId.toLowerCase()) ||
      (typeof r.path === 'string' && key(path.normalize(r.path)) === key(app.path)));
    return found ? found.name || app.name : null;
  }

  function publicApp(app, running) {
    return { id: app.id, name: app.name, bundleId: app.bundleId, path: app.path,
      protected: !!app.reason, reason: app.reason || null, running: runningName(app, running) };
  }

  async function listApps() {
    if (cleaning || listing) throw new Error('Deep Delete is busy.');
    listing = true;
    try {
      const errors = [];
      const discovered = new Map();
      const directories = new Map();
      const running = await processes();
      const visit = async (dir, depth, protectedRoot) => {
        let entries;
        try {
          const checked = await inspect(dir, { protectOwn: false });
          directories.set(dir, checked.identity);
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (error.code === 'ENOENT') directories.set(dir, null);
          if (error.code !== 'ENOENT') errors.push({ path: dir, error: message(error) });
          return;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const target = path.join(dir, entry.name);
          if (!/\.app$/i.test(entry.name)) {
            if (depth > 1) await visit(target, depth - 1, protectedRoot);
            continue;
          }
          if (discovered.has(target)) continue;
          const app = { id: randomUUID(), name: entry.name.replace(/\.app$/i, ''), path: target, root: dir,
            bundleId: null, identity: null, metadataIdentity: null, reason: null };
          try {
            app.identity = (await inspect(target)).identity;
            Object.assign(app, await readApp(target));
          } catch (error) {
            app.reason = message(error);
          }
          if (protectedRoot || contains('/System', target)) app.reason = 'macOS system applications are protected.';
          else if (app.bundleId && /^com\.apple\./i.test(app.bundleId)) app.reason = 'Apple applications are protected.';
          else if (ownsPath(target) || (app.bundleId && ownIds.has(app.bundleId.toLowerCase()))) app.reason = 'cleanMac cannot remove itself.';
          else if (!app.bundleId) app.reason ||= 'A valid application bundle identifier could not be read.';
          discovered.set(target, app);
        }
      };
      for (const root of roots) await visit(root.dir, root.depth, !!root.protected);
      await verifyDirectories(directories);
      apps.clear();
      previews.clear();
      appDirectories = directories;
      catalogComplete = errors.length === 0;
      for (const app of discovered.values()) apps.set(app.id, app);
      return { apps: [...apps.values()].map((a) => publicApp(a, running)).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)), errors };
    } finally { listing = false; }
  }

  function candidates(app) {
    const id = app.bundleId;
    const specs = [
      ['Caches', id, 'cache', 'Application cache', 'Temporary files owned by this app.'],
      ['Logs', id, 'logs', 'Application logs', 'Diagnostic and activity logs owned by this app.'],
      ['Application Support', id, 'support', 'Application support data', 'May contain saved work, databases, downloads or account data.'],
      ['Preferences', id + '.plist', 'preferences', 'Preferences', 'Removes settings and may reset account information.'],
      ['Saved Application State', id + '.savedState', 'saved-state', 'Saved window state', 'May contain unsaved window or session state.'],
      ['Containers', id, 'container', 'Sandbox container', 'May contain documents and all private application data.'],
      ['Application Scripts', id, 'support', 'Application scripts', 'Application-specific scripts and automation data.'],
      ['HTTPStorages', id, 'web-data', 'Web storage', 'May contain sign-ins and local website data.'],
      ['HTTPStorages', id + '.binarycookies', 'web-data', 'Web cookies', 'May contain saved sign-ins.'],
      ['WebKit', id, 'web-data', 'WebKit data', 'May contain sign-ins and offline website data.'],
      ['Cookies', id + '.binarycookies', 'web-data', 'Cookies', 'May contain saved sign-ins.'],
    ];
    const out = specs.map(([parent, leaf, kind, name, note]) => ({ path: path.join(home, 'Library', parent, leaf), kind, name, note }));
    if (SUPPORT_FOLDERS[id]) {
      out.push({ path: path.join(home, 'Library/Application Support', SUPPORT_FOLDERS[id]), kind: 'support',
        name: 'Known application support folder', note: 'An explicit folder mapping for this bundle identifier. May contain saved work, browser profiles, extensions, databases and sign-ins.' });
    }
    if (systemLibrary) {
      for (const [parent, leaf, kind, name, note] of specs.slice(0, 4)) {
        out.push({ path: path.join(systemLibrary, parent, leaf), kind, name: 'System ' + name.toLowerCase(),
          note: note + ' macOS may require additional filesystem permissions.' });
      }
    }
    return out;
  }

  async function verifyApp(app) {
    if (app.reason) throw new Error(app.reason);
    if ((await inspect(app.path)).identity !== app.identity) throw new Error('The application changed. Refresh the application list.');
    const fresh = await readApp(app.path);
    if (fresh.bundleId !== app.bundleId || fresh.metadataIdentity !== app.metadataIdentity) throw new Error('The application identity changed. Refresh the application list.');
  }

  async function buildPreview(appId) {
    const app = apps.get(appId);
    if (!app) throw new Error('Application not found. Refresh the application list.');
    await verifyApp(app);
    const running = await processes();
    const active = runningName(app, running);
    const notices = [];
    if (active) notices.unshift(`Quit ${active} before moving any files to Trash.`);
    const items = new Map();
    const add = async (candidate) => {
      try {
        const { identity } = await inspect(candidate.path);
        const measured = await measurePath(candidate.path);
        const item = { ...candidate, id: randomUUID(), identity, size: Math.max(0, measured.bytes || 0),
          partial: !!measured.partial, selectable: !measured.partial, defaultSelected: candidate.kind === 'application' && !active && !measured.partial,
          safety: 'review',
          location: contains(home, candidate.path) ? '~' + candidate.path.slice(home.length) : candidate.path };
        if (measured.partial) {
          item.note += ' Some files could not be read; this item cannot be removed until a complete preview is available.';
          notices.push(`${item.path}: Some files could not be read. Check permissions and preview again.`);
        }
        items.set(item.id, item);
      } catch (error) {
        if (error.code !== 'ENOENT') notices.push(`${candidate.path}: ${message(error)}`);
      }
    };
    await add({ path: app.path, kind: 'application', name: app.name + '.app', note: 'The installed application bundle.' });
    const copies = [...apps.values()].filter((a) => a.bundleId && a.bundleId.toLowerCase() === app.bundleId.toLowerCase());
    if (!catalogComplete) {
      notices.push('Some application locations could not be checked. Application data is excluded because another installed copy may share it.');
    } else if (copies.length > 1) {
      notices.push('Another installed copy uses this bundle identifier. Shared application data is excluded so that copy keeps working.');
    } else {
      for (const candidate of candidates(app)) await add(candidate);
      // ByHost preferences carry a hardware UUID, not an arbitrary name suffix.
      const byHost = path.join(home, 'Library/Preferences/ByHost');
      try {
        await inspect(byHost);
        const pattern = new RegExp('^' + app.bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.' + UUID_RE + '\\.plist$');
        for (const leaf of await fsp.readdir(byHost)) {
          if (pattern.test(leaf)) await add({ path: path.join(byHost, leaf), kind: 'preferences', name: 'Device-specific preferences', note: 'Application settings for this Mac.' });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') notices.push(`${byHost}: ${message(error)}`);
      }
    }
    const id = randomUUID();
    // Bound retained previews; stale UI selections fail instead of targeting
    // a different scan. No caller ever receives the private identities.
    if (previews.size >= 20) previews.delete(previews.keys().next().value);
    previews.set(id, { app, items });
    return { id, app: publicApp(app, running), items: [...items.values()].map(({ identity, ...i }) => i),
      totalBytes: [...items.values()].reduce((sum, i) => sum + i.size, 0), notices, limitations: [...LIMITATIONS], running: active };
  }

  async function preview(appId) {
    if (cleaning || listing) throw new Error('Deep Delete is busy.');
    listing = true;
    try { return await buildPreview(appId); } finally { listing = false; }
  }

  async function verifyDirectories(directories) {
    for (const [dir, identity] of directories) {
      try {
        if ((await inspect(dir, { protectOwn: false })).identity !== identity) throw new Error('Changed directory');
      } catch (error) {
        if (identity === null && error.code === 'ENOENT') continue;
        throw new Error('Installed applications changed after discovery. Refresh the application list.');
      }
    }
  }

  async function verifyCatalog() { await verifyDirectories(appDirectories); }

  async function clean({ previewId, ids, onProgress = () => {} } = {}) {
    if (cleaning || listing) throw new Error('Deep Delete is busy.');
    const saved = previews.get(previewId);
    if (!saved) throw new Error('This preview expired. Preview the application again.');
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !saved.items.has(id))) {
      throw new Error('Choose files from the current Deep Delete preview.');
    }
    if (typeof trashItem !== 'function') throw new Error('Moving files to Trash is unavailable.');
    const selected = [...new Set(ids)].map((id) => saved.items.get(id));
    if (selected.some((i) => !i.selectable)) throw new Error('Files with incomplete previews cannot be removed.');
    cleaning = true;
    try {
      await verifyApp(saved.app);
      await verifyCatalog();
      const initialRunning = runningName(saved.app, await processes());
      if (initialRunning) throw new Error(`Quit ${initialRunning} before moving its files to Trash.`);
      // Consume the preview once a valid operation begins. Repeat requests
      // cannot replay a prior authorization after a file has been replaced.
      previews.delete(previewId);
      const report = [];
      let appRemoved = false;
      // Move the app last: a failed data move does not hide the still-installed
      // app, and a running-process check can still inspect its bundle.
      selected.sort((a, b) => Number(a.kind === 'application') - Number(b.kind === 'application'));
      for (const item of selected) {
        onProgress({ done: report.length, total: selected.length, current: item.name });
        const result = { id: item.id, name: item.name, path: item.path, size: item.size, ok: false, partial: false, errors: [], trashedBytes: 0 };
        try {
          if (item.kind === 'application' && report.some((r) => !r.ok)) {
            throw new Error('Some selected files could not be moved. The application was kept so you can fix the issue and retry.');
          }
          const active = runningName(saved.app, await processes());
          if (active) throw new Error(`Quit ${active} before moving its files to Trash.`);
          await verifyApp(saved.app);
          await verifyCatalog();
          const fresh = await inspect(item.path);
          if (fresh.identity !== item.identity) throw new Error('This file changed after the preview. Preview the application again.');
          await trashItem(item.path);
          // A successful API response is insufficient if the source remains.
          try {
            await fsp.lstat(item.path);
            throw new Error('The file is still in its original location. No successful move was confirmed.');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          result.ok = true;
          result.trashedBytes = item.size;
          if (item.kind === 'application') appRemoved = true;
        } catch (error) { result.errors.push(message(error)); }
        report.push(result);
      }
      onProgress({ done: selected.length, total: selected.length, current: null });
      // Other previews for this app would now be misleading.
      for (const [id, p] of previews) if (p.app.id === saved.app.id) previews.delete(id);
      if (appRemoved) apps.delete(saved.app.id);
      return { report, mode: 'trash', trashedBytes: report.reduce((sum, r) => sum + r.trashedBytes, 0), reclaimedBytes: 0, appRemoved };
    } finally { cleaning = false; }
  }

  async function revealPath(previewId, itemId) {
    const item = previews.get(previewId)?.items.get(itemId);
    if (!item) return null;
    try { return (await inspect(item.path)).identity === item.identity ? item.path : null; } catch { return null; }
  }

  function invalidate() { apps.clear(); previews.clear(); appDirectories.clear(); }

  return { listApps, preview, clean, revealPath, invalidate };
}

module.exports = { createDeepDelete, LIMITATIONS };
