'use strict';
/* Inventory (server/stock.js): counted items take their count from stock
   takes, batches and orders; ingredients that are out make their items sold
   out. The menu, the checkout and the POS all refuse what is not in the shop.
   Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-inventory-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const orders = require('../server/orders');
const menu = require('../server/menu');
const audit = require('../server/audit');
const stock = require('../server/stock');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const checkout = require('../server/checkout');
const render = require('../server/render');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
shifts.open({ opening_cash: 1000 }, cashier);

const item = (name) => menu.list().find((i) => i.name === name);
const SANDWICH = 'Bacon and Egg Sandwich'; // Php 85, the counted item in these tests
const MATCHA = 'Matcha Frappe'; // Php 129
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
const line = (name, qty = 1) => ({ key: `k${++seq}`, item_id: item(name).id, qty });
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}
/** A POS takeout of qty of one item, sent to the kitchen and not paid. */
const posOrder = (name, qty, by = cashier) => pos.save(null, {
  request_key: key(), type: 'pickup', customer_name: '', lines: [line(name, qty)], send: true,
}, by).order;
const payCash = (o) => payments.pay(o.id, { request_key: key(), payments: [{ method: 'cash', amount: o.total }] }, cashier);
const left = (name) => item(name).stock_left;
/** An online dine-in order, as the checkout sends it. */
const onlineInput = (lines) => ({
  type: 'dinein', name: 'Guest', phone: '', address: '', cash: '', table_no: '3',
  items: lines.map(([name, qty]) => ({ id: item(name).id, qty })),
  expected_total: lines.reduce((sum, [name, qty]) => sum + item(name).sale_price * qty, 0),
  checkout_token: checkout.issue(new Date(Date.now() - 10000)),
});

test('items are not counted until a stock take', () => {
  const s = item(SANDWICH);
  assert.deepStrictEqual([s.stock_left, s.remaining, s.sold_out, s.missing_ingredients], [null, null, false, []]);
  assert.strictEqual(stock.level(s.id), null);
  const e = errorOf(() => stock.change(s.id, { action: 'add', qty: 5 }, cashier));
  assert.ok(e.errors.qty.includes('stock take first'), 'a batch needs a count to add to');
});

test('a stock take sets the count; orders hold, payments and completion keep it taken; cancels give it back', () => {
  const id = item(SANDWICH).id;
  assert.strictEqual(stock.change(id, { action: 'count', qty: 6 }, cashier).left, 6);
  assert.deepStrictEqual([left(SANDWICH), item(SANDWICH).remaining, item(SANDWICH).left_by], [6, 6, 'stock']);

  const a = posOrder(SANDWICH, 2);
  assert.strictEqual(left(SANDWICH), 4, 'an open order holds its units');
  payCash(a);
  assert.strictEqual(left(SANDWICH), 4, 'paid: handed over, still taken');

  const b = posOrder(SANDWICH, 1);
  orders.setStatus(b.id, 'completed');
  assert.strictEqual(left(SANDWICH), 3);
  orders.setStatus(b.id, 'preparing');
  assert.strictEqual(left(SANDWICH), 3, 'back from completed: held again, not given back');
  orders.setStatus(b.id, 'completed');

  const c = posOrder(SANDWICH, 2);
  assert.strictEqual(left(SANDWICH), 1);
  pos.voidOrder(c.id, { reason: 'customer left', override: { staff_id: owner.id, pin: '2580' } }, cashier);
  assert.strictEqual(left(SANDWICH), 3, 'a voided order gives its units back');

  assert.strictEqual(stock.change(id, { action: 'add', qty: 4 }, cashier).left, 7, 'a batch from the oven');
});

