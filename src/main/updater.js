'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { randomUUID } = require('crypto');

const SOURCE = 'https://codeload.github.com/zhengzihao2002/cleanMac/zip/HEAD';
const LATEST = 'https://api.github.com/repos/zhengzihao2002/cleanMac/commits?per_page=1';

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).slice(-4000)));
      else resolve(stdout);
    });
  });
}

// Never pull into or replace the user's checkout. Keep the working version
// until a fresh source download has built and passed the build's signature check.
async function prepareUpdate({ projectRoot, appPath, currentVersion, platform = process.platform, execute = run, progress = () => {} }) {
  if (platform !== 'darwin') throw new Error('Automatic updates are available on macOS.');
  if (!projectRoot) throw new Error('The cleanMac source folder could not be found.');
  let updateRoot = path.join(projectRoot, '.runtime', 'updates');
  let installedCommit = null;
  try {
    const info = JSON.parse(await fs.readFile(path.join(appPath, 'build-info.json'), 'utf8'));
    if (typeof info.updateRoot === 'string' && path.isAbsolute(info.updateRoot)) updateRoot = info.updateRoot;
    installedCommit = info.sourceCommit;
  } catch { /* development or first update */ }
  if (typeof installedCommit !== 'string' || !/^[a-f0-9]{40}$/.test(installedCommit)) {
    throw new Error('This build has no source revision, so an update cannot be checked reliably. Pull the latest source and run build.sh once. Nothing was downloaded.');
  }
  progress('Checking GitHub for updates…');
  const metadata = await execute('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '30', '--silent', '--show-error', '--header', 'Accept: application/vnd.github+json', '--header', 'User-Agent: cleanMac-updater', LATEST]);
  const latest = JSON.parse(metadata)?.[0]?.sha;
  if (typeof latest !== 'string' || !/^[a-f0-9]{40}$/.test(latest)) throw new Error('GitHub did not return a valid source revision.');
  if (installedCommit === latest) {
    progress('Already up to date.');
    return { upToDate: true, version: currentVersion };
  }
  await fs.mkdir(updateRoot, { recursive: true, mode: 0o700 });
  const job = await fs.mkdtemp(path.join(updateRoot, 'version-'));
  try {
    await fs.writeFile(path.join(job, 'update-marker.json'), JSON.stringify({ repository: 'zhengzihao2002/cleanMac' }), { mode: 0o600 });
    progress('Downloading the latest source from GitHub…');
    const archive = path.join(job, 'source.zip');
    await execute('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '30', '--max-time', '300', '--output', archive, SOURCE.replace(/HEAD$/, latest)]);
    progress('Extracting the update…');
    const extracted = path.join(job, 'source');
    await execute('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    const entries = await fs.readdir(extracted, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('GitHub returned an unexpected source archive.');
    const root = path.join(extracted, entries[0].name);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'cleanmac' || typeof pkg.version !== 'string') throw new Error('The download is not a cleanMac project.');
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('The GitHub source has an unsupported version.');
    if (currentVersion && /^\d+\.\d+\.\d+$/.test(currentVersion)) {
      const remote = pkg.version.split('.').map(Number);
      const local = currentVersion.split('.').map(Number);
      const different = remote.findIndex((n, i) => n !== local[i]);
      if (different >= 0 && remote[different] < local[different]) {
        throw new Error(`GitHub has version ${pkg.version}, older than this app (${currentVersion}). Publish the newer source before updating.`);
      }
    }
    await fs.access(path.join(root, 'build.sh'));
    progress('Building and signing the update locally. This may take several minutes…');
    await execute('/bin/bash', [path.join(root, 'build.sh'), '--no-open'], {
      cwd: root, env: { ...process.env, CLEANMAC_UPDATE_ROOT: updateRoot, CLEANMAC_SOURCE_COMMIT: latest, CLEANMAC_UPDATER_BUILD: '1' },
    });
    const application = path.join(root, 'cleanMac.app');
    await fs.access(path.join(application, 'Contents/MacOS/cleanMac'));
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    // Preserve the user's cleaning preference in the new independent source folder.
    try {
      const settings = JSON.parse(await fs.readFile(path.join(projectRoot, '.runtime/settings.json'), 'utf8'));
      await fs.writeFile(path.join(root, '.runtime/settings.json'), JSON.stringify({ mode: settings.mode === 'delete' ? 'delete' : 'trash' }), { mode: 0o600 });
    } catch { /* absent settings use the safe default */ }
    await fs.rm(archive, { force: true });
    return { application, version: pkg.version };
  } catch (error) {
    await fs.rm(job, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function launchUpdate(application, installedApplication) {
  const source = await fs.realpath(application);
  const target = await fs.realpath(installedApplication);
  if (source === target || !source.endsWith('.app') || !target.endsWith('.app')) throw new Error('Invalid update installation paths.');
  await fs.access(path.dirname(target), require('fs').constants.W_OK);
  const backups = path.join(path.dirname(target), '.runtime', 'update-backups');
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = path.join(backups, `previous-${randomUUID()}.app`);
  const log = await fs.open(path.join(path.dirname(application), 'install-update.log'), 'w', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', [path.join(__dirname, 'install-update.sh'), source, target, backup, String(process.pid)],
        { detached: true, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } finally { await log.close(); }
}

async function updateLayout(appPath) {
  const info = JSON.parse(await fs.readFile(path.join(appPath, 'build-info.json'), 'utf8'));
  if (typeof info.updateRoot !== 'string' || !path.isAbsolute(info.updateRoot) ||
      path.basename(info.updateRoot) !== 'updates' || path.basename(path.dirname(info.updateRoot)) !== '.runtime') return null;
  const root = await fs.realpath(path.resolve(info.updateRoot, '../..'));
  return { root, updates: path.join(root, '.runtime/updates'), original: path.join(root, 'cleanMac.app'), current: await fs.realpath(path.resolve(appPath, '../../..')) };
}

// Old updater versions launch a staged copy. Move that copy back into the
// original app path before exposing the interface, requiring no Terminal work.
async function migrateLegacyUpdate(appPath, install = launchUpdate) {
  let layout;
  try { layout = await updateLayout(appPath); } catch { return false; }
  if (!layout || !layout.current.startsWith(layout.updates + path.sep) || layout.current === layout.original) return false;
  await install(layout.current, layout.original);
  return true;
}

async function cleanupUpdateCopies(appPath, runningPaths = []) {
  let layout;
  try { layout = await updateLayout(appPath); } catch { return 0; }
  if (!layout || layout.current !== layout.original) return 0;
  // Fail closed if an artifact directory points outside the original folder.
  const runtimeRoot = path.join(layout.root, '.runtime');
  try { if (await fs.realpath(runtimeRoot) !== runtimeRoot) return 0; } catch { return 0; }
  const active = [layout.current, ...runningPaths.map((p) => path.resolve(p))];
  const candidates = [];
  for (const [dir, pattern] of [[layout.updates, /^version-/], [path.join(runtimeRoot, 'update-backups'), /^previous-/], [layout.root, /^\.cleanMac-previous-/]]) {
    let entries;
    try {
      if (await fs.realpath(dir) !== dir) continue;
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && pattern.test(entry.name)) candidates.push(path.join(dir, entry.name));
  }
  let removed = 0;
  for (const candidate of candidates) {
    if (active.some((p) => p === candidate || p.startsWith(candidate + path.sep))) continue;
    // Recognize only actual cleanMac build artifacts, never arbitrary folders.
    const bundles = candidate.endsWith('.app') || candidate.endsWith('.app.failed') ? [candidate] : [];
    if (!bundles.length) {
      try {
        for (const e of await fs.readdir(path.join(candidate, 'source'), { withFileTypes: true })) {
          if (e.isDirectory()) bundles.push(path.join(candidate, 'source', e.name, 'cleanMac.app'));
        }
      } catch { /* interrupted job; its marker is checked below */ }
    }
    let recognized = false;
    try {
      recognized = JSON.parse(await fs.readFile(path.join(candidate, 'update-marker.json'), 'utf8')).repository === 'zhengzihao2002/cleanMac';
    } catch { /* older updater */ }
    // The app may already have been moved out of this legacy source folder.
    for (const bundle of bundles) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(bundle), 'package.json'), 'utf8'));
        await fs.access(path.join(path.dirname(bundle), 'build.sh'));
        if (pkg.name === 'cleanmac') recognized = true;
      } catch { /* not a built cleanMac source folder */ }
    }
    for (const bundle of bundles) {
      try {
        if ((await fs.lstat(bundle)).isSymbolicLink()) continue;
        const pkg = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/package.json'), 'utf8'));
        if (pkg.name === 'cleanmac') recognized = true;
      } catch { /* incomplete or unrelated artifact */ }
    }
    if (recognized) { await fs.rm(candidate, { recursive: true, force: true }); removed++; }
  }
  return removed;
}

module.exports = { prepareUpdate, SOURCE, LATEST, launchUpdate, migrateLegacyUpdate, cleanupUpdateCopies };
