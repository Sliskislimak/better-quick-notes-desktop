// preload.js · the only bridge between renderer windows and the main process.
// Renderers are sandboxed with context isolation; they get `window.qn` with
// a fixed list of invoke channels and event channels.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:whoami', 'app:info', 'state:get',
  'notes:create', 'notes:update', 'notes:remove',
  'prefs:set', 'settings:set',
  'history:add', 'history:remove', 'history:clear',
  'overlay:collapse', 'overlay:expand', 'overlay:drag-start', 'overlay:recenter', 'overlay:open-menu',
  'window:open-settings', 'window:open-dashboard', 'window:close', 'window:minimize',
  'clipboard:read-text', 'clipboard:write-text',
  'assets:save-image', 'note:export-md',
  'vault:choose', 'vault:forget', 'vault:status', 'vault:open-folder', 'vault:reveal-note', 'vault:open-in-obsidian',
  'drive:status', 'drive:set-config', 'drive:set-client-secret', 'drive:sign-in', 'drive:sign-out',
  'drive:test-folder', 'drive:create-folder', 'drive:push', 'drive:pull', 'drive:sync',
  'hotkeys:status', 'hotkeys:suspend', 'hotkeys:resume',
  'backup:export', 'backup:import', 'external:open'
]);

const EVENTS = new Set([
  'notes:changed', 'prefs:changed', 'settings:changed', 'history:changed',
  'panel:context', 'bar:context', 'dashboard:focus',
  'vault:status', 'drive:status', 'hotkeys:status', 'icons:changed'
]);

contextBridge.exposeInMainWorld('qn', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`Blocked IPC event: ${channel}`);
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // Absolute path of a dropped file (File.path was removed in Electron 32).
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }
});
