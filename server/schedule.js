'use strict';
/* Pre-orders and scheduled orders, in Manila time.

   Pick-up: a date (today up to N days ahead, a setting) and a 15-minute
   slot within the opening hours. Delivery: as soon as possible, or a date
   and a 30-minute window within the hours. Dine-in is now or not at all.

   "As soon as possible" and dine-in need the shop open now. Outside the
   hours (with the Open/Closed switch on) customers can still order for a
   later time: a pre-order. The switch set to Closed stops everything.

   The same rules run in the cart (assets/js/cart.js) to offer the times;
   the server checks them again here. */

const { manilaMinutes, manilaDate, addDays } = require('./clock');
const { getSetting } = require('./settings');
const { ValidationError } = require('./menu');

const SLOT_MINUTES = 15;
const WINDOW_MINUTES = 30;
const PICKUP_LEAD = 15; // the earliest pick-up offered today is this far ahead
const DELIVERY_LEAD = 30;
const GRACE = 5; // a slow submit is not refused for a slot that was offered
const DEFAULT_DAYS = 3;
const MAX_DAYS = 14;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** A real calendar date written YYYY-MM-DD (not 2026-02-30 or 2026-13-01). */
function realDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function hours() {
  const open = toMinutes(getSetting('pickup_open', '10:00'));
  const closeRaw = getSetting('pickup_close', '20:00');
  const close = String(closeRaw).trim() === '24:00' ? 24 * 60 : toMinutes(closeRaw);
  return { open, close };
}

