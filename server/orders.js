'use strict';
/* Customer orders (delivery, pick-up and dine-in) and the ordering settings.
   Orders come from the public menu, so nothing the browser sends about money
   is trusted: prices, the fee and the total are all recomputed here. */

const { db, transaction } = require('./db');
const menu = require('./menu');
const vouchers = require('./vouchers');
const blocklist = require('./blocklist');
const pricing = require('./pricing');
const { getSetting, saveSetting } = require('./settings');
const { manilaMinutes } = require('./clock');
const { normalizePhPhone, PHONE_MESSAGE } = require('./phone');
const delivery = require('./delivery');
const itemOptions = require('./options');

const { ValidationError } = menu;

const STATUSES = ['new', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled'];
const ACTIVE_STATUSES = ['new', 'confirmed', 'preparing', 'delivering'];
// Why an order was cancelled. No-shows and fakes count against the number.
const CANCEL_REASONS = ['customer', 'no_show', 'fake', 'other'];
const LANDMARK_MIN = 5;
const LANDMARK_MAX = 200;

const NAME_MAX = 80;
const ADDRESS_MAX = 400;
const MAX_LINES = 50;
const MAX_QTY = 50;
const MAX_CASH = 1000000;

/* ---------------------------- delivery fee ---------------------------- */

// The fee comes from the delivery area the customer picks (server/delivery.js).
// The single 'delivery_fee' setting from before areas is no longer read.

/* ---------------------------- order types ---------------------------- */

// Delivery pays in cash at the door; pick-up and dine-in pay at the counter.
const ORDER_TYPES = ['delivery', 'pickup', 'dinein'];
const TABLE_MAX = 10;

function isEnabled(type) {
  return getSetting(`${type}_enabled`, '1') === '1';
}

function enabledTypes() {
  return ORDER_TYPES.filter(isEnabled);
}

function parseSwitch(key) {
  return (input) => {
    if (input === true || input === 'true' || input === '1' || input === 1) return '1';
    if (input === false || input === 'false' || input === '0' || input === 0) return '0';
    throw new ValidationError({ [key]: 'Choose on or off.' });
  };
}

/* ---------------------------- opening hours ---------------------------- */

// One set of hours, the same every day, in Manila time. Online ordering is
// open between them and pick-up times are offered within them; 30 minutes
// before closing the menu says it is closing soon. They are kept under the
// old pick-up keys, so the hours set before this change carry over.
// Pick-up is same day only, in 15-minute steps.
const SLOT_MINUTES = 15;
const DEFAULT_PICKUP_OPEN = '10:00';
const DEFAULT_PICKUP_CLOSE = '20:00';
const CLOSING_SOON_MINUTES = 30;

/** 'HH:MM' -> minutes since midnight, or null if it is not a valid time. */
function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A closing time in minutes: like toMinutes, and '24:00' (open until midnight) is 1440. */
function closeMinutes(hhmm) {
  return String(hhmm ?? '').trim() === '24:00' ? 24 * 60 : toMinutes(hhmm);
}

function parseHour(key, { closing = false } = {}) {
  return (input) => {
    const mins = closing ? closeMinutes(input) : toMinutes(input);
    if (mins === null || mins % SLOT_MINUTES !== 0) {
      throw new ValidationError({ [key]: 'Enter a time on the quarter hour, like 10:00 or 17:30.' });
    }
    return String(input).trim();
  };
}

/** The opening hours, { open, close } as 'HH:MM'. Pick-up uses the same. */
function openingHours() {
  return {
    open: getSetting('pickup_open', DEFAULT_PICKUP_OPEN),
    close: getSetting('pickup_close', DEFAULT_PICKUP_CLOSE),
  };
}
const pickupHours = openingHours;

/** '20:00' -> '8:00 PM' */
function clock12(hhmm) {
  const mins = toMinutes(hhmm);
  if (mins === null) return String(hhmm);
  const h = Math.floor(mins / 60);
  return `${h % 12 || 12}:${String(mins % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** @returns 'asap' or 'HH:MM', or throws ValidationError */
function parsePickupTime(input, now) {
  const { open, close } = pickupHours();
  const openMins = toMinutes(open);
  const closeMins = closeMinutes(close);
  const nowMins = manilaMinutes(now);
  const value = String(input ?? '').trim();

  if (!value) throw new ValidationError({ pickup_at: 'Choose when you will pick up your order.' });
  if (value === 'asap') {
    if (nowMins < openMins || nowMins >= closeMins) {
      throw new ValidationError({ pickup_at: `Pick-up is from ${open} to ${close}. Choose a time.` });
    }
    return value;
  }
  const mins = toMinutes(value);
  if (mins === null || mins % SLOT_MINUTES !== 0 || mins < openMins || mins > closeMins) {
    throw new ValidationError({ pickup_at: `Choose a pick-up time between ${open} and ${close}.` });
  }
  // The page offers times at least 15 minutes ahead; allow 10 so a slow
  // submit is not refused.
  if (mins < nowMins + 10) {
    throw new ValidationError({ pickup_at: 'That time is too soon. Choose a later pick-up time.' });
  }
  return value;
}

/* ---------------------------- open / closed ---------------------------- */

// Ordering opens and closes with the opening hours. The Open/Closed switch is
// an override: Closed (a holiday, closing early) closes ordering even within
// the hours. While closed, customers can browse the menu but not order; cake
// bookings are not affected.
const CLOSED_NOTE_MAX = 120;

/**
 * Where the shop stands right now.
 * @returns {{ open, switch_open, in_hours, before_opening, closing_soon,
 *             minutes_left, opens_at, closes_at }}
 */
function shopState(now = new Date()) {
  const { open, close } = openingHours();
  const switchOpen = getSetting('shop_open', '1') === '1';
  const mins = manilaMinutes(now);
  const openMins = toMinutes(open);
  const closeMins = closeMinutes(close);
  const inHours = mins >= openMins && mins < closeMins;
  const isOpen = switchOpen && inHours;
  return {
    open: isOpen,
    switch_open: switchOpen,
    in_hours: inHours,
    before_opening: mins < openMins,
    closing_soon: isOpen && closeMins - mins <= CLOSING_SOON_MINUTES,
    minutes_left: isOpen ? closeMins - mins : 0,
    opens_at: open,
    closes_at: close,
  };
}

function isShopOpen(now = new Date()) {
  return shopState(now).open;
}

function closedNote() {
  return getSetting('closed_note', '');
}

function parseClosedNote(input) {
  const note = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (note.length > CLOSED_NOTE_MAX) {
    throw new ValidationError({ closed_note: `Keep the note under ${CLOSED_NOTE_MAX} characters.` });
  }
  return note;
}

/* ---------------------------- customer page settings ---------------------------- */

// After an order: "We'll call you within about N minutes to confirm".
const DEFAULT_CALL_MINUTES = 5;
const FACEBOOK_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'fb.me', 'm.me'];
const FACEBOOK_DEFAULT = require('./business').BUSINESS.facebook;
const URL_MAX = 200;

function callMinutes() {
  const n = Number(getSetting('confirm_call_minutes', String(DEFAULT_CALL_MINUTES)));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CALL_MINUTES;
}

/** The shop's Facebook (or Messenger) link, for "Message us on Facebook". */
function facebookUrl() {
  return getSetting('facebook_url', FACEBOOK_DEFAULT) || FACEBOOK_DEFAULT;
}

/** Only an https link to Facebook or Messenger; blank goes back to the default. */
function parseFacebookUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return FACEBOOK_DEFAULT;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError({ facebook_url: 'Paste the full link, starting with https://' });
  }
  if (url.protocol !== 'https:' || !FACEBOOK_HOSTS.includes(url.hostname.toLowerCase()) || raw.length > URL_MAX) {
    throw new ValidationError({ facebook_url: 'Use your Facebook page or Messenger link, e.g. https://www.facebook.com/YourPage' });
  }
  return url.toString();
}

/** The image shown when the site is shared (Open Graph), or '' for the logo.
    Must be a photo uploaded through the admin (metadata already stripped). */
function shareImage() {
  const rel = getSetting('share_image', '');
  return rel && menu.resolveImage(rel) ? rel : '';
}

function parseShareImage(input) {
  const rel = String(input ?? '').trim();
  if (!rel) return '';
  const img = rel.startsWith('assets/uploads/') ? menu.resolveImage(rel) : null;
  if (!img) throw new ValidationError({ share_image: 'Upload the share image first, then save.' });
  return img.rel;
}

/** Free delivery from this much (pesos, after discounts); blank turns it off. */
function parseFreeMin(input) {
  const raw = input === null || input === undefined ? '' : String(input).trim();
  if (raw === '') return '';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100000) {
    throw new ValidationError({ free_delivery_min: 'Enter a whole number of pesos, or leave it blank for no free delivery.' });
  }
  return String(n);
}

/** What the menu says while ordering is closed, for the switch or the hours. */
function closedMessage(now = new Date()) {
  const s = shopState(now);
  if (!s.switch_open) {
    const note = closedNote();
    return `Sorry, we're closed right now, so we can't take orders.${note ? ` ${note}` : ''}`;
  }
  return s.before_opening
    ? `Sorry, we're not open yet. We take orders from ${clock12(s.opens_at)} today.`
    : `Sorry, we're closed for today. We take orders again from ${clock12(s.opens_at)} tomorrow.`;
}

/** The error an order (or a voucher check) gets while the shop is closed. */
function shopClosedError(now = new Date()) {
  const message = closedMessage(now);
  return Object.assign(new Error(message), { status: 409, body: { error: message, closed: true } });
}

/* ---------------------------- fake-order protection ---------------------------- */

// Orders of a type that needs confirmation wait as New until Dachel has
// called the customer and tapped Confirm; only then can they be prepared.
// Dine-in customers are standing in the shop, so by default they do not.
const CONFIRM_DEFAULTS = { delivery: '1', pickup: '1', dinein: '0' };

function requiresConfirmation(type) {
  return getSetting(`require_confirm_${type}`, CONFIRM_DEFAULTS[type] || '0') === '1';
}

// How many orders still in progress one phone number may have at once.
const DEFAULT_MAX_OPEN = 3;
// Auto-confirm (off by default) numbers with this many completed orders and
// at most this many no-shows or fakes.
const DEFAULT_TRUSTED_COMPLETED = 3;
const DEFAULT_TRUSTED_FLAGS = 0;

function intSetting(key, fallback) {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isInteger(n) ? n : fallback;
}

function maxOpenOrders() {
  return intSetting('max_open_orders', DEFAULT_MAX_OPEN);
}

function trustRules() {
  return {
    on: getSetting('auto_confirm_trusted', '0') === '1',
    min_completed: intSetting('trusted_min_completed', DEFAULT_TRUSTED_COMPLETED),
    max_flags: intSetting('trusted_max_flags', DEFAULT_TRUSTED_FLAGS),
  };
}

function parseCount(key, min, max) {
  return (input) => {
    const n = Number(input);
    if (input === '' || input === null || input === undefined || !Number.isInteger(n) || n < min || n > max) {
      throw new ValidationError({ [key]: `Enter a whole number from ${min} to ${max}.` });
    }
    return String(n);
  };
}

/**
 * Past orders per normalised phone: { orders, completed, no_show, fake, open }.
 * One grouped query for the whole list, on the phone_norm index.
 * @returns Map(phone_norm -> counts)
 */
function historyFor(phoneNorms) {
  const phones = [...new Set(phoneNorms.filter(Boolean))];
  if (!phones.length) return new Map();
  const rows = db.prepare(`
    SELECT phone_norm, COUNT(*) AS orders,
           SUM(status = 'completed') AS completed,
           SUM(status = 'cancelled' AND cancel_reason = 'no_show') AS no_show,
           SUM(status = 'cancelled' AND cancel_reason = 'fake') AS fake,
           SUM(status NOT IN ('completed','cancelled')) AS open
    FROM orders WHERE phone_norm IN (${phones.map(() => '?').join(',')})
    GROUP BY phone_norm`).all(...phones);
  return new Map(rows.map((r) => [r.phone_norm, {
    orders: r.orders, completed: r.completed || 0, no_show: r.no_show || 0, fake: r.fake || 0, open: r.open || 0,
  }]));
}

const EMPTY_HISTORY = { orders: 0, completed: 0, no_show: 0, fake: 0, open: 0 };

function isTrusted(history, rules = trustRules()) {
  return history.completed >= rules.min_completed && history.no_show + history.fake <= rules.max_flags;
}

/** A refusal that index.js logs by code. Neutral wording, no personal data. */
function rejection(status, code, message) {
  return Object.assign(new Error(message), { status, code, body: { error: message } });
}

/* ---------------------------- all settings ---------------------------- */

function settings() {
  const state = shopState();
  const trust = trustRules();
  return {
    delivery_enabled: isEnabled('delivery'),
    pickup_enabled: isEnabled('pickup'),
    dinein_enabled: isEnabled('dinein'),
    open_at: state.opens_at,
    close_at: state.closes_at,
    // shop_open is the Open/Closed switch; open_now is the switch and the hours together.
    shop_open: state.switch_open,
    open_now: state.open,
    in_hours: state.in_hours,
    closing_soon: state.closing_soon,
    closed_note: closedNote(),
    confirm_call_minutes: callMinutes(),
    facebook_url: facebookUrl(),
    share_image: shareImage(),
    free_delivery_min: delivery.freeOver(),
    require_confirm_delivery: requiresConfirmation('delivery'),
    require_confirm_pickup: requiresConfirmation('pickup'),
    require_confirm_dinein: requiresConfirmation('dinein'),
    max_open_orders: maxOpenOrders(),
    auto_confirm_trusted: trust.on,
    trusted_min_completed: trust.min_completed,
    trusted_max_flags: trust.max_flags,
  };
}

/** Validate every submitted setting first, so a bad value never half-applies. */
function updateSettings(input) {
  const parsers = {
    delivery_enabled: parseSwitch('delivery_enabled'),
    pickup_enabled: parseSwitch('pickup_enabled'),
    dinein_enabled: parseSwitch('dinein_enabled'),
    open_at: parseHour('open_at'),
    close_at: parseHour('close_at', { closing: true }),
    shop_open: parseSwitch('shop_open'),
    closed_note: parseClosedNote,
    confirm_call_minutes: parseCount('confirm_call_minutes', 1, 120),
    facebook_url: parseFacebookUrl,
    share_image: parseShareImage,
    free_delivery_min: parseFreeMin,
    require_confirm_delivery: parseSwitch('require_confirm_delivery'),
    require_confirm_pickup: parseSwitch('require_confirm_pickup'),
    require_confirm_dinein: parseSwitch('require_confirm_dinein'),
    max_open_orders: parseCount('max_open_orders', 1, 20),
    auto_confirm_trusted: parseSwitch('auto_confirm_trusted'),
    trusted_min_completed: parseCount('trusted_min_completed', 1, 50),
    trusted_max_flags: parseCount('trusted_max_flags', 0, 10),
  };
  const values = {};
  const errors = {};
  for (const [key, parse] of Object.entries(parsers)) {
    if (!(key in input)) continue;
    try {
      values[key] = parse(input[key]);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      Object.assign(errors, err.errors);
    }
  }
  if (!errors.open_at && !errors.close_at) {
    const hours = openingHours();
    const open = values.open_at ?? hours.open;
    const close = values.close_at ?? hours.close;
    if (toMinutes(open) >= closeMinutes(close)) errors.close_at = 'Closing must be after opening.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  // The hours keep their original keys (see opening hours above).
  const STORED_AS = { open_at: 'pickup_open', close_at: 'pickup_close' };
  transaction(() => Object.entries(values).forEach(([key, v]) => saveSetting(STORED_AS[key] || key, v)));
  return settings();
}

/* ---------------------------- validation ---------------------------- */

/** Keep digits and a leading +, so "0917 123 4567" and "0917-123-4567" match. */
function normalisePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/\D/g, '');
  return (s.startsWith('+') ? '+' : '') + digits;
}

