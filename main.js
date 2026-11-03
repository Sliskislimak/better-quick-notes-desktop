// Quick Notes Desktop · main process
//
// Tray daemon that pins Quick Notes sticky notes to Windows applications.
//   services/windowTracker.js   foreground window, bounds, minimize (Win32 FFI)
//   services/overlayManager.js  docked bar + expanded panel windows
//   services/shortcutManager.js global hotkeys
//   services/noteStore.js       notes / prefs / settings (state.json)
//   services/storageVault.js    Markdown files in a local (Obsidian) folder
//   services/driveSync.js       Markdown files in a Google Drive folder

const path = require('path');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell,
  globalShortcut, clipboard, protocol, net, safeStorage, screen
} = require('electron');

const { NoteStore, processKey } = require('./services/noteStore');
const { StorageVault } = require('./services/storageVault');
const { DriveSync } = require('./services/driveSync');
const { WindowTracker } = require('./services/windowTracker');
const { ShortcutManager, ACTIONS } = require('./services/shortcutManager');
const { OverlayManager } = require('./services/overlayManager');
const fm = require('./services/frontmatter');

const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : null;
};
const DEV = process.argv.includes('--dev');
const SNAPSHOT_DIR = argValue('--snapshot');
const USER_DATA = argValue('--user-data');
const RENDERER = path.join(__dirname, 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const ASSETS = path.join(__dirname, 'assets');

if (USER_DATA) app.setPath('userData', path.resolve(USER_DATA));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('com.quicknotes.desktop');
protocol.registerSchemesAsPrivileged([
  { scheme: 'qn-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let store, vault, drive, tracker, overlay, shortcuts, tray;
let settingsWin = null;
let dashboardWin = null;

// ---------- Broadcasting ----------

function allWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

function broadcast(channel, payload) {
  for (const w of allWindows()) w.webContents.send(channel, payload);
}

function publicSettings() {
  return store.settings;
}

function fullState() {
  return {
    notes: store.list(),
    prefs: store.prefs,
    settings: publicSettings(),
    history: store.history,
    context: overlay ? overlay.context() : { hasTarget: false },
    appIcons: overlay ? overlay.appIcons() : {},
    vault: vault.status,
    drive: drive.getStatus(),
    hotkeys: shortcuts ? shortcuts.results : {}
  };
}

// ---------- Windows ----------

function themeBg() {
  return store.prefs.theme === 'light' ? '#fafaf8' : '#1F1F1E';
}

function secureWebContents(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 860,
    minWidth: 560,
    minHeight: 480,
    title: 'Quick Notes · Settings',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: themeBg(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.setMenu(null);
  secureWebContents(settingsWin);
  settingsWin.loadFile(path.join(RENDERER, 'settings', 'index.html'), section ? { hash: section } : undefined);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
    shortcuts.resume();
  });
  return settingsWin;
}

function createDashboard() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1040, area.width - 80);
  const height = Math.min(680, area.height - 80);
  dashboardWin = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 3),
    minWidth: 640,
    minHeight: 400,
    frame: false,
    title: 'Quick Notes · All notes',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: themeBg(),
    show: false,
    skipTaskbar: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  secureWebContents(dashboardWin);
  dashboardWin.loadFile(path.join(RENDERER, 'dashboard', 'index.html'));
  dashboardWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); dashboardWin.hide(); }
  });
  return dashboardWin;
}

function toggleDashboard(force, opts = {}) {
  if (!dashboardWin || dashboardWin.isDestroyed()) createDashboard();
  const visible = dashboardWin.isVisible() && dashboardWin.isFocused();
  if (visible && force !== true) { dashboardWin.hide(); return; }
  if (overlay.mode === 'expanded') overlay.collapse({ focusTarget: false });
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const b = dashboardWin.getBounds();
  if (!dashboardWin.isVisible()) {
    dashboardWin.setPosition(Math.round(area.x + (area.width - b.width) / 2), Math.round(area.y + (area.height - b.height) / 3));
  }
  const show = () => {
    dashboardWin.show();
    dashboardWin.focus();
    dashboardWin.webContents.send('dashboard:focus', { context: overlay.context(), appIcons: overlay.appIcons(), noteId: opts.noteId || null });
  };
  if (dashboardWin.webContents.isLoading()) dashboardWin.webContents.once('did-finish-load', show);
  else show();
}

// ---------- Tray ----------