test('at zero the item is sold out online and at the POS', () => {
  const id = item(SANDWICH).id;
  stock.change(id, { action: 'count', qty: 1 }, cashier);
  const s = item(SANDWICH);
  assert.deepStrictEqual([s.remaining, s.sold_out], [1, false]);

  // Online: more than is left is cut down, with "left" (not "left today").
  const short = errorOf(() => orders.create(onlineInput([[SANDWICH, 2]])));
  assert.strictEqual(short.status, 409);
  assert.match(short.body.error, /^Only 1 Bacon and Egg Sandwich left\. /);

  const placed = orders.create(onlineInput([[SANDWICH, 1]]));
  assert.ok(placed.id);
  assert.deepStrictEqual([left(SANDWICH), item(SANDWICH).sold_out], [0, true], 'the last one is held by the order');

  const gone = errorOf(() => orders.create(onlineInput([[SANDWICH, 1]])));
  assert.strictEqual(gone.status, 409, 'nothing left: the online order is refused');
  assert.deepStrictEqual(gone.body.quote.unavailable, [id]);

  const counter = errorOf(() => posOrder(SANDWICH, 1));
  assert.match(counter.errors.lines, /sold out/, 'the POS refuses it too');

  // The card on the menu page says Sold out and cannot be added.
  const html = render.buildHtml();
  const card = html.slice(html.indexOf(`data-id="${id}"`), html.indexOf('</article>', html.indexOf(`data-id="${id}"`)));
  assert.ok(card.includes('data-soldout') && card.includes('card__soldout'));

  // Cancelling the online order puts it back.
  orders.setStatus(placed.id, 'cancelled', { reason: 'customer' });
  assert.deepStrictEqual([left(SANDWICH), item(SANDWICH).sold_out], [1, false]);
});

test('a stock take counts what is in the shop, including orders set aside', () => {
  const id = item(SANDWICH).id;
  stock.change(id, { action: 'count', qty: 10 }, cashier);
  const held = posOrder(SANDWICH, 3); // set aside, not handed over yet
  assert.strictEqual(left(SANDWICH), 7);
  // Someone recounts the case: 10 are there (the 3 are still on the shelf).
  stock.change(id, { action: 'count', qty: 10 }, cashier);
  assert.strictEqual(left(SANDWICH), 7, 'the 3 set aside are not free to sell');
  payCash(held);
  assert.strictEqual(left(SANDWICH), 7, 'handing them over changes nothing free to sell');
  // Later the case holds 7: a recount agrees.
  assert.strictEqual(stock.change(id, { action: 'count', qty: 7 }, cashier).left, 7);
});

test('a stock take in the same second as a sale counts it once', () => {
  // Bug: comparing timestamps (to the second) took sales paid in the same
  // second as the stock take off the new count as well.
  const id = item(SANDWICH).id;
  stock.change(id, { action: 'count', qty: 5 }, cashier);
  payCash(posOrder(SANDWICH, 2));
  stock.change(id, { action: 'count', qty: 3 }, cashier); // what is on the shelf now
  assert.strictEqual(left(SANDWICH), 3);
  payCash(posOrder(SANDWICH, 1));
  assert.strictEqual(left(SANDWICH), 2, 'only sales after the stock take come off it');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'count' AND handed IS NULL").get().n, 0);
});

test('a daily limit and a count together: the lower one wins, and says which', () => {
  const id = item(SANDWICH).id;
  stock.change(id, { action: 'count', qty: 50 }, cashier);
  menu.setStock(id, { availability: 'available', daily_limit: String(item(SANDWICH).sold_today + 2) });
  assert.deepStrictEqual([item(SANDWICH).remaining, item(SANDWICH).left_by, menu.leftText(item(SANDWICH))], [2, 'day', 'left today']);
  menu.setStock(id, { availability: 'available', daily_limit: '' });
  assert.deepStrictEqual([item(SANDWICH).remaining, menu.leftText(item(SANDWICH))], [50, 'left']);
});

test('a pre-order for a later day takes from the same count', () => {
  const id = item(SANDWICH).id;
  stock.change(id, { action: 'count', qty: 2 }, cashier);
  const later = menu.get(id, { date: '2099-01-01' });
  assert.strictEqual(later.remaining, 2, 'the count is the same whatever the day');
  posOrder(SANDWICH, 2);
  assert.strictEqual(menu.get(id, { date: '2099-01-01' }).sold_out, true);
});

test('stopping the count makes the item unlimited again', () => {
  const id = item(SANDWICH).id;
  assert.strictEqual(stock.change(id, { action: 'off' }, null), null);
  assert.deepStrictEqual([left(SANDWICH), item(SANDWICH).remaining], [null, null]);
  assert.strictEqual(stock.change(id, { action: 'off' }, null), null, 'stopping twice is harmless');
});

