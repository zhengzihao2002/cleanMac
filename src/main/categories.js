'use strict';

/*
 * What cleanMac looks at. Each category's `collect` returns candidate items
 * (paths + safety verdict); the scanner measures them afterwards.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const R = require('./rules');
const { readPlistStrings } = require('./plist');
const { localSnapshots, userTempRoot } = require('./system');

async function readDir(dir) {
  try {
    return { entries: await fsp.readdir(dir, { withFileTypes: true }) };
  } catch (e) {
    return { entries: [], error: e.code || 'ERROR' };
  }
}

function isRealDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const safeName = (n) => !/[\0\n\r\t]/.test(n);

// Running-app hints for cache folders whose name is not a bundle id.
const RUNNING_HINTS = {
  Google: ['Google Chrome'],
  Firefox: ['Firefox'],
  Mozilla: ['Firefox'],
  BraveSoftware: ['Brave Browser'],
  'Microsoft Edge': ['Microsoft Edge'],
  JetBrains: ['IntelliJ IDEA', 'PyCharm', 'WebStorm', 'GoLand', 'CLion', 'Rider', 'PhpStorm', 'RubyMine', 'DataGrip', 'Android Studio', 'RustRover'],
};

/* ---------------------------------------------------------------- caches */

async function collectAppCaches(ctx) {
  const root = path.join(ctx.home, 'Library/Caches');
  const { entries, error } = await readDir(root);
  if (error && error !== 'ENOENT') return { notice: 'cleanMac could not read your Caches folder.' };
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory() || !safeName(e.name) || R.HIDDEN_CACHES.has(e.name)) continue;
    const name = R.friendlyName(e.name, ctx.appNames);
    const { safety, note } = R.cacheSafety(e.name);
    const runningHints = { bundleIds: [e.name], names: [name, ...(RUNNING_HINTS[e.name] || [])] };
    const running = ctx.running.match(runningHints);
    items.push({
      name,
      detail: null,
      location: path.join(root, e.name),
      paths: [path.join(root, e.name)],
      action: 'contents',
      safety,
      note: note || `Temporary files ${name} keeps to work faster. It rebuilds them automatically when needed.`,
      running,
      runningHints,
    });
  }
  return { items };
}

/* ------------------------------------------------ browser & electron apps */

const NO_DESCEND = new Set([
  'IndexedDB', 'Local Storage', 'Session Storage', 'File System', 'blob_storage', 'databases', 'WebStorage',
  'Extensions', 'extensions', 'node_modules', 'workspaceStorage', 'globalStorage', 'Local Extension Settings',
  'Sync Data', 'shared_proto_db', 'Storage', 'Backups', 'backups', 'Snapshots', 'Media', 'media', 'Downloads',
  'Documents', 'Attachments', 'Library', 'User Content',
]);

function appSupportOwner(rel) {
  const first = rel[0];
  if (R.APP_SUPPORT_VENDORS.has(first) && rel.length > 1) {
    const key = `${first}/${rel[1]}`;
    return { key, name: R.APP_SUPPORT_NAMES[key] || `${first} ${rel[1]}`, hints: [`${first} ${rel[1]}`, rel[1]] };
  }
  return { key: first, name: R.APP_SUPPORT_NAMES[first] || first, hints: [first] };
}

async function hasAnyChild(dir, names) {
  const { entries } = await readDir(dir);
  return entries.some((e) => names.includes(e.name));
}

