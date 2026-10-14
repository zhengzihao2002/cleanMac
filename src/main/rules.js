'use strict';

/*
 * The safety knowledge base.
 *
 * Every item cleanMac shows gets one of three safety levels:
 *
 *   safe       Rebuilt automatically by macOS or the owning app. Selected by default.
 *   review     Removable, but with a side effect (re-download, re-sync, lost backup).
 *              Never selected by default; the UI explains the trade-off.
 *   protected  Shown for transparency only. cleanMac refuses to remove it.
 *
 * Anything not described here is not scanned at all, and the deletion guard
 * (guard.js) independently refuses any path outside the allow-list below.
 */

// ~/Library/Caches folders whose removal has side effects worth a second look.
const CAUTION_CACHES = {
  'com.apple.bird': 'iCloud Drive keeps its sync state here. Removing it makes iCloud Drive re-index and re-sync everything.',
  'CloudKit': 'iCloud sync data used by apps. Removing it makes them download their iCloud data again.',
  'com.apple.cloudkit': 'iCloud sync data used by apps. Removing it makes them download their iCloud data again.',
  'com.apple.nsurlsessiond': 'Holds background downloads in progress (App Store, software updates). They would restart from zero.',
  'com.apple.appstoreagent': 'App Store downloads and updates in progress would restart.',
  'com.apple.akd': 'Apple Account sign-in cache. You may be asked to verify your Apple Account again.',
  'com.apple.mediaanalysisd': 'Photos and media analysis results. macOS would spend hours re-analysing your library.',
  'com.apple.photoanalysisd': 'Photos analysis results (faces, scenes). macOS would spend hours re-analysing your library.',
  'com.apple.HomeKit': 'Home accessory data. The Home app re-syncs it from iCloud.',
  'com.apple.homed': 'Home accessory data. The Home app re-syncs it from iCloud.',
  'FamilyCircle': 'Family Sharing data. Re-downloaded from iCloud.',
  'com.apple.passd': 'Wallet passes. Re-downloaded from iCloud.',
  'com.apple.findmy.fmipcore': 'Find My data. Re-downloaded from iCloud.',
  'ms-playwright': 'Browsers downloaded by Playwright for automated tests. They are re-downloaded on the next test run (often 500 MB+).',
  'pypoetry': 'Python packages downloaded by Poetry. Re-downloaded on the next install.',
};

const CAUTION_CACHE_PATTERNS = [
  [/^com\.apple\.(icloud|cloudd|cloudkit|bird|CloudDocs)/i, 'Part of iCloud sync. Removing it forces a re-sync from iCloud.'],
];

// Folders inside ~/Library/Caches that cleanMac never lists.
const HIDDEN_CACHES = new Set([
  'local.cleanmac.app', // our own (normally never created)
]);

