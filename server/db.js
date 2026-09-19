'use strict';
/* SQLite schema, migrations and first-run seed.
   Uses node:sqlite (built into Node 22) so the project has no dependencies. */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

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

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  category   TEXT    NOT NULL CHECK (category IN ('drinks','food')),
  image      TEXT    NOT NULL,
  alt        TEXT    NOT NULL DEFAULT '',
  -- When crop_w is NULL the image is shown whole (object-fit: cover).
  -- Otherwise it is a sprite window onto a shared menu poster.
  crop_x     INTEGER,
  crop_y     INTEGER,
  crop_w     INTEGER,
  crop_h     INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_order ON items(category, position, id);
`);

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

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM items').get();
  if (n > 0) return false;

  const insert = db.prepare(`
    INSERT INTO items (name, price, category, image, alt, crop_x, crop_y, crop_w, crop_h, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    SEED.forEach((row, i) => insert.run(...row, i));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

/** Remove expired sessions. Cheap enough to call on every request path that reads one. */
function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = { db, seedIfEmpty, pruneSessions, DB_PATH, ROOT };
