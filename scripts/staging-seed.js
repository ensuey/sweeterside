#!/usr/bin/env node
'use strict';
/* Make a starting database for the staging site from the live one.
     node scripts/staging-seed.js /data/app.db /data/staging-seed.db

   Only the menu and the shop's set-up are copied: categories, items,
   options, ingredients, delivery areas, vouchers, the cake gallery and
   settings. Nothing about people is copied: no customers, orders, cake
   bookings, payments, shifts, staff, admin accounts, Utang accounts,
   blocked phones, reviews, alerts or audit log (RA 10173). Tracking IDs and
   secrets are left out too. The live database is opened read-only.

   This is a list of what to copy, not of what to leave out, so a new table
   stays out of staging until someone adds it here on purpose. */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const COPY = [
  'categories', 'items', 'option_groups', 'options', 'item_option_groups',
  'ingredients', 'item_ingredients', 'delivery_areas', 'vouchers', 'cake_gallery', 'settings',
];
// Settings that point at the shop's ad and analytics accounts, and any key or
// secret (checkout_secret signs live checkout tokens). Staging makes its own.
const SKIP_SETTINGS = /pixel|ga4|gads|clarity|secret|token|key/i;

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node scripts/staging-seed.js <live.db> <new-staging.db>');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}.`);
  process.exit(1);
}
if (fs.existsSync(target)) {
  console.error(`${target} already exists. Pick a new file name.`);
  process.exit(1);
}
if (path.resolve(source) === path.resolve(target)) {
  console.error('The source and the target must be different files.');
  process.exit(1);
}

// Build the empty schema in the target with the app's own migrations.
process.env.DB_PATH = path.resolve(target);
const { db } = require('../server/db');
require('../server/delivery'); // creates delivery_areas

const src = new DatabaseSync(path.resolve(source), { readOnly: true });
const columns = (conn, table) => conn.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name);
const counts = {};

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const table of COPY) {
    const have = new Set(columns(src, table));
    const cols = columns(db, table).filter((c) => have.has(c));
    if (!cols.length) { counts[table] = 'not in the live database'; continue; }
    // Table and column names come from the list above and from the schema, never from input.
    db.exec(`DELETE FROM "${table}"`);
    const list = cols.map((c) => `"${c}"`).join(', ');
    const insert = db.prepare(`INSERT INTO "${table}" (${list}) VALUES (${cols.map(() => '?').join(', ')})`);
    let n = 0;
    for (const row of src.prepare(`SELECT ${list} FROM "${table}"`).all()) {
      if (table === 'settings' && SKIP_SETTINGS.test(String(row.key))) continue;
      insert.run(...cols.map((c) => row[c]));
      n++;
    }
    counts[table] = n;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
} finally {
  db.exec('PRAGMA foreign_keys = ON');
  src.close();
}

for (const [table, n] of Object.entries(counts)) console.log(`${table}: ${n}`);
console.log(`Wrote ${target}. Copy the uploads folder too, for the item and gallery photos.`);
