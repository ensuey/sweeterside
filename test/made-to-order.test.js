'use strict';
/* Made to order when sold out: an item sold out now, with a lead time in
   hours, can still be ordered for a time at least that far ahead. The daily
   limit still caps it; ASAP, dine-in and a time too soon are refused. Own
   throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-made-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
const schedule = require('../server/schedule');
const deliveryAreas = require('../server/delivery');
seedIfEmpty();
orders.updateSettings({ open_at: '10:00', close_at: '20:00', preorder_days: 3 });
const AREA = deliveryAreas.create({ name: 'Test Area', fee: 0 });

// Times in Manila (UTC+8) on Fri 23 Oct 2026.
const manila = (h, m = 0, day = 23) => new Date(Date.UTC(2026, 9, day, h - 8, m));
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
let phoneSeq = 10;
const cake = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // ₱129, no options
const input = (over = {}) => ({
  type: 'pickup', name: 'Ana Reyes', phone: `0917 123 45${++phoneSeq}`,
  items: [{ id: cake().id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});
const place = (over, now) => orders.create(input(over), { now });
const stockOf = (id, body) => menu.setStock(id, { availability: 'sold_out', daily_limit: '', ...body });

test('the lead time: whole hours 1 to 72, blank turns it off, left out leaves it', () => {
  const id = cake().id;
  assert.strictEqual(stockOf(id, { preorder_lead_hours: '2' }).preorder_lead_hours, 2);
  assert.strictEqual(menu.setStock(id, { availability: 'sold_out', daily_limit: '' }).preorder_lead_hours, 2, 'unchanged');
  for (const bad of ['0', '73', '1.5', 'abc', '2; DROP TABLE items']) {
    assert.ok(errorsOf(() => stockOf(id, { preorder_lead_hours: bad })).preorder_lead_hours, bad);
  }
  assert.strictEqual(stockOf(id, { preorder_lead_hours: '' }).preorder_lead_hours, null);
});

test('without a lead time a sold-out item is still refused', () => {
  stockOf(cake().id, { preorder_lead_hours: '' });
  const e = errorsOf(() => place({ pickup_at: '16:00', pickup_date: '2026-10-23' }, manila(12)));
  assert.strictEqual(e.status, 409, 'sold out');
});

test('sold out with a lead: on the menu as "Order", not sold out', () => {
  stockOf(cake().id, { preorder_lead_hours: '2' });
  const item = cake();
  assert.deepStrictEqual([item.sold_out, item.preorder_lead], [true, 2]);
  const card = render.buildHtml().split('<li class="card').find((c) => c.includes(`data-id="${item.id}"`));
  assert.ok(card, 'the card is on the menu');
  assert.match(card, /data-lead="2"/);
  assert.doesNotMatch(card, /data-soldout|card--soldout/);
  assert.match(card, /data-add>Order</);
  assert.match(card, /Sold out now · order ahead, ready in 2 hours/);
});

test('ASAP, dine-in and a time too soon are refused; one far enough ahead is taken', () => {
  stockOf(cake().id, { preorder_lead_hours: '2' });
  const noon = manila(12);
  assert.match(errorsOf(() => place({ pickup_at: 'asap' }, noon)).pickup_at, /needs 2 hours.*first is today at 2:00 PM/);
  assert.ok(errorsOf(() => place({ type: 'dinein', table_no: '3' }, noon)).type, 'dine-in is now only');
  assert.match(errorsOf(() => place({ pickup_at: '13:00', pickup_date: '2026-10-23' }, noon)).pickup_at, /needs 2 hours/);
  const ok = place({ pickup_at: '14:00', pickup_date: '2026-10-23' }, noon);
  assert.strictEqual(ok.total, 129);
  // Delivery too, on another day.
  const d = place({ type: 'delivery', address: '12 Mabini St', landmark: 'green gate beside the store',
    delivery_area: AREA.id, deliver_at: '10:00', deliver_date: '2026-10-24' }, noon);
  assert.strictEqual(d.total, 129);
});

test('the daily limit still caps it, per day', () => {
  stockOf(cake().id, { preorder_lead_hours: '1', daily_limit: '1' });
  const noon = manila(12);
  place({ pickup_at: '15:00', pickup_date: '2026-10-25' }, noon);
  const e = errorsOf(() => place({ pickup_at: '16:00', pickup_date: '2026-10-25' }, noon));
  assert.strictEqual(e.status, 409, 'that day is full');
  assert.ok(place({ pickup_at: '15:00', pickup_date: '2026-10-26' }, noon), 'another day is not');
});

test('slots start the lead time ahead, and move to the next day after closing', () => {
  const at = (h) => schedule.slots('pickup', '2026-10-23', manila(h), 120).map(schedule.hhmm);
  assert.strictEqual(at(12)[0], '14:00');
  assert.deepStrictEqual(schedule.slots('pickup', '2026-10-23', manila(19), 120), []);
  assert.deepStrictEqual(schedule.dates('pickup', manila(19), 24 * 60), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.strictEqual(schedule.slots('pickup', '2026-10-24', manila(19), 24 * 60).map(schedule.hhmm)[0], '19:00', 'a day ahead');
});

test('the cart offers times from the lead on: no "as soon as possible", no dine-in', () => {
  const cart = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'cart.js'), 'utf8');
  assert.match(cart, /lead: Number\(card\.dataset\.lead\) \|\| 0/);
  assert.match(cart, /Math\.max\(LEAD\[kind\], madeMinutes\(\)\)/);
  assert.match(cart, /openNow\(\) && !madeMinutes\(\)\) times\.push\(\{ value: 'asap'/);
  assert.match(cart, /dinein: openNow\(\) && !madeMinutes\(\)/);
});
