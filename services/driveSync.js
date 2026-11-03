// driveSync.js · mirror notes into a Google Drive folder as Markdown files.
//
// Auth: OAuth 2.0 for installed apps (loopback redirect + PKCE) with the
// user's own "Desktop app" OAuth client. The refresh token and client secret
// are encrypted with Electron safeStorage (DPAPI on Windows) and kept in
// <userData>/drive-secrets.bin, never in state.json.
//
// Files: created once with POST (parents: [folderId], mimeType text/markdown),
// then always updated in place with PATCH on the stored file id, so autosave
// never produces duplicates. A 404 on PATCH (file deleted in Drive) creates a
// fresh file and stores the new id.

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fm = require('./frontmatter');
const { deriveTitle } = require('./noteStore');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive',
  'drive.file': 'https://www.googleapis.com/auth/drive.file'
};
const UPLOAD_DELAY_MS = 2500;
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class DriveError extends Error {
  constructor(status, message) {
    super(`Drive API ${status}: ${message}`);
    this.status = status;
  }
}

class DriveSync extends EventEmitter {
  constructor(store, { userDataDir, openExternal, safeStorage }) {
    super();
    this.store = store;
    this.secretsFile = path.join(userDataDir, 'drive-secrets.bin');
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    this.secrets = this.loadSecrets();
    this.timers = new Map();
    this.queues = new Map();
    this.autoTimer = null;
    this.status = { signedIn: !!this.secrets.refreshToken, lastSync: null, lastError: null, busy: false };
  }

  get cfg() { return this.store.settings.drive; }

  // ----- Secrets -----

  loadSecrets() {
    try {
      const raw = fs.readFileSync(this.secretsFile);
      const text = this.safeStorage && this.safeStorage.isEncryptionAvailable()
        ? this.safeStorage.decryptString(raw)
        : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async saveSecrets() {
    const text = JSON.stringify(this.secrets);
    const data = this.safeStorage && this.safeStorage.isEncryptionAvailable()
      ? this.safeStorage.encryptString(text)
      : Buffer.from(text, 'utf8');
    await fsp.mkdir(path.dirname(this.secretsFile), { recursive: true });
    await fsp.writeFile(this.secretsFile, data);
  }

  async setClientSecret(secret) {
    this.secrets.clientSecret = String(secret || '').trim();
    await this.saveSecrets();
  }

  hasClientSecret() { return !!this.secrets.clientSecret; }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      ...this.status,
      signedIn: !!this.secrets.refreshToken,
      email: this.cfg.email || '',
      enabled: !!this.cfg.enabled,
      folderId: this.cfg.folderId || '',
      hasClientSecret: this.hasClientSecret(),
      encrypted: !!(this.safeStorage && this.safeStorage.isEncryptionAvailable())
    };
  }

  // ----- OAuth -----

