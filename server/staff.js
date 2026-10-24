'use strict';
/* Staff, their PINs, their turns at the counter tablet, and what each role
   may do.

   The tablet stays signed in as the admin. A staff member taps their name and
   types their 4-6 digit PIN, which opens a staff session under that admin
   session: a random token (only its SHA-256 is stored) that the POS sends with
   every request. It locks after pos_lock_minutes without use, when the admin
   signs out, or when the staff member is switched off or their PIN changes.

   A manager override is an owner typing their own PIN on the screen for one
   action; approve() checks it and the action is logged with the owner as
   the approver. */

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const { hashPassword, verifyPassword } = require('./auth');
const { posSettings } = require('./settings');
const audit = require('./audit');

const ROLES = ['owner', 'cashier', 'waiter'];
const NAME_MAX = 40;
const PIN_RE = /^\d{4,6}$/;
// Five wrong PINs lock that staff member out for five minutes.
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

/* What each role may do. The owner may do everything. Anything only the owner
   may do, someone else can still do with an owner's override. */
const PERMISSIONS = {
  take_orders: ['owner', 'cashier', 'waiter'],
  send_to_kitchen: ['owner', 'cashier', 'waiter'],
  // Waiters take dine-in orders only.
  takeout_and_delivery: ['owner', 'cashier'],
  take_payment: ['owner', 'cashier'],
  claim_sc_pwd: ['owner', 'cashier'],
  apply_voucher: ['owner', 'cashier'],
  manual_discount: ['owner', 'cashier'], // up to the cashier limit
  change_delivery_fee: ['owner', 'cashier'],
  remove_service_charge: ['owner', 'cashier'],
  manage_shift: ['owner', 'cashier'],
  cash_movement: ['owner', 'cashier'],
  see_id_numbers: ['owner', 'cashier'],
  void: ['owner'],
  refund: ['owner'],
  price_override: ['owner'],
  discount_over_limit: ['owner'],
  reports: ['owner'],
  audit: ['owner'],
  manage_staff: ['owner'],
  tax_settings: ['owner'],
};

function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, body: { error: message, ...extra } });

/* ---------------------------- staff ---------------------------- */

function publicStaff(row) {
  return row ? { id: row.id, name: row.name, role: row.role, active: row.active === 1 } : null;
}

function get(id) {
  return publicStaff(db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(id)));
}

/** Active staff for the PIN screen, or everyone (incl. switched off) for the Staff page. */
function list({ all = false } = {}) {
  return db.prepare(`SELECT * FROM staff ${all ? '' : 'WHERE active = 1'}
                     ORDER BY active DESC, CASE role WHEN 'owner' THEN 0 WHEN 'cashier' THEN 1 ELSE 2 END, name`)
    .all().map(publicStaff);
}

function activeOwners() {
  return db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1").get().n;
}

function hasStaff() {
  return db.prepare('SELECT COUNT(*) AS n FROM staff').get().n > 0;
}

/** Four to six digits, and not one an onlooker would guess (1111, 1234, 4321). */
function pinProblem(pin) {
  const p = String(pin ?? '');
  if (!PIN_RE.test(p)) return 'Use a PIN of 4 to 6 digits.';
  const digits = [...p].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'That PIN is too easy to guess. Choose another.';
  }
  return null;
}

function validate(input, { needPin }) {
  const errors = {};
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;
  const role = String(input.role ?? '');
  if (!ROLES.includes(role)) errors.role = 'Choose owner, cashier or waiter.';
  if (needPin) {
    const problem = pinProblem(input.pin);
    if (problem) errors.pin = problem;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, role };
}

/** by: the staff member making the change, or null for the very first owner. */
function create(input, by) {
  const row = validate(input, { needPin: true });
  if (!by && hasStaff()) throw httpError(403, 'Only the owner can add staff.');
  if (!by && row.role !== 'owner') throw new ValidationError({ role: 'The first staff member must be the owner.' });
  return transaction(() => {
    const info = db.prepare('INSERT INTO staff (name, role, pin_hash) VALUES (?, ?, ?)')
      .run(row.name, row.role, hashPassword(String(input.pin)));
    const added = get(info.lastInsertRowid);
    audit.record({ action: 'staff_add', staff: by || added, details: { id: added.id, name: added.name, role: added.role } });
    return added;
  });
}

