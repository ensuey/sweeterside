'use strict';
/* POS data model: the centavo migration, staff and PINs, staff sessions and
   the idle lock, manager overrides, the append-only audit log and the POS
   settings. Uses its own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-pos-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const staff = require('../server/staff');
const audit = require('../server/audit');
const settings = require('../server/settings');
const orders = require('../server/orders');
const vouchers = require('../server/vouchers');
const menu = require('../server/menu');

seedIfEmpty();
orders.saveSetting('max_open_orders', 1000);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function adminSession() {
  const email = `admin${crypto.randomBytes(4).toString('hex')}@example.com`;
  const user = auth.createUser(email, 'a-long-enough-password');
  const { token } = auth.createSession(user.lastInsertRowid);
  return sha256(token);
}
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}

let owner;
let cashier;
let waiter;

test('the first staff member must be the owner; after that only staff can add staff', () => {
  assert.strictEqual(staff.hasStaff(), false);
  assert.ok(errorOf(() => staff.create({ name: 'Ana', role: 'cashier', pin: '2580' }, null)).errors.role);
  owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
  assert.deepStrictEqual(owner, { id: owner.id, name: 'Dachel', role: 'owner', active: true });
  assert.strictEqual(errorOf(() => staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, null)).status, 403);

  cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
  waiter = staff.create({ name: 'Ben', role: 'waiter', pin: '470213' }, owner);
  assert.deepStrictEqual(staff.list().map((s) => s.name), ['Dachel', 'Ana', 'Ben'], 'owner first, then cashier, then waiter');
  assert.ok(db.prepare('SELECT pin_hash FROM staff WHERE id = ?').get(cashier.id).pin_hash.startsWith('scrypt$'),
    'PINs are scrypt-hashed');
});

test('PINs are 4-6 digits and not trivially guessable', () => {
  for (const bad of ['123', '1234567', 'abcd', '12a4', '1111', '1234', '4321', '000000', '']) {
    assert.ok(staff.pinProblem(bad), `should refuse ${bad}`);
  }
  for (const good of ['2580', '3691', '470213', '1235']) assert.strictEqual(staff.pinProblem(good), null);
  assert.ok(errorOf(() => staff.create({ name: 'Cy', role: 'waiter', pin: '1111' }, owner)).errors.pin);
});

test('a wrong PIN is refused, and five wrong PINs lock that staff member for 5 minutes', () => {
  const t0 = Date.UTC(2026, 9, 24, 2, 0);
  assert.strictEqual(staff.verifyPin(cashier.id, '3691', t0).name, 'Ana');
  for (let i = 1; i <= 4; i++) assert.strictEqual(errorOf(() => staff.verifyPin(cashier.id, '0000', t0)).status, 401);
  const locked = errorOf(() => staff.verifyPin(cashier.id, '0000', t0));
  assert.strictEqual(locked.status, 429);
  assert.strictEqual(errorOf(() => staff.verifyPin(cashier.id, '3691', t0 + 60 * 1000)).status, 429,
    'even the right PIN waits out the lock');
  assert.strictEqual(staff.verifyPin(cashier.id, '3691', t0 + staff.PIN_LOCK_MS + 1).name, 'Ana', 'unlocks after 5 minutes');
  assert.strictEqual(errorOf(() => staff.verifyPin(owner.id, '0000', t0)).status, 401, 'other staff are not affected');
  staff.verifyPin(owner.id, '2580', t0);
});

test('staff sessions: tied to the admin session, locked after the idle time', () => {
  const adminA = adminSession();
  const adminB = adminSession();
  const t0 = Date.UTC(2026, 9, 24, 3, 0);
  const { token, staff: who, lock_minutes: mins } = staff.unlock(cashier.id, '3691', adminA, t0);
  assert.strictEqual(who.name, 'Ana');
  assert.strictEqual(mins, 5);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM staff_sessions WHERE id = ?').get(token).n, 0,
    'only the hash of the token is stored');

  assert.strictEqual(staff.current(token, adminA, t0 + 4 * 60 * 1000).name, 'Ana');
  assert.strictEqual(staff.current(token, adminB, t0 + 4 * 60 * 1000), null, 'another admin session cannot use it');
  assert.strictEqual(staff.current(token, adminA, t0 + 8 * 60 * 1000).name, 'Ana', 'use pushes the lock back');
  assert.strictEqual(staff.current(token, adminA, t0 + 14 * 60 * 1000), null, 'idle for 6 minutes: locked');
  assert.strictEqual(staff.current(token, adminA, t0 + 14 * 60 * 1000 + 1), null, 'and stays locked');

  const again = staff.unlock(cashier.id, '3691', adminA, t0);
  staff.lock(again.token);
  assert.strictEqual(staff.current(again.token, adminA, t0), null, 'locking by hand ends it');

  settings.updatePosSettings({ pos_lock_minutes: 1 });
  const quick = staff.unlock(cashier.id, '3691', adminA, t0);
  assert.strictEqual(staff.current(quick.token, adminA, t0 + 2 * 60 * 1000), null, 'the idle time is a setting');
  settings.updatePosSettings({ pos_lock_minutes: 5 });
});

test('switching staff off or changing their PIN ends their session; the last owner stays an owner', () => {
  const admin = adminSession();
  const now = Date.now();
  const s = staff.unlock(waiter.id, '470213', admin, now);
  staff.resetPin(waiter.id, '582046', owner);
  assert.strictEqual(staff.current(s.token, admin, now), null);
  assert.strictEqual(errorOf(() => staff.verifyPin(waiter.id, '470213')).status, 401);

  const s2 = staff.unlock(waiter.id, '582046', admin, now);
  staff.update(waiter.id, { active: false }, owner);
  assert.strictEqual(staff.current(s2.token, admin, now), null);
  assert.strictEqual(errorOf(() => staff.verifyPin(waiter.id, '582046')).status, 403);
  assert.deepStrictEqual(staff.list().map((x) => x.name), ['Dachel', 'Ana'], 'switched-off staff leave the PIN screen');
  staff.update(waiter.id, { active: true }, owner);

  assert.ok(errorOf(() => staff.update(owner.id, { role: 'cashier' }, owner)).errors.role);
  assert.ok(errorOf(() => staff.update(owner.id, { active: false }, owner)).errors.role);
});

test('roles: what each may do, and manager overrides by an owner PIN', () => {
  assert.ok(staff.can('waiter', 'send_to_kitchen'));
  for (const p of ['take_payment', 'void', 'manual_discount', 'takeout_and_delivery', 'see_id_numbers']) {
    assert.ok(!staff.can('waiter', p), `waiter cannot ${p}`);
  }
  assert.ok(staff.can('cashier', 'take_payment') && staff.can('cashier', 'manual_discount'));
  for (const p of ['void', 'refund', 'price_override', 'discount_over_limit', 'reports', 'audit', 'manage_staff']) {
    assert.ok(!staff.can('cashier', p), `cashier cannot ${p}`);
    assert.ok(staff.can('owner', p), `owner can ${p}`);
  }

  assert.deepStrictEqual(staff.authorise(owner, 'void'), { approver: null }, 'the owner needs no override');
  const none = errorOf(() => staff.authorise(cashier, 'void'));
  assert.strictEqual(none.status, 403);
  assert.strictEqual(none.body.override_required, true);
  assert.strictEqual(errorOf(() => staff.authorise(cashier, 'void', { staff_id: cashier.id, pin: '3691' })).status, 403,
    "a cashier cannot approve their own void");
  assert.strictEqual(errorOf(() => staff.authorise(cashier, 'void', { staff_id: owner.id, pin: '9999' })).status, 401);
  assert.strictEqual(staff.authorise(cashier, 'void', { staff_id: owner.id, pin: '2580' }).approver.name, 'Dachel');
});

test('the audit log records staff changes and cannot be changed or deleted', () => {
  const entries = audit.list();
  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes('staff_add') && actions.includes('staff_pin_change') && actions.includes('staff_change'));
  const pin = entries.find((e) => e.action === 'staff_pin_change');
  assert.strictEqual(pin.staff_name, 'Dachel');
  assert.strictEqual(pin.details.name, 'Ben');
  assert.ok(!JSON.stringify(entries).includes('582046'), 'PINs never reach the log');

  const id = audit.record({ action: 'void', staff: cashier, approver: owner, order_id: 1, amount_cents: 12900, reason: 'Wrong item' });
  const row = audit.list({ action: 'void' })[0];
  assert.deepStrictEqual([row.id, row.staff_name, row.approver_name, row.amount_cents, row.reason],
    [id, 'Ana', 'Dachel', 12900, 'Wrong item']);
  assert.strictEqual(audit.list({ staff_id: owner.id, action: 'void' }).length, 1, 'found by approver too');
  assert.throws(() => db.prepare("UPDATE audit_log SET reason = 'x' WHERE id = ?").run(id), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id), /cannot be changed/);
  assert.throws(() => audit.record({ action: 'nope' }), /Unknown audit action/);
});

test('POS settings: non-VAT by default, service charge off, 10% cashier limit', () => {
  const s = settings.posSettings();
  assert.strictEqual(s.vat_registered, false, 'the migration sets non-VAT');
  assert.deepStrictEqual(s.service_charge, { on: false, rate_bp: 1000, types: ['dinein'], base: 'after_discounts' });
  assert.strictEqual(s.cashier_discount_limit_bp, 1000);

  const after = settings.updatePosSettings({
    service_charge_on: true, service_charge_rate: '7.5', service_charge_types: ['dinein', 'pickup'],
    cashier_discount_limit: 15,
  });
  assert.deepStrictEqual(after.service_charge, { on: true, rate_bp: 750, types: ['dinein', 'pickup'], base: 'after_discounts' });
  assert.strictEqual(after.cashier_discount_limit_bp, 1500);

  const err = errorOf(() => settings.updatePosSettings({ service_charge_rate: 25, vat_registered: 'maybe', service_charge_base: 'x' }));
  assert.ok(err.errors.service_charge_rate && err.errors.vat_registered && err.errors.service_charge_base);
  assert.strictEqual(settings.posSettings().service_charge.rate_bp, 750, 'a bad value saves nothing');
  settings.updatePosSettings({ service_charge_on: false, service_charge_rate: 10, service_charge_types: ['dinein'], cashier_discount_limit: 10 });
});

/* ---------------------------- orders in centavos ---------------------------- */

