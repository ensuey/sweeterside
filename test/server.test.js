'use strict';
/* Tests for the security-critical pieces: password hashing, CSRF comparison,
   item validation and the image-path containment check.
   Run with:  npm test          (uses a throwaway database) */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the database somewhere disposable before anything requires it.
process.env.DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-test-')), 'test.db');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const menu = require('../server/menu');
const categories = require('../server/categories');
const render = require('../server/render');
const orders = require('../server/orders');
const imagesize = require('../server/imagesize');

seedIfEmpty();
const DRINKS_ID = db.prepare("SELECT id FROM categories WHERE slug = 'drinks'").get().id;

/* ---------------------------- passwords ---------------------------- */

test('password hash verifies and is salted', () => {
  const a = auth.hashPassword('a-long-enough-password');
  const b = auth.hashPassword('a-long-enough-password');
  assert.notStrictEqual(a, b, 'same password must not produce the same hash');
  assert.ok(auth.verifyPassword('a-long-enough-password', a));
  assert.ok(auth.verifyPassword('a-long-enough-password', b));
});

test('password verify rejects wrong passwords and junk hashes', () => {
  const hash = auth.hashPassword('correct-password-here');
  assert.strictEqual(auth.verifyPassword('wrong-password-here', hash), false);
  assert.strictEqual(auth.verifyPassword('correct-password-here', 'garbage'), false);
  assert.strictEqual(auth.verifyPassword('correct-password-here', ''), false);
  assert.strictEqual(auth.verifyPassword('', hash), false);
});

/* ---------------------------- CSRF ---------------------------- */

test('CSRF comparison rejects missing, wrong and truncated tokens', () => {
  const session = { csrf: 'abcdefghijklmnop' };
  assert.ok(auth.csrfOk(session, 'abcdefghijklmnop'));
  assert.strictEqual(auth.csrfOk(session, 'abcdefghijklmnoX'), false);
  assert.strictEqual(auth.csrfOk(session, 'abcdefgh'), false);
  assert.strictEqual(auth.csrfOk(session, undefined), false);
  assert.strictEqual(auth.csrfOk(null, 'abcdefghijklmnop'), false);
});

/* ---------------------------- cookies ---------------------------- */

