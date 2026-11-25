'use strict';
/* Someone else pays (spec: docs/superpowers/specs/2026-11-25-someone-else-pays-design.md).
   The receiver orders; the order waits (pay_method 'someone', pay_status
   'awaiting', out of the queue, stock held). A payer opens /pay/<id>.<payer
   token>, pays by GCash or bank transfer to the shop's own account and gives
   the reference ('checking'). The owner checks the money arrived and taps
   Payment received ('paid', into the queue) or Not received (back to waiting). */

const crypto = require('node:crypto');
const { ValidationError } = require('./menu');
const { getSetting } = require('./settings');
const { normalizePhPhone, displayPhPhone } = require('./phone');

const LEAD_HOURS = 3; // earliest time to choose: time to pay and be checked
const CUTOFF_MINUTES = 60; // no reference this close to its time: cancelled
const MAX_WAIT_HOURS = 24; // no reference this long after ordering: cancelled
const REFERENCE_MAX = 60; // the same limit as POS payment references
const NAME_MAX = 60;
const BANK_MAX = 300;

/** The shop's own payment details, as payers see them. */
function details() {
  return {
    gcash_name: getSetting('pay_gcash_name', ''),
    gcash_number: getSetting('pay_gcash_number', ''),
    bank_details: getSetting('pay_bank_details', ''),
    qr_gcash: getSetting('pay_qr_gcash', ''),
    qr_bank: getSetting('pay_qr_bank', ''),
  };
}

/** Offered at checkout: switched on, with somewhere to send the money. */
function offered() {
  const d = details();
  return getSetting('someone_pays', '0') === '1' && !!(d.gcash_number || d.bank_details);
}

/** The payer's key, apart from the receiver's own pay_token. */
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/* ---------------------------- settings ---------------------------- */

function text(key, max, label) {
  return (input) => {
    const v = String(input ?? '').replace(/\r\n/g, '\n').trim();
    if (v.length > max) throw new ValidationError({ [key]: `Keep the ${label} under ${max} characters.` });
    return v;
  };
}

function parseGcashNumber(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const norm = normalizePhPhone(raw);
  if (!norm) throw new ValidationError({ pay_gcash_number: 'Enter a PH mobile number, like 0917 123 4567.' });
  return displayPhPhone(norm);
}

/** parseImage: orders.js's share-image check, given the setting's key. */
function parsers(parseSwitch, parseImage) {
  return {
    someone_pays: parseSwitch('someone_pays'),
    pay_gcash_name: text('pay_gcash_name', NAME_MAX, 'name'),
    pay_gcash_number: parseGcashNumber,
    pay_bank_details: text('pay_bank_details', BANK_MAX, 'bank details'),
    pay_qr_gcash: parseImage('pay_qr_gcash'),
    pay_qr_bank: parseImage('pay_qr_bank'),
  };
}

function settingsView() {
  const d = details();
  return {
    someone_pays: getSetting('someone_pays', '0') === '1',
    someone_pays_ready: offered(),
    pay_gcash_name: d.gcash_name,
    pay_gcash_number: d.gcash_number,
    pay_bank_details: d.bank_details,
    pay_qr_gcash: d.qr_gcash,
    pay_qr_bank: d.qr_bank,
  };
}

/* ---------------------------- the payer ---------------------------- */

const { db, transaction } = require('./db');
const orders = () => require('./orders'); // orders.js requires this module

const httpError = (status, message) => Object.assign(new Error(message), { status });
const REF_RE = /^(\d{1,10})\.([A-Za-z0-9_-]{32})$/;
const REFERENCE_RE = /^[A-Za-z0-9 -]+$/;
const REFERENCE_MIN = 4;
const METHODS = { gcash: 'GCash', bank: 'Bank transfer' };

/** The payer's link key, "<id>.<payer token>", or '' when the order has none. */
function payerRef(id) {
  const row = db.prepare("SELECT payer_token FROM orders WHERE id = ? AND pay_method = 'someone'").get(Number(id));
  return row && row.payer_token ? `${Number(id)}.${row.payer_token}` : '';
}

/** The order a payer's key opens, or null. The token is compared in constant time. */
function byPayerRef(ref) {
  const m = REF_RE.exec(String(ref || ''));
  if (!m) return null;
  const row = db.prepare("SELECT payer_token FROM orders WHERE id = ? AND pay_method = 'someone'").get(Number(m[1]));
  if (!row || !row.payer_token) return null;
  const a = Buffer.from(row.payer_token);
  const b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? orders().get(Number(m[1])) : null;
}

/** What the payer sees: the order, the receiver's first name, never a phone or address. */
function payView(order) {
  return {
    id: order.id, order_type: order.order_type, first_name: String(order.customer_name || '').trim().split(/\s+/)[0] || '',
    items: order.items.map((i) => ({ qty: i.qty, name: i.name, options_text: i.options_text || '' })),
    subtotal: order.subtotal, discount: order.discount, voucher_code: order.voucher_code,
    delivery_fee: order.delivery_fee, total: order.total, delivery_area: order.delivery_area,
    scheduled_label: order.scheduled_label, pickup_at: order.pickup_at,
    status: order.status, pay_status: order.pay_status, payer_method: order.payer_method,
  };
}

let referenceListener = () => {};
/** index.js texts the owner when a reference comes in. */
function onReference(fn) { referenceListener = fn; }

/**
 * The payer's reference. input: { method: 'gcash'|'bank', reference, name? }.
 * Only while the order waits; one at a time.
 * @returns the order, now 'checking'
 */
function submitReference(ref, input = {}) {
  const errors = {};
  const method = String(input.method ?? '');
  const reference = String(input.reference ?? '').trim().replace(/\s+/g, ' ');
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!METHODS[method]) errors.method = 'Choose GCash or bank transfer.';
  if (reference.length < REFERENCE_MIN || reference.length > REFERENCE_MAX || !REFERENCE_RE.test(reference)) {
    errors.reference = 'Enter the reference number from your receipt.';
  }
  if (name.length > NAME_MAX) errors.name = `Keep your name under ${NAME_MAX} characters.`;
  const order = byPayerRef(ref);
  if (!order) throw httpError(404, 'We could not find that order.');
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const changed = transaction(() => db.prepare(`UPDATE orders SET pay_status = 'checking', payer_method = ?,
      payer_reference = ?, payer_name = ?, payer_sent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND pay_method = 'someone' AND pay_status = 'awaiting' AND status <> 'cancelled'`)
    .run(method, reference, name, order.id).changes);
  if (!changed) {
    throw httpError(409, order.status === 'cancelled' ? 'This order was cancelled. Please contact us.'
      : 'A payment for this order is already being checked.');
  }
  const after = orders().get(order.id);
  try { referenceListener(after); } catch { console.warn(`[someone-pays] #${order.id} alert failed`); }
  return after;
}

module.exports = {
  LEAD_HOURS, CUTOFF_MINUTES, MAX_WAIT_HOURS, REFERENCE_MAX, NAME_MAX,
  METHODS, details, offered, newToken, parsers, settingsView,
  payerRef, byPayerRef, payView, onReference, submitReference,
};
