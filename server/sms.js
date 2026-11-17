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
 * Send one text to every number. Never throws.
 * @returns {Promise<{ sent: number, status: number }>} status 0 on a network error.
 */
async function send(text) {
  const to = numbers();
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
    // The key and the numbers are never logged.
    if (res.status < 200 || res.status >= 300) console.warn(`[sms] Semaphore refused (${res.status})`);
    return { sent: res.status >= 200 && res.status < 300 ? to.length : 0, status: res.status };
  } catch {
    console.warn('[sms] Semaphore did not answer');
    return { sent: 0, status: 0 };
  }
}

/** The push alert's words on one line: 'New order #12: Pick-up · ASAP · 2 items · ₱320'. */
function orderText(message) {
  return `Sweeter Side: ${message.title}. ${message.body}`;
}

/** Fire and forget, after the response has gone. */
function alert(message) {
  if (!enabled() || !numbers().length) return;
  setImmediate(() => { send(orderText(message)).catch(() => {}); });
}

module.exports = { enabled, numbers, numbersLabel, parseNumbers, send, orderText, alert, setTransport, MAX_NUMBERS };