/** How many days ahead customers may order (0: today only). */
function preorderDays() {
  const n = Number(getSetting('preorder_days', String(DEFAULT_DAYS)));
  return Number.isInteger(n) && n >= 0 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

function parseDays(input) {
  const n = Number(input);
  if (input === '' || input === null || input === undefined || !Number.isInteger(n) || n < 0 || n > MAX_DAYS) {
    throw new ValidationError({ preorder_days: `Enter 0 (today only) up to ${MAX_DAYS} days.` });
  }
  return String(n);
}

const switchOpen = () => getSetting('shop_open', '1') === '1';

/** Open right now: the switch on and within the hours. */
function openNow(now = new Date()) {
  const { open, close } = hours();
  const m = manilaMinutes(now);
  return switchOpen() && open !== null && close !== null && m >= open && m < close;
}

/**
 * The start times offered on a Manila date ('YYYY-MM-DD'), as minutes.
 * pickup: every 15 minutes from opening to closing (a time at midnight is
 * not offered). delivery: 30-minute windows that end by closing.
 * Today only from the lead time on; nothing on a date out of range.
 */
function slots(type, date, now = new Date()) {
  const { open, close } = hours();
  if (open === null || close === null || !switchOpen()) return [];
  const today = manilaDate(now);
  if (date < today || date > addDays(today, preorderDays())) return [];
  const out = [];
  const step = type === 'delivery' ? WINDOW_MINUTES : SLOT_MINUTES;
  const last = type === 'delivery' ? close - WINDOW_MINUTES : Math.min(close, 24 * 60 - SLOT_MINUTES);
  let first = open;
  if (date === today) {
    const lead = manilaMinutes(now) + (type === 'delivery' ? DELIVERY_LEAD : PICKUP_LEAD);
    while (first < lead) first += step;
  }
  for (let t = first; t <= last; t += step) out.push(t);
  return out;
}

/** The dates with something left to choose, today first. */
function dates(type, now = new Date()) {
  const today = manilaDate(now);
  const out = [];
  for (let i = 0; i <= preorderDays(); i++) {
    const d = addDays(today, i);
    if (slots(type, d, now).length) out.push(d);
  }
  return out;
}

/** The first time a type can be had: now when open (ASAP), else the next slot. */
function next(type, now = new Date()) {
  for (const d of dates(type, now)) return { date: d, minutes: slots(type, d, now)[0] };
  return null;
}

/** 'Tue 4 Nov' */
function dayLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function clock12(mins) {
  if (mins >= 24 * 60) return 'midnight';
  const h = Math.floor(mins / 60);
  return `${h % 12 || 12}:${String(mins % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 'today at 10:00 AM', 'tomorrow at 10:00 AM' or 'Tue 4 Nov at 10:00 AM' */
function whenText(date, minutes, now = new Date()) {
  const today = manilaDate(now);
  const day = date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : dayLabel(date);
  return `${day} at ${clock12(minutes)}`;
}

/** The UTC time SQLite would write for a Manila date and minutes. */
function utcSql(date, minutes) {
  const t = new Date(`${date}T00:00:00Z`).getTime() + minutes * 60000 - MANILA_OFFSET_MS;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** Back from that UTC time to { date, minutes } in Manila. */
function fromUtcSql(sql) {
  const local = new Date(`${String(sql).replace(' ', 'T')}Z`).getTime() + MANILA_OFFSET_MS;
  const d = new Date(local);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** "Tue 4 Nov, 10:30 AM" (pick-up) or "Tue 4 Nov, 10:30–11:00 AM" (delivery), from a saved order. */
function label(order) {
  if (!order || !order.scheduled_for) return '';
  const { date, minutes } = fromUtcSql(order.scheduled_for);
  if (order.order_type === 'delivery') {
    const end = minutes + WINDOW_MINUTES;
    const a = clock12(minutes);
    const b = clock12(end);
    // "10:30–11:00 AM", or "11:30 AM–12:00 PM" across noon.
    const same = a.slice(-2) === b.slice(-2);
    return `${dayLabel(date)}, ${same ? a.slice(0, -3) : a}–${b}`;
  }
  return `${dayLabel(date)}, ${clock12(minutes)}`;
}

/**
 * Check when the customer wants an order, for create().
 * input: pickup_at / pickup_date for pick-up ('asap' or 'HH:MM'), and
 * deliver_at / deliver_date for delivery (blank or 'asap' means as soon as
 * possible, so a page from before scheduling still works).
 * @returns {{ pickup_at, scheduled_for, scheduled_date, service_date }}
 *   service_date is the Manila day the order counts against daily limits.
 * @throws ValidationError, or { status: 409, closed: true } when the switch is off
 */
function parseWhen(type, input, now = new Date()) {
  const today = manilaDate(now);
  const open = openNow(now);
  const field = type === 'pickup' ? 'pickup_at' : 'deliver_at';
  const refuse = (message) => { throw new ValidationError({ [field]: message }); };

  if (type === 'dinein') {
    if (!open) refuse("Dine-in orders are taken while we're open.");
    return { pickup_at: '', scheduled_for: null, scheduled_date: null, service_date: today };
  }

  const rawTime = String((type === 'pickup' ? input.pickup_at : input.deliver_at) ?? '').trim();
  const rawDate = String((type === 'pickup' ? input.pickup_date : input.deliver_date) ?? '').trim();
  const asap = type === 'pickup' ? rawTime === 'asap' : rawTime === '' || rawTime === 'asap';
  if (asap) {
    if (!open) {
      const n = next(type, now);
      refuse(n ? `We're closed now. Choose a time: the first is ${whenText(n.date, n.minutes, now)}.`
        : "We're closed now and not taking orders ahead.");
    }
    return { pickup_at: type === 'pickup' ? 'asap' : '', scheduled_for: null, scheduled_date: null, service_date: today };
  }

  if (type === 'pickup' && !rawTime) refuse('Choose when you will pick up your order.');
  const date = rawDate || today; // a page from before dates picks a time today
  if (!realDate(date)) refuse('Choose a day from the list.');
  if (date < today) refuse('That day has passed. Choose another.');
  if (date > addDays(today, preorderDays())) {
    refuse(preorderDays() === 0 ? 'We take orders for today only.' : `We take orders up to ${preorderDays()} days ahead.`);
  }
  const mins = toMinutes(rawTime);
  const { open: o, close: c } = hours();
  const step = type === 'delivery' ? WINDOW_MINUTES : SLOT_MINUTES;
  const last = type === 'delivery' ? c - WINDOW_MINUTES : Math.min(c, 24 * 60 - SLOT_MINUTES);
  if (mins === null || o === null || mins < o || mins > last || (mins - o) % step !== 0) {
    refuse(type === 'delivery' ? 'Choose a delivery time from the list.' : 'Choose a pick-up time from the list.');
  }
  if (date === today) {
    const lead = (type === 'delivery' ? DELIVERY_LEAD : PICKUP_LEAD) - GRACE;
    if (mins < manilaMinutes(now) + lead) refuse('That time is too soon. Choose a later one.');
  }
  return {
    pickup_at: type === 'pickup' ? hhmm(mins) : '',
    scheduled_for: utcSql(date, mins), scheduled_date: date, service_date: date,
  };
}

module.exports = {
  SLOT_MINUTES, WINDOW_MINUTES, PICKUP_LEAD, DELIVERY_LEAD, MAX_DAYS,
  preorderDays, parseDays, openNow, slots, dates, next, dayLabel, clock12, whenText, utcSql, fromUtcSql, label, parseWhen, hhmm,
};
