'use strict';

/*
 * The deletion guard: the last line of defence.
 *
 * Even if the scanner or the UI had a bug, nothing is removed unless the exact
 * path matches the allow-list below AND does not match the deny-list. The
 * renderer never sends paths, only ids of items the scanner produced; the
 * guard then re-checks every single path right before it is removed.
 */

const fs = require('fs');
const path = require('path');
const { CHROMIUM_CACHE_DIRS, VSCODE_LIKE, VSCODE_DIRS, DEVELOPER_TARGETS } = require('./rules');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEG = '[^/]+';

// These exact locations contain generated builds or downloaded test browsers.
// Bundles elsewhere (including updater staging caches) stay protected.
const GENERATED_BUNDLE_ROOTS = [
  'Library/Developer/Xcode/DerivedData',
  'Library/Developer/Xcode/Products',
  'Library/Developer/Xcode/UserData/Previews',
  'Library/Developer/XCTestDevices',
  'Library/Caches/ms-playwright',
  'Library/Caches/Cypress',
];

const DENY = [
  /\/Library\/Keychains(\/|$)/,
  /\/Library\/Preferences(\/|$)/,
  /\/Library\/Mobile Documents(\/|$)/,
  /\/Library\/CloudStorage(\/|$)/,
  /\/Library\/Messages(\/|$)/,
  /\/Library\/Mail(\/|$)/,
  /\/Library\/Safari(\/|$)/,
  /\/Library\/Photos(\/|$)/,
  /\/Library\/Accounts(\/|$)/,
  /\/Library\/Cookies(\/|$)/,
  /\/Library\/Calendars(\/|$)/,
  /\/Library\/Keyboard(\/|$)/,
  /\/Library\/LaunchAgents(\/|$)/,
  /\/Library\/LaunchDaemons(\/|$)/,
  /\/Library\/Application Support\/(AddressBook|com\.apple\.TCC|CloudDocs|FileProvider|Knowledge|CallHistoryDB)(\/|$)/,
  /\/[^/]+\.(photoslibrary|musiclibrary|tvlibrary|fcpbundle|vmwarevm|pvm|utm)(\/|$)/i,
  /\/\.Trash(\/|$)/,
  /^\/(System|usr|bin|sbin|etc|opt|cores|Applications|Volumes|Network)(\/|$)/,
  /^\/private\/(etc|tmp)(\/|$)/,
  /^\/private\/var\/(vm|db|folders|root|protected|MobileSoftwareUpdate)(\/|$)/,
  /^\/Library\/(Apple|Application Support|Preferences|Frameworks|Extensions|Updates|Keychains|Security|PrivilegedHelperTools|SystemExtensions|StagedExtensions)(\/|$)/,
];

function buildAllowList(home) {
  const H = esc(home);
  const chromium = Object.keys(CHROMIUM_CACHE_DIRS).map(esc).join('|');
  const vscodeRoots = [...VSCODE_LIKE].map(esc).join('|');
  const vscodeDirs = Object.keys(VSCODE_DIRS).map(esc).join('|');

  const patterns = [
    `${H}/Library/Caches/${SEG}`,
    `${H}/Library/Logs/${SEG}`,
    `${H}/Library/Application Support/(?:${SEG}/){1,4}(?:${chromium})`,
    `${H}/Library/Application Support/(?:${SEG}/){1,4}Service Worker/(?:CacheStorage|ScriptCache)`,
    `${H}/Library/Application Support/(?:${vscodeRoots})/(?:${vscodeDirs})`,
    `${H}/Library/Containers/${SEG}/Data/Library/Caches`,
    `${H}/Library/Group Containers/${SEG}/Library/Caches`,
    `${H}/Library/Containers/com\\.apple\\.mail/Data/Library/Mail Downloads`,
    `${H}/Library/iTunes/(?:iPhone|iPad|iPod) Software Updates/${SEG}`,
    `${H}/Library/Application Support/MobileSync/Backup/${SEG}`,
    ...DEVELOPER_TARGETS.map((t) => `${H}/${esc(t.rel)}`),
    // System-wide (administrator) areas.
    `/Library/Caches/${SEG}`,
    `/Library/Logs/${SEG}`,
  ];
  return [
    ...patterns.map((p) => new RegExp(`^${p}(?:/.*)?$`)),
    // Only archived logs, at the depths the collector understands. Never
    // authorize a live log or an entire /var/log directory for removal.
    /^\/private\/var\/log\/(?:[^/]+\/)?[^/]+\.(?:gz|bz2|xz|zip|\d+)$/i,
  ];
}

