'use strict';
/* The customer's "we got your order" text and their order status page: one
   text per order (GCash once paid), a link only they hold, and a page with no
   personal data. Semaphore and PayMongo are stubbed. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-status-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.SEMAPHORE_API_KEY = 'sk-test-semaphore-key-123';
process.env.PAYMONGO_SECRET_KEY = 'sk_test_stubkey123';
delete process.env.SEMAPHORE_SENDER;
delete process.env.CANONICAL_HOST;

const { db, seedIfEmpty } = require('../server/db');
const orders = require('../server/orders');
const menu = require('../server/menu');
const checkout = require('../server/checkout');
const deliveryAreas = require('../server/delivery');
const paymongo = require('../server/paymongo');
const render = require('../server/render');
const sms = require('../server/sms');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00', gcash_online: true, sms_numbers: '0918 765 4321', max_open_orders: 20 });
const { server } = require('../server/index');

const AREA = deliveryAreas.create({ name: 'Status Area', fee: 0, eta_min: 30, eta_max: 45 });
const MATCHA = menu.list().find((i) => i.name === 'Matcha Frappe'); // Php 129
const CUSTOMER = '639171234567';
const OWNER = '639187654321';
const REF = /\/order\/(\d+\.[A-Za-z0-9_-]{32})$/;

const texts = [];
sms.setTransport(async (url, init) => {
  const form = new URLSearchParams(init.body);
  texts.push({ number: form.get('number'), message: form.get('message') });
  return { status: 200, text: async () => '[]' };
});
const sentTo = (n) => texts.filter((t) => t.number === n);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30)); // texts go out after the response

const pm = { seq: 0 };
paymongo.setFetch(async (url, init) => {
  if (init.method === 'POST' && new URL(url).pathname === '/v1/checkout_sessions') {
    const id = `cs_test${++pm.seq}`;
    return { ok: true, status: 200, json: async () => ({ data: { id, attributes: { checkout_url: `https://checkout.paymongo.com/${id}` } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

const input = (over = {}) => ({
  name: 'Juan dela Cruz', phone: '0917 123 4567', address: '12 Mabini St, Brgy. Uno',
  landmark: 'beside the green gate', cash: 500, delivery_area: AREA.id,
  items: [{ id: MATCHA.id, qty: 2 }], expected_total: 258,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});

let url;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { url = `http://127.0.0.1:${server.address().port}`; resolve(); })));
test.after(() => new Promise((resolve) => server.close(resolve)));
const place = (body) => fetch(`${url}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let first; // { id, ref }

test('a cash order texts the customer once, with the link to its status, and still alerts the owner', async () => {
  texts.length = 0;
  const res = await place(input());
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.match(body.status_url, REF);
  assert.ok(!('pay_token' in body.order) && !('phone_norm' in body.order), 'the key and phone stay on the server');
  first = { id: body.order.id, ref: REF.exec(body.status_url)[1] };
  await settle();
  const mine = sentTo(CUSTOMER);
  assert.strictEqual(mine.length, 1, 'one text to the customer');
  assert.ok(mine[0].message.includes(`#${first.id}`) && mine[0].message.includes(body.status_url), mine[0].message);
  assert.ok(mine[0].message.includes('P258'));
  assert.ok(mine[0].message.length <= 160);
  assert.match(mine[0].message, /^[\x20-\x7E]*$/, 'plain characters only');
  assert.ok(!mine[0].message.includes('Juan'), 'no name in the text');
  assert.strictEqual(sentTo(OWNER).length, 1, 'the owner alert is separate');
  assert.ok(!('pay_token' in orders.get(first.id)));
});

test('the status page shows the order and its status, and no name, phone or address', async () => {
  const res = await fetch(`${url}/order/${first.ref}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'") && !csp.includes('clarity') && !csp.includes('facebook'), 'no trackers');
  const html = await res.text();
  assert.ok(html.includes(`Order #${first.id}`));
  assert.ok(html.includes('2 × Matcha Frappe'));
  assert.ok(html.includes('₱258'));
  assert.ok(html.includes('Status Area'));
  assert.ok(html.includes('http-equiv="refresh"'), 'refreshes while active');
  for (const secret of ['Juan', '0917', '9171234567', 'Mabini', 'green gate']) assert.ok(!html.includes(secret), secret);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!html.includes('<!--'), 'every placeholder filled');
});

test('the status words follow the order, per type', () => {
  const o = { id: 9, order_type: 'pickup', items: [], subtotal: 1, total: 1 };
  const line = (status, extra = {}) => render.buildOrderStatusHtml({ ...o, ...extra }, { status }).match(/<p class="hero__sub">(.*?)<\/p>/)[1];
  assert.strictEqual(line('delivering'), 'Your order is ready for pick-up.');
  assert.strictEqual(line('delivering', { order_type: 'delivery' }), 'Your order is on the way.');
  assert.strictEqual(line('preparing'), 'We are making your order.');
  assert.match(line('cancelled'), /cancelled/);
  assert.ok(!render.buildOrderStatusHtml(o, { status: 'completed' }).includes('http-equiv="refresh"'), 'finished: no refresh');
  assert.strictEqual(render.buildOrderStatusHtml(o, { status: 'new', awaiting: true }).match(/<p class="hero__sub">(.*?)<\/p>/)[1], 'Waiting for your GCash payment.');
  assert.match(render.buildOrderStatusHtml(o, { status: 'new', willCall: true }), /We will call you to confirm it/);
  // Item names come from the owner's menu: escaped.
  assert.ok(render.buildOrderStatusHtml({ ...o, items: [{ qty: 1, name: '<img src=x onerror=alert(1)>' }] }, { status: 'new' })
    .includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('a wrong, borrowed, short or missing key, an old order and a counter order all get the same 404', async () => {
  const other = orders.create(input({ checkout_token: checkout.issue(new Date(Date.now() - 10000)) }));
  const otherRef = orders.customerRef(other.id);
  const [, token] = first.ref.split('.');
  const notFound = await (await fetch(`${url}/order/999999.${token}`)).text();
  const tries = [
    `${first.id}.${'A'.repeat(32)}`, // wrong key
    `${first.id}.${otherRef.split('.')[1]}`, // another order's key
    `${first.id}.${token.slice(0, 31)}`, // short
    `${first.id}`, `${first.ref}/x`, `${first.ref}%00`, `0${first.ref}x`,
  ];
  for (const t of tries) {
    const res = await fetch(`${url}/order/${t}`);
    assert.strictEqual(res.status, 404, t);
    assert.strictEqual(await res.text(), notFound, `${t}: the same answer`);
  }
  assert.strictEqual((await fetch(`${url}/order/`)).status, 404, 'no key at all');
  db.prepare('UPDATE orders SET pay_token = NULL WHERE id = ?').run(other.id); // an order from before the key
  assert.strictEqual(orders.byRef(otherRef), null);
  db.prepare("UPDATE orders SET pay_token = ?, source = 'pos' WHERE id = ?").run(otherRef.split('.')[1], other.id);
  assert.strictEqual((await fetch(`${url}/order/${otherRef}`)).status, 404, 'counter orders have no page');
});

test('switched off, or with no Semaphore key, the customer gets no text; the order still has its link', async () => {
  assert.strictEqual(orders.settings().sms_customer_on, true, 'on unless turned off');
  orders.updateSettings({ sms_customer_on: false });
  texts.length = 0;
  const res = await place(input());
  assert.match((await res.json()).status_url, REF, 'the confirmation screen still gets the link');
  await settle();
  assert.strictEqual(sentTo(CUSTOMER).length, 0);
  assert.strictEqual(sentTo(OWNER).length, 1, 'the owner alert has its own switch');
  orders.updateSettings({ sms_customer_on: true });
  assert.throws(() => orders.updateSettings({ sms_customer_on: 'maybe' }), (e) => Boolean(e.errors && e.errors.sms_customer_on));

  delete process.env.SEMAPHORE_API_KEY;
  try {
    texts.length = 0;
    sms.confirmCustomer({ id: 1, total: 1, phone_norm: '+639171234567' }, 'https://sweeterside.ph/order/x');
    await settle();
    assert.strictEqual(texts.length, 0);
  } finally {
    process.env.SEMAPHORE_API_KEY = 'sk-test-semaphore-key-123';
  }
  sms.confirmCustomer({ id: 1, total: 1, phone_norm: '' }, 'https://sweeterside.ph/order/x');
  sms.confirmCustomer({ id: 1, total: 1, phone: '<script>' }, 'https://sweeterside.ph/order/x');
  await settle();
  assert.strictEqual(texts.length, 0, 'no valid number: nothing sent');
});

test('a GCash order texts the customer only once it is paid', async () => {
  texts.length = 0;
  // Test keys: GCash is offered to the signed-in owner only, as on staging.
  const order = orders.create(input({ pay: 'gcash', cash: '' }), { admin: true });
  await paymongo.startCheckout(order.id, 'https://sweeterside.ph');
  await settle();
  assert.strictEqual(sentTo(CUSTOMER).length, 0, 'not while it waits for payment');
  const session = db.prepare('SELECT paymongo_session FROM orders WHERE id = ?').get(order.id).paymongo_session;
  assert.strictEqual(paymongo.markPaid(order.id, { session_id: session, payment_id: 'pay_x', amount: 25800 }), 'paid');
  await settle();
  const mine = sentTo(CUSTOMER);
  assert.strictEqual(mine.length, 1);
  assert.ok(mine[0].message.includes(`https://sweeterside.ph/order/${orders.customerRef(order.id)}`), mine[0].message);
});

test('robots.txt keeps status pages out, and opening one too often is slowed down', async () => {
  assert.match(await (await fetch(`${url}/robots.txt`)).text(), /^Disallow: \/order\/$/m);
  let last;
  for (let i = 0; i < 70 && (!last || last.status !== 429); i++) {
    last = await fetch(`${url}/order/${first.ref}`);
    await last.text();
  }
  assert.strictEqual(last.status, 429);
});
