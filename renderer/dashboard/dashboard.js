// Global notes dashboard (Alt+Shift+A): every note across every app.
(function () {
  const { escapeHtml, TAG_CSS, fmtTime, svgIcon, processKey, sortPinnedRecent } = window.QN;
  const $ = (id) => document.getElementById(id);
  const invoke = (ch, ...a) => window.qn.invoke(ch, ...a);

  const state = {
    myId: null,
    notes: [],
    prefs: {},
    settings: {},
    vault: {},
    icons: {},
    ctx: { hasTarget: false },
    filterApp: '*',        // '*' = all, '' = notes without an app, otherwise a process key
    filterTag: null,
    query: '',
    sort: 'updated',
    selectedId: null,
    preview: false
  };

  let saveTimer = null;
  let lastTyped = 0;

  // ---------- Data helpers ----------
  const byId = (id) => state.notes.find((n) => n.id === id) || null;
  const appLabel = (n) => n.appName || n.process || 'No app';

  function apps() {
    const map = new Map();
    for (const n of state.notes) {
      const key = processKey(n.process);
      const cur = map.get(key) || { key, process: n.process, name: '', count: 0, latest: 0 };
      cur.count++;
      if (n.updatedAt > cur.latest) { cur.latest = n.updatedAt; cur.name = n.appName || n.process; }
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => {
      if (!a.key) return 1;
      if (!b.key) return -1;
      return (a.name || a.key).localeCompare(b.name || b.key);
    });
  }

  function filtered() {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    let list = state.notes.filter((n) => {
      if (state.filterApp !== '*' && processKey(n.process) !== state.filterApp) return false;
      if (state.filterTag && n.tag !== state.filterTag) return false;
      if (!terms.length) return true;
      const hay = `${n.title}\n${n.body}\n${n.process}\n${n.appName}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    switch (state.sort) {
      case 'created': list.sort((a, b) => Date.parse(b.created) - Date.parse(a.created)); break;
      case 'title': list.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
      case 'app': list.sort((a, b) => appLabel(a).localeCompare(appLabel(b)) || b.updatedAt - a.updatedAt); break;
      default: list = sortPinnedRecent(list);
    }
    return list;
  }

  function iconFor(proc) {
    const url = state.icons[processKey(proc)];
    return url ? `<img src="${escapeHtml(url)}" alt="">` : svgIcon(proc ? 'app' : 'grid');
  }

  // ---------- Rendering ----------
  function renderApps() {
    const list = apps();
    const curKey = state.ctx.hasTarget ? state.ctx.processKey : null;
    const row = (key, name, count, ico) => `
      <button class="qd-app${state.filterApp === key ? ' qn-active' : ''}${key && key === curKey ? ' qd-current' : ''}" data-app="${escapeHtml(key)}" title="${escapeHtml(name)}">
        <span class="qd-app-ico">${ico}</span>
        <span class="qd-app-name">${escapeHtml(name)}</span>
        <span class="qd-app-n">${count}</span>
      </button>`;
    $('apps').innerHTML =
      row('*', 'All notes', state.notes.length, svgIcon('stack')) +
      `<div class="qd-apps-label">Applications</div>` +
      list.map((a) => row(a.key, a.key ? a.name || a.key : 'No app', a.count, iconFor(a.process))).join('');

    $('knownApps').innerHTML = list.filter((a) => a.key)
      .map((a) => `<option value="${escapeHtml(a.process)}">${escapeHtml(a.name)}</option>`).join('');
  }

  function renderTagFilter() {
    $('tagFilter').innerHTML = Object.entries(TAG_CSS).map(([name, color]) =>
      `<button class="qd-tag${state.filterTag === name ? ' qn-active' : ''}" data-tag="${name}" style="background:${color}" title="${name}"></button>`
    ).join('');
  }

  function excerpt(n) {
    const lines = (n.body || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const rest = lines.slice(lines[0] && lines[0].replace(/^#+\s*/, '') === n.title ? 1 : 0);
    return rest.join(' ').slice(0, 140);
  }

  function renderList() {
    const list = filtered();
    if (!list.some((n) => n.id === state.selectedId)) state.selectedId = list[0] ? list[0].id : null;
    $('count').textContent = `${list.length} note${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
      $('list').innerHTML = `<li class="qn-empty">${state.notes.length ? 'No matching notes' : 'No notes yet · Ctrl+N to create one'}</li>`;
      renderDetail();
      return;
    }

    let html = '';
    let group = null;
    for (const n of list) {
      if (state.sort === 'app' && appLabel(n) !== group) {
        group = appLabel(n);
        html += `<li class="qd-group">${escapeHtml(group)}</li>`;
      }
      html += `
        <li data-id="${n.id}" class="${n.id === state.selectedId ? 'qn-sel' : ''}">
          <span class="qn-ico">${iconFor(n.process)}</span>
          <div class="qn-body-cell">
            <div class="qn-snip">${n.tag ? `<span class="qd-dot" style="background:${TAG_CSS[n.tag]}"></span>` : ''}${n.pinned ? '📌 ' : ''}${escapeHtml(n.title || 'Untitled')}</div>
            <div class="qd-excerpt">${escapeHtml(excerpt(n)) || '&nbsp;'}</div>
            <div class="qn-meta">${state.sort === 'app' ? '' : escapeHtml(appLabel(n)) + ' · '}${fmtTime(n.updatedAt)}</div>
          </div>
        </li>`;
    }
    $('list').innerHTML = html;
    const sel = $('list').querySelector('.qn-sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    renderDetail();
  }

  function renderDetail(forceBody) {
    const n = byId(state.selectedId);
    const ta0 = $('text');
    if (saveTimer && ta0.dataset.id && (!n || ta0.dataset.id !== n.id)) {
      clearTimeout(saveTimer);
      saveTimer = null;
      invoke('notes:update', ta0.dataset.id, { body: ta0.value }).then((u) => u && upsert(u));
    }
    $('empty').hidden = !!n;
    $('editor').hidden = !n;
    if (!n) return;

    const ta = $('text');
    if ($('text').dataset.id !== n.id || forceBody) {
      ta.value = n.body || '';
      ta.dataset.id = n.id;
      ta.scrollTop = 0;
    }
    if (document.activeElement !== $('title')) $('title').value = n.title || '';
    if (document.activeElement !== $('appInput')) $('appInput').value = n.process || '';
    $('tagDot').style.background = n.tag ? TAG_CSS[n.tag] : 'var(--accent)';
    $('pinBtn').classList.toggle('qn-active', !!n.pinned);
    $('tagBtn').classList.toggle('qn-active', !!n.tag);
    $('previewBtn').classList.toggle('qn-active', state.preview);

    const parts = [
      `created ${new Date(n.created).toLocaleString()}`,
      `updated ${fmtTime(n.updatedAt)}`
    ];
    if (n.fileName && state.vault.configured) parts.push(n.fileName);
    if (n.driveFileId) parts.push('☁ Drive');
    $('meta').textContent = parts.join(' · ');
    $('meta').title = parts.join('\n');

    const vaultOk = !!(state.vault.configured && n.fileName);
    $('revealBtn').disabled = !vaultOk;
    $('obsidianBtn').disabled = !vaultOk;

    ta.hidden = state.preview;
    $('preview').hidden = !state.preview;
    if (state.preview) $('preview').innerHTML = window.QNMarkdown.render(ta.value);
    updateCounter();
  }

  function updateCounter() {
    const v = $('text').value;
    const words = (v.match(/\S+/g) || []).length;
    $('counter').textContent = `${words} word${words === 1 ? '' : 's'} · ${v.length} chars`;
  }

  function renderAll() {
    document.getElementById('wrap').dataset.theme = state.prefs.theme === 'light' ? 'light' : 'dark';
    window.QN.applyCustomColors(state.prefs.customColors);
    renderApps();
    renderTagFilter();
    renderList();
  }

  function setStatus(text, ok) {
    $('status').textContent = text;
    $('status').classList.toggle('qn-ok', !!ok);
  }

  // ---------- Actions ----------
  function select(id, { focusEditor } = {}) {
    if (id !== state.selectedId) flushSave();
    state.selectedId = id;
    $('list').querySelectorAll('li[data-id]').forEach((li) => li.classList.toggle('qn-sel', li.dataset.id === id));
    const sel = $('list').querySelector('.qn-sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    renderDetail();
    if (focusEditor) {
      if (state.preview) { state.preview = false; renderDetail(); }
      $('text').focus();
    }
  }

  function moveSelection(delta) {
    const ids = [...$('list').querySelectorAll('li[data-id]')].map((li) => li.dataset.id);
    if (!ids.length) return;
    const i = ids.indexOf(state.selectedId);
    const next = ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i + delta)))];
    select(next);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    setStatus('saving…');
    saveTimer = setTimeout(flushSave, 300);
  }

  async function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const id = $('text').dataset.id;
    const n = byId(id);
    if (!n || n.body === $('text').value) { setStatus('saved', true); return; }
    const updated = await invoke('notes:update', id, { body: $('text').value });
    if (updated) upsert(updated);
    setStatus('saved', true);
    renderListKeepEditor();
  }

  // Re-render the list without touching the editor contents.
  function renderListKeepEditor() {
    const scroll = $('list').scrollTop;
    renderApps();
    renderList();
    $('list').scrollTop = scroll;
  }

  async function newNote() {
    await flushSave();
    let proc = '';
    let appName = '';
    if (state.filterApp !== '*' && state.filterApp) {
      const a = apps().find((x) => x.key === state.filterApp);
      if (a) { proc = a.process; appName = a.name; }
    } else if (state.filterApp === '*' && state.ctx.hasTarget) {
      proc = state.ctx.process;
      appName = state.ctx.appName;
    }
    const n = await invoke('notes:create', { process: proc, appName, body: '' });
    upsert(n);
    state.query = '';
    $('search').value = '';
    state.filterTag = null;
    state.selectedId = n.id;
    state.preview = false;
    renderAll();
    $('text').focus();
  }

  async function deleteSelected() {
    const n = byId(state.selectedId);
    if (!n) return;
    if (!confirm(`Delete "${n.title || 'Untitled'}"?${state.vault.configured ? '\nThe Markdown file is moved to the Recycle Bin.' : ''}`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const ids = [...$('list').querySelectorAll('li[data-id]')].map((li) => li.dataset.id);
    const i = ids.indexOf(n.id);
    await invoke('notes:remove', n.id);
    state.notes = state.notes.filter((x) => x.id !== n.id);
    state.selectedId = ids[i + 1] || ids[i - 1] || null;
    $('text').dataset.id = '';
    renderAll();
  }

  async function patchSelected(patch) {
    const n = byId(state.selectedId);
    if (!n) return;
    await flushSave();
    const updated = await invoke('notes:update', n.id, patch);
    if (updated) upsert(updated);
    renderListKeepEditor();
  }

  async function commitTitle() {
    const n = byId(state.selectedId);
    if (!n) return;
    const v = $('title').value.trim();
    if (!v) return patchSelected({ titleLocked: false });
    if (v !== n.title) return patchSelected({ title: v, titleLocked: true });
  }

  async function commitApp() {
    const n = byId(state.selectedId);
    if (!n) return;
    const proc = $('appInput').value.trim();
    if (proc === (n.process || '')) return;
    const known = apps().find((a) => a.key === processKey(proc));
    const appName = known ? known.name : proc.replace(/\.exe$/i, '');
    await patchSelected({ process: proc, appName: proc ? appName : '' });
  }

  function openTagMenu() {
    closeTagMenu();
    const n = byId(state.selectedId);
    if (!n) return;
    const menu = document.createElement('div');
    menu.className = 'qn-tag-menu';
    menu.id = 'tagMenu';
    menu.innerHTML =
      `<div class="qn-tag-swatch qn-none${!n.tag ? ' qn-active' : ''}" data-tag="" title="No tag">${svgIcon('x')}</div>` +
      Object.entries(TAG_CSS).map(([name, color]) =>
        `<div class="qn-tag-swatch${n.tag === name ? ' qn-active' : ''}" data-tag="${name}" style="background:${color}" title="${name}"></div>`).join('');
    const r = $('tagBtn').getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-tag]');
      if (!sw) return;
      patchSelected({ tag: sw.dataset.tag || null });
      closeTagMenu();
    });
  }
  function closeTagMenu() {
    const m = $('tagMenu');
    if (m) { m.remove(); return true; }
    return false;
  }

  // ---------- Remote updates ----------
  function upsert(note) {
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = note; else state.notes.push(note);
  }

  function onNotesChanged(ev) {
    if (ev.type === 'remove') {
      state.notes = state.notes.filter((n) => n.id !== ev.id);
      if ($('text').dataset.id === ev.id) $('text').dataset.id = '';
      renderListKeepEditor();
      return;
    }
    upsert(ev.note);
    if (ev.origin === state.myId) return;
    const ta = $('text');
    const editingThis = ta.dataset.id === ev.note.id;
    const canReplace = document.activeElement !== ta || Date.now() - lastTyped > 1500;
    if (editingThis && canReplace && !saveTimer && ta.value !== ev.note.body) {
      const { selectionStart: s, selectionEnd: e, scrollTop } = ta;
      ta.value = ev.note.body;
      ta.setSelectionRange(Math.min(s, ta.value.length), Math.min(e, ta.value.length));
      ta.scrollTop = scrollTop;
      if (state.preview) $('preview').innerHTML = window.QNMarkdown.render(ta.value);
      updateCounter();
    }
    renderListKeepEditor();
  }

  // ---------- Wiring ----------
  function wire() {
    document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = svgIcon(el.dataset.icon); });

    $('search').addEventListener('input', () => { state.query = $('search').value; renderList(); });
    $('sort').addEventListener('change', () => { state.sort = $('sort').value; renderList(); });
    $('tagFilter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      state.filterTag = state.filterTag === b.dataset.tag ? null : b.dataset.tag;
      renderTagFilter();
      renderList();
    });
    $('apps').addEventListener('click', (e) => {
      const b = e.target.closest('[data-app]');
      if (!b) return;
      state.filterApp = b.dataset.app;
      renderApps();
      renderList();
    });

    $('list').tabIndex = 0;
    $('list').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li) select(li.dataset.id);
    });
    $('list').addEventListener('dblclick', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li) select(li.dataset.id, { focusEditor: true });
    });

    $('text').addEventListener('input', () => {
      lastTyped = Date.now();
      updateCounter();
      scheduleSave();
    });
    $('text').addEventListener('blur', flushSave);
    $('title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('text').focus(); }
    });
    $('title').addEventListener('change', commitTitle);
    $('appInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('appInput').blur(); }
    });
    $('appInput').addEventListener('change', commitApp);

    $('newBtn').addEventListener('click', newNote);
    $('settingsBtn').addEventListener('click', () => invoke('window:open-settings'));
    $('minBtn').addEventListener('click', () => invoke('window:minimize'));
    $('closeBtn').addEventListener('click', () => invoke('window:close'));
    $('pinBtn').addEventListener('click', () => { const n = byId(state.selectedId); if (n) patchSelected({ pinned: !n.pinned }); });
    $('tagBtn').addEventListener('click', (e) => { e.stopPropagation(); if (!closeTagMenu()) openTagMenu(); });
    $('previewBtn').addEventListener('click', togglePreview);
    $('revealBtn').addEventListener('click', async () => { await flushSave(); invoke('vault:reveal-note', state.selectedId); });
    $('obsidianBtn').addEventListener('click', async () => { await flushSave(); invoke('vault:open-in-obsidian', state.selectedId); });
    $('exportBtn').addEventListener('click', async () => {
      await flushSave();
      const p = await invoke('note:export-md', state.selectedId);
      if (p) setStatus('exported', true);
    });
    $('deleteBtn').addEventListener('click', deleteSelected);
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#tagMenu') && !e.target.closest('#tagBtn')) closeTagMenu();
    });

    $('preview').addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a) { e.preventDefault(); invoke('external:open', a.getAttribute('href')); }
    });

    document.addEventListener('keydown', onKeydown);
  }

  function togglePreview() {
    state.preview = !state.preview;
    renderDetail();
    if (!state.preview) $('text').focus();
  }

  function onKeydown(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const active = document.activeElement;
    const inEditor = active === $('text') || active === $('title') || active === $('appInput');

    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); return; }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); if (byId(state.selectedId)) togglePreview(); return; }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); return; }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (closeTagMenu()) return;
      if (inEditor) { active.blur(); $('list').focus(); return; }
      if (active === $('search') && $('search').value) { $('search').value = ''; state.query = ''; renderList(); return; }
      flushSave().then(() => invoke('window:close'));
      return;
    }

    if (inEditor) return;
    const navigable = active === $('search') || active === $('list') || active === document.body;
    if (!navigable) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Home' && active !== $('search')) { e.preventDefault(); moveSelection(-1e6); }
    else if (e.key === 'End' && active !== $('search')) { e.preventDefault(); moveSelection(1e6); }
    else if (e.key === 'Enter' && state.selectedId) { e.preventDefault(); select(state.selectedId, { focusEditor: true }); }
    else if (e.key === 'Delete' && active === $('list')) { e.preventDefault(); deleteSelected(); }
  }

  function onFocusRequest({ context, appIcons, noteId }) {
    if (context) state.ctx = context;
    if (appIcons) state.icons = appIcons;
    if (noteId && byId(noteId)) {
      state.filterApp = '*';
      state.filterTag = null;
      state.query = '';
      $('search').value = '';
      state.selectedId = noteId;
      renderAll();
      select(noteId, { focusEditor: true });
      return;
    }
    renderAll();
    $('search').focus();
    $('search').select();
  }

  async function init() {
    wire();
    state.myId = await invoke('app:whoami');
    const st = await invoke('state:get');
    state.notes = st.notes;
    state.prefs = st.prefs;
    state.settings = st.settings;
    state.vault = st.vault || {};
    state.icons = st.appIcons || {};
    state.ctx = st.context || state.ctx;
    renderAll();
    $('search').focus();

    window.qn.on('notes:changed', onNotesChanged);
    window.qn.on('prefs:changed', ({ prefs }) => { state.prefs = prefs; renderAll(); });
    window.qn.on('settings:changed', ({ settings }) => { state.settings = settings; });
    window.qn.on('vault:status', (s) => { state.vault = s; renderDetail(); });
    window.qn.on('icons:changed', (icons) => { state.icons = icons; renderApps(); });
    window.qn.on('dashboard:focus', onFocusRequest);
    window.addEventListener('blur', flushSave);
  }

  init();
})();
