'use strict';
/* Philippine mobile numbers. Customers type them every way: 0917 123 4567,
   +63 917-123-4567, (0917) 1234567. They are all stored the same way,
   +639XXXXXXXXX, so the open-orders limit, the customer history and the
   blocklist see one number however it was typed. */

const PHONE_MESSAGE = 'Please enter a valid PH mobile number, e.g. 0917 123 4567.';

/**
 * '0917 123 4567', '+639171234567' or '639171234567' (spaces, dashes and
 * brackets allowed) -> '+639171234567'. Anything else -> null.
 */
function normalizePhPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\+?[\d\s()-]+$/.test(s)) return null;
  const compact = s.replace(/[\s()-]/g, '');
  const m = /^(?:\+63|63|0)(9\d{9})$/.exec(compact);
  return m ? `+63${m[1]}` : null;
}

/** '+639171234567' -> '0917 123 4567', the way Dachel would write it. */
function displayPhPhone(norm) {
  const m = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(String(norm ?? ''));
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : String(norm ?? '');
}

module.exports = { normalizePhPhone, displayPhPhone, PHONE_MESSAGE };
