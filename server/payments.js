'use strict';
/* Payments and refunds on POS orders, and what goes on the receipt.

   An order can be paid in parts, by more than one method; it is Paid only
   when the payments cover the total. Cash needs an open shift (the drawer)
   and records what was handed over and the change; the other methods are
   paid outside the POS (the customer's wallet, the card terminal) and need
   the reference number from it.

   A refund (full, or some of the lines) needs the owner, or an owner's PIN,
   and a reason. It is paid back by a method of the cashier's choosing; cash
   comes out of the drawer.

   Adding a payment provider later (PayMongo): add it to METHODS with
   `provider` set. pay() records a payment only once the provider has
   confirmed it and given a reference, so the rest of the flow (paid when
   covered, shift readings, receipts) stays as it is. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const pos = require('./pos');
const orders = require('./orders');
const shifts = require('./shifts');
const staff = require('./staff');
const audit = require('./audit');
const settings = require('./settings');
const pricing = require('./pricing');

const METHODS = {
  cash: { label: 'Cash', reference: false, drawer: true },
  gcash: { label: 'GCash', reference: true },
  maya: { label: 'Maya', reference: true },
  qrph: { label: 'QR Ph', reference: true },
  card: { label: 'Card (terminal)', reference: true },
};
const REFERENCE_MAX = 60;
const REASON_MAX = 200;
const MAX_PARTS = 5;

const { httpError } = pos;

function refundedCents(orderId) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE order_id = ?').get(orderId).n;
}

function paymentsOf(orderId) {
  return db.prepare(`SELECT p.id, p.method, p.amount_cents, p.tendered_cents, p.change_cents, p.reference, p.at,
                            s.name AS staff FROM payments p JOIN staff s ON s.id = p.staff_id
                     WHERE p.order_id = ? ORDER BY p.id`).all(orderId)
    .map((p) => ({ ...p, label: (METHODS[p.method] || { label: p.method }).label }));
}

function refundsOf(orderId) {
  return db.prepare(`SELECT r.id, r.method, r.amount_cents, r.reference, r.reason, r.lines, r.at,
                            s.name AS staff, a.name AS approver
                     FROM refunds r JOIN staff s ON s.id = r.staff_id LEFT JOIN staff a ON a.id = r.approved_by
                     WHERE r.order_id = ? ORDER BY r.id`).all(orderId)
    .map((r) => ({ ...r, lines: r.lines ? JSON.parse(r.lines) : null, label: (METHODS[r.method] || { label: r.method }).label }));
}

function posOrder(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND source = 'pos'").get(Number(id));
  if (!o) throw httpError(404, 'That order is not a POS order or no longer exists.');
  return o;
}

function checkKey(key) {
  if (!pos.KEY_RE.test(String(key ?? ''))) throw new ValidationError({ request_key: 'Missing request key. Reload the POS.' });
  return String(key);
}

/** Where an order stands: total, paid, still due, refunded. */
function balance(orderId) {
  const o = db.prepare('SELECT total_cents, paid_at FROM orders WHERE id = ?').get(orderId);
  const paid = pos.paidCents(orderId);
  return {
    total_cents: o.total_cents, paid_cents: paid, due_cents: Math.max(0, o.total_cents - paid),
    refunded_cents: refundedCents(orderId), paid: !!o.paid_at,
  };
}

/* ---------------------------- paying ---------------------------- */

/**
 * Take payment. body: { request_key, payments: [{ method, amount, tendered?, reference? }],
 *                       send?, override? } with pesos.
 * For cash, amount is what goes towards the order and tendered what was
 * handed over (at least the amount); the difference is the change.
 * @returns {{ order, balance, payments, change_cents, kitchen }}
 */
