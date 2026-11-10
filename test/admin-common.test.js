'use strict';
/* Helpers in admin/common.js, run in a sandbox with a stub document. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommon() {
  const document = { getElementById: () => null, querySelector: () => null };
  const sandbox = { document, window: {}, console };
  vm.createContext(sandbox);
  // `function` declarations in the script become properties of the sandbox.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'admin', 'common.js'), 'utf8'), sandbox);
  return sandbox;
}

test('plural adds an s, or takes the plural it is given', () => {
  const { plural } = loadCommon();
  assert.strictEqual(plural(1, 'item'), '1 item');
  assert.strictEqual(plural(3, 'item'), '3 items');
  assert.strictEqual(plural(0, 'item'), '0 items');
  // Bug: the Items page said "2 categorys".
  assert.strictEqual(plural(1, 'category', 'categories'), '1 category');
  assert.strictEqual(plural(2, 'category', 'categories'), '2 categories');
});

test('admin dialogs stay fixed to the screen, so they open in view on a scrolled page', () => {
  // Bug: .modal had position: relative, which a modal dialog turns into
  // absolute, so on the iPad the Delete dialog opened at the top of the page.
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const css = noComments(fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.css'), 'utf8'));
  const rule = css.match(/\n\.modal \{([^}]*)\}/);
  assert.ok(rule, 'the .modal rule');
  assert.match(rule[1], /position: fixed;/);
  assert.ok(!/position: (relative|absolute|static)/.test(rule[1]));
  for (const file of ['pos.css', 'admin.css']) {
    const other = noComments(fs.readFileSync(path.join(__dirname, '..', 'admin', file), 'utf8'));
    assert.ok(!/\.modal[^{]*\{[^}]*position: relative/.test(other), `${file}: nothing puts it back`);
  }
});

test('the Items page names its categories with the right plural', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin', 'items.js'), 'utf8');
  assert.ok(js.includes("plural(list.length, 'category', 'categories')"));
  assert.ok(!/plural\([^)]*'category'\)/.test(js), 'no "categorys"');
});
