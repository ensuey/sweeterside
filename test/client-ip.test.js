'use strict';
/* F1: the client address comes from Fly-Client-IP on Fly and the socket
   elsewhere, never from X-Forwarded-For. A forged header must not reset the
   sign-in lock or the public rate limits. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-client-ip-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
delete process.env.FLY_APP_NAME;

const { db, seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
seedIfEmpty();
// Ordering follows the opening hours. Open all day, so no test depends on the clock.
require('../server/orders').updateSettings({ open_at: '00:00', close_at: '24:00' });
const { server } = require('../server/index');

const PASSWORD = 'a-long-enough-password';
let seq = 0;
/** A fresh admin, so each test starts with no failed sign-ins. */
function newAdmin() {
  const email = `ip-${++seq}@example.com`;
  auth.createUser(email, PASSWORD);
  return email;
}

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const login = (url, email, password, headers = {}) => fetch(`${url}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ email, password }),
});

test('a forged X-Forwarded-For does not reset the sign-in lock', async () => {
  const email = newAdmin();
  await withServer(async (url) => {
    for (let i = 1; i <= auth.MAX_FAILS; i++) {
      const res = await login(url, email, 'wrong', { 'X-Forwarded-For': `203.0.113.${i}` });
      assert.strictEqual(res.status, 401);
    }
    const res = await login(url, email, PASSWORD, { 'X-Forwarded-For': '198.51.100.7' });
    assert.strictEqual(res.status, 429, 'still locked, even with the right password and a new forged address');
  });
});

test('off Fly, a forged Fly-Client-IP is ignored too', async () => {
  const email = newAdmin();
  await withServer(async (url) => {
    for (let i = 1; i <= auth.MAX_FAILS; i++) {
      await login(url, email, 'wrong', { 'Fly-Client-IP': `203.0.113.${i}` });
    }
    assert.strictEqual((await login(url, email, PASSWORD, { 'Fly-Client-IP': '198.51.100.8' })).status, 429);
  });
});

test('on Fly, Fly-Client-IP is the address; X-Forwarded-For still changes nothing', async () => {
  process.env.FLY_APP_NAME = 'sweeterside-test';
  try {
    const email = newAdmin();
    await withServer(async (url) => {
      const fly = { 'Fly-Client-IP': '192.0.2.10' };
      for (let i = 1; i <= auth.MAX_FAILS; i++) {
        await login(url, email, 'wrong', { ...fly, 'X-Forwarded-For': `203.0.113.${i}` });
      }
      assert.strictEqual((await login(url, email, PASSWORD, { ...fly, 'X-Forwarded-For': '198.51.100.9' })).status, 429,
        'same Fly address: locked');
      const other = await login(url, email, PASSWORD, { 'Fly-Client-IP': '192.0.2.11' });
      assert.strictEqual(other.status, 200, 'a different real address is not locked by someone else');
    });
  } finally {
    delete process.env.FLY_APP_NAME;
  }
});

test('guesses spread over many addresses lock the email itself', async () => {
  process.env.FLY_APP_NAME = 'sweeterside-test';
  try {
    const email = newAdmin();
    await withServer(async (url) => {
      // Five guesses from each address stays under the per-address lock.
      let n = 0;
      for (let i = 0; i < auth.EMAIL_MAX_FAILS; i++) {
        if (i % 5 === 0) n++;
        const res = await login(url, email, 'wrong', { 'Fly-Client-IP': `192.0.2.${100 + n}` });
        assert.strictEqual(res.status, 401, `guess ${i + 1}`);
      }
      const res = await login(url, email, PASSWORD, { 'Fly-Client-IP': '192.0.2.250' });
      assert.strictEqual(res.status, 429, 'locked from a brand-new address as well');
    });
  } finally {
    delete process.env.FLY_APP_NAME;
  }
});

test('a good sign-in clears both locks, and an expired lock starts the count again', () => {
  const key = auth.throttleKey('expiry@example.com', '192.0.2.1');
  for (let i = 0; i < auth.MAX_FAILS; i++) auth.recordFailure(key);
  assert.ok(auth.lockRemaining(key) > 0);
  // The lock runs out.
  db.prepare('UPDATE login_attempts SET locked_until = ? WHERE key = ?').run(Date.now() - 1, key);
  assert.strictEqual(auth.lockRemaining(key), 0);
  const { fails, lockedUntil } = auth.recordFailure(key);
  assert.deepStrictEqual([fails, lockedUntil], [1, 0], 'one more wrong guess does not lock again at once');

  const emailKey = auth.emailThrottleKey('expiry@example.com');
  assert.notStrictEqual(emailKey, key);
  assert.strictEqual(auth.recordFailure(emailKey, auth.EMAIL_MAX_FAILS).lockedUntil, 0, 'the email limit is higher');
});

test('a forged X-Forwarded-For does not get round the public voucher check limit', async () => {
  await withServer(async (url) => {
    let last;
    for (let i = 1; i <= 21; i++) {
      last = await fetch(`${url}/api/vouchers/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` },
        body: JSON.stringify({ code: `NOPE${i}`, items: [] }),
      });
    }
    assert.strictEqual(last.status, 429, 'the 21st check in 10 minutes is refused');
  });
});
