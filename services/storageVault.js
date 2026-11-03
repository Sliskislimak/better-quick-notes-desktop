// storageVault.js · mirror notes into a local folder (e.g. an Obsidian vault).
//
// Every note is written as `${sanitizedTitle}_${noteId.slice(0, 6)}.md` with
// YAML frontmatter. chokidar watches the folder so edits made in Obsidian show
// up live in the sticky notes:
//   - change/add of a known file   -> note body/frontmatter updated
//   - add of a new file whose frontmatter has a `process:` key or the
//     `quicknotes` tag             -> imported as a new note
//   - file renamed in Obsidian     -> note title follows the new file name
//   - file deleted in Obsidian     -> note removed
// Our own writes are recognised by content, so they never echo back.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fm = require('./frontmatter');
const { deriveTitle, processKey } = require('./noteStore');

const WRITE_DELAY_MS = 400;
const UNLINK_GRACE_MS = 1500;

class StorageVault extends EventEmitter {
  constructor(store, { attachmentsFallbackDir, trashItem } = {}) {
    super();
    this.store = store;
    this.dir = '';
    this.watcher = null;
    this.timers = new Map();
    this.queues = new Map();
    this.lastWritten = new Map();   // absolute path -> content we wrote
    this.ignoreUnlink = new Set();  // absolute paths we removed/renamed ourselves
    this.attachmentsFallbackDir = attachmentsFallbackDir;
    this.trashItem = trashItem || ((p) => fsp.unlink(p));
    this.status = { configured: false, path: '', lastWrite: null, lastError: null, watching: false };
  }

