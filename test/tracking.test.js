'use strict';
/* Tracking (Meta Pixel, Google Analytics, Google Ads, Microsoft Clarity):
   each is off until the owner saves its ID, then loaded on the customer pages
   only, after consent. The CSP opens up for the tools that are on, on those
   pages and nowhere else. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-tracking-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty, ROOT } = require('../server/db');
const auth = require('../server/auth');
const orders = require('../server/orders');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });
const { server } = require('../server/index');

const IDS = {
  meta_pixel_id: '300448864172496',
  ga4_id: 'G-AB12CD34EF',
  gads_id: 'AW-123456789',
  gads_purchase_label: 'AbC-dEf_123',
  gads_lead_label: 'LeAd_456',
  clarity_id: 'abc123xyz9',
};
const OFF = Object.fromEntries(Object.keys(IDS).map((k) => [k, '']));
const PAGES = ['/', '/cakes', '/about'];

const email = 'tracking@example.com';
auth.createUser(email, 'a-long-enough-password');
const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
const cookie = `${auth.SESSION_COOKIE}=${token}`;

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const put = (url, body, headers) => fetch(`${url}/api/settings`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

// Any tracking origin. (fonts.googleapis.com is in the strict CSP already.)
const OUTSIDE = /facebook|googletagmanager|google-analytics|analytics\.google|doubleclick|googleadservices|googlesyndication|www\.google\.com|clarity|bing/;
const GOOGLE = /googletagmanager|google-analytics|doubleclick|googleadservices|www\.google\.com/;

const directive = (csp, name) => (csp.split('; ').find((d) => d.startsWith(`${name} `)) || '');

test('tracking is off by default: no tag and the strict CSP on every customer page', async () => {
  orders.updateSettings(OFF);
  await withServer(async (url) => {
    for (const page of PAGES) {
      const res = await fetch(url + page);
      const html = await res.text();
      assert.ok(!html.includes('ss-tracking') && !html.includes('tracking.js'), `${page}: no tracking`);
      const csp = res.headers.get('content-security-policy');
      assert.match(directive(csp, 'script-src'), /^script-src 'self'$/, `${page}: strict CSP`);
      assert.ok(!OUTSIDE.test(csp), `${page}: no outside origins`);
    }
  });
});

test('each tracking ID must match its format; blank turns it off', () => {
  const bad = (key, v) => assert.throws(() => orders.updateSettings({ [key]: v }), (e) => !!e.errors[key], `${key}: ${v}`);
  bad('meta_pixel_id', 'abc');
  bad('meta_pixel_id', '12345');
  bad('meta_pixel_id', '300448864172496"><script>alert(1)</script>');
  bad('ga4_id', 'UA-12345-1');
  bad('ga4_id', 'G-AB12"><b>');
  bad('gads_id', 'AW-abc');
  bad('gads_id', "AW-123456789; script-src 'unsafe-inline'");
  bad('gads_purchase_label', 'has space');
  bad('gads_purchase_label', 'a/b"c');
  bad('clarity_id', 'abc 123');
  bad('clarity_id', 'https://www.clarity.ms/tag/abc');
  // Case is fixed for the user.
  const s = orders.updateSettings({ ga4_id: ' g-ab12cd34ef ', gads_id: 'aw-123456789', clarity_id: 'ABC123XYZ9' });
  assert.deepStrictEqual([s.ga4_id, s.gads_id, s.clarity_id], ['G-AB12CD34EF', 'AW-123456789', 'abc123xyz9']);
  // A label is only used together with the Ads ID.
  const labels = orders.updateSettings({ gads_id: '', gads_purchase_label: 'AbC-dEf_123' });
  assert.strictEqual(labels.gads_purchase_label, '');
  orders.updateSettings(IDS);
  orders.updateSettings(OFF);
  assert.deepStrictEqual(orders.tracking(), OFF, 'blank turns every tool off');
});

test('the tracking IDs are saved through the admin API, which needs the session and CSRF', async () => {
  orders.updateSettings(OFF);
  await withServer(async (url) => {
    assert.strictEqual((await put(url, IDS, {})).status, 401, 'signed out');
    assert.strictEqual((await put(url, IDS, { Cookie: cookie })).status, 403, 'no CSRF token');
    assert.deepStrictEqual(orders.tracking(), OFF, 'nothing saved without both');
    const bad = await put(url, { ...IDS, ga4_id: '<b>' }, { Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.strictEqual(bad.status, 422);
    assert.deepStrictEqual(orders.tracking(), OFF, 'one bad ID saves none');
    const res = await put(url, IDS, { Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.strictEqual(res.status, 200);
    const s = await res.json();
    for (const [k, v] of Object.entries(IDS)) assert.strictEqual(s[k], v, k);
    const page = await (await fetch(`${url}/admin/settings`, { headers: { Cookie: cookie } })).text();
    assert.ok(page.includes('id="tracking-form"'), 'the Settings page has the Tracking form');
  });
  orders.updateSettings(OFF);
});

test('with every ID set the customer pages load tracking.js and allow only those tools in the CSP', async () => {
  orders.updateSettings(IDS);
  try {
    await withServer(async (url) => {
      for (const page of PAGES) {
        const res = await fetch(url + page);
        const html = await res.text();
        const tag = html.match(/<meta name="ss-tracking"[^>]*>/);
        assert.ok(tag, `${page}: the tag`);
        for (const [attr, v] of [['meta', IDS.meta_pixel_id], ['ga4', IDS.ga4_id], ['gads', IDS.gads_id],
          ['gads-purchase', IDS.gads_purchase_label], ['gads-lead', IDS.gads_lead_label], ['clarity', IDS.clarity_id]]) {
          assert.ok(tag[0].includes(` data-${attr}="${v}"`), `${page}: ${attr}`);
        }
        assert.ok(html.includes('<script src="/assets/js/tracking.js" defer></script>'), `${page}: the loader`);
        assert.ok(!/<script>[^<]*(fbq|gtag|clarity)/.test(html), `${page}: no inline snippet`);

        const csp = res.headers.get('content-security-policy');
        const script = directive(csp, 'script-src');
        for (const o of ['https://connect.facebook.net', 'https://www.googletagmanager.com', 'https://www.googleadservices.com', 'https://www.clarity.ms']) {
          assert.ok(script.includes(o), `${page}: script-src ${o}`);
        }
        assert.ok(directive(csp, 'connect-src').includes('https://*.google-analytics.com'), `${page}: GA connect`);
        assert.ok(directive(csp, 'connect-src').includes('https://*.clarity.ms'), `${page}: Clarity connect`);
        assert.ok(directive(csp, 'frame-src').includes('https://td.doubleclick.net'), `${page}: Ads frame`);
        assert.ok(!csp.includes('unsafe-eval') && !script.includes('unsafe-inline'), `${page}: no inline or eval`);
        assert.ok(!/(^| )(\*|https:|http:)( |$)/.test(script.replace(/^script-src /, '')), `${page}: no wildcard source`);
        assert.match(csp, /frame-ancestors 'none'/);
      }

      // Admin, POS and API responses keep the strict CSP.
      for (const page of ['/admin/settings', '/admin/pos', '/admin/login']) {
        const res = await fetch(url + page, { headers: { Cookie: cookie } });
        assert.ok(!OUTSIDE.test(res.headers.get('content-security-policy')), `${page}: strict CSP`);
        assert.ok(!(await res.text()).includes('tracking.js'), `${page}: no tracking`);
      }
      const api = await fetch(`${url}/api/settings`, { headers: { Cookie: cookie } });
      assert.ok(!OUTSIDE.test(api.headers.get('content-security-policy')), 'API: strict CSP');

      const js = await fetch(`${url}/assets/js/tracking.js`);
      assert.strictEqual(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/);
    });
  } finally {
    orders.updateSettings(OFF);
  }
});

test('the CSP adds only the origins of the tools that are on', async () => {
  const cspFor = async (ids) => {
    orders.updateSettings({ ...OFF, ...ids });
    let csp;
    await withServer(async (url) => { csp = (await fetch(url)).headers.get('content-security-policy'); });
    return csp;
  };
  try {
    const clarity = await cspFor({ clarity_id: IDS.clarity_id });
    assert.ok(clarity.includes('clarity.ms') && !/facebook/.test(clarity) && !GOOGLE.test(clarity), 'Clarity only');
    const ga = await cspFor({ ga4_id: IDS.ga4_id });
    assert.ok(ga.includes('googletagmanager.com') && !/facebook|clarity|doubleclick|frame-src/.test(ga), 'Analytics only');
    const meta = await cspFor({ meta_pixel_id: IDS.meta_pixel_id });
    assert.ok(meta.includes('connect.facebook.net') && !/clarity/.test(meta) && !GOOGLE.test(meta), 'Meta only');
  } finally {
    orders.updateSettings(OFF);
  }
});

test('Clarity is told to hide the cart, the checkout and the cake form', async () => {
  orders.updateSettings({ ...OFF, clarity_id: IDS.clarity_id });
  try {
    await withServer(async (url) => {
      const menuHtml = await (await fetch(url)).text();
      assert.match(menuHtml, /<dialog class="sheet cart" id="cart"[^>]*data-clarity-mask="true"/, 'the cart, checkout and order-done screen');
      const cakes = await (await fetch(`${url}/cakes`)).text();
      assert.match(cakes, /<form class="cake-form" id="cake-form"[^>]*data-clarity-mask="true"/, 'the cake form');
      assert.match(cakes, /<section class="cake-done" id="cake-done"[^>]*data-clarity-mask="true"/, 'the cake request number');
    });
  } finally {
    orders.updateSettings(OFF);
  }
});

test('tracking.js loads the tools only after consent and builds the banner without innerHTML', () => {
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'tracking.js'), 'utf8');
  assert.ok(!/innerHTML|eval\(|new Function|document\.write/.test(js), 'DOM APIs only');
  // Scripts are added only by the loaders, which only load() calls, which runs only on "yes".
  assert.strictEqual(js.split('addScript(').length - 1, 4, 'one definition, three loaders');
  const load = js.slice(js.indexOf('  function load()'), js.indexOf('  function revoke()'));
  for (const fn of ['loadMeta()', 'loadGoogle()', 'loadClarity()']) assert.ok(load.includes(fn), fn);
  assert.strictEqual(js.split('load();').length - 1, 2, 'load() is called in two places');
  assert.match(js, /if \(consent === 'yes'\) load\(\);/);
  assert.match(js, /if \(value === 'yes'\) load\(\);/);
  assert.match(js, /if \(!loaded \|\| readConsent\(\) !== 'yes' \|\| !SEND\[name\]\) return;/, 'events need consent');
  // No advanced matching or enhanced conversions: nothing about the customer.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // (The banner text says "never your name, phone or address", so match fields, not words.)
  assert.ok(!/(?<!ad_)user_data|enhanced|\b(em|ph|fn|ln|zp|ct|db):|external_id|email|phone_number|street/.test(code), 'no customer data');
});

test('the consent bar is one short line, with every tool named behind Details', () => {
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'tracking.js'), 'utf8');
  const short = js.match(/var SHORT_TEXT = '([^']*)';/);
  assert.ok(short && short[1].length <= 80, 'a short line');
  assert.match(js, /el\('button', 'consent__link', 'Details'\)/);
  assert.match(js, /el\('p', 'consent__details', bannerText\(\)\)/, 'the details name the tools');
  assert.match(js, /details\.hidden = true;/, 'folded at first');
  assert.match(js, /more\.setAttribute\('aria-expanded'/);
  // Both answers are equally easy: two buttons side by side.
  assert.match(js, /el\('button', 'consent__btn consent__btn--quiet', 'No'\)/);
  assert.match(js, /el\('button', 'consent__btn', 'Accept'\)/);
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'styles.css'), 'utf8');
  assert.match(css, /body\.cart-open-bar \.consent \{ bottom:/, 'kept clear of the cart bar');
  // Two columns on every screen: text left, buttons right, never wrapped below.
  assert.match(css, /\.consent__row \{[^}]*display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.ok(!/\.consent__row \{[^}]*flex-wrap/.test(css), 'the buttons never drop below the text');
  assert.match(js, /copy\.appendChild\(details\);/, 'the details stay in the left column');
});

test('the cart and cake events send ids, quantities and totals, never personal data', () => {
  const cart = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'cart.js'), 'utf8');
  const cakes = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'cakes.js'), 'utf8');
  const calls = [...cart.matchAll(/track\('(\w+)', \{([\s\S]*?)\}\);/g)];
  assert.deepStrictEqual(calls.map((m) => m[1]).sort(), ['add_to_cart', 'begin_checkout', 'purchase']);
  const cakeCall = cakes.match(/ssTrack\('lead', \{([^}]*)\}\)/);
  assert.ok(cakeCall, 'a cake request is a lead');
  for (const body of [...calls.map((m) => m[2]), cakeCall[1]]) {
    assert.ok(!/name|phone|address|email|table_no|notes|cash/.test(body), body);
  }
  // The purchase value is the server's total for the order that was placed.
  assert.match(cart, /track\('purchase', \{\s*id: 'order-' \+ order\.id,\s*value: order\.total,/);
});
