'use strict';
/* Tests for the security-critical pieces: password hashing, CSRF comparison,
   item validation and the image-path containment check.
   Run with:  npm test          (uses a throwaway database) */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the database and cake photos somewhere disposable before anything requires them.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-test-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

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

/* ---------------------------- item stock ---------------------------- */

/** A fresh item, so other tests' orders never count against its limit. */
function stockItem(name, stock = {}) {
  const item = menu.create({ ...base, name, price: 100 });
  return menu.setStock(item.id, { availability: 'available', daily_limit: '', ...stock });
}

function orderOf(item, qty) {
  return orderInput({ items: [{ id: item.id, qty }], expected_total: 100 * qty, cash: 1000 });
}

test('availability and the daily limit are validated', () => {
  const item = stockItem('Stock Check');
  assert.strictEqual(item.availability, 'available');
  assert.strictEqual(item.daily_limit, null, 'blank means no limit');
  assert.strictEqual(item.remaining, null);

  const set = (input) => {
    try { menu.setStock(item.id, input); return null; } catch (err) { return err.errors; }
  };
  assert.ok(set({ availability: 'gone' }).availability);
  for (const bad of ['0', '-1', '2.5', 'ten', '10000']) {
    assert.ok(set({ availability: 'available', daily_limit: bad }).daily_limit, `should reject ${bad}`);
  }
  assert.strictEqual(menu.setStock(item.id, { availability: 'sold_out', daily_limit: '12' }).daily_limit, 12);
  assert.strictEqual(menu.setStock(999999, { availability: 'available' }), null);
  menu.remove(item.id);
});

test('the menu hides items that are not available and greys sold-out ones', () => {
  orders.setDeliveryFee(0);
  const hidden = stockItem('Hidden Frappe', { availability: 'unavailable' });
  const soldOut = stockItem('Gone Frappe', { availability: 'sold_out' });
  const few = stockItem('Few Frappe', { daily_limit: '5' });
  const many = stockItem('Many Frappe', { daily_limit: '6' });

  const html = render.buildHtml();
  assert.ok(!html.includes('Hidden Frappe'), 'not available is left off');
  const card = (name) => html.split('<li class="card').find((c) => c.includes(`data-name="${name}"`));
  assert.match(card('Gone Frappe'), /data-soldout/);
  assert.match(card('Gone Frappe'), /Sold out/);
  assert.ok(!card('Gone Frappe').includes('data-add'), 'a sold-out card has no Add button');
  assert.match(card('Few Frappe'), /data-remaining="5"/);
  assert.match(card('Few Frappe'), /Only 5 left today/);
  assert.match(card('Many Frappe'), /data-remaining="6"/);
  assert.ok(!card('Many Frappe').includes('left today'), 'more than 5 left says nothing');

  // A hand-marked sold out item cannot be ordered.
  assert.throws(() => orders.create(orderOf(soldOut, 1)),
    (err) => err.status === 409 && err.body.quote.unavailable.includes(soldOut.id));
  assert.throws(() => orders.create(orderOf(hidden, 1)),
    (err) => err.status === 409 && err.body.quote.unavailable.includes(hidden.id));
  [hidden, soldOut, few, many].forEach((i) => menu.remove(i.id));
});

test('a daily limit stops orders at capacity and frees up when an order is cancelled', () => {
  orders.setDeliveryFee(0);
  const item = stockItem('Limited Cake', { daily_limit: '3' });

  const first = orders.create(orderOf(item, 2));
  assert.strictEqual(menu.get(item.id).remaining, 1);

  assert.throws(() => orders.create(orderOf(item, 2)), (err) => {
    assert.strictEqual(err.status, 409);
    assert.deepStrictEqual(err.body.quote.limits, { [item.id]: 1 });
    assert.match(err.body.error, /Only 1 Limited Cake left today/);
    return true;
  });

  orders.create(orderOf(item, 1));
  const full = menu.get(item.id);
  assert.strictEqual(full.remaining, 0);
  assert.strictEqual(full.sold_out, true, 'at the limit it reads as sold out');
  assert.strictEqual(full.availability, 'available', 'without changing what the admin set');
  assert.throws(() => orders.create(orderOf(item, 1)),
    (err) => err.status === 409 && err.body.quote.unavailable.includes(item.id));

  orders.setStatus(first.id, 'cancelled');
  assert.strictEqual(menu.get(item.id).remaining, 2, 'a cancelled order gives its quantity back');
  menu.remove(item.id);
});

