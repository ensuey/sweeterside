'use strict';
/* "Goes well with": up to three items the cart suggests, set per category
   (drinks → brownies) with one list for any order as the fallback. Saved as
   one setting. The cart picks from them on the page; nothing is fetched. */

const { db } = require('./db');
const { ValidationError } = require('./menu');
const { getSetting, saveSetting } = require('./settings');

const MAX_PER_LIST = 3;
const KEY = 'cart_suggestions';

function stored() {
  try {
    const v = JSON.parse(getSetting(KEY, '') || '{}');
    return { any: Array.isArray(v.any) ? v.any : [], categories: v.categories && typeof v.categories === 'object' ? v.categories : {} };
  } catch {
    return { any: [], categories: {} };
  }
}

/** The lists, with items and categories removed since left out. */
function get() {
  const items = new Set(db.prepare('SELECT id FROM items').all().map((r) => r.id));
  const cats = new Set(db.prepare('SELECT id FROM categories').all().map((r) => r.id));
  const keep = (ids) => ids.map(Number).filter((id) => items.has(id)).slice(0, MAX_PER_LIST);
  const s = stored();
  const categories = {};
  for (const [cat, ids] of Object.entries(s.categories)) {
    if (cats.has(Number(cat)) && Array.isArray(ids)) {
      const list = keep(ids);
      if (list.length) categories[Number(cat)] = list;
    }
  }
  return { any: keep(s.any), categories };
}

/** Check and save { any: [ids], categories: { category_id: [ids] } }. */
function save(input) {
  const items = new Set(db.prepare('SELECT id FROM items').all().map((r) => r.id));
  const cats = new Set(db.prepare('SELECT id FROM categories').all().map((r) => r.id));
  const list = (raw, field) => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_PER_LIST) {
      throw new ValidationError({ [field]: `Choose up to ${MAX_PER_LIST} items.` });
    }
    const ids = [...new Set(raw.filter((v) => v !== '' && v !== null).map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || !items.has(id))) {
      throw new ValidationError({ [field]: 'One of the items is no longer on the menu. Reload the page.' });
    }
    return ids;
  };
  const any = list(input && input.any, 'any');
  const categories = {};
  const rawCats = input && input.categories && typeof input.categories === 'object' ? input.categories : {};
  if (Object.keys(rawCats).length > 100) throw new ValidationError({ categories: 'Too many categories.' });
  for (const [cat, ids] of Object.entries(rawCats)) {
    if (!cats.has(Number(cat))) throw new ValidationError({ categories: 'One of the categories no longer exists. Reload the page.' });
    const l = list(ids, `cat_${Number(cat)}`);
    if (l.length) categories[Number(cat)] = l;
  }
  saveSetting(KEY, JSON.stringify({ any, categories }));
  return get();
}

/** For the cart: the same lists keyed by category slug, as the cards carry it. */
function forMenu() {
  const s = get();
  const slug = new Map(db.prepare('SELECT id, slug FROM categories').all().map((r) => [r.id, r.slug]));
  const byCat = {};
  for (const [cat, ids] of Object.entries(s.categories)) byCat[slug.get(Number(cat))] = ids;
  return { any: s.any, by_cat: byCat };
}

module.exports = { MAX_PER_LIST, get, save, forMenu };
