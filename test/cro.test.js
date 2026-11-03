'use strict';
/* PR A, quick fixes on the customer menu: photo alt text and loading, item
   counts, the peso sign, the honeypot, optional delivery cash, the phone
   hint, the confirmation screen, the share image, the best sellers row and
   the receipt currency. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-cro-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { db, seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const orders = require('../server/orders');
const checkout = require('../server/checkout');
const settings = require('../server/settings');
const render = require('../server/render');
seedIfEmpty();
// Ordering follows the opening hours. Open all day, so no test depends on the clock.
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });

const ROOT = path.join(__dirname, '..');
const item = (name) => menu.list().find((i) => i.name === name);
const cardOf = (html, name) => html.split('<li class="card').find((c) => c.includes(`data-name="${name}"`));
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
const deliveryInput = (over = {}) => ({
  type: 'delivery', name: 'Ana Reyes', phone: '0917 123 4567', address: '12 Mabini St', landmark: 'green gate beside the store',
  items: [{ id: item('Matcha Frappe').id, qty: 1 }], expected_total: 129,
  checkout_token: checkout.issue(new Date(Date.now() - 10000)), ...over,
});

test('an item showing the logo has empty alt text; an own photo keeps its alt', () => {
  const html = render.buildHtml();
  const logoCard = cardOf(html, 'Matcha Frappe'); // seeded items show the logo
  assert.match(logoCard, /<img src="assets\/Sweeter%20Side%20-%20PNG\.png" alt=""/);

  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', 'icons', 'icon-192.png'), path.join(process.env.UPLOAD_DIR, 'photo.png'));
  const own = menu.create({ name: 'Brownie', price: 60, category_id: item('Matcha Frappe').category_id, image: 'assets/uploads/photo.png', alt: 'A fudgy brownie' });
  try {
    assert.match(cardOf(render.buildHtml(), 'Brownie'), /alt="A fudgy brownie"/);
  } finally {
    menu.remove(own.id);
  }
});

test('photos: width and height, async decoding, lazy loading after the first few', () => {
  const imgs = [...render.buildHtml().matchAll(/<img src="assets\/[^"]*"[^>]*>/g)].map((m) => m[0])
    .filter((tag) => !tag.includes('hero__logo'));
  assert.ok(imgs.length > 4);
  assert.ok(imgs.every((t) => /width="\d+" height="\d+"/.test(t) && t.includes('decoding="async"')), 'all have a size');
  assert.ok(imgs.slice(0, 4).every((t) => !t.includes('loading="lazy"')), 'the first four load at once');
  assert.ok(imgs.slice(4).every((t) => t.includes('loading="lazy"')), 'the rest load as you scroll');
});

test('item counts say "1 item" and "N items"', () => {
  const cat = db.prepare("INSERT INTO categories (slug, name, label, position) VALUES ('solo', 'Solo', 'Solo', 9)").run().lastInsertRowid;
  const one = menu.create({ name: 'Only One', price: 50, category_id: Number(cat), image: '', alt: '' });
  try {
    const html = render.buildHtml();
    assert.match(html, /<section class="section" id="solo"[\s\S]*?data-count>1 item<\/span>/);
    assert.match(html, /data-count>6 items<\/span>/);
    assert.ok(!/\b1 items\b/.test(html));
  } finally {
    menu.remove(one.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat);
  }
});

test('prices show the peso sign, not "Php"', () => {
  const html = render.buildHtml();
  assert.match(cardOf(html, 'Matcha Frappe'), /<span class="price"><small>₱<\/small>129<\/span>/);
  assert.ok(!html.includes('Php'), 'no "Php" anywhere on the customer menu');
  assert.ok(!render.buildCakesHtml().includes('Php') && !render.buildAboutHtml().includes('Php'));
});

test('the honeypot is hidden from sight and from screen readers, and its label is inside', () => {
  const html = render.buildHtml();
  const hp = html.match(/<div class="hp"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.match(hp, /^<div class="hp" aria-hidden="true">/);
  assert.match(hp, /<label for="o-website">/);
  assert.match(hp, /<input id="o-website" name="website" type="text" tabindex="-1" autocomplete="off">/);
});

test('delivery cash is optional: blank means the exact amount and no change', () => {
  const order = orders.create(deliveryInput({ cash: '' }));
  assert.deepStrictEqual([order.cash, order.change_due, order.total], [129, 0, 129]);
  const withCash = orders.create(deliveryInput({ cash: 200, phone: '0917 123 4568' }));
  assert.deepStrictEqual([withCash.cash, withCash.change_due], [200, 71]);
  assert.match(errorsOf(() => orders.create(deliveryInput({ cash: 100, phone: '0917 123 4569' }))).cash, /₱129/);
  assert.ok(errorsOf(() => orders.create(deliveryInput({ cash: 'abc', phone: '0917 123 4569' }))).cash);
  const html = render.buildHtml();
  assert.match(html, /<input id="o-cash"[^>]*placeholder="Exact amount"[^>]*>/);
  assert.ok(!/<input id="o-cash"[^>]*required/.test(html), 'not required');
  assert.ok(html.includes('<button class="cfield__exact" type="button" id="o-exact">Exact amount</button>'));
});

test('the phone field has the example and a hint tied to it', () => {
  const html = render.buildHtml();
  assert.match(html, /<input id="o-phone"[^>]*placeholder="0917 123 4567"[^>]*aria-describedby="o-phone-hint"/);
  assert.match(html, /<p class="cfield__hint cfield__hint--below" id="o-phone-hint">[^<]+<\/p>/);
});

test('the confirmation screen: call-back minutes, tap to call, and the Facebook link from Settings', () => {
  let html = render.buildHtml();
  assert.match(html, /data-call-minutes="5"/, 'default 5 minutes');
  assert.match(html, /<a class="done__link" id="done-tel" href="tel:\+639327620367">Call 0932 762 0367<\/a>/);
  assert.match(html, /id="done-fb" href="https:\/\/www\.facebook\.com\/SweeterSideByDachel"/);
  for (const id of ['done-when', 'done-lines', 'done-call']) assert.ok(html.includes(`id="${id}"`), id);

  orders.updateSettings({ confirm_call_minutes: 10, facebook_url: 'https://m.me/SweeterSideByDachel' });
  try {
    html = render.buildHtml();
    assert.match(html, /data-call-minutes="10"/);
    assert.match(html, /id="done-fb" href="https:\/\/m\.me\/SweeterSideByDachel"/);
    assert.ok(render.buildAboutHtml().includes('https://m.me/SweeterSideByDachel'), 'the same link everywhere');
  } finally {
    orders.updateSettings({ confirm_call_minutes: 5, facebook_url: '' });
  }
  assert.ok(errorsOf(() => orders.updateSettings({ confirm_call_minutes: 0 })).confirm_call_minutes);
  for (const bad of ['javascript:alert(1)', 'http://www.facebook.com/x', 'https://evil.example/x', 'https://facebook.com.evil.example/x', 'not a url']) {
    assert.ok(errorsOf(() => orders.updateSettings({ facebook_url: bad })).facebook_url, bad);
  }
  assert.strictEqual(orders.facebookUrl(), 'https://www.facebook.com/SweeterSideByDachel', 'blank goes back to the default');
});

test('share image: only an uploaded photo, with size tags and the large card; the logo otherwise', () => {
  let html = render.buildHtml();
  assert.match(html, /<meta property="og:image" content="https:\/\/sweeterside\.ph\/assets\/Sweeter%20Side%20-%20PNG\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);

  for (const bad of ['assets/Meals.jpg', 'assets/uploads/missing.png', '../server/db.js', 'https://evil.example/x.png']) {
    assert.ok(errorsOf(() => orders.updateSettings({ share_image: bad })).share_image, bad);
  }
  fs.copyFileSync(path.join(ROOT, 'assets', 'icons', 'icon-512.png'), path.join(process.env.UPLOAD_DIR, 'share.png'));
  orders.updateSettings({ share_image: 'assets/uploads/share.png' });
  try {
    html = render.buildHtml();
    assert.match(html, /<meta property="og:image" content="https:\/\/sweeterside\.ph\/assets\/uploads\/share\.png">/);
    assert.match(html, /<meta property="og:image:width" content="512">\s*<meta property="og:image:height" content="512">/);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  } finally {
    orders.updateSettings({ share_image: '' });
  }
});

test('best sellers: a row at the top, sold-out ones left out, none when there are none, and in index.html', () => {
  assert.ok(!render.buildHtml().includes('id="best-sellers"'), 'no row without best sellers');
  const matcha = item('Matcha Frappe');
  const biscoff = item('Biscoff Frappe');
  db.prepare('UPDATE items SET best_seller = 1 WHERE id IN (?, ?)').run(matcha.id, biscoff.id);
  db.prepare("UPDATE items SET availability = 'sold_out' WHERE id = ?").run(biscoff.id);
  try {
    const html = render.buildHtml();
    const row = html.match(/<section class="best" id="best-sellers"[\s\S]*?<\/section>/)[0];
    assert.ok(row.includes('data-best-row'), 'menu.js hides it while filtering');
    assert.ok(row.includes('data-name="Matcha Frappe"') && !row.includes('data-name="Biscoff Frappe"'));
    assert.ok(row.includes('1 item'));
    assert.ok(html.indexOf('id="best-sellers"') < html.indexOf('<section class="section"'), 'first on the menu');
    render.writeStatic();
    assert.ok(fs.readFileSync(render.OUTPUT, 'utf8').includes('id="best-sellers"'), 'also in the static index.html');
  } finally {
    db.prepare("UPDATE items SET best_seller = 0, availability = 'available' WHERE id IN (?, ?)").run(matcha.id, biscoff.id);
    render.writeStatic();
  }
});

test('receipts can print ₱ or PHP; nothing else is accepted', () => {
  assert.strictEqual(settings.receiptSettings().receipt_currency, '₱', 'default ₱');
  assert.strictEqual(settings.updateReceiptSettings({ receipt_currency: 'PHP' }).receipt_currency, 'PHP');
  assert.ok(errorsOf(() => settings.updateReceiptSettings({ receipt_currency: '$' })).receipt_currency);
  settings.updateReceiptSettings({ receipt_currency: '₱' });
});

test('the admin pages show ₱, have the new Settings sections and the menu health panel', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'admin')).filter((n) => /\.(html|js)$/.test(n))) {
    assert.ok(!fs.readFileSync(path.join(ROOT, 'admin', f), 'utf8').includes('Php'), `${f} has no "Php"`);
  }
  const settingsPage = fs.readFileSync(path.join(ROOT, 'admin', 'settings.html'), 'utf8');
  for (const id of ['confirm-form', 'call-minutes', 'facebook-url', 'share-file', 'share-preview']) assert.ok(settingsPage.includes(`id="${id}"`), id);
  assert.ok(fs.readFileSync(path.join(ROOT, 'admin', 'items.html'), 'utf8').includes('id="health"'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'admin', 'staff.html'), 'utf8').includes('id="r-currency"'));
});
