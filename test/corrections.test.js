'use strict';
/* Custom items (named and priced at the counter), the Other payment method,
   cash-only drawer counts, and the owner's corrections of payments and cash
   in / out, including on a closed shift (recounted, original kept).
   Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-corrections-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const corrections = require('../server/corrections');
const audit = require('../server/audit');
const stock = require('../server/stock');
const menu = require('../server/menu');

seedIfEmpty();

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
const OWNER_OK = { staff_id: owner.id, pin: '2580' };
shifts.open({ opening_cash: 1000 }, cashier);

const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
const custom = (name, price, qty = 1) => ({ key: `c${++seq}`, custom: true, name, unit_price: price, qty });
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}
/** A takeout of custom lines. */
const ticket = (lines, by = cashier, extra = {}) => pos.save(null, {
  request_key: key(), type: 'pickup', customer_name: '', lines, send: false, ...extra,
}, by).order;
const pay = (o, parts) => payments.pay(o.id, { request_key: key(), payments: parts }, cashier);
const expected = () => shifts.reading(shifts.current()).cash.expected_cents;
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const paymentOf = (id) => db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(id);

test('a custom item is named and priced at the counter, with no stock and no menu item', () => {
  const sandwich = menu.list().find((i) => i.name === 'Bacon and Egg Sandwich');
  stock.change(sandwich.id, { action: 'count', qty: 5 }, cashier);
  const o = ticket([custom('Custom cake deposit #12', 500)]);
  assert.strictEqual(o.total, 500);
  const line = o.lines[0];
  assert.deepStrictEqual([line.name, line.item_id, line.custom, line.unit_cents], ['Custom cake deposit #12', null, true, 50000]);
  assert.strictEqual(stock.level(sandwich.id).left, 5, 'no stock touched');

  // More of an existing custom line is fine (it has no menu item to run out).
  const more = pos.save(o.id, {
    request_key: key(), version: o.version, type: 'pickup', customer_name: '',
    lines: [{ id: line.id, key: line.key, qty: 2 }],
  }, cashier).order;
  assert.strictEqual(more.total, 1000);

  for (const [name, price, message] of [['', 100, /Name the custom item/], ['x'.repeat(61), 100, /Name the custom item/],
    ['Cake', 0, /price/], ['Cake', -5, /price/], ['Cake', 'abc', /price/], ['Cake', 1.005, /price/], ['Cake', 100001, /price/]]) {
    assert.match(errorOf(() => ticket([custom(name, price)])).errors.lines, message, `${name}/${price}`);
  }
  // Waiters need the owner for a custom item.
  const w = errorOf(() => pos.save(null, { request_key: key(), type: 'dinein', table_no: '9', lines: [custom('Cake', 100)] }, waiter));
  assert.deepStrictEqual([w.status, w.body.needs], [403, ['custom_item']]);
  stock.change(sandwich.id, { action: 'off' }, null);
});

test('only cash counts in the drawer; Other needs a note', () => {
  const start = expected();
  const a = ticket([custom('Cake balance', 800)]);
  pay(a, [{ method: 'gcash', amount: 800, reference: 'GC123' }]);
  const b = ticket([custom('Cupcakes', 300)]);
  assert.match(errorOf(() => pay(b, [{ method: 'other', amount: 300 }])).errors.reference, /For Other, say what it was/);
  pay(b, [{ method: 'other', amount: 300, reference: 'Bank transfer' }]);
  const c = ticket([custom('Cookies', 150)]);
  pay(c, [{ method: 'cash', amount: 150, tendered: 200 }]);
  assert.strictEqual(expected(), start + 15000, 'only the cash payment');
  const r = shifts.reading(shifts.current());
  assert.strictEqual(r.payments.by_method.other.amount_cents, 30000);
});

