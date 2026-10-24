'use strict';
/* Tests for the fake-order protections: phone numbers, the checkout token and
   honeypot, the open-orders limit, the blocklist, confirmation, cancel
   reasons, customer history and the migration of older databases.
   Run with:  npm test          (uses its own throwaway database) */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-antifake-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
delete process.env.CHECKOUT_SECRET;

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const menu = require('../server/menu');
const orders = require('../server/orders');
const cakes = require('../server/cakes');
const blocklist = require('../server/blocklist');
const checkout = require('../server/checkout');
const { normalizePhPhone, displayPhPhone, PHONE_MESSAGE } = require('../server/phone');

seedIfEmpty();

const MATCHA = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // Php 129

/** A delivery order of one Matcha Frappe (no delivery fee is set). */
function orderInput(over = {}) {
  return {
    type: 'delivery', name: 'Test Customer', phone: '0917 123 4567',
    address: '12 Mabini St, Brgy. Uno', landmark: 'beside 7-Eleven, green gate', cash: 200,
    items: [{ id: MATCHA().id, qty: 1 }], expected_total: 129,
    checkout_token: checkout.issue(new Date(Date.now() - 10000)),
    ...over,
  };
}

function errorsOf(fn) {
  try { fn(); return null; } catch (err) {
    assert.ok(err instanceof menu.ValidationError, `expected a ValidationError, got ${err.message}`);
    return err.errors;
  }
}

// Noon in Manila on Fri 23 Oct 2026; with 3 days' notice the earliest cake day is Mon 26 Oct.
const CAKE_NOW = new Date(Date.UTC(2026, 9, 23, 4, 0));

function cakeInput(over = {}) {
  return {
    name: 'Ana Reyes', phone: '0917 555 1234', size: cakes.settings().sizes[0].name,
    flavour: 'Chocolate', needed_on: '2026-10-28', handover: 'pickup', ...over,
  };
}

