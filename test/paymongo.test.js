'use strict';
/* GCash through PayMongo (server/paymongo.js), with PayMongo stubbed: an
   order paid with GCash waits out of the queue until PayMongo confirms it by
   a signed webhook or on the customer's return; only its own checkout and
   exact total count; unpaid orders are cancelled; it is off until switched
   on. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-paymongo-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.PAYMONGO_SECRET_KEY = 'sk_test_stubkey123';
process.env.PAYMONGO_WEBHOOK_SECRET = 'whsk_test_stubsecret';
const WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET;

const { db, seedIfEmpty } = require('../server/db');
const orders = require('../server/orders');
const menu = require('../server/menu');
const staff = require('../server/staff');
const shifts = require('../server/shifts');
const payments = require('../server/payments');
const checkout = require('../server/checkout');
const deliveryAreas = require('../server/delivery');
const paymongo = require('../server/paymongo');
const auth = require('../server/auth');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00', gcash_online: true });
auth.createUser('owner@example.com', 'a-long-enough-password');
const OWNER_COOKIE = `${auth.SESSION_COOKIE}=${auth.createSession(auth.findUserByEmail('owner@example.com').id).token}`;
const AS_OWNER = { admin: true };

/* ---- a stand-in for PayMongo ---- */
const pm = { calls: [], sessions: new Map(), fail: false, seq: 0 };
paymongo.setFetch(async (url, init) => {
  const { pathname } = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  pm.calls.push({ method: init.method, pathname, body, auth: init.headers.Authorization });
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  if (pm.fail) return reply(500, { errors: [{ detail: 'down' }] });
  let m;
  if (init.method === 'POST' && pathname === '/v1/checkout_sessions') {
    const id = `cs_test${++pm.seq}`;
    pm.sessions.set(id, { id, attributes: { ...body.data.attributes, payments: [] } });
    return reply(200, { data: { id, attributes: { checkout_url: `https://checkout.paymongo.com/${id}` } } });
  }
  if ((m = /^\/v1\/checkout_sessions\/(cs_\w+)$/.exec(pathname)) && init.method === 'GET') {
    return reply(200, { data: pm.sessions.get(m[1]) });
  }
  if ((m = /^\/v1\/checkout_sessions\/(cs_\w+)\/expire$/.exec(pathname))) {
    pm.sessions.get(m[1]).expired = true;
    return reply(200, { data: pm.sessions.get(m[1]) });
  }
  return reply(404, {});
});
/** The customer pays on PayMongo's page. */
function payOnPaymongo(sessionId, amount) {
  pm.sessions.get(sessionId).attributes.payments = [{ id: `pay_${sessionId}`, attributes: { status: 'paid', amount } }];
}