function buildTrayMenu() {
  const hk = store.settings.hotkeys;
  return Menu.buildFromTemplate([
    { label: 'Quick Notes Desktop', enabled: false },
    { type: 'separator' },
    { label: 'Global notes menu', accelerator: hk.globalMenu || undefined, click: () => toggleDashboard(true) },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: 'Pause note tracking',
      type: 'checkbox',
      checked: !!(tracker && tracker.paused),
      click: (item) => { tracker.setPaused(item.checked); }
    },
    {
      label: 'Open vault folder',
      enabled: !!store.settings.vaultPath,
      click: () => shell.openPath(store.settings.vaultPath)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 }) : img);
  tray.setToolTip('Quick Notes Desktop');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleDashboard(true));
}

function notify(title, content) {
  if (SNAPSHOT_DIR) return;
  if (tray && process.platform === 'win32') {
    tray.displayBalloon({ title, content, iconType: 'info', noSound: true });
  }
}

// ---------- Settings side effects ----------

async function applySettings(prev, next) {
  if (!prev || JSON.stringify(prev.hotkeys) !== JSON.stringify(next.hotkeys)) {
    const results = shortcuts.apply(next.hotkeys);
    broadcast('hotkeys:status', results);
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
  if (!prev || prev.vaultPath !== next.vaultPath) {
    await vault.setFolder(next.vaultPath);
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
  if (!prev || prev.launchAtLogin !== next.launchAtLogin) {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!next.launchAtLogin, args: ['--hidden'] });
  }
  if (!prev || JSON.stringify(prev.drive) !== JSON.stringify(next.drive)) drive.setupAutoSync();
  if (prev && prev.idleOpacity !== next.idleOpacity) overlay.sendBar();
  if (prev && JSON.stringify(prev.excludedProcesses) !== JSON.stringify(next.excludedProcesses)) tracker.refreshForeground(true);
}

