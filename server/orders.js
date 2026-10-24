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
const MAX_FEE = 10000;

/* ---------------------------- delivery fee ---------------------------- */

function getDeliveryFee() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'delivery_fee'").get();
  return row ? Number(row.value) : 0;
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

/* ---------------------------- open / closed ---------------------------- */

// Dachel switches the shop open or closed by hand. While closed, customers can
// browse the menu but not order; cake bookings are not affected.
const CLOSED_NOTE_MAX = 120;

function isShopOpen() {
  return getSetting('shop_open', '1') === '1';
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

/** The error an order (or a voucher check) gets while the shop is closed. */
function shopClosedError() {
  const note = closedNote();
  const message = `Sorry, we're closed right now, so we can't take orders.${note ? ` ${note}` : ''}`;
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
  const { open, close } = pickupHours();
  const trust = trustRules();
  return {
    delivery_fee: getDeliveryFee(),
    delivery_enabled: isEnabled('delivery'),
    pickup_enabled: isEnabled('pickup'),
    dinein_enabled: isEnabled('dinein'),
    pickup_open: open,
    pickup_close: close,
    shop_open: isShopOpen(),
    closed_note: closedNote(),
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
    delivery_fee: parseDeliveryFee,
    delivery_enabled: parseSwitch('delivery_enabled'),
    pickup_enabled: parseSwitch('pickup_enabled'),
    dinein_enabled: parseSwitch('dinein_enabled'),
    pickup_open: parseHour('pickup_open'),
    pickup_close: parseHour('pickup_close'),
    shop_open: parseSwitch('shop_open'),
    closed_note: parseClosedNote,
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
    lines.push({
      item_id: item.id, name: item.name, price: item.sale_price, regular: item.price,
      sc_eligible: item.sc_eligible, qty,
    });
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

  const fee = type === 'delivery' ? getDeliveryFee() : 0;
  const priced = lines.length ? pricing.price({
    type,
    lines: lines.map((l, i) => ({
      key: String(i), item_id: l.item_id, name: l.name, qty: l.qty,
      unit_cents: l.regular * 100, sale_cents: l.price * 100, sc_eligible: l.sc_eligible,
    })),
    voucher: found,
    delivery: { default_cents: fee * 100 },
  }) : null;
  const t = priced ? priced.totals : { subtotal: 0, voucher_discount: 0, delivery_fee: fee * 100, total: fee * 100 };

  const discount = t.voucher_discount / 100;
  const voucher = found ? { code: found.code, label: found.label, discount } : null;
  const limits = Object.fromEntries(short.map((s) => [s.id, s.remaining]));
  return {
    lines, unavailable, limits, short, subtotal: t.subtotal / 100, discount, voucher, voucherError,
    delivery_fee: t.delivery_fee / 100, total: t.total / 100, priced,
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
  if (!isShopOpen()) throw shopClosedError();

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
  if (type === 'delivery' && cash < q.total) {
    throw new ValidationError({ cash: `The total is Php ${q.total}, so the cash must be at least that.` });
  }
  // Counter orders store no cash: they pay the total in person.
  const changeDue = type === 'delivery' ? cash - q.total : 0;

  const id = transaction(() => {
    const t = q.priced.totals;
    const info = db.prepare(`
      INSERT INTO orders (source, order_type, status, customer_name, phone, phone_norm, address, landmark,
                          table_no, pickup_at, gross_cents, subtotal_cents, voucher_code, discount_cents,
                          delivery_fee_cents, total_cents, cash_cents, change_due_cents, pricing)
      VALUES ('online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type, status, name, phone, phoneNorm, address, landmark, tableNo, pickupAt,
      t.gross, t.subtotal, q.voucher ? q.voucher.code : '', t.voucher_discount,
      t.delivery_fee, t.total, cash * 100, changeDue * 100, JSON.stringify(q.priced));
    insertLines(info.lastInsertRowid, q.priced.lines);
    return info.lastInsertRowid;
  });

  return get(id);
}

/** Save the engine's lines: unit price charged, regular price and net, in centavos. */
function insertLines(orderId, lines) {
  const line = db.prepare(`
    INSERT INTO order_items (order_id, item_id, name, price_cents, regular_price_cents, net_cents, qty)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((l) => line.run(orderId, l.item_id, l.name, l.sale_unit_cents, l.unit_cents, l.net, l.qty));
}

/* ---------------------------- queries ---------------------------- */

// Stored as *_cents. The same amounts in pesos are added when an order is
// read, for the checkout page and anything written before the POS.
const PESO_FIELDS = ['subtotal', 'discount', 'delivery_fee', 'total', 'cash', 'change_due'];

/**
 * Add the lines, the peso fields and the pricing breakdown. SC/PWD ID
 * numbers are masked (****1234) unless options.fullIds, which only the
 * owner's and cashier's screens ask for.
 */
function withLines(order, { fullIds = false } = {}) {
  if (!order) return null;
  for (const f of PESO_FIELDS) order[f] = order[`${f}_cents`] / 100;
  order.items = db.prepare(`
    SELECT item_id, name, price_cents, regular_price_cents, net_cents, qty
    FROM order_items WHERE order_id = ? ORDER BY id`).all(order.id)
    .map((l) => ({ ...l, price: l.price_cents / 100 }));
  order.pricing = order.pricing ? JSON.parse(order.pricing) : null;
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
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  return Object.fromEntries(STATUSES.map((s) => [s, (rows.find((r) => r.status === s) || {}).n || 0]));
}

/**
 * Move an order along. A New order whose type needs confirmation cannot go
 * to Preparing (or on to handed over) until it is Confirmed; it can still be
 * cancelled, or marked completed. Cancelling takes a reason (CANCEL_REASONS).
 */
function setStatus(id, status, { reason } = {}) {
  if (!STATUSES.includes(status)) throw new ValidationError({ status: 'Choose a valid status.' });
  const order = db.prepare('SELECT status, order_type, cancel_reason FROM orders WHERE id = ?').get(Number(id));
  if (!order) return null;

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
  STATUSES, CANCEL_REASONS, ORDER_TYPES, PESO_FIELDS, getDeliveryFee, setDeliveryFee, enabledTypes, pickupHours,
  settings, updateSettings, normalisePhone, getSetting, saveSetting,
  isShopOpen, closedNote, shopClosedError, requiresConfirmation, historyFor,
  quote, create, insertLines, get, list, counts, setStatus,
};