const MATCHA = () => menu.list().find((i) => i.name === 'Matcha Frappe');
const checkoutInput = (over = {}) => ({
  type: 'pickup', name: 'Maria Santos', phone: '0917 123 4567', pickup_at: 'asap',
  items: [{ id: MATCHA().id, qty: 2 }], expected_total: 258, ...over,
});
const noon = new Date('2026-10-24T04:00:00Z'); // 12:00 in Manila

test('online orders are stored in centavos with source, gross and the pricing breakdown', () => {
  const order = orders.create(checkoutInput(), { now: noon });
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  assert.deepStrictEqual([row.source, row.subtotal_cents, row.total_cents, row.gross_cents, row.discount_cents],
    ['online', 25800, 25800, 25800, 0]);
  assert.strictEqual(order.total, 258, 'peso fields are still there for the checkout');
  assert.deepStrictEqual(order.items.map((l) => [l.price_cents, l.regular_price_cents, l.net_cents, l.price]),
    [[12900, 12900, 25800, 129]]);
  assert.strictEqual(order.pricing.totals.total, 25800);
  assert.deepStrictEqual(order.pricing.claimants, []);
});

test('voucher uses: a POS order counts once it is paid', () => {
  const v = vouchers.create({ code: 'POSTEST', kind: 'amount', value: 20 });
  orders.create(checkoutInput({ voucher: 'postest', expected_total: 238 }), { now: noon });
  assert.strictEqual(vouchers.get(v.id).uses, 1);
  const info = db.prepare(`INSERT INTO orders (source, customer_name, phone, address, subtotal_cents, delivery_fee_cents,
      total_cents, cash_cents, change_due_cents, voucher_code, discount_cents)
      VALUES ('pos', 'Walk-in', '', '', 10000, 0, 8000, 0, 0, 'POSTEST', 2000)`).run();
  assert.strictEqual(vouchers.get(v.id).uses, 1, 'unpaid POS order does not count');
  db.prepare("UPDATE orders SET paid_at = datetime('now') WHERE id = ?").run(info.lastInsertRowid);
  assert.strictEqual(vouchers.get(v.id).uses, 2);
});

