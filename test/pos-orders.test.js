'use strict';
/* POS tickets (server/pos.js) and the POS endpoints: held tabs, send to
   kitchen, voids with an owner override, idempotent saves, roles, discounts,
   merging and moving tabs, and the PIN-locked API. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-pos-orders-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const orders = require('../server/orders');
const menu = require('../server/menu');
const audit = require('../server/audit');
const settings = require('../server/settings');
const vouchers = require('../server/vouchers');

seedIfEmpty();

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '4702' }, owner);
const OWNER_OK = { staff_id: owner.id, pin: '2580' };

const item = (name) => menu.list().find((i) => i.name === name);
const MATCHA = () => item('Matcha Frappe'); // Php 129
const PASTA = () => item('Beef Penne Pasta'); // Php 135
const key = () => crypto.randomBytes(12).toString('hex');
let lineSeq = 0;
const newLine = (it, qty = 1, extra = {}) => ({ key: `k${++lineSeq}`, item_id: it.id, qty, ...extra });
/** The ticket for an existing order, as the tablet would send it back. */
const ticketOf = (o, over = {}) => ({
  request_key: key(), version: o.version, type: o.order_type, table_no: o.table_no, pax: o.pax,
  customer_name: o.customer_name,
  lines: o.lines.filter((l) => l.qty > 0 || l.sent_qty > 0).map((l) => ({ id: l.id, key: l.key, qty: l.qty, note: l.note })),
  ...over,
});
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}

test('a saved tab is held out of the queue until it is sent to the kitchen', () => {
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '5', pax: 2,
    lines: [newLine(MATCHA(), 2, { note: 'less sugar' }), newLine(PASTA())],
  }, waiter);
  assert.deepStrictEqual([order.source, order.status, order.held, order.total, order.version], ['pos', 'new', true, 393, 0]);
  assert.strictEqual(order.taken_by, 'Ben');
  assert.ok(!orders.list('active').some((o) => o.id === order.id), 'held tabs are not in the queue');
  assert.ok(pos.open().some((o) => o.id === order.id && o.table_no === '5' && o.held));
  assert.strictEqual(MATCHA().sold_today, 2, 'held tabs count against the day');

  const sent = pos.save(order.id, ticketOf(order, { send: true }), waiter);
  assert.deepStrictEqual(sent.kitchen, [{ name: 'Matcha Frappe', qty: 2, note: 'less sugar' }, { name: 'Beef Penne Pasta', qty: 1, note: '' }]);
  assert.deepStrictEqual([sent.order.status, sent.order.held, sent.order.version], ['confirmed', false, 1]);
  const queued = orders.list('active').find((o) => o.id === order.id);
  assert.ok(queued, 'now in the queue');
  assert.strictEqual(queued.items[0].note, 'less sugar', 'the kitchen sees the note');

  // More items later: only the new ones go to the kitchen.
  const more = pos.save(order.id, ticketOf(sent.order, {
    lines: [...ticketOf(sent.order).lines, newLine(MATCHA())], send: true,
  }), waiter);
  assert.deepStrictEqual(more.kitchen, [{ name: 'Matcha Frappe', qty: 1, note: '' }]);
  assert.strictEqual(more.order.total, 393 + 129);
});