test('only today\'s orders, in Manila time, count against the limit', () => {
  orders.setDeliveryFee(0);
  const item = stockItem('Daily Pie', { daily_limit: '2' });
  const order = orders.create(orderOf(item, 2));
  assert.strictEqual(menu.get(item.id).sold_out, true);

  // The same order seen from tomorrow (Manila) no longer counts.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  assert.strictEqual(menu.get(item.id, { now: tomorrow }).remaining, 2);

  // And an order from yesterday does not count today.
  db.prepare("UPDATE orders SET created_at = datetime('now', '-1 day') WHERE id = ?").run(order.id);
  assert.strictEqual(menu.get(item.id).remaining, 2);
  menu.remove(item.id);
});

test('the Manila day starts at 16:00 UTC the day before', () => {
  const { manilaDayStartSql, manilaMinutes } = require('../server/clock');
  assert.strictEqual(manilaDayStartSql(new Date(Date.UTC(2026, 9, 23, 4, 0))), '2026-10-22 16:00:00');
  assert.strictEqual(manilaDayStartSql(new Date(Date.UTC(2026, 9, 23, 15, 59))), '2026-10-22 16:00:00');
  assert.strictEqual(manilaDayStartSql(new Date(Date.UTC(2026, 9, 23, 16, 0))), '2026-10-23 16:00:00');
  assert.strictEqual(manilaMinutes(new Date(Date.UTC(2026, 9, 23, 16, 30))), 30);
});

test('items from before availability are kept available with no limit', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-stock-'));
  const dbPath = path.join(dir, 'old.db');

  // The items table as the release before item stock created it.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE categories (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO categories (id, slug, name, label) VALUES (1, 'drinks', 'Drinks', 'Drinks');
    CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    image TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
    crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO items (id, name, price, category_id, image) VALUES (5, 'Kept Frappe', 99, 1, 'assets/Menu Frappe.jpg');`);
  old.close();

  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const menu = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'menu'))});
    const i = menu.get(5);
    console.log(JSON.stringify([i.name, i.availability, i.daily_limit, i.sold_out]));`],
  { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), ['Kept Frappe', 'available', null, false]);
});

/* ---------------------------- promotions ---------------------------- */

const vouchers = require('../server/vouchers');

function itemErrors(input) {
  try { menu.validate(input); return null; } catch (err) { return err.errors; }
}

test('a sale is a percentage or an amount off, and never takes the price to zero', () => {
  assert.ok(itemErrors({ ...base, sale_type: 'half' }).sale);
  assert.ok(itemErrors({ ...base, sale_type: 'percent', sale_value: '' }).sale);
  assert.ok(itemErrors({ ...base, sale_type: 'percent', sale_value: 0 }).sale);
  assert.ok(itemErrors({ ...base, sale_type: 'percent', sale_value: 91 }).sale);
  assert.ok(itemErrors({ ...base, sale_type: 'amount', sale_value: 100 }).sale, 'not the whole Php 100');
  assert.strictEqual(itemErrors({ ...base, sale_type: 'amount', sale_value: 99 }), null);

  const none = menu.validate({ ...base, sale_type: '', sale_value: 50 });
  assert.strictEqual(none.sale_value, null, 'no sale clears the value');

  assert.strictEqual(menu.salePrice({ price: 129, sale_type: 'percent', sale_value: 20 }), 103, 'rounded');
  assert.strictEqual(menu.salePrice({ price: 129, sale_type: 'amount', sale_value: 30 }), 99);
  assert.strictEqual(menu.salePrice({ price: 129, sale_type: '', sale_value: null }), 129);
});

