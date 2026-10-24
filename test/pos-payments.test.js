'use strict';
/* Payments, refunds, shifts and the cash drawer, X/Z readings and receipt
   data (server/payments.js, server/shifts.js). Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-pos-pay-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const staff = require('../server/staff');
const pos = require('../server/pos');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const audit = require('../server/audit');
const settings = require('../server/settings');
const vouchers = require('../server/vouchers');
const menu = require('../server/menu');

seedIfEmpty();

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
const OWNER_OK = { staff_id: owner.id, pin: '2580' };

const item = (name) => menu.list().find((i) => i.name === name);
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
const line = (name, qty = 1) => ({ key: `k${++seq}`, item_id: item(name).id, qty });
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}
/** A sent dine-in order: Matcha (129) + Beef Penne (135) = 264. */
function order(extra = {}) {
  return pos.save(null, {
    request_key: key(), type: 'dinein', table_no: String(++seq), lines: [line('Matcha Frappe'), line('Beef Penne Pasta')],
    send: true, ...extra,
  }, cashier).order;
}
const pay = (id, parts, extra = {}) => payments.pay(id, { request_key: key(), payments: parts, ...extra }, cashier);

test('cash needs an open shift; one shift at a time', () => {
  const o = order();
  const noShift = errorOf(() => pay(o.id, [{ method: 'cash', amount: 264 }]));
  assert.deepStrictEqual([noShift.status, noShift.body.code], [409, 'no_shift']);
  const x = shifts.open({ opening_cash: 1000 }, cashier);
  assert.deepStrictEqual([x.kind, x.cash.opening_cents, x.cash.expected_cents], ['X', 100000, 100000]);
  assert.strictEqual(errorOf(() => shifts.open({ opening_cash: 0 }, cashier)).status, 409);
  assert.strictEqual(audit.list({ action: 'shift_open' })[0].amount_cents, 100000);
});

test('split payment: GCash with a reference, then cash with change; paid only when covered', () => {
  const o = order();
  assert.ok(errorOf(() => pay(o.id, [{ method: 'gcash', amount: 100 }])).errors.reference, 'non-cash needs a reference');
  assert.ok(errorOf(() => pay(o.id, [{ method: 'gcash', amount: 300, reference: 'X1' }])).errors.payments, 'not more than due');

  const first = pay(o.id, [{ method: 'gcash', amount: 100, reference: '1029384756' }]);
  assert.deepStrictEqual([first.balance.paid, first.balance.paid_cents, first.balance.due_cents], [false, 10000, 16400]);
  assert.strictEqual(errorOf(() => pos.save(o.id, {
    request_key: key(), version: first.order.version, type: 'dinein', table_no: o.table_no,
    lines: first.order.lines.map((l) => ({ id: l.id, key: l.key, qty: l.qty })),
  }, cashier)).status, 409, 'no changes once payment has started');
  assert.strictEqual(errorOf(() => pos.voidOrder(o.id, { reason: 'x', override: OWNER_OK }, cashier)).status, 409);

  const second = pay(o.id, [{ method: 'cash', amount: 164, tendered: 500 }]);
  assert.deepStrictEqual([second.balance.paid, second.change_cents], [true, 33600]);
  assert.deepStrictEqual(second.payments.map((p) => [p.label, p.amount_cents, p.change_cents, p.reference]),
    [['GCash', 10000, 0, '1029384756'], ['Cash', 16400, 33600, '']]);
  assert.ok(!pos.open().some((x) => x.id === o.id), 'paid orders leave the open tabs');
  assert.strictEqual(errorOf(() => pay(o.id, [{ method: 'cash', amount: 1 }])).status, 409, 'already paid');
});