  async signIn() {
    const clientId = (this.cfg.clientId || '').trim();
    const clientSecret = this.secrets.clientSecret || '';
    if (!clientId || !clientSecret) throw new Error('Enter your OAuth client ID and client secret first.');

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const scope = [SCOPES[this.cfg.scope] || SCOPES.drive, 'openid', 'email'].join(' ');

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const err = url.searchParams.get('error');
        const ok = !err && url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Quick Notes</title>
<body style="font-family:Segoe UI,sans-serif;background:#1F1F1E;color:#e8e6e3;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#d4a85f">${ok ? 'Signed in to Google Drive' : 'Sign-in failed'}</h2>
<p>${ok ? 'You can close this tab and return to Quick Notes.' : 'Return to Quick Notes and try again.'}</p></div></body>`);
        clearTimeout(timeout);
        server.close();
        if (ok) resolve({ code: url.searchParams.get('code'), redirectUri: server.redirectUri });
        else reject(new Error(err ? `Google returned: ${err}` : 'Sign-in state mismatch.'));
      });
      const timeout = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out.')); }, SIGN_IN_TIMEOUT_MS);
      server.on('error', (e) => { clearTimeout(timeout); reject(e); });
      server.listen(0, '127.0.0.1', () => {
        server.redirectUri = `http://127.0.0.1:${server.address().port}`;
        const auth = new URL(AUTH_URL);
        auth.searchParams.set('client_id', clientId);
        auth.searchParams.set('redirect_uri', server.redirectUri);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('scope', scope);
        auth.searchParams.set('code_challenge', challenge);
        auth.searchParams.set('code_challenge_method', 'S256');
        auth.searchParams.set('access_type', 'offline');
        auth.searchParams.set('prompt', 'consent');
        auth.searchParams.set('state', state);
        this.openExternal(auth.toString());
      });
    });

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret
    });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
    this.secrets.refreshToken = tokens.refresh_token;
    this.secrets.accessToken = tokens.access_token;
    this.secrets.expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
    await this.saveSecrets();

    let email = '';
    try {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (r.ok) email = (await r.json()).email || '';
    } catch { /* email is cosmetic */ }
    this.store.setSettings({ drive: { enabled: true, email } });
    this.setStatus({ lastError: null });
    this.setupAutoSync();
    return { ok: true, email };
  }

  async signOut() {
    const token = this.secrets.refreshToken || this.secrets.accessToken;
    if (token) {
      try {
        await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
      } catch { /* offline: tokens are dropped locally anyway */ }
    }
    delete this.secrets.refreshToken;
    delete this.secrets.accessToken;
    delete this.secrets.expiresAt;
    await this.saveSecrets();
    this.store.setSettings({ drive: { enabled: false, email: '' } });
    this.setupAutoSync();
    this.setStatus({ lastError: null });
    return { ok: true };
  }

  async tokenRequest(params) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Token request failed: ${data.error_description || data.error || resp.status}`);
    return data;
  }

  async accessToken(forceRefresh = false) {
    if (!forceRefresh && this.secrets.accessToken && Date.now() < (this.secrets.expiresAt || 0) - 60_000) {
      return this.secrets.accessToken;
    }
    if (!this.secrets.refreshToken) throw new Error('Not signed in to Google Drive.');
    const data = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this.secrets.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.secrets.clientSecret || ''
    });
    this.secrets.accessToken = data.access_token;
    this.secrets.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    await this.saveSecrets();
    return data.access_token;
  }

  async api(url, options = {}, retry = true) {
    const token = await this.accessToken();
    const resp = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    if (resp.status === 401 && retry) {
      await this.accessToken(true);
      return this.api(url, options, false);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let message = text;
      try { message = JSON.parse(text).error.message; } catch { /* raw text */ }
      throw new DriveError(resp.status, message || resp.statusText);
    }
    return resp;
  }

  explain(e) {
    const msg = String(e && e.message || e);
    if (e && (e.status === 403 || e.status === 404) && this.cfg.scope === 'drive.file') {
      return msg + ' — with the drive.file scope the app can only write into folders it created. Use "Create folder" or switch the scope to full Drive access.';
    }
    return msg;
  }

  // ----- Folder helpers -----

  async testFolder(folderId) {
    const id = String(folderId || this.cfg.folderId || '').trim();
    if (!id) throw new Error('Enter a Google Drive folder ID.');
    const r = await this.api(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`);
    const f = await r.json();
    if (f.mimeType !== 'application/vnd.google-apps.folder') throw new Error('That ID is not a folder.');
    return { id: f.id, name: f.name };
  }

  async createFolder(name) {
    const r = await this.api(`${DRIVE_API}/files?fields=id,name&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Quick Notes', mimeType: 'application/vnd.google-apps.folder' })
    });
    const f = await r.json();
    this.store.setSettings({ drive: { folderId: f.id } });
    return { id: f.id, name: f.name };
  }

  // ----- Upload -----

  canSync() {
    return !!(this.cfg.enabled && this.secrets.refreshToken && this.cfg.folderId);
  }

  scheduleUpload(note) {
    if (!note || !this.canSync()) return;
    clearTimeout(this.timers.get(note.id));
    this.timers.set(note.id, setTimeout(() => {
      this.timers.delete(note.id);
      this.enqueue(note.id, () => this.uploadNow(note.id)).catch(() => {});
    }, UPLOAD_DELAY_MS));
  }

  enqueue(id, fn) {
    const prev = this.queues.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.queues.set(id, run);
    run.finally(() => { if (this.queues.get(id) === run) this.queues.delete(id); }).catch(() => {});
    return run;
  }

  multipart(metadata, markdown) {
    const boundary = 'qn-' + crypto.randomBytes(12).toString('hex');
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${markdown}\r\n--${boundary}--`;
    return { boundary, body };
  }

  async uploadNow(id, { forceCreate = false } = {}) {
    const note = this.store.get(id);
    if (!note) return null;
    if (!this.canSync()) return { skipped: true };
    const name = fm.noteFileName(note.title, note.id);
    const markdown = fm.serializeNote(note);
    const fields = 'id,name,modifiedTime';
    try {
      let file = null;
      if (note.driveFileId && !forceCreate) {
        const packed = this.multipart({ name, mimeType: 'text/markdown' }, markdown);
        try {
          const r = await this.api(`${UPLOAD_API}/files/${encodeURIComponent(note.driveFileId)}?uploadType=multipart&fields=${fields}&supportsAllDrives=true`, {
            method: 'PATCH',
            headers: { 'Content-Type': `multipart/related; boundary=${packed.boundary}` },
            body: packed.body
          });
          file = await r.json();
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      if (!file) {
        const packed = this.multipart({ name, mimeType: 'text/markdown', parents: [this.cfg.folderId] }, markdown);
        const r = await this.api(`${UPLOAD_API}/files?uploadType=multipart&fields=${fields}&supportsAllDrives=true`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${packed.boundary}` },
          body: packed.body
        });
        file = await r.json();
      }
      const live = this.store.get(id);
      if (live) {
        live.driveFileId = file.id;
        live.driveSyncedAt = Date.parse(file.modifiedTime) || Date.now();
        this.store.scheduleSave();
      }
      this.setStatus({ lastSync: new Date().toISOString(), lastError: null });
      return { ok: true, fileId: file.id };
    } catch (e) {
      this.setStatus({ lastError: this.explain(e) });
      throw e;
    }
  }

  async trashFile(note) {
    if (!note || !note.driveFileId || !this.secrets.refreshToken) return;
    clearTimeout(this.timers.get(note.id));
    try {
      await this.api(`${DRIVE_API}/files/${encodeURIComponent(note.driveFileId)}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
    } catch (e) {
      if (e.status !== 404) this.setStatus({ lastError: this.explain(e) });
    }
  }

  async pushAll() {
    if (!this.canSync()) throw new Error('Sign in and set a folder ID first.');
    this.setStatus({ busy: true });
    let count = 0;
    try {
      for (const n of this.store.list()) {
        await this.enqueue(n.id, () => this.uploadNow(n.id));
        count++;
      }
    } finally {
      this.setStatus({ busy: false });
    }
    return { ok: true, count };
  }

  // ----- Download -----

  async listFolder() {
    const files = [];
    let pageToken = '';
    const folder = String(this.cfg.folderId).replace(/'/g, "\\'");
    do {
      const params = new URLSearchParams({
        q: `'${folder}' in parents and trashed = false and (mimeType = 'text/markdown' or name contains '.md')`,
        fields: 'nextPageToken,files(id,name,modifiedTime)',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.api(`${DRIVE_API}/files?${params}`);
      const data = await r.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  // Pull files changed in Drive since our last upload/download.
  async pull() {
    if (!this.canSync()) throw new Error('Sign in and set a folder ID first.');
    this.setStatus({ busy: true });
    let updated = 0, imported = 0;
    try {
      for (const file of await this.listFolder()) {
        const remoteTime = Date.parse(file.modifiedTime) || 0;
        let note = this.store.list().find((n) => n.driveFileId === file.id)
          || this.store.findByIdPrefix(fm.idPrefixFromFileName(file.name));
        if (note && remoteTime <= (note.driveSyncedAt || 0) + 1000) continue;
        if (note && note.updatedAt > remoteTime) continue;

        const r = await this.api(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
        const parsed = fm.parse(await r.text());
        const f = parsed.fields;
        if (note) {
          const derived = deriveTitle(parsed.body);
          this.store.update(note.id, {
            body: parsed.body,
            process: f.process || note.process,
            appName: f.app_name || note.appName,
            extraYaml: f.extraYaml || '',
            tags: f.tags.filter((t) => !fm.REQUIRED_TAGS.includes(t)),
            ...(f.title && f.title !== derived ? { title: f.title, titleLocked: true } : {})
          }, { source: 'drive' });
          updated++;
        } else if (parsed.hasFrontmatter && (f.process || f.tags.includes('quicknotes'))) {
          note = this.store.create({
            body: parsed.body,
            title: f.title || deriveTitle(parsed.body),
            titleLocked: !!f.title && f.title !== deriveTitle(parsed.body),
            process: f.process || '',
            appName: f.app_name || '',
            created: f.created || undefined,
            tags: f.tags.filter((t) => !fm.REQUIRED_TAGS.includes(t)),
            extraYaml: f.extraYaml || '',
            driveFileId: file.id
          }, { source: 'drive' });
          imported++;
        } else {
          continue;
        }
        note.driveFileId = file.id;
        note.driveSyncedAt = remoteTime;
        this.store.scheduleSave();
      }
      this.setStatus({ lastSync: new Date().toISOString(), lastError: null });
    } catch (e) {
      this.setStatus({ lastError: this.explain(e) });
      throw e;
    } finally {
      this.setStatus({ busy: false });
    }
    return { ok: true, updated, imported };
  }

  async syncNow() {
    const pulled = await this.pull();
    const pushed = await this.pushAll();
    return { ok: true, ...pulled, pushed: pushed.count };
  }

  setupAutoSync() {
    clearInterval(this.autoTimer);
    this.autoTimer = null;
    const minutes = Number(this.cfg.autoSyncMinutes) || 0;
    if (minutes > 0 && this.canSync()) {
      this.autoTimer = setInterval(() => this.pull().catch(() => {}), minutes * 60_000);
    }
  }
}

module.exports = { DriveSync };
