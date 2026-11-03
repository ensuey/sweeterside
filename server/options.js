'use strict';
/* Item options: groups such as "Size", "Add-ons" or "Sugar level", made once
   and attached to any number of items. A group is single (choose one) or
   multiple (choose min to max), and required or optional. Each option adds
   its price to the item's price (it may be 0).

   The server checks every choice: the options must be on that item, be
   available, and fit each group's rules. The price of a line is the item's
   price plus its options, and a sale on the item applies to the whole (see
   claude/pos-plan.md, "Options"). Lines keep a copy of the options chosen,
   so later edits do not change old orders. */

const { db, transaction } = require('./db');
const { ValidationError, salePrice } = require('./menu');

const NAME_MAX = 40;
const MAX_OPTION_PRICE = 10000; // pesos
const MAX_OPTIONS = 30; // per group
const MAX_GROUPS = 100;
const MAX_ITEM_GROUPS = 10; // per item
const MAX_CHOSEN = 50; // option ids on one line
const KINDS = ['single', 'multiple'];

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/* ---------------------------- reading ---------------------------- */

function optionsOf(groupId) {
  return db.prepare('SELECT * FROM options WHERE group_id = ? ORDER BY position, id').all(groupId)
    .map((o) => ({ id: o.id, name: o.name, price: o.price_cents / 100, available: o.available === 1 }));
}

function shapeGroup(g) {
  return {
    id: g.id, name: g.name, kind: g.kind, required: g.required === 1,
    min: g.min_select, max: g.max_select, position: g.position, options: optionsOf(g.id),
  };
}

/** Every group with its options and the items it is on, for the admin. */
function listGroups() {
  const items = db.prepare('SELECT group_id, item_id FROM item_option_groups').all();
  return db.prepare('SELECT * FROM option_groups ORDER BY position, id').all().map((g) => ({
    ...shapeGroup(g), item_ids: items.filter((r) => r.group_id === g.id).map((r) => r.item_id),
  }));
}

function getGroup(id) {
  const g = db.prepare('SELECT * FROM option_groups WHERE id = ?').get(Number(id));
  return g ? shapeGroup(g) : null;
}

/** The ids of the groups on an item, in order. */
function itemGroupIds(itemId) {
  return db.prepare('SELECT group_id FROM item_option_groups WHERE item_id = ? ORDER BY position, group_id')
    .all(Number(itemId)).map((r) => r.group_id);
}

/** The groups on an item, each with its options. */
function groupsForItem(itemId) {
  return db.prepare(`
    SELECT g.* FROM option_groups g JOIN item_option_groups ig ON ig.group_id = g.id
    WHERE ig.item_id = ? ORDER BY ig.position, g.position, g.id`).all(Number(itemId))
    .map(shapeGroup).filter((g) => g.options.length > 0);
}

/**
 * The options of every item that has some, for the menu and the POS:
 * { item_id: { price, sale_type, sale_value, groups } }. Unavailable options
 * are kept (shown greyed out) so the choices do not jump around.
 */
function menuOptions(items) {
  const out = {};
  for (const item of items) {
    const groups = groupsForItem(item.id);
    if (groups.length) {
      out[item.id] = {
        price: item.price, sale_type: item.sale_type || '', sale_value: item.sale_value ?? null,
        groups: groups.map((g) => ({
          id: g.id, name: g.name, kind: g.kind, required: g.required, min: g.min, max: g.max,
          options: g.options.map((o) => ({ id: o.id, name: o.name, price: o.price, available: o.available })),
        })),
      };
    }
  }
  return out;
}

/* ---------------------------- choosing ---------------------------- */

/** The price of one unit with these options: regular, and at the item's sale. */
function linePrices(item, optionsCents = 0) {
  const full = item.price + optionsCents / 100;
  return {
    unit_cents: full * 100,
    sale_cents: salePrice({ price: full, sale_type: item.sale_type, sale_value: item.sale_value }) * 100,
  };
}

/** "Size: Large · Add-ons: Extra shot, Oat milk" */
function optionsText(snapshot) {
  const groups = [];
  for (const o of snapshot || []) {
    const g = groups.find((x) => x.group === o.group);
    if (g) g.names.push(o.name);
    else groups.push({ group: o.group, names: [o.name] });
  }
  return groups.map((g) => `${g.group}: ${g.names.join(', ')}`).join(' · ');
}

