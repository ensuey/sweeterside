'use strict';
/* Inventory: real counts for counted items (baked goods) and in-stock
   switches for ingredients (frappes). menu.js folds both into every item's
   remaining and sold_out, so the menu, the checkout and the POS all refuse
   what is not in the shop.

   A counted item's count is worked out, never stored:
     left = the last stock take
          + batches added since
          - units handed over since the stock take
          - units on orders still open (set aside, but not free to sell)
   An order is handed over once it is completed or fully paid; cancelled
   orders and voided units never count. A stock take keeps how many units had
   been handed over in all (handed), so "since" is a difference, not a clock.
   POS edits, voids, merges and cancellations need no bookkeeping of their
   own, and a pre-order for a later day holds its units from the moment it is
   placed. */

const { db, transaction } = require('./db');

const QTY_MAX = 9999;
const NAME_MAX = 40;
const MAX_ITEM_INGREDIENTS = 20;

const lazy = {
  get ValidationError() { return require('./menu').ValidationError; },
  get audit() { return require('./audit'); },
};

/* ---------------------------- counts ---------------------------- */

// The latest stock take of each counted item. An 'off' after it ends counting.
const latestCounts = db.prepare(`
  SELECT m.id, m.item_id, m.qty, m.handed, m.at FROM stock_moves m
  WHERE m.kind = 'count'
    AND m.id = (SELECT MAX(id) FROM stock_moves WHERE item_id = m.item_id AND kind IN ('count', 'off'))`);

const addsSince = db.prepare(`
  SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves WHERE item_id = ? AND kind = 'add' AND id > ?`);

// Every unit of the item ever handed over: completed or fully paid orders.
const handedOverAll = db.prepare(`
  SELECT COALESCE(SUM(oi.qty - oi.voided_qty), 0) AS n
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.item_id = ? AND o.status <> 'cancelled' AND (o.status = 'completed' OR o.paid_at IS NOT NULL)`);

const openUnits = db.prepare(`
  SELECT oi.item_id, SUM(oi.qty - oi.voided_qty) AS n
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.item_id IS NOT NULL AND o.status NOT IN ('cancelled', 'completed') AND o.paid_at IS NULL
  GROUP BY oi.item_id`);

/**
 * Every counted item's level.
 * @returns Map(item_id -> { counted_at, counted, added, handed_over, held, left })
 *   left can go below zero if orders took more than the last count; the menu
 *   treats that as none left.
 */
function levels() {
  const counts = latestCounts.all();
  if (!counts.length) return new Map();
  const held = new Map(openUnits.all().map((r) => [r.item_id, r.n]));
  return new Map(counts.map((c) => {
    const added = addsSince.get(c.item_id, c.id).n;
    const handedOver = handedOverAll.get(c.item_id).n - c.handed;
    const open = held.get(c.item_id) || 0;
    return [c.item_id, {
      counted_at: c.at, counted: c.qty, added, handed_over: handedOver, held: open,
      left: c.qty + added - handedOver - open,
    }];
  }));
}

function level(itemId) {
  return levels().get(Number(itemId)) || null;
}

function qty(field, input, min) {
  const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (!Number.isInteger(n) || n < min || n > QTY_MAX) {
    throw new lazy.ValidationError({ [field]: `Enter a whole number from ${min} to ${QTY_MAX}.` });
  }
  return n;
}

