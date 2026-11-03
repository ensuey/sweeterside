'use strict';
/* Order alerts (Web Push): the encryption and signature against the specs,
   the push address allowlist, the device routes, and the alerts sent for a
   new order and cake booking. Nothing goes to a real push service. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-push-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const menu = require('../server/menu');
const cakes = require('../server/cakes');
const checkout = require('../server/checkout');
const push = require('../server/push');
const { manilaDate, addDays } = require('../server/clock');
seedIfEmpty();
// Ordering follows the opening hours. Open all day, so no test depends on the clock.
require('../server/orders').updateSettings({ open_at: '00:00', close_at: '24:00' });

const KEYS = push.generateKeys();
const withKeys = () => { process.env.VAPID_PUBLIC_KEY = KEYS.publicKey; process.env.VAPID_PRIVATE_KEY = KEYS.privateKey; };
const withoutKeys = () => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; };

/** A browser's side of a subscription. */
function device(endpoint = `https://web.push.apple.com/QG${crypto.randomBytes(8).toString('hex')}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    ecdh, authSecret,
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } },
  };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The receiving browser, written from RFC 8291 with plain HMAC, apart from server/push.js. */
function decrypt(body, dev) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = dev.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), dev.ecdh.getPublicKey(), asPublic, Buffer.from([1])]);
  const ikm = hmac(hmac(dev.authSecret, shared), info);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'ends with the last-record delimiter');
  return plain.subarray(0, plain.length - 1);
}

test('the encryption is readable by a browser built from the spec, and by nobody else', () => {
  const dev = device();
  const body = push.encrypt(Buffer.from('{"title":"New order #7"}'), dev.ecdh.getPublicKey(), dev.authSecret);
  assert.strictEqual(body.readUInt32BE(16), 4096, 'record size');
  assert.strictEqual(body[20], 65, 'the server key is in the header');
  assert.strictEqual(decrypt(body, dev).toString(), '{"title":"New order #7"}');

  const other = device();
  other.authSecret = dev.authSecret;
  assert.throws(() => decrypt(body, other), 'another device cannot read it');
  const again = push.encrypt(Buffer.from('{"title":"New order #7"}'), dev.ecdh.getPublicKey(), dev.authSecret);
  assert.notDeepStrictEqual(again, body, 'a new salt and key every time');
});

test('the VAPID header is a valid ES256 token for that push service', () => {
  withKeys();
  try {
    const now = Date.now();
    const h = push.vapidHeader('https://web.push.apple.com/QGabc', push.keys(), now);
    const [, token, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.strictEqual(k, KEYS.publicKey);
    const [head, claims, sig] = token.split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
    const c = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.strictEqual(c.aud, 'https://web.push.apple.com');
    assert.ok(c.exp > now / 1000 && c.exp <= now / 1000 + 24 * 3600, 'expires within a day, as RFC 8292 requires');
    assert.match(c.sub, /^(https:|mailto:)/);
    const raw = Buffer.from(KEYS.publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  } finally {
    withoutKeys();
  }
});

test('only real push services are accepted as push addresses', () => {
  for (const ok of [
    'https://web.push.apple.com/QGabc', 'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.ok(push.allowedEndpoint(ok), ok);
  for (const bad of [
    'http://web.push.apple.com/QGabc', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://127.0.0.1/x',
    'https://sweeterside.internal/x', 'https://web.push.apple.com.evil.example/x', 'https://evilweb.push.apple.com.example/x',
    'https://user:pw@web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'javascript:alert(1)', '', 'not a url',
  ]) assert.ok(!push.allowedEndpoint(bad), bad);
});

/* ---------------------------- HTTP ---------------------------- */

async function withAdmin(fn) {
  const email = `push-${crypto.randomBytes(3).toString('hex')}@example.com`;
  auth.createUser(email, 'a-long-enough-password');
  const { token, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const cookie = `${auth.SESSION_COOKIE}=${token}`;
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', body, csrf: withCsrf = true, signedIn = true } = {}) => fetch(`${url}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(signedIn ? { Cookie: cookie } : {}), ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    await fn({ call, url, email });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('without keys alerts are off and nothing can subscribe', async () => {
  withoutKeys();
  await withAdmin(async ({ call }) => {
    const info = await (await call('/api/push')).json();
    assert.deepStrictEqual([info.enabled, info.public_key], [false, null]);
    assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: device().subscription })).status, 503);
  });
});

