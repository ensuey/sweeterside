'use strict';
/* Reports and the audit log (server/reports.js, server/csv.js): what counts
   as a sale, the breakdowns, the SC/PWD export, voucher and manual discount
   reports, the Php 3M tracker, CSV safety and owner-only access. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-reports-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const orders = require('../server/orders');
const reports = require('../server/reports');
const settings = require('../server/settings');
const vouchers = require('../server/vouchers');
const menu = require('../server/menu');
const checkout = require('../server/checkout');
const { toCsv } = require('../server/csv');
const { manilaDate } = require('../server/clock');

seedIfEmpty();
orders.saveSetting('max_open_orders', 1000);

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
const item = (name) => menu.list().find((i) => i.name === name);
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
const line = (name, qty = 1) => ({ key: `k${++seq}`, item_id: item(name).id, qty });
const today = { from: manilaDate(), to: manilaDate() };
const IDS = {};

test('setup: POS sales (SC, manual, voucher), an online sale, and things that are not sales', () => {
  shifts.open({ opening_cash: 500 }, cashier);
  // 1. Dine-in: pasta for an SC (135 -> 108) + matcha 129 = 237, paid cash.
  const pasta = line('Beef Penne Pasta');
  const a = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '1', lines: [pasta, line('Matcha Frappe')], send: true,
    discounts: { claimants: [{ type: 'sc', name: '=HYPERLINK("x")', id_no: 'OSCA-11112222', mode: 'exclusive', lines: { [pasta.key]: 1 } }] },
  }, cashier).order;
  payments.pay(a.id, { request_key: key(), payments: [{ method: 'cash', amount: 237 }] }, cashier);
  IDS.a = a.id;

  // 2. Takeout: 2 matcha, 10% manual = 232.20, paid GCash.
  const b = pos.save(null, {
    request_key: key(), type: 'pickup', lines: [line('Matcha Frappe', 2)],
    discounts: { manual: { kind: 'percent', value: 10, reason: 'Regular' } },
  }, cashier).order;
  payments.pay(b.id, { request_key: key(), payments: [{ method: 'gcash', amount: 232.2, reference: 'G-1' }] }, cashier);

  // 3. Takeout with a voucher, paid by card: 135 - 20 = 115.
  vouchers.create({ code: 'REP20', kind: 'amount', value: 20 });
  const c = pos.save(null, {
    request_key: key(), type: 'pickup', lines: [line('Beef Penne Pasta')], discounts: { voucher_code: 'REP20' },
  }, cashier).order;
  payments.pay(c.id, { request_key: key(), payments: [{ method: 'card', amount: 115, reference: 'C-1' }] }, cashier);

  // 4. Online dine-in, completed: 85.
  const online = orders.create({
    type: 'dinein', name: 'Web', table_no: '3', items: [{ id: item('Bacon and Egg Sandwich').id, qty: 1 }],
    expected_total: 85, checkout_token: checkout.issue(new Date(Date.now() - 10000)),
  });
  orders.setStatus(online.id, 'completed');

  // Not sales: an unpaid POS tab, an online order still in progress, a cancelled one.
  pos.save(null, { request_key: key(), type: 'dinein', table_no: '9', lines: [line('Matcha Frappe')] }, cashier);
  orders.create({ type: 'dinein', name: 'Pending', table_no: '4', items: [{ id: item('Matcha Frappe').id, qty: 1 }], expected_total: 129 });
  const gone = orders.create({ type: 'dinein', name: 'Gone', table_no: '5', items: [{ id: item('Matcha Frappe').id, qty: 1 }], expected_total: 129 });
  orders.setStatus(gone.id, 'cancelled', { reason: 'customer' });

  // A line refund on the takeout: one matcha, 116.10.
  const bLines = pos.view(b.id, owner).lines;
  payments.refund(b.id, { request_key: key(), lines: [{ line_id: bLines[0].id, qty: 1 }], method: 'gcash', reason: 'Melted' }, owner);
});

test('the summary counts paid POS orders and completed online orders, broken down every way', () => {
  const s = reports.summary(today);
  assert.strictEqual(s.totals.orders, 4);
  assert.strictEqual(s.totals.gross, 26400 + 25800 + 13500 + 8500);
  assert.deepStrictEqual([s.totals.sc_pwd, s.totals.manual, s.totals.voucher], [2700, 2580, 2000]);
  assert.strictEqual(s.totals.total, 23700 + 23220 + 11500 + 8500);
  assert.strictEqual(s.totals.net_sales, s.totals.total, 'no service charge or fees here');
  assert.deepStrictEqual(s.refunds, { count: 1, amount: 11610 });

  assert.deepStrictEqual(Object.fromEntries(s.by_source.map((x) => [x.source, x.orders])), { pos: 3, online: 1 });
  assert.deepStrictEqual(Object.fromEntries(s.by_type.map((x) => [x.order_type, x.orders])), { pickup: 2, dinein: 2 });
  assert.deepStrictEqual(Object.fromEntries(s.by_staff.map((x) => [x.staff, x.orders])), { Ana: 3, Online: 1 });
  assert.deepStrictEqual(s.by_day.map((d) => [d.day, d.orders, d.refunds]), [[today.from, 4, 11610]]);

  const matcha = s.by_item.find((x) => x.name === 'Matcha Frappe');
  assert.deepStrictEqual([matcha.qty, matcha.gross], [3, 3 * 12900]);
  assert.strictEqual(s.by_category.reduce((n, c) => n + c.net, 0), s.by_item.reduce((n, l) => n + l.net, 0));
  assert.deepStrictEqual(Object.fromEntries(s.payments.map((x) => [x.method, x.amount])), { cash: 23700, gcash: 23220, card: 11500 });
  assert.strictEqual(s.online_unrecorded, 8500, 'online orders are paid outside the POS');
});

test('the SC/PWD report: masked on screen, full IDs in the CSV, no VAT column when non-VAT', () => {
  const r = reports.scPwd(today);
  assert.strictEqual(r.vat_registered, false);
  assert.deepStrictEqual(r.rows.map((x) => [x.order_id, x.id_no, x.type, x.gross, x.discount, x.net]),
    [[IDS.a, '****2222', 'Senior Citizen', 13500, 2700, 10800]]);

  const csv = reports.scPwdCsv(today);
  const [head, row] = csv.trim().split('\r\n');
  assert.strictEqual(head, 'Date (Manila),Order no.,Name,ID number,Type,Gross eligible (Php),20% discount (Php),Net (Php)');
  assert.match(row, /OSCA-11112222/);
  assert.match(row, /,"'=HYPERLINK\(""x""\)",/, 'a name that looks like a formula is defused');
  assert.match(row, /,135,27,108$/);
});

test('vouchers and manual discounts, with who gave them', () => {
  const d = reports.discounts(today);
  assert.deepStrictEqual(d.vouchers.map((v) => [v.code, v.uses, v.discount]), [['REP20', 1, 2000]]);
  assert.deepStrictEqual(d.manual.map((m) => [m.staff_name, m.reason, m.amount_cents]), [['Ana', 'Regular', 2580]]);
  assert.deepStrictEqual(d.manual_by_staff, [{ staff: 'Ana', count: 1, amount: 2580 }]);
});

test('the Php 3M tracker: year to date, warnings at 80% and 95%', () => {
  const t = reports.threshold();
  assert.strictEqual(t.total_cents, 26400 + 25800 + 13500 + 8500 - 11610);
  assert.strictEqual(t.level, 'ok');
  const big = (cents) => db.prepare(`INSERT INTO orders (source, status, customer_name, phone, address, gross_cents,
      subtotal_cents, delivery_fee_cents, total_cents, cash_cents, change_due_cents)
      VALUES ('online', 'completed', 'Catering', '', '', ?, ?, 0, ?, 0, 0)`).run(cents, cents, cents);
  big(240000000);
  assert.strictEqual(reports.threshold().level, 'warn');
  big(46000000);
  const high = reports.threshold();
  assert.strictEqual(high.level, 'danger');
  assert.ok(high.percent >= 95 && high.percent < 100);
});

test('CSV cells: quoted when needed, formulas defused, numbers left alone', () => {
  assert.strictEqual(toCsv(['a', 'b'], [['x,y', -5], ['@sum', 'say "hi"']]),
    'a,b\r\n"x,y",-5\r\n\'@sum,"say ""hi"""\r\n');
  assert.throws(() => reports.range({ from: '2026-10-05', to: '2026-10-01' }), /Validation/);
  assert.throws(() => reports.range({ from: 'yesterday' }), /Validation/);
});

test('reports and the audit log are for the owner only', async () => {
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  auth.createUser('reports-admin@example.com', 'a-long-enough-password');
  try {
    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reports-admin@example.com', password: 'a-long-enough-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const unlock = async (id, pin) => (await (await fetch(`${url}/api/pos/unlock`, {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: id, pin }),
    })).json()).token;
    const get = (p, token) => fetch(`${url}${p}`, { headers: { Cookie: cookie, ...(token ? { 'X-Staff-Token': token } : {}) } });

    assert.strictEqual((await get('/api/reports/summary')).status, 423, 'locked without a PIN');
    const cashierTok = await unlock(cashier.id, '3691');
    for (const p of ['/api/reports/summary', '/api/reports/sc-pwd.csv', '/api/reports/threshold', '/api/audit', '/api/audit.csv']) {
      assert.strictEqual((await get(p, cashierTok)).status, 403, `cashier refused: ${p}`);
    }
    const ownerTok = await unlock(owner.id, '2580');
    assert.strictEqual((await (await get('/api/reports/summary', ownerTok)).json()).totals.orders, 6);
    const csv = await get(`/api/reports/sc-pwd.csv?from=${today.from}&to=${today.to}`, ownerTok);
    assert.strictEqual(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="sc-pwd-/);
    assert.match(await csv.text(), /OSCA-11112222/);

    const log = await (await get(`/api/audit?action=refund`, ownerTok)).json();
    assert.deepStrictEqual(log.entries.map((e) => [e.action, e.amount_cents]), [['refund', 11610]]);
    assert.ok(log.actions.includes('void'));
    const auditCsv = await (await get('/api/audit.csv', ownerTok)).text();
    assert.match(auditCsv, /When \(Manila\),Action,Staff,Approved by/);
    assert.strictEqual((await get('/api/reports/summary?from=2026-10-09&to=2026-10-01', ownerTok)).status, 422);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