function itemName(itemId) {
  const row = db.prepare('SELECT name FROM items WHERE id = ?').get(Number(itemId));
  return row ? row.name : null;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

function move(itemId, kind, n, by, key) {
  const handed = kind === 'count' ? handedOverAll.get(Number(itemId)).n : null;
  db.prepare(`INSERT INTO stock_moves (item_id, kind, qty, handed, staff_id, staff_name, request_key)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(Number(itemId), kind, n, handed, by ? by.id : null, by ? by.name : '', key);
}

/**
 * Change a counted item's stock. by is the staff member at the POS, or null
 * on the Items page (the admin session).
 * action: 'count' (a stock take: what is in the shop now, including orders
 *   set aside), 'add' (a batch from the oven), or 'off' (stop counting).
 * request_key (optional): a repeat of a request already done changes nothing.
 * @returns the item's level after, or null when it is no longer counted;
 *   undefined when the item does not exist
 */
function change(itemId, { action, qty: input, request_key: rawKey } = {}, by = null) {
  const name = itemName(itemId);
  if (name === null) return undefined;
  let key = null;
  if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
    key = String(rawKey);
    if (!KEY_RE.test(key)) throw new lazy.ValidationError({ request_key: 'Reload the page and try again.' });
    const done = db.prepare('SELECT item_id FROM stock_moves WHERE request_key = ?').get(key);
    if (done) return level(done.item_id);
  }
  const before = level(itemId);
  let n = 0;
  if (action === 'count') n = qty('qty', input, 0);
  else if (action === 'add') {
    if (!before) throw new lazy.ValidationError({ qty: 'Do a stock take first: enter how many are in the shop.' });
    n = qty('qty', input, 1);
  } else if (action !== 'off') {
    throw new lazy.ValidationError({ action: 'Choose a stock take, add stock or stop counting.' });
  }
  if (action === 'off' && !before) return null;

  return transaction(() => {
    move(itemId, action, n, by, key);
    const after = level(itemId);
    lazy.audit.record({
      action: `stock_${action}`, staff: by,
      details: { item_id: Number(itemId), item: name, qty: n, left_before: before ? before.left : null, left_after: after ? after.left : null },
    });
    return after;
  });
}

/* ---------------------------- ingredients ---------------------------- */

/** Every ingredient with the items that need it (ids). */
function listIngredients() {
  const links = db.prepare('SELECT ingredient_id, item_id FROM item_ingredients ORDER BY item_id').all();
  return db.prepare('SELECT * FROM ingredients ORDER BY position, name COLLATE NOCASE').all().map((g) => ({
    id: g.id, name: g.name, in_stock: g.in_stock === 1,
    item_ids: links.filter((l) => l.ingredient_id === g.id).map((l) => l.item_id),
  }));
}

function getIngredient(id) {
  return listIngredients().find((g) => g.id === Number(id)) || null;
}

/**
 * The ingredients that are out, by item.
 * @returns Map(item_id -> [names])
 */
function missing() {
  const rows = db.prepare(`
    SELECT ii.item_id, g.name FROM item_ingredients ii JOIN ingredients g ON g.id = ii.ingredient_id
    WHERE g.in_stock = 0 ORDER BY g.position, g.name COLLATE NOCASE`).all();
  const map = new Map();
  for (const r of rows) map.set(r.item_id, [...(map.get(r.item_id) || []), r.name]);
  return map;
}

function parseName(input) {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new lazy.ValidationError({ name: 'Enter the ingredient, e.g. Oreo or Matcha powder.' });
  if (name.length > NAME_MAX) throw new lazy.ValidationError({ name: `Keep it under ${NAME_MAX} characters.` });
  return name;
}

function nameTaken(name, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM ingredients WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId);
}

function createIngredient(input) {
  const name = parseName(input.name);
  if (nameTaken(name)) throw new lazy.ValidationError({ name: 'There is already an ingredient with that name.' });
  const { next } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ingredients').get();
  const id = db.prepare('INSERT INTO ingredients (name, position) VALUES (?, ?)').run(name, next).lastInsertRowid;
  return getIngredient(id);
}

function renameIngredient(id, input) {
  if (!getIngredient(id)) return null;
  const name = parseName(input.name);
  if (nameTaken(name, Number(id))) throw new lazy.ValidationError({ name: 'There is already an ingredient with that name.' });
  db.prepare('UPDATE ingredients SET name = ? WHERE id = ?').run(name, Number(id));
  return getIngredient(id);
}

/** Mark an ingredient in stock or out. Audited: it takes items off the menu. */
function setIngredientStock(id, inStock, by = null) {
  const g = getIngredient(id);
  if (!g) return null;
  if (typeof inStock !== 'boolean') throw new lazy.ValidationError({ in_stock: 'Choose in stock or out.' });
  if (g.in_stock === inStock) return g;
  transaction(() => {
    db.prepare('UPDATE ingredients SET in_stock = ? WHERE id = ?').run(inStock ? 1 : 0, g.id);
    lazy.audit.record({
      action: 'ingredient_change', staff: by,
      details: { ingredient_id: g.id, ingredient: g.name, in_stock: inStock, items: g.item_ids.length },
    });
  });
  return getIngredient(id);
}

function removeIngredient(id) {
  return db.prepare('DELETE FROM ingredients WHERE id = ?').run(Number(id)).changes > 0;
}

/** The ingredient ids an item needs. */
function itemIngredientIds(itemId) {
  return db.prepare('SELECT ingredient_id FROM item_ingredients WHERE item_id = ? ORDER BY ingredient_id')
    .all(Number(itemId)).map((r) => r.ingredient_id);
}

function parseItemIngredients(raw) {
  if (raw === undefined) return undefined; // not sent: leave the item's ingredients as they are
  if (!Array.isArray(raw) || raw.length > MAX_ITEM_INGREDIENTS) {
    throw new lazy.ValidationError({ ingredients: `Choose up to ${MAX_ITEM_INGREDIENTS} ingredients.` });
  }
  const ids = [...new Set(raw.map(Number))];
  for (const id of ids) {
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(id)) {
      throw new lazy.ValidationError({ ingredients: 'One of the ingredients no longer exists. Reload the page.' });
    }
  }
  return ids;
}

/** Link these ingredients to an item (inside the item's save). */
function setItemIngredients(itemId, ids) {
  db.prepare('DELETE FROM item_ingredients WHERE item_id = ?').run(Number(itemId));
  const insert = db.prepare('INSERT INTO item_ingredients (item_id, ingredient_id) VALUES (?, ?)');
  ids.forEach((id) => insert.run(Number(itemId), id));
}

module.exports = {
  QTY_MAX, levels, level, change, missing,
  listIngredients, getIngredient, createIngredient, renameIngredient, setIngredientStock, removeIngredient,
  itemIngredientIds, parseItemIngredients, setItemIngredients,
};
