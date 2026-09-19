'use strict';
/* Menu item validation and CRUD. Every field an admin can submit is checked
   here — the HTTP layer never writes to the database directly. */

const path = require('node:path');
const fs = require('node:fs');
const { db, ROOT } = require('./db');
const imagesize = require('./imagesize');

const CATEGORIES = ['drinks', 'food'];
const MAX_PRICE = 100000;
const NAME_MAX = 80;
const ALT_MAX = 300;

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.errors = errors; // { field: message }
  }
}

/** Resolve an image path from the client to a real file under assets/. */
function resolveImage(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').trim();
  if (!clean.startsWith('assets/')) return null;
  if (clean.includes('..') || clean.includes('\0')) return null;

  const abs = path.resolve(ROOT, clean);
  const assetsRoot = path.resolve(ROOT, 'assets');
  // Containment check — defeats traversal even if the prefix test is fooled.
  if (abs !== assetsRoot && !abs.startsWith(assetsRoot + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;

  const size = imagesize.fromFile(abs);
  if (!size) return null;
  return { rel: clean, abs, ...size };
}

function intOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Validate a submitted item.
 * @returns normalised row ready for insert/update
 * @throws {ValidationError}
 */
function validate(input) {
  const errors = {};

  const name = String(input.name ?? '').trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;

  const priceNum = Number(input.price);
  let price = null;
  if (input.price === '' || input.price === null || input.price === undefined) {
    errors.price = 'Enter a price.';
  } else if (!Number.isInteger(priceNum)) {
    errors.price = 'Price must be a whole number of pesos.';
  } else if (priceNum < 0 || priceNum > MAX_PRICE) {
    errors.price = `Price must be between 0 and ${MAX_PRICE}.`;
  } else {
    price = priceNum;
  }

  const category = String(input.category ?? '').trim();
  if (!CATEGORIES.includes(category)) errors.category = 'Choose a category.';

  const image = resolveImage(input.image);
  if (!image) errors.image = 'Choose an image that exists in assets/.';

  const alt = String(input.alt ?? '').trim().slice(0, ALT_MAX);

  // Crop is all-or-nothing: four numbers, or none at all.
  const cx = intOrNull(input.crop_x);
  const cy = intOrNull(input.crop_y);
  const cw = intOrNull(input.crop_w);
  const ch = intOrNull(input.crop_h);
  const given = [cx, cy, cw, ch].filter((v) => v !== null);

  let crop = { x: null, y: null, w: null, h: null };
  if (given.length > 0) {
    if (given.length < 4) {
      errors.crop = 'A crop needs all four values, or leave them all blank.';
    } else if ([cx, cy, cw, ch].some(Number.isNaN)) {
      errors.crop = 'Crop values must be whole numbers.';
    } else if (cw <= 0 || ch <= 0) {
      errors.crop = 'Crop width and height must be greater than zero.';
    } else if (cx < 0 || cy < 0) {
      errors.crop = 'Crop position cannot be negative.';
    } else if (image && (cx + cw > image.width || cy + ch > image.height)) {
      errors.crop = `Crop falls outside the image (${image.width}x${image.height}).`;
    } else {
      crop = { x: cx, y: cy, w: cw, h: ch };
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  return {
    name, price, category, image: image.rel, alt,
    crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h,
  };
}

/* ---------------------------- queries ---------------------------- */

const SELECT = `SELECT id, name, price, category, image, alt,
                       crop_x, crop_y, crop_w, crop_h, position
                FROM items`;

function list() {
  return db.prepare(`${SELECT} ORDER BY
    CASE category WHEN 'drinks' THEN 0 ELSE 1 END, position, id`).all();
}

function get(id) {
  return db.prepare(`${SELECT} WHERE id = ?`).get(Number(id)) || null;
}

function create(input) {
  const row = validate(input);
  const { next } = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM items WHERE category = ?'
  ).get(row.category);

  const info = db.prepare(`
    INSERT INTO items (name, price, category, image, alt, crop_x, crop_y, crop_w, crop_h, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.name, row.price, row.category, row.image, row.alt,
    row.crop_x, row.crop_y, row.crop_w, row.crop_h, next);

  return get(info.lastInsertRowid);
}

function update(id, input) {
  const existing = get(id);
  if (!existing) return null;
  const row = validate(input);

  db.prepare(`
    UPDATE items SET name = ?, price = ?, category = ?, image = ?, alt = ?,
      crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    row.name, row.price, row.category, row.image, row.alt,
    row.crop_x, row.crop_y, row.crop_w, row.crop_h, Number(id));

  return get(id);
}

function remove(id) {
  const existing = get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM items WHERE id = ?').run(Number(id));
  return true;
}

/** Reorder within a category from an array of ids. */
function reorder(ids) {
  const stmt = db.prepare('UPDATE items SET position = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => stmt.run(i, Number(id)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return list();
}

/** Images already present in assets/ that an item can point at. */
function availableImages() {
  const assetsRoot = path.resolve(ROOT, 'assets');
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'css' || entry.name === 'js') continue;
        walk(abs, rel);
      } else {
        const size = imagesize.fromFile(abs);
        if (size) out.push({ path: `assets/${rel}`, width: size.width, height: size.height });
      }
    }
  };
  walk(assetsRoot, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  CATEGORIES, ValidationError,
  list, get, create, update, remove, reorder,
  availableImages, resolveImage, validate,
};