async function withServer(fn) {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ---------------------------- phone numbers ---------------------------- */

test('PH mobile numbers are normalised to +639XXXXXXXXX however they are typed', () => {
  for (const raw of [
    '09171234567', '0917 123 4567', '0917-123-4567', '(0917) 123-4567',
    '+639171234567', '+63 917 123 4567', '639171234567', '  63 917 123 4567  ',
  ]) {
    assert.strictEqual(normalizePhPhone(raw), '+639171234567', raw);
  }
  assert.strictEqual(displayPhPhone('+639171234567'), '0917 123 4567');
});

test('anything that is not a PH mobile number is refused', () => {
  for (const raw of [
    '', null, undefined, 'abc', '12345678', '0917123456', '091712345678',
    '08171234567', '9171234567', '+6309171234567', '+1 917 123 4567',
    '0917.123.4567', '0917 123 4567 ext 2', '+63+9171234567',
  ]) {
    assert.strictEqual(normalizePhPhone(raw), null, String(raw));
  }
  const e = errorsOf(() => orders.create(orderInput({ phone: '12345678' })));
  assert.strictEqual(e.phone, PHONE_MESSAGE);
  assert.strictEqual(PHONE_MESSAGE, 'Please enter a valid PH mobile number, e.g. 0917 123 4567.');
  assert.strictEqual(errorsOf(() => cakes.create(cakeInput({ phone: '555-1234' }), { now: CAKE_NOW })).phone,
    PHONE_MESSAGE, 'cake bookings check the number the same way');
});

test('an order keeps the number as typed (digits) and normalised', () => {
  const order = orders.create(orderInput({ phone: '+63 917 000 1111' }));
  assert.strictEqual(order.phone, '+639170001111');
  assert.strictEqual(order.phone_norm, '+639170001111');
  const local = orders.create(orderInput({ phone: '0917-000-1111' }));
  assert.strictEqual(local.phone, '09170001111');
  assert.strictEqual(local.phone_norm, '+639170001111', 'both match one customer');
  const dinein = orders.create(orderInput({
    type: 'dinein', phone: '', table_no: '2', address: '', landmark: '', cash: '',
  }));
  assert.strictEqual(dinein.phone_norm, null, 'dine-in takes no phone');
});

/* ---------------------------- landmark ---------------------------- */

test('delivery needs a landmark of 5 to 200 characters; other types do not', () => {
  assert.ok(errorsOf(() => orders.create(orderInput({ landmark: '' }))).landmark);
  assert.ok(errorsOf(() => orders.create(orderInput({ landmark: 'gate' }))).landmark, 'too short');
  assert.ok(errorsOf(() => orders.create(orderInput({ landmark: 'x'.repeat(201) }))).landmark, 'too long');
  const order = orders.create(orderInput({ phone: '0917 000 2222', landmark: '  green   gate  ' }));
  assert.strictEqual(order.landmark, 'green gate');

  const pickup = orders.create(orderInput({
    type: 'pickup', phone: '0917 000 2222', pickup_at: '13:00', address: '', landmark: 'ignored', cash: '',
  }), { now: CAKE_NOW });
  assert.strictEqual(pickup.landmark, '', 'pick-up keeps no landmark');
});

/* ---------------------------- checkout token ---------------------------- */

test('checkout tokens: too fast, expired and forged ones are refused', () => {
  const now = new Date();
  const ago = (ms) => checkout.issue(new Date(now.getTime() - ms));
  assert.strictEqual(checkout.check(ago(10 * 1000), now), null, 'ten seconds is fine');
  assert.strictEqual(checkout.check(ago(119 * 60 * 1000), now), null, 'just under two hours is fine');
  assert.strictEqual(checkout.check(ago(1000), now), 'too_fast');
  assert.strictEqual(checkout.check(ago(121 * 60 * 1000), now), 'bad_token', 'over two hours');
  assert.strictEqual(checkout.check('', now), 'bad_token');
  assert.strictEqual(checkout.check(undefined, now), 'bad_token');
  assert.strictEqual(checkout.check('not-a-token', now), 'bad_token');

  // Changing the time to make an old token look fresh breaks the signature.
  const [, sig] = ago(10 * 1000).split('.');
  const old = (now.getTime() - 3 * 60 * 60 * 1000).toString(36);
  assert.strictEqual(checkout.check(`${old}.${sig}`, now), 'bad_token');
  const good = ago(10 * 1000);
  const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  assert.strictEqual(checkout.check(flipped, now), 'bad_token');

  const saved = db.prepare("SELECT value FROM settings WHERE key = 'checkout_secret'").get();
  assert.ok(saved && saved.value.length >= 32, 'a secret was generated and kept');
  assert.ok(!('checkout_secret' in orders.settings()), 'the secret is never sent to the admin page');
});

test('the order endpoint refuses honeypots and bad tokens, and accepts a good order', async () => {
  await withServer(async (url) => {
    // A different address per request, so the per-IP order limit stays out of the way.
    let n = 0;
    const place = (body) => fetch(`${url}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.1.0.${++n}` },
      body: JSON.stringify(body),
    });

    const tokenRes = await fetch(`${url}/api/checkout-token`);
    assert.strictEqual(tokenRes.status, 200);
    const { token } = await tokenRes.json();
    assert.strictEqual(checkout.check(token), 'too_fast', 'a fresh token cannot be used straight away');

    const honey = await place(orderInput({ phone: '0917 000 3333', website: 'http://spam.example' }));
    assert.strictEqual(honey.status, 400);
    const honeyBody = await honey.json();
    assert.doesNotMatch(honeyBody.error, /website|honeypot|bot/i, 'it does not say why');

    for (const bad of [undefined, token, checkout.issue(new Date(Date.now() - 3 * 60 * 60 * 1000)), 'x.y']) {
      const res = await place(orderInput({ phone: '0917 000 3333', checkout_token: bad }));
      assert.strictEqual(res.status, 409, `token ${bad}`);
      assert.strictEqual((await res.json()).retry, true, 'the cart is told to fetch a new token');
    }
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE phone_norm = '+639170003333'").get().n, 0,
      'none of those were saved');

    const ok = await place(orderInput({ phone: '0917 000 3333' }));
    assert.strictEqual(ok.status, 201);
  });
});

/* ---------------------------- open orders ---------------------------- */

test('a number may have at most N orders in progress (default 3)', () => {
  assert.strictEqual(orders.settings().max_open_orders, 3);
  const phone = '0918 000 0001';
  const a = orders.create(orderInput({ phone }));
  orders.create(orderInput({ phone }));
  // Two open (N-1): the third is allowed, typed another way.
  orders.create(orderInput({ phone: '+63 918 000 0001' }));

  assert.throws(() => orders.create(orderInput({ phone: '639180000001' })), (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'too_many_open');
    assert.strictEqual(err.body.error,
      'You already have orders in progress. Please wait for them to finish or call us.');
    return true;
  });

  orders.setStatus(a.id, 'completed');
  assert.ok(orders.create(orderInput({ phone })).id, 'once one is completed, another is allowed');

  orders.updateSettings({ max_open_orders: 5 });
  assert.ok(orders.create(orderInput({ phone })).id, 'the limit is a setting');
  assert.ok(errorsOf(() => orders.updateSettings({ max_open_orders: 0 })).max_open_orders);
  orders.updateSettings({ max_open_orders: 3 });
});

