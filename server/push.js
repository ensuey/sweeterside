'use strict';
/* Order alerts as Web Push notifications, on node:crypto only.

   A phone or tablet turns alerts on from the admin (on an iPhone, the admin
   added to the Home Screen). The browser gives us a subscription: an https
   address at its push service, and two keys. Each alert is encrypted for
   that device (RFC 8291, aes128gcm), so the push service cannot read it,
   and signed with our VAPID key (RFC 8292), so only we can send to it.

   An alert carries the order number, type and total only: never the
   customer's name, phone or address.

   Keys come from the environment (fly secrets): VAPID_PUBLIC_KEY and
   VAPID_PRIVATE_KEY, base64url, made by scripts/vapid-keys.js. Without them
   alerts are switched off and the rest of the app is unchanged. */

const crypto = require('node:crypto');
const { db } = require('./db');
const { ValidationError } = require('./menu');

const SUBJECT = 'https://sweeterside.ph'; // who to contact about our pushes
const TTL_SECONDS = 4 * 60 * 60; // a push not delivered in 4 hours is dropped
const RECORD_SIZE = 4096;
const MAX_DEVICES = 20;
const LABEL_MAX = 40;
const ENDPOINT_MAX = 1000;

/* Only the real push services. The address comes from the browser, so
   without this list a signed-in user could make the server send requests to
   any address, including ones inside Fly's network. */
const PUSH_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  label      TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT
)`);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s ?? ''), 'base64url');

/* ---------------------------- keys ---------------------------- */

/** A new VAPID key pair, base64url: the public key as an uncompressed point, the private as d. */
function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)])),
    privateKey: priv.d,
  };
}

/** The configured keys, or null when alerts are not set up. */
function keys() {
  const pub = fromB64url(process.env.VAPID_PUBLIC_KEY);
  const d = fromB64url(process.env.VAPID_PRIVATE_KEY);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) return null;
  try {
    const privateKey = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
      format: 'jwk',
    });
    return { publicKey: pub, privateKey };
  } catch {
    return null;
  }
}

function enabled() {
  return keys() !== null;
}

/* ---------------------------- VAPID ---------------------------- */

/** The Authorization header for one push service (RFC 8292). */
function vapidHeader(endpoint, k, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: SUBJECT }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${b64url(k.publicKey)}`;
}

/* ---------------------------- encryption ---------------------------- */

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/**
 * Encrypt a payload for one device (RFC 8291, a single aes128gcm record).
 * @param {Buffer} payload
 * @param {Buffer} uaPublic the device's p256dh key (65 bytes)
 * @param {Buffer} authSecret the device's auth secret (16 bytes)
 * @returns {Buffer} the request body
 */
function encrypt(payload, uaPublic, authSecret, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  // One record: the payload, then the last-record delimiter 0x02.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, sealed]);
}

/* ---------------------------- devices ---------------------------- */

/** True for an https address at one of the known push services. */
function allowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/** Save (or refresh) one device's subscription. @throws ValidationError */
function subscribe(input, createdBy) {
  const endpoint = String(input && input.endpoint || '');
  const p256dh = fromB64url(input && input.keys && input.keys.p256dh);
  const auth = fromB64url(input && input.keys && input.keys.auth);
  if (!endpoint || endpoint.length > ENDPOINT_MAX || !allowedEndpoint(endpoint)) {
    throw new ValidationError({ endpoint: 'That is not a push address this browser should have given.' });
  }
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
    throw new ValidationError({ keys: 'The browser sent keys we cannot use. Try turning alerts on again.' });
  }
  try {
    crypto.ECDH.convertKey(p256dh, 'prime256v1'); // throws unless it is a point on the curve
  } catch {
    throw new ValidationError({ keys: 'The browser sent keys we cannot use. Try turning alerts on again.' });
  }
  const label = String(input.label ?? '').trim().replace(/\s+/g, ' ').slice(0, LABEL_MAX) || 'Device';
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ? WHERE id = ?')
      .run(b64url(p256dh), b64url(auth), label, existing.id);
    return existing.id;
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get();
  if (n >= MAX_DEVICES) {
    throw new ValidationError({ endpoint: `Alerts are on for ${MAX_DEVICES} devices already. Remove one first.` });
  }
  return Number(db.prepare('INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(endpoint, b64url(p256dh), b64url(auth), label, String(createdBy || '')).lastInsertRowid);
}

/** The devices with alerts on, for the admin list. No keys and no full address. */
function list() {
  return db.prepare('SELECT id, endpoint, label, created_by, created_at, last_ok_at FROM push_subscriptions ORDER BY id').all()
    .map((s) => ({ id: s.id, label: s.label, service: new URL(s.endpoint).hostname, created_by: s.created_by,
      created_at: s.created_at, last_ok_at: s.last_ok_at, endpoint_hash: hashEndpoint(s.endpoint) }));
}

/** Lets a device find itself in the list without the list showing the address. */
function hashEndpoint(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('base64url').slice(0, 16);
}

function remove(id) {
  return db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(Number(id)).changes > 0;
}

function removeEndpoint(endpoint) {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint ?? '')).changes > 0;
}

