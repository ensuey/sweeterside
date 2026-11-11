'use strict';
/* The owner's corrections: a payment or a cash in / out entered wrongly is
   changed or deleted. Owner only (correct_entries): anyone else needs the
   owner's PIN, as for other overrides. Every correction gives a reason and
   goes in the audit log with what it was and what it became.

   A payment's order is paid or not paid again by what is left of its
   payments. A correction to a closed shift works its reading out again
   (shifts.recount), keeping the one printed at close. Refunded orders are
   not corrected here: their refunds are tied to what was paid. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const audit = require('./audit');
const staff = require('./staff');
const shifts = require('./shifts');

const REASON_MAX = 200;
const REFERENCE_MAX = 60;

const httpError = (status, message) => Object.assign(new Error(message), { status, body: { error: message } });

function reasonOf(raw) {
  const reason = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) throw new ValidationError({ why: 'Say why it is being corrected, e.g. "was GCash, not cash".' });
  if (reason.length > REASON_MAX) throw new ValidationError({ why: `Keep it under ${REASON_MAX} characters.` });
  return reason;
}

/** The owner, or the owner's PIN. @returns who approved it (null when the owner did it) */
function approve(actor, override) {
  return staff.authorise(actor, 'correct_entries', override).approver;
}

/* ---------------------------- payments ---------------------------- */

function paymentRow(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(id));
}