/* ---------------------------- blocklist ---------------------------- */

test('a blocked number cannot order or book a cake, and unblocking lets it again', () => {
  const blocked = blocklist.add({ phone: '+63 918 000 0003', reason: 'Fake orders' }, 'dachel@example.com');
  assert.strictEqual(blocked.phone_norm, '+639180000003');
  assert.strictEqual(blocked.created_by, 'dachel@example.com');
  assert.strictEqual(blocklist.add({ phone: '09180000003' }).id, blocked.id, 'blocking twice keeps one entry');
  assert.ok(errorsOf(() => blocklist.add({ phone: '12345' })).phone, 'only real numbers can be blocked');

  const refused = (err) => {
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.body.error, "We couldn't place this order online. Please call or message us.");
    return true;
  };
  assert.throws(() => orders.create(orderInput({ phone: '0918-000-0003' })), refused);
  assert.throws(() => cakes.create(cakeInput({ phone: '639180000003' }), { now: CAKE_NOW }), refused);

  assert.ok(blocklist.remove(blocked.id));
  assert.strictEqual(blocklist.remove(blocked.id), false);
  assert.ok(orders.create(orderInput({ phone: '0918-000-0003' })).id);
  assert.ok(cakes.create(cakeInput({ phone: '639180000003' }), { now: CAKE_NOW }).id);
  assert.strictEqual(cakes.get(db.prepare('SELECT MAX(id) AS id FROM cake_bookings').get().id).phone_norm,
    '+639180000003', 'cake bookings keep the normalised number too');
});

test('the blocklist endpoints need sign-in and CSRF, and can block from an order', async () => {
  const email = 'blocktest@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const order = orders.create(orderInput({ phone: '0918 000 0004' }));

  await withServer(async (url) => {
    const call = (p, method, body, headers = {}) => fetch(`${url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    assert.strictEqual((await call('/api/blocked', 'GET')).status, 401);
    assert.strictEqual((await call('/api/blocked', 'POST', { phone: '09180000005' })).status, 401);
    assert.strictEqual((await call('/api/blocked', 'POST', { phone: '09180000005' }, { Cookie: cookie })).status, 403,
      'no CSRF token');
    assert.strictEqual((await call('/api/blocked/1', 'DELETE', undefined, { Cookie: cookie })).status, 403);
    assert.strictEqual((await fetch(`${url}/admin/blocked`, { redirect: 'manual' })).status, 302);

    const admin = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const res = await call('/api/blocked', 'POST', { order_id: order.id, reason: 'Nobody at the address', cancel: true }, admin);
    assert.strictEqual(res.status, 201);
    const { blocked } = await res.json();
    assert.strictEqual(blocked.phone_norm, '+639180000004');
    assert.strictEqual(blocked.display, '0918 000 0004');
    assert.strictEqual(blocked.created_by, email);
    const cancelled = orders.get(order.id);
    assert.strictEqual(cancelled.status, 'cancelled');
    assert.strictEqual(cancelled.cancel_reason, 'fake');

    const placed = await fetch(`${url}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.2.0.1' },
      body: JSON.stringify(orderInput({ phone: '0918 000 0004' })),
    });
    assert.strictEqual(placed.status, 403, 'checkout refuses the blocked number');

    const list = await (await call('/api/blocked', 'GET', undefined, admin)).json();
    assert.ok(list.blocked.some((b) => b.id === blocked.id));
    assert.ok(orders.list('finished').find((o) => o.id === order.id).blocked, 'the order shows the number is blocked');

    const bad = await call('/api/blocked', 'POST', { phone: 'call me' }, admin);
    assert.strictEqual(bad.status, 422);
    assert.strictEqual((await call(`/api/blocked/${blocked.id}`, 'DELETE', undefined, admin)).status, 200);
    assert.strictEqual(blocklist.isBlocked('+639180000004'), false);
  });
});

/* ---------------------------- confirmation ---------------------------- */

