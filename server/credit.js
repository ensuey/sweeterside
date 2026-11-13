'use strict';
/* Utang: customers who pay later.

   The owner keeps the list (manage_credit): a name, an optional phone, an
   optional limit and a note. A cashier charges an order to someone on the
   list at the pay screen (payment method 'utang', give_credit). The order is
   then paid: a sale that day. Going over the limit needs the owner's PIN.

   They pay it back in any amount, by any method (collect_credit). Cash goes
   into the drawer as "Utang collected", not as a sale.

   The balance is never stored: utang payments - utang refunds - collections.
   So deleting an order or a payment puts the balance right by itself.

   Phones are masked in lists. Logs and the audit log carry ids, never names
   or phones. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const audit = require('./audit');
const staff = require('./staff');
const shifts = require('./shifts');
const settings = require('./settings');
const { normalizePhPhone, displayPhPhone, PHONE_MESSAGE } = require('./phone');

const NAME_MAX = 60;
const NOTE_MAX = 200;
const REASON_MAX = 200;
const REFERENCE_MAX = 60;

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, body: { error: message, ...extra } });

/** '****4567': a phone as lists show it. */
function maskPhone(norm) {
  const s = String(norm || '');
  return s ? `****${s.slice(-4)}` : '';
}

const BALANCE_SQL = `
  (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE method = 'utang' AND credit_account_id = a.id)
  - (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE method = 'utang' AND credit_account_id = a.id)
  - (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_collections WHERE account_id = a.id)`;

function row(id) {
  return db.prepare(`SELECT a.*, ${BALANCE_SQL} AS balance_cents FROM credit_accounts a WHERE a.id = ?`).get(Number(id)) || null;
}

/** What they owe now, in centavos. Below 0 only if a charge was taken off after they paid. */
function balance(id) {
  const a = row(id);
  return a ? a.balance_cents : 0;
}

/** An account as screens show it. fullPhone: the owner's view. */
function shape(a, { fullPhone = false } = {}) {
  return {
    id: a.id, name: a.name,
    phone: fullPhone ? displayPhPhone(a.phone_norm) : maskPhone(a.phone_norm),
    limit_cents: a.limit_cents, note: a.note, active: a.active === 1,
    balance_cents: a.balance_cents,
    left_cents: a.limit_cents === null ? null : Math.max(0, a.limit_cents - Math.max(0, a.balance_cents)),
    created_at: a.created_at,
  };
}

/** Every account, those who owe the most first. Phones masked. */
function list() {
  return db.prepare(`SELECT a.*, ${BALANCE_SQL} AS balance_cents FROM credit_accounts a`).all()
    .map((a) => shape(a))
    .sort((x, y) => (y.active - x.active) || (y.balance_cents - x.balance_cents) || x.name.localeCompare(y.name));
}

