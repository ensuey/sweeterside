'use strict';
/* SMS order alerts through Semaphore: the owner's numbers in Settings, what
   is sent, and that nothing leaks (no customer details, no key in the logs).
   Nothing goes to the real Semaphore. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-sms-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
delete process.env.SEMAPHORE_API_KEY;
delete process.env.SEMAPHORE_SENDER;

const { seedIfEmpty } = require('../server/db');
const orders = require('../server/orders');
const push = require('../server/push');
const sms = require('../server/sms');
seedIfEmpty();

const KEY = 'sk-test-semaphore-key-123';

function capture(status = 200) {
  const sent = [];
  sms.setTransport(async (url, init) => {
    sent.push({ url, init, form: new URLSearchParams(init.body) });
    if (status === 0) throw new Error('offline');
    return { status, text: async () => `[{"senderName":"No active sender name found.","number":"639171234567","key":"${KEY}"}]` };
  });
  return sent;
}

const order = {
  id: 42, order_type: 'delivery', total: 560,
  customer_name: 'Maria Santos', phone: '09171234567', address: '12 Mabini St',
  items: [{ qty: 2 }, { qty: 1 }],
};

test('numbers: any way they are typed, kept once, up to 3; blank clears', () => {
  const s = orders.updateSettings({ sms_numbers: '0917 123 4567, +63 918-765-4321, 639171234567' });
  assert.strictEqual(s.sms_numbers, '0917 123 4567, 0918 765 4321');
  assert.deepStrictEqual(sms.numbers(), ['+639171234567', '+639187654321']);
  assert.strictEqual(orders.updateSettings({ sms_numbers: '' }).sms_numbers, '');
  assert.deepStrictEqual(sms.numbers(), []);
});

test('numbers: a bad entry or more than 3 is refused and nothing is saved', () => {
  orders.updateSettings({ sms_numbers: '09171234567' });
  for (const bad of ['0917', '<script>', '09171234567&apikey=x', '0917 123 4567, 0918 123 4567, 0919 123 4567, 0920 123 4567']) {
    assert.throws(() => orders.updateSettings({ sms_numbers: bad }), (e) => Boolean(e.errors && e.errors.sms_numbers), bad);
  }
  assert.deepStrictEqual(sms.numbers(), ['+639171234567']);
});

test('no key: nothing is sent, and Settings says it is not set up', async () => {
  const sent = capture();
  orders.updateSettings({ sms_numbers: '09171234567' });
  assert.strictEqual(orders.settings().sms_enabled, false);
  assert.deepStrictEqual(await sms.send('hi'), { sent: 0, status: 0 });
  assert.strictEqual(sent.length, 0);
});

test('an order alert texts every number: order number, type and total only', async () => {
  process.env.SEMAPHORE_API_KEY = KEY;
  try {
    const sent = capture();
    orders.updateSettings({ sms_numbers: '09171234567, 09187654321' });
    const r = await sms.send(sms.orderText(push.orderMessage(order)));
    assert.deepStrictEqual(r, { sent: 2, status: 200 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].url, 'https://api.semaphore.co/api/v4/messages');
    const f = sent[0].form;
    assert.strictEqual(f.get('apikey'), KEY);
    assert.strictEqual(f.get('number'), '639171234567,639187654321');
    assert.strictEqual(f.get('sendername'), null);
    const text = f.get('message');
    assert.match(text, /New order #42/);
    assert.match(text, /Delivery - 3 items - P560/);
    for (const secret of ['Maria', 'Santos', '0917', 'Mabini']) assert.ok(!text.includes(secret), secret);
  } finally {
    delete process.env.SEMAPHORE_API_KEY;
  }
});

test('the approved sender name is used when set', async () => {
  process.env.SEMAPHORE_API_KEY = KEY;
  process.env.SEMAPHORE_SENDER = 'SWEETERSIDE';
  try {
    const sent = capture();
    orders.updateSettings({ sms_numbers: '09171234567' });
    await sms.send('x');
    assert.strictEqual(sent[0].form.get('sendername'), 'SWEETERSIDE');
  } finally {
    delete process.env.SEMAPHORE_API_KEY;
    delete process.env.SEMAPHORE_SENDER;
  }
});

test('a refusal or no answer never throws, and the key and numbers are not logged', async () => {
  process.env.SEMAPHORE_API_KEY = KEY;
  const logged = [];
  const warn = console.warn;
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    orders.updateSettings({ sms_numbers: '09171234567' });
    capture(401);
    assert.deepStrictEqual(await sms.send('x'), { sent: 0, status: 401 });
    capture(0);
    assert.deepStrictEqual(await sms.send('x'), { sent: 0, status: 0 });
    assert.strictEqual(logged.length, 2);
    assert.match(logged[0], /No active sender name found/);
    for (const line of logged) {
      assert.ok(!line.includes(KEY) && !line.includes('917') && !line.includes('123'), line);
    }
  } finally {
    console.warn = warn;
    delete process.env.SEMAPHORE_API_KEY;
  }
});

test('new online orders and paid GCash orders both send the text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  // One place sends the alerts (announce); placing a cash order and a GCash payment both call it.
  assert.strictEqual((src.match(/sms\.alert\(push\.orderMessage\(order\)\)/g) || []).length, 1);
  assert.match(src, /paymongo\.onPaid\([\s\S]{0,120}announce\(order\)/);
  assert.match(src, /announce\(order, req\);\s+return sendJson\(res, 201/);
});

test('texts use plain characters only, at most 160: one normal SMS, one credit', () => {
  // A scheduled delivery: the longest alert, with a dash between the window's times.
  const long = sms.orderText({ title: 'New order #1234', body: 'Delivery · Scheduled Tue 24 Nov, 11:30 AM–12:00 PM · 12 items · ₱12,560' });
  assert.strictEqual(long, 'New order #1234. Delivery - Scheduled Tue 24 Nov, 11:30 AM-12:00 PM - 12 items - P12,560');
  assert.match(long, /^[\x20-\x7E]*$/, 'plain characters only');
  // A dine-in table typed by the customer: accents kept as letters, the rest dropped, never over 160.
  assert.strictEqual(sms.plainSms('Dine-in · Table Café 3 🍰'), 'Dine-in - Table Cafe 3');
  assert.strictEqual(sms.plainSms('x'.repeat(300)).length, 160);
});

test('the Settings switch turns texts off and on; the numbers are kept', async () => {
  process.env.SEMAPHORE_API_KEY = KEY;
  try {
    orders.updateSettings({ sms_numbers: '09171234567' });
    assert.strictEqual(orders.settings().sms_on, true, 'on unless turned off');
    const off = orders.updateSettings({ sms_on: false });
    assert.deepStrictEqual([off.sms_on, off.sms_numbers], [false, '0917 123 4567']);
    const sent = capture();
    assert.deepStrictEqual(await sms.send('x'), { sent: 0, status: 0 });
    assert.strictEqual(sent.length, 0, 'nothing goes to Semaphore while off');
    assert.throws(() => orders.updateSettings({ sms_on: 'maybe' }), (e) => Boolean(e.errors && e.errors.sms_on));
    orders.updateSettings({ sms_on: true });
    assert.deepStrictEqual(await sms.send('x'), { sent: 1, status: 200 });
  } finally {
    delete process.env.SEMAPHORE_API_KEY;
  }
});
