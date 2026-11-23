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

test('the menu hero is short on a phone: logo beside the name, a one-line tagline, a one-line status', () => {
  const tpl = fs.readFileSync(path.join(root, 'templates', 'menu.html'), 'utf8');
  assert.match(tpl, /<header class="hero hero--home">\s*<div class="wrap">\s*<div class="hero__brand">\s*<img class="hero__logo"[^>]*>\s*<h1 class="hero__title">Sweeter Side<\/h1>\s*<\/div>/);
  const sub = /<p class="hero__sub">([^<]*)<\/p>/.exec(tpl)[1];
  assert.ok(sub.length <= 60, `tagline kept short (${sub.length})`);
  assert.match(css, /\.hero__brand \{ display: flex;/);
  const hours = fs.readFileSync(path.join(root, 'assets', 'js', 'hours.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'server', 'render.js'), 'utf8');
  for (const src of [hours, render]) assert.ok(!src.includes('Tap Add on anything'), 'status says only the closing time');
});

test('checkout: "+ delivery" while the fee is still to come, and only then', () => {
  const src = /function feeNote\(kind, a, sub, freeOver, otherStart\) \{[\s\S]*?\n  \}/.exec(cart);
  assert.ok(src, 'cart.js has feeNote()');
  const feeNote = vm.runInNewContext(`(${src[0]})`);
  const area = { fee: 40 };
  const other = { other: true, fee: 0 };
  assert.strictEqual(feeNote('delivery', null, 300, null, null), ' + delivery', 'no area yet');
  assert.strictEqual(feeNote('delivery', null, 1500, 1000, null), '', 'over the free-delivery minimum');
  assert.strictEqual(feeNote('delivery', null, 500, 1000, null), ' + delivery', 'under it');
  assert.strictEqual(feeNote('delivery', area, 300, null, null), '', 'an area with its fee in the total');
  assert.strictEqual(feeNote('delivery', other, 300, null, null), ' + delivery', 'Other area, fee by phone');
  assert.strictEqual(feeNote('delivery', other, 300, null, 50), '', 'Other area with a starting fee in the total');
  assert.strictEqual(feeNote('pickup', null, 300, null, null), '', 'pick-up has no fee');
  assert.match(cart, /money\(total\(\)\) \+ feeLater;/);
});

test('checkout: Place order is pinned in the cart only, solid while sending', () => {
  assert.match(css, /\.cart \.checkout__submit \{ position: sticky;/);
  assert.doesNotMatch(css, /^\.checkout__submit \{ position: sticky/m, 'the cake page button stays in place');
  assert.match(css, /\.cart \.checkout__submit:disabled \{ opacity: 1;/);
  assert.match(css, /scroll-padding-bottom: 128px;/);
});

test('popups open as page elements (recorded by Clarity), with the modal behaviour rebuilt', () => {
  const modal = fs.readFileSync(path.join(root, 'assets', 'js', 'modal.js'), 'utf8');
  const menu = fs.readFileSync(path.join(root, 'assets', 'js', 'menu.js'), 'utf8');
  const tpl = fs.readFileSync(path.join(root, 'templates', 'menu.html'), 'utf8');
  for (const src of [menu, cart]) assert.ok(!/\.showModal\(\)/.test(src), 'no top-layer popups');
  assert.match(menu, /ssModal\.open\(sheet\)/);
  assert.match(cart, /ssModal\.open\(dialog\)/);
  assert.match(modal, /dialog\.show\(\);/);
  assert.match(modal, /el\.inert = true;/, 'the page behind is inert');
  assert.match(modal, /e\.key !== 'Escape'/, 'Esc closes');
  assert.match(modal, /scrim\.addEventListener\('click'/, 'tapping the dimmed page closes');
  assert.ok(tpl.indexOf('assets/js/modal.js') < tpl.indexOf('assets/js/menu.js'), 'loaded before menu.js');
  assert.match(css, /\.scrim \{ position: fixed; inset: 0;/);
});
