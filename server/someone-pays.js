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

module.exports = {
  LEAD_HOURS, CUTOFF_MINUTES, MAX_WAIT_HOURS, REFERENCE_MAX, NAME_MAX,
  details, offered, newToken, parsers, settingsView,
};
