'use strict';

/*
 * Facts about the Mac: disk space, permissions, installed and running apps,
 * Time Machine snapshots. Everything here is read-only.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { readPlistStrings } = require('./plist');
const { isPromptingLocation } = require('./runtime');

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function diskInfo(target) {
  try {
    const s = await fsp.statfs(target);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return null;
  }
}

async function macosVersion() {
  if (process.platform !== 'darwin') return null;
  const r = await run('/usr/bin/sw_vers', ['-productVersion']);
  return r.ok ? r.stdout.trim() : null;
}

/*
 * Full Disk Access can't be queried directly; the reliable test is to try to
 * list a folder that only Full-Disk-Access apps may read. Listing (not
 * reading files) never triggers a permission prompt.
 */
function hasFullDiskAccess(home) {
  if (process.platform !== 'darwin') return false;
  const probes = [
    path.join(home, 'Library/Safari'),
    path.join(home, 'Library/Mail'),
    path.join(home, 'Library/Messages'),
    path.join(home, 'Library/Containers/com.apple.stocks'),
    '/Library/Application Support/com.apple.TCC',
  ];
  for (const p of probes) {
    try {
      fs.readdirSync(p);
      return true;
    } catch {
      // Missing, or blocked by privacy protection: try the next one.
    }
  }
  return false;
}

/* ---------- Installed applications: bundle id -> display name ---------- */

function appInfo(bundlePath) {
  const plist = readPlistStrings(path.join(bundlePath, 'Contents', 'Info.plist'));
  const fallback = path.basename(bundlePath).replace(/\.app$/i, '');
  // The bundle's file name is what people see in Finder ("Visual Studio Code"
  // rather than its internal name "Code").
  return { bundleId: (plist && plist.CFBundleIdentifier) || null, name: fallback, path: bundlePath };
}

async function installedApps(home) {
  const roots = [
    { dir: '/Applications', depth: 2 },
    { dir: '/System/Applications', depth: 2 },
    { dir: '/System/Library/CoreServices', depth: 1 },
    { dir: '/System/Library/CoreServices/Applications', depth: 1 },
    { dir: path.join(home, 'Applications'), depth: 2 },
  ];
  const byId = new Map();
  const visit = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (/\.app$/i.test(e.name)) {
        const info = appInfo(full);
        if (info.bundleId && !byId.has(info.bundleId)) byId.set(info.bundleId, info.name);
      } else if (depth > 1 && !e.name.startsWith('.')) {
        await visit(full, depth - 1);
      }
    }
  };
  for (const r of roots) await visit(r.dir, r.depth);
  return byId;
}

/* ---------- Running applications ---------- */

/*
 * `ps` prints the executable path of every process. Anything that runs from
 * inside an .app bundle (including helper processes) is attributed to the
 * outermost bundle, whose Info.plist gives us the bundle id.
 */
async function runningApps(home = os.homedir(), { strict = false } = {}) {
  const r = await run('/bin/ps', ['-axww', '-o', 'comm=']);
  if (!r.ok && strict) throw new Error('Could not verify running applications. Try again before removing an app.');
  if (!r.ok && !r.stdout) return [];
  const bundles = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\/.*?\.app)\//i);
    if (m) bundles.add(m[1]);
  }
  const apps = [];
  for (const b of bundles) {
    // Reading inside Desktop, Documents or Downloads would make macOS show a
    // permission prompt, so apps running from there are known by name only.
    if (isPromptingLocation(b, home)) {
      apps.push({ bundleId: null, name: path.basename(b).replace(/\.app$/i, ''), path: b });
    } else {
      apps.push(appInfo(b));
    }
  }
  return apps;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function createRunningIndex(apps) {
  const ids = new Set();
  const names = new Map();
  for (const a of apps) {
    if (a.bundleId) ids.add(a.bundleId.toLowerCase());
    if (a.name) names.set(norm(a.name), a.name);
  }
  return {
    /** Returns the running app's name if any hint matches, else null. */
    match({ bundleIds = [], names: hints = [] } = {}) {
      for (const id of bundleIds) {
        if (!id) continue;
        const lower = id.toLowerCase();
        for (const running of ids) {
          if (running === lower || lower.startsWith(running + '.')) {
            const app = apps.find((a) => a.bundleId && a.bundleId.toLowerCase() === running);
            return app ? app.name : id;
          }
        }
      }
      for (const n of hints) {
        const key = norm(n);
        if (key && names.has(key)) return names.get(key);
      }
      return null;
    },
    count: apps.length,
  };
}

/* ---------- macOS file flags ---------- */

/*
 * Folders flagged "restricted" (System Integrity Protection) or immutable
 * cannot be emptied by any app, so cleanMac does not offer them. Reads the
 * flags of many paths with a single `ls -lOd` call.
 */
async function lockedPaths(paths) {
  const locked = new Set();
  if (process.platform !== 'darwin' || paths.length === 0) return locked;
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const r = await run('/bin/ls', ['-lOd', ...batch]);
    for (const line of r.stdout.split('\n')) {
      const target = batch.find((p) => line.endsWith(` ${p}`));
      if (!target) continue;
      const flags = (line.trim().split(/\s+/)[4] || '').split(',');
      if (flags.some((f) => f === 'restricted' || f === 'schg' || f === 'uchg')) locked.add(target);
    }
  }
  return locked;
}

/* ---------- Time Machine local snapshots ---------- */

async function localSnapshots() {
  if (process.platform !== 'darwin') return [];
  const r = await run('/usr/bin/tmutil', ['listlocalsnapshotdates', '/']);
  if (!r.ok) return [];
  const dates = r.stdout.match(/\b\d{4}-\d{2}-\d{2}-\d{6}\b/g) || [];
  return [...new Set(dates)];
}

function userTempRoot() {
  // os.tmpdir() is /var/folders/xx/yyyy/T on macOS; its parent holds this
  // user's temporary (T) and cache (C) folders.
  if (process.platform !== 'darwin') return null;
  try {
    const root = fs.realpathSync(path.dirname(os.tmpdir()));
    return root.startsWith('/private/var/folders/') ? root : null;
  } catch {
    return null;
  }
}

module.exports = {
  run,
  diskInfo,
  macosVersion,
  hasFullDiskAccess,
  installedApps,
  runningApps,
  createRunningIndex,
  lockedPaths,
  localSnapshots,
  userTempRoot,
};
