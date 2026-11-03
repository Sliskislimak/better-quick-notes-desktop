// frontmatter.js · YAML frontmatter for Obsidian-compatible note files.
//
// Ported from the extension's note-meta.js. The editor works on the note body
// only; this module wraps the body with a frontmatter block on write and
// splits it back out on read. Keys this app does not own (aliases, cssclasses,
// anything a user adds in Obsidian) are kept verbatim, including nested lists.

const OWNED_KEYS = ['title', 'app_name', 'process', 'created', 'updated', 'tags'];
const REQUIRED_TAGS = ['quicknotes', 'desktop-app'];

function escapeYamlQuoted(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function unquoteScalar(value) {
  let v = String(value == null ? '' : value).trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      else v = v.replace(/''/g, "'");
    }
  }
  return v;
}

// Groups the YAML into top-level entries: { key, value, lines[] } where
// lines holds the raw text (the key line plus any indented continuation).
function parseEntries(yaml) {
  const entries = [];
  let cur = null;
  for (const line of String(yaml || '').split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_][A-Za-z0-9_ -]*?)\s*:(?:\s+(.*))?$/);
    if (kv && !/^\s/.test(line)) {
      cur = { key: kv[1], value: (kv[2] || '').trim(), lines: [line], children: [] };
      entries.push(cur);
    } else if (cur && (/^\s/.test(line) || /^-\s/.test(line))) {
      cur.lines.push(line);
      cur.children.push(line);
    } else if (line.trim()) {
      // Comment or stray line: keep it attached so it round-trips.
      cur = { key: null, value: '', lines: [line], children: [] };
      entries.push(cur);
    }
  }
  return entries;
}

function parseTags(entry) {
  const tags = [];
  const inline = entry.value.match(/^\[([\s\S]*)\]$/);
  if (inline) {
    inline[1].split(',').forEach((part) => { const t = unquoteScalar(part); if (t) tags.push(t); });
  } else if (entry.value) {
    const t = unquoteScalar(entry.value);
    if (t) tags.push(t);
  }
  for (const child of entry.children) {
    const m = child.match(/^\s*-\s+(.*)$/);
    if (m) { const t = unquoteScalar(m[1]); if (t) tags.push(t); }
  }
  return tags;
}

// Returns { fields, body, hasFrontmatter }.
function parse(markdown) {
  const text = String(markdown == null ? '' : markdown).replace(/^\uFEFF/, '');
  const match = text.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/);
  const fields = { title: '', app_name: '', process: '', created: '', updated: '', tags: [], extraYaml: '' };
  if (!match) return { fields, body: text, hasFrontmatter: false };

  const extras = [];
  for (const entry of parseEntries(match[1])) {
    if (entry.key === 'tags') fields.tags = parseTags(entry);
    else if (entry.key && OWNED_KEYS.includes(entry.key)) fields[entry.key] = unquoteScalar(entry.value);
    else extras.push(entry.lines.join('\n'));
  }
  fields.extraYaml = extras.join('\n');
  return { fields, body: text.slice(match[0].length), hasFrontmatter: true };
}

function formatTag(tag) {
  const clean = escapeYamlQuoted(tag);
  if (!clean) return null;
  if (/[:#{}[\],&*!|>%@`"]|^\s|\s$|^'/.test(clean)) return '"' + clean + '"';
  return clean;
}

function build(fields) {
  const tags = [];
  for (const t of [...REQUIRED_TAGS, ...(fields.tags || [])]) {
    if (t && !tags.includes(t)) tags.push(t);
  }
  const lines = [
    '---',
    `title: "${escapeYamlQuoted(fields.title)}"`,
    `app_name: "${escapeYamlQuoted(fields.app_name)}"`,
    `process: "${escapeYamlQuoted(fields.process)}"`,
    `created: "${escapeYamlQuoted(fields.created)}"`,
    `updated: "${escapeYamlQuoted(fields.updated)}"`,
    'tags:'
  ];
  for (const t of tags) {
    const rendered = formatTag(t);
    if (rendered) lines.push('  - ' + rendered);
  }
  if (fields.extraYaml && fields.extraYaml.trim()) lines.push(fields.extraYaml.replace(/\s+$/, ''));
  lines.push('---');
  return lines.join('\n') + '\n';
}

// Note object -> full Markdown file contents.
function serializeNote(note) {
  return build({
    title: note.title || 'Untitled',
    app_name: note.appName || '',
    process: note.process || '',
    created: note.created || new Date().toISOString(),
    updated: note.updated || new Date().toISOString(),
    tags: note.tags || [],
    extraYaml: note.extraYaml || ''
  }) + (note.body || '');
}

// OS filename stem. Replaces <>:"/\|?* with hyphens, strips control chars
// and trailing dots/spaces, caps the length to stay inside MAX_PATH.
function sanitizeFileTitle(title) {
  let s = String(title == null ? '' : title).replace(/[\u0000-\u001F\u007F]/g, '');
  s = s.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/g, '');
  return s || 'note';
}

function noteFileName(title, noteId) {
  const id = String(noteId == null ? '' : noteId).slice(0, 6) || 'note';
  return `${sanitizeFileTitle(title)}_${id}.md`;
}

// "My note_3fa9c1.md" -> "3fa9c1"
function idPrefixFromFileName(fileName) {
  const m = String(fileName || '').match(/_([A-Za-z0-9]{6})\.md$/i);
  return m ? m[1] : null;
}

module.exports = {
  parse,
  build,
  serializeNote,
  sanitizeFileTitle,
  noteFileName,
  idPrefixFromFileName,
  REQUIRED_TAGS
};
