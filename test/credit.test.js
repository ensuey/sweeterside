'use strict';
/* Utang: customers who pay later (server/credit.js, payments.pay with method
   'utang', collections, the shift and the reports). Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-credit-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const orders = require('../server/orders');
const menu = require('../server/menu');
const audit = require('../server/audit');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const reports = require('../server/reports');
const corrections = require('../server/corrections');
const credit = require('../server/credit');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
const OWNER_OK = { staff_id: owner.id, pin: '2580' };

const item = (name) => menu.list().find((i) => i.name === name);
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
/** A sent takeout of `qty` Bacon and Egg Sandwiches (Php 85 each). */
const order = (qty = 1) => pos.save(null, {
  request_key: key(), type: 'pickup', customer_name: '', send: true,
  lines: [{ key: `k${++seq}`, item_id: item('Bacon and Egg Sandwich').id, qty }],
}, cashier).order;
const pay = (o, parts, actor = cashier, override) => payments.pay(o.id, { request_key: key(), payments: parts, override }, actor);
const collect = (id, body, actor = cashier) => credit.collect(id, { request_key: key(), ...body }, actor);
const status = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.status || (e.errors ? 422 : e.message); } };

shifts.open({ opening_cash: 1000 }, cashier);
const lola = credit.create({ name: 'Lola Nena', phone: '0917 555 1234', limit: 300, note: 'Neighbour' }, owner).account;
const kuya = credit.create({ name: 'Kuya Jun', limit: '' }, owner).account;

test('the list: the owner adds people; a cashier needs the owner\'s PIN; phones are masked in lists', () => {
  assert.strictEqual(lola.phone, '0917 555 1234', 'the owner sees the number they typed');
  assert.strictEqual(kuya.limit_cents, null, 'blank: no limit');
  const listed = credit.list().find((a) => a.id === lola.id);
  assert.deepStrictEqual([listed.phone, listed.balance_cents, listed.left_cents], ['****1234', 0, 30000]);

  assert.throws(() => credit.create({ name: 'New Suki' }, cashier), (e) => e.status === 403 && e.body.override_required);
  const added = credit.create({ name: 'New Suki', override: OWNER_OK }, cashier).account;
  assert.ok(audit.list({ action: 'override' }).some((e) => e.details && e.details.permissions[0] === 'manage_credit'));
  assert.throws(() => credit.create({ name: 'new suki' }, owner), (e) => !!(e.errors && e.errors.name), 'no two with one name');
  assert.throws(() => credit.create({ name: 'X', phone: '12345' }, owner), (e) => !!(e.errors && e.errors.phone));
  assert.throws(() => credit.update(added.id, { limit: 50 }, cashier), (e) => e.status === 403);
  assert.strictEqual(credit.update(added.id, { limit: 50 }, owner).account.limit_cents, 5000);
  const logged = audit.list({ action: 'credit_account' });
  assert.ok(logged.length >= 3);
  assert.ok(!JSON.stringify(logged).includes('Suki') && !JSON.stringify(logged).includes('555'), 'no names or phones in the log');
});

