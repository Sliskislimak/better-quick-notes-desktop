// shortcutManager.js · system-wide hotkeys (Electron globalShortcut).
//
// Global hotkeys go through RegisterHotKey, so they fire even while one of
// our own windows is focused. Renderer windows add local keydown handlers on
// top (editor formatting, Esc, arrow navigation); see renderer/panel/panel.js.

const { EventEmitter } = require('events');

const ACTIONS = {
  toggle: 'Toggle open / minimize note for the current app',
  appMenu: 'Current app notes menu',
  globalMenu: 'Global notes dashboard'
};
const REPEAT_GUARD_MS = 300;

class ShortcutManager extends EventEmitter {
  constructor(globalShortcut) {
    super();
    this.gs = globalShortcut;
    this.bindings = {};   // action -> accelerator
    this.results = {};    // action -> { accelerator, ok, error }
    this.lastFired = {};
    this.suspended = false;
  }

  fire(action) {
    const now = Date.now();
    // Holding the keys auto-repeats WM_HOTKEY; one press should act once.
    if (now - (this.lastFired[action] || 0) < REPEAT_GUARD_MS) return;
    this.lastFired[action] = now;
    this.emit('action', action);
  }

  unregisterAll() {
    for (const accel of Object.values(this.bindings)) {
      if (accel) { try { this.gs.unregister(accel); } catch { /* not registered */ } }
    }
  }

  apply(hotkeys) {
    this.unregisterAll();
    this.bindings = {};
    this.results = {};
    const seen = new Map();
    for (const action of Object.keys(ACTIONS)) {
      const accel = String((hotkeys && hotkeys[action]) || '').trim();
      this.bindings[action] = accel;
      if (!accel) { this.results[action] = { accelerator: '', ok: true, disabled: true }; continue; }
      if (seen.has(accel.toLowerCase())) {
        this.results[action] = { accelerator: accel, ok: false, error: `Same hotkey as "${ACTIONS[seen.get(accel.toLowerCase())]}".` };
        continue;
      }
      seen.set(accel.toLowerCase(), action);
      if (this.suspended) { this.results[action] = { accelerator: accel, ok: true, suspended: true }; continue; }
      let ok = false, error = null;
      try {
        ok = this.gs.register(accel, () => this.fire(action));
        if (!ok) error = 'Already used by another application.';
      } catch (e) {
        error = 'Invalid hotkey: ' + e.message;
      }
      this.results[action] = { accelerator: accel, ok, error };
    }
    this.emit('applied', this.results);
    return this.results;
  }

  // Lets the Settings window record a combination without triggering it.
  suspend() {
    if (this.suspended) return;
    this.unregisterAll();
    this.suspended = true;
  }

  resume() {
    if (!this.suspended) return this.results;
    this.suspended = false;
    return this.apply(this.bindings);
  }

  dispose() {
    this.unregisterAll();
    this.bindings = {};
  }
}

module.exports = { ShortcutManager, ACTIONS };
