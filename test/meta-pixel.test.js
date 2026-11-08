'use strict';
/* The Meta Pixel: off until the owner saves a Pixel ID, then loaded on the
   customer pages only, after consent. The CSP opens up for Meta on those
   pages and nowhere else. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-pixel-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty, ROOT } = require('../server/db');
const auth = require('../server/auth');
const orders = require('../server/orders');
seedIfEmpty();
orders.updateSettings({ open_at: '00:00', close_at: '24:00' });
const { server } = require('../server/index');

const PIXEL_ID = '300448864172496';
const PAGES = ['/', '/cakes', '/about'];

const email = 'pixel@example.com';
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

test('the pixel is off by default: no tag and the strict CSP on every customer page', async () => {
  orders.updateSettings({ meta_pixel_id: '' });
  await withServer(async (url) => {
    for (const page of PAGES) {
      const res = await fetch(url + page);
      const html = await res.text();
      assert.ok(!html.includes('meta-pixel') && !html.includes('pixel.js'), `${page}: no pixel`);
      assert.ok(!res.headers.get('content-security-policy').includes('facebook'), `${page}: strict CSP`);
    }
  });
});

test('only a Pixel ID made of digits is saved; blank turns it off', () => {
  const bad = (v) => assert.throws(() => orders.updateSettings({ meta_pixel_id: v }), (e) => !!e.errors.meta_pixel_id, String(v));
  bad('abc');
  bad('12345'); // too short
  bad('123456789012345678901'); // too long
  bad('300448864172496"><script>alert(1)</script>');
  bad("300448864172496; script-src 'unsafe-inline'");
  bad('3004 4886 4172 496');
  assert.strictEqual(orders.updateSettings({ meta_pixel_id: ` ${PIXEL_ID} ` }).meta_pixel_id, PIXEL_ID, 'trimmed');
  assert.strictEqual(orders.updateSettings({ meta_pixel_id: '' }).meta_pixel_id, '');
});

test('the Pixel ID is saved through the admin API, which needs the session and CSRF', async () => {
  orders.updateSettings({ meta_pixel_id: '' });
  await withServer(async (url) => {
    assert.strictEqual((await put(url, { meta_pixel_id: PIXEL_ID }, {})).status, 401, 'signed out');
    assert.strictEqual((await put(url, { meta_pixel_id: PIXEL_ID }, { Cookie: cookie })).status, 403, 'no CSRF token');
    assert.strictEqual(orders.metaPixelId(), '', 'nothing saved without both');
    const bad = await put(url, { meta_pixel_id: '<b>1</b>' }, { Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.strictEqual(bad.status, 422);
    const res = await put(url, { meta_pixel_id: PIXEL_ID }, { Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).meta_pixel_id, PIXEL_ID);
    const page = await (await fetch(`${url}/admin/settings`, { headers: { Cookie: cookie } })).text();
    assert.ok(page.includes('id="pixel-form"'), 'the Settings page has the Pixel ID form');
  });
  orders.updateSettings({ meta_pixel_id: '' });
});

test('with a Pixel ID the customer pages load pixel.js and allow only Meta in the CSP', async () => {
  orders.updateSettings({ meta_pixel_id: PIXEL_ID });
  try {
    await withServer(async (url) => {
      for (const page of PAGES) {
        const res = await fetch(url + page);
        const html = await res.text();
        assert.ok(html.includes(`<meta name="meta-pixel" content="${PIXEL_ID}">`), `${page}: the ID`);
        assert.ok(html.includes('<script src="/assets/js/pixel.js" defer></script>'), `${page}: the loader`);
        assert.ok(!/<script>[^<]*fbq/.test(html) && !html.includes('connect.facebook.net'), `${page}: no inline snippet`);

        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net(;|$)/, `${page}: script-src`);
        assert.match(csp, /img-src 'self' data: https:\/\/www\.facebook\.com(;|$)/, `${page}: img-src`);
        assert.match(csp, /connect-src 'self' https:\/\/www\.facebook\.com(;|$)/, `${page}: connect-src`);
        assert.ok(!csp.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(csp), `${page}: no inline or eval`);
        assert.match(csp, /frame-ancestors 'none'/);
      }

      // Admin, POS and API responses keep the strict CSP.
      for (const page of ['/admin/settings', '/admin/pos', '/admin/login']) {
        const res = await fetch(url + page, { headers: { Cookie: cookie } });
        const csp = res.headers.get('content-security-policy');
        assert.ok(!csp.includes('facebook'), `${page}: strict CSP`);
        assert.ok(!(await res.text()).includes('pixel.js'), `${page}: no pixel`);
      }
      const api = await fetch(`${url}/api/settings`, { headers: { Cookie: cookie } });
      assert.ok(!api.headers.get('content-security-policy').includes('facebook'), 'API: strict CSP');

      const js = await fetch(`${url}/assets/js/pixel.js`);
      assert.strictEqual(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/);
    });
  } finally {
    orders.updateSettings({ meta_pixel_id: '' });
  }
});

test('pixel.js loads Meta only after consent and builds the banner without innerHTML', () => {
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pixel.js'), 'utf8');
  assert.ok(!/innerHTML|eval\(|new Function|document\.write/.test(js), 'DOM APIs only');
  // The one place Meta's script is added is load(), which runs only on "yes".
  const load = js.slice(js.indexOf('function load()'), js.indexOf('function el('));
  assert.ok(load.includes('script.src = SCRIPT_URL'), 'load() adds the script');
  assert.strictEqual(js.split('SCRIPT_URL').length - 1, 2, 'declared once, used once');
  assert.match(js, /if \(consent === 'yes'\) load\(\);/);
  assert.match(js, /if \(value === 'yes'\) load\(\);/);
  assert.match(js, /if \(!loaded \|\| readConsent\(\) !== 'yes'\) return;/, 'events need consent');
  assert.ok(!/advanced|em:|ph:|fn:|ln:|external_id/.test(js), 'no advanced matching');
});

test('the cart and cake events send ids, quantities and totals, never personal data', () => {
  const cart = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'cart.js'), 'utf8');
  const cakes = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'cakes.js'), 'utf8');
  const calls = [...cart.matchAll(/track\('(\w+)', \{([\s\S]*?)\}(, '[\w-]+' \+ \w+\.id)?\);/g)];
  assert.deepStrictEqual(calls.map((m) => m[1]).sort(), ['AddToCart', 'InitiateCheckout', 'Purchase']);
  const cakeCall = cakes.match(/ssPixel\.track\('Lead', \{([^}]*)\}/);
  assert.ok(cakeCall, 'a cake request is a Lead');
  for (const body of [...calls.map((m) => m[2]), cakeCall[1]]) {
    assert.ok(!/name\b(?!:)|phone|address|email|table_no|notes|cash/.test(body.replace(/content_name: 'Custom cake'/, '')), body);
  }
  // The purchase value is the server's total for the order that was placed.
  assert.match(cart, /track\('Purchase', \{\s*value: order\.total,/);
});
