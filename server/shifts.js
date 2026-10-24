'use strict';
/* Shifts and the cash drawer.

   A shift opens with the starting cash and closes with the cash counted.
   In between: cash payments and cash refunds (payments.js), and cash in or
   out with a reason ("bought ice, Php 80"). One drawer, so one open shift.

   The reading of a shift (X during the day, Z at close) is worked out from
   what was recorded in it:
     sales      orders fully paid in the shift (orders.paid_shift_id):
                gross, each kind of discount, service charge, delivery fees
     payments   by method, refunds by method
     voids      from the audit log, during the shift
     cash       expected = opening + cash taken - cash refunded + in - out
   The Z reading is saved with the shift when it closes, so it reads the same
   later even if something is changed afterwards. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const audit = require('./audit');

const REASON_MAX = 200;
const NOTE_MAX = 300;
const MAX_CASH_CENTS = 10000000 * 100;

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, body: { error: message, ...extra } });

/** Pesos (up to two decimals) -> centavos, or throws a ValidationError on `field`. */
function cents(raw, field, { min = 0 } = {}) {
  const n = Number(raw);
  const c = Math.round(n * 100);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)
      || Math.abs(n * 100 - c) > 1e-6 || c < min || c > MAX_CASH_CENTS) {
    throw new ValidationError({ [field]: 'Enter an amount in pesos, with at most two decimals.' });
  }
  return c;
}

function current() {
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() || null;
}

function get(id) {
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(id)) || null;
}

function staffName(id) {
  const row = id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id) : null;
  return row ? row.name : '';
}

function open(input, actor) {
  if (current()) throw httpError(409, 'A shift is already open. Close it before opening another.');
  const opening = cents(input.opening_cash, 'opening_cash');
  return transaction(() => {
    const id = db.prepare('INSERT INTO shifts (opened_by, opening_cash_cents) VALUES (?, ?)')
      .run(actor.id, opening).lastInsertRowid;
    audit.record({ action: 'shift_open', staff: actor, amount_cents: opening, details: { shift_id: id } });
    return reading(get(id));
  });
}

/** Cash put into (in) or taken out of (out) the drawer, with a reason. */
function cashMove(input, actor) {
  const shift = current();
  if (!shift) throw httpError(409, 'Open a shift first.');
  const kind = String(input.kind ?? '');
  if (kind !== 'in' && kind !== 'out') throw new ValidationError({ kind: 'Choose cash in or cash out.' });
  const amount = cents(input.amount, 'amount', { min: 1 });
  const reason = String(input.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) throw new ValidationError({ reason: 'Say what the cash was for.' });
  if (reason.length > REASON_MAX) throw new ValidationError({ reason: `Keep it under ${REASON_MAX} characters.` });
  if (kind === 'out' && amount > reading(shift).cash.expected_cents) {
    throw new ValidationError({ amount: 'There is not that much cash in the drawer.' });
  }
  return transaction(() => {
    db.prepare('INSERT INTO cash_movements (shift_id, kind, amount_cents, reason, staff_id) VALUES (?, ?, ?, ?, ?)')
      .run(shift.id, kind, amount, reason, actor.id);
    audit.record({ action: kind === 'in' ? 'cash_in' : 'cash_out', staff: actor, amount_cents: amount, reason,
      details: { shift_id: shift.id } });
    return reading(shift);
  });
}

/**
 * The reading of a shift: an X reading while it is open, the same figures
 * as the Z reading once it closes.
 */