test('cookie parser handles multiple pairs and missing header', () => {
  assert.deepStrictEqual(auth.parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepStrictEqual(auth.parseCookies(''), {});
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
});

test('session cookie is HttpOnly and SameSite=Strict', () => {
  const c = auth.sessionCookie('tok', { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(auth.sessionCookie('tok', { secure: false }), /Secure/);
});

/* ---------------------------- image paths ---------------------------- */

test('image paths outside assets/ are rejected', () => {
  for (const bad of [
    '../server/db.js', 'assets/../server/db.js', '/etc/passwd',
    'server/db.js', '', null, 'assets/does-not-exist.jpg',
  ]) {
    assert.strictEqual(menu.resolveImage(bad), null, `should reject: ${bad}`);
  }
});

test('a real asset resolves and reports its size', () => {
  const img = menu.resolveImage('assets/Menu Frappe.jpg');
  assert.ok(img, 'expected the poster to resolve');
  assert.strictEqual(img.width, 1021);
  assert.strictEqual(img.height, 1434);
});

/* ---------------------------- validation ---------------------------- */

const base = {
  name: 'Test Item', price: 100, category_id: DRINKS_ID,
  image: 'assets/Menu Frappe.jpg', alt: 'x',
};

function errorsFor(input) {
  try {
    menu.validate(input);
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError);
    return err.errors;
  }
}

test('a valid item passes and normalises', () => {
  const row = menu.validate({ ...base, name: '  Spaced  ' });
  assert.strictEqual(row.name, 'Spaced');
  assert.strictEqual(row.crop_w, null, 'no crop given means no crop stored');
});

test('bad prices are rejected', () => {
  assert.ok(errorsFor({ ...base, price: 'abc' }).price);
  assert.ok(errorsFor({ ...base, price: -5 }).price);
  assert.ok(errorsFor({ ...base, price: 1.5 }).price);
  assert.ok(errorsFor({ ...base, price: '' }).price);
});

test('bad categories and empty names are rejected', () => {
  assert.ok(errorsFor({ ...base, category_id: 99999 }).category);
  assert.ok(errorsFor({ ...base, category_id: 'drinks' }).category);
  assert.ok(errorsFor({ ...base, name: '   ' }).name);
  assert.ok(errorsFor({ ...base, name: 'x'.repeat(81) }).name);
});

test('crop must be complete and inside the image', () => {
  assert.ok(errorsFor({ ...base, crop_x: 10 }).crop, 'partial crop rejected');
  assert.ok(errorsFor({ ...base, crop_x: 0, crop_y: 0, crop_w: 2000, crop_h: 100 }).crop);
  assert.ok(errorsFor({ ...base, crop_x: 0, crop_y: 0, crop_w: 0, crop_h: 10 }).crop);
  assert.ok(errorsFor({ ...base, crop_x: -1, crop_y: 0, crop_w: 10, crop_h: 10 }).crop);

  const ok = menu.validate({ ...base, crop_x: 113, crop_y: 530, crop_w: 184, crop_h: 245 });
  assert.strictEqual(ok.crop_w, 184);
});

/* ---------------------------- categories ---------------------------- */

function categoryErrors(input, id) {
  try {
    categories.validate(input, id);
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError);
    return err.errors;
  }
}

test('the seed creates the two poster categories with every item in one', () => {
  const list = categories.list();
  assert.deepStrictEqual(list.slice(0, 2).map((c) => c.slug), ['drinks', 'food']);
  assert.strictEqual(list[0].item_count + list[1].item_count, 9);
});

test('category names are required, bounded and unique ignoring case', () => {
  assert.ok(categoryErrors({ name: '  ' }).name);
  assert.ok(categoryErrors({ name: 'x'.repeat(61) }).name);
  assert.ok(categoryErrors({ name: 'FOOD' }).name, 'case-insensitive clash');
  assert.ok(categoryErrors({ name: 'Desserts', label: 'x'.repeat(31) }).label);

  const food = categories.list().find((c) => c.slug === 'food');
  assert.strictEqual(categoryErrors({ name: 'Food' }, food.id), null, 'own name is not a clash');
  assert.strictEqual(categories.validate({ name: 'Desserts' }).label, 'Desserts',
    'blank label falls back to the name');
});

test('slugs are unique and avoid ids the page already uses', () => {
  assert.strictEqual(categories.slugify('Food'), 'food-2');
  assert.strictEqual(categories.slugify('Menu'), 'menu-2');
  assert.strictEqual(categories.slugify('All'), 'all-2');
  assert.strictEqual(categories.slugify('Crème Brûlée!'), 'creme-brulee');
  assert.strictEqual(categories.slugify('☕☕'), 'category');
});

test('a category can be created, renamed and deleted; its slug never changes', () => {
  const cat = categories.create({ name: 'Desserts', label: 'Sweets' });
  assert.strictEqual(cat.slug, 'desserts');
  assert.strictEqual(cat.item_count, 0);

  const renamed = categories.update(cat.id, { name: 'Cakes', label: '' });
  assert.strictEqual(renamed.name, 'Cakes');
  assert.strictEqual(renamed.label, 'Cakes');
  assert.strictEqual(renamed.slug, 'desserts', 'renaming must not break #desserts links');

  assert.strictEqual(categories.remove(cat.id), true);
  assert.strictEqual(categories.get(cat.id), null);
  assert.strictEqual(categories.remove(cat.id), false);
  assert.strictEqual(categories.update(cat.id, { name: 'Gone' }), null);
});

test('a category with items cannot be deleted', () => {
  assert.throws(() => categories.remove(DRINKS_ID), (err) => err.status === 409);
  assert.ok(categories.get(DRINKS_ID), 'still there');
  assert.ok(menu.list().some((i) => i.category_id === DRINKS_ID), 'items untouched');
});

test('reordering categories changes the order of the customer menu', () => {
  const ids = categories.list().map((c) => c.id);
  const reversed = [...ids].reverse();
  categories.reorder(reversed);
  try {
    assert.deepStrictEqual(categories.list().map((c) => c.id), reversed);
    const html = render.buildHtml();
    assert.ok(html.indexOf('id="food"') < html.indexOf('id="drinks"'));
    assert.throws(() => categories.reorder(ids.slice(1)), (err) => err.status === 409,
      'a partial list is refused');
  } finally {
    categories.reorder(ids);
  }
});

test('the customer page escapes category names and hides empty categories', () => {
  const cat = categories.create({ name: '<b>Empty</b>' });
  try {
    const html = render.buildHtml();
    assert.doesNotMatch(html, /<b>Empty<\/b>/);
    assert.doesNotMatch(html, /data-filter="b-empty-b"/, 'no chip for an empty category');

    const item = menu.create({ ...base, category_id: cat.id });
    const withItem = render.buildHtml();
    assert.match(withItem, /&lt;b&gt;Empty&lt;\/b&gt;/);
    assert.match(withItem, /data-filter="b-empty-b"/);
    menu.remove(item.id);
  } finally {
    categories.remove(cat.id);
  }
});

test('a database from before editable categories is migrated with its items', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-'));
  const dbPath = path.join(dir, 'old.db');

  // Build the old schema by hand, exactly as the previous release created it.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('drinks','food')),
    image TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
    crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO items (id, name, price, category, image, position) VALUES
      (7, 'Old Frappe', 120, 'drinks', 'assets/Menu Frappe.jpg', 0),
      (8, 'Old Pasta', 130, 'food', 'assets/Meals.jpg', 0);`);
  old.close();

  // Open it with the current code in a fresh process (db.js migrates on load).
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    console.log(JSON.stringify(db.prepare(
      'SELECT i.id, i.name, c.slug FROM items i JOIN categories c ON c.id = i.category_id ORDER BY i.id'
    ).all()));`], { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), [
    { id: 7, name: 'Old Frappe', slug: 'drinks' },
    { id: 8, name: 'Old Pasta', slug: 'food' },
  ]);
});