test('payments are idempotent, waiters need the owner, and a voucher counts once paid', () => {
  vouchers.create({ code: 'PAYTEN', kind: 'amount', value: 10 });
  const o = order({ discounts: { voucher_code: 'payten' } });
  assert.strictEqual(o.total, 254);
  assert.strictEqual(vouchers.list().find((v) => v.code === 'PAYTEN').uses, 0);

  const body = { request_key: key(), payments: [{ method: 'card', amount: 254, reference: 'APPR-7788' }] };
  const w = errorOf(() => payments.pay(o.id, body, waiter));
  assert.deepStrictEqual([w.status, w.body.override_required], [403, true]);
  const paid = payments.pay(o.id, { ...body, override: OWNER_OK }, waiter);
  assert.strictEqual(paid.balance.paid, true);
  assert.strictEqual(payments.pay(o.id, body, waiter).replayed, true, 'the same request twice pays once');
  assert.strictEqual(payments.paymentsOf(o.id).length, 1);
  assert.strictEqual(vouchers.list().find((v) => v.code === 'PAYTEN').uses, 1);

  // Pay and send in one go (takeout paid at the counter first).
  const t = pos.save(null, { request_key: key(), type: 'pickup', lines: [line('Matcha Frappe')] }, cashier).order;
  const r = pay(t.id, [{ method: 'cash', amount: 129, tendered: 129 }], { send: true });
  assert.deepStrictEqual(r.kitchen, [{ name: 'Matcha Frappe', qty: 1, note: '' }]);
  assert.strictEqual(r.order.status, 'confirmed');
});

test('refunds need the owner and a reason; by line or in full, never more than paid', () => {
  const o = order({ discounts: { manual: { kind: 'percent', value: 10, reason: 'Regular' } } });
  // 264 - 10% = 237.60: matcha 116.10, pasta 121.50.
  pay(o.id, [{ method: 'cash', amount: 237.6, tendered: 300 }]);
  const pasta = o.lines.find((l) => l.name === 'Beef Penne Pasta');

  const body = { request_key: key(), lines: [{ line_id: pasta.id, qty: 1 }], method: 'cash', reason: 'Too salty' };
  assert.strictEqual(errorOf(() => payments.refund(o.id, body, cashier)).body.override_required, true);
  assert.ok(errorOf(() => payments.refund(o.id, { ...body, reason: '' }, owner)).errors.reason);
  const r = payments.refund(o.id, { ...body, override: OWNER_OK }, cashier);
  assert.deepStrictEqual([r.refunds[0].amount_cents, r.refunds[0].approver, r.balance.refunded_cents], [12150, 'Dachel', 12150]);
  assert.ok(errorOf(() => payments.refund(o.id, { ...body, request_key: key() }, owner)).errors.lines, 'that line is refunded already');

  const full = payments.refund(o.id, { request_key: key(), method: 'gcash', reference: 'RF-1', reason: 'Wrong order' }, owner);
  assert.strictEqual(full.balance.refunded_cents, 23760, 'the rest, in full');
  assert.ok(errorOf(() => payments.refund(o.id, { request_key: key(), method: 'cash', reason: 'Again' }, owner)).errors.lines);
  const log = audit.list({ action: 'refund' });
  assert.deepStrictEqual(log.slice(0, 2).map((e) => e.amount_cents), [11610, 12150]);
  assert.strictEqual(errorOf(() => payments.refund(order().id, { request_key: key(), method: 'cash', reason: 'x' }, owner)).status, 409,
    'an unpaid order is voided, not refunded');
});

test('the X reading: sales, discounts by type, service charge apart, payments by method, expected cash', () => {
  settings.updatePosSettings({ service_charge_on: true });
  shifts.cashMove({ kind: 'out', amount: 80, reason: 'Bought ice' }, cashier);
  shifts.cashMove({ kind: 'in', amount: 200, reason: 'Change fund top-up' }, cashier);
  assert.ok(errorOf(() => shifts.cashMove({ kind: 'out', amount: 5, reason: '' }, cashier)).errors.reason);
  const o = order(); // 264 + 26.40 service charge
  pay(o.id, [{ method: 'maya', amount: 290.4, reference: 'MY-55' }]);
  settings.updatePosSettings({ service_charge_on: false });

  const x = shifts.reading(shifts.current());
  assert.strictEqual(x.kind, 'X');
  assert.strictEqual(x.sales.orders, 5);
  assert.strictEqual(x.sales.service_charge_cents, 2640, 'reported apart from sales');
  assert.strictEqual(x.sales.discounts.voucher, 1000);
  assert.strictEqual(x.sales.discounts.manual, 2640);
  assert.strictEqual(x.sales.net_sales_cents, x.sales.total_cents - 2640);
  assert.deepStrictEqual(Object.keys(x.payments.by_method).sort(), ['card', 'cash', 'gcash', 'maya']);
  assert.strictEqual(x.refunds.total_cents, 23760);
  // 1000 + cash taken (164 + 129 + 237.60) - cash refunded (121.50) + 200 - 80
  assert.strictEqual(x.cash.expected_cents, 100000 + 16400 + 12900 + 23760 - 12150 + 20000 - 8000);
  assert.deepStrictEqual(x.movements.map((m) => [m.kind, m.amount_cents, m.reason, m.staff]),
    [['out', 8000, 'Bought ice', 'Ana'], ['in', 20000, 'Change fund top-up', 'Ana']]);
});

