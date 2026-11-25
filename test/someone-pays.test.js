'use strict';
/* Someone else pays: the receiver orders, a payer anywhere pays by GCash or
   bank transfer through a link and gives the reference, and the order starts
   only when the owner taps Payment received. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-someone-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { seedIfEmpty, db } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const paymongo = require('../server/paymongo');
const deliveryAreas = require('../server/delivery');
seedIfEmpty();
orders.updateSettings({ open_at: '10:00', close_at: '20:00', preorder_days: 3 });
const AREA = deliveryAreas.create({ name: 'Test Area', fee: 0 });

// Times in Manila (UTC+8) on Fri 23 Oct 2026.
const manila = (h, m = 0, day = 23) => new Date(Date.UTC(2026, 9, day, h - 8, m));
const NOON = manila(12);
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
let phoneSeq = 10;
const frappe = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // ₱129, no options
const input = (over = {}) => ({
  type: 'pickup', name: 'Ana Reyes', phone: `0917 123 45${++phoneSeq}`,
  items: [{ id: frappe().id, qty: 1 }], expected_total: 129, pay: 'someone',
  pickup_at: '16:00', pickup_date: '2026-10-23',
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});
const place = (over, now = NOON) => orders.create(input(over), { now });
const turnOn = () => orders.updateSettings({ someone_pays: '1', pay_gcash_name: 'Dachel S.', pay_gcash_number: '0917 555 1234' });

test('someone pays: refused while the switch is off', () => {
  orders.updateSettings({ someone_pays: '0' });
  assert.ok(errorsOf(() => place()).pay);
});

test('someone pays: dine-in and Other area refused', () => {
  turnOn();
  assert.ok(errorsOf(() => place({ type: 'dinein', table_no: '3', pickup_at: '', pickup_date: '' })).pay);
  const e = errorsOf(() => place({ type: 'delivery', address: '12 Mabini St', landmark: 'green gate beside the store',
    delivery_area: 'other', deliver_at: '16:00', deliver_date: '2026-10-23', pickup_at: '', pickup_date: '' }));
  assert.ok(e && (e.pay || e.delivery_area), 'refused');
});

test('someone pays: ASAP and times under 3 hours refused', () => {
  turnOn();
  assert.match(errorsOf(() => place({ pickup_at: 'asap', pickup_date: '' })).pickup_at, /3 hours/);
  assert.match(errorsOf(() => place({ pickup_at: '14:30' })).pickup_at, /3 hours/);
  assert.strictEqual(place({ pickup_at: '15:00' }).pay_method, 'someone');
});

test('someone pays: saved as awaiting with its own payer token', () => {
  turnOn();
  const o = place();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  assert.strictEqual(row.pay_method, 'someone');
  assert.strictEqual(row.pay_status, 'awaiting');
  assert.strictEqual(row.cash_cents, 0);
  assert.strictEqual(row.payer_token.length, 32);
  assert.notStrictEqual(row.payer_token, row.pay_token);
});

test('someone pays: not in the active list, waiting or being checked', () => {
  turnOn();
  const o = place();
  const ids = () => orders.list('active').map((x) => x.id);
  assert.ok(!ids().includes(o.id));
  db.prepare("UPDATE orders SET pay_status = 'checking' WHERE id = ?").run(o.id);
  assert.ok(!ids().includes(o.id));
});

test('someone pays: stock is held while waiting', () => {
  turnOn();
  const id = frappe().id;
  menu.setStock(id, { availability: 'available', daily_limit: '50' });
  const before = menu.list({ now: NOON }).find((i) => i.id === id).remaining;
  place({ items: [{ id, qty: 2 }], expected_total: 258 });
  assert.strictEqual(menu.list({ now: NOON }).find((i) => i.id === id).remaining, before - 2);
  menu.setStock(id, { availability: 'available', daily_limit: '' });
});

test('someone pays: the 15-minute GCash sweep leaves it alone', async () => {
  turnOn();
  const o = place();
  await paymongo.expireStale(new Date(Date.now() + 60 * 60000));
  assert.strictEqual(db.prepare('SELECT pay_status FROM orders WHERE id = ?').get(o.id).pay_status, 'awaiting');
});
