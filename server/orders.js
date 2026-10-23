'use strict';
/* Customer orders (delivery, pick-up and dine-in) and the ordering settings.
   Orders come from the public menu, so nothing the browser sends about money
   is trusted: prices, the fee and the total are all recomputed here. */

const { db, transaction } = require('./db');
const menu = require('./menu');
const vouchers = require('./vouchers');
const { manilaMinutes } = require('./clock');

const { ValidationError } = menu;

const STATUSES = ['new', 'preparing', 'delivering', 'completed', 'cancelled'];
const ACTIVE_STATUSES = ['new', 'preparing', 'delivering'];

const NAME_MAX = 80;
const ADDRESS_MAX = 400;
const MAX_LINES = 50;
const MAX_QTY = 50;
const MAX_CASH = 1000000;
const MAX_FEE = 10000;

/* ---------------------------- delivery fee ---------------------------- */

function getDeliveryFee() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'delivery_fee'").get();
  return row ? Number(row.value) : 0;
}

function saveSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/** @returns the fee as an integer, or throws ValidationError */
function parseDeliveryFee(input) {
  const fee = Number(input);
  if (input === '' || input === null || input === undefined || !Number.isInteger(fee)) {
    throw new ValidationError({ delivery_fee: 'Enter the fee as a whole number of pesos.' });
  }
  if (fee < 0 || fee > MAX_FEE) {
    throw new ValidationError({ delivery_fee: `The fee must be between 0 and ${MAX_FEE}.` });
  }
  return fee;
}

function setDeliveryFee(input) {
  const fee = parseDeliveryFee(input);
  saveSetting('delivery_fee', fee);
  return fee;
}

/* ---------------------------- order types ---------------------------- */

// Delivery pays in cash at the door; pick-up and dine-in pay at the counter.
const ORDER_TYPES = ['delivery', 'pickup', 'dinein'];
const TABLE_MAX = 10;

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

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

/* ---------------------------- pick-up hours ---------------------------- */

// Pick-up is same day only, in 15-minute steps, in the shop's time zone.
const SLOT_MINUTES = 15;
const DEFAULT_PICKUP_OPEN = '10:00';
const DEFAULT_PICKUP_CLOSE = '20:00';

/** 'HH:MM' -> minutes since midnight, or null if it is not a valid time. */
function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseHour(key) {
  return (input) => {
    const mins = toMinutes(input);
    if (mins === null || mins % SLOT_MINUTES !== 0) {
      throw new ValidationError({ [key]: 'Enter a time on the quarter hour, like 10:00 or 17:30.' });
    }
    return String(input).trim();
  };
}

function pickupHours() {
  return {
    open: getSetting('pickup_open', DEFAULT_PICKUP_OPEN),
    close: getSetting('pickup_close', DEFAULT_PICKUP_CLOSE),
  };
}

