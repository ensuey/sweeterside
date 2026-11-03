'use strict';
/* PR D, cart suggestions: up to three "Goes well with" items per category
   and for any order, shipped with the menu, and lines added from them
   counted on the Reports page. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-suggest-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { db, seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const categories = require('../server/categories');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
const reports = require('../server/reports');
const auth = require('../server/auth');
const suggestions = require('../server/suggestions');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const item = (name) => menu.list().find((i) => i.name === name);
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
const cat = (slug) => categories.list().find((c) => c.slug === slug);
let phoneSeq = 10;
const place = (items, expected) => orders.create({
  type: 'dinein', name: 'Ana Reyes', table_no: '4', phone: `0917 123 45${++phoneSeq}`, items, expected_total: expected,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)),
});

test('suggestion lists are checked: up to three, items and categories that exist', () => {
  const drinks = cat('drinks').id;
  const bad = [
    [{ any: [1, 2, 3, 4] }, 'any'], [{ any: [9999] }, 'any'], [{ any: ['abc'] }, 'any'], [{ any: 'x' }, 'any'],
    [{ categories: { 9999: [1] } }, 'categories'], [{ categories: { [drinks]: [1, 2, 3, 4] } }, `cat_${drinks}`],
  ];
  for (const [input, field] of bad) {
    const e = errorsOf(() => suggestions.save(input));
    assert.ok(e && e[field], `${JSON.stringify(input)} should fail on ${field}`);
  }
  assert.deepStrictEqual(suggestions.get(), { any: [], categories: {} }, 'nothing saved by the failures');
});

test('the lists ship with the menu, keyed by category slug; removed items drop out', () => {
  const sandwich = item('Bacon and Egg Sandwich');
  const pasta = item('Beef Penne Pasta');
  const biscoff = item('Biscoff Frappe');
  const saved = suggestions.save({ any: [biscoff.id], categories: { [cat('drinks').id]: [sandwich.id, pasta.id, sandwich.id] } });
  assert.deepStrictEqual(saved.categories[cat('drinks').id], [sandwich.id, pasta.id], 'a repeat counts once');
  const html = render.buildHtml();
  const data = JSON.parse(html.match(/data-suggest="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  assert.deepStrictEqual(data, { any: [biscoff.id], by_cat: { drinks: [sandwich.id, pasta.id] } });
  // The cart strip is there, hidden until the cart has something.
  assert.match(html, /<section class="suggest" id="cart-suggest" aria-labelledby="suggest-title" hidden>/);

  const temp = menu.create({ name: 'Temp Brownie', price: 60, category_id: cat('drinks').id, image: '', alt: '' });
  suggestions.save({ any: [temp.id, biscoff.id] });
  menu.remove(temp.id);
  assert.deepStrictEqual(suggestions.get().any, [biscoff.id]);
});

test('a line added from a suggestion is saved as such; anything else is the menu', () => {
  const matcha = item('Matcha Frappe'); // 129
  const biscoff = item('Biscoff Frappe'); // 129
  const o = place([
    { id: matcha.id, qty: 1 },
    { id: biscoff.id, qty: 1, source: 'suggested' },
    { id: biscoff.id, qty: 1 }, // the same line from the menu: still one suggested line
    { id: item('Bacon and Egg Sandwich').id, qty: 1, source: '<script>' },
  ], 129 * 3 + 85);
  const rows = db.prepare('SELECT item_id, qty, source FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  assert.deepStrictEqual(rows.map((r) => [r.item_id, r.qty, r.source]), [
    [matcha.id, 1, ''], [biscoff.id, 2, 'suggested'], [item('Bacon and Egg Sandwich').id, 1, ''],
  ]);

  // Reports count it once the order is a sale (completed online).
  const day = require('../server/clock').manilaDate(new Date());
  assert.deepStrictEqual(reports.summary({ from: day, to: day }).suggested, { qty: 0, net: 0 });
  db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(o.id);
  assert.deepStrictEqual(reports.summary({ from: day, to: day }).suggested, { qty: 2, net: 129 * 2 * 100 });
});

test('the suggestions endpoints need sign-in and CSRF', async () => {
  const email = 'suggest@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = (method, body, headers = {}) => fetch(`${url}/api/suggestions`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    const body = { any: [item('Matcha Frappe').id] };
    assert.strictEqual((await call('GET')).status, 401);
    assert.strictEqual((await call('PUT', body)).status, 401);
    assert.strictEqual((await call('PUT', body, { Cookie: cookie })).status, 403, 'no CSRF');
    const admin = { Cookie: cookie, 'X-CSRF-Token': csrf };
    assert.strictEqual((await call('PUT', { any: [9999] }, admin)).status, 422);
    const ok = await call('PUT', body, admin);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual((await ok.json()).any, body.any);
    assert.deepStrictEqual((await (await call('GET', undefined, { Cookie: cookie })).json()).any, body.any);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
