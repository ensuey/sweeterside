'use strict';
/* Paying online with GCash through PayMongo's hosted Checkout. The customer
   chooses GCash at checkout; the order is saved as awaiting payment (out of
   the queue and the alerts), and the customer goes to PayMongo's page. Card
   and wallet details never reach this server.

   The order is paid only when PayMongo says so: its webhook, signed with the
   webhook secret, or the customer's return, which asks PayMongo directly.
   The amount must be the order's total. An order still unpaid after
   PAY_MINUTES is cancelled (asking PayMongo first), which frees its stock.

   On only when PAYMONGO_SECRET_KEY is set and Settings has GCash switched on.
   Secrets come from the environment (fly secrets), never from the database,
   and are never logged. Logs carry order ids and reason codes only. */

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { getSetting } = require('./settings');

const API = 'https://api.paymongo.com/v1';
const PAY_MINUTES = 15;
const SIGNATURE_TOLERANCE_S = 5 * 60;
const UNAVAILABLE = 'GCash payments are not available right now. Please choose another way to pay.';

let fetchImpl = (...args) => globalThis.fetch(...args);
/** Tests swap PayMongo for a stub. */
function setFetch(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

const secretKey = () => process.env.PAYMONGO_SECRET_KEY || '';
const webhookSecret = () => process.env.PAYMONGO_WEBHOOK_SECRET || '';
const liveMode = () => secretKey().startsWith('sk_live_');

/** The keys are set on the server (not whether they work). */
function configured() {
  return /^sk_(test|live)_[A-Za-z0-9]+$/.test(secretKey());
}

/** GCash is offered at checkout: keys set and switched on in Settings. */
function enabled() {
  return configured() && getSetting('gcash_online', '0') === '1';
}

const unavailable = () => Object.assign(new Error(UNAVAILABLE), { status: 502, body: { error: UNAVAILABLE } });

async function call(method, path, body) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString('base64')}`,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    console.warn(`[paymongo] ${method} ${path.split('/')[1]} unreachable`);
    throw unavailable();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The status code only: PayMongo's error text can echo request details.
    console.warn(`[paymongo] ${method} ${path.split('/')[1]} answered ${res.status}`);
    throw unavailable();
  }
  return data;
}

/* ---------------------------- checkout ---------------------------- */

/**
 * A PayMongo Checkout for an order awaiting payment: one line for the order's
 * total, GCash only. baseUrl is where the customer comes back to.
 * @returns { url, ref } the checkout page, and the customer's key to the order
 */
async function startCheckout(orderId, baseUrl) {
  const order = db.prepare("SELECT id, total_cents, pay_token FROM orders WHERE id = ? AND pay_status = 'awaiting'")
    .get(Number(orderId));
  if (!order) throw unavailable();
  const ref = `${order.id}.${order.pay_token}`;
  const data = await call('POST', '/checkout_sessions', {
    data: {
      attributes: {
        line_items: [{ name: `Sweeter Side order #${order.id}`, amount: order.total_cents, currency: 'PHP', quantity: 1 }],
        payment_method_types: ['gcash'],
        description: `Order #${order.id}`,
        reference_number: String(order.id),
        metadata: { order_id: String(order.id) },
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        success_url: `${baseUrl}/?gcash=${encodeURIComponent(ref)}`,
        cancel_url: `${baseUrl}/?gcash=${encodeURIComponent(ref)}&back=1`,
      },
    },
  });
  const id = data && data.data && data.data.id;
  const url = data && data.data && data.data.attributes && data.data.attributes.checkout_url;
  if (!/^cs_[A-Za-z0-9]+$/.test(String(id)) || !/^https:\/\/[a-z0-9.-]*paymongo\.com\//.test(String(url))) {
    console.warn(`[paymongo] #${order.id} checkout answer not understood`);
    throw unavailable();
  }
  db.prepare('UPDATE orders SET paymongo_session = ? WHERE id = ?').run(id, order.id);
  return { url, ref };
}

/** What a checkout session says about payment: { paid, payment_id, amount } (centavos). */
function sessionPayment(session) {
  const attrs = (session && session.attributes) || {};
  const payment = (attrs.payments || []).find((p) => p && p.attributes && p.attributes.status === 'paid');
  return payment
    ? { paid: true, payment_id: String(payment.id), amount: Number(payment.attributes.amount) }
    : { paid: false };
}

async function fetchSession(sessionId) {
  const data = await call('GET', `/checkout_sessions/${encodeURIComponent(sessionId)}`);
  return data.data;
}

/* ---------------------------- order state ---------------------------- */

/** A new key for the customer's way back from PayMongo. */
function newPayToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** The order a "<id>.<token>" reference points at, or null. The token is compared in constant time. */
function orderByRef(ref) {
  const m = /^(\d{1,10})\.([A-Za-z0-9_-]{32})$/.exec(String(ref || ''));
  if (!m) return null;
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND pay_method = ?').get(Number(m[1]), 'gcash');
  if (!o || !o.pay_token) return null;
  const a = Buffer.from(o.pay_token);
  const b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? o : null;
}