/** One account with what was charged, taken off and paid back, oldest first. */
function get(id, actor) {
  const a = row(id);
  if (!a) throw httpError(404, 'That customer is not on the Utang list.');
  const charges = db.prepare(`
    SELECT p.id, p.order_id, p.amount_cents, p.at, s.name AS staff FROM payments p JOIN staff s ON s.id = p.staff_id
    WHERE p.method = 'utang' AND p.credit_account_id = ? ORDER BY p.id`).all(a.id);
  const refunds = db.prepare(`
    SELECT r.id, r.order_id, r.amount_cents, r.reason, r.at, s.name AS staff FROM refunds r JOIN staff s ON s.id = r.staff_id
    WHERE r.method = 'utang' AND r.credit_account_id = ? ORDER BY r.id`).all(a.id);
  const collections = collectionsOf(a.id);
  const history = [
    ...charges.map((c) => ({ kind: 'charge', ...c })),
    ...refunds.map((r) => ({ kind: 'refund', ...r })),
    ...collections.map((c) => ({ kind: 'collection', ...c })),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return { account: shape(a, { fullPhone: staff.can(actor.role, 'manage_credit') }), history };
}

function collectionsOf(accountId) {
  const { METHODS } = require('./payments');
  return db.prepare(`
    SELECT c.id, c.method, c.amount_cents, c.tendered_cents, c.change_cents, c.reference, c.shift_id, c.at, s.name AS staff
    FROM credit_collections c JOIN staff s ON s.id = c.staff_id WHERE c.account_id = ? ORDER BY c.id`).all(accountId)
    .map((c) => ({ ...c, label: (METHODS[c.method] || { label: c.method }).label }));
}

/* ---------------------------- the list ---------------------------- */

function fields(input, before = null) {
  const out = {};
  if (input.name !== undefined || !before) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new ValidationError({ name: 'Enter the customer\'s name.' });
    if (name.length > NAME_MAX) throw new ValidationError({ name: `Keep the name under ${NAME_MAX} characters.` });
    out.name = name;
  }
  if (input.phone !== undefined) {
    const raw = String(input.phone ?? '').trim();
    if (raw && raw.startsWith('****')) {
      // The masked phone sent back unchanged.
    } else if (raw) {
      const norm = normalizePhPhone(raw);
      if (!norm) throw new ValidationError({ phone: PHONE_MESSAGE });
      out.phone_norm = norm;
    } else {
      out.phone_norm = '';
    }
  }
  if (input.limit !== undefined) {
    out.limit_cents = input.limit === '' || input.limit === null ? null : shifts.cents(input.limit, 'limit');
  }
  if (input.note !== undefined) {
    const note = String(input.note ?? '').trim();
    if (note.length > NOTE_MAX) throw new ValidationError({ note: `Keep the note under ${NOTE_MAX} characters.` });
    out.note = note;
  }
  if (input.active !== undefined) out.active = input.active === true || input.active === 1 ? 1 : 0;
  return out;
}

function sameName(name, exceptId = 0) {
  return db.prepare('SELECT 1 FROM credit_accounts WHERE name = ? COLLATE NOCASE AND active = 1 AND id <> ?').get(name, exceptId);
}

/** Add a customer to the list. The owner, or the owner's PIN. input: { name, phone, limit, note, override } */
function create(input, actor) {
  const { approver } = staff.authorise(actor, 'manage_credit', input.override);
  const f = fields(input);
  if (sameName(f.name)) throw new ValidationError({ name: 'Someone with that name is already on the list.' });
  return transaction(() => {
    const id = db.prepare(`INSERT INTO credit_accounts (name, phone_norm, limit_cents, note, created_by)
                           VALUES (?, ?, ?, ?, ?)`)
      .run(f.name, f.phone_norm || '', f.limit_cents ?? null, f.note || '', actor.id).lastInsertRowid;
    audit.record({ action: 'credit_account', staff: actor, approver,
      details: { account_id: Number(id), created: true, limit_cents: f.limit_cents ?? null } });
    if (approver) audit.record({ action: 'override', staff: actor, approver, details: { permissions: ['manage_credit'] } });
    return { account: shape(row(id), { fullPhone: true }) };
  });
}

