'use strict';
/* Text message alerts to the owner's phones, through Semaphore (semaphore.co).
   Each new online order sends one SMS with the same words as the push alert:
   number, type, item count and total. Never the customer's name, phone or
   address. The API key is the SEMAPHORE_API_KEY secret; without it nothing is
   sent. SEMAPHORE_SENDER is the sender name Semaphore approved, if any. */

const { getSetting } = require('./settings');
const { normalizePhPhone, displayPhPhone, PHONE_MESSAGE } = require('./phone');
const { ValidationError } = require('./menu');

const API_URL = 'https://api.semaphore.co/api/v4/messages';
const MAX_NUMBERS = 3;

// Swapped in tests, so nothing goes out to Semaphore.
let transport = (url, init) => fetch(url, init);
function setTransport(fn) { transport = fn; }

function enabled() {
  return Boolean(String(process.env.SEMAPHORE_API_KEY || '').trim());
}

/** The owner's switch in Settings: on unless turned off. Off keeps the numbers. */
function on() {
  return getSetting('sms_on', '1') === '1';
}

/** The switch for texting customers when we get their order: on unless turned off. */
function customerOn() {
  return getSetting('sms_customer_on', '1') === '1';
}

/** The owner's numbers, as '+639XXXXXXXXX'. */
function numbers() {
  try {
    const list = JSON.parse(getSetting('sms_alert_numbers', '[]'));
    return Array.isArray(list) ? list.filter((n) => normalizePhPhone(n)) : [];
  } catch {
    return [];
  }
}

/** Shown on the Settings page: '0917 123 4567, 0918 …'. */
function numbersLabel() {
  return numbers().map(displayPhPhone).join(', ');
}

/** 'a, b' or ['a','b'] -> up to 3 distinct numbers; blank clears the list. */
function parseNumbers(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]/);
  const parts = raw.map((s) => String(s).trim()).filter(Boolean);
  const list = [];
  for (const p of parts) {
    const n = normalizePhPhone(p);
    if (!n) throw new ValidationError({ sms_numbers: PHONE_MESSAGE });
    if (!list.includes(n)) list.push(n);
  }
  if (list.length > MAX_NUMBERS) throw new ValidationError({ sms_numbers: `Up to ${MAX_NUMBERS} numbers.` });
  return list;
}

/**
 * Send one text to every number: the owner's, unless given. Never throws.
 * @returns {Promise<{ sent: number, status: number }>} status 0 on a network error.
 */
async function send(text, to = on() ? numbers() : []) {
  if (!enabled() || !to.length) return { sent: 0, status: 0 };
  const form = new URLSearchParams({
    apikey: process.env.SEMAPHORE_API_KEY.trim(),
    number: to.map((n) => n.slice(1)).join(','), // '639XXXXXXXXX'
    message: text,
  });
  const sender = String(process.env.SEMAPHORE_SENDER || '').trim();
  if (sender) form.set('sendername', sender);
  try {
    const res = await transport(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10 * 1000),
    });
    // The key and the numbers are never logged: Semaphore's reason is cut short
    // and any run of digits in it hidden.
    if (res.status < 200 || res.status >= 300) {
      const key = process.env.SEMAPHORE_API_KEY.trim();
      const why = await res.text()
        .then((t) => t.split(key).join('[key]').replace(/\d{4,}/g, '#').slice(0, 200)).catch(() => '');
      console.warn(`[sms] Semaphore refused (${res.status})${why ? `: ${why}` : ''}`);
    }
    return { sent: res.status >= 200 && res.status < 300 ? to.length : 0, status: res.status };
  } catch {
    console.warn('[sms] Semaphore did not answer');
    return { sent: 0, status: 0 };
  }
}

/** The push alert's words on one line: 'New order #12. Pick-up - ASAP - 2 items - P320'. */
function orderText(message) {
  // No shop name: the sender name (SweeterSide) already says who it is from.
  return plainSms(`${message.title}. ${message.body}`);
}

/**
 * Plain characters only, at most 160: one normal SMS, one credit. A "·" or
 * "₱" would make it a Unicode SMS of 70 characters, often two credits.
 * 'Delivery · 3 items · ₱560' -> 'Delivery - 3 items - P560'.
 */
function plainSms(text) {
  return String(text)
    .replace(/₱/g, 'P')
    .replace(/[·•–—]/g, '-')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[^\x20-\x7E]/g, '') // anything else not plain is dropped
    .replace(/\s+/g, ' ').trim()
    .slice(0, 160);
}

/** Fire and forget, after the response has gone. */
function alert(message) {
  if (!enabled() || !on() || !numbers().length) return;
  setImmediate(() => { send(orderText(message)).catch(() => {}); });
}

/**
 * The customer's "we got your order" text, with the link to its status page.
 * Plain characters and at most 160, so the link is never cut off.
 * 'Sweeter Side: We got your order #12 (P320). Status: https://sweeterside.ph/order/12.<key>'
 */
function customerText(order, link, { willCall = false } = {}) {
  const total = `P${Number(order.total).toLocaleString('en-US')}`;
  const text = `Sweeter Side: We got your order #${order.id} (${total}).${willCall ? ' We will call to confirm.' : ''} Status: ${link}`;
  return text.length <= 160 ? text : `Order #${order.id} received. Status: ${link}`;
}

/**
 * Text the customer that we got their order. Fire and forget, after the
 * response has gone. Their number is never logged, only the order number.
 */
function confirmCustomer(order, link, options) {
  const to = normalizePhPhone(order.phone_norm || order.phone || '');
  if (!enabled() || !customerOn() || !to || !link) return;
  setImmediate(() => {
    send(customerText(order, link, options), [to])
      .then((r) => console.log(`[sms] customer #${order.id} ${r.sent ? 'sent' : 'failed'}`))
      .catch(() => {});
  });
}

module.exports = {
  enabled, on, customerOn, numbers, numbersLabel, parseNumbers, send, orderText, plainSms, alert,
  customerText, confirmCustomer, setTransport, MAX_NUMBERS,
};