/**
 * Record a payment PayMongo confirmed. Only for this order's own checkout
 * session and for exactly its total.
 * @returns 'paid' (newly), 'already', 'late' (the order had been cancelled:
 *   refund it in PayMongo), or a refusal code: 'unknown', 'session', 'amount'
 */
function markPaid(orderId, { session_id: sessionId, payment_id: paymentId, amount }) {
  const result = transaction(() => {
    const o = db.prepare('SELECT id, status, total_cents, pay_method, pay_status, paymongo_session FROM orders WHERE id = ?')
      .get(Number(orderId));
    if (!o || o.pay_method !== 'gcash') return 'unknown';
    if (!o.paymongo_session || o.paymongo_session !== sessionId) return 'session';
    if (o.pay_status === 'paid' || o.pay_status === 'late') return 'already';
    if (amount !== o.total_cents) return 'amount';
    const status = o.status === 'cancelled' ? 'late' : 'paid';
    db.prepare(`UPDATE orders SET pay_status = ?, paymongo_payment = ?, online_paid_cents = ?,
                  online_paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(status, paymentId, amount, o.id);
    return status;
  });
  // Only now does the kitchen hear about it (once, whichever way it arrived).
  if (result === 'paid') {
    try { paidListener(Number(orderId)); } catch { console.warn(`[paymongo] #${orderId} alert failed`); }
  }
  return result;
}

let paidListener = () => {};
/** index.js sends the order alert when an order is paid. */
function onPaid(fn) { paidListener = fn; }

/** Cancel an order that was never paid; its stock is free again. */
function cancelUnpaid(orderId) {
  db.prepare(`UPDATE orders SET status = 'cancelled', cancel_reason = 'unpaid', pay_status = '',
                updated_at = datetime('now')
              WHERE id = ? AND pay_status = 'awaiting' AND status <> 'cancelled'`).run(Number(orderId));
}

/**
 * Ask PayMongo about an order still awaiting payment: paid → recorded; not
 * paid and give up → the checkout is expired and the order cancelled.
 * @returns 'paid' | 'awaiting' | 'cancelled'
 */
async function settle(order, { giveUp = false } = {}) {
  if (order.pay_status !== 'awaiting') return order.pay_status === 'paid' ? 'paid' : 'cancelled';
  if (order.paymongo_session) {
    const p = sessionPayment(await fetchSession(order.paymongo_session));
    if (p.paid) {
      const r = markPaid(order.id, { session_id: order.paymongo_session, payment_id: p.payment_id, amount: p.amount });
      if (r === 'paid' || r === 'already') return 'paid';
      console.warn(`[paymongo] #${order.id} payment refused: ${r}`);
    }
    if (!giveUp) return 'awaiting';
    try {
      await call('POST', `/checkout_sessions/${encodeURIComponent(order.paymongo_session)}/expire`);
    } catch { /* already expired or finished: cancelled below either way */ }
  }
  cancelUnpaid(order.id);
  return 'cancelled';
}

/**
 * Cancel orders still awaiting payment after PAY_MINUTES (run every minute).
 * @returns how many were looked at
 */
async function expireStale(now = new Date()) {
  const cutoff = new Date(now.getTime() - PAY_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const stale = db.prepare("SELECT * FROM orders WHERE pay_status = 'awaiting' AND created_at <= ? ORDER BY id LIMIT 20")
    .all(cutoff);
  for (const o of stale) {
    try {
      const r = await settle(o, { giveUp: true });
      console.log(`[paymongo] #${o.id} unpaid after ${PAY_MINUTES} min: ${r}`);
    } catch { /* PayMongo unreachable: try again next minute */ }
  }
  return stale.length;
}

/* ---------------------------- webhook ---------------------------- */

/**
 * Check a webhook's Paymongo-Signature header ("t=<unix>,te=<hex>,li=<hex>"):
 * an HMAC-SHA256 of "<t>.<raw body>" with the webhook secret, in the live or
 * test slot to match the key, compared in constant time, and not older than
 * five minutes.
 */
function verifySignature(rawBody, header, now = Date.now()) {
  const secret = webhookSecret();
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_S) return false;
  const given = liveMode() ? parts.li : parts.te;
  if (!/^[a-f0-9]{64}$/.test(String(given || ''))) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

/**
 * A verified webhook event. Only a paid checkout session counts; anything
 * else is acknowledged and ignored.
 * @returns { order_id, result } or null when there was nothing to do
 */
function handleEvent(event) {
  const attrs = event && event.data && event.data.attributes;
  if (!attrs || attrs.type !== 'checkout_session.payment.paid') return null;
  const session = attrs.data;
  const orderId = Number(session && session.attributes && session.attributes.metadata && session.attributes.metadata.order_id);
  if (!Number.isInteger(orderId) || orderId < 1) return null;
  const p = sessionPayment(session);
  if (!p.paid) return null;
  const result = markPaid(orderId, { session_id: String(session.id), payment_id: p.payment_id, amount: p.amount });
  return { order_id: orderId, result };
}

module.exports = {
  PAY_MINUTES, UNAVAILABLE, setFetch, configured, enabled, liveMode,
  startCheckout, newPayToken, orderByRef, markPaid, onPaid, cancelUnpaid, settle, expireStale,
  verifySignature, handleEvent,
};
