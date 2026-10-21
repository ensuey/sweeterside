'use strict';
/* Menu category validation and CRUD. Like menu.js, every field an admin can
   submit is checked here before it reaches the database. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');

const NAME_MAX = 60;
const LABEL_MAX = 30;

// Slugs become element ids and filter keys on the customer page, so they must
// not collide with ids the page template already uses, or with the "all" chip.
const RESERVED_SLUGS = new Set([
  'all', 'menu', 'q', 'sheet', 'sheet-shot', 'sheet-img', 'sheet-name', 'sheet-price', 'sheet-tag',
]);

function slugify(name) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'category';
  const taken = (s) => RESERVED_SLUGS.has(s)
    || db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(s);
  let slug = base;
  for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/**
 * Validate a submitted category.
 * @param {number|null} id  the category being edited, so its own name is not a clash
 * @throws {ValidationError}
 */
function validate(input, id = null) {
  const errors = {};

  const name = String(input.name ?? '').trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;
  else {
    const clash = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name);
    if (clash && clash.id !== id) errors.name = 'Another category already has that name.';
  }

  // The short label is optional and falls back to the full name.
  const label = String(input.label ?? '').trim() || name;
  if (label.length > LABEL_MAX) errors.label = `Keep the short label under ${LABEL_MAX} characters.`;

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, label };
}

/* ---------------------------- queries ---------------------------- */

const SELECT = `SELECT c.id, c.slug, c.name, c.label, c.position,
                       (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS item_count
                FROM categories c`;

function list() {
  return db.prepare(`${SELECT} ORDER BY c.position, c.id`).all();
}

function get(id) {
  return db.prepare(`${SELECT} WHERE c.id = ?`).get(Number(id)) || null;
}

function create(input) {
  const row = validate(input);
  const { next } = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories').get();

  const info = db.prepare(
    'INSERT INTO categories (slug, name, label, position) VALUES (?, ?, ?, ?)'
  ).run(slugify(row.name), row.name, row.label, next);

  return get(info.lastInsertRowid);
}

function update(id, input) {
  if (!get(id)) return null;
  const row = validate(input, Number(id));

  db.prepare(`UPDATE categories SET name = ?, label = ?, updated_at = datetime('now')
              WHERE id = ?`).run(row.name, row.label, Number(id));
  return get(id);
}

/**
 * Delete an empty category. Refuses while items still use it, so a delete can
 * never take menu items down with it.
 * @returns {boolean} false if it did not exist
 */
function remove(id) {
  const existing = get(id);
  if (!existing) return false;
  if (existing.item_count > 0) {
    const n = existing.item_count;
    throw Object.assign(new Error(
      `“${existing.name}” still has ${n} item${n === 1 ? '' : 's'}. ` +
      'Move them to another category or delete them first.'), { status: 409 });
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id));
  return true;
}

/** Set the display order from an array of every category id. */
function reorder(ids) {
  const current = list().map((c) => c.id).sort((a, b) => a - b);
  const given = ids.map(Number).sort((a, b) => a - b);
  if (given.length !== current.length || given.some((v, i) => v !== current[i])) {
    throw Object.assign(new Error('The category list changed. Reload the page and try again.'),
      { status: 409 });
  }

  const stmt = db.prepare('UPDATE categories SET position = ? WHERE id = ?');
  transaction(() => ids.forEach((id, i) => stmt.run(i, Number(id))));
  return list();
}

module.exports = { list, get, create, update, remove, reorder, validate, slugify };
