'use strict';
/* Voucher codes customers type at checkout. Like menu.js, every field an admin
   can submit is checked here before it reaches the database. A voucher takes
   money off the items only, never the delivery fee. */

const { db } = require('./db');
const { ValidationError } = require('./menu');
const { manilaDate } = require('./clock');
const { voucherDiscount } = require('./pricing');

const KINDS = ['percent', 'amount'];
const CODE_RE = /^[A-Z0-9-]{3,20}$/;
const MAX_AMOUNT = 100000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Codes are matched ignoring case and surrounding spaces. */
function normaliseCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

function intOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/** 'YYYY-MM-DD' that is a real calendar day, or null when blank. */
function dateOrNull(v, errors, key) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    errors[key] = 'Enter a date, or leave it blank.';
    return null;
  }
  return s;
}

/** '2026-11-01' -> '1 Nov 2026' */
function niceDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Validate a submitted voucher.
 * @param {number|null} id  the voucher being edited, so its own code is not a clash
 * @throws {ValidationError}
 */
function validate(input, id = null) {
  const errors = {};

  const code = normaliseCode(input.code);
  if (!CODE_RE.test(code)) {
    errors.code = 'Use 3 to 20 letters, numbers or dashes, like SWEET10.';
  } else {
    const clash = db.prepare('SELECT id FROM vouchers WHERE code = ?').get(code);
    if (clash && clash.id !== id) errors.code = 'Another voucher already uses that code.';
  }

  const kind = String(input.kind ?? '');
  if (!KINDS.includes(kind)) errors.kind = 'Choose % off or Php off.';

  const value = intOrNull(input.value);
  if (value === null || Number.isNaN(value)) {
    errors.value = 'Enter how much it takes off, as a whole number.';
  } else if (kind === 'percent' && (value < 1 || value > 100)) {
    errors.value = 'Take between 1% and 100% off.';
  } else if (kind === 'amount' && (value < 1 || value > MAX_AMOUNT)) {
    errors.value = `Take between Php 1 and Php ${MAX_AMOUNT} off.`;
  }

  // The cap only makes sense for a percentage.
  let maxOff = kind === 'percent' ? intOrNull(input.max_off) : null;
  if (Number.isNaN(maxOff) || (maxOff !== null && (maxOff < 1 || maxOff > MAX_AMOUNT))) {
    errors.max_off = 'Enter the most it can take off in pesos, or leave it blank.';
    maxOff = null;
  }

  const validFrom = dateOrNull(input.valid_from, errors, 'valid_from');
  const validUntil = dateOrNull(input.valid_until, errors, 'valid_until');
  if (validFrom && validUntil && validFrom > validUntil) {
    errors.valid_until = 'The last day must be on or after the first day.';
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { code, kind, value, max_off: maxOff, valid_from: validFrom, valid_until: validUntil };
}

/* ---------------------------- describing ---------------------------- */

/** '10% off (up to Php 100)' or 'Php 50 off' */
function label(v) {
  if (v.kind === 'percent') return `${v.value}% off${v.max_off ? ` (up to Php ${v.max_off})` : ''}`;
  return `Php ${v.value} off`;
}

/** 'active' | 'off' | 'scheduled' | 'expired', for today in Manila. */
function status(v, now = new Date()) {
  if (!v.active) return 'off';
  const today = manilaDate(now);
  if (v.valid_from && today < v.valid_from) return 'scheduled';
  if (v.valid_until && today > v.valid_until) return 'expired';
  return 'active';
}

/**
 * Pesos off a whole-peso subtotal: a percentage (capped) or an amount, never
 * more than the subtotal. The arithmetic is the pricing engine's, so the
 * checkout and the POS agree.
 */
function discountFor(v, subtotal) {
  return voucherDiscount(v, subtotal * 100) / 100;
}

/* ---------------------------- queries ---------------------------- */

// uses: orders placed with the code, not counting cancelled ones. A POS
// order only counts once it is paid.
const SELECT = `SELECT v.id, v.code, v.kind, v.value, v.max_off, v.valid_from, v.valid_until, v.active,
                       (SELECT COUNT(*) FROM orders o
                        WHERE o.voucher_code = v.code AND o.status <> 'cancelled'
                          AND (o.source = 'online' OR o.paid_at IS NOT NULL)) AS uses
                FROM vouchers v`;

function describe(v, now) {
  return { ...v, active: v.active === 1, label: label(v), status: status({ ...v, active: v.active === 1 }, now) };
}

function list({ now } = {}) {
  return db.prepare(`${SELECT} ORDER BY v.id DESC`).all().map((v) => describe(v, now));
}

function get(id) {
  const v = db.prepare(`${SELECT} WHERE v.id = ?`).get(Number(id));
  return v ? describe(v) : null;
}

function create(input) {
  const row = validate(input);
  const info = db.prepare(`
    INSERT INTO vouchers (code, kind, value, max_off, valid_from, valid_until)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    row.code, row.kind, row.value, row.max_off, row.valid_from, row.valid_until);
  return get(info.lastInsertRowid);
}

function update(id, input) {
  if (!get(id)) return null;
  const row = validate(input, Number(id));
  db.prepare(`
    UPDATE vouchers SET code = ?, kind = ?, value = ?, max_off = ?, valid_from = ?, valid_until = ?,
      updated_at = datetime('now')
    WHERE id = ?`).run(
    row.code, row.kind, row.value, row.max_off, row.valid_from, row.valid_until, Number(id));
  return get(id);
}

function setActive(id, active) {
  if (!get(id)) return null;
  db.prepare("UPDATE vouchers SET active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(active ? 1 : 0, Number(id));
  return get(id);
}

/** Past orders keep the code text and their discount, so deleting is safe. */
function remove(id) {
  return db.prepare('DELETE FROM vouchers WHERE id = ?').run(Number(id)).changes > 0;
}

/**
 * Find a code a customer (or the cashier) typed and check it can be used
 * today: on, and within its dates. Used by the checkout and the POS alike;
 * the pricing engine then works out what it takes off.
 * @returns {{ code, label, kind, value, max_off }}
 * @throws {ValidationError} with a `voucher` message the customer can act on
 */
function lookup(rawCode, now = new Date()) {
  const code = normaliseCode(rawCode);
  const v = code ? db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code) : null;
  if (!v) throw new ValidationError({ voucher: "We don't know that code. Check the spelling." });

  const state = status({ ...v, active: v.active === 1 }, now);
  if (state === 'off') throw new ValidationError({ voucher: 'That code is not available right now.' });
  if (state === 'expired') throw new ValidationError({ voucher: 'That code has expired.' });
  if (state === 'scheduled') {
    throw new ValidationError({ voucher: `That code starts on ${niceDate(v.valid_from)}.` });
  }
  return { code: v.code, label: label(v), kind: v.kind, value: v.value, max_off: v.max_off };
}

/**
 * Check a code against a whole-peso subtotal.
 * @returns {{ code, label, discount }}
 * @throws {ValidationError}
 */
function check(rawCode, subtotal, now = new Date()) {
  const v = lookup(rawCode, now);
  return { code: v.code, label: v.label, discount: discountFor(v, subtotal) };
}

module.exports = {
  KINDS, normaliseCode, validate, list, get, create, update, setActive, remove, lookup, check, discountFor,
};
