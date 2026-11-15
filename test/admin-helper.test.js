'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { makeTempDir, cleanupHome, write } = require('./fixtures');

test('administrator helper preserves live logs, mounts, linked data and protected nested bundles', async (t) => {
  const dir = makeTempDir('admin-helper-');
  t.after(() => cleanupHome(dir));
  const caches = path.join(dir, 'Caches');
  const logs = path.join(dir, 'Logs');
  const varLogs = path.join(dir, 'var-log');
  const documents = path.join(dir, 'Documents');
  write(path.join(documents, 'important.txt'));
  write(path.join(caches, 'ordinary/data'));
  write(path.join(caches, 'protected/staging/App.app/Contents/Info.plist'));
  write(path.join(caches, 'protected/keep-with-bundle'));
  write(path.join(caches, 'links/data'));
  const mounted = path.join(caches, 'mounted-root');
  write(path.join(mounted, 'important.txt'));
  fs.symlinkSync(documents, path.join(caches, 'linked-root'));
  fs.symlinkSync(documents, path.join(caches, 'links/documents'));
  write(path.join(varLogs, 'system.log'));
  write(path.join(varLogs, 'system.log.0.gz'));
  write(path.join(varLogs, 'subdir/live.log'));

  // Execute the real helper logic against isolated roots, without sudo or
  // touching any real system path. These variables exist only in this copy.
  const source = fs.readFileSync(path.join(__dirname, '../src/main/admin-helper.sh'), 'utf8')
    .replaceAll('/Library/Caches', '${TEST_CACHE_ROOT}')
    .replaceAll('/Library/Logs', '${TEST_LOG_ROOT}')
    .replaceAll('/private/var/log', '${TEST_VAR_LOG_ROOT}')
    // Simulate a different root device without requiring mount privileges.
    // All other device queries execute the real platform stat command.
    .replace('device_id() {', 'device_id() {\n  if [ "$1" = "$TEST_MOUNT_ROOT" ]; then echo mounted-device; return; fi');
  const helper = path.join(dir, 'helper.sh');
  fs.writeFileSync(helper, source);
  const rows = [
    ['cache', 'contents', path.join(caches, 'ordinary')],
    ['protected', 'contents', path.join(caches, 'protected')],
    ['symlink', 'contents', path.join(caches, 'linked-root')],
    ['links', 'contents', path.join(caches, 'links')],
    ['mounted', 'contents', mounted],
    ['live', 'remove', path.join(varLogs, 'system.log')],
    ['archive', 'remove', path.join(varLogs, 'system.log.0.gz')],
    ['logdir', 'contents', path.join(varLogs, 'subdir')],
    ['trailing', 'contents', path.join(caches, 'protected') + '/'],
  ];
  const plan = path.join(dir, 'plan.tsv');
  fs.writeFileSync(plan, rows.map((row) => row.join('\t')).join('\n') + '\n');
  const { stdout } = await promisify(execFile)('/bin/sh', [helper, plan], {
    env: { ...process.env, TEST_CACHE_ROOT: caches, TEST_LOG_ROOT: logs, TEST_VAR_LOG_ROOT: varLogs, TEST_MOUNT_ROOT: mounted },
  });
  for (const id of ['cache', 'links', 'archive']) assert.match(stdout, new RegExp(`^OK\\t${id}$`, 'm'));
  for (const id of ['protected', 'symlink', 'mounted', 'live', 'logdir', 'trailing']) assert.match(stdout, new RegExp(`^ERR\\t${id}\\t`, 'm'));
  assert.deepEqual(fs.readdirSync(path.join(caches, 'ordinary')), []);
  assert.deepEqual(fs.readdirSync(path.join(caches, 'links')), []);
  assert.ok(fs.existsSync(path.join(caches, 'protected/staging/App.app/Contents/Info.plist')));
  assert.ok(fs.existsSync(path.join(caches, 'protected/keep-with-bundle')));
  assert.ok(fs.existsSync(path.join(documents, 'important.txt')));
  assert.ok(fs.existsSync(path.join(mounted, 'important.txt')));
  assert.ok(fs.existsSync(path.join(varLogs, 'system.log')));
  assert.ok(fs.existsSync(path.join(varLogs, 'subdir/live.log')));
  assert.equal(fs.existsSync(path.join(varLogs, 'system.log.0.gz')), false);
});