test('taking off unsent units is free; taking off sent units is a void that needs the owner and a reason', () => {
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '7', lines: [newLine(MATCHA(), 3)], send: true,
  }, cashier);
  // One more, not sent, then taken off again: no void.
  const plus = pos.save(order.id, ticketOf(order, { lines: [{ id: order.lines[0].id, key: order.lines[0].key, qty: 4 }] }), cashier).order;
  const minus = pos.save(plus.id, ticketOf(plus, { lines: [{ id: plus.lines[0].id, key: plus.lines[0].key, qty: 3 }] }), cashier).order;
  assert.strictEqual(minus.lines[0].voided_qty, 0);

  const voidTicket = ticketOf(minus, { lines: [{ id: minus.lines[0].id, key: minus.lines[0].key, qty: 1 }] });
  const preview = pos.quote(minus.id, voidTicket, cashier);
  assert.deepStrictEqual([preview.needs, preview.voids.map((v) => v.units), preview.pricing.totals.total], [['void'], [2], 12900],
    'the preview prices it before a reason is given, and says it needs the owner');
  assert.ok(errorOf(() => pos.save(minus.id, { ...voidTicket, override: OWNER_OK }, cashier)).errors.void_reason);
  const needs = errorOf(() => pos.save(minus.id, { ...voidTicket, void_reason: 'Spilled' }, cashier));
  assert.strictEqual(needs.status, 403);
  assert.deepStrictEqual(needs.body.needs, ['void']);
  assert.strictEqual(errorOf(() => pos.save(minus.id, { ...voidTicket, void_reason: 'Spilled',
    override: { staff_id: owner.id, pin: '0000' } }, cashier)).body.wrong_pin, true, 'a wrong owner PIN is refused');

  const voided = pos.save(minus.id, { ...voidTicket, void_reason: 'Spilled', override: OWNER_OK, request_key: key() }, cashier).order;
  assert.deepStrictEqual([voided.lines[0].qty, voided.lines[0].voided_qty, voided.lines[0].void_reason], [1, 2, 'Spilled']);
  assert.strictEqual(voided.total, 129);
  const log = audit.list({ action: 'void' })[0];
  assert.deepStrictEqual([log.order_id, log.staff_name, log.approver_name, log.amount_cents, log.reason, log.details.units],
    [voided.id, 'Ana', 'Dachel', 2 * 12900, 'Spilled', 2]);
  assert.strictEqual(audit.list({ action: 'override' })[0].details.permissions[0], 'void');
});

test('voids by the owner need a reason but no PIN; an empty ticket is refused', () => {
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '8', lines: [newLine(MATCHA(), 2), newLine(PASTA())], send: true,
  }, owner);
  const t = ticketOf(order, { lines: [ticketOf(order).lines[1]], void_reason: 'Wrong order' });
  const saved = pos.save(order.id, t, owner).order;
  assert.strictEqual(saved.total, 135);
  assert.strictEqual(saved.lines.find((l) => l.name === 'Matcha Frappe').voided_qty, 2);
  assert.ok(!orders.get(order.id).items.some((l) => l.name === 'Matcha Frappe'), 'voided lines leave the kitchen ticket');
  assert.ok(errorOf(() => pos.save(order.id, ticketOf(saved, { lines: [], void_reason: 'x' }), owner)).errors.lines);
});

test('the running total works before the table or customer is typed; saving still needs them', () => {
  const body = { request_key: key(), type: 'dinein', table_no: '', lines: [newLine(MATCHA(), 2)] };
  assert.strictEqual(pos.quote(null, body, waiter).pricing.totals.total, 25800);
  assert.ok(errorOf(() => pos.save(null, body, waiter)).errors.table_no);
  const delivery = { request_key: key(), type: 'delivery', lines: [newLine(MATCHA())] };
  assert.strictEqual(pos.quote(null, delivery, cashier).pricing.totals.total, 12900);
  const e = errorOf(() => pos.save(null, delivery, cashier)).errors;
  assert.ok(e.customer_name && e.phone && e.address && e.landmark);
});

test('saves are idempotent and versioned', () => {
  const body = { request_key: key(), type: 'pickup', customer_name: 'Rosa', lines: [newLine(MATCHA())] };
  const first = pos.save(null, body, cashier);
  const again = pos.save(null, body, cashier);
  assert.strictEqual(again.replayed, true);
  assert.strictEqual(again.order.id, first.order.id, 'a double tap does not make a second order');

  const ok = pos.save(first.order.id, ticketOf(first.order, { customer_name: 'Rosa M' }), cashier).order;
  assert.strictEqual(ok.version, 1);
  const stale = errorOf(() => pos.save(first.order.id, ticketOf(first.order), cashier));
  assert.deepStrictEqual([stale.status, stale.body.stale], [409, true], 'a save from an old copy is refused');
  assert.strictEqual(errorOf(() => pos.save(null, { ...body, request_key: 'short' }, cashier)).errors.request_key.length > 0, true);
});

