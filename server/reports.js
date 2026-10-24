'use strict';
/* Reports for the owner. Dates are Manila calendar days, both ends included.

   What counts as a sale: a POS order once it is paid (dated by when it was
   paid), and an online order once it is Completed (dated by when it was
   placed). Cancelled orders never count. Refunds are taken off on the day
   they were given.

   Amounts are centavos. "Gross" is the items at their regular price, before
   any sale or discount; "net sales" is what the items sold for after every
   discount; the service charge (the staff's) and delivery fees are reported
   apart. */

const { db } = require('./db');
const { manilaDateStartSql, manilaDate, addDays } = require('./clock');
const { ValidationError } = require('./menu');
const pricing = require('./pricing');
const settings = require('./settings');
const { toCsv } = require('./csv');

// The 8% income tax option and non-VAT registration stop at Php 3,000,000 of
// gross sales a year.
const THRESHOLD_CENTS = 3000000 * 100;
const WARN_AT = [80, 95];
const MAX_DAYS = 400;

const SALE = `((o.source = 'pos' AND o.paid_at IS NOT NULL) OR (o.source = 'online' AND o.status = 'completed'))
              AND o.status <> 'cancelled'`;
const SALE_AT = "CASE WHEN o.source = 'pos' THEN o.paid_at ELSE o.created_at END";
// The Manila calendar day of a UTC 'YYYY-MM-DD HH:MM:SS'.
const DAY = (col) => `date(${col}, '+8 hours')`;

/** { from, to } Manila dates, defaulting to today; checked and capped. */
function range(input, now = new Date()) {
  const today = manilaDate(now);
  const from = String(input.from || today);
  const to = String(input.to || from);
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok(from) || !ok(to)) throw new ValidationError({ range: 'Choose the dates again.' });
  if (from > to) throw new ValidationError({ range: 'The first day must be on or before the last day.' });
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_DAYS) throw new ValidationError({ range: `Choose at most ${MAX_DAYS} days.` });
  return { from, to, start: manilaDateStartSql(from), end: manilaDateStartSql(addDays(to, 1)) };
}

const totalsSql = `COUNT(*) AS orders,
  COALESCE(SUM(o.gross_cents), 0) AS gross,
  COALESCE(SUM(o.gross_cents - o.subtotal_cents), 0) AS sale,
  COALESCE(SUM(o.sc_pwd_discount_cents), 0) AS sc_pwd,
  COALESCE(SUM(o.vat_exempt_cents), 0) AS vat_exempt,
  COALESCE(SUM(o.discount_cents), 0) AS voucher,
  COALESCE(SUM(o.manual_discount_cents), 0) AS manual,
  COALESCE(SUM(o.service_charge_cents), 0) AS service_charge,
  COALESCE(SUM(o.delivery_fee_cents), 0) AS delivery_fees,
  COALESCE(SUM(o.total_cents), 0) AS total`;

function shape(r) {
  return { ...r, net_sales: r.total - r.service_charge - r.delivery_fees };
}

