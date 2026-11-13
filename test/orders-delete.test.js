'use strict';
/* Deleting test orders for good (orders.remove and POST /api/orders/:id/delete):
   the owner's PIN every time; lines, payments and refunds go with the order;
   reports, shift totals and customer history no longer see it; one audit line
   stays; counted items keep their count. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-orders-delete-'));
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
const reports = require('../server/reports');
const checkout = require('../server/checkout');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const OWNER_OK = { staff_id: owner.id, pin: '2580' };
shifts.open({ opening_cash: 1000 }, cashier);

const item = (name) => menu.list().find((i) => i.name === name);
const SANDWICH = 'Bacon and Egg Sandwich'; // Php 85
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
const posOrder = (qty = 1) => pos.save(null, {
  request_key: key(), type: 'pickup', customer_name: '', lines: [{ key: `k${++seq}`, item_id: item(SANDWICH).id, qty }], send: true,
}, cashier).order;
const payCash = (o) => payments.pay(o.id, { request_key: key(), payments: [{ method: 'cash', amount: o.total }] }, cashier);
const onlineOrder = () => orders.create({
  type: 'dinein', name: 'Test Customer', phone: '', address: '', cash: '', table_no: '9',
  items: [{ id: item(SANDWICH).id, qty: 1 }], expected_total: 85,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)),
});
const exists = (id) => !!db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id);
const lineCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(id).n;

test('an unpaid order is erased with its lines; one audit line stays, with no customer details', () => {
  const o = onlineOrder();
  assert.ok(exists(o.id) && lineCount(o.id) === 1);
  const removed = orders.remove(o.id, owner);
  assert.deepStrictEqual(removed, { id: o.id, total: 85, paid: 0, refunded: 0 });
  assert.ok(!exists(o.id) && lineCount(o.id) === 0);
  assert.strictEqual(orders.get(o.id), null);
  assert.ok(!orders.list('active').some((x) => x.id === o.id));

  const entry = audit.list({ action: 'order_delete' })[0];
  assert.deepStrictEqual([entry.order_id, entry.staff_name, entry.amount_cents], [o.id, 'Dachel', 8500]);
  assert.ok(!JSON.stringify(entry).includes('Test Customer'), 'no customer name in the log');
  assert.strictEqual(orders.remove(o.id, owner), null, 'already gone');
});

test('a paid and refunded order takes its payments and refunds out of the reports and the shift', () => {
  const before = reports.summary({}).totals.total;
  const shiftBefore = shifts.reading(shifts.current());
  const o = posOrder(2);
  payCash(o);
  const line = o.lines[0];
  payments.refund(o.id, { request_key: key(), lines: [{ line_id: line.id, qty: 1 }], method: 'cash', reason: 'Test', override: OWNER_OK }, cashier);
  assert.strictEqual(reports.summary({}).totals.total, before + 17000);

  const removed = orders.remove(o.id, owner);
  assert.deepStrictEqual([removed.total, removed.paid, removed.refunded], [170, 170, 85]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(o.id).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM refunds WHERE order_id = ?').get(o.id).n, 0);
  assert.strictEqual(reports.summary({}).totals.total, before, 'reports no longer see it');
  const after = shifts.reading(shifts.current());
  assert.deepStrictEqual([after.sales.total_cents ?? after.sales.total, after.expected_cash_cents],
    [shiftBefore.sales.total_cents ?? shiftBefore.sales.total, shiftBefore.expected_cash_cents], 'nor the open shift');
  // Earlier audit lines about it (the refund) stay: the log never changes.
  assert.ok(audit.list({ action: 'refund' }).some((e) => e.order_id === o.id));
  const entry = audit.list({ action: 'order_delete' })[0];
  assert.deepStrictEqual(entry.details, { source: 'pos', order_type: 'pickup', status: 'confirmed', paid_cents: 17000, refunded_cents: 8500 });
});

test('counted items keep their count when a handed-over order is deleted; an open one frees its units', () => {
  const id = item(SANDWICH).id;
  const sold = posOrder(2);
  payCash(sold); // handed over before the stock take
  stock.change(id, { action: 'count', qty: 10 }, cashier);
  const afterSale = posOrder(1);
  payCash(afterSale); // handed over after it
  const held = posOrder(3); // open
  assert.strictEqual(stock.level(id).left, 6);

  orders.remove(sold.id, owner);
  assert.strictEqual(stock.level(id).left, 6, 'deleted before the stock take: the count stays');
  orders.remove(afterSale.id, owner);
  assert.strictEqual(stock.level(id).left, 6, 'deleted after it: the count stays');
  orders.remove(held.id, owner);
  assert.strictEqual(stock.level(id).left, 9, 'an open order frees what it held, like cancelling');
  stock.change(id, { action: 'off' }, null);
});

test('the POS ticket has a Delete… button for held tabs, which asks for the owner PIN', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'admin', f), 'utf8');
  const html = read('pos.html');
  const js = read('pos.js');
  assert.match(html, /id="delete-btn"[^>]*hidden/, 'the button starts hidden');
  assert.match(js, /\$\('delete-btn'\)\.hidden = !\(t\.id && t\.held\)/, 'shown on held tabs only');
  assert.match(js, /askOverride\(\['delete_orders'\]\)/, 'the owner PIN every time');
  assert.match(js, /\/api\/orders\/\$\{t\.id\}\/delete/, 'the same route as the Orders page');
  assert.match(js, /confirm: t\.id/, 'repeats the number');
  assert.match(read('staff-gate.js'), /delete_orders:/, 'the approval dialog says what it is for');
});

test('the endpoint needs the session, CSRF, the matching number and an owner PIN', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = 'delete@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const del = (id, body, { noCookie, noCsrf } = {}) => fetch(`${url}/api/orders/${id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(noCookie ? {} : { Cookie: cookie }), ...(noCsrf ? {} : { 'X-CSRF-Token': csrf }) },
    body: JSON.stringify(body),
  });
  const o = onlineOrder();
  try {
    assert.strictEqual((await del(o.id, { confirm: o.id, override: OWNER_OK }, { noCookie: true })).status, 401);
    assert.strictEqual((await del(o.id, { confirm: o.id, override: OWNER_OK }, { noCsrf: true })).status, 403);
    assert.strictEqual((await del(o.id, { confirm: o.id + 1, override: OWNER_OK })).status, 422, 'the number must match');
    const none = await del(o.id, { confirm: o.id });
    assert.deepStrictEqual([none.status, (await none.json()).override_required], [403, true], 'no PIN, no delete');
    const wrong = await del(o.id, { confirm: o.id, override: { staff_id: owner.id, pin: '0000' } });
    assert.deepStrictEqual([wrong.status, (await wrong.json()).wrong_pin], [403, true], 'not 401: that would mean signed out');
    const notOwner = await del(o.id, { confirm: o.id, override: { staff_id: cashier.id, pin: '3691' } });
    assert.strictEqual(notOwner.status, 403, 'a cashier cannot approve it');
    assert.ok(exists(o.id), 'still there after every refusal');

    const ok = await del(o.id, { confirm: o.id, override: OWNER_OK });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).deleted.id, o.id);
    assert.ok(!exists(o.id));
    assert.strictEqual((await del(o.id, { confirm: o.id, override: OWNER_OK })).status, 404);

    // A held POS tab (saved, never sent) is left off the Orders page, so the
    // POS deletes it through the same route, with the same owner PIN.
    const held = pos.save(null, {
      request_key: key(), type: 'pickup', customer_name: '', lines: [{ key: `k${++seq}`, item_id: item(SANDWICH).id, qty: 1 }],
    }, cashier).order;
    assert.ok(pos.open().some((x) => x.id === held.id && x.held), 'in the open tabs');
    assert.ok(!orders.list('active').some((x) => x.id === held.id), 'not on the Orders page');
    const heldWrong = await del(held.id, { confirm: held.id, override: { staff_id: owner.id, pin: '0000' } });
    assert.strictEqual(heldWrong.status, 403);
    assert.ok(exists(held.id), 'a wrong PIN keeps the tab');
    assert.strictEqual((await del(held.id, { confirm: held.id, override: OWNER_OK })).status, 200);
    assert.ok(!exists(held.id) && lineCount(held.id) === 0);
    assert.ok(!pos.open().some((x) => x.id === held.id), 'gone from the open tabs');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
