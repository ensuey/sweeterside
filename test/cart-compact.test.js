'use strict';
/* The compact checkout in the cart: a pinned footer with the button, the
   lines folded behind a count, and the optional extras (cash for change, a
   voucher code) folded into one row each. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-cart-compact-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { seedIfEmpty } = require('../server/db');
const render = require('../server/render');
seedIfEmpty();

const ROOT = path.join(__dirname, '..');
const CART_JS = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'cart.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'styles.css'), 'utf8');
const formOf = (html) => html.match(/<form class="checkout" id="checkout"[\s\S]*?<\/form>/)[0];

test('every element cart.js looks up is on the menu page', () => {
  const html = render.buildHtml();
  const ids = [...new Set([...CART_JS.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 30);
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, []);
});

test('the button sits in a pinned footer outside the form, and still submits it', () => {
  const html = render.buildHtml();
  assert.ok(!formOf(html).includes('checkout-submit'), 'not inside the form');
  const foot = html.match(/<div class="cart__foot" id="cart-foot" hidden>[\s\S]*?<\/div>/)[0];
  assert.match(foot, /<button class="checkout__submit" type="submit" form="checkout" id="checkout-submit">/);
  assert.match(CSS, /\.cart__foot \{[^}]*position: sticky; bottom: 0;/);
  // Focus and error scrolling keep fields clear of the pinned footer.
  assert.match(CSS, /\.cart \{[^}]*scroll-padding: \d+px 0 \d+px;/);
  // The "all fields are required" line is gone; optional fields say so.
  assert.ok(!html.includes('checkout__req'));
});

test('the cart lines fold behind a count, open for a short cart', () => {
  const html = render.buildHtml();
  assert.match(html, /<details class="cart__items" id="cart-items" open>\s*<summary class="cart__items-sum">/);
  assert.match(html, /<details class="cart__items"[\s\S]*?<ul class="cart__lines" id="cart-lines"><\/ul>\s*<\/details>/);
  assert.match(CART_JS, /\$\('cart-items'\)\.open = lines\.length <= ITEMS_OPEN_MAX;/);
});

test('cash for change and the voucher code are folded rows; no required field is ever folded', () => {
  const form = formOf(render.buildHtml());
  const folds = [...form.matchAll(/<details[\s\S]*?<\/details>/g)].map((m) => m[0]);
  assert.strictEqual(folds.length, 2);
  const [cash, voucher] = folds;
  assert.match(cash, /^<details class="more" id="cash-more" data-for="delivery">/);
  assert.match(cash, /<input id="o-cash"/);
  assert.match(voucher, /^<details class="more" id="v-more">/);
  assert.match(voucher, /<input id="v-code"/);
  for (const fold of folds) {
    assert.ok(!/\sopen[\s>]/.test(fold.split('>')[0]), 'closed to start with');
    assert.ok(!/\srequired[\s>]/.test(fold), 'a required field is never hidden in a fold');
  }
  // The old tick box is gone.
  assert.ok(!form.includes('v-have'));
});

test('an error inside a folded row opens it', () => {
  const show = CART_JS.match(/function showErrors\(fields\) \{[\s\S]*?\n  \}/)[0];
  assert.match(show, /var fold = p\.closest\('details'\);\s*if \(fold\) fold\.open = true;/);
});