test('closing the shift: counted vs expected, a note when they differ, the Z reading is kept', () => {
  const expected = shifts.reading(shifts.current()).cash.expected_cents;
  assert.ok(errorOf(() => shifts.close({ counted_cash: expected / 100 - 20 }, cashier)).errors.note);
  const z = shifts.close({ counted_cash: expected / 100 - 20, note: 'Short Php 20, checking' }, cashier);
  assert.deepStrictEqual([z.kind, z.cash.counted_cents, z.cash.difference_cents, z.note], ['Z', expected - 2000, -2000, 'Short Php 20, checking']);
  assert.strictEqual(shifts.current(), null);
  assert.deepStrictEqual(shifts.report(z.shift.id), JSON.parse(JSON.stringify(z)), 'the saved Z reading');
  assert.strictEqual(audit.list({ action: 'shift_close' })[0].details.difference_cents, -2000);
  assert.strictEqual(errorOf(() => pay(order().id, [{ method: 'cash', amount: 264 }])).body.code, 'no_shift');
});

test('receipts: the order, payments, settings, and the order-slip notice until BIR mode', () => {
  shifts.open({ opening_cash: 500 }, owner);
  const p = line('Beef Penne Pasta');
  const o = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '30', lines: [p], send: true,
    discounts: { claimants: [{ type: 'sc', name: 'Lola Remedios', id_no: 'OSCA-99887766', mode: 'exclusive', lines: { [p.key]: 1 } }] },
  }, cashier).order;
  pay(o.id, [{ method: 'cash', amount: 108, tendered: 200 }]);

  const r = payments.receipt(o.id, cashier);
  assert.strictEqual(r.order.pricing.claimants[0].id_no, 'OSCA-99887766', 'the cashier prints the full ID');
  assert.strictEqual(payments.receipt(o.id, waiter).order.pricing.claimants[0].id_no, '****7766');
  assert.strictEqual(r.cashier, 'Ana');
  assert.deepStrictEqual([r.settings.bir_mode, r.settings.receipt_width, r.settings.order_slip],
    [false, 80, 'ORDER SLIP — THIS IS NOT AN OFFICIAL RECEIPT']);
  assert.strictEqual(r.settings.bir_notice, 'THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX');
  assert.strictEqual(r.payments[0].change_cents, 9200);
  assert.ok(payments.recent().some((x) => x.id === o.id));

  const s = settings.updateReceiptSettings({ receipt_width: '58', bir_mode: true, bir_tin: '123-456-789-000', receipt_address: 'Main St' });
  assert.deepStrictEqual([s.receipt_width, s.bir_mode, s.bir_tin], [58, true, '123-456-789-000']);
  assert.ok(errorOf(() => settings.updateReceiptSettings({ receipt_width: '72', receipt_shop_name: '' })).errors.receipt_width);
  settings.updateReceiptSettings({ receipt_width: '80', bir_mode: false });
});

test('a refunded line takes back its share of the service charge', () => {
  settings.updatePosSettings({ service_charge_on: true });
  const o = order(); // 264 + 26.40
  pay(o.id, [{ method: 'card', amount: 290.4, reference: 'APPR-1' }]);
  const matcha = o.lines.find((l) => l.name === 'Matcha Frappe');
  const r = payments.refund(o.id, {
    request_key: key(), lines: [{ line_id: matcha.id, qty: 1 }], method: 'card', reference: 'RF-2', reason: 'Wrong drink',
  }, owner);
  assert.strictEqual(r.refunds[0].amount_cents, 12900 + 1290);
  settings.updatePosSettings({ service_charge_on: false });
});