/** Merge repeated ids and check quantities. Returns [{ id, qty }] or throws. */
function cartLines(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError({ items: 'Your cart is empty.' });
  }
  if (rawItems.length > MAX_LINES) {
    throw new ValidationError({ items: 'That cart has too many lines.' });
  }

  // The same item with the same options is one line; other options, another.
  const byKey = new Map();
  const qtyById = new Map();
  for (const line of rawItems) {
    const id = Number(line && line.id);
    const qty = Number(line && line.qty);
    const opts = line && line.options;
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1
      || (opts !== undefined && opts !== null && (!Array.isArray(opts) || opts.length > 50))) {
      throw new ValidationError({ items: 'One of the cart lines is not valid.' });
    }
    const ids = [...new Set((opts || []).map(Number))].sort((a, b) => a - b);
    const key = ids.length ? `${id}:${ids.join('.')}` : String(id);
    const had = byKey.get(key);
    byKey.set(key, { id, qty: (had ? had.qty : 0) + qty, options: ids });
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  for (const qty of qtyById.values()) {
    if (qty > MAX_QTY) throw new ValidationError({ items: `Order at most ${MAX_QTY} of any one item.` });
  }
  return [...byKey.values()];
}

/**
 * Price a cart against the live menu, at sale prices where an item is on
 * sale, through the pricing engine the POS uses too. Only delivery pays the
 * delivery fee. Online orders get no SC/PWD, manual discount or service
 * charge: those are given at the counter.
 * Items that are deleted, not available or sold out (by hand or because
 * today's limit is used up) go in `unavailable`. Items with fewer left today
 * than the cart wants go in `limits` as { id: remaining }.
 * A voucher code takes `discount` off the items, never the fee. If the code
 * does not work, `voucher` is null and `voucherError` says why.
 * Amounts are pesos, as the checkout page shows them; `priced` is the
 * engine's breakdown in centavos (null for an empty cart).
 * @returns {{ lines, unavailable, limits, short, subtotal, discount, voucher,
 *             voucherError, delivery_fee, total, priced }}
 */