function createGuard({ home, ownPaths = [], platform = process.platform }) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || path.normalize(home) === '/') {
    throw new Error('cleanMac guard: invalid home folder');
  }
  home = path.normalize(home).replace(/\/+$/, '');
  const allow = buildAllowList(home);
  const own = ownPaths.filter(Boolean).map((p) => path.normalize(p).replace(/\/+$/, ''));
  const caseInsensitive = platform === 'darwin';
  const key = (p) => caseInsensitive ? p.toLowerCase() : p;
  const protectedPatterns = caseInsensitive ? DENY.map((re) => new RegExp(re.source, 'i')) : DENY;
  const generatedBundleRoots = GENERATED_BUNDLE_ROOTS.map((rel) => path.join(home, rel));

  function verdict(ok, reason) {
    return { ok, reason };
  }

  /**
   * Returns { ok: true } when `target` may be removed, otherwise
   * { ok: false, reason }.
   */
  function check(target) {
    if (typeof target !== 'string' || target.length === 0) return verdict(false, 'Invalid path');
    if (!path.isAbsolute(target)) return verdict(false, 'Not an absolute path');
    if (/[\x00-\x1f\x7f]/.test(target)) return verdict(false, 'Unsupported characters in path');
    if (path.normalize(target) !== target || target.endsWith('/')) return verdict(false, 'Path is not normalized');
    if (target === home || home.startsWith(target + '/')) return verdict(false, 'Refusing to touch the home folder');

    for (const p of own) {
      if (key(target) === key(p) || key(target).startsWith(key(p) + '/') || key(p).startsWith(key(target) + '/')) {
        return verdict(false, 'Belongs to cleanMac itself');
      }
    }
    for (const re of protectedPatterns) {
      if (re.test(target)) return verdict(false, 'Protected location');
    }
    if (!allow.some((re) => re.test(target))) return verdict(false, 'Outside the areas cleanMac cleans');

    // Refuse real application bundles except generated build products and
    // downloaded test browsers in the exact locations declared above.
    const parts = target.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (/\.app$/i.test(parts[i])) {
        const bundle = parts.slice(0, i + 1).join('/');
        const generated = generatedBundleRoots.some((root) => bundle.startsWith(root + '/'));
        if (!generated && fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))) {
          return verdict(false, 'Inside an application bundle');
        }
      }
    }

    // Refuse paths that travel through a symbolic link (e.g. a cache folder
    // that actually points at an external drive or at your documents).
    const parent = path.dirname(target);
    try {
      let current = path.parse(parent).root;
      for (const part of parent.slice(current.length).split('/').filter(Boolean)) {
        current = path.join(current, part);
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) return verdict(false, 'Path goes through a symbolic link');
        if (!st.isDirectory()) return verdict(false, 'Parent is not a folder');
      }
    } catch {
      return verdict(false, 'Location no longer exists');
    }

    return verdict(true, null);
  }

  function assert(target) {
    const v = check(target);
    if (!v.ok) {
      const err = new Error(`${v.reason}: ${target}`);
      err.code = 'CLEANMAC_GUARD';
      throw err;
    }
  }

  return { check, assert, home };
}

module.exports = { createGuard };
