'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { prepareUpdate, SOURCE, LATEST } = require('../src/main/updater');
const REVISION = 'a'.repeat(40);
const { makeTempDir, cleanupHome } = require('./fixtures');

async function fixture(t, { failBuild = false, version = '1.2.0' } = {}) {
  const root = makeTempDir('update-');
  t.after(() => cleanupHome(root));
  await fs.mkdir(path.join(root, '.runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'local-edit.txt'), 'keep my edits');
  await fs.writeFile(path.join(root, '.runtime/settings.json'), '{"mode":"trash"}');
  const commands = [];
  const execute = async (file, args, options) => {
    commands.push({ file, args, options });
    if (args.includes(LATEST)) return JSON.stringify([{ sha: REVISION }]);
    if (file.endsWith('/ditto')) {
      const source = path.join(args[3], 'cleanMac-HEAD');
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'cleanmac', version }));
      await fs.writeFile(path.join(source, 'build.sh'), '# fixture');
    }
    if (file === '/bin/bash') {
      if (failBuild) throw new Error('Build failed');
      await fs.mkdir(path.join(options.cwd, 'cleanMac.app/Contents/MacOS'), { recursive: true });
      await fs.mkdir(path.join(options.cwd, '.runtime'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'cleanMac.app/Contents/MacOS/cleanMac'), 'fixture');
    }
  };
  return { root, commands, options: { projectRoot: root, appPath: root, platform: 'darwin', execute, currentVersion: '1.1.0' } };
}

test('update downloads fixed GitHub source, builds separately, verifies signature and preserves edits/settings', async (t) => {
  const f = await fixture(t);
  const progress = [];
  const result = await prepareUpdate({ ...f.options, progress: (p) => progress.push(p) });
  assert.equal(result.version, '1.2.0');
  assert.ok(result.application.startsWith(path.join(f.root, '.runtime/updates/version-')));
  assert.equal(await fs.readFile(path.join(f.root, 'local-edit.txt'), 'utf8'), 'keep my edits');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(result.application), '.runtime/settings.json'))), { mode: 'trash' });
  assert.ok(f.commands[0].args.includes(LATEST));
  assert.ok(f.commands[1].args.includes(SOURCE.replace(/HEAD$/, REVISION)));
  assert.ok(f.commands.find((c) => c.file === '/bin/bash').args.includes('--no-open'));
  assert.equal(f.commands.find((c) => c.file === '/bin/bash').options.env.CLEANMAC_SOURCE_COMMIT, REVISION);
  assert.ok(f.commands.find((c) => c.file.endsWith('/codesign')).args.includes('--verify'));
  assert.equal(progress.length, 4);
});

test('failed builds remove only the update job and preserve the current project', async (t) => {
  const f = await fixture(t, { failBuild: true });
  await assert.rejects(prepareUpdate(f.options), /Build failed/);
  assert.equal(await fs.readFile(path.join(f.root, 'local-edit.txt'), 'utf8'), 'keep my edits');
  assert.deepEqual(await fs.readdir(path.join(f.root, '.runtime/updates')), []);
});

test('older GitHub source is refused before running downloaded build code', async (t) => {
  const f = await fixture(t, { version: '1.0.0' });
  await assert.rejects(prepareUpdate(f.options), /older than this app/);
  assert.ok(!f.commands.some((c) => c.file === '/bin/bash'));
});

test('matching installed revision checks metadata only without downloads, build or disk writes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'build-info.json'), JSON.stringify({ sourceCommit: REVISION }));
  const result = await prepareUpdate(f.options);
  assert.equal(result.upToDate, true);
  assert.equal(f.commands.length, 1);
  assert.ok(f.commands[0].args.includes(LATEST));
  await assert.rejects(fs.access(path.join(f.root, '.runtime/updates')), { code: 'ENOENT' });
});

test('a newer source commit updates even when the package version is unchanged', async (t) => {
  const f = await fixture(t, { version: '1.1.0' });
  await fs.writeFile(path.join(f.root, 'build-info.json'), JSON.stringify({ sourceCommit: 'b'.repeat(40) }));
  const result = await prepareUpdate(f.options);
  assert.ok(result.application);
  assert.equal(result.version, '1.1.0');
});

test('failed update checks do not download source or create update folders', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareUpdate({ ...f.options, execute: async () => { throw new Error('GitHub unavailable'); } }), /GitHub unavailable/);
  await assert.rejects(fs.access(path.join(f.root, '.runtime/updates')), { code: 'ENOENT' });
});