test('SC/PWD ID numbers are masked when an order is read, unless asked for in full', () => {
  const priced = require('../server/pricing').price({
    type: 'dinein', tax: { vat_registered: false },
    lines: [{ key: '0', name: 'Pasta', qty: 1, unit_cents: 56000 }],
    claimants: [{ type: 'sc', name: 'Lola', id_no: 'OSCA-778899', mode: 'exclusive', lines: { 0: 1 } }],
  });
  const info = db.prepare(`INSERT INTO orders (source, order_type, customer_name, phone, address, subtotal_cents,
      delivery_fee_cents, total_cents, cash_cents, change_due_cents, pricing)
      VALUES ('pos', 'dinein', 'Walk-in', '', '', 56000, 0, 44800, 0, 0, ?)`).run(JSON.stringify(priced));
  assert.strictEqual(orders.get(info.lastInsertRowid).pricing.claimants[0].id_no, '****8899');
  assert.strictEqual(orders.get(info.lastInsertRowid, { fullIds: true }).pricing.claimants[0].id_no, 'OSCA-778899');
  const listed = orders.list('all').find((o) => o.id === Number(info.lastInsertRowid));
  assert.strictEqual(listed.pricing.claimants[0].id_no, '****8899', 'lists are masked');
});

test('a peso database migrates to centavos without touching the orders', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-cents-'));
  const dbPath = path.join(dir, 'old.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  // The schema as it was just before the POS: pesos, with vouchers and the Confirmed status.
  old.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      label TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO categories (id, slug, name, label) VALUES (1, 'drinks', 'Drinks', 'Drinks');
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT, image TEXT NOT NULL,
      alt TEXT NOT NULL DEFAULT '', crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), availability TEXT NOT NULL DEFAULT 'available',
      daily_limit INTEGER, best_seller INTEGER NOT NULL DEFAULT 0, sale_type TEXT NOT NULL DEFAULT '', sale_value INTEGER);
    INSERT INTO items (id, name, price, category_id, image) VALUES (5, 'Kept Frappe', 99, 1, 'assets/Menu Frappe.jpg');
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
      address TEXT NOT NULL, subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
      cash INTEGER NOT NULL, change_due INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','confirmed','preparing','delivering','completed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      order_type TEXT NOT NULL DEFAULT 'delivery', table_no TEXT NOT NULL DEFAULT '',
      pickup_at TEXT NOT NULL DEFAULT '', voucher_code TEXT NOT NULL DEFAULT '',
      discount INTEGER NOT NULL DEFAULT 0, phone_norm TEXT, landmark TEXT NOT NULL DEFAULT '',
      cancel_reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, name TEXT NOT NULL, price INTEGER NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0));
    INSERT INTO orders (id, customer_name, phone, address, subtotal, delivery_fee, total, cash, change_due,
      voucher_code, discount, status)
      VALUES (7, 'Old Customer', '09170000000', '1 Old St', 297, 40, 287, 500, 213, 'TEN', 50, 'completed');
    INSERT INTO order_items (order_id, item_id, name, price, qty) VALUES (7, 5, 'Kept Frappe', 99, 2), (7, NULL, 'Gone', 99, 1);`);
  old.close();

  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    const orders = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'orders'))});
    const settings = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'settings'))});
    const row = db.prepare('SELECT * FROM orders WHERE id = 7').get();
    const lines = db.prepare('SELECT price_cents, regular_price_cents, net_cents, qty FROM order_items ORDER BY id').all();
    const o = orders.get(7);
    console.log(JSON.stringify({
      cols: ['subtotal', 'total', 'discount', 'cash'].filter((c) => c in row),
      cents: [row.subtotal_cents, row.delivery_fee_cents, row.total_cents, row.cash_cents, row.change_due_cents, row.discount_cents],
      keep: [row.status, row.customer_name, row.voucher_code],
      pos: [row.source, row.gross_cents, row.sc_pwd_discount_cents, row.service_charge_cents, row.pricing],
      lines: lines.map((l) => [l.price_cents, l.regular_price_cents, l.net_cents, l.qty]),
      pesos: [o.subtotal, o.discount, o.delivery_fee, o.total, o.cash, o.change_due, o.items.map((l) => l.price)],
      vat: settings.vatRegistered(),
      sc: db.prepare('SELECT sc_eligible FROM items WHERE id = 5').get().sc_eligible,
    }));`],
  { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), {
    cols: [], // the peso columns are gone, renamed
    cents: [29700, 4000, 28700, 50000, 21300, 5000],
    keep: ['completed', 'Old Customer', 'TEN'],
    pos: ['online', 29700, 0, 0, ''],
    // The Php 50 voucher is spread over the lines by amount: 198/297 and 99/297 of it.
    lines: [[9900, 9900, 19800 - 3333, 2], [9900, 9900, 9900 - 1667, 1]],
    pesos: [297, 50, 40, 287, 500, 213, [99, 99]],
    vat: false,
    sc: 1,
  });
});