// Friendly names for cache folders that do not map to an installed app.
const KNOWN_NAMES = {
  'com.apple.Safari': 'Safari',
  'com.apple.helpd': 'Help Viewer',
  'com.apple.iTunes': 'iTunes',
  'com.apple.Music': 'Music',
  'com.apple.appstore': 'App Store',
  'com.apple.appstoreagent': 'App Store downloads',
  'com.apple.akd': 'Apple Account',
  'com.apple.bird': 'iCloud Drive',
  'CloudKit': 'iCloud (CloudKit)',
  'com.apple.cloudkit': 'iCloud (CloudKit)',
  'com.apple.nsurlsessiond': 'Background downloads',
  'com.apple.mediaanalysisd': 'Media analysis',
  'com.apple.photoanalysisd': 'Photos analysis',
  'com.apple.python': 'Python bytecode (Apple)',
  'com.apple.QuickLook.thumbnailcache': 'Quick Look thumbnails',
  'com.apple.dt.Xcode': 'Xcode',
  'com.apple.HomeKit': 'HomeKit',
  'com.apple.homed': 'Home',
  'com.apple.passd': 'Wallet',
  'com.apple.findmy.fmipcore': 'Find My',
  'com.apple.Safari.SafeBrowsing': 'Safari Safe Browsing',
  'com.apple.parsecd': 'Siri Suggestions',
  'com.apple.Maps': 'Maps',
  'com.apple.news': 'News',
  'com.apple.stocks': 'Stocks',
  'com.apple.tv': 'TV',
  'com.apple.podcasts': 'Podcasts',
  'GeoServices': 'Maps tiles & location',
  'FamilyCircle': 'Family Sharing',
  'Homebrew': 'Homebrew downloads',
  'pip': 'Python pip',
  'pypoetry': 'Poetry',
  'Yarn': 'Yarn',
  'node-gyp': 'node-gyp headers',
  'ms-playwright': 'Playwright browsers',
  'ms-playwright-go': 'Playwright (Go) driver',
  'JetBrains': 'JetBrains IDEs',
  'Google': 'Google (Chrome & others)',
  'Firefox': 'Firefox',
  'Mozilla': 'Mozilla',
  'BraveSoftware': 'Brave',
  'Microsoft Edge': 'Microsoft Edge',
  'org.swift.swiftpm': 'Swift Package Manager',
  'CocoaPods': 'CocoaPods',
  'typescript': 'TypeScript',
  'pnpm': 'pnpm',
  'go-build': 'Go build cache',
  'golangci-lint': 'golangci-lint',
  'com.microsoft.VSCode': 'Visual Studio Code',
  'com.spotify.client': 'Spotify',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord',
  'us.zoom.xos': 'Zoom',
  'com.google.Chrome': 'Google Chrome',
  'com.brave.Browser': 'Brave',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.docker.docker': 'Docker Desktop',
  'Cypress': 'Cypress',
  'electron': 'Electron downloads',
  'electron-builder': 'electron-builder',
  'deno': 'Deno',
  'bun': 'Bun',
  'puppeteer': 'Puppeteer browsers',
  'Adobe': 'Adobe',
  'SentryCrash': 'Crash reports (Sentry)',
  'TemporaryItems': 'Temporary items',
  'Metadata': 'Spotlight metadata cache',
  'com.apple.mail': 'Mail',
  'com.apple.MobileSMS': 'Messages',
  'com.apple.Notes': 'Notes',
  'com.apple.iBooksX': 'Books',
  'com.apple.Photos': 'Photos',
  'com.apple.FaceTime': 'FaceTime',
};

/*
 * Chromium / Electron caches that live inside ~/Library/Application Support.
 * Each name is only accepted when the folder also looks like a Chromium cache
 * (the `signature` children), so an unrelated folder that happens to be
 * called "Cache" is ignored.
 */
const CHROMIUM_CACHE_DIRS = {
  'Cache': { safety: 'safe', signature: ['Cache_Data', 'index', 'index-dir', 'data_0'], label: 'Web cache' },
  'Code Cache': { safety: 'safe', signature: ['js', 'wasm', 'webui_js'], label: 'Compiled script cache' },
  'GPUCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'DawnCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'DawnGraphiteCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'DawnWebGPUCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'GraphiteDawnCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'GrShaderCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
  'ShaderCache': { safety: 'safe', signature: ['index', 'data_0'], label: 'GPU shader cache' },
};

// Inside a "Service Worker" folder.
const SERVICE_WORKER_DIRS = {
  'ScriptCache': { safety: 'safe', label: 'Service worker scripts' },
  'CacheStorage': {
    safety: 'review',
    label: 'Offline website data',
    note: 'Websites and web apps keep offline copies here. They work normally but re-download their offline data.',
  },
};

// VS Code and its forks keep extra rebuildable data at the top of their folder.
const VSCODE_LIKE = new Set(['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae']);
const VSCODE_DIRS = {
  'CachedData': { safety: 'safe', label: 'Compiled code cache' },
  'CachedExtensionVSIXs': { safety: 'safe', label: 'Extension installers' },
  'CachedProfilesData': { safety: 'safe', label: 'Profile cache' },
  'logs': { safety: 'safe', label: 'Logs' },
};