test('best sellers get a badge and sale items show the old price and charge the new one', () => {
  orders.setDeliveryFee(0);
  const star = menu.create({ ...base, name: 'Star Frappe', price: 120, best_seller: true });
  const sale = menu.create({ ...base, name: 'Sale Frappe', price: 129, sale_type: 'percent', sale_value: 20 });
  const plain = menu.create({ ...base, name: 'Plain Frappe', price: 90 });
  assert.strictEqual(star.best_seller, true);
  assert.strictEqual(sale.sale_price, 103);

  const html = render.buildHtml();
  const card = (name) => html.split('<li class="card').find((c) => c.includes(`data-name="${name}"`));
  assert.match(card('Star Frappe'), /data-best/);
  assert.match(card('Star Frappe'), /Best seller/);
  assert.match(card('Sale Frappe'), /data-price="103"/, 'the cart charges the sale price');
  assert.match(card('Sale Frappe'), /data-was="129"/);
  assert.match(card('Sale Frappe'), /<s class="price__was">.*Php 129<\/s>/);
  assert.match(card('Sale Frappe'), /20% off/);
  for (const marker of ['data-best', 'data-was', 'price__was', 'card__sale']) {
    assert.ok(!card('Plain Frappe').includes(marker), `a plain item has no ${marker}`);
  }

  const order = orders.create(orderInput({ items: [{ id: sale.id, qty: 2 }], expected_total: 206, cash: 300 }));
  assert.strictEqual(order.subtotal, 206);
  assert.deepStrictEqual(order.items.map((l) => l.price), [103], 'the order keeps the price charged');

  // Taking the item off sale changes what the next order is charged.
  menu.update(sale.id, { ...base, name: 'Sale Frappe', price: 129 });
  assert.throws(() => orders.create(orderInput({ items: [{ id: sale.id, qty: 1 }], expected_total: 103 })),
    (err) => err.status === 409 && err.body.quote.total === 129);
  [star, sale, plain].forEach((i) => menu.remove(i.id));
});

function voucherErrors(input, id) {
  try { vouchers.validate(input, id); return null; } catch (err) { return err.errors; }
}

test('vouchers are validated: code, amount and dates', () => {
  const ok = { code: 'sweet10', kind: 'percent', value: 10 };
  assert.strictEqual(vouchers.validate(ok).code, 'SWEET10', 'stored in upper case');
  for (const code of ['', 'ab', 'has space', 'x'.repeat(21), 'semi;colon']) {
    assert.ok(voucherErrors({ ...ok, code }).code, `should reject code ${code}`);
  }
  assert.ok(voucherErrors({ ...ok, kind: 'free' }).kind);
  assert.ok(voucherErrors({ ...ok, value: 0 }).value);
  assert.ok(voucherErrors({ ...ok, value: 101 }).value);
  assert.ok(voucherErrors({ ...ok, kind: 'amount', value: '' }).value);
  assert.ok(voucherErrors({ ...ok, max_off: 0 }).max_off);
  assert.strictEqual(vouchers.validate({ ...ok, kind: 'amount', value: 50, max_off: 20 }).max_off, null,
    'the cap is only for percentages');
  assert.ok(voucherErrors({ ...ok, valid_from: '2026-02-30' }).valid_from, 'not a real day');
  assert.ok(voucherErrors({ ...ok, valid_from: '2026-11-10', valid_until: '2026-11-01' }).valid_until);

  const made = vouchers.create(ok);
  assert.ok(voucherErrors({ ...ok, code: 'Sweet10' }).code, 'codes are unique ignoring case');
  assert.strictEqual(voucherErrors({ ...ok, value: 15 }, made.id), null, 'its own code is not a clash');
  vouchers.remove(made.id);
});

