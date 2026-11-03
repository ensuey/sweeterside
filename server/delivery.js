'use strict';
/* Delivery areas: where we deliver, the fee for each and how long it
   usually takes, managed on the Settings page. The server works out the fee
   from the area the customer picks; the browser's number is never used.

   An area without a fee cannot be chosen until the owner sets one. "Other
   area" is always offered: the order goes through with no fee yet and is
   flagged "Fee to confirm", and the shop calls the customer with the fee.

   Free delivery: with a threshold set, an order whose items come to at
   least that much after discounts pays no fee (not for "Other area"). The
   pricing engine applies it, so the checkout and the POS agree. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const { getSetting } = require('./settings');

const NAME_MAX = 40;
const MAX_FEE = 10000; // pesos
const MAX_ETA = 600; // minutes
const MAX_AREAS = 40;
const OTHER = 'other';

db.exec(`
CREATE TABLE IF NOT EXISTS delivery_areas (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  fee_cents INTEGER,             -- NULL: not set yet, so not offered
  eta_min   INTEGER,
  eta_max   INTEGER,
  active    INTEGER NOT NULL DEFAULT 1,
  position  INTEGER NOT NULL DEFAULT 0
)`);

// Orders remember the area by id and by name (so a renamed or removed area
// does not change an old order), and whether the fee is still to confirm.
{
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  const add = { delivery_area_id: 'INTEGER', delivery_area: "TEXT NOT NULL DEFAULT ''", fee_to_confirm: 'INTEGER NOT NULL DEFAULT 0' };
  for (const [name, type] of Object.entries(add)) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
}

// The areas the owner gave, seeded once with no fees: the owner sets them.
const SEED = ['Batobato', 'Manikling', 'Baon', 'Bitaogan'];
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'delivery_areas_seeded'").get()) {
  transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO delivery_areas (name, position) VALUES (?, ?)');
    SEED.forEach((name, i) => insert.run(name, i));
    db.prepare("INSERT INTO settings (key, value) VALUES ('delivery_areas_seeded', '1')").run();
  });
}

/* ---------------------------- reading ---------------------------- */

function shape(r) {
  return {
    id: r.id, name: r.name, fee: r.fee_cents === null ? null : r.fee_cents / 100,
    eta_min: r.eta_min, eta_max: r.eta_max, active: r.active === 1, position: r.position,
    selectable: r.active === 1 && r.fee_cents !== null,
  };
}

/** Every area, for the admin. */
function list() {
  return db.prepare('SELECT * FROM delivery_areas ORDER BY position, id').all().map(shape);
}

/** The areas a customer can pick: on, with a fee set. */
function selectable() {
  return list().filter((a) => a.selectable);
}

/** "Usually 30–45 min", or '' without a time. */
function etaLabel(area) {
  if (!area || area.eta_min === null || area.eta_max === null) return '';
  return area.eta_min === area.eta_max ? `Usually ${area.eta_min} min` : `Usually ${area.eta_min}–${area.eta_max} min`;
}

/** The free delivery threshold in pesos, or null when off. */
function freeOver() {
  const v = getSetting('free_delivery_min', '');
  const n = Number(v);
  return v !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The area a customer or cashier chose, for pricing and the order.
 * @param choice an area id, or 'other'
 * @returns {{ id, name, fee_cents, to_confirm, eta, free_over_cents }} or null if not valid
 */
function resolve(choice) {
  if (String(choice ?? '').trim().toLowerCase() === OTHER) {
    return { id: null, name: 'Other area', fee_cents: 0, to_confirm: true, eta: '', free_over_cents: null };
  }
  const id = Number(choice);
  if (!Number.isInteger(id) || id < 1) return null;
  const row = db.prepare('SELECT * FROM delivery_areas WHERE id = ?').get(id);
  if (!row || row.active !== 1 || row.fee_cents === null) return null;
  const free = freeOver();
  return {
    id: row.id, name: row.name, fee_cents: row.fee_cents, to_confirm: false, eta: etaLabel(shape(row)),
    free_over_cents: free === null ? null : free * 100,
  };
}

/* ---------------------------- managing ---------------------------- */

function intOrNull(v, key, max, errors, label) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) { errors[key] = label; return null; }
  return n;
}

function validate(input, id = null) {
  const errors = {};
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter the area name.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;
  else if (name.toLowerCase() === 'other' || name.toLowerCase() === 'other area') errors.name = '"Other area" is always offered; use another name.';
  else {
    const dup = db.prepare('SELECT id FROM delivery_areas WHERE lower(name) = lower(?)').get(name);
    if (dup && dup.id !== id) errors.name = 'There is already an area with that name.';
  }
  const fee = intOrNull(input.fee, 'fee', MAX_FEE, errors, `Enter the fee as a whole number of pesos, 0 to ${MAX_FEE}, or leave it blank.`);
  const etaMin = intOrNull(input.eta_min, 'eta', MAX_ETA, errors, `Enter minutes from 0 to ${MAX_ETA}.`);
  const etaMax = intOrNull(input.eta_max, 'eta', MAX_ETA, errors, `Enter minutes from 0 to ${MAX_ETA}.`);
  if (!errors.eta && (etaMin === null) !== (etaMax === null)) errors.eta = 'Enter both times (e.g. 30 to 45), or neither.';
  else if (!errors.eta && etaMin !== null && etaMin > etaMax) errors.eta = 'The first time must not be more than the second.';
  const active = !(input.active === false || input.active === 'false' || input.active === 0 || input.active === '0');
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, fee_cents: fee === null ? null : fee * 100, eta_min: etaMin, eta_max: etaMax, active: active ? 1 : 0 };
}

function create(input) {
  const v = validate(input);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM delivery_areas').get();
  if (n >= MAX_AREAS) throw new ValidationError({ name: `Keep it to ${MAX_AREAS} areas or fewer.` });
  const { pos } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM delivery_areas').get();
  const id = db.prepare('INSERT INTO delivery_areas (name, fee_cents, eta_min, eta_max, active, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.name, v.fee_cents, v.eta_min, v.eta_max, v.active, pos).lastInsertRowid;
  return get(Number(id));
}

function update(id, input) {
  if (!db.prepare('SELECT 1 FROM delivery_areas WHERE id = ?').get(Number(id))) return null;
  const v = validate(input, Number(id));
  db.prepare('UPDATE delivery_areas SET name = ?, fee_cents = ?, eta_min = ?, eta_max = ?, active = ? WHERE id = ?')
    .run(v.name, v.fee_cents, v.eta_min, v.eta_max, v.active, Number(id));
  return get(Number(id));
}

/** Orders keep the area's name, so removing it changes no old order. */
function remove(id) {
  return db.prepare('DELETE FROM delivery_areas WHERE id = ?').run(Number(id)).changes > 0;
}

function reorder(ids) {
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(Number(i)))) throw new ValidationError({ order: 'Send the areas in order.' });
  transaction(() => ids.forEach((id, i) => db.prepare('UPDATE delivery_areas SET position = ? WHERE id = ?').run(i, Number(id))));
  return list();
}

function get(id) {
  const r = db.prepare('SELECT * FROM delivery_areas WHERE id = ?').get(Number(id));
  return r ? shape(r) : null;
}

module.exports = { OTHER, list, selectable, etaLabel, freeOver, resolve, create, update, remove, reorder, get };
