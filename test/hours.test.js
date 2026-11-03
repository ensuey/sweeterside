'use strict';
/* Opening hours: online ordering opens and closes with them, the menu says
   "Closing soon" in the last 30 minutes, and after closing it says closed and
   orders are refused. The Open/Closed switch still overrides. Own database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-hours-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
seedIfEmpty();

/** A time today in Manila (UTC+8), as a Date. */
const manila = (hh, mm) => new Date(Date.UTC(2026, 10, 3, hh - 8, mm));
const MATCHA = () => menu.list().find((i) => i.name === 'Matcha Frappe');
const order = () => ({
  type: 'dinein', name: 'Hours Test', table_no: '3', items: [{ id: MATCHA().id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)),
});
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test.beforeEach(() => orders.updateSettings({ open_at: '10:00', close_at: '20:00', shop_open: true }));

test('open from opening to closing, closing soon in the last 30 minutes, closed outside', () => {
  const at = (hh, mm) => orders.shopState(manila(hh, mm));
  assert.deepStrictEqual([at(9, 59).open, at(9, 59).before_opening], [false, true]);
  assert.deepStrictEqual([at(10, 0).open, at(10, 0).closing_soon], [true, false]);
  assert.deepStrictEqual([at(19, 29).open, at(19, 29).closing_soon], [true, false]);
  assert.deepStrictEqual([at(19, 30).open, at(19, 30).closing_soon, at(19, 30).minutes_left], [true, true, 30]);
  assert.deepStrictEqual([at(19, 59).closing_soon, at(19, 59).minutes_left], [true, 1]);
  assert.deepStrictEqual([at(20, 0).open, at(20, 0).before_opening, at(20, 0).closing_soon], [false, false, false]);
});

test('the Closed switch overrides the hours; Open follows them again', () => {
  orders.updateSettings({ shop_open: false, closed_note: 'Closed for the fiesta.' });
  const s = orders.shopState(manila(12, 0));
  assert.deepStrictEqual([s.open, s.switch_open, s.in_hours], [false, false, true]);
  assert.match(orders.closedMessage(manila(12, 0)), /Closed for the fiesta\./);
  orders.updateSettings({ shop_open: true, closed_note: '' });
  assert.strictEqual(orders.isShopOpen(manila(12, 0)), true);
});

test('orders are taken within the hours and refused outside them', () => {
  assert.ok(orders.create(order(), { now: manila(19, 45) }).id, 'closing soon still takes orders');
  for (const [hh, mm, text] of [[9, 30, /not open yet.*10:00 AM today/], [20, 0, /closed for today.*10:00 AM tomorrow/]]) {
    const err = errorOf(() => orders.create(order(), { now: manila(hh, mm) }));
    assert.deepStrictEqual([err.status, err.body.closed], [409, true]);
    assert.match(err.message, text);
  }
});

test('the menu page: open, closing soon with the bar, and closed after hours', () => {
  const open = render.buildHtml(undefined, undefined, manila(12, 0));
  assert.match(open, /data-shop-open="1"/);
  assert.match(open, /class="status status--open"[^>]*><span class="status__pill">Open now<\/span>[^<]*Orders until 8:00 PM/);
  assert.match(open, /<p class="soonbar" id="soonbar" role="status" hidden>/, 'no bar yet');

  const soon = render.buildHtml(undefined, undefined, manila(19, 40));
  assert.match(soon, /data-shop-open="1"/, 'still taking orders');
  assert.match(soon, /<span class="status__pill">Closing soon<\/span> We take orders until 8:00 PM today\./);
  assert.match(soon, /<p class="soonbar" id="soonbar" role="status">Closing soon: we take online orders until 8:00 PM today\.<\/p>/);

  const closed = render.buildHtml(undefined, undefined, manila(20, 5));
  assert.match(closed, /data-shop-open="0"/);
  assert.match(closed, /<span class="status__pill">Closed<\/span> We&#39;re closed for today\. We take orders again from 10:00 AM tomorrow\./);
  const early = render.buildHtml(undefined, undefined, manila(8, 0));
  assert.match(early, /We open at 10:00 AM today\./);

  // The page carries what hours.js needs to keep it current.
  for (const attr of ['data-switch-open="1"', 'data-soon-minutes="30"', 'data-pickup-open="10:00"', 'data-pickup-close="20:00"']) {
    assert.ok(open.includes(attr), attr);
  }
});

test('hours are validated: quarter hours, closing after opening, midnight allowed for closing', () => {
  const bad = (input) => errorOf(() => orders.updateSettings(input));
  assert.ok(bad({ open_at: '10:10' }).errors.open_at);
  assert.ok(bad({ close_at: '25:00' }).errors.close_at);
  assert.ok(bad({ open_at: '20:00', close_at: '10:00' }).errors.close_at);
  assert.ok(bad({ open_at: '24:00' }).errors.open_at, 'only closing can be midnight');
  const s = orders.updateSettings({ open_at: '06:00', close_at: '24:00' });
  assert.deepStrictEqual([s.open_at, s.close_at], ['06:00', '24:00']);
  assert.strictEqual(orders.isShopOpen(manila(23, 59)), true, 'open until midnight');
});

test('the hours are set on the Settings page through the admin API (sign-in and CSRF)', async () => {
  const email = 'hours@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const put = (body, headers) => fetch(`${url}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    assert.strictEqual((await put({ open_at: '08:00' }, {})).status, 401, 'signed out');
    assert.strictEqual((await put({ open_at: '08:00' }, { Cookie: cookie })).status, 403, 'no CSRF token');
    const res = await put({ open_at: '08:00', close_at: '21:30' }, { Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.strictEqual(res.status, 200);
    const s = await res.json();
    assert.deepStrictEqual([s.open_at, s.close_at], ['08:00', '21:30']);
    assert.ok('open_now' in s && 'closing_soon' in s && 'shop_open' in s);
    const page = await (await fetch(`${url}/admin/settings`, { headers: { Cookie: cookie } })).text();
    assert.ok(page.includes('id="hours-form"') && page.includes('id="open-at"') && page.includes('id="close-at"'));
    const ordersPage = await (await fetch(`${url}/admin`, { headers: { Cookie: cookie } })).text();
    assert.ok(!ordersPage.includes('id="pickup-open"'), 'the old pick-up hours are gone from Orders');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
