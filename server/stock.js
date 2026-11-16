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
   placed.

   Counting by flavor: an item can instead be counted per option of one
   required "choose one" group (Tres leches: Mango 1, Ube 7, Moca 6). Each
   flavor has its own moves (option_id) and the same sum, over the lines
   that chose it (order_items.option_ids). The item's left is then the sum
   of its flavors. A flavor of that group with no count yet has none left. */

const { db, transaction } = require('./db');

const QTY_MAX = 9999;
const NAME_MAX = 40;
const MAX_ITEM_INGREDIENTS = 20;

const lazy = {
  get ValidationError() { return require('./menu').ValidationError; },
  get audit() { return require('./audit'); },
  get options() { return require('./options'); },
};

/* ---------------------------- counts ---------------------------- */

// The latest stock take of each counted item. An 'off' after it ends counting.
const latestCounts = db.prepare(`
  SELECT m.id, m.item_id, m.qty, m.handed, m.at FROM stock_moves m
  WHERE m.kind = 'count' AND m.option_id IS NULL
    AND m.id = (SELECT MAX(id) FROM stock_moves
                WHERE item_id = m.item_id AND option_id IS NULL AND kind IN ('count', 'off'))`);

const addsSince = db.prepare(`
  SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves
  WHERE item_id = ? AND option_id IS NULL AND kind = 'add' AND id > ?`);

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

// The same four, for each flavor.
const latestFlavorCounts = db.prepare(`
  SELECT m.id, m.item_id, m.option_id, m.qty, m.handed, m.at, op.name, op.group_id, op.position
  FROM stock_moves m JOIN options op ON op.id = m.option_id
  WHERE m.kind = 'count'
    AND m.id = (SELECT MAX(id) FROM stock_moves
                WHERE item_id = m.item_id AND option_id = m.option_id AND kind IN ('count', 'off'))
  ORDER BY m.item_id, op.position, op.id`);

const flavorAddsSince = db.prepare(`
  SELECT COALESCE(SUM(qty), 0) AS n FROM stock_moves
  WHERE item_id = ? AND option_id = ? AND kind = 'add' AND id > ?`);

const flavorHandedOverAll = db.prepare(`
  SELECT COALESCE(SUM(oi.qty - oi.voided_qty), 0) AS n
  FROM order_items oi JOIN orders o ON o.id = oi.order_id, json_each(oi.option_ids) j
  WHERE oi.item_id = ? AND j.value = ?
    AND o.status <> 'cancelled' AND (o.status = 'completed' OR o.paid_at IS NOT NULL)`);

const flavorOpenUnits = db.prepare(`
  SELECT oi.item_id, j.value AS option_id, SUM(oi.qty - oi.voided_qty) AS n
  FROM order_items oi JOIN orders o ON o.id = oi.order_id, json_each(oi.option_ids) j
  WHERE oi.item_id IS NOT NULL AND o.status NOT IN ('cancelled', 'completed') AND o.paid_at IS NULL
  GROUP BY oi.item_id, j.value`);

/**
 * Each item counted by flavor.
 * @returns Map(item_id -> { group_id, flavors: [{ option_id, name, counted_at, counted, added, handed_over, held, left }] })
 */
function flavorLevels() {
  const counts = latestFlavorCounts.all();
  const out = new Map();
  if (!counts.length) return out;
  const held = new Map(flavorOpenUnits.all().map((r) => [`${r.item_id}:${r.option_id}`, r.n]));
  for (const c of counts) {
    const added = flavorAddsSince.get(c.item_id, c.option_id, c.id).n;
    const handedOver = flavorHandedOverAll.get(c.item_id, c.option_id).n - c.handed;
    const open = held.get(`${c.item_id}:${c.option_id}`) || 0;
    if (!out.has(c.item_id)) out.set(c.item_id, { group_id: c.group_id, flavors: [] });
    const f = out.get(c.item_id);
    if (c.group_id !== f.group_id) continue; // only one group is counted (change() keeps it so)
    f.flavors.push({
      option_id: c.option_id, name: c.name, counted_at: c.at, counted: c.qty, added,
      handed_over: handedOver, held: open, left: c.qty + added - handedOver - open,
    });
  }
  return out;
}