test('stock changes are checked, audited, and a repeated request adds once', () => {
  const id = item(SANDWICH).id;
  for (const bad of [-1, 1.5, '3x', 10000, null, '']) {
    assert.ok(errorOf(() => stock.change(id, { action: 'count', qty: bad }, cashier)).errors.qty, `count ${bad}`);
  }
  const start = stock.change(id, { action: 'count', qty: 5 }, cashier).left; // 5 less what open orders hold
  assert.ok(errorOf(() => stock.change(id, { action: 'add', qty: 0 }, cashier)).errors.qty, 'a batch is at least 1');
  assert.ok(errorOf(() => stock.change(id, { action: 'delete' }, cashier)).errors.action);
  assert.ok(errorOf(() => stock.change(id, { action: 'add', qty: 1, request_key: "x'; DROP" }, cashier)).errors.request_key);
  assert.strictEqual(stock.change(999999, { action: 'count', qty: 1 }, cashier), undefined);

  const k = key();
  assert.strictEqual(stock.change(id, { action: 'add', qty: 3, request_key: k }, cashier).left, start + 3);
  assert.strictEqual(stock.change(id, { action: 'add', qty: 3, request_key: k }, cashier).left, start + 3, 'the same request twice adds once');

  const entry = audit.list({ action: 'stock_add' })[0];
  assert.strictEqual(entry.staff_name, 'Ana');
  assert.deepStrictEqual(entry.details, { item_id: id, item: SANDWICH, qty: 3, left_before: start, left_after: start + 3 });
  assert.ok(audit.list({ action: 'stock_count' }).length >= 1);
});

test('an ingredient that is out makes every item that needs it sold out', () => {
  const oreo = stock.createIngredient({ name: '  Oreo   crumbs ' });
  assert.strictEqual(oreo.name, 'Oreo crumbs');
  const matcha = item(MATCHA);
  menu.update(matcha.id, { ...matcha, ingredients: [oreo.id] });
  assert.deepStrictEqual(stock.itemIngredientIds(matcha.id), [oreo.id]);
  assert.strictEqual(item(MATCHA).sold_out, false);

  stock.setIngredientStock(oreo.id, false, cashier);
  const out = item(MATCHA);
  assert.deepStrictEqual([out.sold_out, out.missing_ingredients], [true, ['Oreo crumbs']]);
  assert.match(errorOf(() => posOrder(MATCHA, 1)).errors.lines, /sold out/, 'the POS refuses it');
  const online = errorOf(() => orders.create(onlineInput([[MATCHA, 1]])));
  assert.deepStrictEqual(online.body.quote.unavailable, [matcha.id], 'so does the checkout');
  assert.strictEqual(audit.list({ action: 'ingredient_change' })[0].details.in_stock, false);

  stock.setIngredientStock(oreo.id, true, cashier);
  assert.strictEqual(item(MATCHA).sold_out, false, 'back in stock: back on sale');

  // Saving the item without the field keeps its ingredients.
  menu.update(matcha.id, { ...item(MATCHA), ingredients: undefined });
  assert.deepStrictEqual(stock.itemIngredientIds(matcha.id), [oreo.id]);

  // Deleting the ingredient frees the item.
  stock.setIngredientStock(oreo.id, false, null);
  assert.strictEqual(stock.removeIngredient(oreo.id), true);
  assert.strictEqual(item(MATCHA).sold_out, false);
});

test('ingredient names and item links are checked', () => {
  const bad = (input) => errorOf(() => stock.createIngredient(input)).errors.name;
  assert.ok(bad({ name: '' }));
  assert.ok(bad({ name: 'x'.repeat(41) }));
  stock.createIngredient({ name: 'Milk' });
  assert.ok(bad({ name: 'MILK' }), 'names are unique, whatever the case');
  assert.ok(errorOf(() => stock.setIngredientStock(stock.listIngredients()[0].id, 'no')).errors.in_stock);
  const matcha = item(MATCHA);
  assert.ok(errorOf(() => menu.update(matcha.id, { ...matcha, ingredients: [999999] })).errors.ingredients);
  assert.ok(errorOf(() => menu.update(matcha.id, { ...matcha, ingredients: 'oreo' })).errors.ingredients);
});

