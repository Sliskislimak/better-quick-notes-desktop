const test = require('node:test');
const assert = require('node:assert');
const { render, toggleCheck } = require('../renderer/shared/markdown');

test('toggleCheck flips unchecked task to checked', () => {
  const src = 'Todo\n- [ ] buy milk\n- [ ] eggs';
  const next = toggleCheck(src, 1);
  assert.strictEqual(next, 'Todo\n- [x] buy milk\n- [ ] eggs');
});

test('toggleCheck flips checked task back to unchecked', () => {
  const src = '- [x] done\n- [ ] open';
  assert.strictEqual(toggleCheck(src, 0), '- [ ] done\n- [ ] open');
});

test('toggleCheck accepts * and + bullets and X mark', () => {
  assert.strictEqual(toggleCheck('* [ ] a', 0), '* [x] a');
  assert.strictEqual(toggleCheck('+ [X] b', 0), '- [ ] b');
});

test('toggleCheck ignores non-checklist lines and bad indexes', () => {
  const src = 'plain\n- not a task';
  assert.strictEqual(toggleCheck(src, 0), src);
  assert.strictEqual(toggleCheck(src, 1), src);
  assert.strictEqual(toggleCheck(src, 99), src);
  assert.strictEqual(toggleCheck(src, -1), src);
});

test('toggleCheck preserves sibling lines and indentation', () => {
  const src = '  - [ ] nested\n\n## Head\n- [x] other';
  assert.strictEqual(toggleCheck(src, 0), '  - [x] nested\n\n## Head\n- [x] other');
  assert.strictEqual(toggleCheck(src, 3), '  - [ ] nested\n\n## Head\n- [ ] other');
});

test('render marks checked lines with done class and data-line', () => {
  const html = render('- [ ] open\n- [x] closed');
  assert.match(html, /data-line="0"/);
  assert.match(html, /data-line="1"/);
  assert.match(html, /chk-line done/);
  assert.match(html, /chk-line"/);
  assert.match(html, /checked/);
  assert.match(html, /closed/);
});

test('render applies strikethrough-ready structure for checked text', () => {
  const html = render('- [x] ship it');
  assert.match(html, /class="chk-line done"/);
  assert.match(html, /<span class="txt">ship it<\/span>/);
});

test('round-trip: toggle then render reflects new state', () => {
  let body = '- [ ] one\n- [ ] two';
  body = toggleCheck(body, 1);
  const html = render(body);
  assert.ok(html.includes('data-line="1"') && html.includes('chk-line done'));
  assert.ok(html.includes('[x]') === false); // marker is in source, not raw in preview text span
  assert.match(html, /class="chk-line done"[^>]*>[\s\S]*two/);
  body = toggleCheck(body, 1);
  assert.strictEqual(body, '- [ ] one\n- [ ] two');
});