/** Paid or not, by what is left of the order's payments. */
function settleOrder(orderId) {
  const o = db.prepare('SELECT id, total_cents, paid_at FROM orders WHERE id = ?').get(orderId);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE order_id = ?').get(orderId).n;
  if (paid >= o.total_cents && !o.paid_at) {
    // Paid in full again: in the shift of its latest payment.
    const last = db.prepare('SELECT shift_id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
    db.prepare("UPDATE orders SET paid_at = datetime('now'), paid_shift_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(last ? last.shift_id : null, orderId);
  } else if (paid < o.total_cents && o.paid_at) {
    db.prepare("UPDATE orders SET paid_at = NULL, paid_shift_id = NULL, updated_at = datetime('now') WHERE id = ?").run(orderId);
  }
}

function recountAll(shiftIds, by) {
  for (const id of new Set(shiftIds.filter(Boolean))) shifts.recount(id, by);
}

function checkNotRefunded(p) {
  if (db.prepare('SELECT 1 FROM refunds WHERE order_id = ?').get(p.order_id)) {
    throw httpError(409, 'This order has a refund, so its payments cannot be corrected here. Ask for help.');
  }
}

/**
 * Change a payment's method, amount or reference. input: { method, amount
 * (pesos), reference, why, override }.
 */
function correctPayment(id, input, actor) {
  const { METHODS } = require('./payments');
  const p = paymentRow(id);
  if (!p) throw httpError(404, 'That payment no longer exists.');
  const approver = approve(actor, input.override);
  checkNotRefunded(p);
  const why = reasonOf(input.why);

  const method = input.method === undefined ? p.method : String(input.method);
  const m = METHODS[method];
  if (!m) throw new ValidationError({ method: 'Choose how they paid.' });
  const amount = input.amount === undefined ? p.amount_cents : shifts.cents(input.amount, 'amount', { min: 1 });
  const order = db.prepare('SELECT id, total_cents, paid_shift_id FROM orders WHERE id = ?').get(p.order_id);
  const others = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE order_id = ? AND id <> ?')
    .get(p.order_id, p.id).n;
  if (others + amount > order.total_cents) {
    throw new ValidationError({ amount: `That is more than the order's ${(order.total_cents / 100).toFixed(2)}.` });
  }
  const reference = input.reference === undefined ? p.reference : String(input.reference ?? '').trim();
  if (m.reference && !reference) throw new ValidationError({ reference: `Enter the ${m.label} reference.` });
  if (reference.length > REFERENCE_MAX) throw new ValidationError({ reference: 'That reference is too long.' });

  // Cash keeps what was handed over (or the amount, if less); the rest has none.
  let tendered = null;
  let change = 0;
  if (m.drawer) {
    if (!p.shift_id) throw httpError(409, 'This payment was taken with no shift open, so it cannot become cash.');
    tendered = Math.max(p.tendered_cents ?? 0, amount);
    change = tendered - amount;
  }
  const before = { method: p.method, amount_cents: p.amount_cents, reference: p.reference };
  const after = { method, amount_cents: amount, reference: m.reference ? reference : '' };
  if (before.method === after.method && before.amount_cents === after.amount_cents && before.reference === after.reference) {
    throw new ValidationError({ why: 'Nothing is different. Change the method, the amount or the reference.' });
  }

  return transaction(() => {
    db.prepare('UPDATE payments SET method = ?, amount_cents = ?, reference = ?, tendered_cents = ?, change_cents = ? WHERE id = ?')
      .run(after.method, after.amount_cents, after.reference, tendered, change, p.id);
    settleOrder(p.order_id);
    audit.record({ action: 'payment_correct', staff: actor, approver, order_id: p.order_id, amount_cents: amount, reason: why,
      details: { payment_id: p.id, shift_id: p.shift_id, before, after } });
    recountAll([p.shift_id, order.paid_shift_id], approver || actor);
    return { payment: paymentRow(p.id) };
  });
}

/** Delete a payment entered by mistake. input: { why, override }. */
function deletePayment(id, input, actor) {
  const p = paymentRow(id);
  if (!p) throw httpError(404, 'That payment no longer exists.');
  const approver = approve(actor, input.override);
  checkNotRefunded(p);
  const why = reasonOf(input.why);
  const order = db.prepare('SELECT paid_shift_id FROM orders WHERE id = ?').get(p.order_id);
  return transaction(() => {
    db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    settleOrder(p.order_id);
    audit.record({ action: 'payment_delete', staff: actor, approver, order_id: p.order_id, amount_cents: p.amount_cents, reason: why,
      details: { payment_id: p.id, shift_id: p.shift_id, method: p.method, reference: p.reference } });
    recountAll([p.shift_id, order.paid_shift_id], approver || actor);
    return { ok: true };
  });
}

/* ---------------------------- cash in / out ---------------------------- */

function moveRow(id) {
  return db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(Number(id));
}

/** Change a cash in / out. input: { kind, amount (pesos), reason (what it was for), why, override }. */
function correctMove(id, input, actor) {
  const mv = moveRow(id);
  if (!mv) throw httpError(404, 'That cash entry no longer exists.');
  const approver = approve(actor, input.override);
  const why = reasonOf(input.why);
  const kind = input.kind === undefined ? mv.kind : String(input.kind);
  if (kind !== 'in' && kind !== 'out') throw new ValidationError({ kind: 'Choose cash in or cash out.' });
  const amount = input.amount === undefined ? mv.amount_cents : shifts.cents(input.amount, 'amount', { min: 1 });
  const reason = input.reason === undefined ? mv.reason : String(input.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) throw new ValidationError({ reason: 'Say what the cash was for.' });
  if (reason.length > REASON_MAX) throw new ValidationError({ reason: `Keep it under ${REASON_MAX} characters.` });
  const before = { kind: mv.kind, amount_cents: mv.amount_cents, reason: mv.reason };
  const after = { kind, amount_cents: amount, reason };
  if (before.kind === after.kind && before.amount_cents === after.amount_cents && before.reason === after.reason) {
    throw new ValidationError({ why: 'Nothing is different. Change in / out, the amount or what it was for.' });
  }
  return transaction(() => {
    db.prepare('UPDATE cash_movements SET kind = ?, amount_cents = ?, reason = ? WHERE id = ?').run(kind, amount, reason, mv.id);
    audit.record({ action: 'cash_move_correct', staff: actor, approver, amount_cents: amount, reason: why,
      details: { move_id: mv.id, shift_id: mv.shift_id, before, after } });
    recountAll([mv.shift_id], approver || actor);
    return { move: moveRow(mv.id) };
  });
}

/** Delete a cash in / out entered by mistake. input: { why, override }. */
function deleteMove(id, input, actor) {
  const mv = moveRow(id);
  if (!mv) throw httpError(404, 'That cash entry no longer exists.');
  const approver = approve(actor, input.override);
  const why = reasonOf(input.why);
  return transaction(() => {
    db.prepare('DELETE FROM cash_movements WHERE id = ?').run(mv.id);
    audit.record({ action: 'cash_move_delete', staff: actor, approver, amount_cents: mv.amount_cents, reason: why,
      details: { move_id: mv.id, shift_id: mv.shift_id, kind: mv.kind, reason: mv.reason } });
    recountAll([mv.shift_id], approver || actor);
    return { ok: true };
  });
}

/* ---------------------------- the list to correct from ---------------------------- */

/**
 * A shift's payments and cash in / out, for the correction screen.
 * shiftId: a shift, or the open one when absent.
 */
function entries(shiftId) {
  const shift = shiftId ? shifts.get(Number(shiftId)) : shifts.current();
  if (!shift) return null;
  const payments = db.prepare(`
    SELECT p.id, p.order_id, p.method, p.amount_cents, p.tendered_cents, p.change_cents, p.reference, p.at,
           s.name AS staff, o.order_type, o.table_no, o.source,
           (SELECT 1 FROM refunds r WHERE r.order_id = p.order_id LIMIT 1) AS refunded
    FROM payments p JOIN staff s ON s.id = p.staff_id JOIN orders o ON o.id = p.order_id
    WHERE p.shift_id = ? ORDER BY p.id DESC`).all(shift.id).map((r) => ({ ...r, refunded: r.refunded === 1 }));
  const moves = db.prepare(`
    SELECT m.id, m.kind, m.amount_cents, m.reason, m.at, s.name AS staff
    FROM cash_movements m JOIN staff s ON s.id = m.staff_id
    WHERE m.shift_id = ? ORDER BY m.id DESC`).all(shift.id);
  return {
    shift: { id: shift.id, opened_at: shift.opened_at, closed_at: shift.closed_at, corrected_at: shift.corrected_at },
    payments, moves,
  };
}

module.exports = { correctPayment, deletePayment, correctMove, deleteMove, entries };
