'use strict';
/* Menu item validation and CRUD. Every field an admin can submit is checked
   here — the HTTP layer never writes to the database directly. */

const path = require('node:path');
const fs = require('node:fs');
const { db } = require('./db');
const { ROOT, ASSETS_DIR, UPLOAD_DIR, UPLOAD_URL_PREFIX } = require('./paths');
const imagesize = require('./imagesize');
const { manilaDayStartSql } = require('./clock');

const MAX_PRICE = 100000;
const NAME_MAX = 80;
const ALT_MAX = 300;
const SALE_PERCENT_MAX = 90;

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.errors = errors; // { field: message }
  }
}

/**
 * Map an "assets/…" URL path to a real file and check it stays inside the
 * directory that is meant to back it. Uploads keep the assets/uploads/ prefix
 * but may live on a mounted volume somewhere else entirely.
 */
function imagePathToDisk(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').trim();
  if (!clean.startsWith('assets/')) return null;
  if (clean.includes('..') || clean.includes('\0')) return null;

  const uploadPrefix = `${UPLOAD_URL_PREFIX}/`;
  const base = clean.startsWith(uploadPrefix) ? UPLOAD_DIR : ASSETS_DIR;
  const tail = clean.startsWith(uploadPrefix)
    ? clean.slice(uploadPrefix.length)
    : clean.slice('assets/'.length);
  if (!tail) return null;

  const abs = path.resolve(base, tail);
  // Containment check — defeats traversal even if the prefix test is fooled.
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return { clean, abs };
}

