// noteStore.js · notes, UI preferences, settings and capture history.
//
// The main process owns this state; renderers read it through IPC and send
// edits back. Everything is persisted to <userData>/state.json with an atomic
// write (tmp file + rename) a short moment after the last change.
// The vault folder and Google Drive are export targets fed from here.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_HISTORY = 200;
const SAVE_DELAY_MS = 250;

const DEFAULT_HOTKEYS = {
  toggle: 'Alt+Shift+Q',
  appMenu: 'Alt+Shift+W',
  globalMenu: 'Alt+Shift+A'
};

function defaultPrefs() {
  return {
    theme: 'dark',
    shape: 'rounded',
    opacity: 1,
    fontSize: 13,
    zen: false,
    split: false,
    splitDir: 'h',
    paneRatio: 0.5,
    customColors: { dark: {}, light: {} },
    panelByProcess: {},   // processKey -> { anchor, ox, oy, width, height }
    barByProcess: {},     // processKey -> ratio (0..1) along the top edge
    activeByProcess: {},  // processKey -> noteId
    pane2ByProcess: {}    // processKey -> noteId shown in split pane 2
  };
}

function defaultSettings() {
  return {
    hotkeys: { ...DEFAULT_HOTKEYS },
    vaultPath: '',
    drive: {
      clientId: '',
      clientSecret: '',
      folderId: '',
      scope: 'drive',
      enabled: false,
      email: '',
      autoSyncMinutes: 0
    },
    excludedProcesses: [],
    appDefaults: {},        // processKey -> noteId opened first for that app
    restoreExpanded: false, // re-open the expanded note when returning to an app
    idleOpacity: 0.25,
    launchAtLogin: false
  };
}

function genId(existing) {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex');
    const prefix = id.slice(0, 6);
    if (!existing || !existing.some((n) => n.id.slice(0, 6) === prefix)) return id;
  }
}

function deriveTitle(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const clean = first.trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+\[[ xX]\]\s+/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .trim();
  return clean.slice(0, 40) || 'Untitled';
}

const processKey = (p) => String(p || '').trim().toLowerCase();

class NoteStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.notes = [];
    this.prefs = defaultPrefs();
    this.settings = defaultSettings();
    this.history = [];
    this.saveTimer = null;
    this.saving = Promise.resolve();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the unreadable file for recovery instead of overwriting it.
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
    }
    if (data) {
      this.notes = Array.isArray(data.notes) ? data.notes.filter((n) => n && n.id) : [];
      this.prefs = { ...defaultPrefs(), ...(data.prefs || {}) };
      const s = data.settings || {};
      this.settings = {
        ...defaultSettings(),
        ...s,
        hotkeys: { ...DEFAULT_HOTKEYS, ...(s.hotkeys || {}) },
        drive: { ...defaultSettings().drive, ...(s.drive || {}) }
      };
      this.history = Array.isArray(data.history) ? data.history.slice(0, MAX_HISTORY) : [];
    }
    for (const n of this.notes) this.normalize(n);
    return this;
  }

  normalize(n) {
    n.title = n.title || deriveTitle(n.body);
    n.body = typeof n.body === 'string' ? n.body : '';
    n.pinned = !!n.pinned;
    n.tags = Array.isArray(n.tags) ? n.tags : [];
    n.created = n.created || new Date().toISOString();
    n.updated = n.updated || n.created;
    n.updatedAt = n.updatedAt || Date.parse(n.updated) || Date.now();
    return n;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snapshot = JSON.stringify({
      version: 1,
      notes: this.notes,
      prefs: this.prefs,
      settings: this.settings,
      history: this.history
    }, null, 1);
    this.saving = this.saving.then(async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.file);
    }).catch((e) => this.emit('error', e));
    return this.saving;
  }

  flushSync() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      version: 1, notes: this.notes, prefs: this.prefs, settings: this.settings, history: this.history
    }, null, 1), 'utf8');
  }

  // ----- Notes -----

  list() { return this.notes; }
  get(id) { return this.notes.find((n) => n.id === id) || null; }
  forProcess(proc) {
    const key = processKey(proc);
    return this.notes.filter((n) => processKey(n.process) === key);
  }
  findByIdPrefix(prefix) {
    return prefix ? this.notes.find((n) => n.id.slice(0, 6) === prefix) || null : null;
  }

  create(fields = {}, meta = {}) {
    const now = new Date();
    const note = this.normalize({
      id: fields.id || genId(this.notes),
      title: fields.title || deriveTitle(fields.body),
      titleLocked: !!fields.titleLocked,
      body: fields.body || '',
      process: fields.process || '',
      appName: fields.appName || '',
      created: fields.created || now.toISOString(),
      updated: fields.updated || now.toISOString(),
      updatedAt: fields.updatedAt || now.getTime(),
      pinned: !!fields.pinned,
      tag: fields.tag || null,
      tags: fields.tags || [],
      extraYaml: fields.extraYaml || '',
      fileName: fields.fileName || null,
      driveFileId: fields.driveFileId || null
    });
    this.notes.push(note);
    this.scheduleSave();
    this.emit('note-changed', note, { ...meta, created: true });
    return note;
  }

  // Patch a note. `meta.source` tells listeners who made the change
  // ('editor', 'vault', 'drive', …) so they can avoid echo loops.
  update(id, patch = {}, meta = {}) {
    const note = this.get(id);
    if (!note) return null;
    const prev = { ...note };
    const allowed = ['body', 'title', 'titleLocked', 'process', 'appName', 'pinned', 'tag', 'tags', 'extraYaml', 'created', 'fileName', 'driveFileId', 'driveSyncedAt'];
    for (const k of allowed) if (k in patch) note[k] = patch[k];

    const contentChanged = ['body', 'title', 'titleLocked', 'process', 'appName', 'tags', 'extraYaml']
      .some((k) => k in patch && JSON.stringify(prev[k]) !== JSON.stringify(note[k]));
    if (!note.titleLocked && ('body' in patch || patch.titleLocked === false)) note.title = deriveTitle(note.body);
    if (contentChanged || 'pinned' in patch || 'tag' in patch) {
      if (!meta.keepTimestamp) {
        note.updatedAt = Date.now();
        note.updated = new Date(note.updatedAt).toISOString();
      } else if (patch.updated) {
        note.updated = patch.updated;
        note.updatedAt = Date.parse(patch.updated) || note.updatedAt;
      }
    }
    this.scheduleSave();
    this.emit('note-changed', note, { ...meta, prev, contentChanged });
    return note;
  }

  remove(id, meta = {}) {
    const idx = this.notes.findIndex((n) => n.id === id);
    if (idx < 0) return null;
    const [note] = this.notes.splice(idx, 1);
    for (const [k, v] of Object.entries(this.settings.appDefaults || {})) {
      if (v === id) delete this.settings.appDefaults[k];
    }
    for (const map of [this.prefs.activeByProcess, this.prefs.pane2ByProcess]) {
      for (const [k, v] of Object.entries(map || {})) if (v === id) delete map[k];
    }
    this.scheduleSave();
    this.emit('note-removed', note, meta);
    return note;
  }

  // ----- Prefs / settings -----

  setPrefs(patch, meta = {}) {
    Object.assign(this.prefs, patch || {});
    this.scheduleSave();
    this.emit('prefs-changed', this.prefs, meta);
    return this.prefs;
  }

  setSettings(patch, meta = {}) {
    const p = patch || {};
    const next = { ...this.settings, ...p };
    if (p.hotkeys) next.hotkeys = { ...this.settings.hotkeys, ...p.hotkeys };
    if (p.drive) next.drive = { ...this.settings.drive, ...p.drive };
    this.settings = next;
    this.scheduleSave();
    this.emit('settings-changed', this.settings, meta);
    return this.settings;
  }

  // ----- History -----

  addHistory(entry) {
    if (!entry || !entry.full) return null;
    const e = {
      id: crypto.randomBytes(6).toString('hex'),
      ts: Date.now(),
      source: entry.source || 'clipboard',
      preview: String(entry.full).slice(0, 300),
      full: String(entry.full),
      noteId: entry.noteId || null,
      title: entry.title || ''
    };
    this.history.unshift(e);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    this.scheduleSave();
    this.emit('history-changed', this.history);
    return e;
  }

  removeHistory(id) {
    this.history = this.history.filter((h) => h.id !== id);
    this.scheduleSave();
    this.emit('history-changed', this.history);
  }

  clearHistory() {
    this.history = [];
    this.scheduleSave();
    this.emit('history-changed', this.history);
  }

  // ----- Backup -----

  exportAll() {
    return { app: 'quick-notes-desktop', version: 1, exportedAt: new Date().toISOString(), notes: this.notes, prefs: this.prefs, history: this.history };
  }

  importAll(data, { replace = false } = {}) {
    if (!data || !Array.isArray(data.notes)) throw new Error('Not a Quick Notes backup file.');
    if (replace) {
      for (const n of [...this.notes]) this.remove(n.id, { source: 'import' });
    }
    let added = 0;
    for (const raw of data.notes) {
      if (!raw || !raw.id) continue;
      // Extension backups store frontmatter + body in `content`.
      const body = typeof raw.body === 'string' ? raw.body : String(raw.content || '').replace(/^---[\s\S]*?\n---[ \t]*\r?\n/, '');
      const fields = { ...raw, body, fileName: null, driveFileId: null };
      if (this.get(raw.id)) this.update(raw.id, fields, { source: 'import' });
      else { this.create(fields, { source: 'import' }); added++; }
    }
    if (Array.isArray(data.history) && replace) {
      this.history = data.history.slice(0, MAX_HISTORY);
      this.emit('history-changed', this.history);
    }
    this.scheduleSave();
    return { added, total: data.notes.length };
  }
}

module.exports = { NoteStore, deriveTitle, processKey, genId, DEFAULT_HOTKEYS, defaultSettings };