test('charging: a sale today, not drawer cash; split with cash; over the limit needs the owner', () => {
  const before = shifts.reading(shifts.current());
  const salesBefore = reports.summary({}).totals.total;
  const a = order(2); // 170
  const res = pay(a, [{ method: 'cash', amount: 70 }, { method: 'utang', amount: 100, account_id: lola.id }]);
  assert.ok(res.order.paid, 'paid: a sale now');
  assert.strictEqual(credit.balance(lola.id), 10000);
  const after = shifts.reading(shifts.current());
  assert.strictEqual(after.sales.total_cents - before.sales.total_cents, 17000, 'the whole order is in the shift sales');
  assert.strictEqual(after.cash.expected_cents - before.cash.expected_cents, 7000, 'only the cash part is in the drawer');
  assert.strictEqual(after.payments.by_method.utang.amount_cents, 10000);
  assert.strictEqual(reports.summary({}).totals.total - salesBefore, 17000, 'in the reports today');

  // 100 owed, limit 300: another 255 is over.
  const b = order(3); // 255
  assert.throws(() => pay(b, [{ method: 'utang', amount: 255, account_id: lola.id }]),
    (e) => e.status === 403 && e.body.override_required && e.body.needs[0] === 'credit_over_limit');
  assert.throws(() => pay(b, [{ method: 'utang', amount: 255, account_id: lola.id }], cashier, { staff_id: owner.id, pin: '0000' }),
    (e) => e.status === 403 && e.body.wrong_pin);
  assert.strictEqual(credit.balance(lola.id), 10000, 'nothing written by a refusal');
  pay(b, [{ method: 'utang', amount: 255, account_id: lola.id }], cashier, OWNER_OK);
  assert.strictEqual(credit.balance(lola.id), 35500);
  assert.ok(audit.list({ action: 'override' }).some((e) => e.order_id === b.id && e.details.permissions[0] === 'credit_over_limit'));
  const slip = payments.receipt(b.id, cashier);
  assert.deepStrictEqual(slip.utang, { name: 'Lola Nena', balance_cents: 35500 });

  // The owner charges over a limit without a PIN; no limit, no question.
  pay(order(), [{ method: 'utang', amount: 85, account_id: kuya.id }]);
  assert.strictEqual(credit.balance(kuya.id), 8500);
});

test('charging is refused for an unknown or switched-off customer, a waiter, a missing customer, or two customers', () => {
  const o = order();
  const off = credit.create({ name: 'Gone Away' }, owner).account;
  credit.update(off.id, { active: false }, owner);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 85 }])), 422);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 85, account_id: 99999 }])), 422);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 85, account_id: off.id }])), 422);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 85, account_id: kuya.id }], waiter)), 403);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 40, account_id: kuya.id },
    { method: 'utang', amount: 45, account_id: lola.id }])), 422);
  assert.ok(!payments.balance(o.id).paid, 'still unpaid after every refusal');
  pay(o, [{ method: 'utang', amount: 40, account_id: kuya.id }]);
  assert.strictEqual(status(() => pay(o, [{ method: 'utang', amount: 45, account_id: lola.id }])), 422, 'one customer per order');
  pay(o, [{ method: 'utang', amount: 45, account_id: kuya.id }]);
  assert.strictEqual(credit.balance(kuya.id), 17000);
});

test('paying it back: cash into the drawer, not a sale; never more than owed; counted once', () => {
  const owed = credit.balance(lola.id); // 355
  const before = shifts.reading(shifts.current());
  const r = collect(lola.id, { method: 'cash', amount: 200, tendered: 500 });
  assert.deepStrictEqual([r.change_cents, r.balance_after_cents, r.account.name], [30000, owed - 20000, 'Lola Nena']);
  const after = shifts.reading(shifts.current());
  assert.strictEqual(after.cash.expected_cents - before.cash.expected_cents, 20000, 'the cash is in the drawer');
  assert.strictEqual(after.sales.total_cents, before.sales.total_cents, 'not a sale');
  assert.strictEqual(after.utang_collected.by_method.cash.amount_cents, 20000);

  const k = key();
  collect(lola.id, { request_key: k, method: 'gcash', amount: 50, reference: 'G-777' });
  const again = collect(lola.id, { request_key: k, method: 'gcash', amount: 50, reference: 'G-777' });
  assert.ok(again.replayed, 'a retry is not counted twice');
  assert.strictEqual(credit.balance(lola.id), owed - 25000);

  assert.strictEqual(status(() => collect(lola.id, { method: 'cash', amount: 200 })), 422, 'more than owed');
  assert.strictEqual(status(() => collect(lola.id, { method: 'gcash', amount: 10 })), 422, 'GCash needs a reference');
  assert.strictEqual(status(() => collect(lola.id, { method: 'utang', amount: 10 })), 422, 'not with more utang');
  assert.strictEqual(status(() => collect(lola.id, { method: 'cash', amount: 10 }, waiter)), 403);
  const log = audit.list({ action: 'credit_collect' });
  assert.ok(log.length >= 2 && !JSON.stringify(log).includes('Lola'));
});

test('cash back needs an open shift', () => {
  const shift = shifts.current();
  const expected = shifts.reading(shift).cash.expected_cents;
  shifts.close({ counted_cash: expected / 100 }, cashier);
  assert.strictEqual(status(() => collect(kuya.id, { method: 'cash', amount: 10 })), 409);
  shifts.open({ opening_cash: 1000 }, cashier);
});