/**
 * Check the options chosen for one item and price them.
 * @returns {{ ids: number[], key: string, snapshot: [{group, name, price_cents}], options_cents }}
 * @throws ValidationError({ items }) with a message the customer can act on
 */
function choose(item, rawIds) {
  const refuse = (message) => { throw new ValidationError({ items: message }); };
  if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) refuse('One of the cart lines is not valid.');
  const raw = rawIds || [];
  if (raw.length > MAX_CHOSEN) refuse('One of the cart lines is not valid.');
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) refuse('One of the cart lines is not valid.');

  const groups = groupsForItem(item.id);
  const byId = new Map();
  for (const g of groups) for (const o of g.options) byId.set(o.id, { o, g });

  for (const id of ids) {
    const found = byId.get(id);
    if (!found) refuse(`One of the options chosen is not on ${item.name}. Choose again.`);
    if (!found.o.available) refuse(`${found.o.name} for ${item.name} is not available right now.`);
  }
  for (const g of groups) {
    const n = ids.filter((id) => byId.get(id).g.id === g.id).length;
    if (n < g.min) {
      refuse(g.kind === 'single' || g.min === 1 ? `Choose ${g.name.toLowerCase()} for ${item.name}.`
        : `Choose at least ${g.min} ${g.name.toLowerCase()} for ${item.name}.`);
    }
    if (n > g.max) {
      refuse(g.max === 1 ? `Choose only one ${g.name.toLowerCase()} for ${item.name}.`
        : `Choose at most ${g.max} ${g.name.toLowerCase()} for ${item.name}.`);
    }
  }

  // In menu order: group by group, option by option.
  const snapshot = [];
  const chosen = [];
  for (const g of groups) {
    for (const o of g.options) {
      if (ids.includes(o.id)) {
        snapshot.push({ group: g.name, name: o.name, price_cents: Math.round(o.price * 100) });
        chosen.push(o.id);
      }
    }
  }
  const sorted = [...chosen].sort((a, b) => a - b);
  return {
    ids: sorted, key: sorted.length ? `${item.id}:${sorted.join('.')}` : String(item.id),
    snapshot, options_cents: snapshot.reduce((sum, o) => sum + o.price_cents, 0),
  };
}

/* ---------------------------- managing ---------------------------- */