test('waiters take dine-in only and cannot give discounts', () => {
  const takeout = errorOf(() => pos.save(null, { request_key: key(), type: 'pickup', lines: [newLine(MATCHA())] }, waiter));
  assert.deepStrictEqual(takeout.body.needs, ['takeout_and_delivery']);

  const disc = errorOf(() => pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '2', lines: [newLine(MATCHA())],
    discounts: { manual: { kind: 'percent', value: 5, reason: 'Friend' } },
  }, waiter));
  assert.deepStrictEqual(disc.body.needs, ['manual_discount']);

  // A cashier's discount on a tab survives a waiter adding items.
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '3', lines: [newLine(PASTA())],
    discounts: { manual: { kind: 'percent', value: 10, reason: 'Regular' } },
  }, cashier);
  assert.strictEqual(order.manual_discount, 13.5);
  const added = pos.save(order.id, ticketOf(order, { lines: [...ticketOf(order).lines, newLine(PASTA())] }), waiter).order;
  assert.strictEqual(added.manual_discount, 27);
  assert.strictEqual(added.total, 270 - 27);
});

test('a manual discount above the cashier limit needs the owner; it is audited', () => {
  const body = {
    request_key: key(), type: 'pickup', lines: [newLine(PASTA(), 2)],
    discounts: { manual: { kind: 'percent', value: 20, reason: 'Birthday' } },
  };
  assert.deepStrictEqual(errorOf(() => pos.save(null, body, cashier)).body.needs, ['discount_over_limit']);
  const q = pos.quote(null, body, cashier);
  assert.deepStrictEqual(q.needs, ['discount_over_limit'], 'the preview says what needs approving');
  assert.strictEqual(q.pricing.totals.total, 21600);

  const { order } = pos.save(null, { ...body, override: OWNER_OK }, cashier);
  assert.strictEqual(order.total, 216);
  const log = audit.list({ action: 'manual_discount' })[0];
  assert.deepStrictEqual([log.order_id, log.amount_cents, log.reason, log.approver_name], [order.id, 5400, 'Birthday', 'Dachel']);

  // Saving the tab again (no change to the discount) needs no approval.
  assert.strictEqual(pos.save(order.id, ticketOf(order), cashier).order.total, 216);
});

test('SC/PWD, vouchers, service charge and the delivery fee through the POS', () => {
  settings.updatePosSettings({ service_charge_on: true });
  const pasta = newLine(PASTA()); // 135
  const matcha = newLine(MATCHA()); // 129
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '9', lines: [pasta, matcha],
    discounts: {
      claimants: [{ type: 'sc', name: 'Lola Remedios', id_no: 'OSCA-55501234', mode: 'exclusive', lines: { [pasta.key]: 1 } }],
    },
  }, cashier);
  // SC: 135 - 27 = 108; matcha 129; service charge 10% of 237 = 23.70.
  assert.strictEqual(order.sc_pwd_discount, 27);
  assert.strictEqual(order.service_charge, 23.7);
  assert.strictEqual(order.total, 108 + 129 + 23.7);
  assert.strictEqual(order.input.claimants[0].id_no, 'OSCA-55501234', 'the cashier sees the full ID');
  assert.strictEqual(pos.view(order.id, waiter).input.claimants[0].id_no, '****1234', 'the waiter does not');
  assert.strictEqual(orders.get(order.id).pricing.claimants[0].id_no, '****1234', 'nor does the order queue');

  const removed = pos.save(order.id, ticketOf(order, {
    discounts: { ...order.input, service_removed_reason: 'Slow service' },
  }), cashier).order;
  assert.strictEqual(removed.service_charge, 0);
  assert.strictEqual(audit.list({ action: 'service_charge_removed' })[0].amount_cents, 2370);
  settings.updatePosSettings({ service_charge_on: false });

  vouchers.create({ code: 'POS20', kind: 'amount', value: 20 });
  const v = pos.save(null, {
    request_key: key(), type: 'pickup', lines: [newLine(MATCHA())], discounts: { voucher_code: 'pos20' },
  }, cashier).order;
  assert.deepStrictEqual([v.voucher_code, v.discount, v.total], ['POS20', 20, 109]);
  assert.strictEqual(vouchers.list().find((x) => x.code === 'POS20').uses, 0, 'not used until paid');

  orders.setDeliveryFee(50);
  const d = {
    request_key: key(), type: 'delivery', customer_name: 'Carlo', phone: '+63 917 555 0101', address: '2 Rizal St',
    landmark: 'Blue gate by the chapel', lines: [newLine(MATCHA())],
  };
  const del = pos.save(null, d, cashier).order;
  assert.deepStrictEqual([del.phone_norm, del.delivery_fee, del.total], ['+639175550101', 50, 179]);
  assert.ok(errorOf(() => pos.save(null, { ...d, request_key: key(), discounts: { delivery_fee: 80 } }, cashier)).errors.delivery_fee);
  const far = pos.save(null, { ...d, request_key: key(), discounts: { delivery_fee: 80, fee_reason: 'Next town' } }, cashier).order;
  assert.strictEqual(far.total, 209);
  assert.strictEqual(audit.list({ action: 'delivery_fee_changed' })[0].reason, 'Next town');
  orders.setDeliveryFee(0);
});