test('taking utang off: a refund to utang, deleting the payment or the order; never below nothing', () => {
  const start = credit.balance(kuya.id);
  const o = order(2); // 170
  pay(o, [{ method: 'utang', amount: 170, account_id: kuya.id }]);
  const line = pos.view(o.id, owner).lines[0];
  payments.refund(o.id, { request_key: key(), lines: [{ line_id: line.id, qty: 1 }], method: 'utang', reason: 'Wrong item', override: OWNER_OK }, cashier);
  assert.strictEqual(credit.balance(kuya.id), start + 8500);
  // An order that was not utang cannot be refunded to utang.
  const cash = order();
  pay(cash, [{ method: 'cash', amount: 85 }]);
  assert.strictEqual(status(() => payments.refund(cash.id, { request_key: key(), method: 'utang', reason: 'x', override: OWNER_OK }, cashier)), 422);

  // Deleting an utang payment (owner) takes it off.
  const d = order();
  pay(d, [{ method: 'utang', amount: 85, account_id: kuya.id }]);
  const p = db.prepare("SELECT id FROM payments WHERE order_id = ? AND method = 'utang'").get(d.id);
  assert.strictEqual(status(() => corrections.correctPayment(p.id, { method: 'cash', why: 'was cash' }, owner)), 422, 'not to or from utang');
  corrections.deletePayment(p.id, { why: 'wrong customer' }, owner);
  assert.strictEqual(credit.balance(kuya.id), start + 8500);

  // Deleting a test order takes its utang off too.
  const t = order();
  pay(t, [{ method: 'utang', amount: 85, account_id: kuya.id }]);
  orders.remove(t.id, owner);
  assert.strictEqual(credit.balance(kuya.id), start + 8500);

  // Once paid back, the charge cannot be deleted (they would owe less than nothing).
  const all = credit.balance(kuya.id);
  collect(kuya.id, { method: 'cash', amount: all / 100 });
  const first = db.prepare("SELECT id FROM payments WHERE credit_account_id = ? ORDER BY id LIMIT 1").get(kuya.id);
  assert.strictEqual(status(() => corrections.deletePayment(first.id, { why: 'x' }, owner)), 422);
  assert.strictEqual(credit.balance(kuya.id), 0);
});

test('switching someone off needs a zero balance; deleting a collection is the owner\'s, and recounts a closed shift', () => {
  assert.ok(credit.balance(lola.id) > 0);
  assert.strictEqual(status(() => credit.update(lola.id, { active: false }, owner)), 422);
  const r = collect(lola.id, { method: 'cash', amount: 10 });
  const id = r.collection.id;
  assert.strictEqual(status(() => credit.deleteCollection(id, { why: 'typo' }, cashier)), 403);
  assert.strictEqual(status(() => credit.deleteCollection(id, {}, owner)), 422, 'a reason');
  const shift = shifts.current();
  shifts.close({ counted_cash: shifts.reading(shift).cash.expected_cents / 100 }, cashier);
  shifts.open({ opening_cash: 1000 }, cashier);
  const before = credit.balance(lola.id);
  const collectedBefore = JSON.parse(shifts.get(shift.id).z_report).cash.utang_collected_cents;
  credit.deleteCollection(id, { why: 'typo', override: OWNER_OK }, cashier);
  assert.strictEqual(credit.balance(lola.id), before + 1000);
  const z = shifts.get(shift.id);
  assert.ok(z.corrected_at && z.z_original, 'the closed shift was worked out again');
  assert.strictEqual(JSON.parse(z.z_report).cash.utang_collected_cents, collectedBefore - 1000);
});

