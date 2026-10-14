'use strict';

(() => {
  const api = window.cleanmac;
  const { icon, logo } = window.ICONS;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = {
    sidebar: $('#sidebar'),
    toolbar: $('#toolbar'),
    view: $('#view'),
    actionBar: $('#action-bar'),
    modal: $('#modal-root'),
    toasts: $('#toast-root'),
  };

  const params = new URLSearchParams(location.search);
  const platform = (api && api.platform) || params.get('platform') || 'darwin';
  if (platform !== 'darwin') document.body.classList.add('no-vibrancy');

  /* ================================================================ state */

  const S = {
    sys: null,
    settings: { mode: 'trash' },
    meta: [], // category metadata (before a scan)
    phase: 'idle', // idle | scanning | results | cleaning | done
    view: 'home', // home | cat:<id> | settings
    scan: null,
    progress: { status: {}, sizes: {}, counts: {}, found: 0, path: '' },
    selected: new Set(),
    expanded: new Set(),
    filter: '',
    clean: { done: 0, total: 0, current: '' },
    cleanResult: null,
    animatedTotal: false,
  };
  const byId = new Map();

  /* ============================================================== helpers */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function bytesParts(n) {
    if (n == null) return { value: '—', unit: '' };
    if (n < 1000) return { value: String(Math.round(n)), unit: n === 1 ? 'byte' : 'bytes' };
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n / 1000;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i++;
    }
    const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    const value = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(v);
    return { value, unit: units[i] };
  }
  const fmt = (n) => {
    const p = bytesParts(n);
    return p.unit ? `${p.value} ${p.unit}` : p.value;
  };
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  function hue(text) {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function initial(name) {
    const m = String(name).match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '•';
  }

  function toast(message, kind = 'warning') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `${icon(kind === 'info' ? 'info' : 'warning', 18)}<div>${esc(message)}</div>`;
    el.toasts.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      setTimeout(() => t.remove(), 320);
    }, 4200);
  }

  function animateBytes(node, to, duration = 900) {
    if (!node) return;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const p = bytesParts(to * eased);
      node.innerHTML = `<span class="grad-text">${esc(p.value)}</span><span class="unit">${esc(p.unit)}</span>`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ================================================================ data */

  const categories = () => (S.scan ? S.scan.categories : S.meta);
  const findCat = (id) => categories().find((c) => c.id === id);
  const cleanableCats = () => (S.scan ? S.scan.categories.filter((c) => !c.informational) : []);

  function indexScan() {
    byId.clear();
    for (const c of S.scan.categories) for (const it of c.items) byId.set(it.id, it);
  }

  function catStats(c) {
    const st = { total: 0, selected: 0, selCount: 0, safe: 0, review: 0, count: 0, admin: 0 };
    if (!c || !c.items) return st;
    for (const it of c.items) {
      if (!it.selectable) continue;
      st.count++;
      st.total += it.size || 0;
      if (it.safety === 'safe') st.safe++;
      if (it.safety === 'review') st.review++;
      if (it.admin) st.admin++;
      if (S.selected.has(it.id)) {
        st.selected += it.size || 0;
        st.selCount++;
      }
    }
    return st;
  }

  function totals() {
    const t = { total: 0, safe: 0, review: 0, protected: 0, count: 0, selected: 0, selCount: 0 };
    if (!S.scan) return t;
    for (const c of S.scan.categories) {
      for (const it of c.items) {
        if (!it.selectable) {
          t.protected += it.size || 0;
          continue;
        }
        t.count++;
        t.total += it.size || 0;
        if (it.safety === 'safe') t.safe += it.size || 0;
        else t.review += it.size || 0;
        if (S.selected.has(it.id)) {
          t.selected += it.size || 0;
          t.selCount++;
        }
      }
    }
    return t;
  }

  const selectedItems = () => [...S.selected].map((id) => byId.get(id)).filter(Boolean);

  // What to show as a category's size: bytes, a count when macOS does not
  // report sizes (snapshots), or a dash when there is nothing.
  function catSizeLabel(c, { long = false } = {}) {
    if (!c.items || c.items.length === 0 || c.status === 'locked') return '—';
    const measured = c.items.filter((i) => i.size != null);
    if (measured.length === 0) return long ? plural(c.items.length, c.id === 'snapshots' ? 'snapshot' : 'item') : String(c.items.length);
    const bytes = c.informational ? measured.reduce((s, i) => s + i.size, 0) : catStats(c).total;
    return bytes > 0 ? fmt(bytes) : '—';
  }

  /* ============================================================== sidebar */

  function renderSidebar() {
    const results = S.phase === 'results' || S.phase === 'done';
    const t = totals();
    const disk = S.sys && S.sys.disk;
    const usedPct = disk ? Math.round((disk.used / disk.total) * 100) : 0;

    const catItems = categories()
      .map((c) => {
        let meta = '';
        if (S.phase === 'scanning') {
          const st = S.progress.status[c.id];
          meta = st === 'scanning' ? '<span class="spinner"></span>' : st === 'locked' ? icon('lock', 13) : st ? esc(stepSizeText(st, S.progress.sizes[c.id], S.progress.counts[c.id])) : '';
        } else if (S.scan) {
          if (c.status === 'locked') meta = icon('lock', 13);
          else if (c.informational) {
            const bytes = c.items.reduce((sum, i) => sum + (i.size || 0), 0);
            meta = bytes > 0 ? esc(fmt(bytes)) : icon('lock', 13);
          }
          else meta = esc(catSizeLabel(c));
        }
        const disabled = !S.scan || S.phase === 'scanning' || S.phase === 'cleaning';
        return `<button class="nav-item ${S.view === 'cat:' + c.id ? 'active' : ''}" data-nav="cat:${esc(c.id)}" ${disabled ? 'disabled' : ''}>
          <span class="nav-icon" style="background-color:${esc(c.color)}">${icon(c.icon, 14)}</span>
          <span class="nav-label">${esc(c.title)}</span>
          <span class="nav-meta">${meta}</span>
        </button>`;
      })
      .join('');

    el.sidebar.innerHTML = `
      <div class="sb-drag"></div>
      <div class="brand">${logo(34)}<div><div class="brand-name">cleanMac</div><div class="brand-sub">System Data cleaner</div></div></div>
      <nav class="nav">
        <button class="nav-item ${S.view === 'home' ? 'active' : ''}" data-nav="home">
          <span class="nav-icon grad">${icon('sparkles', 14)}</span>
          <span class="nav-label">Smart Scan</span>
          <span class="nav-meta">${results && S.scan ? esc(fmt(t.total)) : ''}</span>
        </button>
        <div class="nav-heading">Categories</div>
        ${catItems}
      </nav>
      <div class="sb-footer">
        ${
          disk
            ? `<div class="disk-card">
                <div class="disk-row">${icon('disk', 15)}<span>Macintosh HD</span><span class="free">${esc(fmt(disk.free))} free</span></div>
                <div class="disk-bar"><i style="width:${usedPct}%"></i></div>
                <div class="disk-sub">${esc(fmt(disk.used))} of ${esc(fmt(disk.total))} used</div>
              </div>`
            : ''
        }
        <button class="nav-item ${S.view === 'settings' ? 'active' : ''}" data-nav="settings">
          <span class="nav-icon plain">${icon('settings', 17)}</span><span class="nav-label">Settings</span>
        </button>
      </div>`;
  }

  /* ============================================================== toolbar */

  function renderToolbar() {
    let left = '';
    if (S.view.startsWith('cat:') || S.view === 'settings') {
      left = `<button class="btn btn-ghost btn-sm" data-nav="home">${icon('chevronLeft', 15)}Overview</button>`;
    }
    const fda = S.sys && S.sys.fda;
    const fdaPill =
      S.sys && S.sys.platform === 'darwin'
        ? `<button class="chip ${fda ? 'safe' : 'review'}" data-nav="settings" title="Full Disk Access">${icon(fda ? 'shield' : 'lock', 12)}${fda ? 'Full Disk Access' : 'Limited access'}</button>`
        : '';
    const rescan =
      S.phase === 'results' || S.phase === 'done'
        ? `<button class="btn btn-ghost btn-sm" data-action="scan">${icon('refresh', 15)}Scan Again</button>`
        : S.phase === 'scanning'
          ? `<button class="btn btn-ghost btn-sm" data-action="cancel-scan">${icon('x', 15)}Stop Scan</button>`
          : '';
    el.toolbar.innerHTML = `${left}<div class="spacer"></div>${rescan}${fdaPill}`;
  }

  /* ================================================================ views */

  function gaugeSvg(fraction, { spinning = false } = {}) {
    const r = 94;
    const c = 2 * Math.PI * r;
    const f = Math.max(0, Math.min(1, fraction));
    const dash = spinning ? `${c * 0.28} ${c}` : `${c}`;
    const offset = spinning ? 0 : c * (1 - f);
    return `<svg class="gauge" viewBox="0 0 228 228">
      <defs><linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2bd0f5"/><stop offset=".5" stop-color="#2f7cf6"/><stop offset="1" stop-color="#7a5af8"/>
      </linearGradient></defs>
      <circle class="gauge-inner" cx="114" cy="114" r="80"/>
      <circle class="gauge-track" cx="114" cy="114" r="${r}"/>
      <circle class="gauge-arc" cx="114" cy="114" r="${r}" stroke="url(#gauge-grad)" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" transform="rotate(-90 114 114)"/>
    </svg>`;
  }

  function fdaBanner(wide = false) {
    if (!S.sys || S.sys.platform !== 'darwin' || S.sys.fda) return '';
    return `<div class="banner ${wide ? 'wide' : ''}">
      <div class="banner-icon">${icon('lock', 19)}</div>
      <div class="banner-body"><b>Allow Full Disk Access for a deeper scan</b>
        <span>macOS hides caches of sandboxed apps and device backups until you allow it. cleanMac never reads your documents.</span></div>
      <div class="banner-actions"><button class="btn btn-secondary btn-sm" data-action="open-fda">Open Settings</button></div>
    </div>`;
  }

  function viewIdle() {
    const disk = S.sys && S.sys.disk;
    const frac = disk ? disk.used / disk.total : 0;
    return `<div class="hero fade-in">
      <div class="gauge-wrap">${gaugeSvg(frac)}
        <div class="gauge-center"><div class="gauge-value">${disk ? esc(fmt(disk.free)) : '—'}</div><div class="gauge-label">available</div></div>
      </div>
      <h1 class="hero-title">Reclaim your <span class="grad-text">System Data</span></h1>
      <p class="hero-sub">cleanMac looks through the hidden parts of your Mac — caches, logs and leftovers — and only removes what macOS and your apps rebuild on their own.</p>
      <button class="btn btn-primary btn-xl" data-action="scan">${icon('sparkles', 19)}Start Scan</button>
      <div class="assure">
        <div class="assure-item">${icon('shield', 20)}<div><b>Safety first</b><span>Every item is rated Safe, Review or Protected.</span></div></div>
        <div class="assure-item">${icon('trash', 20)}<div><b>Undo-able</b><span>Moves files to the Trash unless you choose otherwise.</span></div></div>
        <div class="assure-item">${icon('lock', 20)}<div><b>Private</b><span>Runs offline. Nothing ever leaves your Mac.</span></div></div>
      </div>
      ${fdaBanner()}
    </div>`;
  }

  function stepSizeText(status, bytes, count) {
    if (status === 'locked') return 'Needs access';
    if (!status || status === 'scanning') return '';
    if (bytes > 0) return fmt(bytes);
    return count ? `${count} found` : '—';
  }

  function stepState(status) {
    if (status === 'scanning') return '<span class="spinner"></span>';
    if (status === 'locked') return icon('lock', 15);
    if (status === 'done' || status === 'empty') return icon('check', 16);
    return '';
  }

  function viewScanning() {
    const steps = categories()
      .map((c) => {
        const st = S.progress.status[c.id];
        const size = stepSizeText(st, S.progress.sizes[c.id], S.progress.counts[c.id]);
        return `<div class="step ${st ? '' : 'pending'}" data-step="${esc(c.id)}">
          <span class="nav-icon" style="background-color:${esc(c.color)}">${icon(c.icon, 14)}</span>
          <span class="step-name">${esc(c.title)}</span>
          <span class="step-size">${esc(size)}</span>
          <span class="step-state ${st === 'locked' ? 'locked' : ''}">${stepState(st)}</span>
        </div>`;
      })
      .join('');
    return `<div class="hero fade-in">
      <div class="gauge-wrap spinning">${gaugeSvg(0, { spinning: true })}
        <div class="gauge-center"><div class="gauge-value" id="scan-found">${esc(fmt(S.progress.found))}</div><div class="gauge-label">found so far</div></div>
      </div>
      <h2 class="hero-title sm">Scanning your Mac…</h2>
      <div class="ticker" id="scan-ticker">${esc(S.progress.path || 'Getting ready…')}</div>
      <div class="steps">${steps}</div>
      <button class="btn btn-ghost" data-action="cancel-scan">Stop Scan</button>
    </div>`;
  }

  function cardFoot(c, st) {
    if (c.status === 'locked') return `<span class="chip neutral">${icon('lock')}Needs Full Disk Access</span>`;
    if (c.informational) return `<span class="chip protected">${icon('lock')}${plural(c.items.length, 'area')} · never removed</span>`;
    if (!c.items.length) return `<span class="chip safe">${icon('check')}Nothing to clean</span>`;
    const chips = [];
    if (st.safe) chips.push(`<span class="chip safe">${st.safe} safe</span>`);
    if (st.review) chips.push(`<span class="chip review">${st.review} review</span>`);
    if (st.admin) chips.push(`<span class="chip admin">${icon('key')}admin</span>`);
    chips.push(`<span class="card-selected">${st.selCount ? esc(fmt(st.selected)) + ' selected' : 'none selected'}</span>`);
    return chips.join('');
  }

  function viewResults() {
    const t = totals();
    const cats = cleanableCats();
    const segs = cats
      .map((c) => ({ c, b: catStats(c).total }))
      .filter((x) => x.b > 0)
      .sort((a, b) => b.b - a.b);
    const sum = segs.reduce((s, x) => s + x.b, 0) || 1;
    const bar = segs.map((x) => `<i style="width:${(x.b / sum) * 100}%;background:${esc(x.c.color)}" title="${esc(x.c.title)}"></i>`).join('');
    const legend = segs
      .slice(0, 6)
      .map((x) => `<span><i style="background:${esc(x.c.color)}"></i>${esc(x.c.title)} <b>${esc(fmt(x.b))}</b></span>`)
      .join('');
    const big = bytesParts(S.animatedTotal ? t.total : 0);
    const secs = S.scan.durationMs != null ? Math.round(S.scan.durationMs / 1000) : null;
    const took = secs == null ? '' : secs < 1 ? ' · under a second' : ` · ${secs} sec`;
    const protectedCat = S.scan.categories.find((c) => c.informational);
    const protectedLabel = t.protected > 0 ? fmt(t.protected) : protectedCat ? plural(protectedCat.items.length, 'area') : '—';

    const cards = categories()
      .map((c) => {
        const st = catStats(c);
        const size = catSizeLabel(c, { long: true });
        const pct = st.total ? (st.selected / st.total) * 100 : 0;
        return `<button class="card ${c.informational || c.status === 'locked' || !c.items.length ? 'muted' : ''}" data-nav="cat:${esc(c.id)}">
          <div class="card-top"><span class="cat-icon" style="background-color:${esc(c.color)}">${icon(c.icon, 18)}</span><span class="card-size">${esc(size)}</span></div>
          <div class="card-title">${esc(c.title)}</div>
          <div class="card-blurb">${esc(c.blurb)}</div>
          <div class="card-foot">${cardFoot(c, st)}</div>
          ${c.informational ? '' : `<div class="card-progress"><i style="width:${pct}%"></i></div>`}
        </button>`;
      })
      .join('');

    return `<div class="fade-in">
      <section class="summary">
        <div>
          <div class="eyebrow">Scan complete${took}</div>
          <div class="big-number" id="big-total"><span class="grad-text">${esc(big.value)}</span><span class="unit">${esc(big.unit)}</span></div>
          <div class="summary-sub">of removable files in ${plural(t.count, 'item')} · ${esc(fmt(t.selected))} selected</div>
          <div class="stack-bar">${bar}</div>
          <div class="legend">${legend}</div>
        </div>
        <div class="summary-side">
          <div class="side-stat"><span class="dot safe"></span><div><b>${esc(fmt(t.safe))}</b><span>Safe to remove</span></div></div>
          <div class="side-stat"><span class="dot review"></span><div><b>${esc(fmt(t.review))}</b><span>Worth a look first</span></div></div>
          <div class="side-stat"><span class="dot protected"></span><div><b>${esc(protectedLabel)}</b><span>Protected · left alone</span></div></div>
        </div>
      </section>
      ${fdaBanner(true)}
      <div class="section-title">Categories</div>
      <div class="cards">${cards}</div>
    </div>`;
  }

  function badges(it) {
    const b = [];
    if (it.safety === 'safe') b.push('<span class="chip safe">Safe</span>');
    else if (it.safety === 'review') b.push('<span class="chip review">Review</span>');
    else b.push(`<span class="chip protected">${icon('lock')}Protected</span>`);
    if (it.admin) b.push(`<span class="chip admin">${icon('key')}Admin</span>`);
    if (it.running) b.push(`<span class="chip running">${icon('running')}Open</span>`);
    return b.join('');
  }

  function rowHtml(it) {
    const sel = S.selected.has(it.id);
    const exp = S.expanded.has(it.id);
    const sizeText = it.size == null ? '—' : fmt(it.size) + (it.partial ? '+' : '');
    const sizeTitle = it.size == null ? 'macOS does not report this size' : it.partial ? 'At least this much. Some files can only be measured with administrator rights.' : '';
    const runningNote = it.running ? `<br><b>${esc(it.running)}</b> is open right now — quit it before cleaning for the best result.` : '';
    const adminNote = it.admin ? '<br>Needs your administrator password, and is deleted directly instead of going to the Trash.' : '';
    const where = it.location ? `<span class="path">${esc(it.location)}${it.count > 1 ? ` · ${it.count} folders` : ''}</span>` : '';
    const check = it.selectable
      ? `<button class="check ${sel ? 'on' : ''}" data-action="toggle" data-id="${esc(it.id)}" aria-pressed="${sel}" aria-label="Select ${esc(it.name)}">${icon('check')}</button>`
      : `<span class="check locked" title="cleanMac never removes this">${icon('lock', 15)}</span>`;
    return `<div class="row ${sel ? 'selected' : ''} ${exp ? 'expanded' : ''}" data-row="${esc(it.id)}">
      ${check}
      <div class="avatar ${it.selectable ? '' : 'muted'}" style="--h:${hue(it.name)}">${esc(initial(it.name))}</div>
      <div class="row-body" data-action="expand" data-id="${esc(it.id)}">
        <div class="row-title"><span class="row-name">${esc(it.name)}</span>${badges(it)}</div>
        <div class="row-sub">${esc(it.detail || it.location || '')}</div>
        <div class="row-note">${esc(it.note || '')}${runningNote}${adminNote}${where}</div>
      </div>
      <div class="row-size ${it.size == null ? 'unknown' : ''}" title="${esc(sizeTitle)}">${esc(sizeText)}</div>
      <div class="row-actions">
        ${it.location ? `<button class="icon-btn" data-action="reveal" data-id="${esc(it.id)}" title="Show in Finder">${icon('folder', 16)}</button>` : ''}
        <button class="icon-btn" data-action="expand" data-id="${esc(it.id)}" title="Why is this ${esc(it.safety)}?">${icon('info', 16)}</button>
      </div>
    </div>`;
  }

  function filteredItems(c) {
    const q = S.filter.trim().toLowerCase();
    if (!q) return c.items;
    return c.items.filter((it) => [it.name, it.detail, it.location].some((v) => v && v.toLowerCase().includes(q)));
  }

  function lockedPanel(c) {
    const root = S.sys && S.sys.app && S.sys.app.projectRoot;
    return `<div class="locked-panel">
      <div class="lock-badge">${icon('lock', 24)}</div>
      <b>cleanMac needs Full Disk Access to look here</b>
      <p>macOS protects the folders of sandboxed apps. Allow access once and cleanMac can list their caches too — it still never opens your documents.</p>
      <ol class="steps-list">
        <li>Click <b>Open System Settings</b> below (Privacy &amp; Security → Full Disk Access).</li>
        <li>Click <b>+</b>, then choose <b>cleanMac.app</b>${root ? ` in <code>${esc(root)}</code>` : ''}.</li>
        <li>Turn it on, then click <b>Relaunch cleanMac</b>.</li>
      </ol>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-primary btn-sm" data-action="open-fda">Open System Settings</button>
        <button class="btn btn-secondary btn-sm" data-action="relaunch">Relaunch cleanMac</button>
      </div>
    </div>`;
  }

  function viewCategory(id) {
    const c = findCat(id);
    if (!c || !S.scan) return viewIdle();
    const head = `<header class="cat-head">
      <span class="cat-icon lg" style="background-color:${esc(c.color)}">${icon(c.icon, 26)}</span>
      <div class="cat-head-text"><h1>${esc(c.title)}</h1><p>${esc(c.description)}</p></div>
      <div class="cat-head-size"><b>${esc(catSizeLabel(c))}</b><span>${plural(c.items.length, 'item')}</span></div>
    </header>`;

    if (c.status === 'locked') return `<div class="fade-in">${head}${lockedPanel(c)}</div>`;

    const notices = [];
    if (c.notice) notices.push(`<div class="notice">${icon('info', 16)}<span>${esc(c.notice)}</span></div>`);
    if (c.requires === 'admin' && c.items.length) {
      notices.push(`<div class="notice">${icon('key', 16)}<span>These are shared by every user of this Mac. Cleaning them asks for your administrator password, and they are deleted directly — they can't go to the Trash.</span></div>`);
    }

    const list = filteredItems(c);
    const rows = list.length
      ? `<div class="list">${list.map(rowHtml).join('')}</div>`
      : c.items.length
        ? `<div class="list"><div class="empty">No items match “${esc(S.filter)}”.</div></div>`
        : `<div class="list"><div class="empty">${icon('check', 28)}<b>All clean</b>Nothing worth removing here.</div></div>`;

    const toolbar = c.items.length
      ? `<div class="list-toolbar">
          <label class="search">${icon('search', 15)}<input id="filter" type="search" placeholder="Filter items" value="${esc(S.filter)}" spellcheck="false"></label>
          <div class="spacer"></div>
          ${
            c.informational
              ? ''
              : `<div class="seg-mini">
                  <button data-action="select" data-mode="safe" data-cat="${esc(c.id)}">Select Safe</button>
                  <button data-action="select" data-mode="all" data-cat="${esc(c.id)}">Select All</button>
                  <button data-action="select" data-mode="none" data-cat="${esc(c.id)}">Select None</button>
                </div>`
          }
        </div>`
      : '';

    const never = c.neverTouched
      ? `<div class="never"><div class="section-title">cleanMac never touches</div>
          <div class="never-chips">${c.neverTouched.map((n) => `<span>${icon('shield', 14)}${esc(n)}</span>`).join('')}</div></div>`
      : '';

    return `<div class="fade-in">${head}${notices.join('')}${toolbar}${rows}${never}</div>`;
  }

  function viewCleaning() {
    const { done, total, current } = S.clean;
    const frac = total ? done / total : 0;
    return `<div class="hero fade-in">
      <div class="gauge-wrap">${gaugeSvg(frac)}
        <div class="gauge-center"><div class="gauge-value" id="clean-pct">${Math.round(frac * 100)}%</div><div class="gauge-label">cleaned</div></div>
      </div>
      <h2 class="hero-title sm">Cleaning…</h2>
      <div class="ticker" id="clean-current">${esc(current || '')}</div>
    </div>`;
  }

  function viewDone() {
    const r = S.cleanResult;
    const freed = r.report.reduce((s, x) => s + (x.freed || 0), 0);
    const failed = r.report.filter((x) => !x.ok);
    const cleanedCount = r.report.filter((x) => x.ok || x.partial).length;
    const big = bytesParts(freed);
    const trash = r.mode === 'trash' && r.report.some((x) => !x.admin && (x.ok || x.partial));
    const diskLine =
      r.diskBefore && r.diskAfter
        ? `<div class="done-stat"><b>${esc(fmt(r.diskBefore.free))} → ${esc(fmt(r.diskAfter.free))}</b><span>Free space</span></div>`
        : '';
    const failures = failed.length
      ? `<details class="failures"><summary>${icon('warning', 16)}${plural(failed.length, 'item')} could not be fully cleaned</summary>
          <ul>${failed.map((f) => `<li><b>${esc(f.name)}</b> — ${esc(f.errors[0] || 'Unknown error')}</li>`).join('')}</ul></details>`
      : '';
    return `<div class="hero fade-in">
      <div class="done-badge ${failed.length && !cleanedCount ? 'partial' : ''}">${icon(failed.length && !cleanedCount ? 'warning' : 'check')}</div>
      <div class="big-number"><span class="grad-text">${esc(big.value)}</span><span class="unit">${esc(big.unit)}</span></div>
      <h2 class="hero-title sm">${trash ? 'moved to the Trash' : 'cleaned up'}</h2>
      <p class="hero-sub" style="margin-bottom:0">${
        trash
          ? 'Everything can be put back from the Trash. Empty the Trash when you are happy to get the space back.'
          : 'The space is free right away.'
      }</p>
      <div class="done-stats">
        <div class="done-stat"><b>${plural(cleanedCount, 'item')}</b><span>Cleaned</span></div>
        ${diskLine}
      </div>
      ${failures}
      <div class="btn-row">
        ${trash ? `<button class="btn btn-secondary" data-action="open-trash">${icon('trash', 16)}Open Trash</button>` : ''}
        <button class="btn btn-secondary" data-action="back-to-results">Review Remaining</button>
        <button class="btn btn-primary" data-action="scan">${icon('refresh', 16)}Scan Again</button>
      </div>
    </div>`;
  }

  function modeChoice(current) {
    return `<div class="choice" role="radiogroup">
      <button class="${current === 'trash' ? 'on' : ''}" data-action="set-mode" data-mode="trash" role="radio" aria-checked="${current === 'trash'}">
        <b>${icon('trash', 15)}Move to Trash</b><span>Recoverable until you empty the Trash</span></button>
      <button class="${current === 'delete' ? 'on' : ''}" data-action="set-mode" data-mode="delete" role="radio" aria-checked="${current === 'delete'}">
        <b>${icon('x', 15)}Delete immediately</b><span>Frees the space right away</span></button>
    </div>`;
  }

  function viewSettings() {
    const sys = S.sys || {};
    const fda = sys.fda;
    const app = sys.app || {};
    return `<div class="fade-in" style="max-width:760px">
      <h1 class="page-title">Settings</h1>

      <section class="panel">
        <h3>When cleaning</h3>
        <p>System-wide items always need your password and are deleted directly.${app.settingsPersisted ? '' : ' (This choice lasts until you quit, because the cleanMac folder is in a location macOS protects.)'}</p>
        ${modeChoice(S.settings.mode)}
      </section>

      ${
        sys.platform === 'darwin'
          ? `<section class="panel">
              <h3>Permissions</h3>
              <div class="perm-row">
                <span class="chip ${fda ? 'safe' : 'review'}">${icon(fda ? 'shield' : 'lock')}${fda ? 'On' : 'Off'}</span>
                <div class="perm-text"><b>Full Disk Access</b><span>${
                  fda
                    ? 'cleanMac can scan caches of sandboxed apps and device backups.'
                    : 'Optional. Lets cleanMac scan caches of sandboxed apps and device backups. After turning it on, relaunch cleanMac.'
                }</span></div>
                <button class="btn btn-secondary btn-sm" data-action="open-fda">Open Settings</button>
                ${fda ? '' : '<button class="btn btn-ghost btn-sm" data-action="relaunch">Relaunch</button>'}
              </div>
            </section>`
          : ''
      }

      <section class="panel">
        <h3>How cleanMac decides what is safe</h3>
        <p>Only folders on a fixed allow-list are ever scanned, and every path is checked again right before it is removed.</p>
        <div class="legend-rows">
          <div class="legend-row"><span class="chip safe">Safe</span><span>macOS or the app rebuilds it automatically. Selected for you.</span></div>
          <div class="legend-row"><span class="chip review">Review</span><span>Removable, but with a side effect — a re-download, a re-sync or a lost backup. Never selected for you.</span></div>
          <div class="legend-row"><span class="chip protected">${icon('lock')}Protected</span><span>Part of System Data that is your data or that macOS needs. Shown for transparency, never removed.</span></div>
          <div class="legend-row"><span class="chip running">${icon('running')}Open</span><span>The app that owns it is running. Not selected for you; quit the app first.</span></div>
        </div>
      </section>

      <section class="panel">
        <h3>Leave no trace</h3>
        <p>cleanMac, its runtime and everything it downloaded live in one folder. While it runs it keeps temporary data in a private folder that is erased when you quit. Delete the folder and cleanMac is gone; run <code>./uninstall.sh</code> first to also clear the Full Disk Access entry.</p>
        ${app.projectRoot ? `<div class="path-box">${icon('folder', 15)}${esc(app.projectRoot)}</div>` : ''}
        <button class="btn btn-secondary btn-sm" data-action="open-project">${icon('folder', 15)}Show cleanMac Folder</button>
      </section>

      <section class="panel about">
        ${logo(44)}
        <div><b>cleanMac ${esc(app.version || '')}</b>
          <span>${sys.macos ? `macOS ${esc(sys.macos)} · ` : ''}Electron ${esc(app.electron || '')} · No network access, no tracking.</span></div>
      </section>
    </div>`;
  }

  function renderView() {
    let html;
    if (S.view === 'settings') html = viewSettings();
    else if (S.view.startsWith('cat:') && S.scan && (S.phase === 'results' || S.phase === 'done')) html = viewCategory(S.view.slice(4));
    else if (S.phase === 'scanning') html = viewScanning();
    else if (S.phase === 'cleaning') html = viewCleaning();
    else if (S.phase === 'done') html = viewDone();
    else if (S.phase === 'results') html = viewResults();
    else html = viewIdle();
    el.view.innerHTML = html;

    if (S.phase === 'results' && S.view === 'home' && !S.animatedTotal) {
      S.animatedTotal = true;
      animateBytes($('#big-total'), totals().total);
    }
  }

  function renderActionBar() {
    const show = S.phase === 'results' && S.view !== 'settings';
    if (!show) {
      el.actionBar.innerHTML = '';
      return;
    }
    const t = totals();
    const items = selectedItems();
    const admin = items.filter((i) => i.admin).length;
    const modeText = S.settings.mode === 'delete' ? 'Deletes immediately' : 'Moves to the Trash';
    el.actionBar.innerHTML = `<div class="action-bar">
      <div class="ab-info">
        <div class="ab-size">${esc(fmt(t.selected))} selected</div>
        <div class="ab-sub">${plural(t.selCount, 'item')}${admin ? ` · ${admin} need your password` : ''} · ${modeText}</div>
      </div>
      <button class="btn btn-primary" data-action="confirm" ${t.selCount ? '' : 'disabled'}>${icon('sparkles', 17)}Clean</button>
    </div>`;
  }

  function render() {
    renderSidebar();
    renderToolbar();
    renderView();
    renderActionBar();
  }

  // Lightweight refresh after a selection change (keeps scroll position).
  function refreshSelection() {
    renderSidebar();
    renderActionBar();
    if (S.view === 'home' && S.phase === 'results') {
      const scroll = el.view.scrollTop;
      renderView();
      el.view.scrollTop = scroll;
    } else if (S.view.startsWith('cat:')) {
      const c = findCat(S.view.slice(4));
      const node = $('.cat-head-size b');
      if (c && node) node.textContent = catSizeLabel(c);
    }
  }

  /* ============================================================== modal */

  function closeModal() {
    el.modal.innerHTML = '';
  }

  function openConfirm() {
    const items = selectedItems();
    if (!items.length) return;
    const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
    const cats = new Set(items.map((i) => i.category));
    const admin = items.filter((i) => i.admin);
    const running = [...new Set(items.map((i) => i.running).filter(Boolean))];
    const review = items.filter((i) => i.safety === 'review');
    const mode = S.settings.mode;

    const notes = [];
    if (running.length) {
      notes.push(`<li class="warn">${icon('running', 16)}<span><b>${esc(running.slice(0, 3).join(', '))}${running.length > 3 ? ` and ${running.length - 3} more` : ''}</b> ${running.length === 1 ? 'is' : 'are'} open. Quit ${running.length === 1 ? 'it' : 'them'} first for the cleanest result.</span></li>`);
    }
    if (review.length) {
      notes.push(`<li class="review">${icon('eye', 16)}<span>You selected ${plural(review.length, 'item')} marked <b>Review</b>. Make sure you are fine with the side effects described for ${review.length === 1 ? 'it' : 'them'}.</span></li>`);
    }
    if (admin.length) {
      notes.push(`<li class="admin">${icon('key', 16)}<span>${plural(admin.length, 'system item')} will ask for your administrator password and ${admin.length === 1 ? 'is' : 'are'} deleted directly.</span></li>`);
    }

    el.modal.innerHTML = `<div class="modal-backdrop" data-action="backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-icon ${mode === 'delete' ? 'danger' : ''}">${icon(mode === 'delete' ? 'x' : 'trash', 28)}</div>
        <h2 id="confirm-title">Clean ${esc(fmt(bytes))}?</h2>
        <p>${plural(items.length, 'item')} from ${plural(cats.size, 'category', 'categories')}.</p>
        ${modeChoice(mode)}
        ${notes.length ? `<ul class="notes">${notes.join('')}</ul>` : ''}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
          <button class="btn btn-primary ${mode === 'delete' ? 'btn-danger' : ''}" data-action="do-clean" id="do-clean">${mode === 'delete' ? 'Delete' : 'Move to Trash'}</button>
        </div>
      </div>
    </div>`;
    setTimeout(() => {
      const b = $('#do-clean');
      if (b) b.focus();
    }, 50);
  }

  /* ============================================================ actions */

  async function loadSystem() {
    try {
      S.sys = await api.systemInfo();
    } catch (e) {
      toast(`Could not read system information: ${e.message}`);
    }
  }

  async function startScan() {
    if (S.phase === 'scanning' || S.phase === 'cleaning') return;
    closeModal();
    S.phase = 'scanning';
    S.view = 'home';
    S.filter = '';
    S.expanded.clear();
    S.progress = { status: {}, sizes: {}, counts: {}, found: 0, path: '' };
    S.animatedTotal = false;
    render();
    try {
      const result = await api.scan();
      await loadSystem();
      if (result.cancelled) {
        S.phase = 'idle';
        S.scan = null;
        toast('Scan stopped.', 'info');
      } else {
        S.scan = result;
        indexScan();
        S.selected = new Set([...byId.values()].filter((i) => i.defaultSelected).map((i) => i.id));
        S.phase = 'results';
      }
    } catch (e) {
      S.phase = S.scan ? 'results' : 'idle';
      toast(`Scan failed: ${e.message}`);
    }
    render();
  }

  function onScanProgress(p) {
    if (S.phase !== 'scanning') return;
    if (p.type === 'start') {
      return;
    }
    if (typeof p.foundBytes === 'number') {
      S.progress.found = p.foundBytes;
      const f = $('#scan-found');
      if (f) f.textContent = fmt(p.foundBytes);
    }
    if (p.type === 'path') {
      S.progress.path = p.path;
      const t = $('#scan-ticker');
      if (t) t.textContent = p.path;
    }
    if (p.type === 'category') {
      S.progress.status[p.id] = p.status;
      if (typeof p.bytes === 'number') S.progress.sizes[p.id] = p.bytes;
      if (typeof p.count === 'number') S.progress.counts[p.id] = p.count;
      const node = $(`[data-step="${CSS.escape(p.id)}"]`);
      if (node) {
        node.classList.remove('pending');
        const size = node.querySelector('.step-size');
        const state = node.querySelector('.step-state');
        size.textContent = stepSizeText(p.status, p.bytes, p.count);
        state.className = `step-state ${p.status === 'locked' ? 'locked' : ''}`;
        state.innerHTML = stepState(p.status);
      }
      renderSidebar();
    }
  }

  async function doClean() {
    const ids = [...S.selected].filter((id) => byId.has(id));
    if (!ids.length) return;
    closeModal();
    S.phase = 'cleaning';
    S.view = 'home';
    S.clean = { done: 0, total: ids.length, current: 'Starting…' };
    render();
    try {
      const result = await api.clean(ids, S.settings.mode);
      S.cleanResult = result;
      applyCleanResult(result);
      S.phase = 'done';
    } catch (e) {
      toast(`Cleaning failed: ${e.message}`);
      S.phase = 'results';
    }
    await loadSystem();
    render();
  }

  function applyCleanResult(result) {
    const done = new Map(result.report.map((r) => [r.id, r]));
    for (const c of S.scan.categories) {
      c.items = c.items.filter((it) => {
        const r = done.get(it.id);
        if (!r) return true;
        if (r.ok) {
          byId.delete(it.id);
          S.selected.delete(it.id);
          return false;
        }
        if (r.remaining != null) it.size = r.remaining;
        else if (it.size != null && r.freed) it.size = Math.max(0, it.size - r.freed);
        S.selected.delete(it.id);
        return true;
      });
    }
  }

  function onCleanProgress(p) {
    if (S.phase !== 'cleaning') return;
    S.clean = { done: p.done, total: p.total, current: p.current };
    const frac = p.total ? p.done / p.total : 0;
    const pct = $('#clean-pct');
    if (pct) pct.textContent = `${Math.round(frac * 100)}%`;
    const cur = $('#clean-current');
    if (cur) cur.textContent = p.current || '';
    const arc = $('.gauge-arc');
    if (arc) {
      const c = 2 * Math.PI * 94;
      arc.setAttribute('stroke-dashoffset', String(c * (1 - frac)));
    }
  }

  function toggle(id) {
    const it = byId.get(id);
    if (!it || !it.selectable) return;
    if (S.selected.has(id)) S.selected.delete(id);
    else S.selected.add(id);
    const row = $(`[data-row="${CSS.escape(id)}"]`);
    if (row) {
      const on = S.selected.has(id);
      row.classList.toggle('selected', on);
      const chk = row.querySelector('.check');
      chk.classList.toggle('on', on);
      chk.setAttribute('aria-pressed', String(on));
    }
    refreshSelection();
  }

  function selectIn(catId, mode) {
    const c = findCat(catId);
    if (!c) return;
    for (const it of filteredItems(c)) {
      if (!it.selectable) continue;
      const want = mode === 'all' || (mode === 'safe' && it.safety === 'safe' && !it.running);
      if (want) S.selected.add(it.id);
      else S.selected.delete(it.id);
    }
    const scroll = el.view.scrollTop;
    renderView();
    el.view.scrollTop = scroll;
    renderSidebar();
    renderActionBar();
  }

  async function setMode(mode) {
    S.settings.mode = mode === 'delete' ? 'delete' : 'trash';
    try {
      S.settings = await api.setSettings({ mode: S.settings.mode });
    } catch {
      /* keep local */
    }
    if (el.modal.innerHTML) openConfirm();
    if (S.view === 'settings') renderView();
    renderActionBar();
  }

  function navigate(view) {
    if ((S.phase === 'scanning' || S.phase === 'cleaning') && view !== 'settings' && view !== 'home') return;
    if (view.startsWith('cat:') && !S.scan) return;
    if (view !== S.view) S.filter = '';
    S.view = view;
    if (view === 'home' && S.phase === 'done' && S.scan) {
      // keep showing the result screen
    }
    render();
    el.view.scrollTop = 0;
  }

  /* ============================================================= events */

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav && !nav.disabled) {
      navigate(nav.dataset.nav);
      return;
    }
    const a = e.target.closest('[data-action]');
    if (!a || a.disabled) return;
    const { action, id } = a.dataset;
    switch (action) {
      case 'scan':
        startScan();
        break;
      case 'cancel-scan':
        api.cancelScan();
        break;
      case 'toggle':
        toggle(id);
        break;
      case 'expand': {
        if (e.target.closest('.row-note')) return;
        const row = $(`[data-row="${CSS.escape(id)}"]`);
        if (S.expanded.has(id)) S.expanded.delete(id);
        else S.expanded.add(id);
        if (row) row.classList.toggle('expanded', S.expanded.has(id));
        break;
      }
      case 'reveal':
        api.reveal(id);
        break;
      case 'select':
        selectIn(a.dataset.cat, a.dataset.mode);
        break;
      case 'confirm':
        openConfirm();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'backdrop':
        if (e.target === a) closeModal();
        break;
      case 'set-mode':
        setMode(a.dataset.mode);
        break;
      case 'do-clean':
        doClean();
        break;
      case 'open-fda':
        api.openFullDiskAccess();
        break;
      case 'relaunch':
        api.relaunch();
        break;
      case 'open-trash':
        api.openTrash();
        break;
      case 'open-project':
        api.openProjectFolder();
        break;
      case 'back-to-results':
        S.phase = 'results';
        S.view = 'home';
        S.animatedTotal = true;
        render();
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'filter') return;
    S.filter = e.target.value;
    const c = findCat(S.view.slice(4));
    const list = $('.list');
    if (!c || !list) return;
    const items = filteredItems(c);
    list.innerHTML = items.length ? items.map(rowHtml).join('') : `<div class="empty">No items match “${esc(S.filter)}”.</div>`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.modal.innerHTML) {
      closeModal();
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      const f = $('#filter');
      if (f) {
        f.focus();
        e.preventDefault();
      }
    }
  });

  /* =============================================================== boot */

  async function boot() {
    if (!api) {
      el.view.innerHTML = '<div class="hero"><h2 class="hero-title sm">Open cleanMac.app to use cleanMac.</h2></div>';
      return;
    }
    api.onScanProgress(onScanProgress);
    api.onCleanProgress(onCleanProgress);
    api.onNavigate((view) => navigate(view));
    api.onCommand((cmd) => {
      if (cmd === 'scan') startScan();
    });
    const [meta, settings] = await Promise.all([api.categories(), api.getSettings(), loadSystem()]);
    S.meta = meta || [];
    S.settings = settings || S.settings;
    render();
  }

  boot();
})();