// Top-level Application Support folders the web-cache crawler never enters.
const APP_SUPPORT_SKIP = new Set([
  'MobileSync', 'AddressBook', 'CallHistoryDB', 'CallHistoryTransactions', 'CloudDocs',
  'Knowledge', 'FileProvider', 'iCloud', 'Dock', 'CrashReporter', 'Apple', 'App Store',
  'Steam', 'Battle.net', 'minecraft', 'Ableton', 'Logic', 'GarageBand', 'Final Cut Pro',
  'Native Instruments', 'Spotify', 'Mozilla', 'Firefox', 'Docker Desktop', 'Parallels',
  'VMware Fusion', 'UTM', 'Containers', 'Plex Media Server',
]);

// Vendor folders whose next component is the actual product (Google/Chrome).
const APP_SUPPORT_VENDORS = new Set([
  'Google', 'Microsoft', 'BraveSoftware', 'Opera Software', 'Vivaldi', 'JetBrains', 'com.operasoftware.Opera',
]);

const APP_SUPPORT_NAMES = {
  'Google/Chrome': 'Google Chrome',
  'Google/Chrome Beta': 'Google Chrome Beta',
  'Google/Chrome Canary': 'Google Chrome Canary',
  'Google/Chrome Dev': 'Google Chrome Dev',
  'BraveSoftware/Brave-Browser': 'Brave',
  'BraveSoftware/Brave-Browser-Beta': 'Brave Beta',
  'Microsoft Edge': 'Microsoft Edge',
  'Microsoft/Teams': 'Microsoft Teams (classic)',
  'Code': 'Visual Studio Code',
  'Code - Insiders': 'VS Code Insiders',
  'discord': 'Discord',
  'Arc': 'Arc',
  'Slack': 'Slack',
  'Notion': 'Notion',
  'Figma': 'Figma',
  'Postman': 'Postman',
  'Obsidian': 'Obsidian',
  'obsidian': 'Obsidian',
  'Claude': 'Claude',
  'ChatGPT': 'ChatGPT',
  'WhatsApp': 'WhatsApp',
  'Signal': 'Signal',
  'Microsoft Teams': 'Microsoft Teams',
};

/*
 * Developer junk. Paths are relative to the home folder.
 * `running` lists bundle ids / app names that make an item "in use".
 */