test('the device routes need sign-in and CSRF, check what they get, and never show keys', async () => {
  withKeys();
  db.exec('DELETE FROM push_subscriptions');
  try {
    await withAdmin(async ({ call, email }) => {
      const dev = device();
      assert.strictEqual((await call('/api/push', { signedIn: false })).status, 401);
      assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: dev.subscription, signedIn: false })).status, 401);
      assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: dev.subscription, csrf: false })).status, 403);

      const evil = { ...dev.subscription, endpoint: 'https://169.254.169.254/latest/meta-data' };
      assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: evil })).status, 422, 'no internal addresses');
      const badKey = { ...dev.subscription, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: dev.subscription.keys.auth } };
      assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: badKey })).status, 422, 'not a point on the curve');
      const shortAuth = { ...dev.subscription, keys: { ...dev.subscription.keys, auth: 'abc' } };
      assert.strictEqual((await call('/api/push/subscriptions', { method: 'POST', body: shortAuth })).status, 422);

      const res = await call('/api/push/subscriptions', { method: 'POST', body: { ...dev.subscription, label: '  iPhone  <b>x</b>' } });
      assert.strictEqual(res.status, 201);
      const again = await call('/api/push/subscriptions', { method: 'POST', body: { ...dev.subscription, label: 'iPhone' } });
      assert.strictEqual((await again.json()).devices.length, 1, 'the same device is saved once');

      const info = await (await call('/api/push')).json();
      assert.strictEqual(info.enabled, true);
      assert.strictEqual(info.public_key, KEYS.publicKey);
      const [d] = info.devices;
      assert.deepStrictEqual([d.label, d.service, d.created_by], ['iPhone', 'web.push.apple.com', email]);
      assert.strictEqual(d.endpoint_hash, push.hashEndpoint(dev.subscription.endpoint));
      const listed = JSON.stringify(info.devices);
      assert.ok(!listed.includes(dev.subscription.keys.p256dh) && !listed.includes(dev.subscription.keys.auth)
        && !listed.includes(dev.subscription.endpoint), 'no keys or push address in the list');

      assert.strictEqual((await call(`/api/push/subscriptions/${d.id}`, { method: 'DELETE', csrf: false })).status, 403);
      assert.strictEqual((await call(`/api/push/subscriptions/${d.id}`, { method: 'DELETE' })).status, 200);
      assert.strictEqual((await call(`/api/push/subscriptions/${d.id}`, { method: 'DELETE' })).status, 404);

      await call('/api/push/subscriptions', { method: 'POST', body: dev.subscription });
      await call('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: dev.subscription.endpoint } });
      assert.strictEqual((await (await call('/api/push')).json()).devices.length, 0, 'turned off from the device itself');
    });
  } finally {
    withoutKeys();
  }
});

/** Capture pushes instead of sending them. */
function capture(status = 201) {
  const sent = [];
  push.setTransport(async (url, init) => { sent.push({ url, init }); return { status: typeof status === 'function' ? status(url) : status }; });
  return sent;
}

