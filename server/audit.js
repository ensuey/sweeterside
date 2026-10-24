'use strict';
/* The audit log: voids, refunds, manager overrides, price changes, manual
   discounts, service charge removals, drawer cash in and out, shifts and
   staff changes. Append-only: the database refuses updates and deletes
   (see the triggers in db.js), and this module has no way to make either. */

const { db } = require('./db');
const { manilaDateStartSql, addDays } = require('./clock');

const ACTIONS = [
  'void', 'refund', 'override', 'price_change', 'manual_discount', 'service_charge_removed',
  'delivery_fee_changed', 'cash_in', 'cash_out', 'shift_open', 'shift_close',
  'staff_add', 'staff_change', 'staff_pin_change', 'settings_change',
];

/**
 * Add an entry.
 * entry: { action, staff: {id, name} | null, approver: {id, name} | null,
 *          order_id, amount_cents, reason, details (any JSON value) }
 */
function record(entry) {
  if (!ACTIONS.includes(entry.action)) throw new Error(`Unknown audit action: ${entry.action}`);
  const info = db.prepare(`
    INSERT INTO audit_log (action, staff_id, staff_name, approved_by, approver_name,
                           order_id, amount_cents, reason, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.action,
    entry.staff ? entry.staff.id : null, entry.staff ? entry.staff.name : '',
    entry.approver ? entry.approver.id : null, entry.approver ? entry.approver.name : '',
    entry.order_id ?? null, entry.amount_cents ?? null, String(entry.reason ?? ''),
    entry.details === undefined ? '' : JSON.stringify(entry.details));
  return info.lastInsertRowid;
}

/**
 * Entries, newest first. filter: { from, to } (Manila 'YYYY-MM-DD', both
 * included), action, staff_id (as actor or approver), limit.
 */
function list({ from, to, action, staff_id: staffId, limit = 1000 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('at >= ?'); params.push(manilaDateStartSql(from)); }
  if (to) { where.push('at < ?'); params.push(manilaDateStartSql(addDays(to, 1))); }
  if (action) { where.push('action = ?'); params.push(String(action)); }
  if (staffId) { where.push('(staff_id = ? OR approved_by = ?)'); params.push(Number(staffId), Number(staffId)); }
  return db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     ORDER BY id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 1000, 10000))
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

module.exports = { ACTIONS, record, list };
