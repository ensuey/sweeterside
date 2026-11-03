'use strict';
/* PR B, delivery areas: a fee and a usual time per area, "Other area" with
   the fee to confirm, and free delivery over a threshold. The checkout and
   the POS price them the same way. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-delivery-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { db, seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
const seo = require('../server/seo');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const delivery = require('../server/delivery');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const item = (name) => menu.list().find((i) => i.name === name);
const MATCHA = () => item('Matcha Frappe'); // ₱129
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
const area = (name) => delivery.list().find((a) => a.name === name);
const setArea = (name, over) => delivery.update(area(name).id, { ...area(name), ...over });
let phoneSeq = 10;
const order = (over = {}) => orders.create({
  type: 'delivery', name: 'Ana Reyes', phone: `0917 123 45${++phoneSeq}`, address: '12 Mabini St',
  landmark: 'green gate beside the store', items: [{ id: MATCHA().id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});
// Finished orders do not count against "too many in progress".
const done = (o) => db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(o.id);

async function withServer(fn) {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the four areas are seeded once, with no fee, so none is offered yet', () => {
  assert.deepStrictEqual(delivery.list().map((a) => a.name), ['Batobato', 'Manikling', 'Baon', 'Bitaogan']);
  assert.ok(delivery.list().every((a) => a.fee === null && a.active && !a.selectable));
  assert.deepStrictEqual(delivery.selectable(), []);
  // Only "Other area" is in the checkout dropdown.
  const html = render.buildHtml();
  const options = [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
  assert.deepStrictEqual(options, ['', 'other']);
});

test('area details are checked', () => {
  const id = area('Baon').id;
  const bad = [
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ name: 'Batobato' }, 'name'],
    [{ name: 'other area' }, 'name'], [{ fee: -1 }, 'fee'], [{ fee: 1.5 }, 'fee'], [{ fee: 10001 }, 'fee'],
    [{ fee: 'abc' }, 'fee'], [{ eta_min: 30 }, 'eta'], [{ eta_min: 45, eta_max: 30 }, 'eta'], [{ eta_min: 0, eta_max: 601 }, 'eta'],
  ];
  for (const [over, field] of bad) {
    const e = errorsOf(() => delivery.update(id, { name: 'Baon', fee: 40, ...over }));
    assert.ok(e && e[field], `${JSON.stringify(over)} should fail on ${field}`);
  }
  assert.strictEqual(delivery.update(9999, { name: 'Nowhere' }), null);
  // Nothing was saved by the failures.
  assert.strictEqual(area('Baon').fee, null);
});

test('an order pays its area\'s fee; the browser\'s fee is ignored', () => {
  setArea('Batobato', { fee: 30, eta_min: 20, eta_max: 30 });
  setArea('Bitaogan', { fee: 60, eta_min: 45, eta_max: 60 });
  const near = order({ delivery_area: area('Batobato').id, expected_total: 159, delivery_fee: 0 });
  assert.deepStrictEqual([near.delivery_fee, near.total, near.delivery_area, near.fee_to_confirm], [30, 159, 'Batobato', 0]);
  done(near);
  const far = order({ delivery_area: String(area('Bitaogan').id), expected_total: 189 });
  assert.deepStrictEqual([far.delivery_fee, far.total], [60, 189]);
  done(far);
  // A total worked out with the wrong fee is refused with the right one.
  const e = (() => { try { order({ delivery_area: area('Bitaogan').id, expected_total: 159 }); } catch (err) { return err; } })();
  assert.strictEqual(e.status, 409);
  assert.strictEqual(e.body.quote.delivery_fee, 60);
});

test('delivery needs an area that is on and has a fee; other types need none', () => {
  for (const choice of [undefined, '', 'abc', 0, -1, 9999, area('Baon').id]) {
    const e = errorsOf(() => order({ delivery_area: choice }));
    assert.ok(e && e.delivery_area, `area ${choice} should be refused`);
  }
  setArea('Manikling', { fee: 40, active: false });
  assert.ok(errorsOf(() => order({ delivery_area: area('Manikling').id, expected_total: 169 })).delivery_area, 'an area turned off');
  setArea('Manikling', { active: true });
  // Pick-up and dine-in pay no delivery fee, whatever area is sent.
  for (const type of ['pickup', 'dinein']) {
    const q = orders.quote([{ id: MATCHA().id, qty: 1 }], type, new Date(), '', area('Bitaogan').id);
    assert.deepStrictEqual([q.delivery_fee, q.area], [0, null], type);
  }
});

test('"Other area" goes through with no fee yet, flagged to confirm', () => {
  const o = order({ delivery_area: 'other', expected_total: 129 });
  assert.deepStrictEqual([o.delivery_fee, o.total, o.delivery_area, o.fee_to_confirm, o.delivery_area_id],
    [0, 129, 'Other area', 1, null]);
  assert.ok(render.buildHtml().includes('<option value="other">Other area'));
  done(o);
});

test('free delivery from the threshold, after discounts; never for "Other area"', () => {
  for (const bad of ['0', '-5', '1.5', 'abc', '100001']) {
    assert.ok(errorsOf(() => orders.updateSettings({ free_delivery_min: bad })).free_delivery_min, bad);
  }
  orders.updateSettings({ free_delivery_min: '258' });
  assert.strictEqual(orders.settings().free_delivery_min, 258);
  const id = area('Batobato').id;
  // ₱129 × 2 = ₱258: exactly the threshold, so no fee.
  const at = order({ delivery_area: id, items: [{ id: MATCHA().id, qty: 2 }], expected_total: 258 });
  assert.deepStrictEqual([at.delivery_fee, at.total], [0, 258]);
  done(at);
  // One peso short (a ₱1 voucher) pays the fee.
  require('../server/vouchers').create({ code: 'ONE', kind: 'amount', value: 1 });
  const under = order({ delivery_area: id, items: [{ id: MATCHA().id, qty: 2 }], voucher: 'ONE', expected_total: 287 });
  assert.deepStrictEqual([under.delivery_fee, under.total], [30, 287]);
  done(under);
  const other = order({ delivery_area: 'other', items: [{ id: MATCHA().id, qty: 2 }], expected_total: 258 });
  assert.strictEqual(other.fee_to_confirm, 1);
  done(other);
  const data = JSON.parse(render.buildHtml().match(/data-delivery="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  assert.strictEqual(data.free_min, 258);
  assert.ok(data.areas.some((a) => a.name === 'Batobato' && a.fee === 30 && a.eta === 'Usually 20–30 min'));
  orders.updateSettings({ free_delivery_min: '' });
  assert.strictEqual(orders.settings().free_delivery_min, null);
});

test('the POS uses the same areas and fees, and a cashier can still change the fee with a reason', () => {
  const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
  const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
  const key = () => crypto.randomBytes(12).toString('hex');
  const ticket = (over = {}) => ({
    request_key: key(), type: 'delivery', customer_name: 'Carlo', phone: '+63 917 555 0101', address: '2 Rizal St',
    landmark: 'Blue gate by the chapel', lines: [{ key: `k${key().slice(0, 6)}`, item_id: MATCHA().id, qty: 1 }], ...over,
  });
  const online = order({ delivery_area: area('Bitaogan').id, expected_total: 189 });
  done(online);
  const saved = pos.save(null, ticket({ delivery_area: area('Bitaogan').id }), cashier).order;
  assert.deepStrictEqual([saved.delivery_fee, saved.total, saved.delivery_area], [online.delivery_fee, online.total, 'Bitaogan']);
  assert.ok(errorsOf(() => pos.save(null, ticket(), cashier)).delivery_area, 'an area is required');
  assert.ok(errorsOf(() => pos.save(null, ticket({ delivery_area: area('Baon').id }), cashier)).delivery_area, 'no fee set');
  const other = pos.save(null, ticket({ delivery_area: 'other', discounts: { delivery_fee: 90, fee_reason: 'Next town' } }), cashier).order;
  assert.deepStrictEqual([other.delivery_fee, other.fee_to_confirm], [90, 1]);
});

test('the site text lists the areas that are on, with fees and times', () => {
  setArea('Baon', { active: false });
  const visit = seo.visitHtml();
  assert.ok(visit.includes('Batobato (₱30, usually 20–30 min)'));
  assert.ok(!visit.includes('Baon'), 'an area turned off is not listed');
  const faq = seo.faqs().find(([q]) => q === 'Do you deliver?')[1];
  assert.match(faq, /Bitaogan \(₱60, usually 45–60 min\)/);
  assert.match(faq, /Other area/);
  assert.ok(seo.llmsTxt([]).includes('Manikling (₱40)'));
  setArea('Baon', { active: true });
});

test('the delivery areas endpoints need sign-in and CSRF', async () => {
  const email = 'areas@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  await withServer(async (url) => {
    const call = (p, method, body, headers = {}) => fetch(`${url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    assert.strictEqual((await call('/api/delivery-areas', 'GET')).status, 401);
    assert.strictEqual((await call('/api/delivery-areas', 'POST', { name: 'Hack' })).status, 401);
    assert.strictEqual((await call('/api/delivery-areas', 'POST', { name: 'Hack' }, { Cookie: cookie })).status, 403, 'no CSRF');
    assert.strictEqual((await call(`/api/delivery-areas/${area('Baon').id}`, 'DELETE', undefined, { Cookie: cookie })).status, 403);
    assert.ok(!area('Hack'));

    const admin = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const created = await call('/api/delivery-areas', 'POST', { name: 'Poblacion', fee: 25, eta_min: 15, eta_max: 25 }, admin);
    assert.strictEqual(created.status, 201);
    const { area: p } = await created.json();
    const bad = await call(`/api/delivery-areas/${p.id}`, 'PATCH', { name: 'Poblacion', fee: -5 }, admin);
    assert.strictEqual(bad.status, 422);
    assert.ok((await bad.json()).fields.fee);
    assert.strictEqual((await call(`/api/delivery-areas/${p.id}`, 'PATCH', { name: 'Poblacion', fee: 35 }, admin)).status, 200);
    assert.strictEqual(area('Poblacion').fee, 35);
    assert.strictEqual((await call('/api/delivery-areas/9999', 'PATCH', { name: 'X' }, admin)).status, 404);
    // Removing an area keeps the name on its past orders.
    const placed = order({ delivery_area: p.id, expected_total: 164 });
    assert.strictEqual((await call(`/api/delivery-areas/${p.id}`, 'DELETE', undefined, admin)).status, 200);
    assert.strictEqual(orders.get(placed.id).delivery_area, 'Poblacion');
    const list = await (await call('/api/delivery-areas', 'GET', undefined, { Cookie: cookie })).json();
    assert.ok(!list.areas.some((a) => a.name === 'Poblacion'));
  });
});