/* ---------------------------- orders ---------------------------- */

function menuItem(name) {
  return menu.list().find((i) => i.name === name);
}

function orderInput(over = {}) {
  const matcha = menuItem('Matcha Frappe');      // Php 129
  const sandwich = menuItem('Bacon and Egg Sandwich'); // Php 85
  return {
    name: '  Juan   dela Cruz ', phone: '0917 123-4567', address: '12 Mabini St, Brgy. Uno',
    cash: 500,
    items: [{ id: matcha.id, qty: 2 }, { id: sandwich.id, qty: 1 }],
    expected_total: 129 * 2 + 85 + orders.getDeliveryFee(),
    ...over,
  };
}

function orderErrors(input) {
  try {
    orders.create(input);
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError, `expected a ValidationError, got ${err.message}`);
    return err.errors;
  }
}

test('the delivery fee defaults to zero and only takes whole pesos in range', () => {
  assert.strictEqual(orders.getDeliveryFee(), 0);
  for (const bad of ['', null, 'abc', 1.5, -1, 10001]) {
    assert.throws(() => orders.setDeliveryFee(bad), menu.ValidationError, `should reject ${bad}`);
  }
  assert.strictEqual(orders.setDeliveryFee('45'), 45);
  assert.strictEqual(orders.getDeliveryFee(), 45);
  assert.match(render.buildHtml(), /data-delivery-fee="45"/, 'the page carries the fee');
});

test('an order is priced from the database, not from the browser', () => {
  orders.setDeliveryFee(50);
  const order = orders.create(orderInput({
    // Prices sent by the browser are ignored outright.
    items: orderInput().items.map((l) => ({ ...l, price: 1 })),
    cash: 1000,
  }));
  assert.strictEqual(order.subtotal, 129 * 2 + 85);
  assert.strictEqual(order.delivery_fee, 50);
  assert.strictEqual(order.total, 393);
  assert.strictEqual(order.change_due, 1000 - 393);
  assert.strictEqual(order.customer_name, 'Juan dela Cruz', 'whitespace tidied');
  assert.strictEqual(order.phone, '09171234567', 'spaces and dashes removed');
  assert.strictEqual(order.status, 'new');
  assert.deepStrictEqual(order.items.map((l) => [l.name, l.qty, l.price]),
    [['Matcha Frappe', 2, 129], ['Bacon and Egg Sandwich', 1, 85]]);
});