/** @returns 'asap' or 'HH:MM', or throws ValidationError */
function parsePickupTime(input, now) {
  const { open, close } = pickupHours();
  const openMins = toMinutes(open);
  const closeMins = toMinutes(close);
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

/* ---------------------------- all settings ---------------------------- */

function settings() {
  const { open, close } = pickupHours();
  return {
    delivery_fee: getDeliveryFee(),
    delivery_enabled: isEnabled('delivery'),
    pickup_enabled: isEnabled('pickup'),
    dinein_enabled: isEnabled('dinein'),
    pickup_open: open,
    pickup_close: close,
  };
}

/** Validate every submitted setting first, so a bad value never half-applies. */
function updateSettings(input) {
  const parsers = {
    delivery_fee: parseDeliveryFee,
    delivery_enabled: parseSwitch('delivery_enabled'),
    pickup_enabled: parseSwitch('pickup_enabled'),
    dinein_enabled: parseSwitch('dinein_enabled'),
    pickup_open: parseHour('pickup_open'),
    pickup_close: parseHour('pickup_close'),
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
  if (!errors.pickup_open && !errors.pickup_close) {
    const hours = pickupHours();
    const open = values.pickup_open ?? hours.open;
    const close = values.pickup_close ?? hours.close;
    if (toMinutes(open) >= toMinutes(close)) errors.pickup_close = 'Closing must be after opening.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  transaction(() => Object.entries(values).forEach(([key, v]) => saveSetting(key, v)));
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

  const qtyById = new Map();
  for (const line of rawItems) {
    const id = Number(line && line.id);
    const qty = Number(line && line.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) {
      throw new ValidationError({ items: 'One of the cart lines is not valid.' });
    }
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  for (const qty of qtyById.values()) {
    if (qty > MAX_QTY) throw new ValidationError({ items: `Order at most ${MAX_QTY} of any one item.` });
  }
  return [...qtyById].map(([id, qty]) => ({ id, qty }));
}

/**
 * Price a cart against the live menu, at sale prices where an item is on
 * sale. Only delivery pays the delivery fee.
 * Items that are deleted, not available or sold out (by hand or because
 * today's limit is used up) go in `unavailable`. Items with fewer left today
 * than the cart wants go in `limits` as { id: remaining }.
 * A voucher code takes `discount` off the items, never the fee. If the code
 * does not work, `voucher` is null and `voucherError` says why.
 * @returns {{ lines, unavailable, limits, short, subtotal, discount, voucher,
 *             voucherError, delivery_fee, total }}
 */
function quote(rawItems, type = 'delivery', now = new Date(), voucherCode = '') {
  const lines = [];
  const unavailable = [];
  const short = [];

  for (const { id, qty } of cartLines(rawItems)) {
    const item = menu.get(id, { now });
    if (!item || item.availability === 'unavailable' || item.sold_out) {
      unavailable.push(id);
      continue;
    }
    if (item.remaining !== null && qty > item.remaining) {
      short.push({ id: item.id, name: item.name, remaining: item.remaining });
    }
    lines.push({ item_id: item.id, name: item.name, price: item.sale_price, qty });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  let voucher = null;
  let voucherError = null;
  if (vouchers.normaliseCode(voucherCode)) {
    try {
      voucher = vouchers.check(voucherCode, subtotal, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      voucherError = err.errors.voucher;
    }
  }
  const discount = voucher ? voucher.discount : 0;

  const delivery_fee = type === 'delivery' ? getDeliveryFee() : 0;
  const limits = Object.fromEntries(short.map((s) => [s.id, s.remaining]));
  return {
    lines, unavailable, limits, short, subtotal, discount, voucher, voucherError,
    delivery_fee, total: subtotal - discount + delivery_fee,
  };
}

/** A 409 carrying the live prices, so the page can update and ask again. */
function staleCart(message, q) {
  return Object.assign(new Error(message), {
    status: 409,
    body: {
      error: message,
      quote: {
        items: q.lines.map((l) => ({ id: l.item_id, name: l.name, price: l.price })),
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
 * input: { type, name, phone, address, cash, table_no, pickup_at, voucher,
 *          items: [{ id, qty }], expected_total }
 * Which fields are required depends on the type:
 *   delivery  name, phone, address, cash
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
  const type = input.type === undefined ? 'delivery' : String(input.type);
  if (!ORDER_TYPES.includes(type) || !isEnabled(type)) {
    throw new ValidationError({ type: 'That order type is not available right now. Choose another.' });
  }

  const errors = {};

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter your full name.';
  else if (name.length > NAME_MAX) errors.name = `Keep your name under ${NAME_MAX} characters.`;

  let phone = '';
  if (type !== 'dinein') {
    phone = normalisePhone(input.phone);
    const phoneDigits = phone.replace('+', '');
    if (!phoneDigits) errors.phone = 'Enter a phone number we can call.';
    else if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      errors.phone = 'That phone number does not look right.';
    }
  }

  let address = '';
  let cash = 0;
  if (type === 'delivery') {
    address = String(input.address ?? '').trim();
    if (!address) errors.address = 'Enter the delivery address.';
    else if (address.length > ADDRESS_MAX) errors.address = `Keep the address under ${ADDRESS_MAX} characters.`;

    const cashRaw = input.cash;
    cash = Number(cashRaw);
    const cashGiven = !(cashRaw === '' || cashRaw === null || cashRaw === undefined);
    if (!cashGiven) errors.cash = 'Enter how much cash you will pay with.';
    else if (!Number.isInteger(cash) || cash < 0 || cash > MAX_CASH) {
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
    q = quote(input.items, type, now, input.voucher);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    Object.assign(errors, err.errors);
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

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
  if (type === 'delivery' && cash < q.total) {
    throw new ValidationError({ cash: `The total is Php ${q.total}, so the cash must be at least that.` });
  }
  // Counter orders store no cash: they pay the total in person.
  const changeDue = type === 'delivery' ? cash - q.total : 0;

  const id = transaction(() => {
    const info = db.prepare(`
      INSERT INTO orders (order_type, customer_name, phone, address, table_no, pickup_at,
                          subtotal, voucher_code, discount, delivery_fee, total, cash, change_due)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type, name, phone, address, tableNo, pickupAt,
      q.subtotal, q.voucher ? q.voucher.code : '', q.discount, q.delivery_fee, q.total, cash, changeDue);
    const line = db.prepare(
      'INSERT INTO order_items (order_id, item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)');
    q.lines.forEach((l) => line.run(info.lastInsertRowid, l.item_id, l.name, l.price, l.qty));
    return info.lastInsertRowid;
  });

  return get(id);
}

/* ---------------------------- queries ---------------------------- */

function withLines(order) {
  if (!order) return null;
  order.items = db.prepare(
    'SELECT item_id, name, price, qty FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  return order;
}

function get(id) {
  return withLines(db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id)) || null);
}

/**
 * @param {'active'|'finished'|'all'} which
 */
function list(which = 'active') {
  const filter = {
    active: `WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
    finished: "WHERE status IN ('completed','cancelled')",
    all: '',
  }[which];
  if (filter === undefined) throw Object.assign(new Error('Unknown order filter.'), { status: 400 });

  const params = which === 'active' ? ACTIVE_STATUSES : [];
  // Active orders oldest first (the queue); finished ones newest first.
  const order = which === 'active' ? 'id ASC' : 'id DESC';
  return db.prepare(`SELECT * FROM orders ${filter} ORDER BY ${order} LIMIT 200`)
    .all(...params).map(withLines);
}

function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  return Object.fromEntries(STATUSES.map((s) => [s, (rows.find((r) => r.status === s) || {}).n || 0]));
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new ValidationError({ status: 'Choose a valid status.' });
  const info = db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, Number(id));
  return info.changes ? get(id) : null;
}

module.exports = {
  STATUSES, ORDER_TYPES, getDeliveryFee, setDeliveryFee, enabledTypes, pickupHours,
  settings, updateSettings, normalisePhone, getSetting, saveSetting,
  quote, create, get, list, counts, setStatus,
};