function reading(shift, now = new Date()) {
  const until = shift.closed_at || now.toISOString().slice(0, 19).replace('T', ' ');
  const sales = db.prepare(`
    SELECT COUNT(*) AS orders,
           COALESCE(SUM(gross_cents), 0) AS gross,
           COALESCE(SUM(gross_cents - subtotal_cents), 0) AS sale,
           COALESCE(SUM(sc_pwd_discount_cents), 0) AS sc_pwd,
           COALESCE(SUM(vat_exempt_cents), 0) AS vat_exempt,
           COALESCE(SUM(discount_cents), 0) AS voucher,
           COALESCE(SUM(manual_discount_cents), 0) AS manual,
           COALESCE(SUM(service_charge_cents), 0) AS service_charge,
           COALESCE(SUM(delivery_fee_cents), 0) AS delivery_fees,
           COALESCE(SUM(total_cents), 0) AS total
    FROM orders WHERE paid_shift_id = ?`).get(shift.id);
  const byMethod = (table) => Object.fromEntries(db.prepare(`
    SELECT method, COUNT(*) AS n, SUM(amount_cents) AS amount FROM ${table} WHERE shift_id = ? GROUP BY method`)
    .all(shift.id).map((r) => [r.method, { count: r.n, amount_cents: r.amount }]));
  const payments = byMethod('payments');
  const refunds = byMethod('refunds');
  const moves = db.prepare(`SELECT kind, COALESCE(SUM(amount_cents), 0) AS amount FROM cash_movements
                            WHERE shift_id = ? GROUP BY kind`).all(shift.id);
  const moved = (k) => (moves.find((m) => m.kind === k) || { amount: 0 }).amount;
  const voids = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS amount FROM audit_log
                            WHERE action = 'void' AND at >= ? AND at <= ?`).get(shift.opened_at, until);
  const sum = (o) => Object.values(o).reduce((s, x) => s + x.amount_cents, 0);

  const cashIn = (payments.cash || { amount_cents: 0 }).amount_cents;
  const cashRefunds = (refunds.cash || { amount_cents: 0 }).amount_cents;
  const expected = shift.opening_cash_cents + cashIn - cashRefunds + moved('in') - moved('out');
  const discounts = {
    sale: sales.sale, sc_pwd: sales.sc_pwd, vat_exempt: sales.vat_exempt, voucher: sales.voucher, manual: sales.manual,
  };
  return {
    shift: {
      id: shift.id, opened_at: shift.opened_at, opened_by: staffName(shift.opened_by),
      closed_at: shift.closed_at, closed_by: staffName(shift.closed_by), until,
    },
    kind: shift.closed_at ? 'Z' : 'X',
    sales: {
      orders: sales.orders,
      gross_cents: sales.gross,
      discounts,
      discounts_cents: Object.values(discounts).reduce((s, x) => s + x, 0),
      // What the items sold for after every discount: the shop's sales.
      net_sales_cents: sales.total - sales.service_charge - sales.delivery_fees,
      service_charge_cents: sales.service_charge,
      delivery_fees_cents: sales.delivery_fees,
      total_cents: sales.total,
    },
    voids: { count: voids.n, amount_cents: voids.amount },
    refunds: { by_method: refunds, total_cents: sum(refunds) },
    payments: { by_method: payments, total_cents: sum(payments) },
    cash: {
      opening_cents: shift.opening_cash_cents,
      sales_cents: cashIn,
      refunds_cents: cashRefunds,
      in_cents: moved('in'),
      out_cents: moved('out'),
      expected_cents: expected,
      counted_cents: shift.counted_cash_cents,
      difference_cents: shift.counted_cash_cents === null ? null : shift.counted_cash_cents - expected,
    },
    movements: db.prepare(`SELECT m.kind, m.amount_cents, m.reason, m.at, s.name AS staff
                           FROM cash_movements m JOIN staff s ON s.id = m.staff_id
                           WHERE m.shift_id = ? ORDER BY m.id`).all(shift.id),
    note: shift.close_note,
  };
}

/** Close the open shift with the cash counted. @returns the Z reading */
function close(input, actor) {
  const shift = current();
  if (!shift) throw httpError(409, 'No shift is open.');
  const counted = cents(input.counted_cash, 'counted_cash');
  const note = String(input.note ?? '').trim().slice(0, NOTE_MAX + 1);
  if (note.length > NOTE_MAX) throw new ValidationError({ note: `Keep the note under ${NOTE_MAX} characters.` });
  const expected = reading(shift).cash.expected_cents;
  if (counted !== expected && !note) {
    throw new ValidationError({ note: 'The count is different from what is expected: add a note.' });
  }
  return transaction(() => {
    db.prepare(`UPDATE shifts SET closed_by = ?, closed_at = datetime('now'), counted_cash_cents = ?,
                  expected_cash_cents = ?, close_note = ? WHERE id = ?`)
      .run(actor.id, counted, expected, note, shift.id);
    const z = reading(get(shift.id));
    db.prepare('UPDATE shifts SET z_report = ? WHERE id = ?').run(JSON.stringify(z), shift.id);
    audit.record({ action: 'shift_close', staff: actor, amount_cents: counted, reason: note,
      details: { shift_id: shift.id, expected_cents: expected, difference_cents: counted - expected } });
    return z;
  });
}

/** A shift's reading: the saved Z reading for a closed shift, a fresh X reading otherwise. */
function report(id) {
  const shift = get(id);
  if (!shift) return null;
  return shift.z_report ? JSON.parse(shift.z_report) : reading(shift);
}

function recent(limit = 20) {
  return db.prepare('SELECT id, opened_at, closed_at, opening_cash_cents, counted_cash_cents, expected_cash_cents FROM shifts ORDER BY id DESC LIMIT ?')
    .all(limit);
}

module.exports = { current, get, open, cashMove, reading, close, report, recent, cents };