test('delivery and pick-up must be confirmed before preparing; dine-in need not', () => {
  const s = orders.settings();
  assert.deepStrictEqual(
    [s.require_confirm_delivery, s.require_confirm_pickup, s.require_confirm_dinein], [true, true, false]);

  const delivery = orders.create(orderInput({ phone: '0918 000 0006' }));
  assert.strictEqual(delivery.status, 'new');
  assert.ok(errorsOf(() => orders.setStatus(delivery.id, 'preparing')).status, 'New cannot skip to Preparing');
  assert.ok(errorsOf(() => orders.setStatus(delivery.id, 'delivering')).status, 'nor to handed over');
  assert.strictEqual(orders.setStatus(delivery.id, 'confirmed').status, 'confirmed');
  assert.strictEqual(orders.setStatus(delivery.id, 'preparing').status, 'preparing');

  const dinein = orders.create(orderInput({ type: 'dinein', phone: '', table_no: '3', address: '', cash: '' }));
  assert.strictEqual(orders.setStatus(dinein.id, 'preparing').status, 'preparing', 'dine-in goes straight on');

  orders.updateSettings({ require_confirm_delivery: false, require_confirm_dinein: true });
  try {
    const d2 = orders.create(orderInput({ phone: '0918 000 0006' }));
    assert.strictEqual(orders.setStatus(d2.id, 'preparing').status, 'preparing', 'switched off for delivery');
    const t2 = orders.create(orderInput({ type: 'dinein', phone: '', table_no: '3', address: '', cash: '' }));
    assert.ok(errorsOf(() => orders.setStatus(t2.id, 'preparing')).status, 'switched on for dine-in');
    assert.ok(orders.list('active').find((o) => o.id === t2.id).needs_confirm);
  } finally {
    orders.updateSettings({ require_confirm_delivery: true, require_confirm_dinein: false });
  }

  // Orders already past New are left alone, and New can still be cancelled.
  const waiting = orders.create(orderInput({ phone: '0918 000 0007' }));
  assert.strictEqual(orders.setStatus(waiting.id, 'cancelled', { reason: 'customer' }).status, 'cancelled');
});

test('cancelling records why', () => {
  const order = orders.create(orderInput({ phone: '0918 000 0008' }));
  assert.ok(errorsOf(() => orders.setStatus(order.id, 'cancelled', { reason: 'bored' })).reason);
  const cancelled = orders.setStatus(order.id, 'cancelled', { reason: 'no_show' });
  assert.strictEqual(cancelled.cancel_reason, 'no_show');
  assert.deepStrictEqual(orders.CANCEL_REASONS, ['customer', 'no_show', 'fake', 'other']);
  assert.strictEqual(orders.setStatus(order.id, 'new').cancel_reason, '', 'reopening clears the reason');
});

/* ---------------------------- history and trust ---------------------------- */

test('each order shows the number\'s history, and trusted numbers can be auto-confirmed', () => {
  const phone = '0918 000 0009';
  const first = orders.create(orderInput({ phone }));
  assert.deepStrictEqual(orders.list('active').find((o) => o.id === first.id).history,
    { orders: 0, completed: 0, no_show: 0, fake: 0 }, 'first order');

  orders.setStatus(first.id, 'completed');
  for (let i = 0; i < 2; i++) orders.setStatus(orders.create(orderInput({ phone })).id, 'completed');

  // Off by default: even a good customer waits for the call.
  assert.strictEqual(orders.settings().auto_confirm_trusted, false);
  const plain = orders.create(orderInput({ phone }));
  assert.strictEqual(plain.status, 'new');
  assert.deepStrictEqual(orders.list('active').find((o) => o.id === plain.id).history,
    { orders: 3, completed: 3, no_show: 0, fake: 0 });
  orders.setStatus(plain.id, 'cancelled', { reason: 'customer' });

  orders.updateSettings({ auto_confirm_trusted: true });
  try {
    assert.strictEqual(orders.create(orderInput({ phone })).status, 'confirmed', '3 completed, no no-shows');
    assert.strictEqual(orders.create(orderInput({ phone: '0918 000 0010' })).status, 'new', 'a new number waits');

    const noShow = orders.create(orderInput({ phone }));
    orders.setStatus(noShow.id, 'cancelled', { reason: 'no_show' });
    const after = orders.create(orderInput({ phone }));
    assert.strictEqual(after.status, 'new', 'a no-show loses the trust');
    assert.deepStrictEqual(orders.list('active').find((o) => o.id === after.id).history,
      { orders: 6, completed: 3, no_show: 1, fake: 0 });

    orders.updateSettings({ trusted_max_flags: 1 });
    assert.strictEqual(orders.create(orderInput({ phone })).status, 'confirmed', 'one no-show allowed now');
  } finally {
    orders.updateSettings({ auto_confirm_trusted: false, trusted_max_flags: 0, trusted_min_completed: 3 });
  }
  // Clear this number's open orders so later tests are not held by the limit.
  db.prepare("UPDATE orders SET status = 'completed' WHERE phone_norm = '+639180000009'").run();
});