/** Change a customer's details, limit or on/off. Owner only (or the owner's PIN). */
function update(id, input, actor) {
  const a = row(id);
  if (!a) throw httpError(404, 'That customer is not on the Utang list.');
  const { approver } = staff.authorise(actor, 'manage_credit', input.override);
  const f = fields(input, a);
  if (f.name && f.name !== a.name && sameName(f.name, a.id)) {
    throw new ValidationError({ name: 'Someone with that name is already on the list.' });
  }
  if (f.active === 1 && a.active === 0 && sameName(f.name || a.name, a.id)) {
    throw new ValidationError({ name: 'Someone with that name is already on the list.' });
  }
  if (f.active === 0 && a.balance_cents > 0) {
    throw new ValidationError({ active: 'They still owe money. Collect it before taking them off the list.' });
  }
  const keys = Object.keys(f).filter((k) => f[k] !== a[k]);
  if (!keys.length) return { account: shape(a, { fullPhone: true }) };
  return transaction(() => {
    // The column names come from fields(), never from the request.
    const set = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE credit_accounts SET ${set} WHERE id = ?`).run(...keys.map((k) => f[k]), a.id);
    const changed = keys.map((k) => (k === 'phone_norm' ? 'phone' : k === 'limit_cents' ? 'limit' : k));
    audit.record({ action: 'credit_account', staff: actor, approver,
      details: { account_id: a.id, changed, ...(keys.includes('limit_cents') ? { limit_cents: f.limit_cents } : {}) } });
    if (approver) audit.record({ action: 'override', staff: actor, approver, details: { permissions: ['manage_credit'] } });
    return { account: shape(row(a.id), { fullPhone: true }) };
  });
}

/* ---------------------------- charging (from payments.pay) ---------------------------- */

/**
 * Check that `amount` can be charged to the account, before payments.pay
 * writes it. Call it inside pay's transaction. Going over the limit needs the
 * owner's PIN (credit_over_limit). @returns { account, approver }
 */
function checkCharge(accountId, amount, actor, override) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError({ account_id: 'Choose who the utang is for.' });
  const { approver: giver } = staff.authorise(actor, 'give_credit', override);
  const a = row(id);
  if (!a || a.active !== 1) throw new ValidationError({ account_id: 'That customer is not on the Utang list.' });
  let approver = giver;
  if (a.limit_cents !== null && Math.max(0, a.balance_cents) + amount > a.limit_cents) {
    const over = staff.authorise(actor, 'credit_over_limit', override);
    approver = over.approver || approver;
    return { account: a, approver, over_limit: true };
  }
  return { account: a, approver, over_limit: false };
}

/* ---------------------------- paying it back ---------------------------- */

function checkKey(key) {
  if (!require('./pos').KEY_RE.test(String(key ?? ''))) throw new ValidationError({ request_key: 'Missing request key. Reload the POS.' });
  return String(key);
}

function collectionRow(id) {
  return db.prepare('SELECT * FROM credit_collections WHERE id = ?').get(Number(id)) || null;
}

/** What the slip shows for one collection. */
function slip(collectionId) {
  const { METHODS } = require('./payments');
  const c = db.prepare(`SELECT c.*, s.name AS staff FROM credit_collections c JOIN staff s ON s.id = c.staff_id
                        WHERE c.id = ?`).get(Number(collectionId));
  if (!c) return null;
  const a = row(c.account_id);
  return {
    collection: { ...c, label: (METHODS[c.method] || { label: c.method }).label },
    account: { id: a.id, name: a.name },
    // What is left after this one (later ones are not on this slip).
    balance_after_cents: db.prepare(`
      SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE method = 'utang' AND credit_account_id = ? AND at <= ?)
           - (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE method = 'utang' AND credit_account_id = ? AND at <= ?)
           - (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_collections WHERE account_id = ? AND id <= ?) AS n`)
      .get(a.id, c.at, a.id, c.at, a.id, c.id).n,
    settings: settings.receiptSettings(),
  };
}

/**
 * Take a payment towards the balance. body: { request_key, method, amount,
 * tendered?, reference?, override? } with pesos. Cash needs an open shift
 * and goes into the drawer.
 */
function collect(id, body, actor) {
  const key = checkKey(body.request_key);
  const done = db.prepare('SELECT id, account_id, change_cents FROM credit_collections WHERE request_key = ?').get(key);
  if (done) {
    if (done.account_id !== Number(id)) throw httpError(409, 'That request was for someone else. Reload the POS.');
    return { ...slip(done.id), change_cents: done.change_cents, replayed: true };
  }
  const a = row(id);
  if (!a) throw httpError(404, 'That customer is not on the Utang list.');
  const { approver } = staff.authorise(actor, 'collect_credit', body.override);
  const { METHODS } = require('./payments');
  const method = String(body.method ?? '');
  const m = METHODS[method];
  if (!m || m.credit) throw new ValidationError({ method: 'Choose how they paid.' });
  const amount = shifts.cents(body.amount, 'amount', { min: 1 });
  if (amount > a.balance_cents) {
    throw new ValidationError({ amount: a.balance_cents > 0
      ? `That is more than the ${(a.balance_cents / 100).toFixed(2)} they owe.` : 'They do not owe anything.' });
  }
  const shift = shifts.current();
  let tendered = null;
  let change = 0;
  if (m.drawer) {
    if (!shift) throw httpError(409, 'Open a shift before taking cash.', { code: 'no_shift' });
    tendered = body.tendered === undefined || body.tendered === null || body.tendered === '' ? amount : shifts.cents(body.tendered, 'tendered');
    if (tendered < amount) throw new ValidationError({ tendered: 'The cash handed over is less than the amount.' });
    change = tendered - amount;
  }
  const reference = String(body.reference ?? '').trim();
  if (m.reference && !reference) {
    throw new ValidationError({ reference: m.referenceLabel ? `For Other, say ${m.referenceLabel}.` : `Enter the ${m.label} reference number.` });
  }
  if (reference.length > REFERENCE_MAX) throw new ValidationError({ reference: 'That reference is too long.' });

  return transaction(() => {
    // Checked again inside the transaction: two tablets collecting at once.
    if (amount > balance(a.id)) throw new ValidationError({ amount: 'The balance changed. Check it and try again.' });
    const cid = db.prepare(`INSERT INTO credit_collections (account_id, shift_id, method, amount_cents, tendered_cents,
                              change_cents, reference, staff_id, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, shift ? shift.id : null, method, amount, tendered, change, m.reference ? reference : '', actor.id, key)
      .lastInsertRowid;
    audit.record({ action: 'credit_collect', staff: actor, approver, amount_cents: amount,
      details: { account_id: a.id, collection_id: Number(cid), method, shift_id: shift ? shift.id : null } });
    if (approver) audit.record({ action: 'override', staff: actor, approver, details: { permissions: ['collect_credit'] } });
    return { ...slip(cid), change_cents: change, replayed: false };
  });
}