test('the report: who owes what, charged and collected; the CSV has no phones and defuses formulas', () => {
  credit.create({ name: '=HYPERLINK("x")', phone: '0918 000 9876' }, owner);
  const sneaky = credit.list().find((a) => a.name.startsWith('='));
  pay(order(), [{ method: 'utang', amount: 85, account_id: sneaky.id }]);
  const r = reports.utang({});
  assert.strictEqual(r.outstanding, r.accounts.reduce((n, a) => n + Math.max(0, a.balance), 0));
  assert.ok(r.accounts.some((a) => a.id === lola.id));
  assert.ok(r.charged.amount > 0 && r.collected_total > 0);
  const csv = reports.utangCsv({});
  assert.match(csv, /^Customer,Owes \(Php\),Limit \(Php\),On the list\r\n/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)",85,,Yes/);
  assert.ok(!csv.includes('0918') && !csv.includes('9876'), 'no phones');
});

test('the endpoints: session, CSRF, a PIN, the right role; a locked POS is 423', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = 'credit@example.com';
  auth.createUser(email, 'a-long-enough-password');
  try {
    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const call = (p, { method = 'GET', body, token, noCsrf = false, noCookie = false } = {}) => fetch(`${url}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json', ...(noCookie ? {} : { Cookie: cookie }),
        ...(noCsrf ? {} : { 'X-CSRF-Token': csrf }), ...(token ? { 'X-Staff-Token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const unlock = async (who, pin) => (await (await call('/api/pos/unlock', { method: 'POST', body: { staff_id: who.id, pin } })).json()).token;
    const t = { owner: await unlock(owner, '2580'), cashier: await unlock(cashier, '3691'), waiter: await unlock(waiter, '4702') };

    assert.strictEqual((await call('/api/pos/credit', { noCookie: true, token: t.cashier })).status, 401);
    assert.strictEqual((await call('/api/pos/credit')).status, 423, 'locked');
    assert.strictEqual((await call('/api/pos/credit', { token: t.waiter })).status, 403, 'not for waiters');
    const listRes = await call('/api/pos/credit', { token: t.cashier });
    assert.strictEqual(listRes.status, 200);
    const listed = (await listRes.json()).accounts;
    assert.ok(listed.length && !JSON.stringify(listed).includes('555 1234'), 'phones masked');
    const one = await (await call(`/api/pos/credit/${lola.id}`, { token: t.cashier })).json();
    assert.strictEqual(one.account.phone, '****1234', 'a cashier sees it masked');
    assert.strictEqual((await (await call(`/api/pos/credit/${lola.id}`, { token: t.owner })).json()).account.phone, '0917 555 1234');

    const add = { name: 'Via Http' };
    assert.strictEqual((await call('/api/pos/credit', { method: 'POST', body: add, token: t.owner, noCsrf: true })).status, 403, 'CSRF');
    const needsPin = await call('/api/pos/credit', { method: 'POST', body: add, token: t.cashier });
    assert.deepStrictEqual([needsPin.status, (await needsPin.json()).override_required], [403, true]);
    const wrong = await call('/api/pos/credit', { method: 'POST', body: { ...add, override: { staff_id: owner.id, pin: '0000' } }, token: t.cashier });
    assert.deepStrictEqual([wrong.status, (await wrong.json()).wrong_pin], [403, true], 'never 401');
    assert.strictEqual((await call('/api/pos/credit', { method: 'POST', body: { ...add, override: OWNER_OK }, token: t.cashier })).status, 201);

    const owes = credit.balance(lola.id);
    const c = await call(`/api/pos/credit/${lola.id}/collect`, {
      method: 'POST', token: t.cashier, body: { request_key: key(), method: 'cash', amount: 5 },
    });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(credit.balance(lola.id), owes - 500);
    const cid = (await c.json()).collection.id;
    assert.strictEqual((await call(`/api/pos/credit/collections/${cid}`, { token: t.cashier })).status, 200);
    assert.strictEqual((await call(`/api/pos/credit/${lola.id}/collect`, {
      method: 'POST', token: t.waiter, body: { request_key: key(), method: 'cash', amount: 5 },
    })).status, 403);
    assert.strictEqual((await call(`/api/pos/credit/collections/${cid}/delete`, {
      method: 'POST', token: t.cashier, body: { why: 'test' },
    })).status, 403);
    assert.strictEqual((await call(`/api/reports/utang`, { token: t.cashier })).status, 403, 'reports are the owner\'s');
    assert.strictEqual((await call(`/api/reports/utang`, { token: t.owner })).status, 200);
    assert.strictEqual((await call(`/api/reports/utang.csv`, { token: t.owner })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