test('the admin and POS endpoints need sign-in, CSRF, a PIN and the right role', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = 'inventory@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const call = (p, { method = 'GET', body, staffToken, noCsrf, noCookie } = {}) => fetch(`${url}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(noCookie ? {} : { Cookie: cookie }), ...(noCsrf ? {} : { 'X-CSRF-Token': csrf }),
      ...(staffToken ? { 'X-Staff-Token': staffToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const id = item(SANDWICH).id;
  try {
    // Items page (admin session).
    assert.strictEqual((await call(`/api/items/${id}/count`, { method: 'POST', body: { action: 'count', qty: 4 }, noCookie: true })).status, 401);
    assert.strictEqual((await call(`/api/items/${id}/count`, { method: 'POST', body: { action: 'count', qty: 4 }, noCsrf: true })).status, 403);
    const counted = await call(`/api/items/${id}/count`, { method: 'POST', body: { action: 'count', qty: 4 } });
    assert.strictEqual(counted.status, 200);
    assert.strictEqual((await counted.json()).level.left, 4 - stock.level(id).held);
    assert.strictEqual((await call(`/api/items/${id}/count`, { method: 'POST', body: { action: 'count', qty: -4 } })).status, 422);
    assert.strictEqual((await call('/api/items/999999/count', { method: 'POST', body: { action: 'count', qty: 1 } })).status, 404);
    const items = await (await call('/api/items')).json();
    assert.strictEqual(items.items.find((i) => i.id === id).stock.counted, 4);

    assert.strictEqual((await call('/api/ingredients', { method: 'POST', body: { name: 'Biscoff' }, noCsrf: true })).status, 403);
    const made = await call('/api/ingredients', { method: 'POST', body: { name: 'Biscoff' } });
    assert.strictEqual(made.status, 201);
    const biscoff = (await made.json()).ingredient;
    const half = await call(`/api/ingredients/${biscoff.id}`, { method: 'PATCH', body: { name: 'Lotus Biscoff', in_stock: 'no' } });
    assert.strictEqual(half.status, 422);
    assert.strictEqual(stock.getIngredient(biscoff.id).name, 'Biscoff', 'a bad request saves nothing');
    assert.strictEqual((await call(`/api/ingredients/${biscoff.id}`, { method: 'PATCH', body: { in_stock: false } })).status, 200);
    assert.strictEqual(stock.getIngredient(biscoff.id).in_stock, false);

    // POS: locked without a PIN; waiters cannot change stock; cashiers can.
    assert.strictEqual((await call('/api/pos/stock', { method: 'POST', body: { item_id: id, action: 'add', qty: 1 } })).status, 423);
    const unlock = (s, pin) => call('/api/pos/unlock', { method: 'POST', body: { staff_id: s.id, pin } }).then((r) => r.json());
    const ben = await unlock(waiter, '4702');
    const ana = await unlock(cashier, '3691');
    assert.ok(!ben.permissions.includes('manage_stock') && ana.permissions.includes('manage_stock'));
    const denied = await call('/api/pos/stock', { method: 'POST', body: { item_id: id, action: 'add', qty: 1 }, staffToken: ben.token });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual((await call('/api/pos/stock', { method: 'POST', body: { item_id: id, action: 'off' }, staffToken: ana.token })).status, 422,
      'the counter can add or recount, not stop counting');
    const added = await call('/api/pos/stock', { method: 'POST', body: { item_id: id, action: 'add', qty: 2, request_key: key() }, staffToken: ana.token });
    assert.strictEqual(added.status, 200);
    const addedBody = await added.json();
    assert.strictEqual(addedBody.level.left, 6 - stock.level(id).held);
    assert.strictEqual(addedBody.items.find((i) => i.id === id).stock_left, 6 - stock.level(id).held);
    assert.strictEqual(audit.list({ action: 'stock_add' })[0].staff_name, 'Ana');

    assert.strictEqual((await call(`/api/pos/ingredients/${biscoff.id}`, { method: 'POST', body: { in_stock: true }, staffToken: ben.token })).status, 403);
    const back = await call(`/api/pos/ingredients/${biscoff.id}`, { method: 'POST', body: { in_stock: true }, staffToken: ana.token });
    assert.strictEqual(back.status, 200);
    assert.strictEqual(stock.getIngredient(biscoff.id).in_stock, true);

    const posMenu = await (await call('/api/pos/menu', { staffToken: ana.token })).json();
    assert.ok(posMenu.ingredients.some((g) => g.name === 'Biscoff' && g.in_stock));
    const s = posMenu.items.find((i) => i.id === id);
    assert.deepStrictEqual([s.counted, s.stock_left], [true, 6 - stock.level(id).held]);

    // The customer page shows "Only N left" (not "left today") for a low count.
    stock.change(id, { action: 'count', qty: 3 + stock.level(id).held }, cashier);
    const home = await (await fetch(url)).text();
    assert.match(home, /<p class="card__left">Only 3 left<\/p>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
