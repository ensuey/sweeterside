'use strict';
/* "Other area" starting fee: set on the Settings page, added to an "Other
   area" delivery until the call confirms it; then the POS sets the agreed
   fee or waives it (POST /api/pos/online/:id/fee). Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-other-fee-'));
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
const render = require('../server/render');
const delivery = require('../server/delivery');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
require('../server/shifts').open({ opening_cash: 1000 }, cashier);

const MATCHA = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // Php 129
const key = () => crypto.randomBytes(12).toString('hex');
let phoneSeq = 10;
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('expected an error'); };

/** An "Other area" delivery of one Matcha Frappe, paying cash. */
const otherOrder = (over = {}) => orders.create({
  type: 'delivery', name: 'Ana Reyes', phone: `0917 444 55${++phoneSeq}`, address: '12 Mabini St',
  landmark: 'green gate', cash: 200, delivery_area: 'other', items: [{ id: MATCHA().id, qty: 1 }],
  expected_total: 179, checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});

async function withPos(fn) {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = `fee-${crypto.randomBytes(4).toString('hex')}@example.com`;
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
    await fn({ call, tokens: { cashier: await unlock(cashier, '3691'), waiter: await unlock(waiter, '4702') } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the starting fee is a whole number of pesos from 0, or blank for none', () => {
  for (const bad of [-1, 1.5, 10001, 'abc']) {
    const e = errorOf(() => orders.updateSettings({ other_area_fee: bad }));
    assert.ok(e.errors.other_area_fee, String(bad));
  }
  assert.strictEqual(orders.settings().other_area_fee, null, 'blank by default');
  // Blank: as before, no fee until the call.
  assert.strictEqual(delivery.resolve('other').fee_cents, 0);
  assert.strictEqual(orders.updateSettings({ other_area_fee: '50' }).other_area_fee, 50);
  assert.deepStrictEqual([delivery.resolve('other').fee_cents, delivery.resolve('other').to_confirm], [5000, true]);
});

test('an "Other area" order adds the starting fee, flagged to confirm; the menu says so', () => {
  const o = otherOrder();
  assert.deepStrictEqual([o.delivery_fee, o.total, o.fee_to_confirm, o.change_due], [50, 179, 1, 21]);

  // The browser's total without the fee is refused with the server's numbers.
  const stale = errorOf(() => otherOrder({ expected_total: 129 }));
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.quote.total, 179);

  // Free delivery never applies to "Other area".
  orders.updateSettings({ free_delivery_min: '100' });
  assert.strictEqual(otherOrder().delivery_fee, 50);
  orders.updateSettings({ free_delivery_min: '' });

  const html = render.buildHtml();
  assert.ok(html.includes('<option value="other">Other area · from ₱50, we call to confirm</option>'));
  assert.ok(html.includes('&quot;other_fee&quot;:50'));
});

test('confirming the fee: the same, another amount, or waived with a reason; total and change follow', () => {
  const o = otherOrder();
  const changed = orders.confirmFee(o.id, { fee: '80' }, cashier);
  assert.deepStrictEqual([changed.delivery_fee, changed.total, changed.cash, changed.change_due, changed.fee_to_confirm],
    [80, 209, 209, 0, 0], 'cash less than the new total: the rider collects the total');
  assert.deepStrictEqual([changed.pricing.totals.delivery_fee, changed.pricing.totals.total], [8000, 20900]);
  const entry = audit.list({ action: 'delivery_fee_changed' })[0];
  assert.deepStrictEqual([entry.order_id, entry.amount_cents, entry.reason, entry.details.from_cents, entry.staff_id],
    [o.id, 8000, 'Confirmed by call', 5000, cashier.id]);

  // Once set, it is set.
  assert.strictEqual(errorOf(() => orders.confirmFee(o.id, { fee: 50 }, cashier)).status, 409);

  const w = otherOrder();
  assert.ok(errorOf(() => orders.confirmFee(w.id, { fee: 0 }, cashier)).errors.reason, 'waiving needs a reason');
  for (const bad of [-5, 2.5, 10001, 'x', null]) {
    assert.ok(errorOf(() => orders.confirmFee(w.id, { fee: bad }, cashier)).errors.fee, String(bad));
  }
  const waived = orders.confirmFee(w.id, { fee: 0, reason: 'Regular customer' }, cashier);
  assert.deepStrictEqual([waived.delivery_fee, waived.total, waived.cash, waived.change_due, waived.fee_to_confirm],
    [0, 129, 200, 71, 0]);
});

test('only an unpaid, open online "Other area" delivery can have its fee set', () => {
  const paid = otherOrder();
  payments.pay(paid.id, { request_key: key(), payments: [{ method: 'cash', amount: 179 }] }, cashier);
  assert.match(errorOf(() => orders.confirmFee(paid.id, { fee: 50 }, cashier)).message, /already paid/);

  const cancelled = otherOrder();
  orders.setStatus(cancelled.id, 'cancelled', { reason: 'customer' });
  assert.match(errorOf(() => orders.confirmFee(cancelled.id, { fee: 50 }, cashier)).message, /closed/);

  const area = delivery.create({ name: 'Town', fee: 30, eta_min: 20, eta_max: 30 });
  const normal = otherOrder({ delivery_area: area.id, expected_total: 159 });
  assert.match(errorOf(() => orders.confirmFee(normal.id, { fee: 0, reason: 'x' }, cashier)).message, /already set/);

  const tab = pos.save(null, {
    request_key: key(), type: 'delivery', customer_name: 'Ana', phone: '0917 000 0000', address: '12 Mabini St', landmark: 'green gate',
    delivery_area: 'other', lines: [{ key: 'a', item_id: MATCHA().id, qty: 1 }],
  }, cashier).order;
  assert.strictEqual(tab.delivery_fee, 50, 'the POS starts from the same fee');
  assert.strictEqual(orders.confirmFee(tab.id, { fee: 60 }, cashier), null, 'POS tabs change the fee on the ticket');
});

test('the endpoint needs CSRF, a PIN and change_delivery_fee', async () => {
  const o = otherOrder();
  await withPos(async ({ call, tokens }) => {
    const post = (token, extra = {}) => call(`/api/pos/online/${o.id}/fee`, { method: 'POST', body: { fee: 70 }, token, ...extra });
    assert.strictEqual((await post(undefined)).status, 423, 'locked without a PIN');
    assert.strictEqual((await post(tokens.waiter)).status, 403, 'a waiter cannot');
    assert.strictEqual((await post(tokens.cashier, { noCsrf: true })).status, 403, 'no CSRF token');
    assert.strictEqual(orders.get(o.id).delivery_fee, 50, 'nothing changed');
    const ok = await post(tokens.cashier);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual([(await ok.json()).order.total, orders.get(o.id).fee_to_confirm], [199, 0]);
    assert.strictEqual((await call('/api/pos/online/999999/fee', { method: 'POST', body: { fee: 1 }, token: tokens.cashier })).status, 404);
  });
});