function quote(rawItems, type = 'delivery', now = new Date(), voucherCode = '', areaChoice = null) {
  const lines = [];
  const unavailable = [];
  const short = [];

  const perItem = new Map(); // item_id -> qty over all its lines
  for (const { id, qty, options } of cartLines(rawItems)) {
    const item = menu.get(id, { now });
    if (!item || item.availability === 'unavailable' || item.sold_out) {
      if (!unavailable.includes(id)) unavailable.push(id);
      continue;
    }
    // The options must be on this item, available, and fit each group.
    const chosen = itemOptions.choose(item, options);
    const prices = itemOptions.linePrices(item, chosen.options_cents);
    perItem.set(item.id, { item, qty: (perItem.has(item.id) ? perItem.get(item.id).qty : 0) + qty });
    lines.push({
      item_id: item.id, name: item.name, price: prices.sale_cents / 100, regular: prices.unit_cents / 100,
      sc_eligible: item.sc_eligible, qty, key: chosen.key, options: chosen.snapshot, options_cents: chosen.options_cents,
    });
  }
  // Today's limit counts the item, whatever options each line has.
  for (const { item, qty } of perItem.values()) {
    if (item.remaining !== null && qty > item.remaining) {
      short.push({ id: item.id, name: item.name, remaining: item.remaining });
    }
  }

  let found = null;
  let voucherError = null;
  if (vouchers.normaliseCode(voucherCode)) {
    try {
      found = vouchers.lookup(voucherCode, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      voucherError = err.errors.voucher;
    }
  }

  // Delivery: the fee comes from the area chosen (none yet, or "Other area": 0).
  const area = type === 'delivery' ? delivery.resolve(areaChoice) : null;
  const fee = area ? area.fee_cents / 100 : 0;
  const priced = lines.length ? pricing.price({
    type,
    lines: lines.map((l, i) => ({
      key: String(i), item_id: l.item_id, name: l.name, qty: l.qty,
      unit_cents: l.regular * 100, sale_cents: l.price * 100, sc_eligible: l.sc_eligible,
      options_text: itemOptions.optionsText(l.options),
    })),
    voucher: found,
    delivery: { default_cents: fee * 100, free_over_cents: area ? area.free_over_cents : null },
  }) : null;
  const t = priced ? priced.totals : { subtotal: 0, voucher_discount: 0, delivery_fee: fee * 100, total: fee * 100 };

  const discount = t.voucher_discount / 100;
  const voucher = found ? { code: found.code, label: found.label, discount } : null;
  const limits = Object.fromEntries(short.map((s) => [s.id, s.remaining]));
  return {
    lines, unavailable, limits, short, subtotal: t.subtotal / 100, discount, voucher, voucherError,
    delivery_fee: t.delivery_fee / 100, total: t.total / 100, priced, area,
    delivery_free: !!(priced && priced.delivery && priced.delivery.free),
  };
}

/** A 409 carrying the live prices, so the page can update and ask again. */
function staleCart(message, q) {
  return Object.assign(new Error(message), {
    status: 409,
    body: {
      error: message,
      quote: {
        items: q.lines.map((l) => ({ id: l.item_id, key: l.key, name: l.name, price: l.price })),
        unavailable: q.unavailable,
        limits: q.limits,
        voucher: q.voucher,
        delivery_fee: q.delivery_fee,
        total: q.total,
      },
    },
  });
}

/**
 * Validate and place an order.
 * input: { type, name, phone, address, landmark, cash, table_no, pickup_at, voucher,
 *          items: [{ id, qty }], expected_total }
 * Which fields are required depends on the type:
 *   delivery  name, phone, address, landmark, cash
 *   pickup    name, phone, pickup_at ('asap' or 'HH:MM' today)
 *   dinein    name, table_no
 * A missing type means delivery, so a page cached from before order types
 * still works.
 * expected_total is what the customer was shown; if the menu or the fee has
 * changed since, the order is refused with the new prices instead of charging
 * an amount they never saw.
 * options.now is the current time, for tests.
 */
function create(input, { now = new Date() } = {}) {
  if (!isShopOpen(now)) throw shopClosedError(now);

  const type = input.type === undefined ? 'delivery' : String(input.type);
  if (!ORDER_TYPES.includes(type) || !isEnabled(type)) {
    throw new ValidationError({ type: 'That order type is not available right now. Choose another.' });
  }

  const errors = {};

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter your full name.';
  else if (name.length > NAME_MAX) errors.name = `Keep your name under ${NAME_MAX} characters.`;

  // Dine-in takes no phone. The others must give a PH mobile number, kept as
  // typed (digits only) and as +639XXXXXXXXX for the checks below.
  let phone = '';
  let phoneNorm = null;
  if (type !== 'dinein') {
    phone = normalisePhone(input.phone);
    phoneNorm = normalizePhPhone(input.phone);
    if (!phone.replace('+', '')) errors.phone = 'Enter a phone number we can call.';
    else if (!phoneNorm) errors.phone = PHONE_MESSAGE;
  }

  let address = '';
  let landmark = '';
  let cash = 0;
  if (type === 'delivery') {
    address = String(input.address ?? '').trim();
    if (!address) errors.address = 'Enter the delivery address.';
    else if (address.length > ADDRESS_MAX) errors.address = `Keep the address under ${ADDRESS_MAX} characters.`;

    landmark = String(input.landmark ?? '').trim().replace(/\s+/g, ' ');
    if (!landmark) errors.landmark = 'Add a landmark or directions, e.g. beside 7-Eleven, green gate.';
    else if (landmark.length < LANDMARK_MIN) errors.landmark = 'Tell us a little more so the rider can find you.';
    else if (landmark.length > LANDMARK_MAX) errors.landmark = `Keep it under ${LANDMARK_MAX} characters.`;

    // Optional: left blank, the customer pays the exact amount (set below,
    // once the total is known) and no change is needed.
    const cashRaw = typeof input.cash === 'string' ? input.cash.trim() : input.cash;
    const cashGiven = !(cashRaw === '' || cashRaw === null || cashRaw === undefined);
    cash = cashGiven ? Number(cashRaw) : null;
    if (cashGiven && (!Number.isInteger(cash) || cash < 0 || cash > MAX_CASH)) {
      errors.cash = 'Enter the cash as a whole number of pesos.';
    }
  }

  let tableNo = '';
  if (type === 'dinein') {
    tableNo = String(input.table_no ?? '').trim();
    if (!tableNo) errors.table_no = 'Enter your table number.';
    else if (tableNo.length > TABLE_MAX) errors.table_no = `Keep the table number under ${TABLE_MAX} characters.`;
  }

  let pickupAt = '';
  if (type === 'pickup') {
    try {
      pickupAt = parsePickupTime(input.pickup_at, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      Object.assign(errors, err.errors);
    }
  }

  // The stock check and the insert below run with no await in between, and
  // Node runs one request's synchronous code at a time, so two customers
  // cannot both take the last one.
  let q = null;
  try {
    q = quote(input.items, type, now, input.voucher, input.delivery_area);
    if (type === 'delivery' && !q.area) {
      errors.delivery_area = 'Choose your area, or "Other area" and we will call you with the fee.';
    }
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    Object.assign(errors, err.errors);
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  // The number's standing: blocked, too many orders still in progress, or
  // trusted enough to skip the confirmation call.
  let status = 'new';
  if (phoneNorm) {
    if (blocklist.isBlocked(phoneNorm)) throw blocklist.blockedError();
    const history = historyFor([phoneNorm]).get(phoneNorm) || EMPTY_HISTORY;
    if (history.open >= maxOpenOrders()) {
      throw rejection(409, 'too_many_open',
        'You already have orders in progress. Please wait for them to finish or call us.');
    }
    const rules = trustRules();
    if (rules.on && requiresConfirmation(type) && isTrusted(history, rules)) status = 'confirmed';
  }

  if (q.unavailable.length) {
    throw staleCart('Some items in your cart are sold out or no longer on the menu. They have been removed.', q);
  }
  if (q.short.length) {
    const message = q.short.length === 1
      ? `Only ${q.short[0].remaining} ${q.short[0].name} left today. Your cart has been updated.`
      : 'Some items have only a few left today. Your cart has been updated.';
    throw staleCart(message, q);
  }
  // The code worked when applied but not now (expired, or turned off since):
  // drop it and let the customer see the new total before ordering.
  if (q.voucherError) throw staleCart(q.voucherError, q);
  if (q.lines.length === 0) throw new ValidationError({ items: 'Your cart is empty.' });
  if (Number(input.expected_total) !== q.total) {
    throw staleCart('Prices have changed since you opened the menu. Check the new total and place your order again.', q);
  }
  if (type === 'delivery' && cash === null) cash = q.total; // blank: exact amount
  if (type === 'delivery' && cash < q.total) {
    throw new ValidationError({ cash: `The total is ₱${q.total}, so the cash must be at least that.` });
  }
  // Counter orders store no cash: they pay the total in person.
  const changeDue = type === 'delivery' ? cash - q.total : 0;

  const id = transaction(() => {
    const t = q.priced.totals;
    const info = db.prepare(`
      INSERT INTO orders (source, order_type, status, customer_name, phone, phone_norm, address, landmark,
                          table_no, pickup_at, gross_cents, subtotal_cents, voucher_code, discount_cents,
                          delivery_fee_cents, total_cents, cash_cents, change_due_cents, pricing,
                          delivery_area_id, delivery_area, fee_to_confirm)
      VALUES ('online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type, status, name, phone, phoneNorm, address, landmark, tableNo, pickupAt,
      t.gross, t.subtotal, q.voucher ? q.voucher.code : '', t.voucher_discount,
      t.delivery_fee, t.total, cash * 100, changeDue * 100, JSON.stringify(q.priced),
      q.area ? q.area.id : null, q.area ? q.area.name : '', q.area && q.area.to_confirm ? 1 : 0);
    insertLines(info.lastInsertRowid, q.priced.lines, q.lines);
    return info.lastInsertRowid;
  });

  return get(id);
}

/** Save the engine's lines: unit price charged, regular price and net, in centavos. */
function insertLines(orderId, lines, quoted = []) {
  const line = db.prepare(`
    INSERT INTO order_items (order_id, item_id, name, price_cents, regular_price_cents, net_cents, qty,
                             options, options_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // The engine's lines are keyed by their place in the quote.
  lines.forEach((l) => {
    const q = quoted[Number(l.key)] || {};
    line.run(orderId, l.item_id, l.name, l.sale_unit_cents, l.unit_cents, l.net, l.qty,
      q.options && q.options.length ? JSON.stringify(q.options) : '', q.options_cents || 0);
  });
}

/* ---------------------------- queries ---------------------------- */

// Stored as *_cents. The same amounts in pesos are added when an order is
// read, for the checkout page and anything written before the POS.
const PESO_FIELDS = ['subtotal', 'discount', 'delivery_fee', 'total', 'cash', 'change_due',
  'gross', 'sc_pwd_discount', 'vat_exempt', 'manual_discount', 'service_charge'];

/**
 * Add the lines, the peso fields and the pricing breakdown. SC/PWD ID
 * numbers are masked (****1234) unless options.fullIds, which only the
 * owner's and cashier's screens ask for.
 */
/** A line's saved options, or [] (lines from before options, or a bad row). */
function parseOptions(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function withLines(order, { fullIds = false } = {}) {
  if (!order) return null;
  for (const f of PESO_FIELDS) order[f] = order[`${f}_cents`] / 100;
  // qty is what is charged: a POS line's voided units are left out (and
  // shown as voided_qty). A line voided completely is left out altogether.
  order.items = db.prepare(`
    SELECT item_id, name, price_cents, regular_price_cents, net_cents, qty, voided_qty, note, options, options_cents
    FROM order_items WHERE order_id = ? ORDER BY id`).all(order.id)
    .filter((l) => l.qty > l.voided_qty)
    .map((l) => {
      const options = parseOptions(l.options);
      return { ...l, qty: l.qty - l.voided_qty, price: l.price_cents / 100, options, options_text: itemOptions.optionsText(options) };
    });
  order.pricing = order.pricing ? JSON.parse(order.pricing) : null;
  // pos_input is what the cashier typed, SC/PWD ID numbers in full; the POS
  // reads it from the database itself (pos.view masks it per role). Neither
  // it nor the request key ever goes out with an order.
  delete order.pos_input;
  delete order.last_request_key;
  if (order.pricing && !fullIds) {
    order.pricing.claimants.forEach((c) => { c.id_no = pricing.maskId(c.id_no); });
  }
  return order;
}

function get(id, options) {
  return withLines(db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id)) || null, options);
}

/**
 * @param {'active'|'finished'|'all'} which
 */
// A POS tab that has not been sent to the kitchen is not in the queue yet,
// and is not counted with it.
const IN_QUEUE = "NOT (source = 'pos' AND kitchen_sent_at IS NULL)";

function list(which = 'active') {
  const filter = {
    active: `WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND ${IN_QUEUE}`,
    finished: `WHERE status IN ('completed','cancelled') AND ${IN_QUEUE}`,
    all: '',
  }[which];
  if (filter === undefined) throw Object.assign(new Error('Unknown order filter.'), { status: 400 });

  const params = which === 'active' ? ACTIVE_STATUSES : [];
  // Active orders oldest first (the queue); finished ones newest first.
  const order = which === 'active' ? 'id ASC' : 'id DESC';
  return withHistory(db.prepare(`SELECT * FROM orders ${filter} ORDER BY ${order} LIMIT 200`)
    .all(...params).map((o) => withLines(o)));
}

/**
 * Adds to each order the number's other orders (`history`: orders,
 * completed, no_show, fake), whether it is blocked, and whether this order
 * must be confirmed before it is prepared.
 */
function withHistory(list) {
  const history = historyFor(list.map((o) => o.phone_norm));
  const blocked = new Set(blocklist.list().map((b) => b.phone_norm));
  return list.map((o) => {
    const h = history.get(o.phone_norm);
    // Leave this order out, so a first order reads as "First order".
    const own = (s, reason) => (o.status === s && (!reason || o.cancel_reason === reason) ? 1 : 0);
    return {
      ...o,
      history: o.phone_norm && h ? {
        orders: h.orders - 1,
        completed: h.completed - own('completed'),
        no_show: h.no_show - own('cancelled', 'no_show'),
        fake: h.fake - own('cancelled', 'fake'),
      } : null,
      blocked: blocked.has(o.phone_norm),
      needs_confirm: requiresConfirmation(o.order_type),
    };
  });
}

function counts() {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE ${IN_QUEUE} GROUP BY status`).all();
  return Object.fromEntries(STATUSES.map((s) => [s, (rows.find((r) => r.status === s) || {}).n || 0]));
}

/**
 * Move an order along. A New order whose type needs confirmation cannot go
 * to Preparing (or on to handed over) until it is Confirmed; it can still be
 * cancelled, or marked completed. Cancelling takes a reason (CANCEL_REASONS).
 */
function setStatus(id, status, { reason } = {}) {
  if (!STATUSES.includes(status)) throw new ValidationError({ status: 'Choose a valid status.' });
  const order = db.prepare('SELECT status, order_type, cancel_reason, refunded_cents FROM orders WHERE id = ?').get(Number(id));
  if (!order) return null;

  // Money taken stays with a sale: refund it before cancelling.
  if (status === 'cancelled' && order.status !== 'cancelled') {
    const { paid } = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE order_id = ?').get(Number(id));
    if (paid - order.refunded_cents > 0) {
      throw Object.assign(new Error('This order has a payment. Refund it first (POS → Receipts).'), { status: 409 });
    }
  }

  if (order.status === 'new' && ['preparing', 'delivering'].includes(status) && requiresConfirmation(order.order_type)) {
    throw new ValidationError({ status: 'Confirm this order first: call the customer, then tap Confirm.' });
  }

  let cancelReason = '';
  if (status === 'cancelled') {
    cancelReason = reason === undefined || reason === '' ? order.cancel_reason : String(reason);
    if (cancelReason && !CANCEL_REASONS.includes(cancelReason)) {
      throw new ValidationError({ reason: 'Choose why the order was cancelled.' });
    }
  }

  db.prepare(`UPDATE orders SET status = ?, cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, cancelReason, Number(id));
  return get(id);
}

module.exports = {
  parseOptions,
  STATUSES, CANCEL_REASONS, ORDER_TYPES, PESO_FIELDS, enabledTypes, pickupHours,
  settings, updateSettings, normalisePhone, getSetting, saveSetting,
  isShopOpen, shopState, openingHours, clock12, closedMessage, CLOSING_SOON_MINUTES,
  closedNote, shopClosedError, requiresConfirmation, historyFor, callMinutes, facebookUrl, shareImage,
  quote, create, insertLines, get, list, counts, setStatus,
};