test('SC/PWD is refused until the tax status is set', () => {
  orders.saveSetting('vat_registered', '');
  db.prepare("DELETE FROM settings WHERE key = 'vat_registered'").run();
  const err = errorOf(() => pos.save(null, {
    request_key: key(), type: 'pickup', lines: [newLine(PASTA())],
    discounts: { claimants: [{ type: 'pwd', name: 'Juan', id_no: 'PWD-1', mode: 'shared' }], diners: 1 },
  }, cashier));
  assert.deepStrictEqual([err.status, err.body.code], [409, 'tax_unset']);
  orders.saveSetting('vat_registered', '0');
});

test('daily limits count POS orders; the closed switch does not block the POS', () => {
  const p = PASTA();
  menu.setStock(p.id, { availability: 'available', daily_limit: p.sold_today + 2 });
  orders.saveSetting('shop_open', '0');
  const { order } = pos.save(null, { request_key: key(), type: 'pickup', lines: [newLine(PASTA(), 2)] }, cashier);
  assert.ok(order.id, 'the shop is closed online, the POS still takes orders');
  assert.match(errorOf(() => pos.save(null, { request_key: key(), type: 'pickup', lines: [newLine(PASTA())] }, cashier))
    .errors.lines, /sold out/);
  orders.saveSetting('shop_open', '1');
  menu.setStock(p.id, { availability: 'available', daily_limit: '' });
});

test('tabs can move tables and merge; a held tab is discarded, a sent one is voided', () => {
  const a = pos.save(null, { request_key: key(), type: 'dinein', table_no: '11', pax: 2, lines: [newLine(MATCHA())], send: true }, waiter).order;
  const b = pos.save(null, { request_key: key(), type: 'dinein', table_no: '12', pax: 3, lines: [newLine(PASTA())] }, waiter).order;
  assert.strictEqual(pos.moveTable(a.id, '14', waiter).table_no, '14');

  const merged = pos.merge(b.id, a.id, waiter);
  assert.deepStrictEqual([merged.table_no, merged.pax, merged.total], ['14', 5, 264]);
  assert.strictEqual(orders.get(b.id).status, 'cancelled');
  assert.strictEqual(orders.get(b.id).merged_into, a.id);
  assert.ok(!pos.open().some((o) => o.id === b.id));

  const held = pos.save(null, { request_key: key(), type: 'dinein', table_no: '15', lines: [newLine(MATCHA())] }, waiter).order;
  assert.deepStrictEqual(pos.voidOrder(held.id, {}, waiter), { ok: true, discarded: true });
  assert.strictEqual(errorOf(() => pos.voidOrder(a.id, { reason: 'Walked out' }, waiter)).body.needs[0], 'void');
  assert.ok(errorOf(() => pos.voidOrder(a.id, {}, owner)).errors.reason);
  assert.deepStrictEqual(pos.voidOrder(a.id, { reason: 'Walked out', override: OWNER_OK }, waiter), { ok: true, discarded: false });
  assert.strictEqual(orders.get(a.id).status, 'cancelled');
  assert.strictEqual(audit.list({ action: 'void' })[0].amount_cents, 26400);
});