/** Sales for the range, broken down every way the owner asked for. */
function summary(input, now) {
  const r = range(input, now);
  const where = `${SALE} AND ${SALE_AT} >= ? AND ${SALE_AT} < ?`;
  const p = [r.start, r.end];
  const group = (key, label = key) => db.prepare(`
    SELECT ${key} AS key, ${totalsSql} FROM orders o WHERE ${where} GROUP BY ${key} ORDER BY total DESC`)
    .all(...p).map((x) => shape({ ...x, [label]: x.key }));

  const totals = shape(db.prepare(`SELECT ${totalsSql} FROM orders o WHERE ${where}`).get(...p));
  const refunds = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS amount FROM refunds
                              WHERE at >= ? AND at < ?`).get(...p);
  const refundsByDay = new Map(db.prepare(`SELECT ${DAY('at')} AS day, SUM(amount_cents) AS amount FROM refunds
                                           WHERE at >= ? AND at < ? GROUP BY day`).all(...p).map((x) => [x.day, x.amount]));
  const byDay = group(DAY(SALE_AT), 'day').sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ ...d, refunds: refundsByDay.get(d.day) || 0 }));

  // By item and category, from the lines (what each line came to after discounts).
  const lines = db.prepare(`
    SELECT oi.item_id, oi.name, COALESCE(c.name, 'Removed from the menu') AS category,
           SUM(oi.qty - oi.voided_qty) AS qty,
           SUM(COALESCE(oi.regular_price_cents, oi.price_cents) * (oi.qty - oi.voided_qty)) AS gross,
           SUM(oi.net_cents) AS net
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
    WHERE ${where} AND oi.qty > oi.voided_qty
    GROUP BY oi.item_id, oi.name ORDER BY net DESC`).all(...p);
  const categories = new Map();
  for (const l of lines) {
    const c = categories.get(l.category) || { category: l.category, qty: 0, gross: 0, net: 0 };
    c.qty += l.qty;
    c.gross += l.gross;
    c.net += l.net;
    categories.set(l.category, c);
  }

  const byStaff = db.prepare(`
    SELECT COALESCE(s.name, 'Online') AS staff, ${totalsSql}
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id
    WHERE ${where} GROUP BY o.staff_id ORDER BY total DESC`).all(...p).map(shape);

  const payments = db.prepare(`
    SELECT p.method, COUNT(*) AS count, SUM(p.amount_cents) AS amount
    FROM payments p WHERE p.at >= ? AND p.at < ? GROUP BY p.method ORDER BY amount DESC`).all(...p);

  return {
    from: r.from, to: r.to, totals, refunds: { count: refunds.n, amount: refunds.amount },
    by_day: byDay,
    by_item: lines,
    by_category: [...categories.values()].sort((a, b) => b.net - a.net),
    by_type: group('o.order_type', 'order_type'),
    by_source: group('o.source', 'source'),
    by_staff: byStaff,
    payments,
    // Online orders are paid on delivery or at the counter, outside the POS.
    online_unrecorded: db.prepare(`SELECT COALESCE(SUM(o.total_cents), 0) AS n FROM orders o
                                   WHERE ${where} AND o.source = 'online'`).get(...p).n,
  };
}

/**
 * Every SC/PWD discount given, one row per claimant, for the BIR deduction.
 * options.fullIds: the ID numbers in full (the CSV export); masked otherwise.
 * The VAT exemption column is only there when the shop is VAT-registered.
 */
function scPwd(input, { fullIds = false } = {}, now) {
  const r = range(input, now);
  const rows = [];
  const orders = db.prepare(`
    SELECT o.id, o.pricing, ${SALE_AT} AS sale_at FROM orders o
    WHERE ${SALE} AND ${SALE_AT} >= ? AND ${SALE_AT} < ? AND o.sc_pwd_discount_cents > 0 ORDER BY sale_at, o.id`)
    .all(r.start, r.end);
  for (const o of orders) {
    const p = JSON.parse(o.pricing);
    for (const c of p.claimants) {
      if (c.applied !== 'sc_pwd') continue;
      rows.push({
        date: o.sale_at, order_id: o.id, name: c.name, id_no: fullIds ? c.id_no : pricing.maskId(c.id_no),
        type: c.type === 'sc' ? 'Senior Citizen' : 'PWD', gross: c.eligible_gross, vat_exempt: c.vat_exempt,
        discount: c.discount, net: c.net,
      });
    }
  }
  const vat = settings.vatRegistered() === true || rows.some((x) => x.vat_exempt);
  return { from: r.from, to: r.to, vat_registered: vat, rows };
}

function scPwdCsv(input, now) {
  const report = scPwd(input, { fullIds: true }, now);
  const pesos = (c) => Number((c / 100).toFixed(2));
  const header = ['Date (Manila)', 'Order no.', 'Name', 'ID number', 'Type', 'Gross eligible (Php)',
    ...(report.vat_registered ? ['VAT exemption (Php)'] : []), '20% discount (Php)', 'Net (Php)'];
  return toCsv(header, report.rows.map((x) => [
    manilaTime(x.date), x.order_id, x.name, x.id_no, x.type, pesos(x.gross),
    ...(report.vat_registered ? [pesos(x.vat_exempt)] : []), pesos(x.discount), pesos(x.net),
  ]));
}

/** Voucher use, and manual discounts with who gave and approved them. */
function discounts(input, now) {
  const r = range(input, now);
  const vouchers = db.prepare(`
    SELECT o.voucher_code AS code, COUNT(*) AS uses, SUM(o.discount_cents) AS discount
    FROM orders o WHERE ${SALE} AND ${SALE_AT} >= ? AND ${SALE_AT} < ? AND o.voucher_code <> ''
    GROUP BY o.voucher_code ORDER BY uses DESC`).all(r.start, r.end);
  const manual = db.prepare(`
    SELECT a.at, a.order_id, a.staff_name, a.approver_name, a.reason, a.amount_cents
    FROM audit_log a WHERE a.action = 'manual_discount' AND a.at >= ? AND a.at < ? ORDER BY a.id`)
    .all(r.start, r.end);
  const byStaff = new Map();
  for (const m of manual) {
    const s = byStaff.get(m.staff_name) || { staff: m.staff_name, count: 0, amount: 0 };
    s.count += 1;
    s.amount += m.amount_cents || 0;
    byStaff.set(m.staff_name, s);
  }
  return { from: r.from, to: r.to, vouchers, manual, manual_by_staff: [...byStaff.values()] };
}

/**
 * Gross sales so far this calendar year (Manila) against the Php 3,000,000
 * non-VAT / 8% limit: items at regular price plus delivery fees, before
 * discounts, without the service charge, less refunds.
 */
function threshold(now = new Date()) {
  const year = manilaDate(now).slice(0, 4);
  const start = manilaDateStartSql(`${year}-01-01`);
  const end = manilaDateStartSql(`${Number(year) + 1}-01-01`);
  const s = db.prepare(`
    SELECT COALESCE(SUM(o.gross_cents), 0) AS gross, COALESCE(SUM(o.delivery_fee_cents), 0) AS fees
    FROM orders o WHERE ${SALE} AND ${SALE_AT} >= ? AND ${SALE_AT} < ?`).get(start, end);
  const refunds = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE at >= ? AND at < ?')
    .get(start, end).n;
  const total = s.gross + s.fees - refunds;
  const pct = Math.floor((total * 1000) / THRESHOLD_CENTS) / 10;
  const level = pct >= WARN_AT[1] ? 'danger' : pct >= WARN_AT[0] ? 'warn' : 'ok';
  return {
    year, gross_cents: s.gross, delivery_fees_cents: s.fees, refunds_cents: refunds, total_cents: total,
    threshold_cents: THRESHOLD_CENTS, percent: pct, level,
  };
}

function manilaTime(sql) {
  const d = new Date(new Date(`${String(sql).replace(' ', 'T')}Z`).getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** The audit log as CSV, for the owner. */
function auditCsv(entries) {
  return toCsv(['When (Manila)', 'Action', 'Staff', 'Approved by', 'Order no.', 'Amount (Php)', 'Reason', 'Details'],
    entries.map((e) => [manilaTime(e.at), e.action, e.staff_name, e.approver_name, e.order_id ?? '',
      e.amount_cents === null ? '' : Number((e.amount_cents / 100).toFixed(2)), e.reason,
      e.details ? JSON.stringify(e.details) : '']));
}

module.exports = { THRESHOLD_CENTS, range, summary, scPwd, scPwdCsv, discounts, threshold, auditCsv, manilaTime };