test('an order whose total the customer did not see is refused with the new prices', () => {
  orders.setDeliveryFee(60);
  assert.throws(() => orders.create(orderInput({ expected_total: 129 * 2 + 85 + 50 })), (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.body.quote.delivery_fee, 60);
    assert.strictEqual(err.body.quote.total, 129 * 2 + 85 + 60);
    return true;
  });
});

test('an item removed from the menu is reported, not silently dropped', () => {
  const temp = menu.create({ ...base, name: 'Soon Gone' });
  const input = orderInput({ items: [{ id: temp.id, qty: 1 }, ...orderInput().items] });
  menu.remove(temp.id);
  assert.throws(() => orders.create(input), (err) => {
    assert.strictEqual(err.status, 409);
    assert.deepStrictEqual(err.body.quote.unavailable, [temp.id]);
    return true;
  });
});

test('order details are required and checked', () => {
  orders.setDeliveryFee(0);
  const e = orderErrors(orderInput({ name: ' ', phone: '12', address: '', cash: '' }));
  assert.ok(e.name && e.phone && e.address && e.cash);

  assert.ok(orderErrors(orderInput({ items: [] })).items, 'empty cart');
  assert.ok(orderErrors(orderInput({ items: 'lots' })).items, 'not an array');
  assert.ok(orderErrors(orderInput({ items: [{ id: 1, qty: 0 }] })).items, 'zero quantity');
  assert.ok(orderErrors(orderInput({ items: [{ id: 1, qty: 51 }] })).items, 'too many of one item');
  assert.ok(orderErrors(orderInput({ cash: 12.5 })).cash, 'cash must be whole pesos');

  const short = orderErrors(orderInput({ cash: 100 }));
  assert.match(short.cash, /Php 343/, 'the error names the total');
});

test('order status moves through the queue', () => {
  const order = orders.create(orderInput({ expected_total: 343 }));
  assert.ok(orders.list('active').some((o) => o.id === order.id));

  assert.strictEqual(orders.setStatus(order.id, 'completed').status, 'completed');
  assert.ok(!orders.list('active').some((o) => o.id === order.id));
  assert.ok(orders.list('finished').some((o) => o.id === order.id));

  assert.throws(() => orders.setStatus(order.id, 'eaten'), menu.ValidationError);
  assert.strictEqual(orders.setStatus(999999, 'new'), null);
  assert.throws(() => orders.list('everything'), (err) => err.status === 400);
});

test('deleting a menu item keeps past orders of it', () => {
  const temp = menu.create({ ...base, name: 'Limited Frappe', price: 150 });
  const order = orders.create(orderInput({
    items: [{ id: temp.id, qty: 1 }], expected_total: 150, cash: 150,
  }));
  menu.remove(temp.id);
  const kept = orders.get(order.id);
  assert.deepStrictEqual(kept.items.map((l) => [l.item_id, l.name, l.price]), [[null, 'Limited Frappe', 150]]);
  assert.strictEqual(kept.change_due, 0);
});

/* ---------------------------- order types ---------------------------- */

// Noon in Manila (UTC+8), and the cart from orderInput() without the fee.
const MANILA_NOON = new Date(Date.UTC(2026, 9, 23, 4, 0));
const ITEMS_TOTAL = 129 * 2 + 85;

function pickupInput(over = {}) {
  return orderInput({
    type: 'pickup', address: '', cash: '', pickup_at: '13:00', expected_total: ITEMS_TOTAL, ...over,
  });
}

function dineinInput(over = {}) {
  return orderInput({
    type: 'dinein', phone: '', address: '', cash: '', table_no: ' 4 ', expected_total: ITEMS_TOTAL, ...over,
  });
}

function pickupErrors(input, now = MANILA_NOON) {
  try {
    orders.create(input, { now });
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError, `expected a ValidationError, got ${err.message}`);
    return err.errors;
  }
}