test('the owner corrects a payment entered as cash that was GCash; anyone else needs the owner\'s PIN', () => {
  const o = ticket([custom('Custom cake', 1200)]);
  pay(o, [{ method: 'cash', amount: 1200 }]);
  const p = paymentOf(o.id)[0];
  const before = expected();

  const e = errorOf(() => corrections.correctPayment(p.id, { method: 'gcash', reference: 'GC9', why: 'was GCash' }, cashier));
  assert.deepStrictEqual([e.status, e.body.override_required], [403, true]);
  assert.ok(errorOf(() => corrections.correctPayment(p.id, { method: 'gcash', reference: 'GC9', why: '' }, owner)).errors.why);
  assert.ok(errorOf(() => corrections.correctPayment(p.id, { method: 'gcash', why: 'was GCash' }, owner)).errors.reference);
  assert.ok(errorOf(() => corrections.correctPayment(p.id, { why: 'no change' }, owner)).errors.why, 'nothing different');
  assert.ok(errorOf(() => corrections.correctPayment(p.id, { amount: 1300, why: 'typo' }, owner)).errors.amount, 'not more than the order');

  corrections.correctPayment(p.id, { method: 'gcash', reference: 'GC9', why: 'was GCash', override: OWNER_OK }, cashier);
  assert.strictEqual(expected(), before - 120000, 'out of the drawer');
  const fixed = paymentOf(o.id)[0];
  assert.deepStrictEqual([fixed.method, fixed.reference, fixed.tendered_cents, fixed.change_cents], ['gcash', 'GC9', null, 0]);
  assert.ok(orderRow(o.id).paid_at, 'still paid');
  const entry = audit.list({ action: 'payment_correct' })[0];
  assert.deepStrictEqual([entry.staff_name, entry.approver_name, entry.reason], ['Ana', 'Dachel', 'was GCash']);
  assert.deepStrictEqual(entry.details.before, { method: 'cash', amount_cents: 120000, reference: '' });
  assert.deepStrictEqual(entry.details.after, { method: 'gcash', amount_cents: 120000, reference: 'GC9' });

  // Back to cash, at a lower amount: the order is short again and unpaid.
  corrections.correctPayment(p.id, { method: 'cash', amount: 1000, why: 'typed wrong' }, owner);
  assert.strictEqual(expected(), before - 20000);
  assert.strictEqual(orderRow(o.id).paid_at, null, 'not fully paid any more');
});

test('deleting a payment leaves the order unpaid, to be paid again; refunded orders are left alone', () => {
  const o = ticket([custom('Mistake', 250)]);
  pay(o, [{ method: 'cash', amount: 250 }]);
  const before = expected();
  corrections.deletePayment(paymentOf(o.id)[0].id, { why: 'paid twice by mistake' }, owner);
  assert.deepStrictEqual([paymentOf(o.id).length, orderRow(o.id).paid_at, expected()], [0, null, before - 25000]);
  assert.ok(pos.open().some((x) => x.id === o.id), 'back among the open tabs');
  pay(o, [{ method: 'cash', amount: 250 }]);
  assert.ok(orderRow(o.id).paid_at);

  payments.refund(o.id, { request_key: key(), method: 'cash', reason: 'returned', override: OWNER_OK }, cashier);
  const e = errorOf(() => corrections.deletePayment(paymentOf(o.id)[0].id, { why: 'x' }, owner));
  assert.strictEqual(e.status, 409);
  assert.strictEqual(audit.list({ action: 'payment_delete' })[0].details.method, 'cash');
});

test('cash in and out are corrected or deleted, and the drawer follows', () => {
  shifts.cashMove({ kind: 'out', amount: 80, reason: 'ice' }, cashier);
  const mv = corrections.entries().moves[0];
  const before = expected();
  corrections.correctMove(mv.id, { amount: 800, why: 'it was 800 for the cake board' , reason: 'cake board' }, owner);
  assert.strictEqual(expected(), before - 72000);
  assert.deepStrictEqual(audit.list({ action: 'cash_move_correct' })[0].details.before, { kind: 'out', amount_cents: 8000, reason: 'ice' });
  // Without the entry the drawer would hold before + 80.
  corrections.correctMove(mv.id, { kind: 'in', why: 'it was cash in' }, owner);
  assert.strictEqual(expected(), before + 8000 + 80000, '800 in instead of 800 out');
  corrections.deleteMove(mv.id, { why: 'never happened' }, owner);
  assert.strictEqual(expected(), before + 8000);
  assert.strictEqual(errorOf(() => corrections.deleteMove(mv.id, { why: 'again' }, owner)).status, 404);
  assert.ok(errorOf(() => corrections.correctMove(9999, { why: 'x' }, owner)).status === 404);
});

