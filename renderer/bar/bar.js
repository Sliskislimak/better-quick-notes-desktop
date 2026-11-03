// Docked bar: shows the active note of the current app's stack.
// Click to expand, drag to slide it along the top edge, scroll to cycle
// through the stack. Fades to the frosted idle state when not hovered.
(function () {
  const { svgIcon, escapeHtml, TAG_CSS, sortPinnedRecent, notesForProcess } = window.QN;
  const $ = (id) => document.getElementById(id);
  const dock = $('dock');
  const WAKE_MS = 2500;

  let notes = [];
  let prefs = {};
  let settings = {};
  let ctx = { hasTarget: false };
  let wakeTimer = null;

  const invoke = (ch, ...a) => window.qn.invoke(ch, ...a);
  const stack = () => sortPinnedRecent(notesForProcess(notes, ctx.process));

  function activeNote() {
    const list = stack();
    const id = (prefs.activeByProcess || {})[ctx.processKey] || (settings.appDefaults || {})[ctx.processKey];
    return list.find((n) => n.id === id) || list[0] || null;
  }

  function render() {
    const wrap = $('wrap');
    wrap.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    window.QN.applyCustomColors(prefs.customColors);
    wrap.style.setProperty('--idle-opacity', String(settings.idleOpacity != null ? settings.idleOpacity : 0.25));

    const list = stack();
    const n = activeNote();
    $('title').textContent = n ? n.title || 'Untitled' : 'No notes';
    $('count').textContent = String(list.length);
    $('count').hidden = list.length < 2;
    const color = n && n.tag && TAG_CSS[n.tag];
    $('dot').style.background = color || 'var(--accent)';
    $('appIcon').innerHTML = ctx.icon ? `<img src="${escapeHtml(ctx.icon)}" alt="">` : svgIcon('app');
    const hk = settings.hotkeys || {};
    dock.title = `${ctx.appName || ctx.process || ''} · ${list.length} note${list.length === 1 ? '' : 's'}\nClick or ${hk.toggle || 'hotkey'} to open · drag to move · scroll to switch`;
    $('menuBtn').title = `This app's notes (${hk.appMenu || ''})`;
    $('expandBtn').title = `Open note (${hk.toggle || ''})`;
  }

  function wake() {
    dock.classList.remove('idle');
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => dock.classList.add('idle'), WAKE_MS);
  }

  function slideIn() {
    dock.classList.remove('slide-in');
    void dock.offsetWidth;
    dock.classList.add('slide-in');
  }

  // Click vs. drag: a drag only starts after the pointer moves a few pixels.
  let down = null;
  dock.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    down = { x: e.screenX, y: e.screenY, dragging: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (!down || down.dragging) return;
    if (Math.abs(e.screenX - down.x) > 4) {
      down.dragging = true;
      dock.classList.add('dragging');
      invoke('overlay:drag-start', 'bar');
    }
  });
  window.addEventListener('mouseup', () => {
    if (!down) return;
    const wasDrag = down.dragging;
    down = null;
    dock.classList.remove('dragging');
    if (!wasDrag) invoke('overlay:expand');
  });
  $('menuBtn').addEventListener('click', () => invoke('overlay:open-menu'));
  $('expandBtn').addEventListener('click', () => invoke('overlay:expand'));
  dock.addEventListener('wheel', (e) => {
    const list = stack();
    if (list.length < 2) return;
    const cur = activeNote();
    const i = list.findIndex((n) => cur && n.id === cur.id);
    const next = list[(i + (e.deltaY > 0 ? 1 : -1) + list.length) % list.length];
    const map = { ...(prefs.activeByProcess || {}), [ctx.processKey]: next.id };
    prefs.activeByProcess = map;
    invoke('prefs:set', { activeByProcess: map });
    render();
    wake();
  }, { passive: true });

  async function init() {
    document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = svgIcon(el.dataset.icon); });
    let gotContext = false;
    window.qn.on('bar:context', (c) => {
      gotContext = true;
      ctx = c;
      if (typeof c.idleOpacity === 'number') settings.idleOpacity = c.idleOpacity;
      render();
      if (c.slide) slideIn();
      if (c.wake) wake();
    });
    window.qn.on('notes:changed', (ev) => {
      if (ev.type === 'remove') notes = notes.filter((n) => n.id !== ev.id);
      else {
        const i = notes.findIndex((n) => n.id === ev.note.id);
        if (i >= 0) notes[i] = ev.note; else notes.push(ev.note);
      }
      render();
    });
    window.qn.on('prefs:changed', ({ prefs: p }) => { prefs = p; render(); });
    window.qn.on('settings:changed', ({ settings: s }) => { settings = s; render(); });

    const st = await invoke('state:get');
    notes = st.notes;
    prefs = st.prefs;
    settings = { ...st.settings, idleOpacity: settings.idleOpacity != null ? settings.idleOpacity : st.settings.idleOpacity };
    if (!gotContext) ctx = st.context || ctx;
    render();
  }

  init();
})();