test('pick-up and dine-in pay no delivery fee and keep only their own details', () => {
  orders.setDeliveryFee(50);

  const pickup = orders.create(pickupInput(), { now: MANILA_NOON });
  assert.strictEqual(pickup.order_type, 'pickup');
  assert.strictEqual(pickup.delivery_fee, 0);
  assert.strictEqual(pickup.total, ITEMS_TOTAL);
  assert.strictEqual(pickup.pickup_at, '13:00');
  assert.strictEqual(pickup.phone, '09171234567');
  assert.strictEqual(pickup.address, '', 'no address is kept');
  assert.strictEqual(pickup.cash, 0, 'pays at the counter');
  assert.strictEqual(pickup.change_due, 0);

  const dinein = orders.create(dineinInput({ phone: '0917 000 0000', address: 'ignored' }));
  assert.strictEqual(dinein.order_type, 'dinein');
  assert.strictEqual(dinein.delivery_fee, 0);
  assert.strictEqual(dinein.table_no, '4', 'trimmed');
  assert.strictEqual(dinein.phone, '', 'dine-in keeps no phone');
  assert.strictEqual(dinein.address, '');

  // The total the customer saw must match the fee for the type they chose.
  assert.throws(() => orders.create(dineinInput({ expected_total: ITEMS_TOTAL + 50 })),
    (err) => err.status === 409 && err.body.quote.delivery_fee === 0);
  assert.strictEqual(orders.create(orderInput({ expected_total: ITEMS_TOTAL + 50 })).delivery_fee, 50,
    'a missing type is still a delivery');
  orders.setDeliveryFee(0);
});

test('each order type asks only for its own details', () => {
  const p = pickupErrors(pickupInput({ phone: '', pickup_at: '' }));
  assert.deepStrictEqual(Object.keys(p).sort(), ['phone', 'pickup_at']);

  const d = orderErrors(dineinInput({ table_no: '  ' }));
  assert.deepStrictEqual(Object.keys(d), ['table_no']);
  assert.ok(orderErrors(dineinInput({ table_no: 'x'.repeat(11) })).table_no, 'table number is short');

  assert.ok(orderErrors(orderInput({ type: 'takeaway' })).type, 'unknown type');
});

test('pick-up times must be today, within hours, on the quarter hour and not too soon', () => {
  orders.updateSettings({ pickup_open: '10:00', pickup_close: '20:00' });

  for (const bad of ['9:45', '09:45', '20:15', '13:10', '12:00', '12:05', 'noon', '25:00']) {
    assert.ok(pickupErrors(pickupInput({ pickup_at: bad })), `should reject ${bad} at noon`);
  }
  for (const ok of ['12:15', '20:00', 'asap']) {
    assert.strictEqual(pickupErrors(pickupInput({ pickup_at: ok })), null, `should accept ${ok} at noon`);
  }

  // Before opening and after closing there is no "as soon as possible".
  const early = new Date(Date.UTC(2026, 9, 23, 0, 30)); // 08:30 in Manila
  const late = new Date(Date.UTC(2026, 9, 23, 12, 30)); // 20:30 in Manila
  assert.ok(pickupErrors(pickupInput({ pickup_at: 'asap' }), early).pickup_at);
  assert.strictEqual(pickupErrors(pickupInput({ pickup_at: '10:00' }), early), null, 'opening time is fine');
  assert.ok(pickupErrors(pickupInput({ pickup_at: 'asap' }), late).pickup_at);
});

test('order types can be turned off and the page only offers the ones on', () => {
  orders.updateSettings({ delivery_enabled: false, dinein_enabled: '0' });
  assert.deepStrictEqual(orders.enabledTypes(), ['pickup']);
  assert.match(render.buildHtml(), /data-order-types="pickup"/);
  assert.ok(orderErrors(orderInput()).type, 'delivery refused while off');
  assert.ok(orderErrors(dineinInput()).type, 'dine-in refused while off');

  orders.updateSettings({ delivery_enabled: true, pickup_enabled: true, dinein_enabled: true });
  assert.deepStrictEqual(orders.enabledTypes(), ['delivery', 'pickup', 'dinein']);
});