/**
 * Every counted item's level.
 * @returns Map(item_id -> { counted_at, counted, added, handed_over, held, left, flavors? })
 *   left can go below zero if orders took more than the last count; the menu
 *   treats that as none left. An item counted by flavor also has group_id
 *   and flavors, and its left and held are their sums (a flavor below zero
 *   counts as none).
 */
function levels() {
  const counts = latestCounts.all();
  if (!counts.length) return new Map();
  const held = new Map(openUnits.all().map((r) => [r.item_id, r.n]));
  const byFlavor = flavorLevels();
  return new Map(counts.map((c) => {
    const added = addsSince.get(c.item_id, c.id).n;
    const handedOver = handedOverAll.get(c.item_id).n - c.handed;
    const open = held.get(c.item_id) || 0;
    const level = {
      counted_at: c.at, counted: c.qty, added, handed_over: handedOver, held: open,
      left: c.qty + added - handedOver - open,
    };
    const f = byFlavor.get(c.item_id);
    if (f && f.flavors.length) {
      level.group_id = f.group_id;
      level.flavors = f.flavors;
      level.left = f.flavors.reduce((sum, x) => sum + Math.max(0, x.left), 0);
      level.held = f.flavors.reduce((sum, x) => sum + x.held, 0);
    }
    return [c.item_id, level];
  }));
}

function level(itemId) {
  return levels().get(Number(itemId)) || null;
}

/**
 * The flavor a line takes from, when its item is counted by flavor: the
 * option chosen in the counted group, with how many are left (0 when that
 * flavor has no count yet). null when the item is not counted by flavor.
 * @param item an item from menu.get/list (with flavor_group and flavor_left)
 */