/* ---------------------------- sending ---------------------------- */

// Swapped in tests, so nothing goes out to a real push service.
let transport = (url, init) => fetch(url, init);
function setTransport(fn) { transport = fn; }

/** Send one notification to one device. @returns the HTTP status, or 0 on a network error. */
async function sendTo(sub, message, k) {
  const body = encrypt(Buffer.from(JSON.stringify(message)), fromB64url(sub.p256dh), fromB64url(sub.auth));
  try {
    const res = await transport(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(sub.endpoint, k),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Urgency: 'high',
        ...(message.tag ? { Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body,
      signal: AbortSignal.timeout(10 * 1000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * Send to every device. A device the push service says is gone (404, 410)
 * is removed. Never throws: alerts must not break placing an order.
 * @returns {Promise<{ sent: number, failed: number, removed: number }>}
 */
async function notifyAll(message) {
  const k = keys();
  const out = { sent: 0, failed: 0, removed: 0 };
  if (!k) return out;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  await Promise.all(subs.map(async (sub) => {
    const status = await sendTo(sub, message, k);
    if (status >= 200 && status < 300) {
      out.sent++;
      db.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").run(sub.id);
    } else if (status === 404 || status === 410) {
      out.removed++;
      remove(sub.id);
      console.log(`[push] device ${sub.id} is gone (${status}); removed`);
    } else {
      out.failed++;
      console.warn(`[push] device ${sub.id} refused (${status || 'network error'})`);
    }
  }));
  return out;
}

const TYPE = { delivery: 'Delivery', pickup: 'Pick-up', dinein: 'Dine-in' };

/** What an order alert says. Number, type and total only. */
function orderMessage(order) {
  const where = order.order_type === 'pickup'
    ? `Pick-up · ${order.pickup_at === 'asap' || !order.pickup_at ? 'ASAP' : order.pickup_at}`
    : order.order_type === 'dinein' ? `Dine-in · Table ${order.table_no}` : TYPE[order.order_type] || 'Order';
  return { title: `New order #${order.id}`, body: `${where} · Php ${order.total}`, url: '/admin', tag: `order-${order.id}` };
}

/** What a cake booking alert says. Number, date and size only. */
function cakeMessage(booking) {
  return {
    title: `New cake booking #${booking.id}`, body: `For ${booking.needed_on} · ${booking.size}`,
    url: '/admin/cakes', tag: `cake-${booking.id}`,
  };
}

/** Fire and forget, after the response has gone. */
function alert(message) {
  if (!enabled()) return;
  setImmediate(() => { notifyAll(message).catch(() => {}); });
}

module.exports = {
  generateKeys, keys, enabled, vapidHeader, encrypt, allowedEndpoint,
  subscribe, list, remove, removeEndpoint, hashEndpoint, notifyAll, setTransport,
  orderMessage, cakeMessage, alert, MAX_DEVICES,
};