// ---------- IPC ----------

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => fn(e, ...args));
  const origin = (e) => e.sender.id;

  handle('app:whoami', (e) => e.sender.id);
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    trackerAvailable: tracker.available,
    trackerError: tracker.error ? String(tracker.error.message || tracker.error) : null,
    actions: ACTIONS
  }));
  handle('state:get', () => fullState());

  // Notes
  handle('notes:create', (e, fields) => store.create(fields || {}, { source: 'editor', origin: origin(e) }));
  handle('notes:update', (e, id, patch) => store.update(id, patch || {}, { source: 'editor', origin: origin(e) }));
  handle('notes:remove', (e, id) => !!store.remove(id, { source: 'editor', origin: origin(e) }));
  handle('prefs:set', (e, patch) => store.setPrefs(patch || {}, { origin: origin(e) }));
  handle('settings:set', (e, patch) => store.setSettings(patch || {}, { origin: origin(e) }));
  handle('history:add', (e, entry) => store.addHistory(entry));
  handle('history:remove', (e, id) => store.removeHistory(id));
  handle('history:clear', () => store.clearHistory());

  // Overlay
  handle('overlay:collapse', () => overlay.collapse({ focusTarget: true }));
  handle('overlay:expand', (e, opts) => overlay.expand({ focus: true, ...(opts || {}) }));
  handle('overlay:open-menu', () => overlay.openAppMenu());
  handle('overlay:drag-start', (e, kind, dir) => overlay.startDrag(kind, dir));
  handle('overlay:recenter', () => overlay.recenter());

  // Windows
  handle('window:open-settings', (e, section) => { openSettings(section); });
  handle('window:open-dashboard', (e, opts) => toggleDashboard(true, opts || {}));
  handle('window:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !overlay.isOwnWindow(w)) w.close();
  });
  handle('window:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !overlay.isOwnWindow(w)) w.minimize();
  });
  handle('external:open', (e, url) => {
    if (/^(https?:|obsidian:)/i.test(String(url))) shell.openExternal(String(url));
  });

  // Clipboard (sandboxed preloads cannot use the clipboard module)
  handle('clipboard:read-text', () => clipboard.readText());
  handle('clipboard:write-text', (e, text) => { clipboard.writeText(String(text || '')); return true; });

  // Images pasted or dropped into a note
  handle('assets:save-image', async (e, bytes, mime) => {
    const ext = String(mime || 'image/png').split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    return vault.saveAttachment(Buffer.from(bytes), ext);
  });
  handle('note:export-md', async (e, id) => {
    const note = store.get(id);
    if (!note) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: fm.noteFileName(note.title, note.id),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, fm.serializeNote(note), 'utf8');
    return filePath;
  });

  // Vault
  handle('vault:choose', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose the folder for your notes (e.g. an Obsidian vault)',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.settings.vaultPath || app.getPath('documents')
    });
    if (canceled || !filePaths[0]) return vault.status;
    store.setSettings({ vaultPath: filePaths[0] });
    return vault.status;
  });
  handle('vault:forget', () => { store.setSettings({ vaultPath: '' }); return vault.status; });
  handle('vault:status', () => vault.status);
  handle('vault:open-folder', () => store.settings.vaultPath && shell.openPath(store.settings.vaultPath));
  handle('vault:reveal-note', (e, id) => {
    const p = vault.noteFilePath(store.get(id));
    if (p) shell.showItemInFolder(p);
    return !!p;
  });
  handle('vault:open-in-obsidian', (e, id) => {
    const p = vault.noteFilePath(store.get(id));
    if (!p) return false;
    shell.openExternal(`obsidian://open?path=${encodeURIComponent(p)}`);
    return true;
  });

  // Drive
  const driveOp = (fn) => async (...args) => {
    try { return { ok: true, ...(await fn(...args)) }; }
    catch (e) { return { ok: false, error: drive.explain(e) }; }
  };
  handle('drive:status', () => drive.getStatus());
  handle('drive:set-config', (e, cfg) => {
    const allowed = {};
    for (const k of ['clientId', 'folderId', 'scope', 'autoSyncMinutes', 'enabled']) if (cfg && k in cfg) allowed[k] = cfg[k];
    store.setSettings({ drive: allowed });
    return drive.getStatus();
  });
  handle('drive:set-client-secret', async (e, secret) => { await drive.setClientSecret(secret); return drive.getStatus(); });
  handle('drive:sign-in', driveOp(() => drive.signIn()));
  handle('drive:sign-out', driveOp(() => drive.signOut()));
  handle('drive:test-folder', driveOp((e, id) => drive.testFolder(id)));
  handle('drive:create-folder', driveOp((e, name) => drive.createFolder(name)));
  handle('drive:push', driveOp(() => drive.pushAll()));
  handle('drive:pull', driveOp(() => drive.pull()));
  handle('drive:sync', driveOp(() => drive.syncNow()));

  // Hotkeys
  handle('hotkeys:status', () => shortcuts.results);
  handle('hotkeys:suspend', () => { shortcuts.suspend(); return true; });
  handle('hotkeys:resume', () => shortcuts.resume());

  // Backup
  handle('backup:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `quick-notes-desktop-backup-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, JSON.stringify(store.exportAll(), null, 2), 'utf8');
    return filePath;
  });
  handle('backup:import', async (e, replace) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths[0]) return null;
    const data = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
    return store.importAll(data, { replace: !!replace });
  });
}

// ---------- Store fan-out ----------

function wireStore() {
  let notesTimer = null;
  const notesChangedSoon = () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => overlay.onNotesChanged(), 60);
  };

  store.on('note-changed', (note, meta) => {
    broadcast('notes:changed', { type: 'upsert', note, source: meta.source, origin: meta.origin || null });
    if (meta.source !== 'vault') vault.scheduleWrite(note);
    if (meta.source !== 'drive') drive.scheduleUpload(note);
    notesChangedSoon();
  });
  store.on('note-removed', (note, meta) => {
    broadcast('notes:changed', { type: 'remove', id: note.id, source: meta.source, origin: meta.origin || null });
    if (meta.source !== 'vault') vault.removeNoteFile(note);
    if (meta.source !== 'drive') drive.trashFile(note);
    notesChangedSoon();
  });
  store.on('prefs-changed', (prefs, meta) => broadcast('prefs:changed', { prefs, origin: meta.origin || null }));
  let prevSettings = JSON.parse(JSON.stringify(store.settings));
  store.on('settings-changed', (settings, meta) => {
    const prev = prevSettings;
    prevSettings = JSON.parse(JSON.stringify(settings));
    broadcast('settings:changed', { settings: publicSettings(), origin: meta.origin || null });
    applySettings(prev, settings).catch((e) => console.error('[settings]', e));
  });
  store.on('history-changed', (history) => broadcast('history:changed', history));
  store.on('error', (e) => console.error('[store]', e));

  vault.on('status', (s) => broadcast('vault:status', s));
  vault.on('error', (e) => console.warn('[vault]', e.message));
  drive.on('status', (s) => broadcast('drive:status', s));
}

