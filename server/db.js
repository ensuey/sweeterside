'use strict';
/* SQLite schema, migrations and first-run seed.
   Uses node:sqlite (built into Node 22) so the project has no dependencies. */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { ROOT, DB_PATH } = require('./paths');
const { normalizePhPhone } = require('./phone');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  -- id is the SHA-256 of the cookie token, so a database leak does not
  -- hand over usable session cookies.
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  -- slug is fixed at creation: it is the section's anchor (#drinks) and the
  -- filter key on the customer page, so a rename does not break links.
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  -- Short form for the filter chip and the item popup tag.
  label      TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Amounts are centavos, copied at order time so later price changes do not
-- rewrite what the customer was charged. The order type columns are added by
-- addMissingColumns(), so new and old databases take the same path.
CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY,
  customer_name      TEXT    NOT NULL,
  phone              TEXT    NOT NULL,
  address            TEXT    NOT NULL,
  subtotal_cents     INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL,
  total_cents        INTEGER NOT NULL,
  cash_cents         INTEGER NOT NULL,
  change_due_cents   INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','confirmed','preparing','delivering','completed','cancelled')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL: deleting a menu item must not delete past orders of it.
  item_id  INTEGER REFERENCES items(id) ON DELETE SET NULL,
  name        TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,   -- the unit price charged, before order-level discounts
  qty         INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

/* Orders were stored in whole pesos before the POS. SQLite can rename a
   column in place, so each peso column becomes *_cents and its values are
   multiplied by 100, all in one transaction: the order rows and their ids are
   untouched. Runs before the columns below are added, so `discount` (when an
   older database has it) is renamed rather than duplicated. */
const PESO_COLUMNS = {
  orders: ['subtotal', 'delivery_fee', 'total', 'cash', 'change_due', 'discount'],
  order_items: ['price'],
};