test('a correction to a closed shift recounts it and keeps the reading printed at close', () => {
  const o = ticket([custom('Late entry', 400)]);
  pay(o, [{ method: 'cash', amount: 400 }]);
  const shiftId = shifts.current().id;
  const counted = expected() - 40000; // the drawer really had 400 less: it was paid by GCash
  const z = shifts.close({ counted_cash: counted / 100, note: 'short by 400' }, cashier);
  assert.strictEqual(z.cash.difference_cents, -40000);

  const p = paymentOf(o.id)[0];
  corrections.correctPayment(p.id, { method: 'gcash', reference: 'GC77', why: 'was GCash, not cash' }, owner);
  const after = shifts.report(shiftId);
  assert.strictEqual(after.cash.difference_cents, 0, 'the drawer now balances');
  assert.strictEqual(after.cash.counted_cents, counted, 'the count stays as counted');
  assert.strictEqual(after.corrected.by, 'Dachel');
  assert.strictEqual(after.original.cash.difference_cents, -40000, 'the printed reading is kept');
  const row = shifts.get(shiftId);
  assert.ok(row.corrected_at);
  assert.strictEqual(row.expected_cash_cents, after.cash.expected_cents);

  // A second correction keeps the first original.
  corrections.correctPayment(p.id, { reference: 'GC78', why: 'reference typo' }, owner);
  assert.strictEqual(shifts.report(shiftId).original.cash.difference_cents, -40000);
  assert.strictEqual(corrections.entries(shiftId).shift.id, shiftId, 'a closed shift can be listed');
  shifts.open({ opening_cash: 500 }, cashier);
});

test('the routes: entries for owner and cashier, corrections with the owner\'s PIN', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  auth.createUser('corr@example.com', 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail('corr@example.com').id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const call = (p, { method = 'GET', body, staffToken, noCsrf } = {}) => fetch(`${url}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json', Cookie: cookie, ...(noCsrf ? {} : { 'X-CSRF-Token': csrf }),
      ...(staffToken ? { 'X-Staff-Token': staffToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const unlock = (s, pin) => call('/api/pos/unlock', { method: 'POST', body: { staff_id: s.id, pin } }).then((r) => r.json());
  try {
    const o = ticket([custom('Route test', 100)]);
    pay(o, [{ method: 'cash', amount: 100 }]);
    const p = paymentOf(o.id)[0];
    assert.strictEqual((await call('/api/pos/entries')).status, 423, 'locked without a PIN');
    const ben = await unlock(waiter, '4702');
    const ana = await unlock(cashier, '3691');
    assert.strictEqual((await call('/api/pos/entries', { staffToken: ben.token })).status, 403, 'not for waiters');
    const list = await (await call('/api/pos/entries', { staffToken: ana.token })).json();
    assert.ok(list.payments.some((x) => x.id === p.id) && Array.isArray(list.moves) && list.shifts.length > 0);

    const path_ = `/api/pos/payments/${p.id}/correct`;
    const noCsrf = await call(path_, { method: 'POST', body: { method: 'gcash', reference: 'G1', why: 'x' }, staffToken: ana.token, noCsrf: true });
    assert.strictEqual(noCsrf.status, 403);
    const needs = await call(path_, { method: 'POST', body: { method: 'gcash', reference: 'G1', why: 'x' }, staffToken: ana.token });
    assert.deepStrictEqual([needs.status, (await needs.json()).override_required], [403, true]);
    const wrong = await call(path_, { method: 'POST', body: { method: 'gcash', reference: 'G1', why: 'x', override: { staff_id: owner.id, pin: '0000' } }, staffToken: ana.token });
    assert.deepStrictEqual([wrong.status, (await wrong.json()).wrong_pin], [403, true], 'never 401');
    const ok = await call(path_, { method: 'POST', body: { method: 'gcash', reference: 'G1', why: 'was GCash', override: OWNER_OK }, staffToken: ana.token });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(paymentOf(o.id)[0].method, 'gcash');
    const del = await call(`/api/pos/payments/${p.id}/delete`, { method: 'POST', body: { why: 'test', override: OWNER_OK }, staffToken: ana.token });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await call(`/api/pos/payments/${p.id}/delete`, { method: 'POST', body: { why: 'again', override: OWNER_OK }, staffToken: ana.token })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