const waitFor = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('a new order and a new cake booking alert every device, without customer details', async () => {
  withKeys();
  db.exec('DELETE FROM push_subscriptions');
  const phone = device();
  const tablet = device(`https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString('hex')}`);
  push.subscribe(phone.subscription, 'owner@example.com');
  push.subscribe(tablet.subscription, 'owner@example.com');
  const sent = capture(201);
  try {
    await withAdmin(async ({ url }) => {
      const matcha = menu.list().find((i) => i.name === 'Matcha Frappe');
      const res = await fetch(`${url}/api/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'delivery', name: 'Ana Secret-Name', phone: '0917 555 7777', address: '99 Private St', landmark: 'blue gate',
          cash: 200, items: [{ id: matcha.id, qty: 1 }], expected_total: 129,
          checkout_token: checkout.issue(new Date(Date.now() - 10000)),
        }),
      });
      assert.strictEqual(res.status, 201);
      const { order } = await res.json();
      await waitFor(() => sent.length >= 2);
      assert.strictEqual(sent.length, 2, 'one push per device');

      const toPhone = sent.find((s) => s.url === phone.subscription.endpoint);
      assert.ok(toPhone);
      assert.strictEqual(toPhone.init.method, 'POST');
      assert.strictEqual(toPhone.init.headers['Content-Encoding'], 'aes128gcm');
      assert.strictEqual(toPhone.init.headers.TTL, String(4 * 60 * 60));
      assert.match(toPhone.init.headers.Authorization, /^vapid t=.+, k=/);
      const msg = JSON.parse(decrypt(toPhone.init.body, phone).toString());
      assert.deepStrictEqual(msg, { title: `New order #${order.id}`, body: 'Delivery · ₱129', url: '/admin', tag: `order-${order.id}` });
      const text = JSON.stringify(msg);
      for (const secret of ['Secret-Name', '555', '7777', 'Private St', 'blue gate']) assert.ok(!text.includes(secret), secret);
      assert.ok(!toPhone.init.body.includes(Buffer.from('Delivery')), 'the push service only sees ciphertext');

      sent.length = 0;
      const day = addDays(manilaDate(), cakes.settings().lead_days + 2);
      const cake = await fetch(`${url}/api/cakes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ana Secret-Name', phone: '0917 555 8888', size: cakes.settings().sizes[0].name,
          flavour: 'Chocolate', needed_on: day, handover: 'pickup' }),
      });
      assert.strictEqual(cake.status, 201, await cake.clone().text());
      const { booking } = await cake.json();
      await waitFor(() => sent.length >= 2);
      const cakeMsg = JSON.parse(decrypt(sent.find((s) => s.url === phone.subscription.endpoint).init.body, phone).toString());
      assert.strictEqual(cakeMsg.title, `New cake booking #${booking.id}`);
      assert.strictEqual(cakeMsg.url, '/admin/cakes');
      assert.ok(cakeMsg.body.includes(day) && !JSON.stringify(cakeMsg).includes('Secret-Name'));
    });
  } finally {
    push.setTransport((u, i) => fetch(u, i));
    withoutKeys();
  }
});

test('a device the push service says is gone is removed; a failure keeps it', async () => {
  withKeys();
  db.exec('DELETE FROM push_subscriptions');
  const gone = device();
  const flaky = device();
  push.subscribe(gone.subscription, '');
  push.subscribe(flaky.subscription, '');
  capture((url) => (url === gone.subscription.endpoint ? 410 : 500));
  try {
    const r = await push.notifyAll({ title: 'x', body: 'y', url: '/admin' });
    assert.deepStrictEqual(r, { sent: 0, failed: 1, removed: 1 });
    assert.deepStrictEqual(push.list().map((d) => d.endpoint_hash), [push.hashEndpoint(flaky.subscription.endpoint)]);
  } finally {
    push.setTransport((u, i) => fetch(u, i));
    withoutKeys();
  }
});

test('the alerts service worker is served with its scope header and never cached; the manifest has its type', async () => {
  await withAdmin(async ({ url }) => {
    const sw = await fetch(`${url}/admin/sw.js`);
    assert.strictEqual(sw.status, 200);
    assert.strictEqual(sw.headers.get('service-worker-allowed'), '/admin');
    assert.strictEqual(sw.headers.get('cache-control'), 'no-cache');
    assert.match(sw.headers.get('content-type'), /javascript/);
    const manifest = await fetch(`${url}/admin/manifest.webmanifest`);
    assert.strictEqual(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    assert.strictEqual((await manifest.json()).start_url, '/admin');
  });
});

test('the Settings page holds fake-order protection and order alerts, behind sign-in', async () => {
  await withAdmin(async ({ call, url }) => {
    const out = await fetch(`${url}/admin/settings`, { redirect: 'manual' });
    assert.strictEqual(out.status, 302, 'signed out: sent to sign in');
    assert.match(out.headers.get('location'), /\/admin\/login$/);
    assert.strictEqual((await fetch(`${url}/admin/settings.html`)).status, 404, 'not served as a static file');

    const settings = await (await call('/admin/settings')).text();
    for (const id of ['trust-form', 'confirm-delivery', 'max-open', 'auto-confirm', 'alerts-on', 'alerts-devices']) {
      assert.ok(settings.includes(`id="${id}"`), `Settings has #${id}`);
    }
    assert.ok(settings.includes('/admin/settings.js') && settings.includes('/admin/push.js'));
    assert.ok(settings.includes('href="/admin/settings" aria-current="page"'));

    const orders = await (await call('/admin')).text();
    assert.ok(!orders.includes('id="trust-form"') && !orders.includes('id="alerts-on"') && !orders.includes('/admin/push.js'),
      'moved off the Orders page');
    assert.ok(orders.includes('id="fee-form"'), 'ordering settings stay on Orders');
    assert.ok(orders.includes('href="/admin/settings"'), 'Settings is in the nav');
  });
});