  async setFolder(dir) {
    await this.stop();
    this.dir = dir ? path.resolve(dir) : '';
    this.status = { configured: !!this.dir, path: this.dir, lastWrite: null, lastError: null, watching: false };
    if (!this.dir) { this.emit('status', this.status); return this.status; }
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.access(this.dir, require('fs').constants.W_OK);
      await this.initialSync();
      await this.startWatcher();
    } catch (e) {
      this.fail('Vault folder is not usable: ' + e.message);
    }
    this.emit('status', this.status);
    return this.status;
  }

  async stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      try { await this.watcher.close(); } catch { /* ignore */ }
    }
    this.watcher = null;
    this.status.watching = false;
  }

  fail(message) {
    this.status.lastError = message;
    this.emit('status', this.status);
    this.emit('error', new Error(message));
  }

  filePath(name) { return path.join(this.dir, name); }

  // ----- Writing -----

  scheduleWrite(note) {
    if (!this.dir || !note) return;
    clearTimeout(this.timers.get(note.id));
    this.timers.set(note.id, setTimeout(() => {
      this.timers.delete(note.id);
      this.enqueue(note.id, () => this.writeNow(note.id));
    }, WRITE_DELAY_MS));
  }

  enqueue(id, fn) {
    const prev = this.queues.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.queues.set(id, run);
    run.finally(() => { if (this.queues.get(id) === run) this.queues.delete(id); });
    return run;
  }

  async writeNow(id) {
    const note = this.store.get(id);
    if (!this.dir || !note) return null;
    const name = fm.noteFileName(note.title, note.id);
    const target = this.filePath(name);
    const content = fm.serializeNote(note);
    try {
      if (note.fileName && note.fileName !== name) {
        const old = this.filePath(note.fileName);
        this.ignoreUnlink.add(old);
        try { await fsp.rename(old, target); } catch { /* old file already gone */ }
        setTimeout(() => this.ignoreUnlink.delete(old), 5000);
      }
      this.lastWritten.set(target, content);
      await fsp.writeFile(target, content, 'utf8');
      if (note.fileName !== name) {
        note.fileName = name;
        this.store.scheduleSave();
      }
      this.status.lastWrite = new Date().toISOString();
      this.status.lastError = null;
      this.emit('status', this.status);
      return target;
    } catch (e) {
      this.fail(`Could not write ${name}: ${e.message}`);
      return null;
    }
  }

  async writeAll() {
    for (const n of this.store.list()) await this.enqueue(n.id, () => this.writeNow(n.id));
  }

  async removeNoteFile(note) {
    if (!this.dir || !note || !note.fileName) return;
    clearTimeout(this.timers.get(note.id));
    const p = this.filePath(note.fileName);
    this.ignoreUnlink.add(p);
    try { await this.trashItem(p); } catch { /* already gone */ }
    setTimeout(() => this.ignoreUnlink.delete(p), 5000);
  }

  // ----- Reading -----

  async readNoteFile(p) {
    const [content, stat] = await Promise.all([fsp.readFile(p, 'utf8'), fsp.stat(p)]);
    return { content, mtimeMs: stat.mtimeMs, ...fm.parse(content) };
  }

  matchNote(fileName) {
    const byName = this.store.list().find((n) => n.fileName && n.fileName.toLowerCase() === fileName.toLowerCase());
    if (byName) return byName;
    return this.store.findByIdPrefix(fm.idPrefixFromFileName(fileName));
  }

  // Patch derived from a file on disk; null when nothing differs.
  patchFromFile(note, fileName, parsed) {
    const f = parsed.fields;
    const patch = {};
    if (parsed.body !== note.body) patch.body = parsed.body;
    if (f.process && f.process !== note.process) patch.process = f.process;
    if (f.app_name && f.app_name !== note.appName) patch.appName = f.app_name;
    if ((f.extraYaml || '') !== (note.extraYaml || '')) patch.extraYaml = f.extraYaml || '';
    const tags = f.tags.filter((t) => !fm.REQUIRED_TAGS.includes(t));
    if (JSON.stringify(tags) !== JSON.stringify(note.tags || [])) patch.tags = tags;

    // A renamed file or an edited `title:` key both mean the user picked a title.
    const stem = fileName.replace(/_[A-Za-z0-9]{6}\.md$/i, '').replace(/\.md$/i, '');
    const expectedName = fm.noteFileName(note.title, note.id);
    if (note.fileName && fileName !== note.fileName && fileName !== expectedName && stem) {
      patch.title = stem; patch.titleLocked = true;
    } else if (f.title && f.title !== note.title) {
      const derived = deriveTitle(patch.body != null ? patch.body : note.body);
      if (f.title !== derived) { patch.title = f.title; patch.titleLocked = true; }
    }
    return Object.keys(patch).length ? patch : null;
  }

  isQuickNotesFile(parsed) {
    return parsed.hasFrontmatter && (!!parsed.fields.process || parsed.fields.tags.includes('quicknotes'));
  }

  importFile(fileName, parsed) {
    const f = parsed.fields;
    const prefix = fm.idPrefixFromFileName(fileName);
    let id;
    if (prefix && !this.store.findByIdPrefix(prefix)) id = prefix.toLowerCase() + crypto.randomBytes(5).toString('hex');
    const stem = fileName.replace(/_[A-Za-z0-9]{6}\.md$/i, '').replace(/\.md$/i, '');
    const derived = deriveTitle(parsed.body);
    const title = f.title || stem || derived;
    const note = this.store.create({
      id,
      body: parsed.body,
      title,
      titleLocked: title !== derived,
      process: f.process || '',
      appName: f.app_name || '',
      created: f.created || undefined,
      updated: f.updated || undefined,
      updatedAt: Date.parse(f.updated) || undefined,
      tags: f.tags.filter((t) => !fm.REQUIRED_TAGS.includes(t)),
      extraYaml: f.extraYaml || '',
      fileName
    }, { source: 'vault' });
    return note;
  }

  async initialSync() {
    const entries = await fsp.readdir(this.dir, { withFileTypes: true });
    const seen = new Set();
    for (const ent of entries) {
      if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
      const p = this.filePath(ent.name);
      let parsed;
      try { parsed = await this.readNoteFile(p); } catch { continue; }
      const note = this.matchNote(ent.name);
      if (note) {
        seen.add(note.id);
        if (!note.fileName) { note.fileName = ent.name; this.store.scheduleSave(); }
        const patch = this.patchFromFile(note, ent.name, parsed);
        if (patch && parsed.mtimeMs > note.updatedAt + 1000) {
          // Edited in Obsidian while the app was closed.
          note.fileName = ent.name;
          this.store.update(note.id, patch, { source: 'vault' });
        } else if (patch) {
          await this.enqueue(note.id, () => this.writeNow(note.id));
        }
      } else if (this.isQuickNotesFile(parsed)) {
        const created = this.importFile(ent.name, parsed);
        seen.add(created.id);
      }
    }
    // Notes that have no file yet (new vault, or app-only notes).
    for (const n of this.store.list()) {
      if (!seen.has(n.id)) {
        n.fileName = null;
        await this.enqueue(n.id, () => this.writeNow(n.id));
      }
    }
  }

  async startWatcher() {
    const chokidar = require('chokidar');
    this.watcher = chokidar.watch(this.dir, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p, stats) => !!stats && stats.isFile() && !/\.md$/i.test(p)
    });
    this.watcher
      .on('add', (p) => this.onFile(p).catch((e) => this.emit('error', e)))
      .on('change', (p) => this.onFile(p).catch((e) => this.emit('error', e)))
      .on('unlink', (p) => this.onUnlink(p))
      .on('error', (e) => this.fail('Folder watcher error: ' + e.message))
      .on('ready', () => { this.status.watching = true; this.emit('status', this.status); });
  }

  async onFile(p) {
    if (!/\.md$/i.test(p) || path.dirname(p) !== this.dir) return;
    let parsed;
    try { parsed = await this.readNoteFile(p); } catch { return; }
    if (this.lastWritten.get(p) === parsed.content) return;

    const fileName = path.basename(p);
    const note = this.matchNote(fileName);
    if (!note) {
      if (this.isQuickNotesFile(parsed)) this.importFile(fileName, parsed);
      return;
    }
    const patch = this.patchFromFile(note, fileName, parsed);
    note.fileName = fileName;
    this.store.scheduleSave();
    if (patch) this.store.update(note.id, patch, { source: 'vault' });
    this.lastWritten.set(p, parsed.content);
  }

  onUnlink(p) {
    if (this.ignoreUnlink.has(p) || path.dirname(p) !== this.dir) return;
    const fileName = path.basename(p);
    const note = this.store.list().find((n) => n.fileName === fileName);
    if (!note) return;
    // A rename in Obsidian arrives as unlink + add; wait for the add.
    setTimeout(() => {
      const still = this.store.get(note.id);
      if (still && still.fileName === fileName) {
        this.lastWritten.delete(p);
        this.store.remove(note.id, { source: 'vault' });
      }
    }, UNLINK_GRACE_MS);
  }

  // ----- Attachments (pasted / dropped images) -----

  // Write target first; the vault root is searched too because Obsidian puts
  // pasted images there by default (`![[Pasted image ….png]]`).
  attachmentDirs({ forWrite = false } = {}) {
    const dirs = [];
    if (this.dir) dirs.push(path.join(this.dir, 'attachments'));
    if (this.dir && !forWrite) dirs.push(this.dir);
    if (this.attachmentsFallbackDir) dirs.push(this.attachmentsFallbackDir);
    return dirs;
  }

  async saveAttachment(buffer, ext) {
    const safeExt = /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(ext) ? ext.toLowerCase() : 'png';
    const name = `qn-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
    const dir = this.attachmentDirs({ forWrite: true })[0];
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), buffer);
    return `attachments/${name}`;
  }

  async resolveAttachment(fileName) {
    const name = String(fileName || '');
    if (!name || name !== path.basename(name) || name.startsWith('.')) return null;
    for (const dir of this.attachmentDirs()) {
      const p = path.join(dir, name);
      try { await fsp.access(p); return p; } catch { /* try next */ }
    }
    return null;
  }

  noteFilePath(note) {
    return this.dir && note && note.fileName ? this.filePath(note.fileName) : null;
  }
}

module.exports = { StorageVault, processKey };
