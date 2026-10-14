'use strict';

// Builds a fake macOS home folder for tests.

const fs = require('fs');
const path = require('path');

function write(file, bytes = 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

// Test files live inside the project (.runtime/test) like everything else.
// Using the real path matters on macOS, where /var/folders is a symlink.
function testRoot() {
  const dir = path.join(__dirname, '..', '.runtime', 'test');
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(testRoot(), prefix));
}

function makeFakeHome() {
  const home = makeTempDir('home-');
  const H = (...p) => path.join(home, ...p);

  // Things that must never be touched.
  write(H('Documents/important.txt'), 4096);
  write(H('Library/Keychains/login.keychain-db'), 4096);
  write(H('Library/Preferences/com.example.plist'), 2048);
  write(H('Library/Mobile Documents/com~apple~CloudDocs/doc.pages'), 4096);

  // ~/Library/Caches
  write(H('Library/Caches/com.spotify.client/Data/chunk1'), 200 * 1024);
  write(H('Library/Caches/com.spotify.client/Data/chunk2'), 100 * 1024);
  write(H('Library/Caches/com.apple.bird/state.db'), 64 * 1024);
  write(H('Library/Caches/Homebrew/downloads/pkg.tar.gz'), 512 * 1024);
  write(H('Library/Caches/com.tinyspeck.slackmacgap/Cache.db'), 80 * 1024);
  fs.mkdirSync(H('Library/Caches/com.example.empty'), { recursive: true });
  // A symlink *as* a cache folder, pointing at Documents: must be ignored.
  fs.symlinkSync(H('Documents'), H('Library/Caches/com.evil.symlink'));
  // A symlink *inside* a cache folder: removing it must not touch Documents.
  write(H('Library/Caches/com.example.links/blob'), 40 * 1024);
  fs.symlinkSync(H('Documents'), H('Library/Caches/com.example.links/docs'));

  // ~/Library/Logs
  write(H('Library/Logs/DiagnosticReports/App-2024.ips'), 30 * 1024);
  write(H('Library/Logs/com.example.tool/run.log'), 25 * 1024);
  write(H('Library/Logs/install.log'), 20 * 1024);

  // Application Support: Electron / Chromium caches
  write(H('Library/Application Support/Slack/Cache/Cache_Data/index'), 8 * 1024);
  write(H('Library/Application Support/Slack/Cache/Cache_Data/data_1'), 300 * 1024);
  write(H('Library/Application Support/Slack/Code Cache/js/abc'), 50 * 1024);
  write(H('Library/Application Support/Slack/GPUCache/index'), 20 * 1024);
  write(H('Library/Application Support/Slack/Service Worker/CacheStorage/xyz/0'), 60 * 1024);
  write(H('Library/Application Support/Slack/Service Worker/ScriptCache/a'), 30 * 1024);
  write(H('Library/Application Support/Slack/Local Storage/leveldb/000003.log'), 50 * 1024); // user data
  write(H('Library/Application Support/Google/Chrome/Default/Code Cache/js/x'), 70 * 1024);
  write(H('Library/Application Support/Google/Chrome/Default/History'), 90 * 1024); // user data
  write(H('Library/Application Support/Code/CachedData/1234/a.bin'), 40 * 1024);
  write(H('Library/Application Support/Code/logs/20240101/main.log'), 20 * 1024);
  write(H('Library/Application Support/Code/User/settings.json'), 4 * 1024); // user data
  // Named "Cache" but not a Chromium cache: must be ignored.
  write(H('Library/Application Support/SomeApp/Cache/notes.txt'), 50 * 1024);
  write(H('Library/Application Support/MobileSync/Backup/00008030-ABC/Info.plist'), 2 * 1024);

  // Developer
  write(H('Library/Developer/Xcode/DerivedData/MyApp-abc/Build/out.o'), 400 * 1024);
  write(H('.npm/_cacache/content-v2/sha512/aa/bb'), 120 * 1024);
  write(H('go/pkg/mod/cache/download/example.com/mod/@v/v1.zip'), 60 * 1024);
  // Go makes its module cache read-only.
  for (const d of ['go/pkg/mod/cache/download/example.com/mod/@v', 'go/pkg/mod/cache/download/example.com/mod', 'go/pkg/mod/cache/download/example.com']) {
    fs.chmodSync(H(d), 0o555);
  }

  // iOS firmware
  write(H('Library/iTunes/iPhone Software Updates/iPhone15,2_17.0_Restore.ipsw'), 256 * 1024);

  return home;
}

function cleanupHome(home) {
  // Restore write permission on read-only folders before removing.
  const stack = [home];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {
        /* ignore */
      }
      for (const n of fs.readdirSync(p)) stack.push(path.join(p, n));
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}

function fakeContext(home, extra = {}) {
  const system = require('../src/main/system');
  return {
    home,
    signal: undefined,
    fda: false,
    appNames: new Map([['com.spotify.client', 'Spotify']]),
    running: system.createRunningIndex(extra.running || []),
  };
}

module.exports = { makeFakeHome, makeTempDir, cleanupHome, fakeContext, write };
