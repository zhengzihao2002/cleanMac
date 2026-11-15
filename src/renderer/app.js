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
    update: { busy: false, message: '' },
    meta: [], // category metadata (before a scan)
    phase: 'idle', // idle | scanning | results | cleaning | done
    view: 'home', // home | cat:<id> | settings | deep-delete
    scan: null,
    progress: { status: {}, sizes: {}, counts: {}, found: 0, path: '' },
    selected: new Set(),
    expanded: new Set(),
    filter: '',
    clean: { done: 0, total: 0, current: '' },
    cleanResult: null,
    animatedTotal: false,
    deep: { loaded: false, apps: [], errors: [], filter: '', showUnavailable: false, status: 'idle', preview: null, selected: new Set(), result: null, error: '', progress: null },
  };
  const byId = new Map();
  const viewCache = new Map();
  const viewFilters = new Map();
  let activeView = null;
  let modalFocus = null;
  const deepBusy = () => ['loading', 'previewing', 'removing'].includes(S.deep.status);

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
        <button class="nav-item ${S.view === 'deep-delete' ? 'active' : ''}" data-nav="deep-delete" ${S.phase === 'scanning' || S.phase === 'cleaning' || S.deep.status === 'removing' ? 'disabled' : ''}>
          <span class="nav-icon deep">${icon('box', 14)}</span>
          <span class="nav-label">Deep Delete</span>
          <span class="nav-meta">${icon('chevronRight', 12)}</span>
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
    if (S.view.startsWith('cat:') || S.view === 'settings' || S.view === 'deep-delete') {
      left = `<button class="btn btn-ghost btn-sm" data-nav="home">${icon('chevronLeft', 15)}Overview</button>`;
    }
    const fda = S.sys && S.sys.fda;
    const fdaPill =
      S.sys && S.sys.platform === 'darwin'
        ? `<button class="chip ${fda ? 'safe' : 'review'}" data-nav="settings" title="Full Disk Access">${icon(fda ? 'shield' : 'lock', 12)}${fda ? 'Full Disk Access' : 'Limited access'}</button>`
        : '';
    const rescan = S.view === 'deep-delete'
      ? `<button class="btn btn-ghost btn-sm" data-action="deep-refresh" ${deepBusy() ? 'disabled' : ''}>${icon('refresh', 15)}Refresh Apps</button>`
      : S.phase === 'results' || S.phase === 'done'
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
      <p class="hero-sub">Find caches, logs and leftovers in the hidden parts of your Mac. Review what is removable, understand the side effects, and keep important files protected.</p>
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
    const runningNote = it.running ? `<br><b>${esc(it.running)}</b> is open right now. Quit it before cleaning; files belonging to open apps will be skipped.` : '';
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
    const mixed = trash && r.report.some((x) => x.admin && (x.ok || x.partial));
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
      <h2 class="hero-title sm">${mixed ? 'removed from selected locations' : trash ? 'moved to the Trash' : 'cleaned up'}</h2>
      <p class="hero-sub" style="margin-bottom:0">${
        trash
          ? `${mixed ? 'System items were deleted directly. Other files ' : 'Files '}can be restored from the Trash until you empty it. Empty the Trash when you are ready to reclaim that space.`
          : 'The selected files were removed. Available disk space is measured below; snapshots and other disk activity can affect it.'
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
        <b>${icon('x', 15)}Delete immediately</b><span>Permanently removes selected files</span></button>
    </div>`;
  }

  function deepAppIcon(a) {
    return typeof a.icon === 'string' && a.icon.startsWith('data:image/png;base64,')
      ? `<img class="deep-native-icon" src="${esc(a.icon)}" alt="" width="40" height="40">`
      : `<span class="avatar" style="--h:${hue(a.name)}">${esc(initial(a.name))}</span>`;
  }

  function deepAppList() {
    const query = S.deep.filter.trim().toLowerCase();
    const rank = (a) => a.protected ? 2 : a.running ? 1 : 0;
    const apps = S.deep.apps.filter((a) => (S.deep.showUnavailable || rank(a) === 0) && `${a.name} ${a.bundleId} ${a.path}`.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    let previous = -1;
    return apps.length ? `<div class="deep-app-grid">${apps.map((a) => {
      const group = rank(a);
      const heading = group !== previous ? `<h2 class="deep-group-title">${['Ready to remove', 'Open apps · quit before removal', 'Protected apps'][group]}</h2>` : '';
      previous = group;
      return `${heading}<button class="deep-app ${a.protected ? 'is-protected' : ''}" data-action="deep-preview" data-id="${esc(a.id)}" ${a.protected ? 'disabled' : ''} aria-label="${esc(a.protected ? a.name + ': ' + a.reason : 'Review ' + a.name)}">
      ${deepAppIcon(a)}
      <span class="deep-app-body"><b>${esc(a.name)}</b><span class="deep-app-id">${esc(a.bundleId)}</span><span class="deep-app-path">${esc(a.path)}</span>${a.protected ? `<span class="deep-app-reason">${icon('lock', 12)}${esc(a.reason || 'Protected application')}</span>` : a.running ? `<span class="deep-app-reason">${icon('running', 12)}Open · quit before removal</span>` : ''}</span>
      ${icon(a.protected ? 'lock' : 'chevronRight', 16)}
    </button>`; }).join('')}</div>` : `<div class="empty">${icon('search', 28)}<b>${query ? 'No matching apps' : 'No removable apps found'}</b>${S.deep.showUnavailable ? 'Try another search or refresh the app list.' : 'Open and protected apps are hidden. Turn on Show unavailable apps to see them.'}</div>`;
  }

  function deepSelectedItems() {
    return (S.deep.preview?.items || []).filter((i) => i.selectable !== false && S.deep.selected.has(i.id));
  }

  function invalidateDeepPreview() {
    S.deep.loaded = false;
    S.deep.apps = [];
    S.deep.errors = [];
    S.deep.preview = null;
    S.deep.selected.clear();
    S.deep.result = null;
    S.deep.error = '';
  }

  function deepItemHtml(it) {
    const selected = S.deep.selected.has(it.id);
    const isApp = it.kind === 'application';
    return `<div class="deep-file ${selected ? 'selected' : ''}" data-deep-row="${esc(it.id)}">
      <button class="check ${selected ? 'on' : ''}" role="checkbox" aria-checked="${selected}" aria-label="${esc('Remove ' + it.name + ': ' + it.path)}" data-action="deep-toggle" data-id="${esc(it.id)}" ${it.selectable === false ? 'disabled' : ''}>${icon(it.selectable === false ? 'lock' : 'check', 14)}</button>
      <div class="deep-file-body"><div class="row-title"><b>${esc(it.name)}</b><span class="chip ${isApp ? 'neutral' : 'review'}">${isApp ? 'Application' : 'Review'}</span></div>
        <div class="deep-path">${esc(it.path || it.location)}</div><p>${esc(it.note || (isApp ? 'The installed app bundle.' : 'App-related files. Review before including; these may contain settings or local data.'))}</p>
      </div>
      <div class="deep-file-end"><b>${esc(fmt(it.size))}${it.partial ? '+' : ''}</b><button class="icon-btn" data-action="deep-reveal" data-id="${esc(it.id)}" aria-label="${esc('Show ' + it.name + ' in Finder')}" title="Show in Finder">${icon('folder', 16)}</button></div>
    </div>`;
  }

  function viewDeepDelete() {
    const d = S.deep;
    const head = `<header class="deep-header"><span class="cat-icon lg deep">${icon('box', 26)}</span><div><div class="eyebrow">APP UNINSTALLER</div><h1>Deep Delete</h1><p>Remove an app and review the files it leaves behind.</p></div><span class="chip safe">${icon('trash', 13)}Trash only</span></header>`;
    if (deepBusy()) {
      return `<div class="fade-in">${head}<div class="deep-loading" role="status"><span class="spinner"></span><h2>${d.status === 'loading' ? 'Finding installed apps…' : d.status === 'previewing' ? 'Finding app-related files…' : 'Moving reviewed files to the Trash…'}</h2><p>${d.status === 'removing' ? 'Each path is checked again before removal. Files macOS protects stay in place.' : 'Looking only in known app locations. Your documents and shared system files stay protected.'}</p><div id="deep-progress" class="deep-footnote">${d.progress ? esc(`${d.progress.done} of ${d.progress.total} · ${d.progress.current || ''}`) : ''}</div></div></div>`;
    }
    if (d.result) {
      const r = d.result;
      const succeeded = r.report.filter((x) => x.ok);
      const failed = r.report.filter((x) => !x.ok);
      return `<div class="fade-in">${head}<section class="panel deep-result" role="status"><span class="deep-result-icon ${failed.length ? 'has-errors' : ''}">${icon(failed.length ? 'warning' : 'check', 30)}</span><h2>${failed.length ? succeeded.length ? 'Some files need another look' : 'Files were left in place' : 'Moved to the Trash'}</h2><p><b>${esc(fmt(r.trashedBytes || 0))}</b> moved to the Trash from ${plural(succeeded.length, 'item')}. ${r.appRemoved ? 'The application was removed.' : 'The application has not been removed.'}</p><p>Space becomes available after you empty the Trash. You can restore the selected files from the Trash until then.</p>${r.diskAfter ? `<div class="deep-disk">${icon('disk', 16)}${esc(fmt(r.diskAfter.free))} available now</div>` : ''}<div class="btn-row"><button class="btn btn-secondary" data-action="open-trash">${icon('trash', 16)}Open Trash</button><button class="btn btn-primary" data-action="deep-refresh">Choose Another App</button></div></section>
        <div class="section-title">Removal details</div><div class="list deep-report">${r.report.map((x) => `<div class="deep-report-row">${icon(x.ok ? 'check' : 'warning', 17)}<div><b>${esc(x.name)}</b>${x.path ? `<span class="deep-path">${esc(x.path)}</span>` : ''}<span>${esc(x.ok ? 'Moved to the Trash' : (x.errors || []).join(' ') || 'Could not be removed.')}</span></div></div>`).join('')}</div></div>`;
    }
    if (d.preview) {
      const p = d.preview;
      const dataCount = p.items.filter((i) => i.kind !== 'application' && i.selectable !== false).length;
      return `<div class="fade-in">${head}<button class="btn btn-ghost btn-sm deep-back" data-action="deep-apps">${icon('chevronLeft', 15)}Choose another app</button>
        <section class="panel deep-identity">${deepAppIcon(p.app)}<div><h2>${esc(p.app.name)}</h2><span class="mono">${esc(p.app.bundleId)}</span><div class="deep-path">${esc(p.app.path)}</div></div><button class="btn btn-secondary btn-sm" data-action="deep-preview" data-id="${esc(p.app.id)}">${icon('refresh', 14)}Refresh Preview</button></section>
        ${p.running || p.app.running ? `<div class="notice">${icon('running', 17)}<span><b>${esc(p.app.name)} is open.</b> Quit it, then refresh this preview before removing files.</span></div>` : ''}
        ${d.error ? `<div class="notice" role="alert">${icon('warning', 17)}<span>${esc(d.error)}</span></div>` : ''}
        <div class="deep-review-note">${icon('eye', 19)}<div><b>Choose what to remove</b><p>${dataCount ? 'Related files are unchecked. They can contain settings, downloads, or local app data. Read each path before including it.' : 'No additional files with an exact ownership match were found in accessible locations.'}</p></div></div>
        ${(p.notices || []).map((n) => `<div class="notice">${icon('info', 16)}<span>${esc(n)}</span></div>`).join('')}
        <div class="list deep-files">${p.items.length ? p.items.map(deepItemHtml).join('') : '<div class="empty"><b>No removable files found</b>Refresh the installed app list to try again.</div>'}</div>
        <details class="deep-limitations"><summary>${icon('shield', 14)}What Deep Delete includes and protects</summary><ul>${(p.limitations?.length ? p.limitations : ['Files are matched by their exact bundle identifier or a known app-specific location. Shared containers, system components, and personal folders are excluded.', 'Some apps store data elsewhere. Deep Delete cannot guarantee the exact free space you had before installation.', 'Files go to the Trash. Space becomes available after you empty it.']).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>
      </div>`;
    }
    return `<div class="fade-in">${head}<div class="deep-intro"><div>${icon('shield', 22)}<div><b>Review first. Recover from Trash.</b><p>Pick an app to see its bundle and files matched by its exact identifier or a known app-specific location. Related data stays unchecked until you choose it.</p></div></div><span>System apps and shared files are protected.</span></div>
      ${d.error ? `<div class="notice" role="alert">${icon('warning', 17)}<span>${esc(d.error)}</span></div>` : ''}
      ${d.errors.map((n) => `<div class="notice">${icon('info', 16)}<span>${esc(typeof n === 'string' ? n : n.message || n.path || 'Some applications could not be read.')}</span></div>`).join('')}
      <div class="list-toolbar"><label class="search deep-search">${icon('search', 15)}<input id="deep-filter" type="search" aria-label="Search installed apps" placeholder="Search apps or bundle IDs" value="${esc(d.filter)}" spellcheck="false"></label><div class="spacer"></div><span class="deep-count">${plural(d.apps.filter((a) => !a.protected && !a.running).length, 'removable app')}</span></div>
      <label class="deep-visibility"><input type="checkbox" id="deep-show-unavailable" ${d.showUnavailable ? 'checked' : ''}>Show unavailable apps (${d.apps.filter((a) => a.protected || a.running).length})</label>
      <div id="deep-app-list">${deepAppList()}</div><p class="deep-footnote">Deep Delete always uses the Trash, even if Smart Scan is set to delete immediately. Empty the Trash yourself when you are ready to reclaim the space.</p></div>`;
  }

  function viewSettings() {
    const sys = S.sys || {};
    const fda = sys.fda;
    const app = sys.app || {};
    return `<div class="fade-in" style="max-width:760px">
      <h1 class="page-title">Settings</h1>

      <section class="panel">
        <h3>Updates</h3>
        <p><b>Running cleanMac ${esc(app.version || '')}</b> · Build ${esc(app.sourceCommit ? app.sourceCommit.slice(0, 10) : 'unknown')}<br><span class="deep-path">${esc(app.applicationPath || '')}</span></p>
        <p>Check GitHub for a newer build. If this build is current, nothing is downloaded or rebuilt. Updates replace cleanMac.app in the original cleanMac folder and remove old update copies after startup succeeds. Your source edits are kept. Everything stays inside that folder.</p>
        <button class="btn btn-secondary btn-sm" data-action="update" ${S.update.busy ? 'disabled' : ''}>${icon('refresh', 15)}${S.update.busy ? 'Checking / Updating…' : 'Check for Updates'}</button>
        <p id="update-status" role="status">${esc(S.update.message)}</p>
      </section>

      <section class="panel">
        <h3>When cleaning</h3>
        <p>System-wide items always need your password and are deleted directly. Deep Delete always moves reviewed files to the Trash.${app.settingsPersisted ? '' : ' (This choice lasts until you quit, because the cleanMac folder is in a location macOS protects.)'}</p>
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
          <div class="legend-row"><span class="chip running">${icon('running')}Open</span><span>The app that owns it is running. Quit the app before cleaning; files belonging to open apps are skipped.</span></div>
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
          <span>${sys.macos ? `macOS ${esc(sys.macos)} · ` : ''}Electron ${esc(app.electron || '')} · Network only for updates. No tracking.</span></div>
      </section>
    </div>`;
  }

  function renderView() {
    let html;
    if (S.view === 'settings') html = viewSettings();
    else if (S.view === 'deep-delete') html = viewDeepDelete();
    else if (S.view.startsWith('cat:') && S.scan && (S.phase === 'results' || S.phase === 'done')) html = viewCategory(S.view.slice(4));
    else if (S.phase === 'scanning') html = viewScanning();
    else if (S.phase === 'cleaning') html = viewCleaning();
    else if (S.phase === 'done') html = viewDone();
    else if (S.phase === 'results') html = viewResults();
    else html = viewIdle();
    const key = S.view === 'deep-delete'
      ? `deep:${deepBusy() ? S.deep.status : S.deep.result ? 'result' : S.deep.preview ? S.deep.preview.id : 'apps'}`
      : S.view === 'home' ? `home:${S.phase}` : S.view;
    if (activeView) {
      activeView.scroll = el.view.scrollTop;
      activeView.nodes = [...el.view.childNodes];
    }
    let cached = viewCache.get(key);
    if (cached && cached.html === html) {
      if (cached !== activeView) el.view.replaceChildren(...cached.nodes);
    } else {
      const scroll = cached?.scroll || 0;
      el.view.innerHTML = html;
      cached = { key, html, scroll, nodes: [...el.view.childNodes] };
      viewCache.set(key, cached);
    }
    activeView = cached;
    el.view.scrollTop = cached.scroll;
    if (viewCache.size > 32) {
      for (const [oldKey, entry] of viewCache) {
        if (entry !== activeView) { viewCache.delete(oldKey); break; }
      }
    }

    if (S.phase === 'results' && S.view === 'home' && !S.animatedTotal) {
      S.animatedTotal = true;
      animateBytes($('#big-total'), totals().total);
    }
  }

  function renderActionBar() {
    if (S.view === 'deep-delete') {
      const preview = S.deep.preview;
      if (!preview || deepBusy() || S.deep.result) {
        el.actionBar.innerHTML = '';
        return;
      }
      const items = deepSelectedItems();
      const bytes = items.reduce((sum, i) => sum + (i.size || 0), 0);
      el.actionBar.innerHTML = `<div class="action-bar"><div class="ab-info"><div class="ab-size">${esc(fmt(bytes))} selected</div><div class="ab-sub">${plural(items.length, 'item')} · Moves to the Trash</div></div><button class="btn btn-primary" data-action="deep-confirm" ${items.length && !preview.running && !preview.app.running ? '' : 'disabled'}>${icon('eye', 17)}Review Removal</button></div>`;
      return;
    }
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
    $('.app').inert = false;
    if (modalFocus && modalFocus.isConnected) modalFocus.focus();
    modalFocus = null;
  }

  function focusModal() {
    if (!modalFocus) modalFocus = document.activeElement;
    $('.app').inert = true;
    const cancel = $('[data-action="close-modal"]', el.modal);
    if (cancel) cancel.focus();
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
      notes.push(`<li class="warn">${icon('running', 16)}<span><b>${esc(running.slice(0, 3).join(', '))}${running.length > 3 ? ` and ${running.length - 3} more` : ''}</b> ${running.length === 1 ? 'is' : 'are'} open. Quit ${running.length === 1 ? 'it' : 'them'} before cleaning. Files belonging to open apps will be skipped.</span></li>`);
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
    focusModal();
  }

  function openDeepConfirm() {
    const preview = S.deep.preview;
    const items = deepSelectedItems();
    if (!preview || !items.length || preview.running || preview.app.running || deepBusy()) return;
    const bytes = items.reduce((sum, i) => sum + (i.size || 0), 0);
    const data = items.filter((i) => i.kind !== 'application');
    el.modal.innerHTML = `<div class="modal-backdrop" data-action="backdrop"><div class="modal deep-confirm" role="dialog" aria-modal="true" aria-labelledby="deep-confirm-title" aria-describedby="deep-confirm-description">
      <div class="modal-icon">${icon('trash', 28)}</div><h2 id="deep-confirm-title">Remove ${esc(preview.app.name)}${items.some((i) => i.kind === 'application') ? '' : ' files'}?</h2><p id="deep-confirm-description">Move ${plural(items.length, 'reviewed item')} (${esc(fmt(bytes))}) to the Trash.</p>
      <div class="deep-confirm-files">${items.map((i) => `<div><b>${esc(i.name)}</b><span class="deep-path">${esc(i.path || i.location)}</span></div>`).join('')}</div>
      <ul class="notes">${data.length ? `<li class="review">${icon('warning', 16)}<span>You included ${plural(data.length, 'related item')}. This can remove app settings and local data. Restore from the Trash before emptying it if needed.</span></li>` : ''}<li>${icon('trash', 16)}<span>Space becomes available after you empty the Trash. Nothing here is deleted immediately.</span></li></ul>
      <div class="modal-actions"><button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="deep-remove">Move to Trash</button></div>
    </div></div>`;
    focusModal();
  }

  /* ============================================================ actions */

  async function loadSystem() {
    try {
      S.sys = await api.systemInfo();
    } catch (e) {
      toast(`Could not read system information: ${e.message}`);
    }
  }

  async function loadDeepApps() {
    if (deepBusy() || S.phase === 'scanning' || S.phase === 'cleaning') return;
    closeModal();
    S.deep.status = 'loading';
    S.deep.error = '';
    S.deep.preview = null;
    S.deep.result = null;
    S.deep.selected.clear();
    render();
    try {
      const result = await api.deepApps();
      S.deep.apps = result.apps || [];
      S.deep.errors = result.errors || [];
      S.deep.loaded = true;
    } catch (e) {
      S.deep.error = `Could not list applications: ${e.message}`;
    } finally {
      S.deep.status = 'idle';
      render();
    }
  }

  async function previewDeepApp(id) {
    if (deepBusy() || S.phase === 'scanning' || S.phase === 'cleaning') return;
    const app = S.deep.apps.find((a) => a.id === id);
    if (!app || app.protected) return;
    S.deep.status = 'previewing';
    S.deep.error = '';
    S.deep.result = null;
    S.deep.preview = null;
    S.deep.selected.clear();
    render();
    try {
      const preview = await api.deepPreview(id);
      S.deep.preview = preview;
      // App data is never selected implicitly, even if a future backend changes its defaults.
      S.deep.selected = new Set(preview.items.filter((i) => i.kind === 'application' && i.selectable !== false && i.defaultSelected && !preview.running && !preview.app.running).map((i) => i.id));
    } catch (e) {
      S.deep.error = `Could not preview this app: ${e.message}`;
    } finally {
      S.deep.status = 'idle';
      render();
      el.view.scrollTop = 0;
    }
  }

  function toggleDeepItem(id) {
    const item = S.deep.preview?.items.find((i) => i.id === id);
    if (!item || item.selectable === false || deepBusy()) return;
    if (S.deep.selected.has(id)) S.deep.selected.delete(id);
    else S.deep.selected.add(id);
    const row = $(`[data-deep-row="${CSS.escape(id)}"]`);
    if (row) {
      const selected = S.deep.selected.has(id);
      row.classList.toggle('selected', selected);
      const check = row.querySelector('.check');
      check.classList.toggle('on', selected);
      check.setAttribute('aria-checked', String(selected));
    }
    renderActionBar();
  }

  async function removeDeepSelection() {
    const preview = S.deep.preview;
    const ids = deepSelectedItems().map((i) => i.id);
    if (!preview || !ids.length || preview.running || preview.app.running || deepBusy()) return;
    closeModal();
    S.deep.status = 'removing';
    S.deep.progress = null;
    S.deep.error = '';
    render();
    try {
      S.deep.result = await api.deepRemove(preview.id, ids);
      // The main process invalidates the old scan after a removal attempt.
      S.scan = null;
      byId.clear();
      S.selected.clear();
      S.expanded.clear();
      S.cleanResult = null;
      S.phase = 'idle';
      S.deep.preview = null;
      S.deep.selected.clear();
      S.deep.loaded = false;
    } catch (e) {
      S.deep.error = `Removal stopped: ${e.message}. Refresh the preview before trying again.`;
      // A failed request may have consumed its preview; require a fresh review.
      S.deep.selected.clear();
    } finally {
      S.deep.status = 'idle';
      await loadSystem();
      render();
      el.view.scrollTop = 0;
    }
  }

  async function startScan() {
    if (S.phase === 'scanning' || S.phase === 'cleaning' || deepBusy()) return;
    closeModal();
    invalidateDeepPreview();
    S.phase = 'scanning';
    S.scan = null;
    byId.clear();
    S.selected.clear();
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
    invalidateDeepPreview();
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
    updateModeControls();
    try {
      S.settings = await api.setSettings({ mode: S.settings.mode });
    } catch {
      /* keep local */
    }
    if (el.modal.innerHTML) openConfirm();
    updateModeControls();
    renderActionBar();
  }

  function updateModeControls() {
    for (const button of el.view.querySelectorAll('[data-action="set-mode"]')) {
      const on = button.dataset.mode === S.settings.mode;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    }
    if (activeView?.key === 'settings') activeView.html = viewSettings();
  }

  function updateUpdateControls() {
    const button = $('[data-action="update"]', el.view);
    if (button) {
      button.disabled = S.update.busy;
      // Keep the button and surrounding Settings DOM mounted during the check.
      button.lastChild.textContent = S.update.busy ? 'Checking / Updating…' : 'Check for Updates';
    }
    const status = $('#update-status');
    if (status) status.textContent = S.update.message;
    if (activeView?.key === 'settings') activeView.html = viewSettings();
  }

  function navigate(view) {
    if (deepBusy()) return;
    if ((S.phase === 'scanning' || S.phase === 'cleaning') && view !== 'settings' && view !== 'home') return;
    if (view.startsWith('cat:') && !S.scan) return;
    if (view === S.view) return;
    viewFilters.set(S.view, S.filter);
    S.filter = viewFilters.get(view) || '';
    S.view = view;
    if (view === 'home' && S.phase === 'done' && S.scan) {
      // keep showing the result screen
    }
    render();
    if (view === 'deep-delete' && !S.deep.loaded && !S.deep.result) loadDeepApps();
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
      case 'deep-refresh':
        loadDeepApps();
        break;
      case 'deep-apps':
        S.deep.preview = null;
        S.deep.selected.clear();
        S.deep.error = '';
        render();
        break;
      case 'deep-preview':
        previewDeepApp(id);
        break;
      case 'deep-toggle':
        toggleDeepItem(id);
        break;
      case 'deep-confirm':
        openDeepConfirm();
        break;
      case 'deep-remove':
        removeDeepSelection();
        break;
      case 'deep-reveal':
        try { await api.deepReveal(S.deep.preview.id, id); } catch (err) { toast(`Could not reveal file: ${err.message}`); }
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
        try { await api.relaunch(); } catch (err) { toast(err.message || 'Wait for the current task to finish before relaunching.'); }
        break;
      case 'update':
        if (S.update.busy) break;
        S.update = { busy: true, message: 'Starting update…' };
        updateUpdateControls();
        try {
          const result = await api.update();
          S.update.message = result.upToDate
            ? `Already up to date.${result.removedCopies ? ` Removed ${result.removedCopies} old update folder(s) from this Mac.` : ''}`
            : 'Installing the update at the original app location…';
        } catch (err) {
          S.update.message = `Update failed. Your current app is unchanged. ${err.message}`;
        } finally {
          S.update.busy = false;
          if (S.view === 'settings') updateUpdateControls();
        }
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
    if (e.target.id === 'deep-show-unavailable') {
      S.deep.showUnavailable = e.target.checked;
      const list = $('#deep-app-list');
      if (list) list.innerHTML = deepAppList();
      return;
    }
    if (e.target.id === 'deep-filter') {
      S.deep.filter = e.target.value;
      const list = $('#deep-app-list');
      if (list) list.innerHTML = deepAppList();
      return;
    }
    if (e.target.id !== 'filter') return;
    S.filter = e.target.value;
    const c = findCat(S.view.slice(4));
    const list = $('.list');
    if (!c || !list) return;
    const items = filteredItems(c);
    list.innerHTML = items.length ? items.map(rowHtml).join('') : `<div class="empty">No items match “${esc(S.filter)}”.</div>`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && el.modal.innerHTML) {
      const focusable = [...el.modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.modal.contains(document.activeElement))) {
        last?.focus();
        e.preventDefault();
      } else if (!e.shiftKey && (document.activeElement === last || !el.modal.contains(document.activeElement))) {
        first?.focus();
        e.preventDefault();
      }
    }
    if (e.key === 'Escape' && el.modal.innerHTML) {
      closeModal();
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      const f = $('#deep-filter') || $('#filter');
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
    if (api.onUpdateProgress) api.onUpdateProgress((message) => {
      S.update.message = message;
      updateUpdateControls();
    });
    if (api.onDeepProgress) api.onDeepProgress((p) => {
      S.deep.progress = p;
      const node = $('#deep-progress');
      if (node) node.textContent = `${p.done} of ${p.total} · ${p.current || ''}`;
    });
    if (api.onNotice) api.onNotice((message) => toast(message, 'info'));
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
