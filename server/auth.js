'use strict';
/* Password hashing, server-side sessions, CSRF tokens and login throttling.
   Built on node:crypto only. */

const crypto = require('node:crypto');
const { db, pruneSessions } = require('./db');

const SESSION_COOKIE = 'ss_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;        // 8 hours
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// Throttling: after MAX_FAILS bad attempts the key is locked for LOCK_MS.
const MAX_FAILS = 6;
const LOCK_MS = 15 * 60 * 1000;

/* ---------------------------- passwords ---------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------------------- users ---------------------------- */

function createUser(email, password) {
  const normalized = String(email).trim().toLowerCase();
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalized, hashPassword(password));
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email).trim().toLowerCase());
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/* ---------------------------- throttling ---------------------------- */

function throttleKey(email, ip) {
  return crypto.createHash('sha256').update(`${String(email).toLowerCase()}|${ip}`)
    .digest('hex').slice(0, 32);
}

/** @returns {number} ms remaining on the lock, or 0 if not locked. */
function lockRemaining(key) {
  const row = db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key);
  if (!row) return 0;
  return Math.max(0, row.locked_until - Date.now());
}

function recordFailure(key) {
  const row = db.prepare('SELECT fails FROM login_attempts WHERE key = ?').get(key);
  const fails = (row ? row.fails : 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
  db.prepare(`
    INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until
  `).run(key, fails, lockedUntil);
  return { fails, lockedUntil };
}

function clearFailures(key) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/* ---------------------------- sessions ---------------------------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, user_id, csrf, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, csrf, now, now + SESSION_TTL_MS);
  return { token, csrf };
}

function getSession(token) {
  if (!token) return null;
  pruneSessions();
  const row = db.prepare(`
    SELECT s.*, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  return row || null;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

/** Invalidate every session for a user — used after a password change. */
function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/* ---------------------------- cookies ---------------------------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure }) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookie({ secure }) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Constant-time compare of a submitted CSRF token against the session's. */
function csrfOk(session, submitted) {
  if (!session || !submitted) return false;
  const a = Buffer.from(String(submitted));
  const b = Buffer.from(session.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  SESSION_COOKIE, MAX_FAILS, LOCK_MS,
  hashPassword, verifyPassword,
  createUser, findUserByEmail, countUsers,
  throttleKey, lockRemaining, recordFailure, clearFailures,
  createSession, getSession, destroySession, destroyUserSessions,
  parseCookies, sessionCookie, clearCookie, csrfOk,
};