test('a voucher code is checked against the day and works out the discount', () => {
  const pct = vouchers.create({ code: 'TENOFF', kind: 'percent', value: 10, max_off: 20 });
  const amt = vouchers.create({ code: 'FIFTY', kind: 'amount', value: 50 });
  const dated = vouchers.create({
    code: 'NOV', kind: 'amount', value: 10, valid_from: '2026-11-01', valid_until: '2026-11-30',
  });

  assert.deepStrictEqual(vouchers.check(' tenoff ', 150), { code: 'TENOFF', label: '10% off (up to Php 20)', discount: 15 });
  assert.strictEqual(vouchers.check('TENOFF', 400).discount, 20, 'capped');
  assert.strictEqual(vouchers.check('FIFTY', 30).discount, 30, 'never more than the items');
  assert.throws(() => vouchers.check('NOPE', 100), (e) => /don't know/.test(e.errors.voucher));

  // Manila is UTC+8: 16:00 UTC on 31 Oct is already 1 Nov in Manila.
  const at = (iso) => new Date(iso);
  assert.throws(() => vouchers.check('NOV', 100, at('2026-10-31T15:59:00Z')),
    (e) => /starts on 1 Nov 2026/.test(e.errors.voucher));
  assert.strictEqual(vouchers.check('NOV', 100, at('2026-10-31T16:00:00Z')).discount, 10);
  assert.strictEqual(vouchers.check('NOV', 100, at('2026-11-30T15:59:00Z')).discount, 10, 'the last day counts');
  assert.throws(() => vouchers.check('NOV', 100, at('2026-11-30T16:00:00Z')),
    (e) => /expired/.test(e.errors.voucher));

  vouchers.setActive(amt.id, false);
  assert.throws(() => vouchers.check('FIFTY', 100), (e) => /not available/.test(e.errors.voucher));
  [pct, amt, dated].forEach((v) => vouchers.remove(v.id));
});

test('an order with a voucher takes it off the items, not the delivery fee', () => {
  orders.setDeliveryFee(40);
  const v = vouchers.create({ code: 'ORDER50', kind: 'amount', value: 50 });

  // Cart: 2 Matcha (258) + 1 sandwich (85) = 343, minus 50, plus the fee of 40.
  const order = orders.create(orderInput({ voucher: 'order50', expected_total: 343 - 50 + 40 }));
  assert.strictEqual(order.discount, 50);
  assert.strictEqual(order.voucher_code, 'ORDER50');
  assert.strictEqual(order.delivery_fee, 40);
  assert.strictEqual(order.total, 333);
  assert.strictEqual(order.change_due, 500 - 333);
  assert.strictEqual(vouchers.get(v.id).uses, 1);

  // Turned off after the customer applied it: refused, and the code is dropped.
  vouchers.setActive(v.id, false);
  assert.throws(() => orders.create(orderInput({ voucher: 'ORDER50', expected_total: 333 })), (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.body.quote.voucher, null);
    assert.strictEqual(err.body.quote.total, 383, 'the new total without the voucher');
    assert.match(err.body.error, /not available/);
    return true;
  });

  orders.setStatus(order.id, 'cancelled');
  assert.strictEqual(vouchers.get(v.id).uses, 0, 'cancelled orders do not count as uses');
  vouchers.remove(v.id);
  assert.strictEqual(orders.get(order.id).voucher_code, 'ORDER50', 'deleting keeps the code on past orders');
  orders.setDeliveryFee(0);
});