function flavorOf(item, optionIds) {
  if (!item.flavor_group) return null;
  const inGroup = new Set(lazy.options.groupOptionIds(item.flavor_group));
  const id = (optionIds || []).find((x) => inGroup.has(x));
  if (id === undefined) return null;
  const left = item.flavor_left[id];
  return { id, left: left === undefined ? 0 : left, name: lazy.options.optionName(id) };
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

function move(itemId, kind, n, by, key, optionId = null) {
  const handed = kind !== 'count' ? null
    : optionId === null ? handedOverAll.get(Number(itemId)).n : flavorHandedOverAll.get(Number(itemId), optionId).n;
  db.prepare(`INSERT INTO stock_moves (item_id, option_id, kind, qty, handed, staff_id, staff_name, request_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(itemId), optionId, kind, n, handed, by ? by.id : null, by ? by.name : '', key);
}

/** The item's groups that can be counted by flavor: required, choose one. */
function countableGroups(itemId) {
  return lazy.options.groupsForItem(itemId).filter((g) => g.kind === 'single' && g.required);
}

/**
 * Check a count by flavor: [{ option_id, qty }], every option from one
 * countable group of the item.
 * @returns {{ group, counts: [{ option_id, name, qty }] }}
 */
function parseFlavors(itemId, raw) {
  const refuse = (message) => { throw new lazy.ValidationError({ flavors: message }); };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) refuse('Enter a count for each flavor.');
  const groups = countableGroups(itemId);
  const ids = raw.map((f) => Number(f && f.option_id));
  const group = groups.find((g) => g.options.some((o) => o.id === ids[0]));
  if (!group) refuse('Only a group where one must be chosen can be counted by flavor. Reload the page.');
  const seen = new Set();
  const counts = raw.map((f, i) => {
    const o = group.options.find((x) => x.id === ids[i]);
    if (!o || seen.has(o.id)) refuse('One of the flavors is not on this item. Reload the page.');
    seen.add(o.id);
    return { option_id: o.id, name: o.name, qty: qty('flavors', f.qty, 0) };
  });
  return { group, counts };
}

/**
 * Change a counted item's stock. by is the staff member at the POS, or null
 * on the Items page (the admin session).
 * action: 'count' (a stock take: what is in the shop now, including orders
 *   set aside), 'add' (a batch from the oven), or 'off' (stop counting).
 * Counting by flavor: 'count' with flavors [{ option_id, qty }] (some or all
 *   of one group's options; the first such count starts it), and 'add' with
 *   option_id. Once an item is counted by flavor, it is counted only so.
 * request_key (optional): a repeat of a request already done changes nothing.
 * @returns the item's level after, or null when it is no longer counted;
 *   undefined when the item does not exist
 */
function change(itemId, { action, qty: input, request_key: rawKey, flavors, option_id: rawOption } = {}, by = null) {
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
  const byFlavor = !!(before && before.flavors);
  const details = { item_id: Number(itemId), item: name };
  let n = 0;
  let parsed = null;
  let optionId = null;
  if (action === 'count' && flavors !== undefined) {
    parsed = parseFlavors(itemId, flavors);
    if (byFlavor && parsed.group.id !== before.group_id) {
      throw new lazy.ValidationError({ flavors: 'This item is counted by another group. Stop counting it first.' });
    }
    details.flavors = parsed.counts.map((c) => ({ option_id: c.option_id, flavor: c.name, qty: c.qty }));
  } else if (action === 'count') {
    if (byFlavor) throw new lazy.ValidationError({ qty: 'This item is counted by flavor. Count each flavor.' });
    n = qty('qty', input, 0);
  } else if (action === 'add') {
    if (!before) throw new lazy.ValidationError({ qty: 'Do a stock take first: enter how many are in the shop.' });
    n = qty('qty', input, 1);
    if (byFlavor) {
      optionId = Number(rawOption);
      const f = before.flavors.find((x) => x.option_id === optionId)
        || countableGroups(itemId).find((g) => g.id === before.group_id)?.options.find((o) => o.id === optionId);
      if (!f) throw new lazy.ValidationError({ qty: 'Choose the flavor to add to.' });
      details.option_id = optionId;
      details.flavor = f.name;
    } else if (rawOption !== undefined && rawOption !== null && rawOption !== '') {
      throw new lazy.ValidationError({ qty: 'This item is not counted by flavor.' });
    }
  } else if (action !== 'off') {
    throw new lazy.ValidationError({ action: 'Choose a stock take, add stock or stop counting.' });
  }
  if (action === 'off' && !before) return null;

  return transaction(() => {
    if (parsed) {
      // The item needs a count of its own to be counted; its left is then the flavors' sum.
      // The request key goes on the first move only (it is unique).
      let k = key;
      if (!before) { move(itemId, 'count', parsed.counts.reduce((sum, c) => sum + c.qty, 0), by, k); k = null; }
      for (const c of parsed.counts) { move(itemId, 'count', c.qty, by, k, c.option_id); k = null; }
    } else {
      move(itemId, action, n, by, key);
      if (optionId !== null) move(itemId, 'add', n, by, null, optionId);
      if (action === 'off' && byFlavor) for (const f of before.flavors) move(itemId, 'off', 0, by, null, f.option_id);
    }
    const after = level(itemId);
    lazy.audit.record({
      action: `stock_${action}`, staff: by,
      details: { ...details, qty: n, left_before: before ? before.left : null, left_after: after ? after.left : null },
    });
    return after;
  });
}

/**
 * Before a handed-over order is deleted (orders.remove): its units leave
 * "handed over in all", which would put them back on the count. A counted
 * item keeps the count it has, so each gets a move that takes them off again
 * (and each flavor counted, too). Call inside the delete's transaction. An
 * open order needs nothing: deleting it frees what it held, like cancelling it.
 */
function keepCountsOnDelete(orderId, by = null) {
  const counted = levels();
  const lines = db.prepare(`
    SELECT item_id, SUM(qty - voided_qty) AS n FROM order_items
    WHERE order_id = ? AND item_id IS NOT NULL GROUP BY item_id`).all(Number(orderId));
  for (const l of lines) {
    if (counted.has(l.item_id) && l.n > 0) move(l.item_id, 'add', -l.n, by, null);
  }
  const flavors = db.prepare(`
    SELECT oi.item_id, j.value AS option_id, SUM(oi.qty - oi.voided_qty) AS n
    FROM order_items oi, json_each(oi.option_ids) j
    WHERE oi.order_id = ? AND oi.item_id IS NOT NULL GROUP BY oi.item_id, j.value`).all(Number(orderId));
  for (const f of flavors) {
    const level = counted.get(f.item_id);
    if (level && level.flavors && level.flavors.some((x) => x.option_id === f.option_id) && f.n > 0) {
      move(f.item_id, 'add', -f.n, by, null, f.option_id);
    }
  }
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
  QTY_MAX, levels, level, flavorOf, change, missing, keepCountsOnDelete,
  listIngredients, getIngredient, createIngredient, renameIngredient, setIngredientStock, removeIngredient,
  itemIngredientIds, parseItemIngredients, setItemIngredients,
};
