'use strict';
const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readPlistStrings } = require('./plist');

async function appIcon(bundle, { cacheRoot, fileIcon, execute = promisify(execFile) }) {
  try {
    const info = readPlistStrings(path.join(bundle, 'Contents/Info.plist'));
    let name = info?.CFBundleIconFile || info?.CFBundleIconName;
    if (!name) {
      const files = (await fs.readdir(path.join(bundle, 'Contents/Resources'))).filter((n) => /\.icns$/i.test(n));
      if (files.length === 1) name = files[0];
    }
    if (typeof name === 'string' && name && path.basename(name) === name && !/[\\\x00-\x1f]/.test(name)) {
      const icon = await fs.realpath(path.join(bundle, 'Contents/Resources', path.extname(name) ? name : name + '.icns'));
      const realBundle = await fs.realpath(bundle);
      if (!icon.startsWith(realBundle + path.sep)) throw new Error('Icon outside bundle');
      const stat = await fs.stat(icon);
      if (stat.size > 32 * 1024 * 1024) throw new Error('Oversized icon');
      await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const key = createHash('sha256').update(icon + ':' + stat.mtimeMs + ':' + stat.size).digest('hex');
      const output = path.join(cacheRoot, key + '.png');
      try { await fs.access(output); } catch {
        await execute('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '80', icon, '--out', output], { timeout: 15000, maxBuffer: 1024 * 1024 });
      }
      const png = await fs.readFile(output);
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid converted icon');
      return 'data:image/png;base64,' + png.toString('base64');
    }
  } catch { /* Asset catalog or inaccessible icon: use the macOS file icon. */ }
  try {
    const image = await fileIcon(bundle);
    if (image && !image.isEmpty()) return image.toDataURL();
  } catch { /* Individual failures do not prevent the application list loading. */ }
  return null;
}

module.exports = { appIcon };
