'use strict';

// Line icons drawn on a 24×24 grid (SF Symbols–inspired).
window.ICONS = (() => {
  const paths = {
    sparkles:
      '<path class="fill" d="M10.5 3.2c.2-.6 1-.6 1.2 0l1.3 3.9a3 3 0 0 0 1.9 1.9l3.9 1.3c.6.2.6 1 0 1.2l-3.9 1.3a3 3 0 0 0-1.9 1.9l-1.3 3.9c-.2.6-1 .6-1.2 0l-1.3-3.9a3 3 0 0 0-1.9-1.9L3.4 11.5c-.6-.2-.6-1 0-1.2l3.9-1.3a3 3 0 0 0 1.9-1.9z"/><path class="fill" d="M18.6 15.2c.1-.3.5-.3.6 0l.5 1.5c.1.4.4.7.8.8l1.5.5c.3.1.3.5 0 .6l-1.5.5a1.2 1.2 0 0 0-.8.8l-.5 1.5c-.1.3-.5.3-.6 0l-.5-1.5a1.2 1.2 0 0 0-.8-.8l-1.5-.5c-.3-.1-.3-.5 0-.6l1.5-.5c.4-.1.7-.4.8-.8z"/>',
    stack: '<path d="M12 3.5 3.5 8 12 12.5 20.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
    doc: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h4"/>',
    hammer: '<path d="m8.5 7.5-4.5 4.5 4.5 4.5"/><path d="m15.5 7.5 4.5 4.5-4.5 4.5"/><path d="m13.5 5-3 14"/>',
    box: '<path d="M20.5 7.8 12 3.5 3.5 7.8v8.4l8.5 4.3 8.5-4.3z"/><path d="m3.5 7.8 8.5 4.4 8.5-4.4"/><path d="M12 12.2v8.3"/>',
    phone: '<rect x="7" y="2.75" width="10" height="18.5" rx="2.6"/><path d="M10.75 18.25h2.5"/>',
    gear: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>',
    clock: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4.2h4.2"/><path d="M12 8v4.3l2.8 1.8"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.4"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
    shield: '<path d="M12 3.2 5 5.8v5.7c0 4.3 2.9 7.9 7 9.3 4.1-1.4 7-5 7-9.3V5.8z"/><path d="m9 12.2 2.2 2.2L15.3 10"/>',
    trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.8c0-.7.5-1.3 1.2-1.3h2.6c.7 0 1.2.6 1.2 1.3v1.7"/><path d="m6.3 6.5.9 12.3a2 2 0 0 0 2 1.7h5.6a2 2 0 0 0 2-1.7l.9-12.3"/><path d="M10.2 10.5v6M13.8 10.5v6"/>',
    check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2"/><path d="M12 7.8h.01"/>',
    warning: '<path d="M10.3 4.4 2.9 17.3c-.8 1.3.2 3 1.7 3h14.8c1.5 0 2.5-1.7 1.7-3L13.7 4.4c-.8-1.3-2.6-1.3-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 16.8h.01"/>',
    settings: '<path d="M4 7h9.5M17.5 7H20M4 12h3M11 12h9M4 17h11.5M19.5 17h.5"/><circle cx="15.5" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17.5" cy="17" r="2"/>',
    refresh: '<path d="M19.5 11.5a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.8h-4.8"/>',
    key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.6-8.6"/><path d="m16.5 7 2.5 2.5"/><path d="m14.5 9 1.8 1.8"/>',
    running: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8v6.4l5.2-3.2z" class="fill"/>',
    disk: '<rect x="3.5" y="12.5" width="17" height="7" rx="2"/><path d="M5.2 12.5 7.6 5.8c.3-.8 1-1.3 1.8-1.3h5.2c.8 0 1.5.5 1.8 1.3l2.4 6.7"/><path d="M16.5 16h.01"/>',
    x: '<path d="M7 7l10 10M17 7 7 17"/>',
    external: '<path d="M14 4.5h5.5V10"/><path d="m19.5 4.5-8 8"/><path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    minus: '<path d="M6 12h12"/>',
    leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z"/><path d="M5 19c3-4 6-7 10-9"/>',
  };

  function icon(name, size = 18, extraClass = '') {
    const body = paths[name] || paths.info;
    return `<svg class="icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  // The cleanMac mark: a gradient squircle with a sparkle.
  const logoIds = new Map();
  function logo(size = 32) {
    if (!logoIds.has(size)) logoIds.set(size, `lg${Math.random().toString(36).slice(2, 8)}`);
    const id = logoIds.get(size);
    return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#36D7F7"/><stop offset=".52" stop-color="#2F7CF6"/><stop offset="1" stop-color="#7A5AF8"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#${id})"/>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#fff" opacity=".08"/>
      <path fill="#fff" d="M29.2 13.6c.4-1.2 2.1-1.2 2.5 0l2.6 7.9a6 6 0 0 0 3.8 3.8l7.9 2.6c1.2.4 1.2 2.1 0 2.5l-7.9 2.6a6 6 0 0 0-3.8 3.8l-2.6 7.9c-.4 1.2-2.1 1.2-2.5 0l-2.6-7.9a6 6 0 0 0-3.8-3.8l-7.9-2.6c-1.2-.4-1.2-2.1 0-2.5l7.9-2.6a6 6 0 0 0 3.8-3.8z"/>
      <path fill="#fff" opacity=".85" d="M45.4 38.9c.2-.6 1-.6 1.2 0l1 3a2.4 2.4 0 0 0 1.5 1.5l3 1c.6.2.6 1 0 1.2l-3 1a2.4 2.4 0 0 0-1.5 1.5l-1 3c-.2.6-1 .6-1.2 0l-1-3a2.4 2.4 0 0 0-1.5-1.5l-3-1c-.6-.2-.6-1 0-1.2l3-1a2.4 2.4 0 0 0 1.5-1.5z"/>
    </svg>`;
  }

  return { icon, logo };
})();
