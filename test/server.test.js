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

const auth = require('../server/auth');
const menu = require('../server/menu');
const imagesize = require('../server/imagesize');

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
  name: 'Test Item', price: 100, category: 'drinks',
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
  assert.ok(errorsFor({ ...base, category: 'desserts' }).category);
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
