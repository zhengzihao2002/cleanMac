'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { appIcon } = require('../src/main/app-icons');
const { makeTempDir, cleanupHome } = require('./fixtures');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

test('bundle ICNS icons are converted to inline PNGs and reused from the local cache', async (t) => {
  const root = makeTempDir('bundle-icon-');
  t.after(() => cleanupHome(root));
  const bundle = path.join(root, 'Example.app');
  await fs.mkdir(path.join(bundle, 'Contents/Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIconFile</key><string>AppIcon</string></dict></plist>');
  await fs.writeFile(path.join(bundle, 'Contents/Resources/AppIcon.icns'), 'fixture ICNS');
  let conversions = 0;
  const options = { cacheRoot: path.join(root, '.runtime/icons'), fileIcon: async () => { throw new Error('Native icon API failed'); },
    execute: async (file, args) => {
      assert.equal(file, '/usr/bin/sips');
      assert.ok(args.includes(path.join(bundle, 'Contents/Resources/AppIcon.icns')));
      conversions++;
      await fs.writeFile(args.at(-1), png);
    } };
  const icon = await appIcon(bundle, options);
  assert.equal(icon, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(await appIcon(bundle, options), icon);
  assert.equal(conversions, 1);
});

test('icon metadata cannot traverse outside the bundle and native fallback is supported', async (t) => {
  const root = makeTempDir('icon-fallback-');
  t.after(() => cleanupHome(root));
  const bundle = path.join(root, 'Example.app');
  await fs.mkdir(path.join(bundle, 'Contents/Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIconFile</key><string>../../secret</string></dict></plist>');
  const result = await appIcon(bundle, { cacheRoot: root, execute: async () => assert.fail('Do not convert paths outside bundle'),
    fileIcon: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,fallback' }) });
  assert.equal(result, 'data:image/png;base64,fallback');
});
