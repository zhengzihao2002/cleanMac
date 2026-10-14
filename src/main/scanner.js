'use strict';

/*
 * Runs every category collector, double-checks each candidate against the
 * deletion guard, measures the survivors and reports progress as it goes.
 */

const { CATEGORIES } = require('./categories');
const { measure, createPool } = require('./sizer');
const system = require('./system');

const MIN_BYTES = 16 * 1024; // hide near-empty folders

function displayPath(p, home) {
  if (!p) return null;
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

async function buildContext({ home, signal, appNames, running }) {
  const [names, apps] = await Promise.all([
    appNames ? Promise.resolve(appNames) : system.installedApps(home),
    running ? Promise.resolve(running) : system.runningApps(home),
  ]);
  return {
    home,
    signal,
    fda: system.hasFullDiskAccess(home),
    appNames: names,
    running: system.createRunningIndex(apps),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.home
 * @param {object} opts.guard        from guard.createGuard
 * @param {function} opts.emit       progress callback
 * @param {AbortSignal} opts.signal
 * @returns {{ categories, items: Map }} public categories and the private item map
 */
async function scan({ home, guard, emit = () => {}, signal, context, categories = CATEGORIES, lockedPaths = system.lockedPaths }) {
  const started = Date.now();
  const ctx = context || (await buildContext({ home, signal }));
  const pool = createPool(6);
  const privateItems = new Map();
  let nextId = 1;
  let foundBytes = 0;
  let lastTick = 0;

  const tick = (p) => {
    const now = Date.now();
    if (now - lastTick < 60) return;
    lastTick = now;
    emit({ type: 'path', path: displayPath(p, home), foundBytes });
  };

  emit({
    type: 'start',
    fda: ctx.fda,
    categories: categories.map((c) => ({ id: c.id, title: c.title, icon: c.icon, color: c.color, informational: !!c.informational })),
  });

  const out = [];
  for (const cat of categories) {
    if (signal && signal.aborted) break;
    emit({ type: 'category', id: cat.id, status: 'scanning' });

    let result;
    try {
      result = await cat.collect(ctx);
    } catch (e) {
      result = { items: [], notice: `Scan failed: ${e.message}` };
    }

    const publicCat = {
      id: cat.id,
      title: cat.title,
      blurb: cat.blurb,
      description: cat.description,
      icon: cat.icon,
      color: cat.color,
      requires: cat.requires || null,
      informational: !!cat.informational,
      status: result.locked ? 'locked' : 'done',
      locked: result.locked || null,
      notice: result.notice || null,
      neverTouched: result.neverTouched || null,
      items: [],
      bytes: 0,
    };

    const guarded = (result.items || []).filter((c) => {
      if (c.action === 'none' || c.action === 'snapshot') return true;
      // Every path must pass the guard, otherwise the item is not offered.
      return c.paths.length > 0 && c.paths.every((p) => guard.check(p).ok);
    });
    // Skip folders macOS itself locks (System Integrity Protection).
    const lockable = guarded.filter((c) => c.action === 'contents' && !c.admin).flatMap((c) => c.paths);
    const locked = await lockedPaths(lockable);
    const candidates = locked.size ? guarded.filter((c) => !c.paths.some((p) => locked.has(p))) : guarded;

    const sized = await Promise.all(
      candidates.map((c) =>
        pool(async () => {
          if (signal && signal.aborted) return null;
          if (c.unsized || c.paths.length === 0) return { ...c, size: null, partial: false };
          let bytes = 0;
          let partial = false;
          for (const p of c.paths) {
            tick(p);
            const r = await measure(p, { signal });
            bytes += r.bytes;
            partial = partial || r.partial;
          }
          if (c.action !== 'none') {
            foundBytes += bytes;
            tick(c.paths[0]);
          }
          return { ...c, size: bytes, partial };
        }),
      ),
    );

    for (const item of sized) {
      if (!item) continue;
      if (item.action !== 'none' && item.action !== 'snapshot' && item.size < MIN_BYTES) continue;
      const id = `i${nextId++}`;
      const admin = !!item.admin;
      const selectable = item.safety !== 'protected' && item.action !== 'none';
      const priv = { ...item, id, category: cat.id, admin };
      privateItems.set(id, priv);
      publicCat.items.push({
        id,
        category: cat.id,
        name: item.name,
        detail: item.detail || null,
        location: displayPath(item.location, home),
        count: item.paths.length,
        size: item.size,
        partial: !!item.partial,
        safety: item.safety,
        note: item.note || null,
        admin,
        running: item.running || null,
        action: item.action,
        selectable,
        defaultSelected: selectable && item.safety === 'safe' && !item.running && !admin,
      });
    }

    publicCat.items.sort((a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name));
    publicCat.bytes = publicCat.items.reduce((s, i) => s + (i.selectable ? i.size || 0 : 0), 0);
    if (publicCat.status === 'done' && publicCat.items.length === 0) publicCat.status = 'empty';
    out.push(publicCat);
    emit({ type: 'category', id: cat.id, status: publicCat.status, bytes: publicCat.bytes, count: publicCat.items.length, foundBytes });
  }

  return {
    result: {
      cancelled: !!(signal && signal.aborted),
      fda: ctx.fda,
      home,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      categories: out,
    },
    items: privateItems,
  };
}

module.exports = { scan, buildContext, displayPath, MIN_BYTES };
