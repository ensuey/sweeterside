'use strict';
/* Counting by flavor (server/stock.js): a counted item counted per option of
   one required "choose one" group. Each flavor has its own count, the item's
   left is their sum, and the menu, the checkout and the POS refuse more of a
   flavor than it has. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-flavor-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
const staff = require('../server/staff');
const pos = require('../server/pos');
const orders = require('../server/orders');
const menu = require('../server/menu');
const options = require('../server/options');
const stock = require('../server/stock');
const payments = require('../server/payments');
const shifts = require('../server/shifts');
const checkout = require('../server/checkout');
const audit = require('../server/audit');

seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);
shifts.open({ opening_cash: 1000 }, cashier);

const item = (name) => menu.list().find((i) => i.name === name);
const CAKE = 'Bacon and Egg Sandwich'; // stands in for Tres leches: Php 85
const key = () => crypto.randomBytes(12).toString('hex');
let seq = 0;
function errorOf(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected an error');
}

const FLAVOR = options.createGroup({
  name: 'Flavor', kind: 'single', required: true,
  options: [{ name: 'Mango', price: 0 }, { name: 'Ube', price: 0 }, { name: 'Moca', price: 10 }],
});
const ADDONS = options.createGroup({
  name: 'Add-ons', kind: 'multiple', required: false, max: 2,
  options: [{ name: 'Extra cream', price: 15 }],
});
const opt = (group, name) => group.options.find((o) => o.name === name).id;
const MANGO = opt(FLAVOR, 'Mango');
const UBE = opt(FLAVOR, 'Ube');
const MOCA = opt(FLAVOR, 'Moca');
const CREAM = opt(ADDONS, 'Extra cream');
const cake = item(CAKE);
menu.update(cake.id, { ...cake, option_groups: [FLAVOR.id, ADDONS.id] });
const ID = cake.id;

const flavorLeft = () => {
  const i = item(CAKE);
  return { total: i.stock_left, ...Object.fromEntries((i.flavor_left ? Object.entries(i.flavor_left) : [])) };
};
const posLine = (optionIds, qty = 1) => ({ key: `k${++seq}`, item_id: ID, qty, options: optionIds });
const posOrder = (lines, by = cashier) => pos.save(null, {
  request_key: key(), type: 'pickup', customer_name: '', lines, send: true,
}, by).order;
const unitPrice = (ids) => 85 + (ids.includes(MOCA) ? 10 : 0) + (ids.includes(CREAM) ? 15 : 0);
const onlineInput = (lines) => ({
  type: 'dinein', name: 'Guest', phone: '', address: '', cash: '', table_no: '3',
  items: lines.map(([ids, qty]) => ({ id: ID, qty, options: ids })),
  expected_total: lines.reduce((sum, [ids, qty]) => sum + unitPrice(ids) * qty, 0),
  checkout_token: checkout.issue(new Date(Date.now() - 10000)),
});

test('only a required "choose one" group can be counted, and the counts are checked', () => {
  const bad = [
    [[{ option_id: CREAM, qty: 1 }], /group where one must be chosen/],
    [[{ option_id: MANGO, qty: 1 }, { option_id: CREAM, qty: 1 }], /not on this item/],
    [[{ option_id: MANGO, qty: 1 }, { option_id: MANGO, qty: 2 }], /not on this item/],
    [[{ option_id: MANGO, qty: -1 }], /whole number/],
    [[{ option_id: MANGO, qty: 1.5 }], /whole number/],
    [[], /each flavor/],
    ['Mango', /each flavor/],
  ];
  for (const [flavors, message] of bad) {
    const e = errorOf(() => stock.change(ID, { action: 'count', flavors }, owner));
    assert.match(e.errors.flavors, message, JSON.stringify(flavors));
  }
  assert.strictEqual(stock.level(ID), null, 'nothing was saved');
});

test('a count by flavor starts counting: the item has the sum, each flavor its own', () => {
  const level = stock.change(ID, {
    action: 'count', request_key: key(),
    flavors: [{ option_id: MANGO, qty: 1 }, { option_id: UBE, qty: 7 }, { option_id: MOCA, qty: 6 }],
  }, cashier);
  assert.strictEqual(level.left, 14);
  assert.deepStrictEqual(flavorLeft(), { total: 14, [MANGO]: 1, [UBE]: 7, [MOCA]: 6 });

  // The menu and the POS show each flavor's count; none left is not available.
  const g = options.menuOptions([item(CAKE)])[ID].groups;
  assert.deepStrictEqual(g[0].options.map((o) => [o.name, o.left, o.available]),
    [['Mango', 1, true], ['Ube', 7, true], ['Moca', 6, true]]);
  assert.deepStrictEqual(g[1].options.map((o) => o.left), [null], 'other groups are not counted');
  const p = pos.posMenu().find((i) => i.id === ID);
  assert.deepStrictEqual(p.flavors.map((f) => [f.name, f.left]), [['Mango', 1], ['Ube', 7], ['Moca', 6]]);

  // Once counted by flavor, the item cannot be counted as a whole.
  const whole = errorOf(() => stock.change(ID, { action: 'count', qty: 20 }, cashier));
  assert.match(whole.errors.qty, /by flavor/);
  const noFlavor = errorOf(() => stock.change(ID, { action: 'add', qty: 2 }, cashier));
  assert.match(noFlavor.errors.qty, /Choose the flavor/);
});

test('online: no more of a flavor than it has, even when the item has plenty', () => {
  const short = errorOf(() => orders.create(onlineInput([[[MANGO], 2]])));
  assert.strictEqual(short.status, 409);
  assert.match(short.body.error, /^Only 1 Bacon and Egg Sandwich \(Mango\) left\. /);
  assert.deepStrictEqual(short.body.quote.flavor_limits, { [`${ID}:${MANGO}`]: 1 });

  // Two lines of the same flavor (one with an add-on) count together.
  const split = errorOf(() => orders.create(onlineInput([[[MANGO], 1], [[MANGO, CREAM], 1]])));
  assert.strictEqual(split.status, 409);

  const placed = orders.create(onlineInput([[[MANGO, CREAM], 1], [[UBE], 2]]));
  assert.ok(placed.id);
  assert.deepStrictEqual(flavorLeft(), { total: 11, [MANGO]: 0, [UBE]: 5, [MOCA]: 6 });
  const saved = db.prepare('SELECT option_ids FROM order_items WHERE order_id = ? ORDER BY id').all(placed.id);
  assert.deepStrictEqual(saved.map((r) => JSON.parse(r.option_ids)), [[MANGO, CREAM].sort((a, b) => a - b), [UBE]]);

  // Mango is gone: shown, not available, and refused; the other flavors still sell.
  const mango = options.menuOptions([item(CAKE)])[ID].groups[0].options[0];
  assert.deepStrictEqual([mango.left, mango.available], [0, false]);
  assert.strictEqual(item(CAKE).sold_out, false);
  const gone = errorOf(() => orders.create(onlineInput([[[MANGO], 1]])));
  assert.match(gone.body.error, /Mango\) is sold out/);
  assert.ok(orders.create(onlineInput([[[MOCA], 1]])).id);

  // Cancelling gives the flavors back.
  orders.setStatus(placed.id, 'cancelled', { reason: 'customer' });
  assert.deepStrictEqual(flavorLeft(), { total: 13, [MANGO]: 1, [UBE]: 7, [MOCA]: 5 });
});

test('POS: new lines and more of a saved line are checked per flavor', () => {
  const tooMany = errorOf(() => posOrder([posLine([MANGO], 2)]));
  assert.match(tooMany.errors.lines, /Only 1 Bacon and Egg Sandwich \(Mango\) left/);

  const o = posOrder([posLine([MANGO], 1), posLine([UBE], 1)]);
  assert.deepStrictEqual(flavorLeft(), { total: 11, [MANGO]: 0, [UBE]: 6, [MOCA]: 5 });

  // One more Mango on the saved line: none left.
  const lines = o.lines.map((l) => ({ id: l.id, key: String(l.id), qty: l.qty + (l.name && l.options_text.includes('Mango') ? 1 : 0) }));
  const more = errorOf(() => pos.save(o.id, { request_key: key(), version: o.version, lines }, cashier));
  assert.match(more.errors.lines, /Mango\) is sold out/);

  // Paid: handed over, still taken.
  payments.pay(o.id, { request_key: key(), payments: [{ method: 'cash', amount: o.total }] }, cashier);
  assert.deepStrictEqual(flavorLeft(), { total: 11, [MANGO]: 0, [UBE]: 6, [MOCA]: 5 });
});

test('adding a batch of one flavor, recounting one flavor, a new flavor starts at none', () => {
  const k = key();
  assert.strictEqual(stock.change(ID, { action: 'add', qty: 3, option_id: MANGO, request_key: k }, cashier).left, 14);
  stock.change(ID, { action: 'add', qty: 3, option_id: MANGO, request_key: k }, cashier);
  assert.deepStrictEqual(flavorLeft(), { total: 14, [MANGO]: 3, [UBE]: 6, [MOCA]: 5 }, 'a repeated request adds once');

  stock.change(ID, { action: 'count', flavors: [{ option_id: UBE, qty: 2 }], request_key: key() }, cashier);
  assert.deepStrictEqual(flavorLeft(), { total: 10, [MANGO]: 3, [UBE]: 2, [MOCA]: 5 }, 'the others keep their counts');

  const wrong = errorOf(() => stock.change(ID, { action: 'add', qty: 1, option_id: CREAM }, cashier));
  assert.match(wrong.errors.qty, /Choose the flavor/);

  // A flavor added to the group later has no count: none left until counted.
  const g = options.updateGroup(FLAVOR.id, {
    name: 'Flavor', kind: 'single', required: true,
    options: [...options.getGroup(FLAVOR.id).options, { name: 'Pandan', price: 0 }],
  });
  const PANDAN = opt(g, 'Pandan');
  const pandan = options.menuOptions([item(CAKE)])[ID].groups[0].options.find((o) => o.id === PANDAN);
  assert.deepStrictEqual([pandan.left, pandan.available], [0, false]);
  assert.match(errorOf(() => orders.create(onlineInput([[[PANDAN], 1]]))).body.error, /Pandan\) is sold out/);

  // Changes are audited with the flavor.
  const last = audit.list({ action: 'stock_count' })[0];
  assert.deepStrictEqual(last.details.flavors, [{ option_id: UBE, flavor: 'Ube', qty: 2 }]);
});

test('deleting a handed-over order keeps each flavor count; stopping ends flavor counting too', () => {
  const o = posOrder([posLine([MOCA], 2)]);
  payments.pay(o.id, { request_key: key(), payments: [{ method: 'cash', amount: o.total }] }, cashier);
  assert.strictEqual(flavorLeft()[MOCA], 3);
  orders.remove(o.id, owner);
  assert.strictEqual(flavorLeft()[MOCA], 3, 'deleting it does not put them back');

  assert.strictEqual(stock.change(ID, { action: 'off' }, owner), null);
  const i = item(CAKE);
  assert.deepStrictEqual([i.stock_left, i.flavor_left, i.flavor_group], [null, null, null]);
  assert.deepStrictEqual(options.menuOptions([i])[ID].groups[0].options.map((o) => o.left), [null, null, null, null]);

  // Counted again as a whole: flavors are free to choose, the item count applies.
  stock.change(ID, { action: 'count', qty: 5 }, owner); // one is still set aside on an open order
  assert.ok(posOrder([posLine([MANGO], 1)]).id);
});
