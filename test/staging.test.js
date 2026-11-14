'use strict';
/* The staging site (STAGING=1) and its seed script. Staging must never pass
   for the real shop: no search indexing, no tracking, no live PayMongo key,
   a badge on every page. The seed copies the menu and set-up only, never
   anything about people. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-staging-'));
process.env.DB_PATH = path.join(TEST_DIR, 'live.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { db, seedIfEmpty } = require('../server/db');
seedIfEmpty();
const staff = require('../server/staff');
const credit = require('../server/credit');
const blocklist = require('../server/blocklist');
const orders = require('../server/orders');
const paymongo = require('../server/paymongo');
const { server } = require('../server/index');

// A "live" database with people in it, and a tracking ID.
const owner = staff.create({ name: 'Dachel', role: 'owner', pin: '2580' }, null);
credit.create({ name: 'Lola Nena', phone: '0917 555 1234', limit: 300 }, owner);
blocklist.add({ phone: '0917 555 9999', reason: 'fake orders' }, 'owner');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('meta_pixel_id', '123456789012345')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('closed_note', 'Back at 10am')").run();
require('../server/checkout'); // keeps its signing secret in settings
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('checkout_secret', 'live-signing-secret')").run();

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function withStaging(on, fn) {
  const before = process.env.STAGING;
  if (on) process.env.STAGING = '1'; else delete process.env.STAGING;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env.STAGING; else process.env.STAGING = before;
  });
}

test('the live site: indexable, tracking on, no badge', () => withStaging(false, () => withServer(async (base) => {
  const home = await fetch(`${base}/`);
  assert.strictEqual(home.headers.get('x-robots-tag'), null);
  assert.ok(!(await home.text()).includes('STAGING'));
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Allow: \//);
  assert.strictEqual(orders.tracking().meta_pixel_id, '123456789012345');
})));

test('staging: noindex on every response and page, no sitemap, a badge on the pages', () => withStaging(true, () => withServer(async (base) => {
  for (const p of ['/', '/cakes', '/about', '/admin/login', '/healthz', '/robots.txt', '/assets/css/styles.css']) {
    const res = await fetch(`${base}${p}`);
    assert.strictEqual(res.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    const body = await res.text();
    if (['/', '/cakes', '/about', '/admin/login'].includes(p)) {
      assert.ok(body.includes('STAGING · test site'), `${p} shows the badge`);
      assert.strictEqual((body.match(/<meta name="robots"/g) || []).length, 1, `${p}: one robots tag`);
      assert.match(body, /<meta name="robots" content="noindex, nofollow">/, `${p}: noindex in the page`);
    }
  }
  // Crawling stays allowed, so search engines can see the noindex.
  assert.strictEqual(await (await fetch(`${base}/robots.txt`)).text(), 'User-agent: *\nAllow: /\n');
  for (const p of ['/sitemap.xml', '/llms.txt']) assert.strictEqual((await fetch(`${base}${p}`)).status, 404, p);
})));

test('the live site has no robots tag on customer pages, and keeps its sitemap', () => withStaging(false, () => withServer(async (base) => {
  assert.ok(!/<meta name="robots"/.test(await (await fetch(`${base}/`)).text()));
  assert.strictEqual((await fetch(`${base}/sitemap.xml`)).status, 200);
})));

test('staging: tracking is off even when the IDs are set', () => withStaging(true, async () => {
  assert.strictEqual(orders.tracking().meta_pixel_id, '');
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.ok(!/facebook|connect\.facebook\.net/.test(res.headers.get('content-security-policy')));
  });
}));

test('staging refuses a live PayMongo key and takes a test key', () => withStaging(true, () => {
  const before = process.env.PAYMONGO_SECRET_KEY;
  try {
    process.env.PAYMONGO_SECRET_KEY = 'sk_live_abc123';
    assert.strictEqual(paymongo.configured(), false);
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_abc123';
    assert.strictEqual(paymongo.configured(), true);
  } finally {
    if (before === undefined) delete process.env.PAYMONGO_SECRET_KEY; else process.env.PAYMONGO_SECRET_KEY = before;
  }
}));

test('the seed copies the menu and set-up, and nothing about people', () => {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const target = path.join(TEST_DIR, 'staging-seed.db');
  const run = (out) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'staging-seed.js'), process.env.DB_PATH, out],
    { encoding: 'utf8', env: { ...process.env, DB_PATH: '' } });
  const res = run(target);
  assert.strictEqual(res.status, 0, res.stderr);

  const seed = new DatabaseSync(target, { readOnly: true });
  const n = (table) => seed.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const live = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  try {
    assert.ok(n('items') > 0);
    assert.strictEqual(n('items'), live('items'));
    assert.strictEqual(n('categories'), live('categories'));
    for (const table of ['users', 'sessions', 'staff', 'staff_sessions', 'orders', 'order_items', 'cake_bookings',
      'payments', 'refunds', 'shifts', 'cash_movements', 'audit_log', 'blocked_phones', 'credit_accounts',
      'credit_collections', 'testimonials', 'push_subscriptions']) {
      if (seed.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        assert.strictEqual(n(table), 0, `${table} is empty`);
      }
    }
    assert.ok(live('staff') > 0 && live('credit_accounts') > 0 && live('blocked_phones') > 0, 'the live copy did have people');
    const setting = (key) => (seed.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value;
    assert.strictEqual(setting('closed_note'), 'Back at 10am');
    assert.strictEqual(setting('meta_pixel_id'), undefined, 'no tracking IDs');
    assert.strictEqual(setting('checkout_secret'), undefined, 'the live signing secret stays on live');
  } finally {
    seed.close();
  }

  // It never writes over an existing file.
  const again = run(target);
  assert.notStrictEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
});
