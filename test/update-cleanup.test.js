'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { migrateLegacyUpdate, cleanupUpdateCopies } = require('../src/main/updater');
const { makeTempDir, cleanupHome } = require('./fixtures');

test('legacy staged apps migrate to the original folder and old copies are removed safely', async (t) => {
  const root = makeTempDir('update-migration-');
  t.after(() => cleanupHome(root));
  const updates = path.join(root, '.runtime/updates');
  const artifact = async (name) => {
    const source = path.join(updates, name, 'source/cleanMac-HEAD');
    const app = path.join(source, 'cleanMac.app');
    await fs.mkdir(path.join(app, 'Contents/Resources/app'), { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), '{"name":"cleanmac"}');
    await fs.writeFile(path.join(source, 'build.sh'), '#fixture');
    await fs.writeFile(path.join(app, 'Contents/Resources/app/package.json'), '{"name":"cleanmac"}');
    await fs.writeFile(path.join(app, 'Contents/Resources/app/build-info.json'), JSON.stringify({ updateRoot: updates, projectRoot: source }));
    return app;
  };
  const old = await artifact('version-old');
  const staged = await artifact('version-new');
  const active = await artifact('version-running');
  const target = path.join(root, 'cleanMac.app');
  await fs.cp(old, target, { recursive: true });
  const scheduled = [];
  assert.equal(await migrateLegacyUpdate(path.join(staged, 'Contents/Resources/app'), async (...args) => scheduled.push(args)), true);
  assert.deepEqual(scheduled[0], [staged, target]);
  // Simulate the post-exit installation and successful startup at the stable path.
  const backup = path.join(root, '.runtime/update-backups/previous-fixture.app');
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.rename(target, backup);
  await fs.rename(staged, target);
  const unrelated = path.join(updates, 'version-personal');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'keep.txt'), 'user data');
  const outside = path.join(root, 'Documents');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'user data');
  await fs.symlink(outside, path.join(updates, 'version-linked'));
  const incomplete = path.join(updates, 'version-interrupted');
  await fs.mkdir(incomplete);
  await fs.writeFile(path.join(incomplete, 'update-marker.json'), '{"repository":"zhengzihao2002/cleanMac"}');
  const count = await cleanupUpdateCopies(path.join(target, 'Contents/Resources/app'), [active]);
  assert.equal(count, 4, 'Old stage, moved stage, rollback copy and interrupted job are removed');
  await fs.access(target);
  await fs.access(active);
  await fs.access(path.join(unrelated, 'keep.txt'));
  await fs.access(path.join(outside, 'keep.txt'));
  await assert.rejects(fs.access(old), { code: 'ENOENT' });
  await assert.rejects(fs.access(backup), { code: 'ENOENT' });
  assert.equal(await migrateLegacyUpdate(path.join(target, 'Contents/Resources/app')), false);
});

test('cleanup refuses artifact directories symlinked outside the project', async (t) => {
  const root = makeTempDir('update-links-');
  t.after(() => cleanupHome(root));
  const appPath = path.join(root, 'cleanMac.app/Contents/Resources/app');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(path.join(appPath, 'build-info.json'), JSON.stringify({ updateRoot: path.join(root, '.runtime/updates') }));
  const outside = path.join(root, 'Documents');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, '.runtime'));
  assert.equal(await cleanupUpdateCopies(appPath), 0);
});