/** Delete a collection entered by mistake. Owner (or PIN), with a reason. */
function deleteCollection(id, input, actor) {
  const c = collectionRow(id);
  if (!c) throw httpError(404, 'That payment no longer exists.');
  const { approver } = staff.authorise(actor, 'correct_entries', input.override);
  const why = String(input.why ?? '').trim().replace(/\s+/g, ' ');
  if (!why) throw new ValidationError({ why: 'Say why it is being deleted.' });
  if (why.length > REASON_MAX) throw new ValidationError({ why: `Keep it under ${REASON_MAX} characters.` });
  return transaction(() => {
    db.prepare('DELETE FROM credit_collections WHERE id = ?').run(c.id);
    audit.record({ action: 'credit_collection_delete', staff: actor, approver, amount_cents: c.amount_cents, reason: why,
      details: { account_id: c.account_id, collection_id: c.id, method: c.method, shift_id: c.shift_id } });
    if (c.shift_id) shifts.recount(c.shift_id, approver || actor);
    return { ok: true, balance_cents: balance(c.account_id) };
  });
}

/* ---------------------------- for the shift and the reports ---------------------------- */

/** Collections in one shift, by method: { cash: { count, amount_cents } }. */
function collectedInShift(shiftId) {
  return Object.fromEntries(db.prepare(`
    SELECT method, COUNT(*) AS n, SUM(amount_cents) AS amount FROM credit_collections WHERE shift_id = ? GROUP BY method`)
    .all(shiftId).map((r) => [r.method, { count: r.n, amount_cents: r.amount }]));
}

/** The account an order was charged to, if any. */
function accountOfOrder(orderId) {
  const p = db.prepare(`SELECT credit_account_id FROM payments WHERE order_id = ? AND method = 'utang'
                        AND credit_account_id IS NOT NULL ORDER BY id LIMIT 1`).get(orderId);
  return p ? p.credit_account_id : null;
}

module.exports = {
  maskPhone, list, get, create, update, balance, checkCharge, collect, deleteCollection, slip,
  collectedInShift, accountOfOrder, collectionsOf,
};
