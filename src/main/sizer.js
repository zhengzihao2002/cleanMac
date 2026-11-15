'use strict';

/*
 * Measures how much disk space a folder really occupies (allocated blocks,
 * hard links counted once, symlinks not followed) using the system `du`,
 * with a pure-JavaScript fallback.
 */

const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const DU = process.platform === 'darwin' ? '/usr/bin/du' : 'du';

function duBytes(target, { signal, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(DU, ['-skx', target], { timeout, maxBuffer: 4 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim().split('\n').pop() || '';
      const m = out.match(/^(\d+)\s/);
      if (m) {
        // du can print a subtotal even when interrupted, timed out or blocked.
        const partial = !!err || /Permission denied|Operation not permitted/i.test(String(stderr || ''));
        resolve({ bytes: Number(m[1]) * 1024, partial });
      } else if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
        resolve(null);
      } else {
        resolve({ bytes: 0, partial: true });
      }
    });
    child.on('error', () => {});
  });
}

async function walkBytes(target, signal) {
  let bytes = 0;
  let partial = false;
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    if (signal && signal.aborted) {
      partial = true;
      break;
    }
    const p = stack.pop();
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      partial = true;
      continue;
    }
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A sparse file may have a large logical size and zero allocated blocks.
    bytes += Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;
    if (st.isDirectory()) {
      try {
        for (const name of await fsp.readdir(p)) stack.push(path.join(p, name));
      } catch {
        partial = true;
      }
    }
  }
  return { bytes, partial };
}

async function measure(target, opts = {}) {
  const r = await duBytes(target, opts);
  if (r) return r;
  return walkBytes(target, opts.signal);
}

/** Runs async tasks with a concurrency limit. */
function createPool(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

module.exports = { measure, duBytes, walkBytes, createPool };