const item = (name) => menu.list().find((i) => i.name === name);
const MATCHA = 'Matcha Frappe'; // Php 129
const input = (over = {}) => ({
  type: 'dinein', name: 'Guest', phone: '', address: '', cash: '', table_no: '7',
  items: [{ id: item(MATCHA).id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), pay: 'gcash', ...over,
});
const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const inQueue = (id) => orders.list('active').some((o) => o.id === id);

function signed(event, { t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET, slot = 'te' } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},te=${slot === 'te' ? sig : ''},li=${slot === 'li' ? sig : ''}` };
}
function paidEvent(sessionId, orderId, amount) {
  return {
    data: {
      id: 'evt_1', attributes: {
        type: 'checkout_session.payment.paid',
        data: {
          id: sessionId,
          attributes: { metadata: { order_id: String(orderId) }, payments: [{ id: 'pay_x', attributes: { status: 'paid', amount } }] },
        },
      },
    },
  };
}

async function withServer(fn) {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const post = (url, p, body, headers = {}) => fetch(`${url}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: OWNER_COOKIE, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('GCash is off until the keys are set and Settings switches it on', () => {
  orders.updateSettings({ gcash_online: false });
  assert.strictEqual(paymongo.enabled(), false);
  assert.throws(() => orders.create(input(), AS_OWNER), (e) => !!e.errors.pay);
  orders.updateSettings({ gcash_online: true });
  assert.strictEqual(paymongo.enabled(), true);
  const s = orders.settings();
  assert.deepStrictEqual([s.gcash_online, s.gcash_ready, s.gcash_webhook, s.gcash_live], [true, true, true, false]);
  assert.ok(!JSON.stringify(s).includes('sk_test_stubkey123') && !JSON.stringify(s).includes(WEBHOOK_SECRET), 'never the keys');
  assert.throws(() => orders.create(input({ pay: 'card' }), AS_OWNER), (e) => !!e.errors.pay);
});

test('with test keys customers never see or use GCash; only the signed-in owner does; live keys offer it to all', async () => {
  const render = require('../server/render');
  const mode = (html) => html.match(/<fieldset class="otype pay" id="pay" data-gcash="(\w+)"/)[1];
  assert.strictEqual(paymongo.offeredTo({ admin: false }), false);
  assert.strictEqual(paymongo.offeredTo({ admin: true }), 'test');
  assert.strictEqual(mode(render.buildHtml()), '0', 'the static menu never offers test GCash');
  // A customer forcing pay: 'gcash' with test keys is refused.
  assert.throws(() => orders.create(input()), (e) => !!e.errors.pay);

  await withServer(async (url) => {
    const asCustomer = await (await fetch(url)).text();
    const asOwner = await (await fetch(url, { headers: { Cookie: OWNER_COOKIE } })).text();
    assert.deepStrictEqual([mode(asCustomer), mode(asOwner)], ['0', 'test']);
    const res = await post(url, '/api/orders', input(), { Cookie: '' });
    assert.strictEqual(res.status, 422);
    assert.ok((await res.json()).fields.pay, 'the server refuses it, whatever the page showed');
  });

  // Live keys: everyone, once switched on.
  process.env.PAYMONGO_SECRET_KEY = 'sk_live_stubkey123';
  try {
    assert.strictEqual(paymongo.offeredTo({ admin: false }), 'live');
    assert.strictEqual(mode(render.buildHtml()), 'live');
    orders.updateSettings({ gcash_online: false });
    assert.strictEqual(paymongo.offeredTo({ admin: true }), false, 'off is off for everyone');
  } finally {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_stubkey123';
    orders.updateSettings({ gcash_online: true });
  }
});

test('a GCash order waits out of the queue, and PayMongo gets exactly its total, GCash only', async () => {
  await withServer(async (url) => {
    const res = await post(url, '/api/orders', input());
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.match(body.checkout_url, /^https:\/\/checkout\.paymongo\.com\/cs_test\d+$/);
    const id = body.order.id;
    assert.match(body.pay_ref, new RegExp(`^${id}\\.[A-Za-z0-9_-]{32}$`));
    assert.strictEqual(body.order.pay_method, 'gcash');

    const o = row(id);
    assert.deepStrictEqual([o.pay_method, o.pay_status, o.cash_cents, o.change_due_cents], ['gcash', 'awaiting', 0, 0]);
    assert.ok(!inQueue(id), 'not in the queue while unpaid');
    assert.ok(!('pay_token' in orders.get(id)), 'the token never goes out with the order');

    const call = pm.calls.find((c) => c.method === 'POST' && c.pathname === '/v1/checkout_sessions');
    const a = call.body.data.attributes;
    assert.deepStrictEqual([a.line_items, a.payment_method_types], [[{ name: `Sweeter Side order #${id}`, amount: 12900, currency: 'PHP', quantity: 1 }], ['gcash']]);
    assert.ok(a.success_url.endsWith(`/?gcash=${encodeURIComponent(body.pay_ref)}`));
    assert.ok(a.cancel_url.endsWith('&back=1'));
    assert.strictEqual(call.auth, `Basic ${Buffer.from('sk_test_stubkey123:').toString('base64')}`);
    assert.ok(!JSON.stringify(a).includes('Guest'), 'no customer details sent to PayMongo');
  });
});

test('only a correctly signed webhook for the order\'s own checkout and exact total pays it', async () => {
  await withServer(async (url) => {
    const { order, pay_ref: ref } = await (await post(url, '/api/orders', input())).json();
    const session = row(order.id).paymongo_session;
    const send = (ev, opts) => { const s = signed(ev, opts); return post(url, '/api/paymongo/webhook', s.raw, { 'Paymongo-Signature': s.header }); };

    assert.strictEqual((await post(url, '/api/paymongo/webhook', paidEvent(session, order.id, 12900))).status, 400, 'unsigned');
    assert.strictEqual((await send(paidEvent(session, order.id, 12900), { secret: 'wrong' })).status, 400, 'wrong secret');
    assert.strictEqual((await send(paidEvent(session, order.id, 12900), { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'too old');
    assert.strictEqual((await send(paidEvent(session, order.id, 12900), { slot: 'li' })).status, 400, 'a live signature with test keys');
    assert.strictEqual(row(order.id).pay_status, 'awaiting');

    assert.strictEqual((await send(paidEvent(session, order.id, 100))).status, 200);
    assert.strictEqual(row(order.id).pay_status, 'awaiting', 'the wrong amount pays nothing');
    assert.strictEqual((await send(paidEvent('cs_someoneelse', order.id, 12900))).status, 200);
    assert.strictEqual(row(order.id).pay_status, 'awaiting', 'another checkout pays nothing');

    assert.strictEqual((await send(paidEvent(session, order.id, 12900))).status, 200);
    const paid = row(order.id);
    assert.deepStrictEqual([paid.pay_status, paid.online_paid_cents, paid.paymongo_payment], ['paid', 12900, 'pay_x']);
    assert.ok(inQueue(order.id), 'paid: into the queue');
    assert.strictEqual((await send(paidEvent(session, order.id, 12900))).status, 200, 'a repeat is fine');
    assert.strictEqual(paymongo.markPaid(order.id, { session_id: session, payment_id: 'pay_x', amount: 12900 }), 'already');

    const back = await (await fetch(`${url}/api/orders/payment?ref=${encodeURIComponent(ref)}`)).json();
    assert.deepStrictEqual([back.status, back.order.paid_online], ['paid', true]);
  });
});

test('the customer\'s return asks PayMongo when the webhook is slow; leaving cancels and frees the order', async () => {
  await withServer(async (url) => {
    const { order, pay_ref: ref } = await (await post(url, '/api/orders', input())).json();
    assert.strictEqual((await fetch(`${url}/api/orders/payment?ref=${order.id}.${'x'.repeat(32)}`)).status, 404, 'a wrong token finds nothing');
    assert.strictEqual((await fetch(`${url}/api/orders/payment?ref=nonsense`)).status, 404);
    const waiting = await (await fetch(`${url}/api/orders/payment?ref=${encodeURIComponent(ref)}`)).json();
    assert.strictEqual(waiting.status, 'awaiting');
    payOnPaymongo(row(order.id).paymongo_session, 12900);
    const paid = await (await fetch(`${url}/api/orders/payment?ref=${encodeURIComponent(ref)}`)).json();
    assert.strictEqual(paid.status, 'paid', 'paid without the webhook');
    assert.strictEqual(row(order.id).pay_status, 'paid');

    // Another order, left without paying.
    const left = await (await post(url, '/api/orders', input())).json();
    const back = await (await post(url, '/api/orders/payment/cancel', { ref: left.pay_ref })).json();
    assert.strictEqual(back.status, 'cancelled');
    const o = row(left.order.id);
    assert.deepStrictEqual([o.status, o.cancel_reason, o.pay_status], ['cancelled', 'unpaid', '']);
    assert.strictEqual(pm.sessions.get(o.paymongo_session).expired, true, 'the checkout is closed at PayMongo too');
  });
});

test('unpaid after 15 minutes: cancelled, unless PayMongo says it was paid; a late payment is flagged', async () => {
  const id = orders.create(input(), AS_OWNER).id;
  await paymongo.startCheckout(id, 'https://sweeterside.ph');
  const old = (minutes) => db.prepare("UPDATE orders SET created_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);
  old(5);
  await paymongo.expireStale();
  assert.strictEqual(row(id).pay_status, 'awaiting', 'not yet');
  old(16);
  await paymongo.expireStale();
  assert.deepStrictEqual([row(id).status, row(id).cancel_reason], ['cancelled', 'unpaid']);
  // The customer paid at the last second; the webhook comes after the cancel.
  const s = row(id).paymongo_session;
  assert.strictEqual(paymongo.markPaid(id, { session_id: s, payment_id: 'pay_late', amount: 12900 }), 'late');
  assert.strictEqual(row(id).pay_status, 'late', 'to refund in PayMongo');

  const id2 = orders.create(input(), AS_OWNER).id;
  await paymongo.startCheckout(id2, 'https://sweeterside.ph');
  payOnPaymongo(row(id2).paymongo_session, 12900);
  db.prepare("UPDATE orders SET created_at = datetime('now', '-20 minutes') WHERE id = ?").run(id2);
  await paymongo.expireStale();
  assert.strictEqual(row(id2).pay_status, 'paid', 'paid after all: kept');
});

test('PayMongo unreachable on the way back: still waiting, never "not paid"', async () => {
  await withServer(async (url) => {
    // Placed directly: the HTTP route allows 5 orders per address in 10 minutes.
    const order = orders.create(input(), AS_OWNER);
    const { ref } = await paymongo.startCheckout(order.id, url);
    pm.fail = true;
    try {
      const r = await (await fetch(`${url}/api/orders/payment?ref=${encodeURIComponent(ref)}`)).json();
      assert.strictEqual(r.status, 'awaiting');
      const left = await (await post(url, '/api/orders/payment/cancel', { ref })).json();
      assert.strictEqual(left.status, 'awaiting', 'not cancelled without asking PayMongo');
      assert.strictEqual(row(order.id).status, 'new');
    } finally {
      pm.fail = false;
    }
  });
});

test('PayMongo down: the order is cancelled and the customer told to pay another way', async () => {
  await withServer(async (url) => {
    pm.fail = true;
    try {
      const res = await post(url, '/api/orders', input());
      assert.strictEqual(res.status, 409);
      assert.deepStrictEqual(await res.json(), { error: paymongo.UNAVAILABLE, pay_unavailable: true });
      const last = db.prepare("SELECT * FROM orders WHERE pay_method = 'gcash' ORDER BY id DESC LIMIT 1").get();
      assert.deepStrictEqual([last.status, last.cancel_reason], ['cancelled', 'unpaid']);
    } finally {
      pm.fail = false;
    }
  });
});

test('the return key never reaches the tracking tools or the page address', () => {
  const root = path.join(__dirname, '..');
  const tracking = fs.readFileSync(path.join(root, 'assets', 'js', 'tracking.js'), 'utf8');
  // Tracking starts after DOMContentLoaded, i.e. after cart.js has run.
  assert.match(tracking, /document\.addEventListener\('DOMContentLoaded', startOnce\)/);
  assert.ok(!/readyState === 'loading'/.test(tracking), 'not straight away while deferred scripts still run');
  const cart = fs.readFileSync(path.join(root, 'assets', 'js', 'cart.js'), 'utf8');
  assert.match(cart, /history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.hash\)/);
});

test('coming back from GCash after closing still shows whether it was paid', () => {
  // Bug: cart.js stopped at once when the shop was closed, so a customer back
  // from GCash after closing saw no confirmation at all.
  const cart = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'cart.js'), 'utf8');
  assert.match(cart, /if \(closedOnLoad && !\/\[\?&\]gcash=\/\.test\(window\.location\.search\)\) return;/,
    'closed: the cart stops early only when not coming back from GCash');
  assert.match(cart, /var shopClosed = closedOnLoad;/, 'and then starts as closed: no checkout');
  assert.match(cart, /if \(closedOnLoad\) document\.body\.classList\.add\('shop-closed'\);/, 'and no Add buttons');
  assert.match(cart, /We are closed now, so your cart is kept for next time\./);
});

test('Other area stays cash; the POS will not take a second payment for a GCash order', async () => {
  // "Other area": the fee is agreed by phone, so there is nothing to pay online yet.
  deliveryAreas.create({ name: 'Near Barangay', fee: 30, eta_min: 30, eta_max: 60 }); // delivery needs an area set up
  assert.throws(() => orders.create(input({
    type: 'delivery', phone: '0917 123 4567', address: '1 Long Road', landmark: 'near the big tree',
    delivery_area: 'other',
  }), AS_OWNER), (err) => !!(err.errors && err.errors.pay));

  const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
  shifts.open({ opening_cash: 0 }, owner);
  const id = orders.create(input(), AS_OWNER).id;
  await paymongo.startCheckout(id, 'https://sweeterside.ph');
  const pay = () => payments.pay(id, { request_key: crypto.randomBytes(8).toString('hex'), payments: [{ method: 'cash', amount: 129 }] }, owner);
  assert.throws(pay, (err) => err.status === 409 && /paying this order with GCash/.test(err.message));
  paymongo.markPaid(id, { session_id: row(id).paymongo_session, payment_id: 'pay_y', amount: 12900 });
  assert.throws(pay, (err) => err.status === 409 && /paid online with GCash/.test(err.message));
});
