'use strict';
/* Phone numbers that may not order or book a cake online. Numbers are kept
   normalised (+639XXXXXXXXX), so however a blocked customer types theirs it
   still matches. */

const { db } = require('./db');
const { ValidationError } = require('./menu');
const { normalizePhPhone, PHONE_MESSAGE } = require('./phone');

const REASON_MAX = 200;

/** What a blocked number is told. Neutral on purpose: it does not say why. */
const BLOCKED_MESSAGE = "We couldn't place this order online. Please call or message us.";

function blockedError() {
  return Object.assign(new Error(BLOCKED_MESSAGE), { status: 403, body: { error: BLOCKED_MESSAGE }, code: 'blocked' });
}

function isBlocked(phoneNorm) {
  if (!phoneNorm) return false;
  return !!db.prepare('SELECT 1 FROM blocked_phones WHERE phone_norm = ?').get(phoneNorm);
}

function list() {
  return db.prepare('SELECT * FROM blocked_phones ORDER BY id DESC').all();
}

function get(id) {
  return db.prepare('SELECT * FROM blocked_phones WHERE id = ?').get(Number(id)) || null;
}

/**
 * Block a number. input: { phone, reason }. Blocking a number that is
 * already blocked keeps the first entry and returns it.
 */
function add(input, createdBy = '') {
  const errors = {};
  const phoneNorm = normalizePhPhone(input.phone);
  if (!String(input.phone ?? '').trim()) errors.phone = 'Enter the phone number to block.';
  else if (!phoneNorm) errors.phone = PHONE_MESSAGE;
  const reason = String(input.reason ?? '').trim().replace(/\s+/g, ' ');
  if (reason.length > REASON_MAX) errors.reason = `Keep the reason under ${REASON_MAX} characters.`;
  if (Object.keys(errors).length) throw new ValidationError(errors);

  db.prepare(`INSERT INTO blocked_phones (phone_norm, reason, created_by) VALUES (?, ?, ?)
              ON CONFLICT(phone_norm) DO NOTHING`).run(phoneNorm, reason, String(createdBy));
  return db.prepare('SELECT * FROM blocked_phones WHERE phone_norm = ?').get(phoneNorm);
}

function remove(id) {
  return db.prepare('DELETE FROM blocked_phones WHERE id = ?').run(Number(id)).changes > 0;
}

module.exports = { BLOCKED_MESSAGE, blockedError, isBlocked, list, get, add, remove };
