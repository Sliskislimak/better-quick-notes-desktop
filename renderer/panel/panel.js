// Quick Notes Desktop · expanded sticky note.
// Port of the extension's floating panel (content.js). Differences:
//   - notes are stacked per application (`note.process`), not global
//   - storage goes through the main process (window.qn) instead of chrome.storage
//   - the window itself is moved/resized by the main process
//   - the note body is edited without its YAML frontmatter; the main process
//     adds it when writing the .md file

(function () {
  const { svgIcon, escapeHtml, fmtTime, TAG_CSS, sortPinnedRecent, notesForProcess, processKey } = window.QN;
  const $ = (id) => document.getElementById(id);

  const wrap = $('wrap');
  const textarea = $('text');
  const text2 = $('text2');
  const previewEl = $('preview');
  const noteSelect = $('noteSelect');
  const statusEl = $('status');
  const counterEl = $('counter');
  const searchInput = $('searchInput');
  const searchResults = $('searchResults');
  const searchCount = $('searchCount');
  const historyListEl = $('historyList');
  const historyCountEl = $('historyCount');

  let myId = null;
  let currentView = 'editor';
  let previewOn = false;
  let saveTimer = null;
  let p2SaveTimer = null;
  let lastInputAt = 0;
  let lastEditor = textarea;
  let drawerIndex = 0;

  const state = {
    notes: [],
    prefs: {},
    settings: {},
    history: [],
    ctx: { hasTarget: false },
    activeId: null,
    pane2Id: null,
    vault: {},
    drive: {}
  };

  // ---------- Helpers ----------
  const key = () => state.ctx.processKey || processKey(state.ctx.process);
  const appNotes = () => sortPinnedRecent(notesForProcess(state.notes, state.ctx.process));
  const activeNote = () => state.notes.find((n) => n.id === state.activeId) || null;
  const pane2Note = () => state.notes.find((n) => n.id === state.pane2Id) || null;
  const noteTitle = (n) => (n.pinned ? '◆ ' : '') + (n.title || 'Untitled');
  const invoke = (ch, ...args) => window.qn.invoke(ch, ...args);

  function mergeNote(note) {
    if (!note) return;
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = note; else state.notes.push(note);
  }

  function flash(msg) {
    statusEl.textContent = msg;
    statusEl.classList.add('qn-ok');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { statusEl.textContent = 'saved ✓'; }, 1400);
  }

  function setPrefs(patch) {
    Object.assign(state.prefs, patch);
    return invoke('prefs:set', patch);
  }

  function setActive(id) {
    state.activeId = id;
    const map = { ...(state.prefs.activeByProcess || {}), [key()]: id };
    setPrefs({ activeByProcess: map });
  }

  function setPane2(id) {
    state.pane2Id = id;
    const map = { ...(state.prefs.pane2ByProcess || {}), [key()]: id };
    setPrefs({ pane2ByProcess: map });
  }

  function pickActive(preferId) {
    const list = appNotes();
    const has = (id) => id && list.some((n) => n.id === id);
    if (has(preferId)) return preferId;
    const def = (state.settings.appDefaults || {})[key()];
    const stored = (state.prefs.activeByProcess || {})[key()];
    if (has(def) && preferId === undefined) return def;
    if (has(stored)) return stored;
    if (has(def)) return def;
    return list[0] ? list[0].id : null;
  }

  function canReplace(el) {
    return document.activeElement !== el || (!saveTimer && !p2SaveTimer && Date.now() - lastInputAt > 1500);
  }

  function setEditorValue(el, value) {
    if (el.value === value) return;
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = value;
    el.selectionStart = Math.min(s, value.length);
    el.selectionEnd = Math.min(e, value.length);
  }

  // ---------- Appearance ----------
  function fillIcons(rootEl) {
    rootEl.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = svgIcon(el.dataset.icon); });
  }

  function applyAppearance() {
    const p = state.prefs;
    wrap.dataset.theme = p.theme === 'light' ? 'light' : 'dark';
    const shapes = ['rectangle', 'rounded', 'hexagon', 'circle'];
    wrap.dataset.shape = shapes.includes(p.shape) ? p.shape : 'rounded';
    $('themeBtn').innerHTML = svgIcon(wrap.dataset.theme === 'dark' ? 'sun' : 'bat');
    applyOpacity();
    applyFontSize();
    applyZen();
    applySplit();
    window.QN.applyCustomColors(p.customColors);
  }

  function applyOpacity() {
    const op = Math.max(0.3, Math.min(1, typeof state.prefs.opacity === 'number' ? state.prefs.opacity : 1));
    wrap.style.setProperty('--panel-alpha', String(op));
    $('opacitySlider').value = String(Math.round(op * 100));
    $('opacityLabel').textContent = `${Math.round(op * 100)}%`;
  }

  function applyFontSize() {
    const px = Math.max(10, Math.min(28, Number(state.prefs.fontSize) || 13));
    textarea.style.fontSize = px + 'px';
    text2.style.fontSize = px + 'px';
    previewEl.style.fontSize = px + 'px';
    $('zoomLabel').textContent = px + 'px';
  }

  function applyZen() {
    wrap.classList.toggle('qn-zen', !!state.prefs.zen);
    $('zenBtn').classList.toggle('qn-active', !!state.prefs.zen);
  }

  function applySplit() {
    const pane2 = $('pane2');
    const splitter = $('splitter');
    const p1 = $('pane1');
    if (state.prefs.split) {
      wrap.dataset.split = 'on';
      wrap.dataset.splitDir = state.prefs.splitDir === 'v' ? 'v' : 'h';
      pane2.hidden = false;
      splitter.hidden = false;
      const r = Math.max(0.15, Math.min(0.85, state.prefs.paneRatio || 0.5));
      p1.style.flex = `${r} 1 0`;
      pane2.style.flex = `${1 - r} 1 0`;
      $('splitBtn').classList.add('qn-active');
    } else {
      wrap.removeAttribute('data-split');
      wrap.removeAttribute('data-split-dir');
      pane2.hidden = true;
      splitter.hidden = true;
      p1.style.flex = '1 1 0';
      $('splitBtn').classList.remove('qn-active');
    }
  }

  // Header/toolbar compaction, same rules as the extension: measure overflow
  // instead of using fixed breakpoints.
  function observePanelSize() {
    const head = $('head');
    const bar = $('toolbar');
    let updating = false;
    const update = () => {
      if (updating) return;
      updating = true;
      wrap.classList.remove('qn-compact');
      if (head.scrollWidth > head.clientWidth + 1) wrap.classList.add('qn-compact');
      bar.classList.remove('qn-bar-compact', 'qn-bar-extra-compact');
      const btn = bar.querySelector('.qn-btn');
      const rowH = btn ? btn.offsetHeight : 24;
      if (bar.offsetHeight > rowH * 2 + 8) {
        bar.classList.add('qn-bar-compact');
        if (bar.offsetHeight > rowH * 2 + 8) bar.classList.add('qn-bar-extra-compact');
      }
      updating = false;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    ro.observe(head);
    ro.observe(bar);
  }

  // ---------- Rendering ----------
  function fillSelect(sel, selectedId) {
    const all = appNotes();
    const sig = all.map((n) => `${n.id}:${n.pinned ? 1 : 0}`).join(',');
    if (sel._qnSig === sig && sel.options.length === all.length) {
      all.forEach((n, i) => {
        const opt = sel.options[i];
        const t = noteTitle(n);
        if (opt.textContent !== t) opt.textContent = t;
        const should = n.id === selectedId;
        if (opt.selected !== should) opt.selected = should;
      });
      return;
    }
    sel._qnSig = sig;
    sel.innerHTML = '';
    all.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = noteTitle(n);
      if (n.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function renderSelector() { fillSelect(noteSelect, state.activeId); }
  function renderPane1Selector() { fillSelect($('pane1Select'), state.activeId); }
  function renderPane2Selector() {
    const all = appNotes();
    if (!state.pane2Id || !all.some((n) => n.id === state.pane2Id)) {
      const stored = (state.prefs.pane2ByProcess || {})[key()];
      const cand = all.find((n) => n.id === stored) || all.find((n) => n.id !== state.activeId) || all[0];
      state.pane2Id = cand ? cand.id : null;
    }
    fillSelect($('pane2Select'), state.pane2Id);
  }

  function renderTabs() {
    const strip = $('tabStrip');
    const all = appNotes();
    strip.innerHTML = '';
    all.forEach((n) => {
      const b = document.createElement('button');
      b.className = 'qn-tab' + (n.id === state.activeId ? ' qn-active' : '');
      b.title = n.title || 'Untitled';
      if (n.tag && TAG_CSS[n.tag]) {
        const dot = document.createElement('span');
        dot.className = 'qn-tag-dot';
        dot.style.background = TAG_CSS[n.tag];
        b.appendChild(dot);
      } else if (n.pinned) {
        const pin = document.createElement('span');
        pin.textContent = '◆';
        pin.style.fontSize = '8px';
        pin.style.color = 'var(--accent)';
        b.appendChild(pin);
      }
      const t = document.createElement('span');
      t.className = 'qn-tab-title';
      t.textContent = n.title || 'Untitled';
      b.appendChild(t);
      b.addEventListener('click', () => switchToNote(n.id));
      b.addEventListener('dblclick', () => { if (n.id === state.activeId) startInlineRename(); });
      strip.appendChild(b);
    });
    const add = document.createElement('button');
    add.className = 'qn-tab qn-tab-add';
    add.title = 'New note for this app (Ctrl+N)';
    add.innerHTML = svgIcon('plus');
    add.addEventListener('click', newNote);
    strip.appendChild(add);
    const active = strip.querySelector('.qn-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderAppChip() {
    const c = state.ctx;
    $('appName').textContent = c.appName || c.process || 'App';
    $('appChip').title = `${c.windowTitle || ''}\n${c.process || ''}`.trim();
    const ico = $('appIcon');
    if (c.icon) ico.innerHTML = `<img src="${escapeHtml(c.icon)}" alt="">`;
    else ico.innerHTML = svgIcon('app');
  }

  function renderAll() {
    renderSelector();
    renderPane1Selector();
    renderPane2Selector();
    renderTabs();
    renderAppChip();
    updatePinButton();
    updateDefaultButton();
    updateTagUI();
    if (isDrawerOpen()) renderDrawer();
  }

  function loadActiveIntoEditor(force) {
    const n = activeNote();
    if (!n) { textarea.value = ''; updateCounter(); return; }
    if (force || document.activeElement !== textarea) textarea.value = n.body || '';
    updateCounter();
    if (previewOn) renderPreview();
  }

  function loadPane2IntoEditor(force) {
    const n = pane2Note();
    if (n && (force || document.activeElement !== text2)) text2.value = n.body || '';
  }

  function updateCounter() {
    const t = textarea.value;
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    counterEl.textContent = `${words} words · ${t.length} chars`;
  }

  function renderSyncState() {
    const el = $('syncState');
    const parts = [];
    const tips = [];
    let err = false;
    if (state.vault.configured) {
      parts.push(svgIcon('folder'));
      tips.push(state.vault.lastError ? `Vault: ${state.vault.lastError}` : `Vault: ${state.vault.path}`);
      if (state.vault.lastError) err = true;
    }
    if (state.drive.enabled && state.drive.signedIn) {
      parts.push(svgIcon('cloud'));
      tips.push(state.drive.lastError ? `Drive: ${state.drive.lastError}` : `Drive: ${state.drive.email || 'connected'}`);
      if (state.drive.lastError) err = true;
    }
    el.innerHTML = parts.join('');
    el.title = tips.join('\n');
    el.classList.toggle('qn-err', err);
  }

  function renderPreview() {
    previewEl.innerHTML = window.QNMarkdown.render(textarea.value);
  }

  function updatePinButton() {
    const n = activeNote();
    const btn = $('pinNote');
    btn.classList.toggle('qn-active', !!(n && n.pinned));
    btn.title = n && n.pinned ? 'Unpin note' : 'Pin note to top of the stack';
  }

  function updateTagUI() {
    const n = activeNote();
    const color = (n && n.tag && TAG_CSS[n.tag]) || null;
    const btn = $('tagBtn');
    btn.style.color = color || '';
    btn.classList.toggle('qn-active', !!color);
    const dot = document.querySelector('.qn-head .qn-brand-dot');
    dot.style.background = color || 'var(--accent)';
    dot.style.boxShadow = color ? `0 0 8px ${color}55` : '0 0 8px var(--accent-soft)';
  }

  function isAppDefault() {
    return (state.settings.appDefaults || {})[key()] === state.activeId;
  }

  function updateDefaultButton() {
    const btn = $('defaultBtn');
    btn.classList.toggle('qn-active', isAppDefault());
    btn.title = isAppDefault()
      ? `This note opens first for ${state.ctx.appName || state.ctx.process} (click to remove)`
      : `Open this note first for ${state.ctx.appName || state.ctx.process || 'this app'}`;
  }

  // ---------- Saving ----------
  function scheduleSave() {
    clearTimeout(saveTimer);
    statusEl.textContent = 'saving…';
    statusEl.classList.remove('qn-ok');
    saveTimer = setTimeout(save, 200);
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const n = activeNote();
    if (!n) return;
    if (n.body !== textarea.value) {
      n.body = textarea.value;
      const updated = await invoke('notes:update', n.id, { body: n.body });
      if (updated) mergeNote({ ...updated, body: textarea.value });
      if (state.pane2Id === n.id && canReplace(text2)) loadPane2IntoEditor(true);
      renderSelector();
      renderPane1Selector();
      renderPane2Selector();
      renderTabs();
    }
    statusEl.textContent = 'saved ✓';
    statusEl.classList.add('qn-ok');
  }

  async function savePane2() {
    clearTimeout(p2SaveTimer);
    p2SaveTimer = null;
    const n = pane2Note();
    if (!n || n.body === text2.value) return;
    n.body = text2.value;
    const updated = await invoke('notes:update', n.id, { body: n.body });
    if (updated) mergeNote({ ...updated, body: text2.value });
    if (state.activeId === n.id && canReplace(textarea)) loadActiveIntoEditor(true);
    renderSelector();
    renderPane1Selector();
    renderPane2Selector();
    renderTabs();
  }

  async function flushSaves() {
    if (saveTimer) await save();
    if (p2SaveTimer) await savePane2();
  }

  // ---------- Note operations ----------
  async function switchToNote(id) {
    if (!id || id === state.activeId) return;
    await flushSaves();
    setActive(id);
    renderAll();
    loadActiveIntoEditor(true);
    switchView('editor');
  }

  async function newNote() {
    await flushSaves();
    const note = await invoke('notes:create', { process: state.ctx.process, appName: state.ctx.appName });
    mergeNote(note);
    setActive(note.id);
    renderAll();
    loadActiveIntoEditor(true);
    closeDrawer();
    switchView('editor');
    textarea.focus();
    flash('new note');
  }

  async function deleteNote(id) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    const list = appNotes();
    if (list.length === 1) {
      if (!confirm('Clear this note?')) return;
      n.body = '';
      const updated = await invoke('notes:update', n.id, { body: '', titleLocked: false });
      mergeNote(updated);
      loadActiveIntoEditor(true);
      renderAll();
      flash('cleared');
      return;
    }
    if (!confirm(`Delete "${n.title || 'Untitled'}"?`)) return;
    await invoke('notes:remove', id);
    state.notes = state.notes.filter((x) => x.id !== id);
    if (state.activeId === id) setActive(pickActive(null));
    if (state.pane2Id === id) state.pane2Id = null;
    renderAll();
    loadActiveIntoEditor(true);
    loadPane2IntoEditor(true);
    flash('deleted');
  }

  // ---------- Text editing ----------
  function insertAtCursor(text, el = lastEditor) {
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Wraps the selection in markers, or removes them when already wrapped.
  function wrapSelection(before, after, el = lastEditor) {
    const v = el.value;
    const s = el.selectionStart, e = el.selectionEnd;
    const selected = v.slice(s, e);
    if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
      const inner = selected.slice(before.length, selected.length - after.length);
      el.value = v.slice(0, s) + inner + v.slice(e);
      el.selectionStart = s;
      el.selectionEnd = s + inner.length;
    } else if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      el.value = v.slice(0, s - before.length) + selected + v.slice(e + after.length);
      el.selectionStart = s - before.length;
      el.selectionEnd = e - before.length;
    } else {
      const inserted = before + selected + after;
      el.value = v.slice(0, s) + inserted + v.slice(e);
      if (selected) {
        el.selectionStart = s;
        el.selectionEnd = s + inserted.length;
      } else {
        el.selectionStart = el.selectionEnd = s + before.length;
      }
    }
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Toggles a "- " bullet on every line touched by the selection.
  function toggleBulletList(el = lastEditor) {
    const v = el.value;
    const start = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    let end = v.indexOf('\n', el.selectionEnd - (el.selectionEnd > el.selectionStart && v[el.selectionEnd - 1] === '\n' ? 1 : 0));
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n');
    const bullet = /^(\s*)[-*+] (?!\[[ xX]\] )/;
    const filled = lines.filter((l) => l.trim());
    const allBulleted = filled.length > 0 && filled.every((l) => bullet.test(l));
    const out = lines.map((l) => {
      if (allBulleted) return l.replace(bullet, '$1');
      if (!l.trim() && lines.length > 1) return l;
      return bullet.test(l) ? l : l.replace(/^(\s*)/, '$1- ');
    }).join('\n');
    el.value = v.slice(0, start) + out + v.slice(end);
    el.selectionStart = start;
    el.selectionEnd = start + out.length;
    if (lines.length === 1) el.selectionStart = el.selectionEnd = start + out.length;
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertTable(rows, cols) {
    const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |';
    const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
    const body = Array.from({ length: rows }, () => '| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |').join('\n');
    const s = lastEditor.selectionStart;
    const before = lastEditor.value[s - 1];
    const prefix = (s === 0 || before === '\n') ? '' : '\n';
    insertAtCursor(prefix + `${header}\n${sep}\n${body}` + '\n');
    flash(`table ${rows}×${cols}`);
  }

  function dismissOnOutsideClick(menu) {
    setTimeout(() => {
      const dismiss = (ev) => {
        if (!ev.composedPath().includes(menu)) {
          menu.remove();
          document.removeEventListener('click', dismiss);
        }
      };
      document.addEventListener('click', dismiss);
    }, 0);
  }

  function placeMenu(menu, anchorBtn) {
    const rect = anchorBtn.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    menu.style.top = (rect.bottom - wrapRect.top + 4) + 'px';
    menu.style.left = Math.max(4, Math.min(wrapRect.width - 180, rect.left - wrapRect.left)) + 'px';
    $('paper').appendChild(menu);
  }

  function openTablePicker(anchorBtn) {
    const MAX_R = 8, MAX_C = 8;
    const picker = document.createElement('div');
    picker.className = 'qn-tbl-picker';
    const label = document.createElement('div');
    label.className = 'qn-tbl-picker-label';
    label.textContent = '0 × 0';
    const grid = document.createElement('div');
    grid.className = 'qn-tbl-picker-grid';
    grid.style.gridTemplateColumns = `repeat(${MAX_C}, 1fr)`;
    let hoverR = 0, hoverC = 0;
    const cells = [];
    const updateHighlight = () => {
      label.textContent = `${hoverR} × ${hoverC}`;
      cells.forEach((c) => c.classList.toggle('qn-active', +c.dataset.r < hoverR && +c.dataset.c < hoverC));
    };
    for (let r = 0; r < MAX_R; r++) {
      for (let c = 0; c < MAX_C; c++) {
        const cell = document.createElement('div');
        cell.className = 'qn-tbl-picker-cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.addEventListener('mouseenter', () => { hoverR = r + 1; hoverC = c + 1; updateHighlight(); });
        cell.addEventListener('click', () => { picker.remove(); insertTable(hoverR, hoverC); });
        grid.appendChild(cell);
        cells.push(cell);
      }
    }
    picker.appendChild(label);
    picker.appendChild(grid);
    placeMenu(picker, anchorBtn);
    dismissOnOutsideClick(picker);
  }

  // ---------- Views ----------
  function switchView(name) {
    currentView = name;
    $('editorView').hidden = name !== 'editor';
    $('searchView').hidden = name !== 'search';
    $('historyView').hidden = name !== 'history';
    if (name === 'editor' && !isDrawerOpen()) textarea.focus();
    if (name === 'search') { setTimeout(() => searchInput.focus(), 30); runSearch(); }
    if (name === 'history') renderHistory();
  }

  function highlightMatch(text, q) {
    const safe = escapeHtml(text);
    if (!q) return safe;
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(esc, 'gi'), (m) => `<span class="qn-hl">${m}</span>`);
  }

  function historyIcon(source) {
    return ({ clipboard: 'clipboard', app: 'app', selection: 'copy' })[source] || 'check';
  }

  function runSearch() {
    const q = searchInput.value.trim();
    const scope = $('searchScope').value;
    searchResults.innerHTML = '';
    if (!q) { searchCount.textContent = 'type to search'; return; }
    const lower = q.toLowerCase();
    const results = [];
    if (scope !== 'history') {
      const pool = scope === 'app' ? appNotes() : state.notes;
      pool.forEach((n) => {
        const body = n.body || '';
        const inTitle = (n.title || '').toLowerCase().includes(lower);
        const inBody = body.toLowerCase().includes(lower);
        const inApp = (n.process || '').toLowerCase().includes(lower) || (n.appName || '').toLowerCase().includes(lower);
        if (!inTitle && !inBody && !(scope !== 'app' && inApp)) return;
        let snippet = n.title;
        if (inBody) {
          const idx = body.toLowerCase().indexOf(lower);
          const start = Math.max(0, idx - 30);
          const end = Math.min(body.length, idx + q.length + 70);
          snippet = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
        }
        results.push({ type: 'note', note: n, snippet, ts: n.updatedAt });
      });
    }
    if (scope === 'all' || scope === 'history') {
      state.history.forEach((h) => {
        if (h.full.toLowerCase().includes(lower)) results.push({ type: 'history', h, ts: h.ts });
      });
    }
    results.sort((a, b) => (a.type !== b.type ? (a.type === 'note' ? -1 : 1) : b.ts - a.ts));
    searchCount.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}`;

    results.forEach((r) => {
      const li = document.createElement('li');
      const ico = document.createElement('div');
      ico.className = 'qn-ico';
      ico.innerHTML = r.type === 'note' ? svgIcon(r.note.pinned ? 'pin' : 'check') : svgIcon(historyIcon(r.h.source));
      const body = document.createElement('div');
      body.className = 'qn-body-cell';
      const snip = document.createElement('div');
      snip.className = 'qn-snip';
      snip.innerHTML = highlightMatch(r.type === 'note' ? r.snippet : r.h.preview, q);
      const meta = document.createElement('div');
      meta.className = 'qn-meta';
      meta.textContent = r.type === 'note'
        ? `note · ${r.note.title} · ${r.note.appName || r.note.process || 'no app'} · ${fmtTime(r.ts)}`
        : `${(r.h.source || '').replace(/-/g, ' ')} · ${fmtTime(r.ts)}${r.h.title ? ' · ' + r.h.title.slice(0, 30) : ''}`;
      body.appendChild(snip);
      body.appendChild(meta);
      li.appendChild(ico);
      li.appendChild(body);
      li.addEventListener('click', async () => {
        if (r.type === 'note') {
          if (processKey(r.note.process) === key()) {
            await switchToNote(r.note.id);
            switchView('editor');
          } else {
            invoke('window:open-dashboard', { noteId: r.note.id });
          }
        } else {
          switchView('editor');
          insertAtCursor(r.h.full, textarea);
          flash('inserted from history');
        }
      });
      searchResults.appendChild(li);
    });
  }

  function renderHistory() {
    historyCountEl.textContent = `${state.history.length} entries`;
    if (!state.history.length) {
      historyListEl.innerHTML = '<li class="qn-empty">No history yet. Your captures will appear here.</li>';
      return;
    }
    historyListEl.innerHTML = '';
    state.history.forEach((entry) => {
      const li = document.createElement('li');
      const ico = document.createElement('div');
      ico.className = 'qn-ico';
      ico.innerHTML = svgIcon(historyIcon(entry.source));
      const body = document.createElement('div');
      body.className = 'qn-body-cell';
      const snip = document.createElement('div');
      snip.className = 'qn-snip';
      snip.textContent = entry.preview;
      const meta = document.createElement('div');
      meta.className = 'qn-meta';
      meta.textContent = `${(entry.source || '').replace(/-/g, ' ')} · ${fmtTime(entry.ts)}${entry.title ? ' · ' + entry.title.slice(0, 30) : ''}`;
      body.appendChild(snip);
      body.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'qn-del';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.history = state.history.filter((h) => h.id !== entry.id);
        invoke('history:remove', entry.id);
        renderHistory();
      });
      li.appendChild(ico);
      li.appendChild(body);
      li.appendChild(del);
      li.addEventListener('click', () => {
        switchView('editor');
        insertAtCursor(entry.full, textarea);
        flash('inserted from history');
      });
      historyListEl.appendChild(li);
    });
  }

  function logHistory(source, full) {
    if (!full) return;
    invoke('history:add', { source, full, noteId: state.activeId, title: state.ctx.windowTitle || '' });
  }

  // ---------- App notes drawer (Alt+Shift+W) ----------
  const isDrawerOpen = () => !$('drawer').hidden;

  function drawerItems() {
    return [...appNotes().map((n) => ({ type: 'note', note: n })), { type: 'new' }];
  }

  function renderDrawer() {
    const items = drawerItems();
    drawerIndex = Math.max(0, Math.min(items.length - 1, drawerIndex));
    const c = state.ctx;
    $('drawerTitle').innerHTML = `${c.icon ? `<img src="${escapeHtml(c.icon)}" alt="">` : ''}<span>${escapeHtml(c.appName || c.process || 'App')} · ${items.length - 1} note${items.length === 2 ? '' : 's'}</span>`;
    const list = $('drawerList');
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      if (i === drawerIndex) li.classList.add('qn-sel');
      const ico = document.createElement('div');
      ico.className = 'qn-ico';
      const body = document.createElement('div');
      body.className = 'qn-body-cell';
      const snip = document.createElement('div');
      snip.className = 'qn-snip';
      const meta = document.createElement('div');
      meta.className = 'qn-meta';
      if (it.type === 'note') {
        const n = it.note;
        if (n.tag && TAG_CSS[n.tag]) ico.innerHTML = `<span class="qn-tag-dot" style="background:${TAG_CSS[n.tag]}"></span>`;
        else ico.innerHTML = svgIcon(n.pinned ? 'pin' : 'check');
        snip.textContent = n.title || 'Untitled';
        snip.style.fontFamily = 'inherit';
        snip.style.fontWeight = n.id === state.activeId ? '600' : '400';
        const firstBody = (n.body || '').split('\n').map((l) => l.trim()).filter(Boolean)[1] || '';
        meta.textContent = `${i < 9 ? `${i + 1} · ` : ''}${fmtTime(n.updatedAt)}${firstBody ? ' · ' + firstBody.slice(0, 60) : ''}`;
      } else {
        li.classList.add('qn-new-row');
        ico.innerHTML = svgIcon('plus');
        snip.textContent = 'New note for this app';
        meta.textContent = 'Ctrl+N';
      }
      body.appendChild(snip);
      body.appendChild(meta);
      li.appendChild(ico);
      li.appendChild(body);
      li.addEventListener('mouseenter', () => { drawerIndex = i; markDrawerSel(); });
      li.addEventListener('click', () => activateDrawerItem(i));
      list.appendChild(li);
    });
  }

  function markDrawerSel() {
    const lis = $('drawerList').children;
    for (let i = 0; i < lis.length; i++) lis[i].classList.toggle('qn-sel', i === drawerIndex);
    if (lis[drawerIndex]) lis[drawerIndex].scrollIntoView({ block: 'nearest' });
  }

  function openDrawer() {
    if (currentView !== 'editor') switchView('editor');
    const items = drawerItems();
    drawerIndex = Math.max(0, items.findIndex((it) => it.note && it.note.id === state.activeId));
    $('drawer').hidden = false;
    $('drawerScrim').hidden = false;
    renderDrawer();
    requestAnimationFrame(() => $('editorView').classList.add('qn-drawer-open'));
    $('drawer').tabIndex = -1;
    $('drawer').focus();
  }

  function closeDrawer(focusEditor) {
    if (!isDrawerOpen()) return;
    $('editorView').classList.remove('qn-drawer-open');
    $('drawer').hidden = true;
    $('drawerScrim').hidden = true;
    if (focusEditor) textarea.focus();
  }

  async function activateDrawerItem(i) {
    const it = drawerItems()[i];
    if (!it) return;
    if (it.type === 'new') { await newNote(); return; }
    await switchToNote(it.note.id);
    closeDrawer(true);
  }

  function onDrawerKey(e) {
    const items = drawerItems();
    if (e.key === 'ArrowDown') { drawerIndex = (drawerIndex + 1) % items.length; markDrawerSel(); }
    else if (e.key === 'ArrowUp') { drawerIndex = (drawerIndex - 1 + items.length) % items.length; markDrawerSel(); }
    else if (e.key === 'Home') { drawerIndex = 0; markDrawerSel(); }
    else if (e.key === 'End') { drawerIndex = items.length - 1; markDrawerSel(); }
    else if (e.key === 'Enter') activateDrawerItem(drawerIndex);
    else if (e.key === 'Escape') closeDrawer(true);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') newNote();
    else if (e.key === 'Delete' && items[drawerIndex] && items[drawerIndex].note) {
      deleteNote(items[drawerIndex].note.id).then(() => renderDrawer());
    } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) activateDrawerItem(Number(e.key) - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------- Inline rename ----------
  function startInlineRename() {
    const n = activeNote();
    if (!n) return;
    const existing = $('renameInput');
    if (existing) { existing.focus(); existing.select(); return; }
    const current = n.title || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'renameInput';
    input.className = 'qn-rename-input';
    input.value = current;
    input.maxLength = 80;
    input.title = 'Enter to save · Esc to cancel · empty = auto-derive';
    noteSelect.style.display = 'none';
    noteSelect.parentNode.insertBefore(input, noteSelect);
    let committed = false;
    async function commit(doSave) {
      if (committed) return;
      committed = true;
      input.remove();
      noteSelect.style.display = '';
      if (!doSave) return;
      const t = (input.value || '').trim().slice(0, 80);
      if (t === current) return;
      const updated = await invoke('notes:update', n.id, t ? { title: t, titleLocked: true } : { titleLocked: false });
      mergeNote(updated);
      renderAll();
      flash(t ? 'renamed ✓' : 'title unlocked');
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); textarea.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); textarea.focus(); }
    });
    input.addEventListener('blur', () => commit(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // ---------- Images ----------
  async function insertImageFile(file, el) {
    if (!file || !file.type || !file.type.startsWith('image/')) return false;
    const MAX_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BYTES) { flash(`image too big (${Math.round(file.size / 1048576)}MB, max 10MB)`); return true; }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const rel = await invoke('assets:save-image', buf, file.type);
      const md = `![${file.type === 'image/gif' ? 'gif' : 'image'}](${rel})`;
      const s = el.selectionStart, e2 = el.selectionEnd;
      const before = el.value[s - 1];
      const prefix = (s === 0 || before === '\n') ? '' : '\n';
      el.value = el.value.slice(0, s) + prefix + md + '\n' + el.value.slice(e2);
      el.selectionStart = el.selectionEnd = s + prefix.length + md.length + 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      flash(file.type === 'image/gif' ? 'gif added' : 'image added');
    } catch {
      flash('image paste failed');
    }
    return true;
  }

  async function handleImagePaste(ev, el) {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        ev.preventDefault();
        await insertImageFile(file, el);
        return;
      }
    }
  }

  function wireDropHandlers(el) {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file');
    el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; el.classList.add('qn-drag-over'); } });
    el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('qn-drag-over'); });
    el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      el.classList.remove('qn-drag-over');
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const file of e.dataTransfer.files) {
        if (file.type && file.type.startsWith('image/')) await insertImageFile(file, el);
      }
    });
  }

  // ---------- Keyboard ----------
  // Local editor shortcuts. Global hotkeys (Alt+Shift+Q/W/A) are registered
  // system-wide by the main process and work here too.
  function onEditorKeydown(e) {
    const el = e.currentTarget;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl || e.altKey) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (!e.shiftKey && k === 'b') wrapSelection('**', '**', el);
    else if (!e.shiftKey && k === 'i') wrapSelection('*', '*', el);
    else if (!e.shiftKey && k === 'u') wrapSelection('<u>', '</u>', el);
    else if (e.shiftKey && k === 'x') wrapSelection('~~', '~~', el);
    else if (e.shiftKey && k === 'l') toggleBulletList(el);
    else handled = false;
    if (handled) e.preventDefault();
  }

  function onDocumentKeydown(e) {
    if (isDrawerOpen()) { onDrawerKey(e); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.altKey && e.shiftKey && k === 'r') { e.preventDefault(); invoke('overlay:recenter'); flash('recentered ✓'); return; }
    if (e.altKey && e.shiftKey && k === 's') { e.preventDefault(); toggleSplit(); return; }
    if (ctrl && !e.shiftKey && k === 's') { e.preventDefault(); flushSaves().then(() => flash('saved ✓')); return; }
    if (ctrl && !e.shiftKey && k === 'f') { e.preventDefault(); switchView('search'); return; }
    if (ctrl && !e.shiftKey && k === 'n') { e.preventDefault(); newNote(); return; }
    if (ctrl && !e.shiftKey && k === 'e') { e.preventDefault(); togglePreview(); return; }
    if (ctrl && e.key === 'Tab') {
      e.preventDefault();
      const list = appNotes();
      const i = list.findIndex((n) => n.id === state.activeId);
      const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      if (next) switchToNote(next.id);
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); startInlineRename(); return; }
    if (e.key === 'Escape') {
      if (document.querySelector('.qn-tag-menu, .qn-color-menu, .qn-tbl-picker')) {
        document.querySelectorAll('.qn-tag-menu, .qn-color-menu, .qn-tbl-picker').forEach((m) => m.remove());
      } else if (state.prefs.zen) toggleZen();
      else if (currentView !== 'editor') switchView('editor');
      else { flushSaves().then(() => invoke('overlay:collapse')); }
      e.preventDefault();
    }
    if (e.key === 'Alt') wrap.classList.add('qn-alt-held');
  }

  // ---------- Toggles ----------
  function togglePreview() {
    previewOn = !previewOn;
    $('previewBtn').classList.toggle('qn-active', previewOn);
    wrap.classList.toggle('qn-preview-on', previewOn);
    textarea.hidden = previewOn;
    previewEl.hidden = !previewOn;
    if (previewOn) renderPreview();
    else textarea.focus();
  }

  function toggleSplit() {
    setPrefs({ split: !state.prefs.split });
    applySplit();
    if (state.prefs.split) { renderPane1Selector(); renderPane2Selector(); loadPane2IntoEditor(true); }
    flash(state.prefs.split ? 'split on' : 'split off');
  }

  function toggleZen() {
    setPrefs({ zen: !state.prefs.zen });
    applyZen();
    flash(state.prefs.zen ? 'zen mode' : 'back to normal');
    textarea.focus();
  }

  // ---------- Events ----------
  function wireEvents() {
    const head = $('head');
    const startMove = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      head.classList.add('dragging');
      invoke('overlay:drag-start', 'move');
      const up = () => { head.classList.remove('dragging'); window.removeEventListener('mouseup', up); };
      window.addEventListener('mouseup', up);
    };
    head.addEventListener('mousedown', (e) => { if (!e.target.closest('button, select, input')) startMove(e); });
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select, input')) return;
      invoke('overlay:recenter');
      flash('recentered ✓');
    });
    $('tabs').addEventListener('mousedown', (e) => { if (!e.target.closest('button')) startMove(e); });
    $('zenDragStrip').addEventListener('mousedown', startMove);
    wrap.addEventListener('mousedown', (e) => {
      if (e.altKey && !e.target.closest('button, select, input, textarea')) startMove(e);
    });
    document.querySelectorAll('.qn-rz').forEach((h) => {
      h.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        invoke('overlay:drag-start', 'resize', h.dataset.dir);
      });
    });

    document.addEventListener('keydown', onDocumentKeydown, true);
    document.addEventListener('keyup', (e) => { if (e.key === 'Alt') wrap.classList.remove('qn-alt-held'); });
    window.addEventListener('blur', () => wrap.classList.remove('qn-alt-held'));

    $('closeBtn').addEventListener('click', () => flushSaves().then(() => invoke('overlay:collapse')));

    noteSelect.addEventListener('change', () => switchToNote(noteSelect.value));
    $('newNote').addEventListener('click', newNote);
    $('delNote').addEventListener('click', () => deleteNote(state.activeId));
    $('pinNote').addEventListener('click', async () => {
      const n = activeNote();
      if (!n) return;
      const updated = await invoke('notes:update', n.id, { pinned: !n.pinned });
      mergeNote(updated);
      renderAll();
      flash(updated.pinned ? 'pinned' : 'unpinned');
    });

    for (const el of [textarea, text2]) {
      el.addEventListener('focus', () => { lastEditor = el; });
      el.addEventListener('keydown', onEditorKeydown);
      el.addEventListener('paste', (ev) => handleImagePaste(ev, el));
      wireDropHandlers(el);
    }
    textarea.addEventListener('input', () => { lastInputAt = Date.now(); updateCounter(); scheduleSave(); });
    text2.addEventListener('input', () => {
      lastInputAt = Date.now();
      clearTimeout(p2SaveTimer);
      p2SaveTimer = setTimeout(savePane2, 200);
    });

    $('pasteBtn').addEventListener('click', async () => {
      const t = await invoke('clipboard:read-text');
      if (t) { insertAtCursor(t); logHistory('clipboard', t); flash('pasted ✓'); }
      else flash('clipboard empty');
    });
    $('copyBtn').addEventListener('click', async () => {
      await invoke('clipboard:write-text', lastEditor.value);
      flash('copied ✓');
    });
    $('urlBtn').addEventListener('click', () => {
      const c = state.ctx;
      const text = `${c.appName || c.process}${c.windowTitle && c.windowTitle !== c.appName ? ' — ' + c.windowTitle : ''}\n`;
      insertAtCursor(text);
      logHistory('app', text);
      flash('app info added ✓');
    });
    $('timeBtn').addEventListener('click', () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const offMin = -now.getTimezoneOffset();
      const sign = offMin >= 0 ? '+' : '-';
      const abs = Math.abs(offMin);
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} GMT${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} (${tz})] `;
      insertAtCursor(stamp);
      flash('time added');
    });
    $('divBtn').addEventListener('click', () => { insertAtCursor('\n━━━━━━━━━━\n'); flash('divider'); });
    $('taskBtn').addEventListener('click', () => {
      const s = lastEditor.selectionStart;
      const before = lastEditor.value[s - 1];
      insertAtCursor(((s === 0 || before === '\n') ? '' : '\n') + '- [ ] ');
      flash('task added');
    });
    $('tableBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.qn-tbl-picker');
      if (existing) { existing.remove(); return; }
      openTablePicker(e.currentTarget);
    });
    $('boldBtn').addEventListener('click', () => { wrapSelection('**', '**'); flash('bold'); });
    $('italicBtn').addEventListener('click', () => { wrapSelection('*', '*'); flash('italic'); });
    $('underlineBtn').addEventListener('click', () => { wrapSelection('<u>', '</u>'); flash('underline'); });
    $('strikeBtn').addEventListener('click', () => { wrapSelection('~~', '~~'); flash('strikethrough'); });
    $('bulletBtn').addEventListener('click', () => { toggleBulletList(); flash('bullet list'); });
    $('codeBtn').addEventListener('click', () => {
      const el = lastEditor;
      const s = el.selectionStart, e = el.selectionEnd;
      const selected = el.value.slice(s, e);
      const before = el.value[s - 1];
      const leadNl = (s === 0 || before === '\n') ? '' : '\n';
      if (selected.includes('\n')) {
        const inserted = `${leadNl}\`\`\`\n${selected}\n\`\`\`\n`;
        el.value = el.value.slice(0, s) + inserted + el.value.slice(e);
        el.selectionStart = el.selectionEnd = s + inserted.length;
      } else if (selected) {
        wrapSelection('`', '`', el);
        flash('code');
        return;
      } else {
        el.value = el.value.slice(0, s) + `${leadNl}\`\`\`\n\n\`\`\`\n` + el.value.slice(e);
        el.selectionStart = el.selectionEnd = s + leadNl.length + 4;
      }
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      flash('code');
    });

    $('colorBtn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const existing = document.querySelector('.qn-color-menu');
      if (existing) { existing.remove(); return; }
      const menu = document.createElement('div');
      menu.className = 'qn-color-menu';
      const colors = [
        { name: 'red', css: '#e57373' }, { name: 'orange', css: '#f0a35e' }, { name: 'yellow', css: '#e7c862' },
        { name: 'green', css: '#7bb87a' }, { name: 'cyan', css: '#6ec1d4' }, { name: 'blue', css: '#6da4d4' },
        { name: 'purple', css: '#a880c4' }, { name: 'pink', css: '#d486a8' }, { name: 'clear', css: null }
      ];
      colors.forEach((c) => {
        const sw = document.createElement('button');
        sw.className = 'qn-color-swatch' + (c.css === null ? ' qn-none' : '');
        if (c.css) sw.style.background = c.css; else sw.textContent = '∅';
        sw.title = c.name;
        sw.addEventListener('click', (e2) => {
          e2.stopPropagation();
          menu.remove();
          const el = lastEditor;
          if (c.css) {
            wrapSelection(`<span style="color: ${c.css}">`, '</span>', el);
            flash(`color: ${c.name}`);
            return;
          }
          const s = el.selectionStart, e = el.selectionEnd;
          const selected = el.value.slice(s, e);
          if (!selected) return;
          const stripped = selected.replace(/^<span\s+style="color:\s*[^"]*">/, '').replace(/<\/span>$/, '');
          el.value = el.value.slice(0, s) + stripped + el.value.slice(e);
          el.selectionStart = s;
          el.selectionEnd = s + stripped.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          flash('color cleared');
        });
        menu.appendChild(sw);
      });
      placeMenu(menu, ev.currentTarget);
      dismissOnOutsideClick(menu);
    });

    $('previewBtn').addEventListener('click', togglePreview);
    previewEl.addEventListener('click', async (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-line]');
      if (!cb) return;
      const idx = parseInt(cb.dataset.line, 10);
      const lines = textarea.value.split('\n');
      const m = lines[idx] && lines[idx].match(/^(\s*[-*] \[)( |x|X)(\].*)$/);
      if (!m) return;
      lines[idx] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + m[3];
      textarea.value = lines.join('\n');
      updateCounter();
      await save();
      renderPreview();
    });

    const ZOOM_MIN = 10, ZOOM_MAX = 28;
    $('zoomInBtn').addEventListener('click', () => {
      const next = Math.min(ZOOM_MAX, (state.prefs.fontSize || 13) + 1);
      if (next !== state.prefs.fontSize) { setPrefs({ fontSize: next }); applyFontSize(); }
    });
    $('zoomOutBtn').addEventListener('click', () => {
      const next = Math.max(ZOOM_MIN, (state.prefs.fontSize || 13) - 1);
      if (next !== state.prefs.fontSize) { setPrefs({ fontSize: next }); applyFontSize(); }
    });
    $('zoomLabel').addEventListener('click', () => { setPrefs({ fontSize: 13 }); applyFontSize(); flash('zoom reset'); });

    $('zenBtn').addEventListener('click', toggleZen);
    $('zenExitBtn').addEventListener('click', () => { if (state.prefs.zen) toggleZen(); });

    $('defaultBtn').addEventListener('click', async () => {
      const map = { ...(state.settings.appDefaults || {}) };
      if (map[key()] === state.activeId) { delete map[key()]; flash('default removed'); }
      else { map[key()] = state.activeId; flash(`default for ${state.ctx.appName || state.ctx.process}`); }
      state.settings.appDefaults = map;
      await invoke('settings:set', { appDefaults: map });
      updateDefaultButton();
    });
    $('dlBtn').addEventListener('click', async () => {
      await flushSaves();
      const p = await invoke('note:export-md', state.activeId);
      if (p) flash('exported ✓');
    });

    $('splitBtn').addEventListener('click', toggleSplit);
    $('splitDirBtn').addEventListener('click', () => {
      setPrefs({ splitDir: state.prefs.splitDir === 'h' ? 'v' : 'h' });
      applySplit();
      flash(`split: ${state.prefs.splitDir === 'h' ? 'horizontal' : 'vertical'}`);
    });
    $('splitSwapBtn').addEventListener('click', async () => {
      if (!state.prefs.split) return;
      await flushSaves();
      const a = state.activeId, b = state.pane2Id;
      if (!b || a === b) return;
      setActive(b);
      setPane2(a);
      renderAll();
      loadActiveIntoEditor(true);
      loadPane2IntoEditor(true);
      flash('swapped');
    });
    $('pane1Select').addEventListener('change', (e) => switchToNote(e.target.value));
    $('pane2Select').addEventListener('change', async (e) => {
      await savePane2();
      setPane2(e.target.value);
      renderPane2Selector();
      loadPane2IntoEditor(true);
    });

    (function splitterDrag() {
      const splitter = $('splitter');
      const body = $('body');
      let dragging = false;
      splitter.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
      window.addEventListener('mousemove', (e) => {
        if (!dragging || !state.prefs.split) return;
        const rect = body.getBoundingClientRect();
        let ratio = state.prefs.splitDir === 'h' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
        ratio = Math.max(0.15, Math.min(0.85, ratio));
        state.prefs.paneRatio = ratio;
        $('pane1').style.flex = `${ratio} 1 0`;
        $('pane2').style.flex = `${1 - ratio} 1 0`;
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        setPrefs({ paneRatio: state.prefs.paneRatio });
      });
    })();

    $('renameBtn').addEventListener('click', startInlineRename);

    $('themeBtn').addEventListener('click', () => {
      setPrefs({ theme: state.prefs.theme === 'dark' ? 'light' : 'dark' });
      applyAppearance();
    });

    const slider = $('opacitySlider');
    slider.addEventListener('input', () => {
      const v = Math.max(30, Math.min(100, +slider.value || 100));
      state.prefs.opacity = v / 100;
      applyOpacity();
    });
    slider.addEventListener('change', () => setPrefs({ opacity: state.prefs.opacity }));

    $('tagBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.qn-tag-menu');
      if (existing) { existing.remove(); return; }
      const n = activeNote();
      if (!n) return;
      const menu = document.createElement('div');
      menu.className = 'qn-tag-menu';
      [{ key: null, css: null, label: 'No tag' }, ...Object.entries(TAG_CSS).map(([k, css]) => ({ key: k, css }))].forEach((c) => {
        const sw = document.createElement('button');
        sw.className = 'qn-tag-swatch' + (c.key === null ? ' qn-none' : '');
        if (c.css) sw.style.background = c.css;
        if (c.key === null) sw.textContent = '∅';
        sw.title = c.label || c.key;
        if ((n.tag || null) === c.key) sw.classList.add('qn-active');
        sw.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const updated = await invoke('notes:update', n.id, { tag: c.key });
          mergeNote(updated);
          renderAll();
          menu.remove();
          flash(c.key ? `tagged ${c.key}` : 'tag cleared');
        });
        menu.appendChild(sw);
      });
      $('paper').appendChild(menu);
      dismissOnOutsideClick(menu);
    });

    $('searchBtn').addEventListener('click', () => switchView('search'));
    $('historyBtn').addEventListener('click', () => switchView('history'));
    $('backFromSearch').addEventListener('click', () => switchView('editor'));
    $('backFromHistory').addEventListener('click', () => switchView('editor'));
    $('clearHistoryBtn').addEventListener('click', () => {
      if (!confirm('Clear all history?')) return;
      state.history = [];
      invoke('history:clear');
      renderHistory();
    });
    $('optionsBtn').addEventListener('click', () => invoke('window:open-settings'));
    $('dashBtn').addEventListener('click', () => invoke('window:open-dashboard'));
    searchInput.addEventListener('input', () => { clearTimeout(runSearch._t); runSearch._t = setTimeout(runSearch, 80); });
    $('searchScope').addEventListener('change', runSearch);

    $('drawerClose').addEventListener('click', () => closeDrawer(true));
    $('drawerScrim').addEventListener('mousedown', () => closeDrawer(true));
  }

  // ---------- Main-process events ----------
  async function applyContext(ctx) {
    const switching = ctx.hasTarget && ctx.processKey !== state.ctx.processKey;
    if (switching) await flushSaves();
    state.ctx = { ...state.ctx, ...ctx };
    if (!ctx.hasTarget) return;

    if (switching || ctx.noteId) {
      state.activeId = pickActive(ctx.noteId || undefined);
      state.pane2Id = null;
      if (state.activeId !== (state.prefs.activeByProcess || {})[key()]) setActive(state.activeId);
      renderAll();
      loadActiveIntoEditor(true);
      loadPane2IntoEditor(true);
    } else {
      if (!appNotes().some((n) => n.id === state.activeId)) {
        state.activeId = pickActive();
        loadActiveIntoEditor(true);
      }
      renderAll();
    }

    const expanding = 'focusEditor' in ctx || 'view' in ctx;
    if (expanding) {
      wrap.classList.remove('qn-shown');
      void wrap.offsetWidth;
      wrap.classList.add('qn-shown');
    }
    if (ctx.view === 'menu') {
      if (ctx.toggleMenu && isDrawerOpen()) closeDrawer(true);
      else openDrawer();
    } else if (ctx.view === 'editor' || ctx.focusEditor) {
      closeDrawer(false);
      if (ctx.focusEditor) {
        if (currentView !== 'editor') switchView('editor');
        textarea.focus();
        if (!textarea.value) textarea.selectionStart = textarea.selectionEnd = 0;
      }
    }
  }

  function onNotesChanged(ev) {
    if (ev.origin === myId) return;
    if (ev.type === 'remove') {
      state.notes = state.notes.filter((n) => n.id !== ev.id);
      if (state.activeId === ev.id) {
        state.activeId = pickActive(null);
        loadActiveIntoEditor(true);
      }
      if (state.pane2Id === ev.id) { state.pane2Id = null; loadPane2IntoEditor(true); }
      renderAll();
      if (state.ctx.hasTarget && !appNotes().length) invoke('overlay:collapse');
      return;
    }
    const note = ev.note;
    mergeNote(note);
    if (!state.activeId && processKey(note.process) === key()) state.activeId = note.id;
    if (note.id === state.activeId && canReplace(textarea)) {
      setEditorValue(textarea, note.body || '');
      updateCounter();
      if (previewOn) renderPreview();
    }
    if (note.id === state.pane2Id && canReplace(text2)) setEditorValue(text2, note.body || '');
    renderAll();
  }

  async function init() {
    fillIcons(document);
    let ready = false;
    const early = [];
    window.qn.on('panel:context', (ctx) => { if (ready) applyContext(ctx); else early.push(ctx); });
    myId = await invoke('app:whoami');
    const st = await invoke('state:get');
    state.notes = st.notes;
    state.prefs = st.prefs;
    state.settings = st.settings;
    state.history = st.history;
    state.vault = st.vault || {};
    state.drive = st.drive || {};
    applyAppearance();
    wireEvents();
    observePanelSize();
    renderSyncState();

    window.qn.on('notes:changed', onNotesChanged);
    window.qn.on('prefs:changed', ({ prefs, origin }) => {
      if (origin === myId) return;
      const lookChanged = ['theme', 'shape', 'opacity', 'fontSize', 'zen', 'split', 'splitDir', 'paneRatio', 'customColors']
        .some((k) => JSON.stringify(prefs[k]) !== JSON.stringify(state.prefs[k]));
      state.prefs = prefs;
      if (lookChanged) applyAppearance();
      const wanted = (prefs.activeByProcess || {})[key()];
      if (wanted && wanted !== state.activeId && !document.hasFocus() && appNotes().some((n) => n.id === wanted)) {
        flushSaves().then(() => {
          state.activeId = wanted;
          renderAll();
          loadActiveIntoEditor(true);
        });
      }
    });
    window.qn.on('settings:changed', ({ settings }) => { state.settings = settings; updateDefaultButton(); });
    window.qn.on('history:changed', (h) => { state.history = h; if (currentView === 'history') renderHistory(); });
    window.qn.on('vault:status', (s) => { state.vault = s; renderSyncState(); });
    window.qn.on('drive:status', (s) => { state.drive = s; renderSyncState(); });
    window.addEventListener('beforeunload', () => { flushSaves(); });

    if (st.context && st.context.hasTarget) await applyContext(st.context);
    for (const ctx of early) await applyContext(ctx);
    ready = true;
  }

  init();
})();
