// common.js · helpers shared by every renderer window (panel, bar,
// dashboard, settings). Ported from the extension's content.js.
(function (root) {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const TAG_CSS = {
    red: '#e57373', orange: '#f0a35e', yellow: '#e7c862', green: '#7bb87a',
    blue: '#6da4d4', purple: '#a880c4', pink: '#d486a8'
  };

  const DEFAULT_COLORS = {
    dark: { bg: '#1F1F1E', bgAlt: '#2C2C2A', fg: '#e8e6e3', accent: '#d4a85f', border: '#3a3a37' },
    light: { bg: '#fafaf8', bgAlt: '#f3f2ee', fg: '#1a1a1a', accent: '#8a5a1a', border: '#e5e4de' }
  };

  function fmtTime(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function hexToRgbTriplet(hex) {
    if (!hex || hex[0] !== '#') return '';
    const h = hex.slice(1);
    if (h.length === 3) return `${parseInt(h[0] + h[0], 16)} ${parseInt(h[1] + h[1], 16)} ${parseInt(h[2] + h[2], 16)}`;
    if (h.length === 6) return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
    return '';
  }

  function customColorsCss(customColors) {
    const cc = customColors || { dark: {}, light: {} };
    let css = '';
    ['dark', 'light'].forEach((theme) => {
      const c = cc[theme];
      if (!c || !Object.keys(c).length) return;
      const rules = [];
      if (c.bg) { const rgb = hexToRgbTriplet(c.bg); if (rgb) rules.push(`--bg-rgb: ${rgb};`); }
      if (c.bgAlt) { const rgb = hexToRgbTriplet(c.bgAlt); if (rgb) rules.push(`--bg-alt-rgb: ${rgb};`); }
      if (c.fg) rules.push(`--fg: ${c.fg};`);
      if (c.accent) { rules.push(`--accent: ${c.accent};`); rules.push(`--accent-soft: ${c.accent}22;`); }
      if (c.border) rules.push(`--border: ${c.border};`);
      if (rules.length) css += `.qn-wrap[data-theme="${theme}"] { ${rules.join(' ')} }\n`;
    });
    return css;
  }

  function applyCustomColors(customColors) {
    let el = document.getElementById('qn-custom-colors');
    if (!el) {
      el = document.createElement('style');
      el.id = 'qn-custom-colors';
      document.head.appendChild(el);
    }
    el.textContent = customColorsCss(customColors);
  }

  function svgIcon(name) {
    const paths = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      minus: '<path d="M5 12h14"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
      pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"/>',
      clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
      app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6" fill="currentColor"/><circle cx="9" cy="6.5" r=".6" fill="currentColor"/>',
      check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>',
      eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
      bat: '<path d="M12 7c-2 0-3 1-3 1s-2-3-5-3c0 2 1 3 1 3s-2 1-2 3c2 0 4-1 4-1l2 3 3 1 3-1 2-3s2 1 4 1c0-2-2-3-2-3s1-1 1-3c-3 0-5 3-5 3s-1-1-3-1z"/>',
      arrowLeft: '<path d="M15 18l-6-6 6-6"/>',
      chevronDown: '<path d="M6 9l6 6 6-6"/>',
      chevronUp: '<path d="M6 15l6-6 6 6"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
      stack: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
      tag: '<path d="M20 12V4a1 1 0 0 0-1-1h-8L3 11l9 9 8-8z"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>',
      pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
      split: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
      splitFlip: '<path d="M3 8h18M3 16h18"/><path d="M7 5l-4 3 4 3"/><path d="M17 13l4 3-4 3"/>',
      swap: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
      minimize: '<rect x="3" y="3" width="18" height="18" rx="2" opacity="0.4"/><path d="M6 18h12" stroke-width="2.5"/>',
      dock: '<rect x="3" y="3" width="18" height="18" rx="2" opacity="0.4"/><path d="M6 6h12" stroke-width="2.5"/>',
      table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
      zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>',
      zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/>',
      zen: '<circle cx="12" cy="6" r="2.5"/><path d="M12 10c-3 0-5 2-5 5v1h10v-1c0-3-2-5-5-5z"/><path d="M7 16c-1.5 0.5-3 1.5-3 3h16c0-1.5-1.5-2.5-3-3"/>',
      zenExit: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z"/>',
      bold: '<path d="M7 4h7a4 4 0 0 1 0 8H7z"/><path d="M7 12h8a4 4 0 0 1 0 8H7z"/>',
      italic: '<path d="M19 4h-9M14 20H5M15 4L9 20"/>',
      underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 21h16"/>',
      strike: '<path d="M4 12h16"/><path d="M17 7a4 4 0 0 0-4-3h-2a4 4 0 0 0 0 8"/><path d="M7 17a4 4 0 0 0 4 3h2a4 4 0 0 0 0-8"/>',
      bullet: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
      code: '<path d="M9 8l-5 4 5 4M15 8l5 4-5 4"/>',
      colorText: '<path d="M6 20l6-14 6 14M8.5 16h7"/><rect x="4" y="20" width="16" height="2" fill="currentColor" stroke="none"/>',
      cloud: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1 0 8z"/>'
    };
    return `<svg viewBox="0 0 24 24">${paths[name] || ''}</svg>`;
  }

  const processKey = (p) => String(p || '').trim().toLowerCase();

  const notesForProcess = (notes, proc) => {
    const key = processKey(proc);
    return notes.filter((n) => processKey(n.process) === key);
  };

  const sortPinnedRecent = (list) => {
    const pinned = list.filter((n) => n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const rest = list.filter((n) => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    return [...pinned, ...rest];
  };

  root.QN = {
    escapeHtml, TAG_CSS, DEFAULT_COLORS, fmtTime, svgIcon, customColorsCss,
    applyCustomColors, processKey, notesForProcess, sortPinnedRecent
  };
})(window);
