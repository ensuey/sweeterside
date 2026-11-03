'use strict';
/* PR C, item descriptions, sizes and options: groups made once and attached
   to items, choices checked on the server, prices with options at the
   checkout and the POS, sales and SC/PWD on the whole line, and a copy of
   the options kept on each order line. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-options-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { db, seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const render = require('../server/render');
const auth = require('../server/auth');
const staff = require('../server/staff');
const pos = require('../server/pos');
const options = require('../server/options');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const item = (name) => menu.list().find((i) => i.name === name);
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
const key = () => crypto.randomBytes(12).toString('hex');
let phoneSeq = 10;
// Pick-up orders: no delivery area or fee to think about.
const place = (items, expected) => {
  const o = orders.create({
    type: 'dinein', name: 'Ana Reyes', table_no: '4', items, expected_total: expected,
    checkout_token: checkout.issue(new Date(Date.now() - 10000)), phone: `0917 123 45${++phoneSeq}`,
  });
  db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(o.id);
  return o;
};

const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
const cashier = staff.create({ name: 'Ana', role: 'cashier', pin: '3691' }, owner);

// Matcha Frappe is ₱129. Size: Regular +0 / Large +20 (required).
// Add-ons: Extra shot +25, Oat milk +30, Sold-out syrup +15 (off), up to 2.
const SIZE = options.createGroup({
  name: 'Size', kind: 'single', required: true,
  options: [{ name: 'Regular', price: 0 }, { name: 'Large', price: 20 }],
});
const ADDONS = options.createGroup({
  name: 'Add-ons', kind: 'multiple', required: false, max: 2,
  options: [{ name: 'Extra shot', price: 25 }, { name: 'Oat milk', price: 30 }, { name: 'Caramel syrup', price: 15, available: false }],
});
const opt = (group, name) => group.options.find((o) => o.name === name).id;
const REGULAR = opt(SIZE, 'Regular');
const LARGE = opt(SIZE, 'Large');
const SHOT = opt(ADDONS, 'Extra shot');
const OAT = opt(ADDONS, 'Oat milk');
const SYRUP = opt(ADDONS, 'Caramel syrup');
const matcha = item('Matcha Frappe');
menu.update(matcha.id, { ...matcha, option_groups: [SIZE.id, ADDONS.id] });

test('groups are checked when saved', () => {
  const bad = [
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ kind: 'many' }, 'kind'],
    [{ options: [] }, 'options'], [{ options: [{ name: '' }] }, 'options'],
    [{ options: [{ name: 'A' }, { name: 'a' }] }, 'options'], [{ options: [{ name: 'A', price: -5 }] }, 'options'],
    [{ options: [{ name: 'A', price: 1.5 }] }, 'options'], [{ options: [{ name: 'A', price: 10001 }] }, 'options'],
    [{ kind: 'multiple', max: 0 }, 'max'], [{ kind: 'multiple', required: true, min: 3, max: 2 }, 'min'],
  ];
  for (const [over, field] of bad) {
    const e = errorsOf(() => options.createGroup({ name: 'Sugar', kind: 'single', options: [{ name: 'Less' }], ...over }));
    assert.ok(e && e[field], `${JSON.stringify(over)} should fail on ${field}`);
  }
  assert.strictEqual(options.listGroups().length, 2, 'nothing saved by the failures');
  // A single choice is at most one; required makes it exactly one.
  assert.deepStrictEqual([SIZE.min, SIZE.max, ADDONS.min, ADDONS.max], [1, 1, 0, 2]);
  // An item cannot get a group that does not exist.
  assert.ok(errorsOf(() => menu.update(matcha.id, { ...matcha, option_groups: [9999] })).option_groups);
});

test('the price of a line is the item plus its options', () => {
  const q = orders.quote([{ id: matcha.id, qty: 2, options: [LARGE, SHOT] }], 'dinein');
  assert.deepStrictEqual([q.lines[0].price, q.total], [129 + 20 + 25, (129 + 20 + 25) * 2]);
  // The same item with other options is its own line; the same options in another order are one line.
  const two = orders.quote([
    { id: matcha.id, qty: 1, options: [REGULAR] }, { id: matcha.id, qty: 1, options: [LARGE] },
    { id: matcha.id, qty: 1, options: [SHOT, LARGE] }, { id: matcha.id, qty: 1, options: [LARGE, SHOT] },
  ], 'dinein');
  assert.deepStrictEqual(two.lines.map((l) => [l.price, l.qty]), [[129, 1], [149, 1], [174, 2]]);
});

test('choices are refused when they do not fit the item', () => {
  const refused = (opts, pattern) => {
    const e = errorsOf(() => orders.quote([{ id: matcha.id, qty: 1, options: opts }], 'dinein'));
    assert.ok(e && e.items, `${JSON.stringify(opts)} should be refused`);
    assert.match(e.items, pattern);
  };
  refused(undefined, /Choose size/); // the required group was left out
  refused([], /Choose size/);
  refused([REGULAR, LARGE], /only one size/);
  // A repeated id counts once: Regular with two add-ons is allowed.
  assert.strictEqual(orders.quote([{ id: matcha.id, qty: 1, options: [REGULAR, SHOT, OAT, SHOT] }], 'dinein').total, 129 + 25 + 30);
  refused([LARGE, SYRUP], /not available/);
  // An option from a group on another item.
  const other = options.createGroup({ name: 'Sauce', options: [{ name: 'Gravy', price: 10 }] });
  menu.update(item('Bacon and Egg Sandwich').id, { ...item('Bacon and Egg Sandwich'), option_groups: [other.id] });
  refused([LARGE, other.options[0].id], /not on Matcha Frappe/);
  refused([LARGE, 'abc'], /not valid/);
  refused([LARGE, 99999], /not on Matcha Frappe/);
  const tooMany = createMax(); // up to 2 add-ons
  refused([LARGE, ...tooMany], /at most 2/);
  // Placing the order is refused the same way, and nothing is saved.
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  assert.ok(errorsOf(() => place([{ id: matcha.id, qty: 1, options: [REGULAR, SYRUP] }], 129)).items);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
});
// Three available add-ons, for the "too many" case.
function createMax() {
  const g = options.updateGroup(ADDONS.id, {
    name: 'Add-ons', kind: 'multiple', max: 2,
    options: [...options.getGroup(ADDONS.id).options.map((o) => ({ id: o.id, name: o.name, price: o.price, available: o.available })),
      { name: 'Whipped cream', price: 10 }],
  });
  return [SHOT, OAT, opt(g, 'Whipped cream')];
}

test('a sale applies to the item and its options together', () => {
  menu.update(matcha.id, { ...item('Matcha Frappe'), sale_type: 'percent', sale_value: 10 });
  try {
    // 129 + 20 = 149, less 10% = 134.10, so 134 (sale prices are whole pesos).
    const q = orders.quote([{ id: matcha.id, qty: 1, options: [LARGE] }], 'dinein');
    assert.deepStrictEqual([q.lines[0].regular, q.lines[0].price], [149, 134]);
    menu.update(matcha.id, { ...item('Matcha Frappe'), sale_type: 'amount', sale_value: 20 });
    const a = orders.quote([{ id: matcha.id, qty: 1, options: [LARGE, SHOT] }], 'dinein');
    assert.strictEqual(a.lines[0].price, 129 + 20 + 25 - 20);
  } finally {
    menu.update(matcha.id, { ...item('Matcha Frappe'), sale_type: '', sale_value: null });
  }
});

test('the order keeps the options as they were, whatever changes later', () => {
  const o = place([{ id: matcha.id, qty: 1, options: [LARGE, SHOT] }], 174);
  const line = orders.get(o.id).items[0];
  assert.deepStrictEqual(line.options, [
    { group: 'Size', name: 'Large', price_cents: 2000 }, { group: 'Add-ons', name: 'Extra shot', price_cents: 2500 },
  ]);
  assert.strictEqual(line.options_text, 'Size: Large · Add-ons: Extra shot');
  assert.deepStrictEqual([line.price, line.options_cents], [174, 4500]);
  // Large goes up to ₱35 and Extra shot is renamed, then removed.
  const g = options.getGroup(SIZE.id);
  options.updateGroup(SIZE.id, { ...g, options: g.options.map((x) => (x.id === LARGE ? { ...x, price: 35 } : x)) });
  const a = options.getGroup(ADDONS.id);
  options.updateGroup(ADDONS.id, { ...a, options: a.options.filter((x) => x.id !== SHOT) });
  const again = orders.get(o.id);
  assert.deepStrictEqual(again.items[0].options, line.options);
  assert.strictEqual(again.total, 174);
  // New orders get the new price.
  assert.strictEqual(orders.quote([{ id: matcha.id, qty: 1, options: [LARGE] }], 'dinein').total, 164);
  options.updateGroup(SIZE.id, g);
});

test('today\'s limit counts the item, whatever its options', () => {
  menu.setStock(matcha.id, { availability: 'available', daily_limit: 3 });
  try {
    const q = orders.quote([
      { id: matcha.id, qty: 2, options: [REGULAR] }, { id: matcha.id, qty: 2, options: [LARGE] },
    ], 'dinein');
    assert.strictEqual(q.short.length, 1);
    assert.strictEqual(q.limits[matcha.id], menu.get(matcha.id).remaining);
  } finally {
    menu.setStock(matcha.id, { availability: 'available', daily_limit: null });
  }
});

test('the POS prices options the same way, with SC/PWD on the whole line', () => {
  const online = place([{ id: matcha.id, qty: 1, options: [LARGE, OAT] }], 179);
  const lineKey = `k${key().slice(0, 6)}`;
  const { order } = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '7',
    lines: [{ key: lineKey, item_id: matcha.id, qty: 1, options: [OAT, LARGE] }],
  }, cashier);
  assert.strictEqual(order.total, online.total, 'POS and online agree');
  assert.strictEqual(pos.view(order.id, cashier).lines[0].options_text, 'Size: Large · Add-ons: Oat milk');
  // The options are refused at the POS too.
  for (const bad of [[], [LARGE, SYRUP], [99999]]) {
    assert.ok(errorsOf(() => pos.save(null, {
      request_key: key(), type: 'dinein', table_no: '8', lines: [{ key: 'kx', item_id: matcha.id, qty: 1, options: bad }],
    }, cashier)).lines, JSON.stringify(bad));
  }
  // SC/PWD 20% (non-VAT) on 129 + 20 + 30 = 179: 35.80.
  const k2 = `k${key().slice(0, 6)}`;
  const sc = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '9', lines: [{ key: k2, item_id: matcha.id, qty: 1, options: [LARGE, OAT] }],
    discounts: { claimants: [{ type: 'sc', name: 'Lola Remedios', id_no: 'OSCA-55501234', mode: 'exclusive', lines: { [k2]: 1 } }] },
  }, cashier).order;
  assert.deepStrictEqual([sc.sc_pwd_discount, sc.total], [35.8, 179 - 35.8]);
  // Adding to the tab later keeps the line's price with its options.
  const v = pos.view(order.id, cashier);
  const more = pos.save(order.id, {
    request_key: key(), version: v.version, type: 'dinein', table_no: '7',
    lines: v.lines.map((l) => ({ id: l.id, key: l.key, item_id: l.item_id, qty: 2, note: '' })),
  }, cashier).order;
  assert.strictEqual(more.total, 179 * 2);
});

test('cards show the description and size; options ship with the card, escaped', () => {
  assert.ok(errorsOf(() => menu.update(matcha.id, { ...item('Matcha Frappe'), description: 'x'.repeat(121) })).description);
  assert.ok(errorsOf(() => menu.update(matcha.id, { ...item('Matcha Frappe'), size_label: 'x'.repeat(21) })).size_label);
  menu.update(matcha.id, { ...item('Matcha Frappe'), description: 'Creamy  iced matcha <b>latte</b>', size_label: '16 oz' });
  assert.deepStrictEqual([item('Matcha Frappe').description, item('Matcha Frappe').size_label], ['Creamy iced matcha <b>latte</b>', '16 oz']);
  // A form without the new fields keeps them (an older admin page).
  const { description, size_label, ...rest } = item('Matcha Frappe');
  menu.update(matcha.id, rest);
  assert.strictEqual(item('Matcha Frappe').size_label, '16 oz');

  const g = options.getGroup(SIZE.id);
  options.updateGroup(SIZE.id, { ...g, options: [...g.options, { name: '"><script>alert(1)</script>', price: 5 }] });
  const html = render.buildHtml();
  const card = html.split('<li class="card').find((c) => c.includes('data-name="Matcha Frappe"'));
  assert.match(card, /<p class="card__desc">Creamy iced matcha &lt;b&gt;latte&lt;\/b&gt;<\/p>/);
  assert.match(card, /<span class="card__size">16 oz<\/span>/);
  assert.match(card, /<span class="price__from">from <\/span><small>₱<\/small>129/, 'cheapest required choice');
  assert.ok(!card.includes('<script>'), 'option names are escaped');
  const data = JSON.parse(card.match(/data-options="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  assert.deepStrictEqual(data.groups.map((x) => x.name), ['Size', 'Add-ons']);
  // Items without options keep one-tap Add (no data-options).
  const plain = html.split('<li class="card').find((c) => c.includes('data-name="Biscoff Frappe"'));
  assert.ok(!plain.includes('data-options'));
  options.updateGroup(SIZE.id, g);
});

test('the option group endpoints need sign-in and CSRF', async () => {
  const email = 'options@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = (p, method, body, headers = {}) => fetch(`${url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    const group = { name: 'Sugar level', kind: 'single', options: [{ name: 'Less' }, { name: 'Normal' }] };
    assert.strictEqual((await call('/api/option-groups', 'GET')).status, 401);
    assert.strictEqual((await call('/api/option-groups', 'POST', group)).status, 401);
    assert.strictEqual((await call('/api/option-groups', 'POST', group, { Cookie: cookie })).status, 403, 'no CSRF');
    assert.strictEqual((await call(`/api/option-groups/${SIZE.id}`, 'DELETE', undefined, { Cookie: cookie })).status, 403);
    const admin = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const made = await call('/api/option-groups', 'POST', group, admin);
    assert.strictEqual(made.status, 201);
    const { group: g } = await made.json();
    assert.strictEqual((await call(`/api/option-groups/${g.id}`, 'PATCH', { ...group, options: [] }, admin)).status, 422);
    // Another group's option id cannot be moved in.
    assert.strictEqual((await call(`/api/option-groups/${g.id}`, 'PATCH',
      { ...group, options: [{ id: LARGE, name: 'Stolen', price: 0 }] }, admin)).status, 422);
    assert.strictEqual(options.getGroup(SIZE.id).options.find((o) => o.id === LARGE).name, 'Large');
    const items = await (await call('/api/items', 'GET', undefined, { Cookie: cookie })).json();
    assert.deepStrictEqual(items.items.find((i) => i.id === matcha.id).option_groups, [SIZE.id, ADDONS.id]);
    assert.strictEqual((await call(`/api/option-groups/${g.id}`, 'DELETE', undefined, admin)).status, 200);
    assert.strictEqual((await call(`/api/option-groups/${g.id}`, 'DELETE', undefined, admin)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports: sales by item stay by the item; options chosen are counted with what they added', () => {
  const reports = require('../server/reports');
  const day = require('../server/clock').manilaDate(new Date());
  const s = reports.summary({ from: day, to: day });
  // Online orders placed above are completed: every Matcha line, whatever its options, is one row.
  assert.strictEqual(s.by_item.filter((r) => r.item_id === matcha.id).length, 1);
  const large = s.by_option.find((r) => r.group === 'Size' && r.name === 'Large');
  assert.ok(large && large.qty >= 2 && large.amount === large.qty * 2000, JSON.stringify(large));
  assert.ok(s.by_option.some((r) => r.name === 'Extra shot'), 'a removed option still shows from the order copy');
});

test('the kitchen ticket and the order alert: options for the kitchen, counts only for the alert', () => {
  const lineKey = `k${key().slice(0, 6)}`;
  const saved = pos.save(null, {
    request_key: key(), type: 'dinein', table_no: '12', send: true,
    lines: [{ key: lineKey, item_id: matcha.id, qty: 2, options: [LARGE, OAT] }],
  }, cashier);
  assert.deepStrictEqual(saved.kitchen, [{ name: 'Matcha Frappe', qty: 2, note: '', options_text: 'Size: Large · Add-ons: Oat milk' }]);
  const o = place([{ id: matcha.id, qty: 2, options: [LARGE] }], 298);
  const msg = require('../server/push').orderMessage(orders.get(o.id));
  assert.strictEqual(msg.body, 'Dine-in · Table 4 · 2 items · ₱298');
  assert.ok(!JSON.stringify(msg).includes('Large'), 'what was chosen is not in the alert');
});