/* ---------------------------- HTTP ---------------------------- */

test('the POS API: locked without a PIN, roles enforced on the server, first owner needs the password', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const email = 'pos-admin@example.com';
  auth.createUser(email, 'a-long-enough-password');
  try {
    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const call = (p, { method = 'GET', body, token } = {}) => fetch(`${url}${p}`, {
      method,
      headers: {
        Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf,
        'X-Request-Id': '1', ...(token ? { 'X-Staff-Token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    assert.strictEqual((await fetch(`${url}/api/pos/menu`)).status, 401, 'no admin session');
    assert.strictEqual((await call('/api/pos/menu')).status, 423, 'admin session but no PIN: locked');
    assert.strictEqual((await call('/api/pos/staff').then((r) => r.json())).staff.length, 3);

    const wrong = await call('/api/pos/unlock', { method: 'POST', body: { staff_id: waiter.id, pin: '9999' } });
    assert.deepStrictEqual([wrong.status, (await wrong.json()).wrong_pin], [403, true], "not 401: that would mean signed out");
    const unlocked = await (await call('/api/pos/unlock', { method: 'POST', body: { staff_id: waiter.id, pin: '4702' } })).json();
    assert.ok(unlocked.token);
    assert.ok(unlocked.permissions.includes('send_to_kitchen') && !unlocked.permissions.includes('take_payment'));

    const menuRes = await (await call('/api/pos/menu', { token: unlocked.token })).json();
    assert.ok(menuRes.items.length >= 9);
    const placed = await call('/api/pos/orders', { method: 'POST', token: unlocked.token, body: {
      request_key: key(), type: 'dinein', table_no: '20', lines: [newLine(MATCHA())],
    } });
    assert.strictEqual(placed.status, 201);
    assert.strictEqual((await call('/api/pos/orders', { method: 'POST', token: unlocked.token, body: {
      request_key: key(), type: 'pickup', lines: [newLine(MATCHA())],
    } })).status, 403, 'the server refuses takeout from a waiter');

    assert.strictEqual((await call('/api/staff', { token: unlocked.token })).status, 403, 'waiters cannot manage staff');
    assert.strictEqual((await call('/api/pos/settings', { method: 'PUT', token: unlocked.token, body: { vat_registered: true } })).status, 403);

    const ownerTok = (await (await call('/api/pos/unlock', { method: 'POST', body: { staff_id: owner.id, pin: '2580' } })).json()).token;
    assert.strictEqual((await call('/api/staff', { token: ownerTok }).then((r) => r.json())).staff.length, 3);
    const saved = await (await call('/api/pos/settings', { method: 'PUT', token: ownerTok, body: { cashier_discount_limit: 12 } })).json();
    assert.strictEqual(saved.cashier_discount_limit_bp, 1200);
    assert.strictEqual(audit.list({ action: 'settings_change' })[0].staff_name, 'Dachel');
    await call('/api/pos/settings', { method: 'PUT', token: ownerTok, body: { cashier_discount_limit: 10 } });

    await call('/api/pos/lock', { method: 'POST', token: unlocked.token });
    assert.strictEqual((await call('/api/pos/menu', { token: unlocked.token })).status, 423, 'locked again');

    // Without CSRF, writes are refused.
    const noCsrf = await fetch(`${url}/api/pos/orders`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Staff-Token': ownerTok }, body: '{}' });
    assert.strictEqual(noCsrf.status, 403);

    // The first owner can only be made while there is no staff, with the admin password.
    const first = await call('/api/staff/first', { method: 'POST', body: { name: 'X', pin: '2581', password: 'wrong-password-here' } });
    assert.strictEqual(first.status, 422);
    const exists = await call('/api/staff/first', { method: 'POST', body: { name: 'X', pin: '2581', password: 'a-long-enough-password' } });
    assert.strictEqual(exists.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