function validateGroup(input) {
  const errors = {};
  const name = clean(input.name);
  if (!name) errors.name = 'Enter the group name, e.g. Size or Add-ons.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;

  const kind = String(input.kind ?? 'single');
  if (!KINDS.includes(kind)) errors.kind = 'Choose "pick one" or "pick several".';
  const required = truthy(input.required);

  const rawOptions = Array.isArray(input.options) ? input.options : [];
  if (rawOptions.length === 0) errors.options = 'Add at least one option.';
  else if (rawOptions.length > MAX_OPTIONS) errors.options = `Keep it to ${MAX_OPTIONS} options or fewer.`;
  const seen = new Set();
  const options = [];
  for (const o of rawOptions.slice(0, MAX_OPTIONS)) {
    const oname = clean(o && o.name);
    const price = o && (o.price === '' || o.price === null || o.price === undefined) ? 0 : Number(o && o.price);
    const id = o && o.id !== undefined && o.id !== null && o.id !== '' ? Number(o.id) : null;
    if (!oname) errors.options = 'Every option needs a name.';
    else if (oname.length > NAME_MAX) errors.options = `Keep option names under ${NAME_MAX} characters.`;
    else if (seen.has(oname.toLowerCase())) errors.options = `"${oname}" is in the list twice.`;
    if (!Number.isInteger(price) || price < 0 || price > MAX_OPTION_PRICE) {
      errors.options = `Option prices are whole pesos from 0 to ${MAX_OPTION_PRICE}.`;
    }
    if (id !== null && (!Number.isInteger(id) || id < 1)) errors.options = 'One of the options is not valid.';
    seen.add(oname.toLowerCase());
    options.push({ id, name: oname, price_cents: price * 100, available: !(o && o.available === false) });
  }

  // single: exactly one when required, at most one when optional.
  // multiple: min (1 or more when required, else 0) to max.
  let min = required ? 1 : 0;
  let max = 1;
  if (kind === 'multiple') {
    max = input.max === '' || input.max === undefined || input.max === null ? options.length : Number(input.max);
    if (!Number.isInteger(max) || max < 1 || max > MAX_OPTIONS) errors.max = 'Enter the most a customer may choose (1 or more).';
    if (required) {
      min = input.min === '' || input.min === undefined || input.min === null ? 1 : Number(input.min);
      if (!Number.isInteger(min) || min < 1) errors.min = 'A required group needs at least 1.';
      else if (!errors.max && min > max) errors.min = 'The least must not be more than the most.';
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, kind, required: required ? 1 : 0, min, max, options };
}

function saveOptions(groupId, options) {
  const existing = new Set(db.prepare('SELECT id FROM options WHERE group_id = ?').all(groupId).map((r) => r.id));
  const keep = new Set();
  options.forEach((o, i) => {
    if (o.id !== null && existing.has(o.id)) {
      db.prepare('UPDATE options SET name = ?, price_cents = ?, available = ?, position = ? WHERE id = ?')
        .run(o.name, o.price_cents, o.available ? 1 : 0, i, o.id);
      keep.add(o.id);
    } else if (o.id !== null) {
      throw new ValidationError({ options: 'One of the options belongs to another group. Reload the page.' });
    } else {
      db.prepare('INSERT INTO options (group_id, name, price_cents, available, position) VALUES (?, ?, ?, ?, ?)')
        .run(groupId, o.name, o.price_cents, o.available ? 1 : 0, i);
    }
  });
  // Options taken off the list go; past orders keep their own copy.
  for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM options WHERE id = ?').run(id);
}

function createGroup(input) {
  const v = validateGroup(input);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM option_groups').get();
  if (n >= MAX_GROUPS) throw new ValidationError({ name: `Keep it to ${MAX_GROUPS} groups or fewer.` });
  const id = transaction(() => {
    const { pos } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM option_groups').get();
    const gid = Number(db.prepare(`INSERT INTO option_groups (name, kind, required, min_select, max_select, position)
      VALUES (?, ?, ?, ?, ?, ?)`).run(v.name, v.kind, v.required, v.min, v.max, pos).lastInsertRowid);
    saveOptions(gid, v.options.map((o) => ({ ...o, id: null })));
    return gid;
  });
  return getGroup(id);
}

function updateGroup(id, input) {
  if (!getGroup(id)) return null;
  const v = validateGroup(input);
  transaction(() => {
    db.prepare('UPDATE option_groups SET name = ?, kind = ?, required = ?, min_select = ?, max_select = ? WHERE id = ?')
      .run(v.name, v.kind, v.required, v.min, v.max, Number(id));
    saveOptions(Number(id), v.options);
  });
  return getGroup(id);
}

/** Takes the group off every item too. Past orders keep their copy. */
function removeGroup(id) {
  return db.prepare('DELETE FROM option_groups WHERE id = ?').run(Number(id)).changes > 0;
}

/** Check a list of group ids for an item (from the item editor). */
function parseItemGroups(raw) {
  if (raw === undefined) return undefined; // not sent: leave the item's groups as they are
  if (!Array.isArray(raw) || raw.length > MAX_ITEM_GROUPS) {
    throw new ValidationError({ option_groups: `Choose up to ${MAX_ITEM_GROUPS} option groups.` });
  }
  const ids = [...new Set(raw.map(Number))];
  for (const id of ids) {
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM option_groups WHERE id = ?').get(id)) {
      throw new ValidationError({ option_groups: 'One of the option groups no longer exists. Reload the page.' });
    }
  }
  return ids;
}

/** Attach these groups to an item, in this order (inside the item's save). */
function setItemGroups(itemId, ids) {
  db.prepare('DELETE FROM item_option_groups WHERE item_id = ?').run(Number(itemId));
  const insert = db.prepare('INSERT INTO item_option_groups (item_id, group_id, position) VALUES (?, ?, ?)');
  ids.forEach((gid, i) => insert.run(Number(itemId), gid, i));
}

module.exports = {
  KINDS, listGroups, getGroup, itemGroupIds, groupsForItem, menuOptions, linePrices, optionsText,
  choose, createGroup, updateGroup, removeGroup, parseItemGroups, setItemGroups,
};