async function collectWebCaches(ctx) {
  const root = path.join(ctx.home, 'Library/Application Support');
  const groups = new Map();

  const add = (full, spec, rel) => {
    const owner = appSupportOwner(rel);
    const key = `${owner.key}|${spec.safety}`;
    let g = groups.get(key);
    if (!g) {
      const runningHints = { names: [owner.name, ...owner.hints] };
      const running = ctx.running.match(runningHints);
      g = {
        name: owner.name,
        labels: new Set(),
        location: path.join(root, ...owner.key.split('/')),
        paths: [],
        action: 'contents',
        safety: spec.safety,
        note: spec.note || `Caches ${owner.name} rebuilds automatically: downloaded web content, compiled scripts and GPU shaders.`,
        running,
        runningHints,
      };
      groups.set(key, g);
    }
    g.paths.push(full);
    g.labels.add(spec.label);
  };

  const queue = [{ dir: root, rel: [] }];
  let visited = 0;
  while (queue.length && visited < 20000) {
    if (ctx.signal && ctx.signal.aborted) break;
    const { dir, rel } = queue.shift();
    visited++;
    const { entries } = await readDir(dir);
    const depth = rel.length;
    for (const e of entries) {
      if (!e.isDirectory() || !safeName(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (depth === 0) {
        if (R.APP_SUPPORT_SKIP.has(e.name) || e.name.startsWith('com.apple.')) continue;
        if (R.VSCODE_LIKE.has(e.name)) {
          for (const [dirName, spec] of Object.entries(R.VSCODE_DIRS)) {
            const p = path.join(full, dirName);
            if (isRealDir(p)) add(p, spec, [e.name]);
          }
        }
        queue.push({ dir: full, rel: [e.name] });
        continue;
      }
      const chromium = R.CHROMIUM_CACHE_DIRS[e.name];
      if (chromium) {
        if (await hasAnyChild(full, chromium.signature)) add(full, chromium, rel);
        continue;
      }
      if (e.name === 'Service Worker') {
        for (const [dirName, spec] of Object.entries(R.SERVICE_WORKER_DIRS)) {
          const p = path.join(full, dirName);
          if (isRealDir(p)) add(p, spec, rel);
        }
        continue;
      }
      if (NO_DESCEND.has(e.name)) continue;
      if (depth === 1 && R.VSCODE_LIKE.has(rel[0]) && R.VSCODE_DIRS[e.name]) continue;
      if (depth < 4) queue.push({ dir: full, rel: [...rel, e.name] });
    }
  }

  const items = [...groups.values()].map((g) => ({
    ...g,
    detail: [...g.labels].join(' · '),
    labels: undefined,
  }));
  return { items };
}

/* ------------------------------------------------------------------ logs */

const LOG_NAMES = {
  DiagnosticReports: 'Crash & diagnostic reports',
  CoreSimulator: 'Simulator logs',
  JetBrains: 'JetBrains IDE logs',
  Homebrew: 'Homebrew logs',
  CrashReporter: 'Crash reporter logs',
};

async function collectLogs(ctx) {
  const root = path.join(ctx.home, 'Library/Logs');
  const { entries } = await readDir(root);
  const items = [];
  const loose = [];
  for (const e of entries) {
    if (!safeName(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const name = LOG_NAMES[e.name] || R.friendlyName(e.name, ctx.appNames);
      const runningHints = { bundleIds: [e.name], names: [name, ...(RUNNING_HINTS[e.name] || [])] };
      items.push({
        name,
        detail: null,
        location: full,
        paths: [full],
        action: 'contents',
        safety: 'safe',
        note: e.name === 'DiagnosticReports'
          ? 'Reports written when an app crashes or hangs. Useful only if you are debugging a problem.'
          : `Diagnostic logs written by ${name}. Apps do not need old logs to work.`,
        running: ctx.running.match(runningHints),
        runningHints,
      });
    } else if (e.isFile()) {
      loose.push(full);
    }
  }
  if (loose.length) {
    items.push({
      name: 'Other log files',
      detail: `${loose.length} file${loose.length === 1 ? '' : 's'} in ~/Library/Logs`,
      location: root,
      paths: loose,
      action: 'remove',
      safety: 'safe',
      note: 'Loose log files. Apps do not need old logs to work.',
      running: null,
    });
  }
  return { items };
}

/* ------------------------------------------------------------- developer */

async function collectDeveloper(ctx) {
  const items = [];
  for (const t of R.DEVELOPER_TARGETS) {
    const full = path.join(ctx.home, t.rel);
    if (!isRealDir(full)) continue;
    items.push({
      name: t.name,
      detail: null,
      location: full,
      paths: [full],
      action: 'contents',
      safety: t.safety,
      note: t.note,
      running: t.running ? ctx.running.match({ bundleIds: t.running }) : null,
      runningHints: t.running ? { bundleIds: t.running } : null,
    });
  }
  return { items };
}

/* ---------------------------------------------------- sandboxed app caches */

async function collectContainers(ctx) {
  if (!ctx.fda) return { locked: 'fda' };
  const items = [];

  const containers = path.join(ctx.home, 'Library/Containers');
  for (const e of (await readDir(containers)).entries) {
    if (!e.isDirectory() || !safeName(e.name)) continue;
    const p = path.join(containers, e.name, 'Data/Library/Caches');
    if (!isRealDir(p)) continue;
    const name = R.friendlyName(e.name, ctx.appNames);
    const { safety, note } = R.cacheSafety(e.name);
    items.push({
      name,
      detail: null,
      location: p,
      paths: [p],
      action: 'contents',
      safety,
      note: note || `Cache of the sandboxed app ${name}. Rebuilt automatically.`,
      running: ctx.running.match({ bundleIds: [e.name], names: [name] }),
      runningHints: { bundleIds: [e.name], names: [name] },
    });
  }

  const mail = path.join(containers, 'com.apple.mail/Data/Library/Mail Downloads');
  if (isRealDir(mail)) {
    items.push({
      name: 'Mail attachment copies',
      detail: 'Mail Downloads',
      location: mail,
      paths: [mail],
      action: 'contents',
      safety: 'review',
      note: 'Copies of attachments you opened from Mail. Edited copies may contain changes that are not saved in the original message. Keep any changes you need before removing these files.',
      running: ctx.running.match({ bundleIds: ['com.apple.mail'] }),
      runningHints: { bundleIds: ['com.apple.mail'] },
    });
  }

  const groupRoot = path.join(ctx.home, 'Library/Group Containers');
  for (const e of (await readDir(groupRoot)).entries) {
    if (!e.isDirectory() || !safeName(e.name)) continue;
    const p = path.join(groupRoot, e.name, 'Library/Caches');
    if (!isRealDir(p)) continue;
    const bare = e.name.replace(/^[A-Z0-9]{10}\./, '').replace(/^group\./, '');
    const name = R.friendlyName(bare, ctx.appNames);
    const { safety, note } = R.cacheSafety(bare);
    items.push({
      name: `${name} (shared)`,
      detail: null,
      location: p,
      paths: [p],
      action: 'contents',
      safety,
      note: note || `Cache shared by ${name} and its extensions. Rebuilt automatically.`,
      running: ctx.running.match({ bundleIds: [bare], names: [name] }),
      runningHints: { bundleIds: [bare], names: [name] },
    });
  }
  return { items };
}

/* -------------------------------------------------------- iPhone & iPad */

function backupInfo(dir) {
  const strings = readPlistStrings(path.join(dir, 'Info.plist')) || {};
  let when = null;
  try {
    const xml = fs.readFileSync(path.join(dir, 'Info.plist'), 'utf8');
    const m = xml.match(/<key>Last Backup Date<\/key>\s*<date>([^<]+)<\/date>/);
    if (m) when = new Date(m[1]);
  } catch {
    /* ignore */
  }
  if (!when || Number.isNaN(when.getTime())) {
    try {
      when = fs.statSync(dir).mtime;
    } catch {
      when = null;
    }
  }
  return {
    device: strings['Device Name'] || strings['Display Name'] || 'iPhone or iPad',
    product: strings['Product Name'] || strings['Product Type'] || null,
    when,
  };
}

async function collectIOS(ctx) {
  const items = [];
  let notice = null;
  for (const kind of ['iPhone', 'iPad', 'iPod']) {
    const dir = path.join(ctx.home, `Library/iTunes/${kind} Software Updates`);
    for (const e of (await readDir(dir)).entries) {
      if (!e.isFile() || !/\.ipsw$/i.test(e.name) || !safeName(e.name)) continue;
      const full = path.join(dir, e.name);
      items.push({
        name: `${kind} software update`,
        detail: e.name,
        location: full,
        paths: [full],
        action: 'remove',
        safety: 'safe',
        note: 'A firmware file Finder downloaded to update or restore a device. It is downloaded again if ever needed.',
        running: null,
      });
    }
  }

  const backups = path.join(ctx.home, 'Library/Application Support/MobileSync/Backup');
  const { entries, error } = await readDir(backups);
  if (error === 'EPERM' || error === 'EACCES') {
    notice = 'Device backups can only be listed with Full Disk Access.';
  }
  for (const e of entries) {
    if (!e.isDirectory() || !safeName(e.name)) continue;
    const full = path.join(backups, e.name);
    const info = backupInfo(full);
    const date = info.when ? info.when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown date';
    items.push({
      name: `${info.device} backup`,
      detail: `${info.product ? info.product + ' · ' : ''}Last backed up ${date}`,
      location: full,
      paths: [full],
      action: 'remove',
      safety: 'review',
      note: 'A local backup of your device. Remove it only if you back up to iCloud or no longer need it — it is the only copy of this backup.',
      running: null,
    });
  }
  return { items, notice };
}

/* --------------------------------------------- system-wide (administrator) */

async function collectSystem(ctx) {
  const items = [];

  const caches = '/Library/Caches';
  for (const e of (await readDir(caches)).entries) {
    if (!e.isDirectory() || !safeName(e.name)) continue;
    const full = path.join(caches, e.name);
    const apple = e.name.startsWith('com.apple.');
    items.push({
      name: R.friendlyName(e.name, ctx.appNames),
      detail: full,
      location: full,
      paths: [full],
      action: 'contents',
      safety: apple ? 'review' : 'safe',
      note: apple
        ? 'A system-wide cache macOS rebuilds by itself. Some changes only take effect after a restart.'
        : 'A system-wide cache. Rebuilt automatically by the app that created it.',
      running: ctx.running.match({ bundleIds: [e.name], names: [R.friendlyName(e.name, ctx.appNames)] }),
      runningHints: { bundleIds: [e.name], names: [R.friendlyName(e.name, ctx.appNames)] },
      admin: true,
    });
  }

  const logs = '/Library/Logs';
  const loose = [];
  for (const e of (await readDir(logs)).entries) {
    if (!safeName(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(logs, e.name);
    if (e.isDirectory()) {
      items.push({
        name: e.name === 'DiagnosticReports' ? 'System crash reports' : `${R.friendlyName(e.name, ctx.appNames)} logs`,
        detail: full,
        location: full,
        paths: [full],
        action: 'contents',
        safety: 'safe',
        note: 'System-wide log files. macOS and apps do not need old logs to work.',
        running: null,
        admin: true,
      });
    } else if (e.isFile()) {
      loose.push(full);
    }
  }
  if (loose.length) {
    items.push({
      name: 'Other system log files',
      detail: `${loose.length} file${loose.length === 1 ? '' : 's'} in /Library/Logs`,
      location: logs,
      paths: loose,
      action: 'remove',
      safety: 'safe',
      note: 'System-wide log files. macOS and apps do not need old logs to work.',
      running: null,
      admin: true,
    });
  }

  // Archived (rotated) logs only; the live log files stay.
  const varLog = '/private/var/log';
  const archived = [];
  const rotated = /\.(gz|bz2|xz|zip)$|\.\d+$/i;
  for (const e of (await readDir(varLog)).entries) {
    if (!safeName(e.name)) continue;
    const full = path.join(varLog, e.name);
    if (e.isFile() && rotated.test(e.name)) archived.push(full);
    else if (e.isDirectory()) {
      for (const c of (await readDir(full)).entries) {
        if (c.isFile() && rotated.test(c.name) && safeName(c.name)) archived.push(path.join(full, c.name));
      }
    }
  }
  if (archived.length) {
    items.push({
      name: 'Archived system logs',
      detail: `${archived.length} rotated log file${archived.length === 1 ? '' : 's'} in /private/var/log`,
      location: varLog,
      paths: archived,
      action: 'remove',
      safety: 'safe',
      note: 'Old, compressed copies of system logs. The current logs are left untouched.',
      running: null,
      admin: true,
    });
  }
  return { items };
}

/* ------------------------------------------------- Time Machine snapshots */

function snapshotLabel(date) {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function collectSnapshots() {
  const dates = await localSnapshots();
  const items = dates.map((date) => ({
    name: `Snapshot from ${snapshotLabel(date)}`,
    detail: `com.apple.TimeMachine.${date}.local`,
    location: null,
    paths: [],
    action: 'snapshot',
    meta: { date },
    safety: 'review',
    note: 'A local Time Machine snapshot. macOS removes these by itself when it needs space, and your backup disk keeps its own copy. macOS does not report how much space each one uses.',
    running: null,
    admin: true,
    unsized: true,
  }));
  return { items };
}

/* ---------------------------------------------- protected (informational) */

async function collectProtected(ctx) {
  const items = [];
  for (const area of R.PROTECTED_AREAS) {
    let full;
    if (area.tmp) full = userTempRoot();
    else if (area.abs) full = area.abs;
    else full = path.join(ctx.home, area.rel);
    if (!full) continue;
    // Even checking whether something exists inside another app's container
    // can make macOS ask for permission, so only look there with Full Disk Access.
    if (area.fda && !ctx.fda && /Containers\//.test(area.rel || '')) continue;
    let exists = false;
    try {
      fs.lstatSync(full);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const blocked = area.fda && !ctx.fda;
    items.push({
      name: area.name,
      detail: full.startsWith(ctx.home + '/') ? '~' + full.slice(ctx.home.length) : full,
      location: full,
      paths: blocked ? [] : [full],
      action: 'none',
      safety: 'protected',
      note: area.note,
      running: null,
      unsized: blocked,
    });
  }
  return { items, neverTouched: R.NEVER_TOUCHED };
}

const CATEGORIES = [
  {
    id: 'app-caches',
    title: 'App Caches',
    blurb: 'Files apps keep to load faster',
    description: 'Every app keeps a cache in ~/Library/Caches. Apps rebuild their caches automatically, so removing them is safe — an app may simply feel a little slower the first time you open it.',
    icon: 'stack',
    color: '#0A84FF',
    collect: collectAppCaches,
  },
  {
    id: 'web-caches',
    title: 'Browser Caches',
    blurb: 'Chrome, Edge, Arc, Slack, Discord, VS Code…',
    description: 'Chromium-based browsers and Electron apps keep web caches and GPU shader caches inside Application Support. cleanMac only lists folders it has verified to be Chromium caches — never your profiles, history, passwords or app data.',
    icon: 'globe',
    color: '#32ADE6',
    collect: collectWebCaches,
  },
  {
    id: 'logs',
    title: 'Logs & Reports',
    blurb: 'Diagnostic logs apps write over time',
    description: 'Logs and crash reports are written for troubleshooting. Nothing on your Mac needs old logs to work.',
    icon: 'doc',
    color: '#5E5CE6',
    collect: collectLogs,
  },
  {
    id: 'developer',
    title: 'Developer Junk',
    blurb: 'Xcode, simulators and package caches',
    description: 'Build products, device support files and package-manager downloads. Tools rebuild or re-download them when needed.',
    icon: 'hammer',
    color: '#FF9F0A',
    collect: collectDeveloper,
  },
  {
    id: 'containers',
    title: 'Sandboxed Apps',
    blurb: 'Caches of App Store and Apple apps',
    description: 'Sandboxed apps keep their caches inside ~/Library/Containers. macOS only lets cleanMac look there when it has Full Disk Access.',
    icon: 'box',
    color: '#30B0C7',
    requires: 'fda',
    collect: collectContainers,
  },
  {
    id: 'ios',
    title: 'iPhone & iPad Files',
    blurb: 'Firmware downloads and device backups',
    description: 'Firmware files Finder downloaded for updates, and local device backups. Firmware is safe to remove; backups are listed for review only.',
    icon: 'phone',
    color: '#34C759',
    collect: collectIOS,
  },
  {
    id: 'system',
    title: 'System Caches',
    blurb: 'Caches and logs shared by all users',
    description: 'Caches and logs shared by all users. Removing them requires an administrator password, and they are deleted directly (they cannot go to your Trash).',
    icon: 'gear',
    color: '#8E8E93',
    requires: 'admin',
    collect: collectSystem,
  },
  {
    id: 'snapshots',
    title: 'Time Machine Snapshots',
    blurb: 'Local backup snapshots on this disk',
    description: 'Time Machine keeps hourly snapshots on your Mac while your backup disk is away. They count as System Data. macOS removes them automatically when space runs low.',
    icon: 'clock',
    color: '#FF375F',
    requires: 'admin',
    collect: collectSnapshots,
  },
  {
    id: 'protected',
    title: 'Not Safe to Remove',
    blurb: 'Parts of System Data cleanMac leaves alone',
    description: 'These areas also count as System Data, but removing them would lose your data or destabilise macOS. cleanMac shows them so you know where the space goes, and never removes them.',
    icon: 'lock',
    color: '#636366',
    informational: true,
    collect: collectProtected,
  },
];

module.exports = { CATEGORIES, snapshotLabel, appSupportOwner };
