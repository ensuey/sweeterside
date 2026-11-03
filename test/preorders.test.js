'use strict';
/* PR E, pre-orders and scheduled orders: pick-up on a day and a 15-minute
   slot, delivery as soon as possible or in a 30-minute window, up to N days
   ahead, in Manila time. Daily limits count the day an order is for. Own
   throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-preorders-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { db, seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
const schedule = require('../server/schedule');
const push = require('../server/push');
const deliveryAreas = require('../server/delivery');
seedIfEmpty();
orders.updateSettings({ open_at: '10:00', close_at: '20:00', preorder_days: 3 });
const AREA = deliveryAreas.create({ name: 'Test Area', fee: 0 });

// Times in Manila (UTC+8) on Fri 23 Oct 2026.
const manila = (h, m = 0, day = 23) => new Date(Date.UTC(2026, 9, day, h - 8, m));
const hm = (list) => list.map(schedule.hhmm);
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
let phoneSeq = 10;
const matcha = () => menu.list().find((i) => i.name === 'Matcha Frappe'); // ₱129
const input = (over = {}) => ({
  name: 'Ana Reyes', phone: `0917 123 45${++phoneSeq}`, address: '12 Mabini St', landmark: 'green gate beside the store',
  delivery_area: AREA.id, items: [{ id: matcha().id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});
const place = (over, now) => orders.create(input(over), { now });

test('pick-up slots: every 15 minutes in the hours, from 15 minutes ahead today', () => {
  const noon = manila(12, 0);
  const today = hm(schedule.slots('pickup', '2026-10-23', noon));
  assert.deepStrictEqual([today[0], today.at(-1), today.length], ['12:15', '20:00', 32]);
  const tomorrow = hm(schedule.slots('pickup', '2026-10-24', noon));
  assert.deepStrictEqual([tomorrow[0], tomorrow.at(-1)], ['10:00', '20:00']);
  // Delivery: 30-minute windows that end by closing, 30 minutes ahead today.
  const del = hm(schedule.slots('delivery', '2026-10-23', manila(12, 10)));
  assert.deepStrictEqual([del[0], del.at(-1)], ['13:00', '19:30']);
  assert.strictEqual(schedule.label({ order_type: 'delivery', scheduled_for: schedule.utcSql('2026-10-24', 11 * 60 + 30) }),
    'Sat 24 Oct, 11:30 AM–12:00 PM', 'a window across noon');
  // Nothing before today or past N days.
  assert.deepStrictEqual(schedule.slots('pickup', '2026-10-22', noon), []);
  assert.deepStrictEqual(schedule.slots('pickup', '2026-10-27', noon), []);
  assert.deepStrictEqual(schedule.dates('pickup', noon), ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
});

test('slots across midnight and closing time', () => {
  orders.updateSettings({ open_at: '06:00', close_at: '24:00' });
  try {
    // Open until midnight: the last pick-up is 23:45 (a time at midnight is not offered).
    assert.strictEqual(hm(schedule.slots('pickup', '2026-10-23', manila(12))).at(-1), '23:45');
    assert.strictEqual(hm(schedule.slots('delivery', '2026-10-23', manila(12))).at(-1), '23:30');
    // At 23:40 nothing is left today; the next is tomorrow at opening.
    const late = manila(23, 40);
    assert.deepStrictEqual(schedule.slots('pickup', '2026-10-23', late), []);
    assert.deepStrictEqual(schedule.next('pickup', late), { date: '2026-10-24', minutes: 6 * 60 });
    // The UTC time saved for 06:00 on the 24th in Manila is 22:00 on the 23rd.
    assert.strictEqual(schedule.utcSql('2026-10-24', 6 * 60), '2026-10-23 22:00:00');
    assert.deepStrictEqual(schedule.fromUtcSql('2026-10-23 22:00:00'), { date: '2026-10-24', minutes: 360 });
  } finally {
    orders.updateSettings({ open_at: '10:00', close_at: '20:00' });
  }
  // After closing (20:00) today is over.
  assert.deepStrictEqual(schedule.dates('pickup', manila(20, 5)), ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('past, too soon, off the grid and beyond N days are refused', () => {
  const noon = manila(12);
  const bad = [
    [{ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-10-22' }, /passed/],
    [{ type: 'pickup', pickup_at: '12:00' }, /too soon/],
    [{ type: 'pickup', pickup_at: '12:10' }, /from the list/],
    [{ type: 'pickup', pickup_at: '09:45', pickup_date: '2026-10-24' }, /from the list/],
    [{ type: 'pickup', pickup_at: '20:15', pickup_date: '2026-10-24' }, /from the list/],
    [{ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-10-27' }, /up to 3 days/],
    [{ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-02-30' }, /day from the list/],
    [{ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-13-01' }, /day from the list/],
    [{ type: 'pickup', pickup_at: '10:00', pickup_date: 'tomorrow' }, /day from the list/],
    [{ type: 'delivery', deliver_at: '12:00' }, /too soon/], // 12:30 is the first offered at noon
    [{ type: 'delivery', deliver_at: '19:45', deliver_date: '2026-10-24' }, /from the list/],
    [{ type: 'delivery', deliver_at: '10:15', deliver_date: '2026-10-24' }, /from the list/],
  ];
  for (const [over, pattern] of bad) {
    const e = errorsOf(() => place(over, noon));
    const msg = e && (e.pickup_at || e.deliver_at);
    assert.ok(msg, `${JSON.stringify(over)} should be refused`);
    assert.match(msg, pattern, JSON.stringify(over));
  }
  // N is a setting; 0 means today only.
  assert.ok(errorsOf(() => orders.updateSettings({ preorder_days: 15 })).preorder_days);
  assert.ok(errorsOf(() => orders.updateSettings({ preorder_days: -1 })).preorder_days);
  orders.updateSettings({ preorder_days: 0 });
  assert.match(errorsOf(() => place({ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-10-24' }, noon)).pickup_at, /today only/);
  orders.updateSettings({ preorder_days: 3 });
});

test('closed now: a pre-order for later goes through; ASAP and dine-in do not', () => {
  const late = manila(20, 30);
  assert.match(errorsOf(() => place({ type: 'delivery' }, late)).deliver_at, /closed now.*tomorrow at 10:00 AM/);
  assert.match(errorsOf(() => place({ type: 'pickup', pickup_at: 'asap' }, late)).pickup_at, /closed now/);
  const dine = errorsOf(() => place({ type: 'dinein', table_no: '3', phone: '' }, late));
  assert.deepStrictEqual([dine.status, dine.body.closed], [409, true]);

  const o = place({ type: 'delivery', deliver_at: '10:30', deliver_date: '2026-10-24' }, late);
  assert.deepStrictEqual([o.scheduled_for, o.scheduled_date, o.scheduled_label],
    ['2026-10-24 02:30:00', '2026-10-24', 'Sat 24 Oct, 10:30–11:00 AM']);
  const p = place({ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-10-25' }, late);
  assert.deepStrictEqual([p.pickup_at, p.scheduled_label], ['10:00', 'Sun 25 Oct, 10:00 AM']);
  // The alert says when, and still nothing about the customer.
  const msg = push.orderMessage(o);
  assert.strictEqual(msg.body, 'Delivery · Scheduled Sat 24 Oct, 10:30–11:00 AM · 1 item · ₱129');
  assert.ok(!JSON.stringify(msg).includes('Ana') && !JSON.stringify(msg).includes('Mabini'));
  // As soon as possible while open is unchanged, and has no schedule.
  const now = place({ type: 'delivery' }, manila(12));
  assert.deepStrictEqual([now.scheduled_for, now.scheduled_label], [null, '']);
});

test('the Closed switch still blocks everything, pre-orders too', () => {
  orders.updateSettings({ shop_open: false });
  try {
    for (const now of [manila(12), manila(20, 30)]) {
      const e = errorsOf(() => place({ type: 'pickup', pickup_at: '10:00', pickup_date: '2026-10-24' }, now));
      assert.deepStrictEqual([e.status, e.body.closed], [409, true]);
    }
    assert.strictEqual(orders.canOrder(manila(20, 30)), false);
    assert.match(render.buildHtml(undefined, undefined, manila(20, 30)), /data-preorder="0"/);
  } finally {
    orders.updateSettings({ shop_open: true });
  }
});

test('daily limits count the day the order is for', () => {
  const pie = menu.create({ name: 'Daily Pie', price: 100, category_id: matcha().category_id, image: '', alt: '' });
  menu.setStock(pie.id, { availability: 'available', daily_limit: 2 });
  const late = manila(20, 30);
  const pieOrder = (qty, date) => place({ type: 'pickup', pickup_at: '11:00', pickup_date: date,
    items: [{ id: pie.id, qty }], expected_total: 100 * qty }, late);
  pieOrder(2, '2026-10-24');
  assert.strictEqual(menu.get(pie.id, { date: '2026-10-24' }).remaining, 0);
  assert.strictEqual(menu.get(pie.id, { date: '2026-10-25' }).remaining, 2, 'another day is untouched');
  assert.strictEqual(menu.get(pie.id, { now: late }).remaining, 2, 'and so is today');
  const full = errorsOf(() => pieOrder(1, '2026-10-24'));
  assert.ok(full && full.status === 409, 'the 24th is full');
  assert.strictEqual(pieOrder(2, '2026-10-25').total, 200);

  // The page shows the next day it can be ordered for, and the stock of every day.
  const html = render.buildHtml(undefined, undefined, late);
  const stock = JSON.parse(html.match(/data-stock="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  assert.deepStrictEqual([stock['2026-10-24'][pie.id], stock['2026-10-25'][pie.id], stock['2026-10-26'][pie.id]], [0, 0, 2]);
  assert.match(html, /You can pre-order for tomorrow at 10:00 AM\./);
  const card = html.split('<li class="card').find((c) => c.includes('data-name="Daily Pie"'));
  assert.ok(card.includes('data-soldout'), 'tomorrow (the next day) is full');
});

test('the queue lists scheduled orders by their time', () => {
  const ids = orders.list('active').map((o) => [o.scheduled_for || o.created_at, o.id]);
  const sorted = [...ids].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  assert.deepStrictEqual(ids, sorted);
});

// Bug found in the browser: the order endpoint's reply left out the scheduled
// time, so the confirmation screen did not show it.
test('placing a pre-order over HTTP: the reply carries the scheduled time', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const tomorrow = require('../server/clock').addDays(require('../server/clock').manilaDate(), 1);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input({ type: 'pickup', pickup_at: '10:00', pickup_date: tomorrow })),
    });
    assert.strictEqual(res.status, 201);
    const { order } = await res.json();
    assert.strictEqual(order.scheduled_label, schedule.label({ order_type: 'pickup', scheduled_for: schedule.utcSql(tomorrow, 600) }));
    assert.match(order.scheduled_label, /, 10:00 AM$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
