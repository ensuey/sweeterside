'use strict';
/* SQLite schema, migrations and first-run seed.
   Uses node:sqlite (built into Node 22) so the project has no dependencies. */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { ROOT, DB_PATH } = require('./paths');

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
`);

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
