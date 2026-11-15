'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { makeTempDir, cleanupHome } = require('./fixtures');
const { prepareUpdate } = require('../src/main/updater');

for (const failVerification of [false, true]) test(`installer ${failVerification ? 'restores the original app on verification failure' : 'replaces the original path and next update check does nothing'}`, async (t) => {
  const root = makeTempDir('install-update-');
  t.after(() => cleanupHome(root));
  const target = path.join(root, 'Desktop/cleanMac/cleanMac.app');
  const source = path.join(root, 'downloaded update/cleanMac.app');
  const backup = path.join(root, 'previous.app');
  const resources = 'Contents/Resources/app';
  const oldCommit = 'b'.repeat(40), newCommit = 'a'.repeat(40);
  for (const [bundle, sha] of [[target, oldCommit], [source, newCommit]]) {
    await fs.mkdir(path.join(bundle, resources), { recursive: true });
    await fs.writeFile(path.join(bundle, resources, 'build-info.json'), JSON.stringify({ sourceCommit: sha }));
  }
  const open = path.join(root, 'open');
  const codesign = path.join(root, 'codesign');
  const opened = path.join(root, 'opened');
  await fs.writeFile(open, '#!/bin/bash\nprintf "%s" "$2" > "$TEST_OPEN_LOG"\n', { mode: 0o700 });
  await fs.writeFile(codesign, `#!/bin/bash\nexit ${failVerification ? 1 : 0}\n`, { mode: 0o700 });
  const helper = path.join(root, 'installer.sh');
  const script = (await fs.readFile(path.join(__dirname, '../src/main/install-update.sh'), 'utf8'))
    .replaceAll('/usr/bin/open', '"$TEST_OPEN"').replaceAll('/usr/bin/codesign', '"$TEST_CODESIGN"');
  await fs.writeFile(helper, script);
  const installation = promisify(execFile)('/bin/bash', [helper, source, target, backup, '2147483647'], {
    env: { ...process.env, TEST_OPEN: open, TEST_CODESIGN: codesign, TEST_OPEN_LOG: opened },
  });
  if (failVerification) await assert.rejects(installation);
  else await installation;
  const installed = JSON.parse(await fs.readFile(path.join(target, resources, 'build-info.json')));
  assert.equal(installed.sourceCommit, failVerification ? oldCommit : newCommit);
  assert.equal(await fs.readFile(opened, 'utf8'), target, 'Launch the stable original path, not a staged copy');
  if (!failVerification) {
    assert.equal(JSON.parse(await fs.readFile(path.join(backup, resources, 'build-info.json'))).sourceCommit, oldCommit);
    const calls = [];
    const result = await prepareUpdate({ platform: 'darwin', projectRoot: root, appPath: path.join(target, resources),
      execute: async (file, args) => { calls.push(args); return JSON.stringify([{ sha: newCommit }]); } });
    assert.equal(result.upToDate, true);
    assert.equal(calls.length, 1, 'A second check must only fetch commit metadata');
  }
});