test('items and orders from before promotions get empty promotion fields', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-promo-'));
  const dbPath = path.join(dir, 'old.db');

  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE categories (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO categories (id, slug, name, label) VALUES (1, 'drinks', 'Drinks', 'Drinks');
    CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    image TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
    crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL DEFAULT 'available', daily_limit INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO items (id, name, price, category_id, image) VALUES (5, 'Kept Frappe', 99, 1, 'assets/Menu Frappe.jpg');
    CREATE TABLE orders (
    id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
    subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
    cash INTEGER NOT NULL, change_due INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','preparing','delivering','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    order_type TEXT NOT NULL DEFAULT 'delivery', table_no TEXT NOT NULL DEFAULT '', pickup_at TEXT NOT NULL DEFAULT '');
    INSERT INTO orders (id, customer_name, phone, address, subtotal, delivery_fee, total, cash, change_due)
    VALUES (3, 'Old Customer', '09170000000', '1 Old St', 100, 40, 140, 200, 60);`);
  old.close();

  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const menu = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'menu'))});
    const orders = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'orders'))});
    const i = menu.get(5);
    const o = orders.get(3);
    console.log(JSON.stringify([i.best_seller, i.sale_type, i.sale_price, o.voucher_code, o.discount, o.total]));`],
  { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), [false, '', 99, '', 0, 140]);
});