const DEVELOPER_TARGETS = [
  { rel: 'Library/Developer/Xcode/DerivedData', name: 'Xcode DerivedData', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Intermediate build products and indexes. Xcode rebuilds them on the next build.' },
  { rel: 'Library/Developer/Xcode/iOS DeviceSupport', name: 'iOS device support files', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Debug symbols copied from your iPhone or iPad. Xcode copies them again the next time you connect a device.' },
  { rel: 'Library/Developer/Xcode/watchOS DeviceSupport', name: 'watchOS device support files', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Debug symbols copied from an Apple Watch. Re-created when you connect it.' },
  { rel: 'Library/Developer/Xcode/tvOS DeviceSupport', name: 'tvOS device support files', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Debug symbols copied from an Apple TV. Re-created when you connect it.' },
  { rel: 'Library/Developer/Xcode/visionOS DeviceSupport', name: 'visionOS device support files', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Debug symbols copied from Apple Vision Pro. Re-created when you connect it.' },
  { rel: 'Library/Developer/Xcode/iOS Device Logs', name: 'iOS device logs', safety: 'safe',
    note: 'Logs pulled from connected devices.' },
  { rel: 'Library/Developer/Xcode/Products', name: 'Xcode Products', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Built products. Rebuilt on the next build.' },
  { rel: 'Library/Developer/Xcode/UserData/Previews', name: 'SwiftUI Previews', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Simulator data used by SwiftUI previews. Re-created automatically.' },
  { rel: 'Library/Developer/CoreSimulator/Caches', name: 'Simulator caches', safety: 'safe', running: ['com.apple.iphonesimulator'],
    note: 'Dyld and runtime caches for the iOS Simulator. Rebuilt on next launch.' },
  { rel: 'Library/Developer/XCTestDevices', name: 'XCTest device clones', safety: 'safe', running: ['com.apple.dt.Xcode'],
    note: 'Simulator clones created for parallel testing. Re-created when tests run.' },
  { rel: 'Library/Developer/Xcode/Archives', name: 'Xcode Archives', safety: 'review',
    note: 'Archived app builds. You need them to re-export a build or to symbolicate crash reports of released versions.' },
  { rel: '.npm/_cacache', name: 'npm cache', safety: 'safe', note: 'Downloaded npm packages. npm re-downloads them when needed.' },
  { rel: '.npm/_logs', name: 'npm logs', safety: 'safe', note: 'Debug logs written by npm.' },
  { rel: '.npm/_npx', name: 'npx cache', safety: 'safe', note: 'Packages fetched by npx. Re-fetched on the next run.' },
  { rel: '.yarn/berry/cache', name: 'Yarn cache', safety: 'safe', note: 'Downloaded Yarn packages. Re-downloaded when needed.' },
  { rel: '.bun/install/cache', name: 'Bun cache', safety: 'safe', note: 'Downloaded Bun packages. Re-downloaded when needed.' },
  { rel: 'Library/pnpm/store', name: 'pnpm store', safety: 'review',
    note: 'Existing projects keep working, but future installs re-download every package. `pnpm store prune` is the gentler option.' },
  { rel: '.gradle/caches', name: 'Gradle caches', safety: 'safe', running: ['com.google.android.studio'],
    note: 'Downloaded dependencies and build caches. Gradle re-downloads them on the next build.' },
  { rel: '.gradle/wrapper/dists', name: 'Gradle distributions', safety: 'review',
    note: 'Downloaded Gradle versions. Re-downloaded (~150 MB each) by projects that need them.' },
  { rel: '.m2/repository', name: 'Maven repository', safety: 'review',
    note: 'Downloaded Java dependencies. Re-downloaded on the next build, which can be slow.' },
  { rel: '.cargo/registry/cache', name: 'Cargo crate archives', safety: 'safe', note: 'Downloaded Rust crates. Re-downloaded when needed.' },
  { rel: '.cargo/registry/src', name: 'Cargo crate sources', safety: 'safe', note: 'Unpacked Rust crates. Re-extracted when needed.' },
  { rel: '.cache/pip', name: 'pip cache', safety: 'safe', note: 'Downloaded Python packages. Re-downloaded when needed.' },
  { rel: '.cache/pre-commit', name: 'pre-commit environments', safety: 'safe', note: 'Hook environments. Rebuilt on the next commit.' },
  { rel: '.cache/huggingface', name: 'Hugging Face models', safety: 'review',
    note: 'Downloaded AI models and datasets. They are re-downloaded when needed, which can be many gigabytes.' },
  { rel: '.cache/torch', name: 'PyTorch hub cache', safety: 'review', note: 'Downloaded model weights. Re-downloaded when needed.' },
  { rel: 'go/pkg/mod/cache/download', name: 'Go module downloads', safety: 'safe', note: 'Downloaded Go modules. Re-downloaded when needed.' },
  { rel: '.cocoapods/repos', name: 'CocoaPods spec repos', safety: 'review', note: 'CocoaPods spec repositories. Re-cloned on the next `pod install`.' },
  { rel: '.android/cache', name: 'Android SDK cache', safety: 'safe', note: 'Android tools download cache.' },
  { rel: '.nuget/packages', name: 'NuGet packages', safety: 'review', note: 'Downloaded .NET packages. Re-downloaded on the next restore.' },
  { rel: '.composer/cache', name: 'Composer cache', safety: 'safe', note: 'Downloaded PHP packages. Re-downloaded when needed.' },
  { rel: '.pub-cache/hosted', name: 'Dart / Flutter packages', safety: 'review', note: 'Downloaded Dart packages. Re-downloaded by `flutter pub get`.' },
  { rel: '.expo/cache', name: 'Expo cache', safety: 'safe', note: 'Expo CLI cache.' },
];

// Large parts of "System Data" that cleanMac deliberately leaves alone.
// `rel` paths are relative to the home folder; `abs` paths are absolute.
const PROTECTED_AREAS = [
  { abs: '/private/var/vm', name: 'Virtual memory & sleep image',
    note: 'Swap files and the hibernation image are managed by macOS while it runs. They shrink when you restart.' },
  { tmp: true, name: 'Temporary files of running apps',
    note: 'Open apps are using these right now. macOS clears them automatically when you restart.' },
  { abs: '/private/var/db/diagnostics', name: 'Unified system logs',
    note: 'macOS manages these logs itself and trims them automatically. Deleting them can break diagnostics.' },
  { rel: 'Library/Mail', name: 'Mail messages & attachments', fda: true,
    note: 'Your email. Delete messages in Mail, or remove the account, to reclaim this space.' },
  { rel: 'Library/Messages', name: 'Messages & attachments', fda: true,
    note: 'Your conversations. Use System Settings → General → Storage → Messages to review large attachments.' },
  { rel: 'Library/Containers/com.docker.docker/Data/vms', name: 'Docker disk image', fda: true,
    note: 'Holds your images, containers and volumes. Use `docker system prune` or Docker Desktop to clean it.' },
  { rel: 'Library/Containers/com.apple.MobileSMS', name: 'Messages app data', fda: true,
    note: 'Belongs to the Messages app.' },
  { rel: 'Library/Group Containers/group.com.apple.notes', name: 'Notes', fda: true,
    note: 'Your notes and their attachments.' },
  { rel: 'Library/Application Support/AddressBook', name: 'Contacts', fda: true,
    note: 'Your contacts database.' },
];

// Shown in the "Never touched" list in the UI.
const NEVER_TOUCHED = [
  'Desktop, Documents & Downloads',
  'Photos & Music libraries',
  'iCloud Drive',
  'Mail & Messages',
  'Keychains & passwords',
  'App preferences',
  'App data (Application Support)',
  'Installed apps',
  'macOS system files',
];

function cacheSafety(folderName) {
  if (Object.prototype.hasOwnProperty.call(CAUTION_CACHES, folderName)) {
    return { safety: 'review', note: CAUTION_CACHES[folderName] };
  }
  for (const [re, note] of CAUTION_CACHE_PATTERNS) {
    if (re.test(folderName)) return { safety: 'review', note };
  }
  return { safety: 'safe', note: null };
}

const GENERIC_SEGMENTS = new Set([
  'app', 'apps', 'client', 'mac', 'macos', 'osx', 'desktop', 'helper', 'agent', 'main', 'application',
  'launcher', 'daemon', 'service', 'x', 'xos', 'macgap', 'beta', 'stable',
]);

function titleCase(s) {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 && w === w.toLowerCase() ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Turns a folder name such as "com.tinyspeck.slackmacgap" into a readable name.
 * `appNames` maps bundle identifiers of installed apps to their display names.
 */
function friendlyName(folderName, appNames) {
  if (appNames && appNames.has(folderName)) return appNames.get(folderName);
  if (Object.prototype.hasOwnProperty.call(KNOWN_NAMES, folderName)) return KNOWN_NAMES[folderName];

  // Updater staging folders, e.g. "com.microsoft.VSCode.ShipIt".
  const shipIt = folderName.match(/^(.*)\.ShipIt$/);
  if (shipIt) return `${friendlyName(shipIt[1], appNames)} updates`;

  // A helper of an installed app, e.g. "com.google.Chrome.helper".
  if (appNames) {
    let probe = folderName;
    while (probe.includes('.')) {
      probe = probe.slice(0, probe.lastIndexOf('.'));
      if (appNames.has(probe)) return appNames.get(probe);
    }
  }

  const parts = folderName.split('.');
  if (parts.length >= 3 && /^[a-z]{2,}$/i.test(parts[0])) {
    // Reverse-DNS identifier.
    let i = parts.length - 1;
    while (i > 1 && GENERIC_SEGMENTS.has(parts[i].toLowerCase())) i--;
    return titleCase(parts[i]);
  }
  return folderName;
}

module.exports = {
  CAUTION_CACHES,
  HIDDEN_CACHES,
  KNOWN_NAMES,
  CHROMIUM_CACHE_DIRS,
  SERVICE_WORKER_DIRS,
  VSCODE_LIKE,
  VSCODE_DIRS,
  APP_SUPPORT_SKIP,
  APP_SUPPORT_VENDORS,
  APP_SUPPORT_NAMES,
  DEVELOPER_TARGETS,
  PROTECTED_AREAS,
  NEVER_TOUCHED,
  cacheSafety,
  friendlyName,
};
