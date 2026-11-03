const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fm = require('../services/frontmatter');
const { NoteStore, deriveTitle } = require('../services/noteStore');

const sample = {
  id: 'a1b2c3d4e5f6',
  title: 'Sprint "plan": Q3',
  body: '# Sprint plan\n\n- one\n- two\n',
  appName: 'Visual Studio Code',
  process: 'Code.exe',
  created: '2026-01-02T03:04:05.000Z',
  updated: '2026-01-03T03:04:05.000Z',
  tags: [],
  extraYaml: ''
};

test('serializeNote writes the exact frontmatter layout', () => {
  const md = fm.serializeNote(sample);
  const head = md.split('\n').slice(0, 11).join('\n');
  assert.strictEqual(head, [
    '---',
    'title: "Sprint \\"plan\\": Q3"',
    'app_name: "Visual Studio Code"',
    'process: "Code.exe"',
    'created: "2026-01-02T03:04:05.000Z"',
    'updated: "2026-01-03T03:04:05.000Z"',
    'tags:',
    '  - quicknotes',
    '  - desktop-app',
    '---',
    '# Sprint plan'
  ].join('\n'));
});

test('parse round-trips fields and body', () => {
  const md = fm.serializeNote({ ...sample, tags: ['work'], extraYaml: 'aliases:\n  - sp' });
  const { fields, body, hasFrontmatter } = fm.parse(md);
  assert.ok(hasFrontmatter);
  assert.strictEqual(fields.title, sample.title);
  assert.strictEqual(fields.app_name, sample.appName);
  assert.strictEqual(fields.process, 'Code.exe');
  assert.deepStrictEqual(fields.tags, [...fm.REQUIRED_TAGS, 'work']);
  assert.match(fields.extraYaml, /aliases:/);
  assert.strictEqual(body, sample.body);
});

test('parse ignores --- that is not at the start of the file', () => {
  const r = fm.parse('hello\n---\nnot yaml\n---\n');
  assert.ok(!r.hasFrontmatter);
  assert.strictEqual(r.body, 'hello\n---\nnot yaml\n---\n');
});

test('parse handles CRLF files edited on Windows', () => {
  const r = fm.parse('---\r\ntitle: "X"\r\nprocess: "a.exe"\r\n---\r\nbody\r\n');
  assert.strictEqual(r.fields.title, 'X');
  assert.strictEqual(r.fields.process, 'a.exe');
  assert.strictEqual(r.body, 'body\r\n');
});

test('noteFileName sanitizes and uses the 6-char id prefix', () => {
  assert.strictEqual(fm.noteFileName('a<b>c:d"e/f\\g|h?i*j', 'abcdef123456'), 'a-b-c-d-e-f-g-h-i-j_abcdef.md');
  assert.strictEqual(fm.idPrefixFromFileName('My note_abcdef.md'), 'abcdef');
  assert.match(fm.noteFileName('', 'abcdef99'), /_abcdef\.md$/);
});

test('deriveTitle uses the first non-empty line', () => {
  assert.strictEqual(deriveTitle('\n\n## Hello world  \nmore'), 'Hello world');
  assert.strictEqual(deriveTitle(''), 'Untitled');
});

test('NoteStore create/update/remove and persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-test-'));
  const store = new NoteStore(dir);
  await store.load();
  const n = store.create({ body: 'First line\nsecond', process: 'Code.exe', appName: 'VS Code' });
  assert.strictEqual(n.title, 'First line');
  assert.strictEqual(n.id.length >= 6, true);
  const before = n.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.update(n.id, { body: 'Renamed\nx' });
  assert.strictEqual(store.get(n.id).title, 'Renamed');
  assert.ok(store.get(n.id).updatedAt > before);
  store.update(n.id, { title: 'Locked', titleLocked: true });
  store.update(n.id, { body: 'Other' });
  assert.strictEqual(store.get(n.id).title, 'Locked');
  assert.strictEqual(store.forProcess('code.EXE').length, 1);
  const m = store.create({ body: 'b', process: 'Code.exe' });
  assert.notStrictEqual(m.id.slice(0, 6), n.id.slice(0, 6));
  await store.flush();

  const again = new NoteStore(dir);
  await again.load();
  assert.strictEqual(again.list().length, 2);
  again.remove(n.id);
  assert.strictEqual(again.list().length, 1);
  await again.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});
