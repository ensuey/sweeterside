'use strict';
/* Menu and cart polish: suggestions skip what a chosen option already gives,
   cards say how many are in the cart, Add to cart stays in view in the item
   popup, and the cart's - and + are 44 px. The browser code is checked from
   its source; the word matching runs for real. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const cart = fs.readFileSync(path.join(root, 'assets', 'js', 'cart.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets', 'css', 'styles.css'), 'utf8');

/** The cart's own words() function, run outside the browser. */
function wordsFn() {
  const src = /function words\(text\) \{[\s\S]*?\n  \}/.exec(cart);
  assert.ok(src, 'cart.js has words()');
  return vm.runInNewContext(`(${src[0]})`);
}

test('an option like "Fries & nuggets" covers the Fries and Chicken Nuggets items', () => {
  const words = wordsFn();
  const chosen = new Set(words('Fries & nuggets'));
  const covered = (name) => words(name).some((w) => chosen.has(w));
  assert.strictEqual(covered('Fries'), true);
  assert.strictEqual(covered('Chicken Nuggets (5pcs)'), true);
  assert.strictEqual(covered('Matcha Frappe'), false);
  assert.strictEqual(covered('Iced Tea'), false, 'short words do not match');
  assert.strictEqual(words('').length, 0);
});

test('suggestions leave out items a chosen option already gives', () => {
  const body = /function suggestions\(\) \{[\s\S]*?\n  \}/.exec(cart)[0];
  assert.match(body, /optionsText\(l\)/);
  assert.match(body, /words\(item\.name\)\.some/);
});

test('menu cards show how many are in the cart, kept up to date on every change', () => {
  assert.match(cart, /function renderInCart\(\)/);
  assert.match(cart, /renderSuggest\(\);\s*renderInCart\(\);/);
  assert.match(cart, /n \+ ' in cart'/);
  assert.match(cart, /tag\.textContent = /, 'set as text, never as HTML');
  assert.match(css, /\.card__incart \{/);
});

test('the item popup keeps Add to cart in view, and the photo leaves room for it', () => {
  assert.match(css, /\.sheet__add \{ position: sticky; bottom:/);
  assert.match(css, /\.sheet \.shot--plain \{ width: 100%; max-height: 42vh; \}/);
});

test('the cart - and + buttons are at least 44 px', () => {
  assert.match(css, /\.stepper__btn \{\s*width: 44px; height: 44px;/);
});
