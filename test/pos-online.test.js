'use strict';
/* Online orders at the POS: the list, moving them along, cancelling, and the
   waiter's dine-in limit (GET/PATCH /api/pos/online). Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-pos-online-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const orders = require('../server/orders');
const payments = require('../server/payments');
const audit = require('../server/audit');
const checkout = require('../server/checkout');
const menu = require('../server/menu');

seedIfEmpty();
// Ordering follows the opening hours. Open all day, so no test depends on the clock.
require('../server/orders').updateSettings({ open_at: '00:00', close_at: '24:00' });

// Delivery orders name an area.
const deliveryAreas = require('../server/delivery');
const TEST_AREA = deliveryAreas.create({ name: 'Test Area', fee: 0, eta_min: 30, eta_max: 45 });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);

const MATCHA = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // Php 129
const key = () => crypto.randomBytes(12).toString('hex');
let phoneSeq = 10;

/** An online order of one Matcha Frappe. */
function online(type = 'delivery') {
  const base = {
    type, name: 'Online Customer', items: [{ id: MATCHA().id, qty: 1 }], expected_total: 129,
    checkout_token: checkout.issue(new Date(Date.now() - 10000)),
  };
  if (type === 'delivery') {
    Object.assign(base, { phone: `0917 222 33${++phoneSeq}`, address: '12 Mabini St', landmark: 'green gate', cash: 200, delivery_area: TEST_AREA.id });
  } else if (type === 'pickup') {
    Object.assign(base, { phone: `0917 222 33${++phoneSeq}`, pickup_at: 'asap' });
  } else {
    Object.assign(base, { table_no: String(++phoneSeq) });
  }
  return orders.create(base);
}

/** Sign in, then unlock the POS for each staff member. */
async function withPos(fn) {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = `online-${crypto.randomBytes(4).toString('hex')}@example.com`;
  auth.createUser(email, 'a-long-enough-password');
  try {
    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const call = (p, { method = 'GET', body, token, noCsrf = false } = {}) => fetch(`${url}${p}`, {
      method,
      headers: {
        Cookie: cookie, 'Content-Type': 'application/json',
        ...(noCsrf ? {} : { 'X-CSRF-Token': csrf }), ...(token ? { 'X-Staff-Token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const unlock = async (who, pin) => (await (await call('/api/pos/unlock', {
      method: 'POST', body: { staff_id: who.id, pin },
    })).json()).token;
    await fn({ call, tokens: { owner: await unlock(owner, '2580'), cashier: await unlock(cashier, '3691'), waiter: await unlock(waiter, '4702') } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the list needs a PIN, shows active online orders only, and never pos_input', async () => {
  const delivery = online('delivery');
  const dinein = online('dinein');
  const tab = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '99', lines: [{ key: 'a', item_id: MATCHA().id, qty: 1 }], send: true,
  }, cashier).order;

  await withPos(async ({ call, tokens }) => {
    assert.strictEqual((await call('/api/pos/online')).status, 423, 'locked without a PIN');

    const { orders: list } = await (await call('/api/pos/online', { token: tokens.cashier })).json();
    const ids = list.map((o) => o.id);
    assert.ok(ids.includes(delivery.id) && ids.includes(dinein.id));
    assert.ok(!ids.includes(tab.id), 'POS tabs are not online orders');
    assert.ok(list.every((o) => o.source === 'online' && !('pos_input' in o)));

    const { orders: waiterList } = await (await call('/api/pos/online', { token: tokens.waiter })).json();
    assert.ok(waiterList.length > 0 && waiterList.every((o) => o.order_type === 'dinein'), 'waiters see dine-in only');
  });
});

test('the bell feed works while locked and carries no customer details', async () => {
  const o = online('pickup');
  await withPos(async ({ call }) => {
    const res = await call('/api/pos/online/pending');
    assert.strictEqual(res.status, 200, 'admin session only, no PIN');
    const { orders: list } = await res.json();
    const row = list.find((x) => x.id === o.id);
    assert.deepStrictEqual(row, { id: o.id, order_type: 'pickup', status: 'new' });
    assert.ok(list.every((x) => Object.keys(x).sort().join() === 'id,order_type,status'), 'ids, types and statuses only');
  });
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pos/online/pending`);
    assert.strictEqual(res.status, 401, 'signed out');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('moving an order along: confirm first, then preparing, handed over, completed', async () => {
  const o = online('delivery');
  await withPos(async ({ call, tokens }) => {
    const patch = (status, extra = {}) => call(`/api/pos/online/${o.id}`, { method: 'PATCH', body: { status, ...extra }, token: tokens.cashier });

    assert.strictEqual((await patch('preparing')).status, 422, 'a delivery order needs Confirm first');
    for (const status of ['confirmed', 'preparing', 'delivering', 'completed']) {
      const res = await patch(status);
      assert.strictEqual(res.status, 200, status);
      assert.strictEqual((await res.json()).order.status, status);
    }
    const gone = await (await call('/api/pos/online', { token: tokens.cashier })).json();
    assert.ok(!gone.orders.some((x) => x.id === o.id), 'completed orders leave the list');
  });
});

test('waiters move online dine-in orders only; CSRF and POS ids are refused', async () => {
  const delivery = online('delivery');
  const dinein = online('dinein');
  const tab = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '98', lines: [{ key: 'b', item_id: MATCHA().id, qty: 1 }], send: true,
  }, cashier).order;

  await withPos(async ({ call, tokens }) => {
    const patch = (id, token, extra = {}) => call(`/api/pos/online/${id}`, { method: 'PATCH', body: { status: 'confirmed' }, token, ...extra });
    assert.strictEqual((await patch(delivery.id, tokens.waiter)).status, 403);
    assert.strictEqual(orders.get(delivery.id).status, 'new', 'nothing changed');
    assert.strictEqual((await patch(dinein.id, tokens.waiter)).status, 200);
    assert.strictEqual((await patch(delivery.id, tokens.cashier, { noCsrf: true })).status, 403, 'no CSRF token');
    assert.strictEqual((await patch(tab.id, tokens.cashier)).status, 404, 'a POS tab is not an online order');
    assert.strictEqual((await patch(delivery.id, undefined)).status, 423, 'locked without a PIN');
  });
});

test('cancelling needs a reason, is audited, and waits for a refund once paid', async () => {
  const o = online('pickup');
  const paidOrder = online('pickup');
  payments.pay(paidOrder.id, { request_key: key(), payments: [{ method: 'gcash', amount: 129, reference: 'GC-9' }] }, cashier);

  await withPos(async ({ call, tokens }) => {
    const cancel = (id, reason) => call(`/api/pos/online/${id}`, {
      method: 'PATCH', body: { status: 'cancelled', ...(reason ? { reason } : {}) }, token: tokens.cashier,
    });
    assert.strictEqual((await cancel(o.id)).status, 422, 'a reason is needed');
    assert.strictEqual((await cancel(o.id, 'made-up')).status, 422);
    const res = await cancel(o.id, 'no_show');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([orders.get(o.id).status, orders.get(o.id).cancel_reason], ['cancelled', 'no_show']);
    const entry = audit.list({ action: 'order_cancel' }).find((e) => e.order_id === o.id);
    assert.ok(entry, 'audited');
    assert.strictEqual(entry.reason, 'no_show');
    assert.strictEqual(entry.staff_name, 'Ana');

    assert.strictEqual((await cancel(paidOrder.id, 'customer')).status, 409, 'refund it first');
    assert.strictEqual(orders.get(paidOrder.id).status, 'new');
  });
});
