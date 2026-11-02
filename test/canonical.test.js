'use strict';
/* The move to the shop's own address (CANONICAL_HOST). Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-canonical-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty } = require('../server/db');
seedIfEmpty();
const { server } = require('../server/index');

/** A request with any Host header (fetch will not set one). */
function request(port, { host, method = 'GET', path: p = '/' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('without CANONICAL_HOST nothing moves', async () => {
  delete process.env.CANONICAL_HOST;
  await withServer(async (port) => {
    const res = await request(port, { host: 'sweeterside.fly.dev', path: '/admin/login' });
    assert.strictEqual(res.status, 200);
  });
});

test('www and fly.dev page visits move to the shop address, path and query kept', async () => {
  process.env.CANONICAL_HOST = 'sweeterside.ph';
  try {
    await withServer(async (port) => {
      const www = await request(port, { host: 'www.sweeterside.ph', path: '/cakes?x=1' });
      assert.deepStrictEqual(www, { status: 301, location: 'https://sweeterside.ph/cakes?x=1' });
      const fly = await request(port, { host: 'sweeterside.fly.dev:443', path: '/admin/pos?pay=12' });
      assert.deepStrictEqual(fly, { status: 301, location: 'https://sweeterside.ph/admin/pos?pay=12' });
      const head = await request(port, { host: 'SWEETERSIDE.FLY.DEV', method: 'HEAD', path: '/' });
      assert.deepStrictEqual(head, { status: 301, location: 'https://sweeterside.ph/' });
    });
  } finally {
    delete process.env.CANONICAL_HOST;
  }
});

test('the shop address, other hosts, saves and the health check are left alone', async () => {
  process.env.CANONICAL_HOST = 'sweeterside.ph';
  try {
    await withServer(async (port) => {
      assert.strictEqual((await request(port, { host: 'sweeterside.ph', path: '/admin/login' })).status, 200);
      // Fly's health check calls the machine by its private address.
      assert.strictEqual((await request(port, { host: '172.19.0.2:8080', path: '/healthz' })).status, 200);
      assert.strictEqual((await request(port, { host: 'sweeterside.fly.dev', path: '/healthz' })).status, 200,
        'the health check is never moved');
      // A tablet still open on the old address finishes what it is saving.
      const post = await request(port, { host: 'sweeterside.fly.dev', method: 'POST', path: '/api/logout' });
      assert.strictEqual(post.status, 200);
      // Any other Host is not ours to move; the target is never taken from it.
      const other = await request(port, { host: 'evil.example', path: '/' });
      assert.strictEqual(other.status, 200);
      const tricky = await request(port, { host: 'www.sweeterside.ph', path: '//evil.example/x' });
      assert.strictEqual(tricky.location, 'https://sweeterside.ph//evil.example/x', 'stays on the shop host');
    });
  } finally {
    delete process.env.CANONICAL_HOST;
  }
});