test('ordering settings are validated together, so a bad value never half-applies', () => {
  const before = orders.settings();
  assert.throws(() => orders.updateSettings({ delivery_enabled: false, pickup_open: '10:07' }),
    (err) => err instanceof menu.ValidationError && Boolean(err.errors.pickup_open));
  assert.throws(() => orders.updateSettings({ pickup_open: '18:00', pickup_close: '09:00' }),
    (err) => err instanceof menu.ValidationError && Boolean(err.errors.pickup_close));
  assert.throws(() => orders.updateSettings({ dinein_enabled: 'maybe' }), menu.ValidationError);
  assert.deepStrictEqual(orders.settings(), before, 'nothing was saved');

  const html = render.buildHtml();
  assert.match(html, /data-pickup-open="10:00"/);
  assert.match(html, /data-pickup-close="20:00"/);
});

test('orders from before order types are kept as delivery orders', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-orders-'));
  const dbPath = path.join(dir, 'old.db');

  // The orders table exactly as the delivery-only release created it.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
    subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
    cash INTEGER NOT NULL, change_due INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','preparing','delivering','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO orders (id, customer_name, phone, address, subtotal, delivery_fee, total, cash, change_due)
    VALUES (3, 'Old Customer', '09170000000', '1 Old St', 100, 40, 140, 200, 60);`);
  old.close();

  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    console.log(JSON.stringify(db.prepare(
      'SELECT id, order_type, table_no, pickup_at, address FROM orders').all()));`],
  { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), [
    { id: 3, order_type: 'delivery', table_no: '', pickup_at: '', address: '1 Old St' },
  ]);
});

test('the order endpoints: public placing, admin-only reading', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const place = (body, headers = { 'Content-Type': 'application/json' }) =>
      fetch(`${url}/api/orders`, { method: 'POST', headers, body: JSON.stringify(body) });

    const ok = await place(orderInput({ expected_total: 343 }));
    assert.strictEqual(ok.status, 201);
    const { order } = await ok.json();
    assert.strictEqual(order.total, 343);
    assert.strictEqual(order.change_due, 157);
    assert.strictEqual(order.phone, undefined, 'the reply does not echo personal details');

    const bad = await place(orderInput({ cash: 1 }));
    assert.strictEqual(bad.status, 422);
    assert.ok((await bad.json()).fields.cash);

    const stale = await place(orderInput({ expected_total: 1 }));
    assert.strictEqual(stale.status, 409);
    assert.strictEqual((await stale.json()).quote.total, 343);

    const form = await place(orderInput(), { 'Content-Type': 'text/plain' });
    assert.strictEqual(form.status, 415, 'a cross-site form post is refused');

    // Four more placed orders reach the limit of five in ten minutes.
    for (let i = 0; i < 4; i++) assert.strictEqual((await place(orderInput({ expected_total: 343 }))).status, 201);
    assert.strictEqual((await place(orderInput({ expected_total: 343 }))).status, 429);

    assert.strictEqual((await fetch(`${url}/api/orders`)).status, 401, 'orders list needs sign-in');
    assert.strictEqual((await fetch(`${url}/api/orders/1`, { method: 'PATCH' })).status, 401);
    assert.strictEqual((await fetch(`${url}/api/settings`, { method: 'PUT' })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---------------------------- image sniffing ---------------------------- */

test('non-image bytes are not recognised as images', () => {
  assert.strictEqual(imagesize.fromBuffer(Buffer.from('<?php echo 1; ?>')), null);
  assert.strictEqual(imagesize.fromBuffer(Buffer.alloc(0)), null);
  assert.strictEqual(imagesize.fromBuffer(Buffer.from('GIF89a')), null);
});

test('real PNG and JPEG headers are read', () => {
  const root = path.join(__dirname, '..');
  const png = imagesize.fromFile(path.join(root, 'assets', 'Sweeter Side - PNG.png'));
  assert.deepStrictEqual([png.type, png.width, png.height], ['png', 1563, 1563]);
  const jpg = imagesize.fromFile(path.join(root, 'assets', 'Meals.jpg'));
  assert.deepStrictEqual([jpg.type, jpg.width, jpg.height], ['jpeg', 1021, 1434]);
});
