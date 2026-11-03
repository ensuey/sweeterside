'use strict';
/* PR F, the custom cakes page and social proof: a gallery of past cakes,
   sizes with starting prices and flavour extras, an estimate, the booking
   info, and testimonials the owner enters. All visible without JavaScript.
   Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-cakespage-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { seedIfEmpty } = require('../server/db');
const cakes = require('../server/cakes');
const gallery = require('../server/gallery');
const testimonials = require('../server/testimonials');
const render = require('../server/render');
const auth = require('../server/auth');
seedIfEmpty();

const ROOT = path.join(__dirname, '..');
const errorsOf = (fn) => { try { fn(); return null; } catch (e) { return e.errors || e; } };
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icons', 'icon-192.png'), path.join(process.env.UPLOAD_DIR, 'cake1.png'));
fs.copyFileSync(path.join(ROOT, 'assets', 'icons', 'icon-192.png'), path.join(process.env.UPLOAD_DIR, 'cake2.png'));

test('gallery photos must be uploads that exist; captions are checked', () => {
  for (const bad of ['', 'assets/Menu Frappe.jpg', 'assets/uploads/missing.png', 'assets/uploads/../../server/db.js',
    '/etc/passwd', 'https://example.com/x.png']) {
    assert.ok(errorsOf(() => gallery.add({ image: bad })).image, `refuse ${bad}`);
  }
  assert.ok(errorsOf(() => gallery.add({ image: 'assets/uploads/cake1.png', caption: 'x'.repeat(121) })).caption);
  const list = gallery.add({ image: 'assets/uploads/cake1.png', caption: '  Ube   2-tier  ' });
  assert.deepStrictEqual(list.map((p) => [p.image, p.caption]), [['assets/uploads/cake1.png', 'Ube 2-tier']]);
  gallery.add({ image: 'assets/uploads/cake2.png', caption: '<b>Mocha</b>' });
  const ids = gallery.list().map((p) => p.id);
  assert.deepStrictEqual(gallery.reorder([ids[1], ids[0]]).map((p) => p.image), ['assets/uploads/cake2.png', 'assets/uploads/cake1.png']);
  assert.strictEqual(gallery.update(9999, { caption: 'x' }), null);
});

test('flavour extras and the estimate', () => {
  assert.match(errorsOf(() => cakes.updateSettings({ flavours: 'Ube | lots' })).flavours, /whole number/);
  assert.match(errorsOf(() => cakes.updateSettings({ flavours: 'Ube | -5' })).flavours, /whole number/);
  const s = cakes.updateSettings({
    sizes: '6" round | 850\n8" round | 1,200',
    flavours: 'Chocolate\nUbe | 100\nRed velvet | ₱150\nchocolate | 50',
  });
  assert.deepStrictEqual(s.flavours, ['Chocolate', 'Ube', 'Red velvet'], 'a repeat is left out');
  assert.deepStrictEqual(s.flavour_prices, { Ube: 100, 'Red velvet': 150 });
  assert.strictEqual(cakes.estimate('8" round', 'Ube'), 1300);
  assert.strictEqual(cakes.estimate('6" round', 'Chocolate'), 850);
  assert.strictEqual(cakes.estimate('6" round', cakes.OTHER_FLAVOUR), 850);
  assert.strictEqual(cakes.estimate('Huge', 'Ube'), null);

  // A booking keeps the estimate it was made with.
  const day = cakes.availability().earliest;
  const b = cakes.create({
    name: 'Ana Reyes', phone: '0917 123 4567', size: '8" round', flavour: 'Ube', needed_on: day, handover: 'pickup',
  });
  assert.strictEqual(b.estimate_from, 1300);
  // The form carries the prices for the estimate shown as the customer picks.
  const html = render.buildCakesHtml();
  assert.match(html, /value="8&quot; round" data-price="1200"/);
  assert.match(html, /<option value="Ube" data-extra="100">Ube \(\+₱100\)<\/option>/);
  assert.match(html, /<p class="cake-estimate" id="k-estimate" aria-live="polite" hidden><\/p>/);
});

test('/cakes without JavaScript: gallery, prices, booking info and how to order', () => {
  cakes.updateSettings({ lead_days: 3, deposit_text: '', handover_text: 'Pick up at the market <stall 4>.' });
  const html = render.buildCakesHtml();
  // Plain HTML, before the form, which stays hidden until cakes.js shows it.
  const before = html.slice(0, html.indexOf('<form class="cake-form"'));
  assert.match(before, /<h2 class="cakes__h2" id="gallery-title">Cakes we have made<\/h2>/);
  assert.match(before, /<img src="\/assets\/uploads\/cake2\.png" alt="&lt;b&gt;Mocha&lt;\/b&gt;" width="192" height="192" decoding="async">/);
  assert.match(before, /<figcaption>Ube 2-tier<\/figcaption>/);
  assert.match(before, /<tr><th scope="row">8&quot; round<\/th><td>from ₱1,200<\/td><\/tr>/);
  assert.match(before, /Some flavours cost a little more: Ube \+₱100, Red velvet \+₱150\./);
  assert.match(before, /Book at least 3 days ahead\. The earliest day you can book now is /);
  assert.match(before, new RegExp(cakes.INFO_DEFAULTS.deposit_text.slice(0, 40)), 'blank goes back to the default');
  assert.match(before, /Pick up at the market &lt;stall 4&gt;\./);
  assert.match(before, /<a class="cakes__link" href="tel:\+639327620367">Call 0932 762 0367<\/a>/);
  assert.match(before, /<a class="cakes__link" href="https:\/\/[^"]*facebook[^"]*" rel="noopener" target="_blank">Message us on Facebook<\/a>/);
  assert.match(html, /<form class="cake-form" id="cake-form" novalidate hidden>/);
  assert.ok(!/<script>/.test(html) && !/ on\w+="/.test(html), 'no inline scripts or handlers');
  assert.ok(errorsOf(() => cakes.updateSettings({ deposit_text: 'x'.repeat(401) })).deposit_text);
});

test('testimonials: shown only while on, escaped, never review structured data', () => {
  assert.ok(!render.buildHtml().includes('class="reviews"'), 'nothing to show: no section at all');
  assert.ok(errorsOf(() => testimonials.create({ quote: '', name: 'A' })).quote);
  assert.ok(errorsOf(() => testimonials.create({ quote: 'Nice', name: '' })).name);
  assert.ok(errorsOf(() => testimonials.create({ quote: 'Nice', name: 'A', source: 'Yelp' })).source);
  assert.ok(errorsOf(() => testimonials.create({ quote: 'x'.repeat(301), name: 'A' })).quote);
  testimonials.create({ quote: 'Best ube cake <script>alert(1)</script>', name: 'M. R.', source: 'Facebook' });
  const off = testimonials.create({ quote: 'Hidden one', name: 'J. D.', active: false })[1];

  for (const html of [render.buildHtml(), render.buildCakesHtml()]) {
    assert.match(html, /<h2 class="reviews__title" id="reviews-title">What customers say<\/h2>/);
    assert.match(html, /<blockquote><p>Best ube cake &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p><\/blockquote>/);
    assert.match(html, /<figcaption>M\. R\. <span class="reviews__source">· Facebook<\/span><\/figcaption>/);
    assert.ok(!html.includes('Hidden one'), 'switched off: not shown');
    assert.ok(!html.includes('reviews__rating'), 'no rating line until it is filled in');
    assert.ok(!/"@type":\s*"(Review|AggregateRating)"/.test(html), 'no review structured data');
  }
  // The menu shows it above Visit us.
  const menu = render.buildHtml();
  assert.ok(menu.indexOf('class="reviews"') < menu.indexOf('class="visit"'));

  testimonials.setRatingLine('  4.9★ on Facebook,  120 reviews ');
  assert.match(render.buildHtml(), /<p class="reviews__rating">4\.9★ on Facebook, 120 reviews<\/p>/);
  assert.ok(errorsOf(() => testimonials.setRatingLine('x'.repeat(81))).rating_line);
  testimonials.update(off.id, { ...off, active: true });
  assert.ok(render.buildHtml().includes('Hidden one'), 'switched on: shown');
});

test('the gallery and testimonial endpoints need sign-in and CSRF', async () => {
  const email = 'cakespage@example.com';
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
    for (const [p, body] of [['/api/cake-gallery', { image: 'assets/uploads/cake1.png' }], ['/api/testimonials', { quote: 'Hi', name: 'A' }]]) {
      assert.strictEqual((await call(p, 'GET')).status, 401, p);
      assert.strictEqual((await call(p, 'POST', body)).status, 401, p);
      assert.strictEqual((await call(p, 'POST', body, { Cookie: cookie })).status, 403, `${p} without CSRF`);
    }
    assert.strictEqual((await call('/api/testimonials/rating', 'PUT', { rating_line: 'x' }, { Cookie: cookie })).status, 403);
    const admin = { Cookie: cookie, 'X-CSRF-Token': csrf };
    assert.strictEqual((await call('/api/cake-gallery', 'POST', { image: 'assets/uploads/../../package.json' }, admin)).status, 422);
    const added = await call('/api/testimonials', 'POST', { quote: 'Lovely', name: 'K.' }, admin);
    assert.strictEqual(added.status, 201);
    const id = (await added.json()).testimonials.at(-1).id;
    assert.strictEqual((await call(`/api/testimonials/${id}`, 'DELETE', undefined, admin)).status, 200);
    assert.strictEqual((await call(`/api/testimonials/${id}`, 'DELETE', undefined, admin)).status, 404);
    // The cake page itself is public and renders without a session.
    const page = await fetch(`${url}/cakes`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Sizes and starting prices/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Bug: the hidden photo input on /cakes was 1,500 px wide, because a field
// rule (.cfield input { width: 100% }) beat .vh, so the page scrolled sideways.
test('visually hidden inputs stay 1 px whatever the field rules say', () => {
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'styles.css'), 'utf8');
  const vh = css.match(/.vh {([^}]*)}/)[1];
  assert.match(vh, /width: 1px !important/);
  assert.match(vh, /height: 1px !important/);
  assert.match(render.buildCakesHtml(), /<input id="k-photo" class="vh"/);
});
