// overlayManager.js · the sticky note windows attached to the foreground app.
//
// Two frameless, transparent, always-on-top windows:
//   bar   — the collapsed note bar hanging from the target window's top edge
//           (non-focusable, so hovering or clicking it never steals focus)
//   panel — the expanded sticky note (the ported Quick Notes floating panel)
//
// States: hidden → docked (bar) ⇄ expanded (panel). The tracker drives
// hidden/docked; the hotkeys and the bar/panel buttons drive expanded.
// The panel's position is stored per process relative to the nearest
// horizontal edge of the target window, so it rides along when the target
// moves or resizes.

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen, app } = require('electron');
const { focusWindow, foregroundWindow, hwndFromBrowserWindow, isLeftButtonDown } = require('./windowTracker');
const { processKey } = require('./noteStore');

const MARGIN = 10;            // transparent margin so the panel shadow is not clipped
const BAR_W = 300;
const BAR_H = 34;
const PANEL_MIN = { w: 320, h: 260 };
const PANEL_MAX = { w: 1400, h: 1200 };
const DEFAULT_PANEL = { anchor: 'right', ox: 24, oy: 56, width: 420, height: 540 };
const DRAG_TICK_MS = 8;

function appNameFromTitle(title, proc) {
  const parts = String(title || '').split(/\s[-–—|]\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts[parts.length - 1];
  const exe = String(proc || '').replace(/\.exe$/i, '');
  return exe ? exe.charAt(0).toUpperCase() + exe.slice(1) : (parts[0] || '');
}

class OverlayManager extends EventEmitter {
  constructor({ store, tracker, preload, rendererDir }) {
    super();
    this.store = store;
    this.tracker = tracker;
    this.preload = preload;
    this.rendererDir = rendererDir;
    this.mode = 'hidden';
    this.target = null;
    this.lastModeByProcess = {};
    this.iconCache = new Map();
    this.drag = null;
    this.bar = null;
    this.panel = null;
    this.panelHwnd = 0;
  }

  // ----- Windows -----

  createWindows() {
    const common = {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
    };
    this.bar = new BrowserWindow({ ...common, width: BAR_W + MARGIN * 2, height: BAR_H + MARGIN, focusable: false, title: 'Quick Notes bar' });
    this.bar.loadFile(path.join(this.rendererDir, 'bar', 'index.html'));

    this.panel = new BrowserWindow({ ...common, width: DEFAULT_PANEL.width + MARGIN * 2, height: DEFAULT_PANEL.height + MARGIN * 2, title: 'Quick Notes' });
    this.panel.loadFile(path.join(this.rendererDir, 'panel', 'index.html'));
    this.panelHwnd = hwndFromBrowserWindow(this.panel);

    for (const w of [this.bar, this.panel]) {
      w.setAlwaysOnTop(true, 'floating');
      w.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); w.hide(); } });
    }
    // Docking can happen before a page has loaded; replay the current state.
    this.bar.webContents.on('did-finish-load', () => this.sendBar(this.mode === 'docked' ? { wake: true, slide: true } : {}));
    this.panel.webContents.on('did-finish-load', () => this.sendPanel(this.mode === 'expanded' ? { view: 'editor' } : {}));

    screen.on('display-metrics-changed', () => this.reposition());
    screen.on('display-removed', () => this.reposition());
  }

  // ----- Target bookkeeping -----

  key() { return this.target ? processKey(this.target.process) : ''; }

  targetDip() {
    if (!this.target || !this.target.bounds) return null;
    const r = screen.screenToDipRect(null, this.target.bounds);
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  workAreaFor(rect) {
    const d = screen.getDisplayNearestPoint({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    return d.workArea;
  }

  context() {
    const t = this.target;
    if (!t) return { hasTarget: false };
    return {
      hasTarget: true,
      process: t.process,
      processKey: processKey(t.process),
      appName: appNameFromTitle(t.title, t.process),
      windowTitle: t.title,
      exePath: t.exePath,
      icon: this.iconCache.get(t.exePath) || null,
      mode: this.mode
    };
  }

  async loadIcon(exePath) {
    if (!exePath || this.iconCache.has(exePath)) return;
    this.iconCache.set(exePath, null);
    try {
      const img = await app.getFileIcon(exePath, { size: 'small' });
      this.iconCache.set(exePath, img.toDataURL());
      this.emit('icons', this.appIcons());
      if (this.target && this.target.exePath === exePath) { this.sendBar(); this.sendPanel({}); }
    } catch { /* icon is cosmetic */ }
  }

  appIcons() {
    const out = {};
    for (const [exe, url] of this.iconCache) if (url) out[path.win32.basename(exe).toLowerCase()] = url;
    return out;
  }

  hasNotes(key) { return this.store.forProcess(key).length > 0; }

  // Tracker: foreground moved to another app window (or to nothing).
  onTarget(info) {
    if (this.drag) return;
    if (!info) {
      if (this.target) this.lastModeByProcess[this.key()] = this.mode;
      this.target = null;
      this.hideAll();
      return;
    }
    const prev = this.target;
    const sameWindow = prev && prev.hwnd === info.hwnd;
    const sameProcess = prev && processKey(prev.process) === processKey(info.process);
    if (prev && !sameProcess) this.lastModeByProcess[this.key()] = this.mode;
    this.target = info;
    this.loadIcon(info.exePath);

    if (sameWindow && this.mode !== 'hidden') {
      // Focus came back from our own panel to the app: keep the current state.
      this.reposition();
      this.sendBar();
      return;
    }
    if (!this.hasNotes(this.key())) { this.hideAll(); return; }
    const restore = this.store.settings.restoreExpanded && this.lastModeByProcess[this.key()] === 'expanded';
    if ((sameProcess && this.mode === 'expanded') || restore) this.expand({ focus: false });
    else this.dock({ wake: true });
  }

  onTargetBounds(info) {
    if (!this.target || info.hwnd !== this.target.hwnd) return;
    this.target = info;
    if (this.mode === 'hidden' && this.hasNotes(this.key())) this.dock({ wake: false });
    else this.reposition();
  }

  onTargetMinimized() {
    if (this.target) this.lastModeByProcess[this.key()] = this.mode;
    this.hideAll();
  }

  onTargetTitle() {
    this.sendBar();
    this.sendPanel({});
  }

  // Notes added/removed for the current app can show or hide the bar.
  onNotesChanged() {
    if (!this.target) return;
    const has = this.hasNotes(this.key());
    if (this.mode === 'hidden' && has && foregroundWindow() === this.target.hwnd) this.dock({ wake: true });
    else if (this.mode === 'docked' && !has) this.hideAll();
    else this.sendBar();
  }

  // ----- Geometry -----

  panelGeometry() {
    const g = this.store.prefs.panelByProcess[this.key()];
    return { ...DEFAULT_PANEL, ...(g || {}) };
  }

  panelBounds() {
    const t = this.targetDip();
    if (!t) return null;
    const g = this.panelGeometry();
    const area = this.workAreaFor(t);
    const w = Math.max(PANEL_MIN.w, Math.min(PANEL_MAX.w, area.width - MARGIN * 2, g.width));
    const h = Math.max(PANEL_MIN.h, Math.min(PANEL_MAX.h, area.height - MARGIN * 2, g.height));
    let x = g.anchor === 'left' ? t.x + g.ox : t.x + t.width - g.ox - w;
    let y = t.y + g.oy;
    x = Math.max(area.x, Math.min(area.x + area.width - w, x));
    y = Math.max(area.y, Math.min(area.y + area.height - h, y));
    return { x: Math.round(x - MARGIN), y: Math.round(y - MARGIN), width: w + MARGIN * 2, height: h + MARGIN * 2 };
  }

  savePanelGeometry() {
    const t = this.targetDip();
    if (!t || !this.panel) return;
    const b = this.panel.getBounds();
    const inner = { x: b.x + MARGIN, y: b.y + MARGIN, width: b.width - MARGIN * 2, height: b.height - MARGIN * 2 };
    const anchor = inner.x + inner.width / 2 > t.x + t.width / 2 ? 'right' : 'left';
    const geo = {
      anchor,
      ox: anchor === 'right' ? t.x + t.width - (inner.x + inner.width) : inner.x - t.x,
      oy: inner.y - t.y,
      width: inner.width,
      height: inner.height
    };
    this.store.setPrefs({ panelByProcess: { ...this.store.prefs.panelByProcess, [this.key()]: geo } }, { source: 'overlay' });
  }

  barBounds() {
    const t = this.targetDip();
    if (!t) return null;
    const ratio = this.store.prefs.barByProcess[this.key()];
    const r = typeof ratio === 'number' ? Math.max(0, Math.min(1, ratio)) : 0.5;
    const w = BAR_W + MARGIN * 2;
    const x = t.x + (t.width - w) * r;
    return { x: Math.round(x), y: Math.round(t.y), width: w, height: BAR_H + MARGIN };
  }

  reposition() {
    if (this.drag) return;
    if (this.mode === 'expanded') {
      const b = this.panelBounds();
      if (b) this.panel.setBounds(b);
    } else if (this.mode === 'docked') {
      const b = this.barBounds();
      if (b) this.bar.setBounds(b);
    }
  }

  // ----- State transitions -----

  hideAll() {
    if (this.drag) this.endDrag();
    if (this.mode === 'hidden') return;
    this.mode = 'hidden';
    this.bar.hide();
    this.panel.hide();
    this.emit('mode', this.mode);
  }

  dock({ wake = true } = {}) {
    if (!this.target || !this.hasNotes(this.key())) { this.hideAll(); return; }
    const b = this.barBounds();
    if (!b) return;
    const was = this.mode;
    this.mode = 'docked';
    if (was === 'expanded') this.panel.hide();
    this.bar.setBounds(b);
    this.sendBar({ wake, slide: was !== 'docked' });
    if (!this.bar.isVisible()) this.bar.showInactive();
    this.emit('mode', this.mode);
  }

  ensureNote() {
    const key = this.key();
    if (this.hasNotes(key)) return null;
    const note = this.store.create({
      process: this.target.process,
      appName: appNameFromTitle(this.target.title, this.target.process)
    }, { source: 'overlay' });
    this.store.setPrefs({ activeByProcess: { ...this.store.prefs.activeByProcess, [key]: note.id } }, { source: 'overlay' });
    return note;
  }

  expand({ focus = true, view = 'editor', noteId = null, createIfEmpty = false } = {}) {
    if (!this.target) return false;
    if (createIfEmpty) this.ensureNote();
    if (!this.hasNotes(this.key())) return false;
    if (noteId) {
      this.store.setPrefs({ activeByProcess: { ...this.store.prefs.activeByProcess, [this.key()]: noteId } }, { source: 'overlay' });
    }
    const b = this.panelBounds();
    if (!b) return false;
    this.mode = 'expanded';
    this.bar.hide();
    this.panel.setBounds(b);
    this.sendPanel({ focusEditor: focus, view, noteId });
    if (focus) {
      this.panel.show();
      this.panel.focus();
      this.panel.webContents.focus();
      setTimeout(() => {
        if (this.mode === 'expanded' && foregroundWindow() !== this.panelHwnd) focusWindow(this.panelHwnd);
      }, 60);
    } else if (!this.panel.isVisible()) {
      this.panel.showInactive();
    }
    this.emit('mode', this.mode);
    return true;
  }

  collapse({ focusTarget = true } = {}) {
    if (this.mode !== 'expanded') return;
    const hwnd = this.target && this.target.hwnd;
    this.dock({ wake: true });
    if (this.mode !== 'docked') this.panel.hide();
    if (focusTarget && hwnd) focusWindow(hwnd);
  }

  // ----- Hotkey actions -----

  toggle() {
    if (this.mode === 'expanded') { this.collapse({ focusTarget: true }); return true; }
    return this.expand({ focus: true, createIfEmpty: true });
  }

  openAppMenu() {
    if (!this.target) return false;
    if (this.mode === 'expanded' && foregroundWindow() === this.panelHwnd) {
      this.sendPanel({ view: 'menu', toggleMenu: true, focusEditor: false });
      return true;
    }
    return this.expand({ focus: true, view: 'menu', createIfEmpty: true });
  }

  // ----- Renderer messaging -----

  sendBar(extra = {}) {
    if (!this.bar || this.bar.isDestroyed()) return;
    this.bar.webContents.send('bar:context', { ...this.context(), ...extra, idleOpacity: this.store.settings.idleOpacity });
  }

  sendPanel(extra) {
    if (!this.panel || this.panel.isDestroyed()) return;
    this.panel.webContents.send('panel:context', { ...this.context(), ...extra });
  }

  // ----- Drag / resize driven from the main process -----
  // The renderer only reports mousedown; the cursor is then followed here,
  // which keeps moving smoothly even when the pointer outruns the window.

  startDrag(kind, dir) {
    const win = kind === 'bar' ? this.bar : this.panel;
    if (!win || this.drag) return;
    const start = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const t = this.targetDip();
    this.drag = { kind, dir, win, start, bounds, t, timer: setInterval(() => this.dragTick(), DRAG_TICK_MS) };
  }

  dragTick() {
    const d = this.drag;
    if (!d) return;
    if (!isLeftButtonDown()) { this.endDrag(); return; }
    const p = screen.getCursorScreenPoint();
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.kind === 'bar') {
      if (!d.t) return;
      const minX = d.t.x;
      const maxX = d.t.x + d.t.width - d.bounds.width;
      d.win.setPosition(Math.round(Math.max(minX, Math.min(maxX, d.bounds.x + dx))), d.bounds.y);
    } else if (d.kind === 'move') {
      d.win.setPosition(d.bounds.x + dx, d.bounds.y + dy);
    } else if (d.kind === 'resize') {
      let { x, y, width, height } = d.bounds;
      const min = { w: PANEL_MIN.w + MARGIN * 2, h: PANEL_MIN.h + MARGIN * 2 };
      const max = { w: PANEL_MAX.w + MARGIN * 2, h: PANEL_MAX.h + MARGIN * 2 };
      if (d.dir.includes('e')) width = d.bounds.width + dx;
      if (d.dir.includes('s')) height = d.bounds.height + dy;
      if (d.dir.includes('w')) width = d.bounds.width - dx;
      if (d.dir.includes('n')) height = d.bounds.height - dy;
      width = Math.max(min.w, Math.min(max.w, width));
      height = Math.max(min.h, Math.min(max.h, height));
      if (d.dir.includes('w')) x = d.bounds.x + d.bounds.width - width;
      if (d.dir.includes('n')) y = d.bounds.y + d.bounds.height - height;
      d.win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    }
  }

  endDrag() {
    const d = this.drag;
    if (!d) return;
    clearInterval(d.timer);
    this.drag = null;
    if (d.kind === 'bar') {
      if (d.t) {
        const b = d.win.getBounds();
        const span = d.t.width - b.width;
        const ratio = span > 0 ? (b.x - d.t.x) / span : 0.5;
        this.store.setPrefs({ barByProcess: { ...this.store.prefs.barByProcess, [this.key()]: Math.max(0, Math.min(1, ratio)) } }, { source: 'overlay' });
      }
    } else {
      this.savePanelGeometry();
      this.reposition();
    }
  }

  recenter() {
    const t = this.targetDip();
    if (!t) return;
    const area = this.workAreaFor(t);
    const w = Math.min(480, Math.max(PANEL_MIN.w, t.width - 40));
    const h = Math.min(560, Math.max(PANEL_MIN.h, t.height - 80));
    const geo = { anchor: 'left', ox: Math.max(20, (t.width - w) / 2), oy: Math.max(20, (t.height - h) / 3), width: w, height: h };
    if (t.y + geo.oy + h > area.y + area.height) geo.oy = Math.max(0, area.y + area.height - h - t.y);
    this.store.setPrefs({ panelByProcess: { ...this.store.prefs.panelByProcess, [this.key()]: geo } }, { source: 'overlay' });
    this.reposition();
  }

  isOwnWindow(win) { return win === this.bar || win === this.panel; }
}

module.exports = { OverlayManager, appNameFromTitle, MARGIN };
