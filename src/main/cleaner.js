'use strict';

/*
 * Removes the items the user selected.
 *
 *  - Only items produced by the scanner can be cleaned (the UI sends ids).
 *  - Every path is re-checked by the guard immediately before removal.
 *  - "contents" items keep the folder itself and remove what is inside it.
 *  - In Trash mode files go to the Trash (with Put Back); in Delete mode they
 *    are removed immediately.
 *  - System-wide items run through a tiny root helper after macOS asks for
 *    the administrator password; the helper re-validates every path itself.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { measure } = require('./sizer');

const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}-\d{6}$/;

function describe(err) {
  switch (err && err.code) {
    case 'EPERM':
    case 'EACCES':
      return 'macOS protects some of these files, so they were left in place.';
    case 'EBUSY':
      return 'Some files are in use. Quit the app and try again.';
    case 'CLEANMAC_GUARD':
      return `Skipped for safety (${err.message.split(':')[0].toLowerCase()}).`;
    default:
      if (err && /Trash/i.test(err.message || '')) return 'Some files could not be moved to the Trash.';
      return (err && err.message) || 'Unknown error';
  }
}

async function makeWritable(target) {
  // Some tools (e.g. Go's module cache) create read-only folders. Make the
  // folders writable for their owner so they can be removed.
  const stack = [target];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    try {
      await fsp.chmod(p, st.mode | 0o700);
    } catch {
      /* ignore */
    }
    try {
      for (const name of await fsp.readdir(p)) stack.push(path.join(p, name));
    } catch {
      /* ignore */
    }
  }
}

async function removePath(target, mode, trashItem) {
  if (mode === 'trash') {
    await trashItem(target);
    return;
  }
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 2 });
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    await makeWritable(target);
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 2 });
  }
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function cleanUserItem(item, { mode, guard, trashItem }) {
  const errors = [];
  let removed = 0;
  const attempt = async (target) => {
    try {
      guard.assert(target);
      await removePath(target, mode, trashItem);
      removed++;
    } catch (e) {
      if (e.code === 'ENOENT' || !(await exists(target))) {
        removed++;
        return;
      }
      errors.push(describe(e));
    }
  };

  for (const p of item.paths) {
    if (item.action === 'contents') {
      const v = guard.check(p);
      if (!v.ok) {
        errors.push(`Skipped for safety (${v.reason.toLowerCase()}).`);
        continue;
      }
      let children;
      try {
        children = await fsp.readdir(p);
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push(describe(e));
        continue;
      }
      for (const name of children) await attempt(path.join(p, name));
    } else if (item.action === 'remove') {
      await attempt(p);
    }
  }
  return { removed, errors: [...new Set(errors)] };
}

/* ------------------------------------------------------------ admin */

function adminPlan(items, guard) {
  const lines = [];
  const refused = new Map();
  for (const item of items) {
    if (item.action === 'snapshot') {
      const date = item.meta && item.meta.date;
      if (SNAPSHOT_RE.test(date || '')) lines.push(`${item.id}\tsnapshot\t${date}`);
      else refused.set(item.id, 'Invalid snapshot name');
      continue;
    }
    for (const p of item.paths) {
      const v = guard.check(p);
      if (!v.ok || !/^\/(Library\/(Caches|Logs)|private\/var\/log)\//.test(p)) {
        refused.set(item.id, `Skipped for safety (${(v.reason || 'not a system location').toLowerCase()}).`);
        continue;
      }
      lines.push(`${item.id}\t${item.action}\t${p}`);
    }
  }
  return { lines, refused };
}

function runOsascript(helperPath, planPath) {
  const script = [
    'on run argv',
    'do shell script "/bin/sh " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) ' +
      'with prompt "cleanMac needs your permission to clean system caches, logs and snapshots." ' +
      'with administrator privileges without altering line endings',
    'end run',
  ];
  const args = [];
  for (const line of script) args.push('-e', line);
  args.push(helperPath, planPath);
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', args, { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function cleanAdminItems(items, { guard, helperPath }) {
  const results = new Map();
  const { lines, refused } = adminPlan(items, guard);
  for (const [id, msg] of refused) results.set(id, { removed: 0, errors: [msg] });
  if (lines.length === 0) return results;

  if (process.platform !== 'darwin') {
    for (const item of items) if (!results.has(item.id)) results.set(item.id, { removed: 0, errors: ['Only supported on macOS.'] });
    return results;
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cleanmac-admin-'));
  const plan = path.join(dir, 'plan.tsv');
  try {
    await fsp.writeFile(plan, lines.join('\n') + '\n', { mode: 0o600 });
    const r = await runOsascript(helperPath, plan);
    if (!r.ok) {
      const cancelled = /-128|cancel/i.test(r.stderr);
      const msg = cancelled ? 'Administrator approval was cancelled.' : 'macOS did not allow the system clean-up to run.';
      for (const item of items) if (!results.has(item.id)) results.set(item.id, { removed: 0, errors: [msg] });
      return results;
    }
    for (const line of r.stdout.split(/\r?\n/)) {
      const [status, id, msg] = line.split('\t');
      if (!id) continue;
      const entry = results.get(id) || { removed: 0, errors: [] };
      if (status === 'OK') entry.removed++;
      else if (status === 'ERR') entry.errors.push(msg || 'Could not be removed.');
      results.set(id, entry);
    }
    for (const item of items) {
      if (!results.has(item.id)) results.set(item.id, { removed: 0, errors: ['No result from the system helper.'] });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  for (const entry of results.values()) entry.errors = [...new Set(entry.errors)];
  return results;
}

/* ------------------------------------------------------------ public */

async function remaining(item) {
  let bytes = 0;
  for (const p of item.paths) {
    if (!(await exists(p))) continue;
    bytes += (await measure(p)).bytes;
  }
  return bytes;
}

/**
 * @param {object[]} items       private scanner items
 * @param {object}   opts        { mode: 'trash'|'delete', guard, trashItem, helperPath, onProgress }
 */
async function clean(items, { mode, guard, trashItem, helperPath, onProgress = () => {} }) {
  const cleanable = items.filter((i) => i.action !== 'none' && i.safety !== 'protected');
  const user = cleanable.filter((i) => !i.admin);
  const admin = cleanable.filter((i) => i.admin);
  const total = cleanable.length;
  const outcome = new Map();
  let done = 0;

  for (const item of user) {
    onProgress({ done, total, current: item.name });
    outcome.set(item.id, await cleanUserItem(item, { mode, guard, trashItem }));
    done++;
  }

  if (admin.length) {
    onProgress({ done, total, current: 'Waiting for your administrator password…', waitingForAdmin: true });
    const results = await cleanAdminItems(admin, { guard, helperPath });
    for (const [id, r] of results) outcome.set(id, r);
    done += admin.length;
  }

  onProgress({ done, total, current: 'Measuring reclaimed space…' });
  const report = [];
  for (const item of cleanable) {
    const r = outcome.get(item.id) || { removed: 0, errors: ['Not processed.'] };
    let freed = null;
    let left = null;
    if (item.size != null) {
      left = await remaining(item);
      freed = Math.max(0, item.size - left);
    }
    report.push({
      id: item.id,
      name: item.name,
      category: item.category,
      admin: item.admin,
      ok: r.errors.length === 0,
      partial: r.errors.length > 0 && (r.removed > 0 || (freed || 0) > 0),
      errors: r.errors,
      freed,
      remaining: left,
    });
  }
  onProgress({ done: total, total, current: null });
  return report;
}

module.exports = { clean, adminPlan, cleanUserItem, describe };
