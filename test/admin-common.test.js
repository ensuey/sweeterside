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

test('finished orders: today as cards, earlier days as rows that open into the card', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin', 'orders.js'), 'utf8');
  assert.match(js, /state\.ordersShow === 'finished' \? finishedHtml\(state\.orders\) : state\.orders\.map\(orderHtml\)/,
    'the active queue stays all cards');
  assert.match(js, /todays\.map\(orderHtml\)/, 'today: cards');
  assert.match(js, /<details class="orow"[^`]*\$\{openRows\.has\(o\.id\) \? ' open' : ''\}/, 'earlier: a row, kept open across refreshes');
  assert.match(js, /<ul class="orow__card">\$\{orderHtml\(o\)\}<\/ul>/, 'opening a row shows the full card (status, Delete…)');
  assert.match(js, /<span class="orow__name">\$\{esc\(who\)\}<\/span>/, 'the customer name is escaped');
  assert.match(js, /toLocaleDateString\('en-CA', \{ timeZone: 'Asia\/Manila' \}\)/, 'days are Manila days');
  assert.match(js, /unpaid: 'GCash not paid'/);
});

test('the Items page names its categories with the right plural', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin', 'items.js'), 'utf8');
  assert.ok(js.includes("plural(list.length, 'category', 'categories')"));
  assert.ok(!/plural\([^)]*'category'\)/.test(js), 'no "categorys"');
});

test('an owner PIN prompt keeps asking after a wrong PIN until it goes through or is cancelled', () => {
  // A capped loop (3 tries) used one try for the first ask, one for the wrong
  // PIN and one for the second ask, so the right PIN was never sent.
  for (const f of ['pos.js', 'pos-pay.js', 'pos-credit.js']) {
    const js = fs.readFileSync(path.join(__dirname, '..', 'admin', f), 'utf8');
    assert.ok(!/for \(let attempt = 0; attempt < \d+; attempt\+\+\)/.test(js), `${f}: no capped retry loop`);
    assert.ok(js.includes('askOverride'), `${f} asks for the owner's PIN`);
  }
});
