'use strict';

/*
 * "Leave no trace" plumbing.
 *
 * Electron/Chromium normally write to ~/Library/Application Support/<app>,
 * ~/Library/Caches, the login keychain and more. cleanMac redirects all of it
 * into one private temporary folder that is erased when the app quits, and
 * sweeps the few files macOS itself may create for any app.
 *
 * The only file cleanMac keeps between launches is its settings file, stored
 * inside the project folder (.runtime/settings.json), so deleting the project
 * folder removes it too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BUNDLE_ID = 'local.cleanmac.app';

const SESSION_PREFIX = 'cleanmac-session-';

// One private folder per launch, so a quick relaunch never shares (or has
// swept away) the folder of the instance that is quitting.
function sessionDirPath() {
  return path.join(os.tmpdir(), `${SESSION_PREFIX}${process.pid}`);
}

// Remove folders left behind by sessions that did not exit cleanly.
function removeStaleSessions() {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX)) continue;
    const pid = Number(name.slice(SESSION_PREFIX.length));
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code === 'EPERM';
    }
    if (!alive) {
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// Folders that make macOS show a permission prompt when an app touches them.
function isPromptingLocation(p, home) {
  const guarded = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'];
  if (guarded.some((g) => p === path.join(home, g) || p.startsWith(path.join(home, g) + '/'))) return true;
  return p.startsWith('/Volumes/');
}

function resolveProjectRoot(app) {
  if (!app.isPackaged) return app.getAppPath();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8'));
    return typeof info.projectRoot === 'string' && path.isAbsolute(info.projectRoot) ? info.projectRoot : null;
  } catch {
    return null;
  }
}

function configure(app) {
  const home = os.homedir();
  removeStaleSessions();
  const sessionDir = sessionDirPath();
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  // Must happen before the app is ready, so nothing is ever written to the
  // default locations in ~/Library.
  app.setPath('userData', sessionDir);
  app.setPath('sessionData', sessionDir);
  app.setPath('crashDumps', path.join(sessionDir, 'crashes'));
  app.setPath('logs', path.join(sessionDir, 'logs'));

  // Chromium would otherwise create a "cleanMac Safe Storage" keychain entry.
  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('disable-http-cache');

  const projectRoot = resolveProjectRoot(app);
  const canPersist = !!projectRoot && !isPromptingLocation(projectRoot, home);
  const settingsFile = canPersist ? path.join(projectRoot, '.runtime', 'settings.json') : null;

  return { home, sessionDir, projectRoot, settingsFile, bundleId: BUNDLE_ID };
}

function readSettings(file, defaults) {
  if (!file) return { ...defaults };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

function writeSettings(file, settings) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

/*
 * After cleanMac exits, a tiny detached shell removes the session folder and
 * anything macOS created on the app's behalf (window state, preference
 * domain, per-app system caches). It waits for the app to exit first so
 * nothing is re-created afterwards.
 */
function sweepOnExit(sessionDir) {
  const id = BUNDLE_ID;
  const script = `
    while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
    sleep 0.5
    rm -rf "$1"
    [ "$(uname -s)" = "Darwin" ] || exit 0
    rm -rf "$HOME/Library/Saved Application State/${id}.savedState"
    rm -rf "$HOME/Library/Caches/${id}" "$HOME/Library/HTTPStorages/${id}" "$HOME/Library/HTTPStorages/${id}.binarycookies" "$HOME/Library/WebKit/${id}"
    C="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null)"; [ -n "$C" ] && rm -rf "$C${id}"
    T="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"; [ -n "$T" ] && rm -rf "$T${id}"
    if defaults read ${id} >/dev/null 2>&1; then defaults delete ${id} >/dev/null 2>&1; fi
    rm -f "$HOME/Library/Preferences/${id}.plist"
  `;
  try {
    const child = spawn('/bin/sh', ['-c', script, 'cleanmac-sweep', sessionDir], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* the next launch removes stale session folders */
  }
}

module.exports = { configure, readSettings, writeSettings, sweepOnExit, BUNDLE_ID, isPromptingLocation };