test('the history query uses the phone index', () => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM orders WHERE phone_norm IN (?)
    GROUP BY phone_norm`).all('+639170000000').map((r) => r.detail).join(' ');
  assert.match(plan, /idx_orders_phone/);
});

/* ---------------------------- migration ---------------------------- */

test('an older database gets normalised phones, the Confirmed status and keeps its order lines', () => {
  const { execFileSync } = require('node:child_process');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-phones-'));
  const dbPath = path.join(dir, 'old.db');

  // Orders and cake bookings as the release before this one stored them.
  const old = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  old.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
      subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
      cash INTEGER NOT NULL, change_due INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','preparing','delivering','completed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      order_type TEXT NOT NULL DEFAULT 'delivery', table_no TEXT NOT NULL DEFAULT '',
      pickup_at TEXT NOT NULL DEFAULT '', voucher_code TEXT NOT NULL DEFAULT '',
      discount INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id INTEGER, name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0));
    INSERT INTO orders (id, customer_name, phone, address, subtotal, delivery_fee, total, cash, change_due, status, order_type) VALUES
      (1, 'A', '09171234567', 'x', 100, 0, 100, 100, 0, 'completed', 'delivery'),
      (2, 'B', '+639181234567', 'x', 100, 0, 100, 100, 0, 'preparing', 'delivery'),
      (3, 'C', '639191234567', '', 100, 0, 100, 0, 0, 'new', 'pickup'),
      (4, 'D', '1234567', 'x', 100, 0, 100, 100, 0, 'new', 'delivery'),
      (5, 'E', '', '', 100, 0, 100, 0, 0, 'new', 'dinein');
    INSERT INTO order_items (order_id, item_id, name, price, qty) VALUES (1, NULL, 'Matcha', 100, 1), (2, NULL, 'Matcha', 100, 1);
    CREATE TABLE cake_bookings (
      id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, size TEXT NOT NULL,
      size_from_price INTEGER NOT NULL, flavour TEXT NOT NULL, occasion TEXT NOT NULL DEFAULT '',
      cake_message TEXT NOT NULL DEFAULT '', design_notes TEXT NOT NULL DEFAULT '',
      photo TEXT NOT NULL DEFAULT '', needed_on TEXT NOT NULL,
      handover TEXT NOT NULL CHECK (handover IN ('pickup','delivery')), address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new', quoted_price INTEGER, deposit_paid INTEGER NOT NULL DEFAULT 0,
      deposit_amount INTEGER, admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO cake_bookings (customer_name, phone, size, size_from_price, flavour, needed_on, handover)
      VALUES ('K', '0917-555-1234', '6"', 850, 'Ube', '2026-11-01', 'pickup'), ('L', '5551234', '6"', 850, 'Ube', '2026-11-01', 'pickup');`);
  old.close();

  const script = `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = 3").run();
    console.log(JSON.stringify({
      orders: db.prepare('SELECT id, phone, phone_norm, status, landmark, cancel_reason FROM orders ORDER BY id').all(),
      lines: db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n,
      cakes: db.prepare('SELECT phone_norm FROM cake_bookings ORDER BY id').all().map((r) => r.phone_norm),
    }));`;
  const run = () => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script],
    { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' }));
  const out = run();

  assert.deepStrictEqual(out.orders.map((o) => o.phone_norm),
    ['+639171234567', '+639181234567', '+639191234567', null, null], 'unparseable and empty numbers stay null');
  assert.deepStrictEqual(out.orders.map((o) => o.phone), ['09171234567', '+639181234567', '639191234567', '1234567', ''],
    'the original numbers are kept');
  assert.deepStrictEqual(out.orders.map((o) => o.status), ['completed', 'preparing', 'confirmed', 'new', 'new'],
    'existing statuses are kept, and Confirmed is now allowed');
  assert.ok(out.orders.every((o) => o.landmark === '' && o.cancel_reason === ''));
  assert.strictEqual(out.lines, 2, 'rebuilding the table keeps every order line');
  assert.deepStrictEqual(out.cakes, ['+639175551234', null]);

  assert.strictEqual(run().orders.length, 5, 'starting again on the migrated database changes nothing');
});
