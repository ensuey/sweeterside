'use strict';
/* Signed checkout tokens: a cheap check that an order came from someone who
   opened the cart and filled it in, not a script posting straight to
   /api/orders. The cart asks for a token when it opens; the token is the time
   it was issued plus an HMAC of it, so the server needs no storage to check
   it. An order is refused if its token is missing, forged, more than two
   hours old (a page left open: the cart fetches a new one) or under three
   seconds old (nobody types a name, phone and address that fast).

   The key is CHECKOUT_SECRET when set. Otherwise one is generated once and
   kept in the settings table, so tokens survive restarts and deploys. */

const crypto = require('node:crypto');
const { db } = require('./db');

const MIN_AGE_MS = 3 * 1000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SECRET_KEY = 'checkout_secret';

let cached = null;

function secret() {
  if (process.env.CHECKOUT_SECRET) return process.env.CHECKOUT_SECRET;
  if (cached) return cached;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_KEY);
  if (row) {
    cached = row.value;
  } else {
    cached = crypto.randomBytes(32).toString('hex');
    // OR IGNORE: if another process saved one first, use that one.
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(SECRET_KEY, cached);
    cached = db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_KEY).value;
  }
  return cached;
}

function sign(issued) {
  return crypto.createHmac('sha256', secret()).update(`checkout:${issued}`).digest('base64url');
}

/** A token issued at `now`. */
function issue(now = new Date()) {
  const issued = now.getTime().toString(36);
  return `${issued}.${sign(issued)}`;
}

/**
 * @returns null if the token is good, or why not: 'bad_token' (missing,
 *   malformed, forged or expired) or 'too_fast'.
 */
function check(token, now = new Date()) {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m) return 'bad_token';
  const expected = Buffer.from(sign(m[1]));
  const given = Buffer.from(m[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 'bad_token';
  const age = now.getTime() - parseInt(m[1], 36);
  if (age > MAX_AGE_MS) return 'bad_token';
  if (age < MIN_AGE_MS) return 'too_fast';
  return null;
}

module.exports = { issue, check, MIN_AGE_MS, MAX_AGE_MS };
