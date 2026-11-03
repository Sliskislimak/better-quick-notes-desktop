// Settings window. Ported from the extension's options.js and extended
// with hotkeys, vault, Drive OAuth, and desktop behavior options.
(function () {
  const { escapeHtml, DEFAULT_COLORS, processKey } = window.QN;
  const $ = (id) => document.getElementById(id);
  const invoke = (ch, ...a) => window.qn.invoke(ch, ...a);

  const DEFAULT_HOTKEYS = { toggle: 'Alt+Shift+Q', appMenu: 'Alt+Shift+W', globalMenu: 'Alt+Shift+A' };

  const state = {
    notes: [],
    prefs: {},
    settings: {},
    history: [],
    vault: {},
    drive: {},
    hotkeys: {},
    info: {},
    recording: null
  };

  const setPrefs = (patch) => { Object.assign(state.prefs, patch); return invoke('prefs:set', patch); };
  const setSettings = (patch) => invoke('settings:set', patch);

  function status(el, text, kind) {
    el.textContent = text || '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  // ---------- Hotkeys ----------
  const CODE_KEYS = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
  };

  function keyFromCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
    return CODE_KEYS[code] || null;
  }

  function acceleratorFromEvent(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    const key = keyFromCode(e.code);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const isFn = /^F\d+$/.test(key);
    if (!mods.length && !isFn) return { error: 'Use at least one modifier (Ctrl, Alt, Shift or Win).' };
    if (mods.length === 1 && mods[0] === 'Shift' && !isFn) return { error: 'Shift alone would block typing that character.' };
    return { accel: [...mods, key].join('+') };
  }

  const kbdHtml = (accel) => accel
    ? accel.split('+').map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('+')
    : '<span class="muted">disabled</span>';

  function renderHotkeys() {
    const actions = state.info.actions || {};
    const hk = state.settings.hotkeys || {};
    $('hotkeyTable').innerHTML = Object.keys(actions).map((action) => {
      const r = state.hotkeys[action] || {};
      const rec = state.recording && state.recording.action === action;
      let st;
      if (rec) st = state.recording.error ? `<span class="err">${escapeHtml(state.recording.error)}</span>` : '<span class="muted">Press the new combination…</span>';
      else if (r.disabled || !hk[action]) st = '<span class="muted">Off</span>';
      else if (r.suspended) st = '<span class="muted">Paused while recording</span>';
      else if (r.ok) st = '<span class="ok">✓ Active</span>';
      else st = `<span class="err">✕ ${escapeHtml(r.error || 'Not registered')}</span>`;
      return `<tr data-action="${action}">
        <td class="desc">${escapeHtml(actions[action])}</td>
        <td><button class="recorder${rec ? ' recording' : ''}" data-rec="${action}">${rec ? 'Recording…' : kbdHtml(hk[action])}</button></td>
        <td class="state">${st}</td>
        <td class="actions">${hk[action] !== DEFAULT_HOTKEYS[action] ? `<button data-default="${action}" title="Back to ${DEFAULT_HOTKEYS[action]}">Default</button>` : ''}</td>
      </tr>`;
    }).join('');
  }

  async function startRecording(action) {
    if (state.recording) await stopRecording();
    state.recording = { action, error: null };
    await invoke('hotkeys:suspend');
    renderHotkeys();
  }

  async function stopRecording(accel) {
    const rec = state.recording;
    state.recording = null;
    if (rec && accel !== undefined) await setSettings({ hotkeys: { [rec.action]: accel } });
    state.hotkeys = await invoke('hotkeys:resume');
    const st = await invoke('state:get');
    state.settings = st.settings;
    renderHotkeys();
  }

  function onRecorderKey(e) {
    if (!state.recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopRecording(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopRecording(''); return; }
    const res = acceleratorFromEvent(e);
    if (!res) return;
    if (res.error) { state.recording.error = res.error; renderHotkeys(); return; }
    stopRecording(res.accel);
  }

  // ---------- Vault ----------
  function renderVault() {
    const v = state.vault;
    $('vaultOpen').disabled = !v.configured;
    $('vaultForget').disabled = !v.configured;
    $('vaultChoose').textContent = v.configured ? 'Change folder' : 'Choose folder';
    if (!v.configured) return status($('vaultStatus'), 'No folder selected. Notes are only stored in the app until you choose one.');
    if (v.lastError) return status($('vaultStatus'), `⚠ ${v.path} · ${v.lastError}`, 'err');
    const parts = [`✓ ${v.path}`, v.watching ? 'watching for external edits' : 'not watching'];
    if (v.lastWrite) parts.push(`last write ${new Date(v.lastWrite).toLocaleTimeString()}`);
    status($('vaultStatus'), parts.join(' · '), 'ok');
  }

  // ---------- Drive ----------
  function renderDrive() {
    const cfg = state.settings.drive || {};
    const d = state.drive;
    if (document.activeElement !== $('driveClientId')) $('driveClientId').value = cfg.clientId || '';
    if (document.activeElement !== $('driveFolderId')) $('driveFolderId').value = cfg.folderId || '';
    $('driveClientSecret').placeholder = d.hasClientSecret
      ? `saved${d.encrypted ? ' (encrypted with Windows DPAPI)' : ''} · type to replace`
      : 'GOCSPX-…';
    $('driveScope').value = cfg.scope || 'drive';
    $('scopeWarning').hidden = $('driveScope').value !== 'drive.file';
    $('driveSignInBtn').hidden = !!d.signedIn;
    $('driveSignOutBtn').hidden = !d.signedIn;
    $('driveSignInBtn').disabled = !(cfg.clientId && d.hasClientSecret);
    $('driveSignInBtn').title = $('driveSignInBtn').disabled ? 'Save a client ID and secret first' : '';
    $('driveAccountLabel').textContent = d.signedIn ? `Signed in${d.email ? ' as ' + d.email : ''}` : 'Not signed in';
    $('driveBody').hidden = !d.signedIn;
    $('driveEnabled').checked = !!cfg.enabled;
    $('driveInterval').value = String(cfg.autoSyncMinutes || 0);
    for (const id of ['driveSyncNowBtn', 'drivePushBtn', 'drivePullBtn', 'driveFolderTest', 'driveFolderCreate']) {
      $(id).disabled = !!d.busy;
    }

    const el = $('driveStatus');
    if (d.busy) status(el, 'Syncing…');
    else if (d.lastError) status(el, '⚠ ' + d.lastError, 'err');
    else if (!cfg.folderId) status(el, 'Set a folder ID (or create a folder) to start syncing.', 'err');
    else if (d.lastSync) status(el, `✓ Last sync ${new Date(d.lastSync).toLocaleString()}`, 'ok');
    else status(el, cfg.enabled ? 'Ready. Notes upload as you edit them.' : 'Automatic upload is off.');
  }

  async function driveOp(btn, channel, arg, onOk) {
    btn.disabled = true;
    const r = await invoke(channel, arg);
    btn.disabled = false;
    if (!r.ok) { status($('driveFolderStatus'), '⚠ ' + r.error, 'err'); return r; }
    if (onOk) onOk(r);
    return r;
  }

  // ---------- Appearance ----------
  function renderAppearance() {
    document.documentElement.dataset.theme = state.prefs.theme === 'light' ? 'light' : 'dark';
    $('themeSelect').value = state.prefs.theme === 'light' ? 'light' : 'dark';
    document.querySelectorAll('.shapeChip').forEach((c) => c.classList.toggle('active', c.dataset.shape === (state.prefs.shape || 'rounded')));
    const op = Math.round((typeof state.prefs.opacity === 'number' ? state.prefs.opacity : 1) * 100);
    $('optOpacity').value = op;
    $('optOpacityLabel').textContent = `${op}%`;
    if (!$('themeColors').contains(document.activeElement)) renderColors();
  }

  const COLOR_FIELDS = [['bg', 'Background'], ['bgAlt', 'Secondary background'], ['fg', 'Text'], ['accent', 'Accent'], ['border', 'Borders']];

  function renderColors() {
    const cc = state.prefs.customColors || {};
    $('themeColors').innerHTML = ['dark', 'light'].map((theme) => {
      const rows = COLOR_FIELDS.map(([key, label]) => {
        const v = (cc[theme] && cc[theme][key]) || DEFAULT_COLORS[theme][key];
        return `<div class="colorRow"><label>${label}</label>
          <input type="color" data-theme="${theme}" data-key="${key}" value="${v}">
          <input type="text" class="hexInput" data-theme="${theme}" data-key="${key}" value="${v}" placeholder="#RRGGBB" spellcheck="false" maxlength="7"></div>`;
      }).join('');
      return `<div class="themeColors-col"><h3>${theme === 'dark' ? '🦇 Dark theme' : '☀ Light theme'}</h3>${rows}
        <button class="small-reset" data-reset="${theme}">Reset ${theme} to defaults</button></div>`;
    }).join('');
  }

  function setColor(theme, key, value) {
    const cc = JSON.parse(JSON.stringify(state.prefs.customColors || {}));
    cc[theme] = cc[theme] || {};
    if (value.toLowerCase() === DEFAULT_COLORS[theme][key].toLowerCase()) delete cc[theme][key];
    else cc[theme][key] = value.toLowerCase();
    setPrefs({ customColors: cc });
  }

  // ---------- Behavior ----------
  function renderBehavior() {
    const s = state.settings;
    const idle = Math.round((s.idleOpacity != null ? s.idleOpacity : 0.25) * 100);
    $('idleOpacity').value = idle;
    $('idleOpacityLabel').textContent = `${idle}%`;
    $('restoreExpanded').checked = !!s.restoreExpanded;
    $('launchAtLogin').checked = !!s.launchAtLogin;
    $('launchHint').textContent = state.info.packaged === false ? 'Only applies to the installed build (not npm start).' : 'Starts minimized to the tray.';

    const ex = s.excludedProcesses || [];
    $('excludeList').innerHTML = ex.length
      ? ex.map((p) => `<li><span class="pat">${escapeHtml(p)}</span><button class="del" data-unexclude="${escapeHtml(p)}" title="Remove">✕</button></li>`).join('')
      : '<li class="empty">No ignored applications</li>';

    const defs = Object.entries(s.appDefaults || {});
    $('defaultsList').innerHTML = defs.length
      ? defs.map(([proc, id]) => {
        const n = state.notes.find((x) => x.id === id);
        return `<li><span class="pat">${escapeHtml(proc)} <span class="muted">→ ${escapeHtml(n ? n.title || 'Untitled' : 'missing note')}</span></span>
          <button class="del" data-undefault="${escapeHtml(proc)}" title="Remove">✕</button></li>`;
      }).join('')
      : '<li class="empty">No default notes yet</li>';
  }

  // ---------- Storage ----------
  function renderStats() {
    $('statNotes').textContent = state.notes.length;
    $('statApps').textContent = new Set(state.notes.map((n) => processKey(n.process)).filter(Boolean)).size;
    $('statHistory').textContent = state.history.length;
    const bytes = new Blob([JSON.stringify({ notes: state.notes, history: state.history })]).size;
    $('statBytes').textContent = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  function renderAll() {
    renderHotkeys();
    renderVault();
    renderDrive();
    renderAppearance();
    renderBehavior();
    renderStats();
  }

  // ---------- Wiring ----------
  function wire() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-ext]');
      if (a) { e.preventDefault(); invoke('external:open', a.href); }
    });

    // Hotkeys
    $('hotkeyTable').addEventListener('click', (e) => {
      const rec = e.target.closest('[data-rec]');
      if (rec) { if (state.recording && state.recording.action === rec.dataset.rec) stopRecording(); else startRecording(rec.dataset.rec); return; }
      const def = e.target.closest('[data-default]');
      if (def) setSettings({ hotkeys: { [def.dataset.default]: DEFAULT_HOTKEYS[def.dataset.default] } });
    });
    window.addEventListener('keydown', onRecorderKey, true);
    window.addEventListener('blur', () => { if (state.recording) stopRecording(); });
    $('hotkeysReset').addEventListener('click', () => setSettings({ hotkeys: { ...DEFAULT_HOTKEYS } }));

    // Vault
    $('vaultChoose').addEventListener('click', async () => {
      status($('vaultStatus'), 'Choosing…');
      state.vault = await invoke('vault:choose');
      renderVault();
    });
    $('vaultOpen').addEventListener('click', () => invoke('vault:open-folder'));
    $('vaultForget').addEventListener('click', async () => {
      if (!confirm('Stop saving notes to this folder? Existing files are kept.')) return;
      state.vault = await invoke('vault:forget');
      renderVault();
    });

    // Drive
    $('driveClientId').addEventListener('change', () => invoke('drive:set-config', { clientId: $('driveClientId').value.trim() }));
    $('driveSecretSave').addEventListener('click', async () => {
      const v = $('driveClientSecret').value.trim();
      if (!v) return;
      state.drive = await invoke('drive:set-client-secret', v);
      $('driveClientSecret').value = '';
      await invoke('drive:set-config', { clientId: $('driveClientId').value.trim() });
      status($('driveFolderStatus'), '✓ Client secret saved', 'ok');
      renderDrive();
    });
    $('driveClientSecret').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('driveSecretSave').click(); });
    $('driveScope').addEventListener('change', () => invoke('drive:set-config', { scope: $('driveScope').value }));
    $('driveFolderSave').addEventListener('click', async () => {
      await invoke('drive:set-config', { folderId: $('driveFolderId').value.trim() });
      status($('driveFolderStatus'), '✓ Folder ID saved', 'ok');
    });
    $('driveFolderTest').addEventListener('click', () => driveOp($('driveFolderTest'), 'drive:test-folder', $('driveFolderId').value.trim(),
      (r) => status($('driveFolderStatus'), `✓ Connected to folder "${r.name}"`, 'ok')));
    $('driveFolderCreate').addEventListener('click', () => driveOp($('driveFolderCreate'), 'drive:create-folder', 'Quick Notes',
      (r) => { $('driveFolderId').value = r.id; status($('driveFolderStatus'), `✓ Created folder "${r.name}" and selected it`, 'ok'); }));
    $('driveSignInBtn').addEventListener('click', async () => {
      await invoke('drive:set-config', { clientId: $('driveClientId').value.trim() });
      status($('driveFolderStatus'), 'Waiting for Google sign-in in your browser…');
      await driveOp($('driveSignInBtn'), 'drive:sign-in', undefined,
        (r) => status($('driveFolderStatus'), `✓ Signed in${r.email ? ' as ' + r.email : ''}`, 'ok'));
    });
    $('driveSignOutBtn').addEventListener('click', () => driveOp($('driveSignOutBtn'), 'drive:sign-out', undefined,
      () => status($('driveFolderStatus'), 'Signed out')));
    $('driveEnabled').addEventListener('change', () => invoke('drive:set-config', { enabled: $('driveEnabled').checked }));
    $('driveInterval').addEventListener('change', () => invoke('drive:set-config', { autoSyncMinutes: Number($('driveInterval').value) }));
    $('driveSyncNowBtn').addEventListener('click', () => driveOp($('driveSyncNowBtn'), 'drive:sync', undefined,
      (r) => status($('driveFolderStatus'), `✓ Synced · ${r.pushed || 0} uploaded · ${r.updated || 0} updated · ${r.imported || 0} imported`, 'ok')));
    $('drivePushBtn').addEventListener('click', () => driveOp($('drivePushBtn'), 'drive:push', undefined,
      (r) => status($('driveFolderStatus'), `✓ Uploaded ${r.count || 0} notes`, 'ok')));
    $('drivePullBtn').addEventListener('click', () => driveOp($('drivePullBtn'), 'drive:pull', undefined,
      (r) => status($('driveFolderStatus'), `✓ ${r.updated || 0} updated · ${r.imported || 0} imported`, 'ok')));

    // Appearance
    $('themeSelect').addEventListener('change', () => { setPrefs({ theme: $('themeSelect').value }); renderAppearance(); });
    $('shapeRow').addEventListener('click', (e) => {
      const chip = e.target.closest('.shapeChip');
      if (chip) { setPrefs({ shape: chip.dataset.shape }); renderAppearance(); }
    });
    $('optOpacity').addEventListener('input', () => { $('optOpacityLabel').textContent = `${$('optOpacity').value}%`; });
    $('optOpacity').addEventListener('change', () => setPrefs({ opacity: Number($('optOpacity').value) / 100 }));
    $('optOpacityReset').addEventListener('click', () => { setPrefs({ opacity: 1 }); renderAppearance(); });
    $('themeColors').addEventListener('input', (e) => {
      const t = e.target;
      if (!t.dataset.key) return;
      const row = t.closest('.colorRow');
      if (t.type === 'color') {
        row.querySelector('.hexInput').value = t.value;
        row.querySelector('.hexInput').classList.remove('invalid');
        setColor(t.dataset.theme, t.dataset.key, t.value);
      } else {
        const ok = /^#[0-9a-f]{6}$/i.test(t.value);
        t.classList.toggle('invalid', !ok && t.value.length > 0);
        if (ok) { row.querySelector('input[type=color]').value = t.value; setColor(t.dataset.theme, t.dataset.key, t.value); }
      }
    });
    $('themeColors').addEventListener('click', (e) => {
      const r = e.target.closest('[data-reset]');
      if (!r) return;
      const cc = { ...(state.prefs.customColors || {}) };
      cc[r.dataset.reset] = {};
      setPrefs({ customColors: cc });
      renderColors();
    });

    // Behavior
    $('idleOpacity').addEventListener('input', () => { $('idleOpacityLabel').textContent = `${$('idleOpacity').value}%`; });
    $('idleOpacity').addEventListener('change', () => setSettings({ idleOpacity: Number($('idleOpacity').value) / 100 }));
    $('restoreExpanded').addEventListener('change', () => setSettings({ restoreExpanded: $('restoreExpanded').checked }));
    $('launchAtLogin').addEventListener('change', () => setSettings({ launchAtLogin: $('launchAtLogin').checked }));
    const addExclude = () => {
      const v = $('excludeInput').value.trim().toLowerCase();
      if (!v) return;
      const name = /\.\w+$/.test(v) ? v : v + '.exe';
      const list = [...new Set([...(state.settings.excludedProcesses || []), name])];
      setSettings({ excludedProcesses: list });
      $('excludeInput').value = '';
    };
    $('excludeAdd').addEventListener('click', addExclude);
    $('excludeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addExclude(); });
    $('excludeList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unexclude]');
      if (b) setSettings({ excludedProcesses: (state.settings.excludedProcesses || []).filter((p) => p !== b.dataset.unexclude) });
    });
    $('defaultsList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-undefault]');
      if (!b) return;
      const defs = { ...(state.settings.appDefaults || {}) };
      delete defs[b.dataset.undefault];
      setSettings({ appDefaults: defs });
    });

    // Backup
    $('exportBtn').addEventListener('click', async () => {
      const p = await invoke('backup:export');
      if (p) status($('importStatus'), `✓ Saved ${p}`, 'ok');
    });
    const doImport = async (replace) => {
      if (replace && !confirm('Replace ALL current notes with the backup? This cannot be undone.')) return;
      try {
        const r = await invoke('backup:import', replace);
        if (r) status($('importStatus'), `✓ Imported ${r.added} of ${r.total} notes`, 'ok');
      } catch (err) {
        status($('importStatus'), '⚠ ' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
      }
    };
    $('importBtn').addEventListener('click', () => doImport(false));
    $('importReplaceBtn').addEventListener('click', () => doImport(true));
    $('clearHistoryBtn').addEventListener('click', async () => {
      if (!confirm('Clear the clipboard / edit history?')) return;
      await invoke('history:clear');
    });
  }

  async function init() {
    wire();
    const [st, info] = await Promise.all([invoke('state:get'), invoke('app:info')]);
    Object.assign(state, {
      notes: st.notes, prefs: st.prefs, settings: st.settings, history: st.history,
      vault: st.vault || {}, drive: st.drive || {}, hotkeys: st.hotkeys || {}, info
    });
    $('aboutVersion').textContent = info.version;
    $('aboutElectron').textContent = info.electron;
    $('aboutData').textContent = info.userData;
    const tr = $('trackerStatus');
    if (info.trackerAvailable === false) status(tr, `⚠ Native window tracking unavailable: ${info.trackerError || 'unknown error'}. Notes can only be opened from the dashboard.`, 'err');
    else status(tr, '');
    renderAll();
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();

    window.qn.on('notes:changed', (ev) => {
      if (ev.type === 'remove') state.notes = state.notes.filter((n) => n.id !== ev.id);
      else {
        const i = state.notes.findIndex((n) => n.id === ev.note.id);
        if (i >= 0) state.notes[i] = ev.note; else state.notes.push(ev.note);
      }
      renderStats();
      renderBehavior();
    });
    window.qn.on('prefs:changed', ({ prefs }) => { state.prefs = prefs; renderAppearance(); });
    window.qn.on('settings:changed', ({ settings }) => { state.settings = settings; renderHotkeys(); renderDrive(); renderBehavior(); });
    window.qn.on('history:changed', (h) => { state.history = Array.isArray(h) ? h : (h && h.history) || []; renderStats(); });
    window.qn.on('vault:status', (s) => { state.vault = s; renderVault(); });
    window.qn.on('drive:status', (s) => { state.drive = s; renderDrive(); });
    window.qn.on('hotkeys:status', (r) => { state.hotkeys = r; renderHotkeys(); });
  }

  init();
})();