/** Rename, change role, or switch on/off. The last active owner stays an active owner. */
function update(id, input, by) {
  const before = get(id);
  if (!before) return null;
  const row = validate({ name: input.name ?? before.name, role: input.role ?? before.role }, { needPin: false });
  const active = input.active === undefined ? before.active : input.active === true;
  const losesOwner = before.role === 'owner' && before.active && (row.role !== 'owner' || !active);
  if (losesOwner && activeOwners() <= 1) {
    throw new ValidationError({ role: 'Keep at least one active owner: add another owner first.' });
  }
  return transaction(() => {
    db.prepare("UPDATE staff SET name = ?, role = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(row.name, row.role, active ? 1 : 0, Number(id));
    // A role change or switching off ends their turn at the tablet.
    if (!active || row.role !== before.role) db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(Number(id));
    const after = get(id);
    audit.record({ action: 'staff_change', staff: by, details: { id: after.id, before, after } });
    return after;
  });
}

function resetPin(id, pin, by) {
  const target = get(id);
  if (!target) return null;
  const problem = pinProblem(pin);
  if (problem) throw new ValidationError({ pin: problem });
  return transaction(() => {
    db.prepare("UPDATE staff SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hashPassword(String(pin)), Number(id));
    db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(Number(id));
    db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`pin:${Number(id)}`);
    audit.record({ action: 'staff_pin_change', staff: by, details: { id: target.id, name: target.name } });
    return target;
  });
}

/* ---------------------------- PINs ---------------------------- */

function pinLock(id) {
  const row = db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').get(`pin:${id}`);
  return row || { fails: 0, locked_until: 0 };
}

/**
 * Check a staff member's PIN, with throttling.
 * @returns the staff member
 * A wrong PIN is a 403 with wrong_pin (not a 401, which the admin pages
 * take to mean signed out).
 * @throws 403 wrong PIN or switched off, 429 locked
 */
function verifyPin(id, pin, now = Date.now()) {
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(id));
  if (!row) throw httpError(403, 'Choose your name, then type your PIN.', { wrong_pin: true });
  if (row.active !== 1) throw httpError(403, 'This staff member is switched off. Ask the owner.');
  const lock = pinLock(row.id);
  if (lock.locked_until > now) {
    throw httpError(429, `Too many wrong PINs. Try again in ${Math.ceil((lock.locked_until - now) / 60000)} minute(s).`);
  }
  if (!verifyPassword(String(pin ?? ''), row.pin_hash)) {
    const fails = (lock.locked_until && lock.locked_until <= now ? 0 : lock.fails) + 1;
    const lockedUntil = fails >= PIN_MAX_FAILS ? now + PIN_LOCK_MS : 0;
    db.prepare(`INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`)
      .run(`pin:${row.id}`, lockedUntil ? 0 : fails, lockedUntil);
    const left = PIN_MAX_FAILS - fails;
    throw httpError(lockedUntil ? 429 : 403, lockedUntil
      ? 'Too many wrong PINs. Try again in 5 minutes.'
      : `Wrong PIN.${left <= 2 ? ` ${left} more tries before a 5-minute lock.` : ''}`, lockedUntil ? {} : { wrong_pin: true });
  }
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`pin:${row.id}`);
  return publicStaff(row);
}

/* ---------------------------- sessions ---------------------------- */

/** Open a staff session under the admin session `adminSessionId` (its hashed id). */
function unlock(staffId, pin, adminSessionId, now = Date.now()) {
  const member = verifyPin(staffId, pin, now);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO staff_sessions (id, staff_id, admin_session, created_at, last_seen)
              VALUES (?, ?, ?, ?, ?)`).run(sha256(token), member.id, adminSessionId, now, now);
  return { token, staff: member, lock_minutes: posSettings().pos_lock_minutes };
}

/**
 * The staff member at the tablet, or null when locked: no such token, opened
 * under another admin session, idle too long, or switched off since.
 * Each successful call counts as use and pushes the idle lock back.
 */
function current(token, adminSessionId, now = Date.now()) {
  if (!token || !adminSessionId) return null;
  const id = sha256(String(token));
  const row = db.prepare(`
    SELECT ss.last_seen, ss.admin_session, s.* FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
    WHERE ss.id = ?`).get(id);
  if (!row || row.admin_session !== adminSessionId) return null;
  const idleMs = posSettings().pos_lock_minutes * 60 * 1000;
  if (row.active !== 1 || now - row.last_seen > idleMs) {
    db.prepare('DELETE FROM staff_sessions WHERE id = ?').run(id);
    return null;
  }
  db.prepare('UPDATE staff_sessions SET last_seen = ? WHERE id = ?').run(now, id);
  return publicStaff(row);
}

function lock(token) {
  if (token) db.prepare('DELETE FROM staff_sessions WHERE id = ?').run(sha256(String(token)));
}

/* ---------------------------- overrides ---------------------------- */

/**
 * Who may do `permission`: the acting staff member if their role allows it,
 * otherwise the approver named in `override` ({ staff_id, pin }) if their
 * PIN is right and their role allows it.
 * @returns {{ approver: staff|null }} approver is null when no override was needed
 * @throws 403 with override_required: true when nobody suitable approved
 */
function authorise(actor, permission, override, now = Date.now()) {
  if (actor && can(actor.role, permission)) return { approver: null };
  if (!override || override.staff_id === undefined) {
    throw httpError(403, 'This needs a manager: ask the owner to enter their PIN.', { override_required: true, permission });
  }
  const approver = verifyPin(override.staff_id, override.pin, now);
  if (!can(approver.role, permission)) {
    throw httpError(403, `${approver.name} cannot approve this. Ask the owner.`, { override_required: true, permission });
  }
  return { approver };
}

module.exports = {
  ROLES, PERMISSIONS, PIN_MAX_FAILS, PIN_LOCK_MS,
  can, list, get, hasStaff, activeOwners, create, update, resetPin, pinProblem,
  verifyPin, unlock, current, lock, authorise,
};