test('the voucher endpoints: public checking with a limit, admin-only managing', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const v = vouchers.create({ code: 'CHECKME', kind: 'percent', value: 10 });
  try {
    const check = (body, headers = { 'Content-Type': 'application/json' }) =>
      fetch(`${url}/api/vouchers/check`, { method: 'POST', headers, body: JSON.stringify(body) });

    const ok = await check({ code: 'checkme', type: 'dinein', items: orderInput().items });
    assert.strictEqual(ok.status, 200);
    const data = await ok.json();
    assert.strictEqual(data.voucher.code, 'CHECKME');
    assert.strictEqual(data.discount, 34, '10% of 343, rounded');
    assert.strictEqual(data.total, 343 - 34, 'dine-in has no fee');

    const unknown = await check({ code: 'NOPE', items: orderInput().items });
    assert.strictEqual(unknown.status, 422);
    assert.match((await unknown.json()).fields.voucher, /don't know/);

    assert.strictEqual((await check({ code: 'CHECKME' }, { 'Content-Type': 'text/plain' })).status, 415);

    // Two checks used above; the 21st check in ten minutes is refused.
    for (let i = 0; i < 18; i++) await check({ code: 'NOPE', items: orderInput().items });
    assert.strictEqual((await check({ code: 'CHECKME', items: orderInput().items })).status, 429);

    assert.strictEqual((await fetch(`${url}/api/vouchers`)).status, 401);
    assert.strictEqual((await fetch(`${url}/api/vouchers`, { method: 'POST' })).status, 401);
    assert.strictEqual((await fetch(`${url}/api/vouchers/${v.id}`, { method: 'DELETE' })).status, 401);
    assert.strictEqual((await fetch(`${url}/api/vouchers/${v.id}/active`, { method: 'PATCH' })).status, 401);
    const page = await fetch(`${url}/admin/vouchers`, { redirect: 'manual' });
    assert.strictEqual(page.status, 302, 'the vouchers page needs sign-in');
  } finally {
    vouchers.remove(v.id);
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---------------------------- cake bookings ---------------------------- */

const cakes = require('../server/cakes');

// Noon in Manila on Fri 23 Oct 2026. With 3 days' notice the earliest day is Mon 26 Oct.
const CAKE_NOW = new Date(Date.UTC(2026, 9, 23, 4, 0));
const PNG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'Sweeter Side - PNG.png'));

function cakeInput(over = {}) {
  return {
    name: ' Ana  Reyes ', phone: '0917 555 1234', size: cakes.settings().sizes[0].name,
    flavour: 'Chocolate', occasion: '7th birthday', cake_message: 'Happy Birthday, Mia!',
    design_notes: 'Pink and gold, unicorn topper', photo: '',
    needed_on: '2026-10-28', handover: 'pickup', address: '', ...over,
  };
}

function cakeErrors(input) {
  try { cakes.create(input, { now: CAKE_NOW }); return null; } catch (err) {
    assert.ok(err instanceof menu.ValidationError, `expected a ValidationError, got ${err.message}`);
    return err.errors;
  }
}

/** Clear bookings between tests so capacity starts empty. */
function clearCakes() {
  db.exec('DELETE FROM cake_bookings');
  cakes.updateSettings({ lead_days: 3, max_per_day: 2 });
}

test('cake settings: notice, capacity, sizes and flavours, validated together', () => {
  const before = cakes.settings();
  assert.ok(before.sizes.length > 0 && before.flavours.length > 0, 'starts with sensible defaults');

  const bad = (input) => { try { cakes.updateSettings(input); return null; } catch (e) { return e.errors; } };
  assert.ok(bad({ lead_days: -1 }).lead_days);
  assert.ok(bad({ lead_days: 61 }).lead_days);
  assert.ok(bad({ max_per_day: 0 }).max_per_day);
  assert.match(bad({ sizes: '8" round | 1200\nNo price here' }).sizes, /Line 2/);
  assert.match(bad({ sizes: 'Big | ten' }).sizes, /whole number/);
  assert.match(bad({ sizes: 'Big | 100\nbig | 200' }).sizes, /twice/);
  assert.ok(bad({ sizes: '\n  \n' }).sizes, 'at least one size');
  assert.ok(bad({ lead_days: 5, sizes: 'oops' }), 'a bad size line blocks the whole save');
  assert.deepStrictEqual(cakes.settings(), before, 'nothing was saved');

  const s = cakes.updateSettings({
    lead_days: '2', max_per_day: '', sizes: '6" round | 850\n8" round (serves 20) | Php 1,200',
    flavours: 'Chocolate\nUbe\n\nchocolate',
  });
  assert.strictEqual(s.lead_days, 2);
  assert.strictEqual(s.max_per_day, null, 'blank means no limit');
  assert.deepStrictEqual(s.sizes, [{ name: '6" round', from_price: 850 }, { name: '8" round (serves 20)', from_price: 1200 }]);
  assert.deepStrictEqual(s.flavours, ['Chocolate', 'Ube'], 'blank lines and repeats dropped');
  clearCakes();
});

test('a cake booking needs the notice period, stays in range and copies the starting price', () => {
  clearCakes();
  const avail = cakes.availability(CAKE_NOW);
  assert.strictEqual(avail.earliest, '2026-10-26');
  assert.strictEqual(avail.latest, '2027-01-24');

  const e = cakeErrors(cakeInput({ name: '', phone: '12', size: 'Huge', flavour: 'Durian', needed_on: '' }));
  assert.ok(e.name && e.phone && e.size && e.flavour && e.needed_on);
  assert.match(cakeErrors(cakeInput({ needed_on: '2026-10-25' })).needed_on, /at least 3 days notice.*Mon 26 Oct/);
  assert.match(cakeErrors(cakeInput({ needed_on: '2027-01-25' })).needed_on, /up to/);
  assert.ok(cakeErrors(cakeInput({ handover: 'delivery' })).address, 'delivery needs an address');
  assert.ok(cakeErrors(cakeInput({ flavour: cakes.OTHER_FLAVOUR, design_notes: '' })).design_notes,
    '"Other" needs the flavour in the notes');
  assert.ok(cakeErrors(cakeInput({ cake_message: 'x'.repeat(81) })).cake_message);

  const size = cakes.settings().sizes[0];
  const b = cakes.create(cakeInput({ needed_on: '2026-10-26' }), { now: CAKE_NOW });
  assert.strictEqual(b.customer_name, 'Ana Reyes');
  assert.strictEqual(b.phone, '09175551234');
  assert.strictEqual(b.size_from_price, size.from_price);
  assert.strictEqual(b.status, 'new');
  assert.strictEqual(b.address, '', 'pick-up keeps no address');

  const other = cakes.create(cakeInput({ flavour: cakes.OTHER_FLAVOUR, design_notes: 'Pandan' }), { now: CAKE_NOW });
  assert.strictEqual(other.flavour, cakes.OTHER_FLAVOUR);
  clearCakes();
});

test('a day is full once it has the most cakes per day, not counting declined ones', () => {
  clearCakes();
  cakes.updateSettings({ max_per_day: 1 });
  const first = cakes.create(cakeInput(), { now: CAKE_NOW });
  assert.deepStrictEqual(cakes.availability(CAKE_NOW).full_dates, ['2026-10-28']);
  assert.match(cakeErrors(cakeInput()).needed_on, /Wed 28 Oct is fully booked/);
  assert.strictEqual(cakeErrors(cakeInput({ needed_on: '2026-10-29' })), null, 'the next day is free');

  cakes.update(first.id, { status: 'declined' });
  assert.ok(!cakes.availability(CAKE_NOW).full_dates.includes('2026-10-28'), 'declining frees the day');
  assert.strictEqual(cakeErrors(cakeInput()), null);

  cakes.updateSettings({ max_per_day: '' });
  assert.deepStrictEqual(cakes.availability(CAKE_NOW).full_dates, [], 'no limit, no full days');
  clearCakes();
});

test('reference photos: only real images, used once, and strays cleared after a day', () => {
  clearCakes();
  assert.strictEqual(cakes.savePhoto(Buffer.from('<?php echo 1; ?>')), null);
  const token = cakes.savePhoto(PNG);
  assert.match(token, /^[a-f0-9]{32}\.png$/);

  for (const bad of ['../../etc/passwd', 'abc.png', `${'0'.repeat(32)}.png`]) {
    assert.ok(cakeErrors(cakeInput({ photo: bad })).photo, `should refuse ${bad}`);
  }
  const b = cakes.create(cakeInput({ photo: token }), { now: CAKE_NOW });
  assert.strictEqual(b.photo, token);
  assert.match(cakeErrors(cakeInput({ photo: token, needed_on: '2026-10-29' })).photo, /already/);

  const stray = cakes.savePhoto(PNG);
  const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(cakes.removeStrayPhotos(new Date()), 0, 'a fresh photo is kept');
  assert.strictEqual(cakes.removeStrayPhotos(later), 1, 'only the unattached one goes');
  assert.strictEqual(cakes.photoPath(stray), null);
  assert.ok(cakes.photoPath(token), 'the attached photo stays');
  clearCakes();
});

test('the admin quotes a price, records the deposit and moves a booking along', () => {
  clearCakes();
  const b = cakes.create(cakeInput(), { now: CAKE_NOW });
  const err = (input) => { try { cakes.update(b.id, input); return null; } catch (e) { return e.errors; } };

  assert.ok(err({ status: 'quoted' }).quoted_price, 'quoting needs a price');
  assert.ok(err({ status: 'baked' }).status);
  assert.ok(err({ quoted_price: 1500, deposit_paid: true }).deposit_amount, 'a received deposit needs an amount');
  assert.ok(err({ quoted_price: 1500, deposit_amount: 2000 }).deposit_amount, 'not more than the price');

  const done = cakes.update(b.id, {
    status: 'confirmed', quoted_price: '1500', deposit_paid: true, deposit_amount: '500', admin_note: 'Gold leaf',
  });
  assert.deepStrictEqual(
    [done.status, done.quoted_price, done.deposit_paid, done.deposit_amount, done.admin_note],
    ['confirmed', 1500, 1, 500, 'Gold leaf']);
  assert.strictEqual(cakes.update(999999, { status: 'new' }), null);

  assert.ok(cakes.list('upcoming', { now: CAKE_NOW }).some((x) => x.id === b.id));
  cakes.update(b.id, { status: 'completed' });
  assert.ok(cakes.list('past', { now: CAKE_NOW }).some((x) => x.id === b.id));
  assert.throws(() => cakes.list('later'), (e) => e.status === 400);
  clearCakes();
});

test('the cake page and endpoints: public booking, private photos, admin-only managing', async () => {
  clearCakes();
  const html = render.buildCakesHtml(CAKE_NOW);
  const size = cakes.settings().sizes[0];
  assert.ok(html.includes(`value="${render.esc(size.name)}"`));
  assert.match(html, new RegExp(`from <strong>Php ${size.from_price.toLocaleString('en-US')}</strong>`));
  assert.match(html, /data-earliest="2026-10-26"/);
  assert.ok(!/<!--[A-Z_]+-->/.test(html), 'every placeholder is filled');

  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(`${url}/cakes`)).status, 200);

    const upload = await fetch(`${url}/api/cakes/photo`, { method: 'POST', body: PNG });
    assert.strictEqual(upload.status, 201);
    const { photo } = await upload.json();
    assert.strictEqual((await fetch(`${url}/api/cakes/photo`, { method: 'POST', body: 'not an image' })).status, 400);

    // Book for a day that is open whatever today's date is.
    const day = cakes.availability().earliest;
    const book = (body, headers = { 'Content-Type': 'application/json' }) =>
      fetch(`${url}/api/cakes`, { method: 'POST', headers, body: JSON.stringify(body) });
    const ok = await book(cakeInput({ photo, needed_on: day }));
    assert.strictEqual(ok.status, 201);
    const { booking } = await ok.json();
    assert.strictEqual(booking.needed_on, day);
    assert.strictEqual(booking.phone, undefined, 'the reply does not echo personal details');

    assert.strictEqual((await book(cakeInput({ needed_on: '2000-01-01' }))).status, 422);
    assert.strictEqual((await book(cakeInput(), { 'Content-Type': 'text/plain' })).status, 415);
    // Only sent bookings count towards the limit of three per ten minutes.
    cakes.updateSettings({ max_per_day: '' });
    assert.strictEqual((await book(cakeInput({ needed_on: day }))).status, 201);
    assert.strictEqual((await book(cakeInput({ needed_on: day }))).status, 201);
    assert.strictEqual((await book(cakeInput({ needed_on: day }))).status, 429, 'three bookings per ten minutes');

    const avail = await (await fetch(`${url}/api/cakes/availability`)).json();
    assert.strictEqual(avail.earliest, day);

    // Photos are never public: not under /assets, and the admin route needs sign-in.
    assert.strictEqual((await fetch(`${url}/api/cakes/${booking.id}/photo`)).status, 401);
    assert.strictEqual((await fetch(`${url}/assets/uploads/${photo}`)).status, 404);
    assert.strictEqual((await fetch(`${url}/api/cakes`)).status, 401);
    assert.strictEqual((await fetch(`${url}/api/cakes/counts`)).status, 401);
    assert.strictEqual((await fetch(`${url}/api/cakes/${booking.id}`, { method: 'PATCH' })).status, 401);
    assert.strictEqual((await fetch(`${url}/api/cake-settings`, { method: 'PUT' })).status, 401);
    const page = await fetch(`${url}/admin/cakes`, { redirect: 'manual' });
    assert.strictEqual(page.status, 302, 'the cakes page needs sign-in');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearCakes();
  }
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
    assert.strictEqual((await fetch(`${url}/api/items/1/stock`, { method: 'PATCH' })).status, 401,
      'changing stock needs sign-in');

    const page = await fetch(`${url}/admin/items`, { redirect: 'manual' });
    assert.strictEqual(page.status, 302, 'the items page needs sign-in');
    assert.match(page.headers.get('location'), /\/admin\/login$/);
    assert.strictEqual((await fetch(`${url}/admin/items.html`)).status, 404,
      'the admin page cannot be fetched as a static file');
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