function migrateMoneyToCents() {
  const work = Object.entries(PESO_COLUMNS).map(([table, names]) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    return [table, names.filter((name) => cols.includes(name))];
  }).filter(([, names]) => names.length);
  if (!work.length) return;
  transaction(() => {
    for (const [table, names] of work) {
      for (const name of names) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${name} TO ${name}_cents`);
      db.exec(`UPDATE ${table} SET ${names.map((name) => `${name}_cents = ${name}_cents * 100`).join(', ')}`);
    }
  });
}

migrateMoneyToCents();

const ITEMS_TABLE = (name) => `
CREATE TABLE ${name} (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  price       INTEGER NOT NULL,
  -- RESTRICT: a category cannot be deleted while items still use it.
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  image       TEXT    NOT NULL,
  alt         TEXT    NOT NULL DEFAULT '',
  -- When crop_w is NULL the image is shown whole (object-fit: cover).
  -- Otherwise it is a sprite window onto a shared menu poster.
  crop_x      INTEGER,
  crop_y      INTEGER,
  crop_w      INTEGER,
  crop_h      INTEGER,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

/* The original two categories, as they appear on the printed posters. */
const DEFAULT_CATEGORIES = [
  ['drinks', 'Frappe Based Drinks', 'Frappes'],
  ['food', 'Food', 'Food'],
];

function insertDefaultCategories() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO categories (slug, name, label, position) VALUES (?, ?, ?, ?)');
  DEFAULT_CATEGORIES.forEach((row, i) => insert.run(...row, i));
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Databases created before categories were editable store items.category as
   'drinks' | 'food' behind a CHECK constraint. SQLite cannot drop a CHECK, so
   the table is rebuilt with a category_id foreign key instead. */
function migrateItems() {
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (cols.length === 0) {
    db.exec(ITEMS_TABLE('items'));
  } else if (cols.includes('category') && !cols.includes('category_id')) {
    transaction(() => {
      insertDefaultCategories();
      db.exec(ITEMS_TABLE('items_new'));
      db.exec(`
        INSERT INTO items_new (id, name, price, category_id, image, alt,
                               crop_x, crop_y, crop_w, crop_h, position, created_at, updated_at)
        SELECT i.id, i.name, i.price, c.id, i.image, i.alt,
               i.crop_x, i.crop_y, i.crop_w, i.crop_h, i.position, i.created_at, i.updated_at
        FROM items i JOIN categories c ON c.slug = i.category`);
      db.exec('DROP TABLE items');
      db.exec('ALTER TABLE items_new RENAME TO items');
    });
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_order ON items(category_id, position, id)');
}

migrateItems();

/* Availability and the daily limit came later. Every existing item starts
   available with no limit. daily_limit NULL means unlimited. */
const ITEM_STOCK_COLUMNS = {
  availability: "TEXT NOT NULL DEFAULT 'available'", // available | unavailable | sold_out
  daily_limit: 'INTEGER',
};

/* Promotions came later still: a best seller badge and a sale price, kept as
   the rule (percent or amount off) so the full price is never lost. */
const ITEM_PROMO_COLUMNS = {
  best_seller: 'INTEGER NOT NULL DEFAULT 0',
  sale_type: "TEXT NOT NULL DEFAULT ''", // '' (no sale) | percent | amount
  sale_value: 'INTEGER',
};

/** Add any of `columns` that `table` does not have yet. @returns the names added. */
function addMissingColumns(table, columns) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const added = [];
  for (const [name, type] of Object.entries(columns)) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
  }
  return added;
}

addMissingColumns('items', ITEM_STOCK_COLUMNS);
addMissingColumns('items', ITEM_PROMO_COLUMNS);

/* Orders were delivery-only before pick-up and dine-in. Adding columns with
   defaults keeps every earlier order as a delivery order. Pick-up and dine-in
   orders store '' for the address (and phone, for dine-in) and 0 for cash. */
const ORDER_COLUMNS = {
  order_type: "TEXT NOT NULL DEFAULT 'delivery'",
  table_no: "TEXT NOT NULL DEFAULT ''",
  pickup_at: "TEXT NOT NULL DEFAULT ''", // 'asap' or 'HH:MM', Manila time, same day
  // A voucher takes `discount` off the items: total = subtotal - discount + delivery_fee.
  voucher_code: "TEXT NOT NULL DEFAULT ''",
  discount_cents: 'INTEGER NOT NULL DEFAULT 0',
};

addMissingColumns('orders', ORDER_COLUMNS);

/* Fake-order protection came later. phone_norm is the phone as +639XXXXXXXXX
   (NULL for dine-in, which takes no phone, and for older numbers that are not
   PH mobiles); the open-orders limit, the customer history and the blocklist
   all match on it. landmark is delivery only. cancel_reason says why an order
   was cancelled: customer | no_show | fake | other, or '' for older ones. */
const ORDER_TRUST_COLUMNS = {
  phone_norm: 'TEXT',
  landmark: "TEXT NOT NULL DEFAULT ''",
  cancel_reason: "TEXT NOT NULL DEFAULT ''",
};

/** Fill phone_norm from phone for rows saved before it existed. */
function backfillPhones(table) {
  const rows = db.prepare(`SELECT id, phone FROM ${table} WHERE phone_norm IS NULL AND phone <> ''`).all();
  const update = db.prepare(`UPDATE ${table} SET phone_norm = ? WHERE id = ?`);
  transaction(() => {
    for (const row of rows) {
      const norm = normalizePhPhone(row.phone);
      if (norm) update.run(norm, row.id);
    }
  });
}

if (addMissingColumns('orders', ORDER_TRUST_COLUMNS).includes('phone_norm')) backfillPhones('orders');

/* The Confirmed status came with fake-order protection. SQLite cannot change a
   CHECK constraint, so an older orders table is rebuilt from its own CREATE
   statement with 'confirmed' added. Foreign keys are off while the table is
   swapped, or dropping it would cascade-delete every order's lines. */
function migrateOrderStatuses() {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (sql.includes("'confirmed'")) return;
  const rebuilt = sql
    .replace(/^CREATE TABLE\s+"?orders"?/i, 'CREATE TABLE orders_new')
    .replace(/'new'\s*,\s*'preparing'/, "'new','confirmed','preparing'");
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      db.exec(rebuilt);
      db.exec('INSERT INTO orders_new SELECT * FROM orders');
      db.exec('DROP TABLE orders');
      db.exec('ALTER TABLE orders_new RENAME TO orders');
      const orphans = db.prepare(
        'SELECT COUNT(*) AS n FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)').get().n;
      if (orphans) throw new Error('Order lines lost their order.');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateOrderStatuses();
db.exec(`
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone_norm, status);
`);

/* Voucher codes customers type at checkout. Codes are stored in upper case;
   the dates are Manila calendar days, both included, and either may be open. */
db.exec(`
CREATE TABLE IF NOT EXISTS vouchers (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL CHECK (kind IN ('percent','amount')),
  value       INTEGER NOT NULL,
  max_off     INTEGER,            -- percent vouchers only: the most it takes off, in pesos
  valid_from  TEXT,               -- 'YYYY-MM-DD' or NULL
  valid_until TEXT,               -- 'YYYY-MM-DD' or NULL
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
)`);

/* Custom cake booking requests. The size's starting price is copied at
   booking time; Dachel sets the real price (quoted_price) after reviewing it.
   needed_on is a Manila calendar day. photo is a file name in CAKE_PHOTO_DIR
   (never public), or ''. */
db.exec(`
CREATE TABLE IF NOT EXISTS cake_bookings (
  id              INTEGER PRIMARY KEY,
  customer_name   TEXT    NOT NULL,
  phone           TEXT    NOT NULL,
  size            TEXT    NOT NULL,
  size_from_price INTEGER NOT NULL,
  flavour         TEXT    NOT NULL,
  occasion        TEXT    NOT NULL DEFAULT '',
  cake_message    TEXT    NOT NULL DEFAULT '',
  design_notes    TEXT    NOT NULL DEFAULT '',
  photo           TEXT    NOT NULL DEFAULT '',
  needed_on       TEXT    NOT NULL,
  handover        TEXT    NOT NULL CHECK (handover IN ('pickup','delivery')),
  address         TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','quoted','confirmed','completed','declined')),
  quoted_price    INTEGER,
  deposit_paid    INTEGER NOT NULL DEFAULT 0,
  deposit_amount  INTEGER,
  admin_note      TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cake_bookings_day ON cake_bookings(needed_on, status);
`);

if (addMissingColumns('cake_bookings', { phone_norm: 'TEXT' }).includes('phone_norm')) backfillPhones('cake_bookings');

/* ---------- The in-store POS (claude/pos-plan.md) ---------- */

/* Staff who use the counter tablet. They pick their name and type a 4-6
   digit PIN; the tablet itself stays signed in as the admin. Staff are never
   deleted, only switched off, so the audit log always names them. */
db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('owner','cashier','waiter')),
  pin_hash   TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A staff member's turn at the tablet, under the admin session it was opened
-- in. id is the SHA-256 of the token. last_seen drives the idle lock.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id            TEXT    PRIMARY KEY,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  admin_session TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

-- Everything that moves money or needs a manager, append-only: the triggers
-- below refuse any change or deletion. staff_name is copied so a renamed
-- staff member's old entries still read as they did.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT    NOT NULL DEFAULT (datetime('now')),
  action        TEXT    NOT NULL,
  staff_id      INTEGER REFERENCES staff(id),
  staff_name    TEXT    NOT NULL DEFAULT '',
  approved_by   INTEGER REFERENCES staff(id),
  approver_name TEXT    NOT NULL DEFAULT '',
  order_id      INTEGER,
  amount_cents  INTEGER,
  reason        TEXT    NOT NULL DEFAULT '',
  details       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed.'); END;
`);

/* Orders from the POS sit in the same table as online ones. source tells
   them apart; every older order came from the website. The discounts the
   pricing engine works out are kept as columns for reports, and in full as
   JSON (pricing) for the receipt. gross_cents is the items at regular price,
   before any sale or discount. paid_at is when the order was fully paid. */
const ORDER_POS_COLUMNS = {
  source: "TEXT NOT NULL DEFAULT 'online'",
  gross_cents: 'INTEGER NOT NULL DEFAULT 0',
  sc_pwd_discount_cents: 'INTEGER NOT NULL DEFAULT 0',
  vat_exempt_cents: 'INTEGER NOT NULL DEFAULT 0',
  manual_discount_cents: 'INTEGER NOT NULL DEFAULT 0',
  service_charge_cents: 'INTEGER NOT NULL DEFAULT 0',
  pricing: "TEXT NOT NULL DEFAULT ''",
  staff_id: 'INTEGER REFERENCES staff(id)',
  paid_at: 'TEXT',
};

// Older orders had no sale or SC/PWD breakdown: their gross is what they paid for the items.
if (addMissingColumns('orders', ORDER_POS_COLUMNS).includes('gross_cents')) {
  db.exec('UPDATE orders SET gross_cents = subtotal_cents');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)');

/* Per line: the regular unit price (before any sale) and what the line came
   to after every discount, for sales-by-item reports. */
const ORDER_ITEM_POS_COLUMNS = {
  regular_price_cents: 'INTEGER NOT NULL DEFAULT 0',
  net_cents: 'INTEGER NOT NULL DEFAULT 0',
};

/** Older lines: regular = the price charged; net = the line less its share of the voucher. */
function backfillLineNets() {
  const { allocate } = require('./pricing');
  const orders = db.prepare('SELECT id, discount_cents FROM orders').all();
  const linesOf = db.prepare('SELECT id, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id');
  const update = db.prepare('UPDATE order_items SET regular_price_cents = ?, net_cents = ? WHERE id = ?');
  transaction(() => {
    for (const o of orders) {
      const lines = linesOf.all(o.id);
      const amounts = lines.map((l) => l.price_cents * l.qty);
      const off = allocate(o.discount_cents, amounts);
      lines.forEach((l, i) => update.run(l.price_cents, amounts[i] - off[i], l.id));
    }
  });
}

if (addMissingColumns('order_items', ORDER_ITEM_POS_COLUMNS).includes('net_cents')) backfillLineNets();

/* Items can be left out of the SC/PWD discount (non-food items added later). */
addMissingColumns('items', { sc_eligible: 'INTEGER NOT NULL DEFAULT 1' });

/* The shop is non-VAT registered (8% income tax option). Saved here, once,
   so the POS gives the non-VAT SC/PWD discount; the owner can change it in
   Tax settings. OR IGNORE keeps whatever the owner set later. */
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vat_registered', '0')").run();

/* Numbers that may not order or book online. created_by is the admin's email. */
db.exec(`
CREATE TABLE IF NOT EXISTS blocked_phones (
  id         INTEGER PRIMARY KEY,
  phone_norm TEXT    NOT NULL UNIQUE,
  reason     TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`);

/* ---------- First-run seed: the nine items from the printed posters ---------- */

const POSTER_DRINKS = 'assets/Menu Frappe.jpg';
const POSTER_FOOD = 'assets/Meals.jpg';

const SEED = [
  ['Matcha Frappe', 129, 'drinks', POSTER_DRINKS,
    'Matcha Frappe — pale green blended drink with whipped cream in a clear cup', 113, 530, 184, 245],
  ['Biscoff Frappe', 129, 'drinks', POSTER_DRINKS,
    'Biscoff Frappe — caramel-coloured blended drink topped with cookie crumble', 427, 539, 170, 227],
  ['Cookies and Cream Frappe', 105, 'drinks', POSTER_DRINKS,
    'Cookies and Cream Frappe — grey blended drink with cookie pieces on whipped cream', 725, 530, 184, 245],
  ['Seasalt Caramel Frappe', 149, 'drinks', POSTER_DRINKS,
    'Seasalt Caramel Frappe — golden blended drink with caramel drizzle', 113, 1050, 184, 245],
  ['Strawberry Cheesecake Frappe', 139, 'drinks', POSTER_DRINKS,
    'Strawberry Cheesecake Frappe — pink blended drink with strawberry sauce on top', 418, 1050, 184, 245],
  ['Dark Chocolate Frappe', 105, 'drinks', POSTER_DRINKS,
    'Dark Chocolate Frappe — deep brown blended drink topped with chocolate chips', 728, 1050, 184, 245],
  ['Beef Penne Pasta', 135, 'food', POSTER_FOOD,
    'Beef Penne Pasta — penne in red sauce on a grey plate with toasted bread', 45, 335, 270, 270],
  ['Chicken Pesto Pasta', 135, 'food', POSTER_FOOD,
    'Chicken Pesto Pasta — fusilli in green pesto topped with cheese, with toasted bread', 378, 335, 270, 270],
  ['Bacon and Egg Sandwich', 85, 'food', POSTER_FOOD,
    'Bacon and Egg Sandwich — layered sandwich with egg, bacon and avocado in a takeaway box', 690, 335, 270, 270],
];

/* Seeds only a brand-new database. Once the admin has categories of their
   own, an empty menu stays empty rather than refilling itself on restart. */
function seedIfEmpty() {
  const { items } = db.prepare('SELECT COUNT(*) AS items FROM items').get();
  const { cats } = db.prepare('SELECT COUNT(*) AS cats FROM categories').get();
  if (items > 0 || cats > 0) return false;

  // SEED rows name their category by slug.
  const insert = db.prepare(`
    INSERT INTO items (name, price, category_id, image, alt, crop_x, crop_y, crop_w, crop_h, position)
    VALUES (?, ?, (SELECT id FROM categories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?)`);

  transaction(() => {
    insertDefaultCategories();
    SEED.forEach((row, i) => insert.run(...row, i));
  });
  return true;
}

/** Remove expired sessions. Cheap enough to call on every request path that reads one. */
function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = { db, seedIfEmpty, pruneSessions, transaction, DB_PATH, ROOT };