// ---------- Hotkey actions ----------

function onHotkey(action) {
  if (action === 'globalMenu') { toggleDashboard(); return; }
  if (!tracker.available) {
    notify('Quick Notes', 'Window tracking is unavailable on this system.');
    return;
  }
  if (action === 'toggle') {
    if (!overlay.toggle()) notify('Quick Notes', 'Focus an application window first, then press the hotkey to pin a note to it.');
  } else if (action === 'appMenu') {
    if (!overlay.openAppMenu()) toggleDashboard(true);
  }
}

// ---------- Boot ----------

app.on('second-instance', () => toggleDashboard(true));
app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  try { store.flushSync(); } catch (e) { console.error(e); }
  if (tracker) tracker.stop();
  if (shortcuts) shortcuts.dispose();
  if (vault) vault.stop();
});

if (DEV || SNAPSHOT_DIR) {
  app.on('web-contents-created', (e, wc) => {
    wc.on('console-message', (ev, ...legacy) => {
      const level = ev.level ?? legacy[0];
      const message = ev.message ?? legacy[1];
      const line = ev.lineNumber ?? legacy[2];
      const source = ev.sourceId ?? legacy[3];
      if (level === 'debug' || level === 0) return;
      console.log(`[renderer:${level}] ${message} (${path.basename(String(source || ''))}:${line})`);
    });
    wc.on('render-process-gone', (ev, details) => console.error('[renderer gone]', details));
    wc.on('preload-error', (ev, p, err) => console.error('[preload error]', err));
  });
}

app.whenReady().then(async () => {
  if (SNAPSHOT_DIR) require('./scripts/snapshot').install();
  store = new NoteStore(app.getPath('userData')).load();
  vault = new StorageVault(store, {
    attachmentsFallbackDir: path.join(app.getPath('userData'), 'attachments'),
    trashItem: (p) => shell.trashItem(p)
  });
  drive = new DriveSync(store, {
    userDataDir: app.getPath('userData'),
    openExternal: (url) => shell.openExternal(url),
    safeStorage
  });

  protocol.handle('qn-asset', async (req) => {
    const u = new URL(req.url);
    const p = await vault.resolveAttachment(decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (!p) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });

  tracker = new WindowTracker({
    isExcluded: (info) => (store.settings.excludedProcesses || []).map(processKey).includes(info.processKey)
  });
  overlay = new OverlayManager({ store, tracker, preload: PRELOAD, rendererDir: RENDERER });
  overlay.on('icons', (icons) => broadcast('icons:changed', icons));
  shortcuts = new ShortcutManager(globalShortcut);
  shortcuts.on('action', onHotkey);

  wireStore();
  registerIpc();
  overlay.createWindows();
  createTray();

  tracker.on('target', (info) => overlay.onTarget(info));
  tracker.on('target-bounds', (info) => overlay.onTargetBounds(info));
  tracker.on('target-minimized', (info) => overlay.onTargetMinimized(info));
  tracker.on('target-title', (info) => overlay.onTargetTitle(info));
  tracker.on('error', (e) => console.warn('[tracker]', e.message));

  await applySettings(null, store.settings);
  const failed = Object.entries(shortcuts.results).filter(([, r]) => !r.ok);
  if (failed.length) {
    notify('Quick Notes · hotkey conflict', failed.map(([a, r]) => `${r.accelerator}: ${r.error}`).join('\n'));
  }

  if (!tracker.start()) {
    console.error('[tracker] unavailable:', tracker.error);
    notify('Quick Notes', 'Window tracking could not start. Notes are still available from the tray.');
  }
  if (SNAPSHOT_DIR) {
    require('./scripts/snapshot').run({
      dir: path.resolve(SNAPSHOT_DIR), store, overlay, tracker, toggleDashboard, openSettings,
      windows: () => ({ dashboardWin, settingsWin })
    });
    return;
  }
  if (DEV) overlay.panel.webContents.openDevTools({ mode: 'detach' });
  if (!process.argv.includes('--hidden') && !store.list().length) {
    notify('Quick Notes is running', `Focus any app and press ${store.settings.hotkeys.toggle} to pin a note to it.`);
  }
});