/** Resolve an image path from the client to a real file. */
function resolveImage(rel) {
  const mapped = imagePathToDisk(rel);
  if (!mapped) return null;
  if (!fs.existsSync(mapped.abs) || !fs.statSync(mapped.abs).isFile()) return null;

  const size = imagesize.fromFile(mapped.abs);
  if (!size) return null;
  return { rel: mapped.clean, abs: mapped.abs, ...size };
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

  const categoryId = Number(input.category_id);
  const categoryOk = Number.isInteger(categoryId)
    && db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId);
  if (!categoryOk) errors.category = 'Choose a category.';

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

  const bestSeller = input.best_seller === true || input.best_seller === 'true'
    || input.best_seller === 1 || input.best_seller === '1';

  // A sale is kept as its rule, so the full price is never lost.
  const saleType = String(input.sale_type ?? '');
  let saleValue = null;
  if (!['', 'percent', 'amount'].includes(saleType)) {
    errors.sale = 'Choose no sale, % off or Php off.';
  } else if (saleType) {
    saleValue = intOrNull(input.sale_value);
    if (saleValue === null || Number.isNaN(saleValue)) {
      errors.sale = 'Enter the discount as a whole number.';
    } else if (saleType === 'percent' && (saleValue < 1 || saleValue > SALE_PERCENT_MAX)) {
      errors.sale = `Take between 1% and ${SALE_PERCENT_MAX}% off.`;
    } else if (saleType === 'amount' && price !== null && (saleValue < 1 || saleValue >= price)) {
      errors.sale = 'Take at least Php 1 off, and less than the full price.';
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  return {
    name, price, category_id: categoryId, image: image.rel, alt,
    crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h,
    best_seller: bestSeller ? 1 : 0, sale_type: saleType, sale_value: saleValue,
  };
}

/** The price customers pay today: the full price, or the sale price. */
function salePrice(item) {
  if (item.sale_type === 'percent') return Math.round((item.price * (100 - item.sale_value)) / 100);
  if (item.sale_type === 'amount') return Math.max(0, item.price - item.sale_value);
  return item.price;
}

/* ---------------------------- stock ---------------------------- */

// available: on the menu. unavailable: hidden from the menu. sold_out: shown
// greyed out and cannot be ordered, until the admin changes it back.
const AVAILABILITY = ['available', 'unavailable', 'sold_out'];
const LIMIT_MAX = 9999;

/**
 * Quantity of each item on today's orders (Manila time), leaving out
 * cancelled ones, so cancelling an order frees its quantity again.
 * @returns Map(item_id -> qty)
 */
function soldToday(now = new Date()) {
  const rows = db.prepare(`
    SELECT oi.item_id, SUM(oi.qty) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status <> 'cancelled' AND o.created_at >= ? AND oi.item_id IS NOT NULL
    GROUP BY oi.item_id`).all(manilaDayStartSql(now));
  return new Map(rows.map((r) => [r.item_id, r.qty]));
}

/**
 * Adds sold_today, remaining (null when unlimited) and sold_out, which is
 * true when marked sold out or when today's limit is used up. The limit
 * comes back by itself at midnight because tomorrow's count starts at zero.
 */
function withStock(item, sold) {
  const sold_today = sold.get(item.id) || 0;
  const remaining = item.daily_limit === null ? null : Math.max(0, item.daily_limit - sold_today);
  return {
    ...item, best_seller: item.best_seller === 1, sale_price: salePrice(item),
    sold_today, remaining, sold_out: item.availability === 'sold_out' || remaining === 0,
  };
}

/** @returns { availability, daily_limit } or throws ValidationError */
function validateStock(input) {
  const errors = {};
  const availability = String(input.availability ?? '');
  if (!AVAILABILITY.includes(availability)) errors.availability = 'Choose available, not available or sold out.';

  let dailyLimit = intOrNull(input.daily_limit);
  if (Number.isNaN(dailyLimit) || (dailyLimit !== null && (dailyLimit < 1 || dailyLimit > LIMIT_MAX))) {
    errors.daily_limit = `Enter a whole number from 1 to ${LIMIT_MAX}, or leave it blank for no limit.`;
    dailyLimit = null;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { availability, daily_limit: dailyLimit };
}

function setStock(id, input) {
  if (!get(id)) return null;
  const { availability, daily_limit } = validateStock(input);
  db.prepare(`UPDATE items SET availability = ?, daily_limit = ?, updated_at = datetime('now')
              WHERE id = ?`).run(availability, daily_limit, Number(id));
  return get(id);
}

/* ---------------------------- queries ---------------------------- */

const SELECT = `SELECT i.id, i.name, i.price, i.category_id, i.image, i.alt,
                       i.crop_x, i.crop_y, i.crop_w, i.crop_h, i.position,
                       i.availability, i.daily_limit, i.best_seller, i.sale_type, i.sale_value
                FROM items i`;

/** Items in menu order: by category position, then item position. */
function list({ now } = {}) {
  const sold = soldToday(now);
  return db.prepare(`${SELECT} JOIN categories c ON c.id = i.category_id
    ORDER BY c.position, c.id, i.position, i.id`).all().map((item) => withStock(item, sold));
}

function get(id, { now } = {}) {
  const item = db.prepare(`${SELECT} WHERE i.id = ?`).get(Number(id));
  return item ? withStock(item, soldToday(now)) : null;
}

function create(input) {
  const row = validate(input);
  const { next } = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM items WHERE category_id = ?'
  ).get(row.category_id);

  const info = db.prepare(`
    INSERT INTO items (name, price, category_id, image, alt, crop_x, crop_y, crop_w, crop_h, position,
                       best_seller, sale_type, sale_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.name, row.price, row.category_id, row.image, row.alt,
    row.crop_x, row.crop_y, row.crop_w, row.crop_h, next,
    row.best_seller, row.sale_type, row.sale_value);

  return get(info.lastInsertRowid);
}

function update(id, input) {
  const existing = get(id);
  if (!existing) return null;
  const row = validate(input);

  db.prepare(`
    UPDATE items SET name = ?, price = ?, category_id = ?, image = ?, alt = ?,
      crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?,
      best_seller = ?, sale_type = ?, sale_value = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    row.name, row.price, row.category_id, row.image, row.alt,
    row.crop_x, row.crop_y, row.crop_w, row.crop_h,
    row.best_seller, row.sale_type, row.sale_value, Number(id));

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

/** Images an item can point at: bundled assets plus anything uploaded. */
function availableImages() {
  const out = [];
  const seen = new Set();

  const walk = (dir, urlPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // directory may not exist yet (no uploads so far)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const url = `${urlPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        // Skip stylesheets/scripts, and skip an uploads folder nested inside
        // assets — it is walked separately so a volume mount is picked up.
        if (['css', 'js', 'uploads'].includes(entry.name)) continue;
        walk(abs, url);
      } else {
        const size = imagesize.fromFile(abs);
        if (size && !seen.has(url)) {
          seen.add(url);
          out.push({ path: url, width: size.width, height: size.height });
        }
      }
    }
  };

  walk(ASSETS_DIR, 'assets');
  walk(UPLOAD_DIR, UPLOAD_URL_PREFIX);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  ValidationError,
  AVAILABILITY, list, get, create, update, remove, reorder, setStock, salePrice,
  availableImages, resolveImage, validate,
};
