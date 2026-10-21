'use strict';
/* Tests for the security-critical pieces: password hashing, CSRF comparison,
   item validation and the image-path containment check.
   Run with:  npm test          (uses a throwaway database) */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the database somewhere disposable before anything requires it.
process.env.DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-test-')), 'test.db');

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const menu = require('../server/menu');
const categories = require('../server/categories');
const render = require('../server/render');
const imagesize = require('../server/imagesize');

seedIfEmpty();
const DRINKS_ID = db.prepare("SELECT id FROM categories WHERE slug = 'drinks'").get().id;

/* ---------------------------- passwords ---------------------------- */

test('password hash verifies and is salted', () => {
  const a = auth.hashPassword('a-long-enough-password');
  const b = auth.hashPassword('a-long-enough-password');
  assert.notStrictEqual(a, b, 'same password must not produce the same hash');
  assert.ok(auth.verifyPassword('a-long-enough-password', a));
  assert.ok(auth.verifyPassword('a-long-enough-password', b));
});

test('password verify rejects wrong passwords and junk hashes', () => {
  const hash = auth.hashPassword('correct-password-here');
  assert.strictEqual(auth.verifyPassword('wrong-password-here', hash), false);
  assert.strictEqual(auth.verifyPassword('correct-password-here', 'garbage'), false);
  assert.strictEqual(auth.verifyPassword('correct-password-here', ''), false);
  assert.strictEqual(auth.verifyPassword('', hash), false);
});

/* ---------------------------- CSRF ---------------------------- */

test('CSRF comparison rejects missing, wrong and truncated tokens', () => {
  const session = { csrf: 'abcdefghijklmnop' };
  assert.ok(auth.csrfOk(session, 'abcdefghijklmnop'));
  assert.strictEqual(auth.csrfOk(session, 'abcdefghijklmnoX'), false);
  assert.strictEqual(auth.csrfOk(session, 'abcdefgh'), false);
  assert.strictEqual(auth.csrfOk(session, undefined), false);
  assert.strictEqual(auth.csrfOk(null, 'abcdefghijklmnop'), false);
});

/* ---------------------------- cookies ---------------------------- */

