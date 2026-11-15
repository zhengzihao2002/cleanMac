'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const SOURCE = 'https://codeload.github.com/zhengzihao2002/cleanMac/zip/HEAD';

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
  try {
    const info = JSON.parse(await fs.readFile(path.join(appPath, 'build-info.json'), 'utf8'));
    if (typeof info.updateRoot === 'string' && path.isAbsolute(info.updateRoot)) updateRoot = info.updateRoot;
  } catch { /* development or first update */ }
  await fs.mkdir(updateRoot, { recursive: true, mode: 0o700 });
  const job = await fs.mkdtemp(path.join(updateRoot, 'version-'));
  try {
    progress('Downloading the latest source from GitHub…');
    const archive = path.join(job, 'source.zip');
    await execute('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '30', '--max-time', '300', '--output', archive, SOURCE]);
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
      cwd: root, env: { ...process.env, CLEANMAC_UPDATE_ROOT: updateRoot },
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

module.exports = { prepareUpdate, SOURCE, launchUpdate: (application) => run('/usr/bin/open', ['-n', application]) };