function pay(orderId, body, actor) {
  const key = checkKey(body.request_key);
  const done = db.prepare('SELECT order_id FROM payments WHERE request_key = ? LIMIT 1').get(key);
  const o = posOrder(orderId);
  if (done) return result(o.id, actor, 0, [], true);

  const approver = staff.authorise(actor, 'take_payment', body.override).approver;
  if (o.status === 'cancelled') throw httpError(409, 'This order was voided.');
  if (o.paid_at) throw httpError(409, 'This order is already paid.');
  const parts = Array.isArray(body.payments) ? body.payments : [];
  if (!parts.length || parts.length > MAX_PARTS) throw new ValidationError({ payments: 'Add a payment.' });

  let due = o.total_cents - pos.paidCents(o.id);
  if (due <= 0) throw httpError(409, 'Nothing is due on this order.');
  const shift = shifts.current();
  const rows = [];
  for (const p of parts) {
    const method = String(p.method ?? '');
    const m = METHODS[method];
    if (!m) throw new ValidationError({ payments: 'Choose how they paid.' });
    const amount = shifts.cents(p.amount, 'payments', { min: 1 });
    if (amount > due) {
      throw new ValidationError({ payments: `That is more than the ${(due / 100).toFixed(2)} still due.` });
    }
    let tendered = null;
    let change = 0;
    if (m.drawer) {
      if (!shift) throw httpError(409, 'Open a shift before taking cash.', { code: 'no_shift' });
      tendered = p.tendered === undefined || p.tendered === null || p.tendered === '' ? amount : shifts.cents(p.tendered, 'tendered');
      if (tendered < amount) throw new ValidationError({ tendered: 'The cash handed over is less than the amount.' });
      change = tendered - amount;
    }
    const reference = String(p.reference ?? '').trim();
    if (m.reference && !reference) throw new ValidationError({ reference: `Enter the ${m.label} reference number.` });
    if (reference.length > REFERENCE_MAX) throw new ValidationError({ reference: 'That reference is too long.' });
    rows.push({ method, amount, tendered, change, reference });
    due -= amount;
  }

  return transaction(() => {
    const insert = db.prepare(`INSERT INTO payments (order_id, shift_id, method, amount_cents, tendered_cents, change_cents,
                                 reference, staff_id, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // The request key goes on the first row only (it is unique).
    rows.forEach((r, i) => insert.run(o.id, shift ? shift.id : null, r.method, r.amount, r.tendered, r.change,
      r.reference, actor.id, i === 0 ? key : null));
    if (approver) {
      audit.record({ action: 'override', staff: actor, approver, order_id: o.id, details: { permissions: ['take_payment'] } });
    }
    if (pos.paidCents(o.id) >= o.total_cents) {
      db.prepare("UPDATE orders SET paid_at = datetime('now'), paid_shift_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(shift ? shift.id : null, o.id);
    }
    const kitchen = body.send === true ? pos.sendToKitchen(o.id) : [];
    return result(o.id, actor, rows.reduce((s, r) => s + r.change, 0), kitchen, false);
  });
}

function result(orderId, actor, change, kitchen, replayed) {
  return {
    order: pos.view(orderId, actor), balance: balance(orderId), payments: paymentsOf(orderId),
    change_cents: change, kitchen, replayed,
  };
}

/* ---------------------------- refunds ---------------------------- */

/**
 * Refund a paid order. body: { request_key, lines?: [{ line_id, qty }],
 * method, reference?, reason, override? }. Without lines, everything not yet
 * refunded is refunded. A line's refund is its share of what the line came
 * to after every discount.
 */
function refund(orderId, body, actor) {
  const key = checkKey(body.request_key);
  const o = posOrder(orderId);
  if (db.prepare('SELECT 1 FROM refunds WHERE request_key = ?').get(key)) {
    return { order: pos.view(o.id, actor), balance: balance(o.id), refunds: refundsOf(o.id), replayed: true };
  }
  if (!o.paid_at) throw httpError(409, 'Only a paid order can be refunded. Void it instead.');
  const reason = String(body.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) throw new ValidationError({ reason: 'Give a reason for the refund.' });
  if (reason.length > REASON_MAX) throw new ValidationError({ reason: `Keep it under ${REASON_MAX} characters.` });
  const method = String(body.method ?? '');
  const m = METHODS[method];
  if (!m) throw new ValidationError({ method: 'Choose how the money goes back.' });
  const reference = String(body.reference ?? '').trim().slice(0, REFERENCE_MAX);
  const shift = shifts.current();
  if (m.drawer && !shift) throw httpError(409, 'Open a shift before giving cash back.', { code: 'no_shift' });

  const left = pos.paidCents(o.id) - refundedCents(o.id);
  let amount = left;
  let lines = null;
  if (Array.isArray(body.lines) && body.lines.length) {
    const all = pos.lineRows(o.id);
    const rows = new Map(all.map((l) => [l.id, l]));
    // A refunded line takes back its share of the service charge too.
    const netAll = all.reduce((s, l) => s + l.net_cents, 0);
    const withService = (c) => c + (netAll ? pricing.roundDiv(o.service_charge_cents * c, netAll) : 0);
    const already = new Map();
    for (const r of refundsOf(o.id)) for (const l of r.lines || []) already.set(l.line_id, (already.get(l.line_id) || 0) + l.qty);
    lines = body.lines.map((x) => {
      const l = rows.get(Number(x.line_id));
      const qty = Number(x.qty);
      const charged = l ? l.qty - l.voided_qty : 0;
      if (!l || !Number.isInteger(qty) || qty < 1 || qty + (already.get(l.id) || 0) > charged) {
        throw new ValidationError({ lines: 'Check the quantities to refund.' });
      }
      return { line_id: l.id, name: l.name, qty, amount_cents: withService(pricing.roundDiv(l.net_cents * qty, charged)) };
    });
    amount = lines.reduce((s, l) => s + l.amount_cents, 0);
  }
  if (amount <= 0 || amount > left) throw new ValidationError({ lines: 'There is nothing left to refund on that.' });
  if (m.drawer && amount > shifts.reading(shift).cash.expected_cents) {
    throw new ValidationError({ method: 'There is not enough cash in the drawer for that.' });
  }

  const approver = staff.authorise(actor, 'refund', body.override).approver;
  return transaction(() => {
    db.prepare(`INSERT INTO refunds (order_id, shift_id, method, amount_cents, reference, reason, lines, staff_id,
                  approved_by, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.id, shift ? shift.id : null, method, amount, reference, reason, lines ? JSON.stringify(lines) : '',
        actor.id, approver ? approver.id : null, key);
    db.prepare("UPDATE orders SET refunded_cents = refunded_cents + ?, updated_at = datetime('now') WHERE id = ?")
      .run(amount, o.id);
    audit.record({ action: 'refund', staff: actor, approver, order_id: o.id, amount_cents: amount, reason,
      details: { method, lines } });
    if (approver) audit.record({ action: 'override', staff: actor, approver, order_id: o.id, details: { permissions: ['refund'] } });
    return { order: pos.view(o.id, actor), balance: balance(o.id), refunds: refundsOf(o.id), replayed: false };
  });
}

/* ---------------------------- receipts ---------------------------- */

/**
 * Everything the printed receipt shows. SC/PWD ID numbers are in full for
 * the owner and cashiers (the slip goes to the customer); masked otherwise.
 */
function receipt(orderId, actor) {
  const o = posOrder(orderId);
  const order = orders.get(o.id, { fullIds: staff.can(actor.role, 'see_id_numbers') });
  const cashier = db.prepare(`SELECT s.name FROM payments p JOIN staff s ON s.id = p.staff_id
                              WHERE p.order_id = ? ORDER BY p.id DESC LIMIT 1`).get(o.id)
    || db.prepare('SELECT name FROM staff WHERE id = ?').get(o.staff_id) || { name: '' };
  return {
    order, payments: paymentsOf(o.id), refunds: refundsOf(o.id), balance: balance(o.id),
    cashier: cashier.name, settings: settings.receiptSettings(),
  };
}

/** Recent POS orders for reprinting and refunds: paid ones, newest first. */
function recent(limit = 40) {
  return db.prepare(`
    SELECT o.id, o.order_type, o.table_no, o.customer_name, o.total_cents, o.refunded_cents, o.paid_at, o.status,
           (SELECT GROUP_CONCAT(DISTINCT method) FROM payments WHERE order_id = o.id) AS methods
    FROM orders o WHERE o.source = 'pos' AND o.paid_at IS NOT NULL ORDER BY o.paid_at DESC, o.id DESC LIMIT ?`)
    .all(limit);
}

module.exports = { METHODS, balance, pay, refund, receipt, recent, paymentsOf, refundsOf, refundedCents };