test('cookie parser handles multiple pairs and missing header', () => {
  assert.deepStrictEqual(auth.parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepStrictEqual(auth.parseCookies(''), {});
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
});

test('session cookie is HttpOnly and SameSite=Strict', () => {
  const c = auth.sessionCookie('tok', { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(auth.sessionCookie('tok', { secure: false }), /Secure/);
});

/* ---------------------------- image paths ---------------------------- */

test('image paths outside assets/ are rejected', () => {
  for (const bad of [
    '../server/db.js', 'assets/../server/db.js', '/etc/passwd',
    'server/db.js', '', null, 'assets/does-not-exist.jpg',
  ]) {
    assert.strictEqual(menu.resolveImage(bad), null, `should reject: ${bad}`);
  }
});

test('a real asset resolves and reports its size', () => {
  const img = menu.resolveImage('assets/Menu Frappe.jpg');
  assert.ok(img, 'expected the poster to resolve');
  assert.strictEqual(img.width, 1021);
  assert.strictEqual(img.height, 1434);
});

/* ---------------------------- validation ---------------------------- */

const base = {
  name: 'Test Item', price: 100, category_id: DRINKS_ID,
  image: 'assets/Menu Frappe.jpg', alt: 'x',
};

function errorsFor(input) {
  try {
    menu.validate(input);
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError);
    return err.errors;
  }
}

test('a valid item passes and normalises', () => {
  const row = menu.validate({ ...base, name: '  Spaced  ' });
  assert.strictEqual(row.name, 'Spaced');
  assert.strictEqual(row.crop_w, null, 'no crop given means no crop stored');
});

test('bad prices are rejected', () => {
  assert.ok(errorsFor({ ...base, price: 'abc' }).price);
  assert.ok(errorsFor({ ...base, price: -5 }).price);
  assert.ok(errorsFor({ ...base, price: 1.5 }).price);
  assert.ok(errorsFor({ ...base, price: '' }).price);
});

test('bad categories and empty names are rejected', () => {
  assert.ok(errorsFor({ ...base, category_id: 99999 }).category);
  assert.ok(errorsFor({ ...base, category_id: 'drinks' }).category);
  assert.ok(errorsFor({ ...base, name: '   ' }).name);
  assert.ok(errorsFor({ ...base, name: 'x'.repeat(81) }).name);
});

test('crop must be complete and inside the image', () => {
  assert.ok(errorsFor({ ...base, crop_x: 10 }).crop, 'partial crop rejected');
  assert.ok(errorsFor({ ...base, crop_x: 0, crop_y: 0, crop_w: 2000, crop_h: 100 }).crop);
  assert.ok(errorsFor({ ...base, crop_x: 0, crop_y: 0, crop_w: 0, crop_h: 10 }).crop);
  assert.ok(errorsFor({ ...base, crop_x: -1, crop_y: 0, crop_w: 10, crop_h: 10 }).crop);

  const ok = menu.validate({ ...base, crop_x: 113, crop_y: 530, crop_w: 184, crop_h: 245 });
  assert.strictEqual(ok.crop_w, 184);
});

/* ---------------------------- categories ---------------------------- */

function categoryErrors(input, id) {
  try {
    categories.validate(input, id);
    return null;
  } catch (err) {
    assert.ok(err instanceof menu.ValidationError);
    return err.errors;
  }
}

test('the seed creates the two poster categories with every item in one', () => {
  const list = categories.list();
  assert.deepStrictEqual(list.slice(0, 2).map((c) => c.slug), ['drinks', 'food']);
  assert.strictEqual(list[0].item_count + list[1].item_count, 9);
});

test('category names are required, bounded and unique ignoring case', () => {
  assert.ok(categoryErrors({ name: '  ' }).name);
  assert.ok(categoryErrors({ name: 'x'.repeat(61) }).name);
  assert.ok(categoryErrors({ name: 'FOOD' }).name, 'case-insensitive clash');
  assert.ok(categoryErrors({ name: 'Desserts', label: 'x'.repeat(31) }).label);

  const food = categories.list().find((c) => c.slug === 'food');
  assert.strictEqual(categoryErrors({ name: 'Food' }, food.id), null, 'own name is not a clash');
  assert.strictEqual(categories.validate({ name: 'Desserts' }).label, 'Desserts',
    'blank label falls back to the name');
});

test('slugs are unique and avoid ids the page already uses', () => {
  assert.strictEqual(categories.slugify('Food'), 'food-2');
  assert.strictEqual(categories.slugify('Menu'), 'menu-2');
  assert.strictEqual(categories.slugify('All'), 'all-2');
  assert.strictEqual(categories.slugify('Crème Brûlée!'), 'creme-brulee');
  assert.strictEqual(categories.slugify('☕☕'), 'category');
});

test('a category can be created, renamed and deleted; its slug never changes', () => {
  const cat = categories.create({ name: 'Desserts', label: 'Sweets' });
  assert.strictEqual(cat.slug, 'desserts');
  assert.strictEqual(cat.item_count, 0);

  const renamed = categories.update(cat.id, { name: 'Cakes', label: '' });
  assert.strictEqual(renamed.name, 'Cakes');
  assert.strictEqual(renamed.label, 'Cakes');
  assert.strictEqual(renamed.slug, 'desserts', 'renaming must not break #desserts links');

  assert.strictEqual(categories.remove(cat.id), true);
  assert.strictEqual(categories.get(cat.id), null);
  assert.strictEqual(categories.remove(cat.id), false);
  assert.strictEqual(categories.update(cat.id, { name: 'Gone' }), null);
});

test('a category with items cannot be deleted', () => {
  assert.throws(() => categories.remove(DRINKS_ID), (err) => err.status === 409);
  assert.ok(categories.get(DRINKS_ID), 'still there');
  assert.ok(menu.list().some((i) => i.category_id === DRINKS_ID), 'items untouched');
});

test('reordering categories changes the order of the customer menu', () => {
  const ids = categories.list().map((c) => c.id);
  const reversed = [...ids].reverse();
  categories.reorder(reversed);
  try {
    assert.deepStrictEqual(categories.list().map((c) => c.id), reversed);
    const html = render.buildHtml();
    assert.ok(html.indexOf('id="food"') < html.indexOf('id="drinks"'));
    assert.throws(() => categories.reorder(ids.slice(1)), (err) => err.status === 409,
      'a partial list is refused');
  } finally {
    categories.reorder(ids);
  }
});

test('the customer page escapes category names and hides empty categories', () => {
  const cat = categories.create({ name: '<b>Empty</b>' });
  try {
    const html = render.buildHtml();
    assert.doesNotMatch(html, /<b>Empty<\/b>/);
    assert.doesNotMatch(html, /data-filter="b-empty-b"/, 'no chip for an empty category');

    const item = menu.create({ ...base, category_id: cat.id });
    const withItem = render.buildHtml();
    assert.match(withItem, /&lt;b&gt;Empty&lt;\/b&gt;/);
    assert.match(withItem, /data-filter="b-empty-b"/);
    menu.remove(item.id);
  } finally {
    categories.remove(cat.id);
  }
});

test('a database from before editable categories is migrated with its items', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-migrate-'));
  const dbPath = path.join(dir, 'old.db');

  // Build the old schema by hand, exactly as the previous release created it.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('drinks','food')),
    image TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
    crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO items (id, name, price, category, image, position) VALUES
      (7, 'Old Frappe', 120, 'drinks', 'assets/Menu Frappe.jpg', 0),
      (8, 'Old Pasta', 130, 'food', 'assets/Meals.jpg', 0);`);
  old.close();

  // Open it with the current code in a fresh process (db.js migrates on load).
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    console.log(JSON.stringify(db.prepare(
      'SELECT i.id, i.name, c.slug FROM items i JOIN categories c ON c.id = i.category_id ORDER BY i.id'
    ).all()));`], { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });

  assert.deepStrictEqual(JSON.parse(out), [
    { id: 7, name: 'Old Frappe', slug: 'drinks' },
    { id: 8, name: 'Old Pasta', slug: 'food' },
  ]);
});

/* ---------------------------- image sniffing ---------------------------- */

test('non-image bytes are not recognised as images', () => {
  assert.strictEqual(imagesize.fromBuffer(Buffer.from('<?php echo 1; ?>')), null);
  assert.strictEqual(imagesize.fromBuffer(Buffer.alloc(0)), null);
  assert.strictEqual(imagesize.fromBuffer(Buffer.from('GIF89a')), null);
});

test('real PNG and JPEG headers are read', () => {
  const root = path.join(__dirname, '..');
  const png = imagesize.fromFile(path.join(root, 'assets', 'Sweeter Side - PNG.png'));
  assert.deepStrictEqual([png.type, png.width, png.height], ['png', 1563, 1563]);
  const jpg = imagesize.fromFile(path.join(root, 'assets', 'Meals.jpg'));
  assert.deepStrictEqual([jpg.type, jpg.width, jpg.height], ['jpeg', 1021, 1434]);
});
