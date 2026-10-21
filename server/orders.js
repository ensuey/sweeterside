'use strict';
/* Customer orders and the delivery fee setting.
   Orders come from the public menu, so nothing the browser sends about money
   is trusted: prices, the fee and the total are all recomputed here. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');

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

/* ---------------------------- messenger page ---------------------------- */

// Customers send their order summary to this page on Messenger (m.me/<page>).
const DEFAULT_MESSENGER_PAGE = 'SweeterSideByDachel';

function getMessengerPage() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'messenger_page'").get();
  return row ? row.value : DEFAULT_MESSENGER_PAGE;
}

/**
 * Accepts a page username, or a facebook.com / m.me link to the page, and
 * returns the username. An empty value turns the Messenger step off.
 */
function parseMessengerPage(input) {
  let page = String(input ?? '').trim();
  const link = page.match(/^(?:https?:\/\/)?(?:(?:www|m|web)\.)?(?:facebook\.com|fb\.com|m\.me)\/([^/?#\s]+)/i);
  if (link) page = link[1];
  page = page.replace(/^@/, '');

  // Facebook usernames are letters, digits and dots; page ids are digits.
  if (page && !/^[A-Za-z0-9.]{5,50}$/.test(page)) {
    throw new ValidationError({
      messenger_page: 'Enter the page username, like SweeterSideByDachel, or its facebook.com link.',
    });
  }
  return page;
}

function setMessengerPage(input) {
  const page = parseMessengerPage(input);
  saveSetting('messenger_page', page);
  return page;
}

/* ---------------------------- all settings ---------------------------- */

function settings() {
  return { delivery_fee: getDeliveryFee(), messenger_page: getMessengerPage() };
}

/** Validate every submitted setting first, so a bad value never half-applies. */
function updateSettings(input) {
  const parsers = { delivery_fee: parseDeliveryFee, messenger_page: parseMessengerPage };
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
 * Price a cart against the live menu.
 * @returns {{ lines, unavailable, subtotal, delivery_fee, total }}
 */
function quote(rawItems) {
  const lines = [];
  const unavailable = [];
  const find = db.prepare('SELECT id, name, price FROM items WHERE id = ?');

  for (const { id, qty } of cartLines(rawItems)) {
    const item = find.get(id);
    if (item) lines.push({ item_id: item.id, name: item.name, price: item.price, qty });
    else unavailable.push(id);
  }

  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const delivery_fee = getDeliveryFee();
  return { lines, unavailable, subtotal, delivery_fee, total: subtotal + delivery_fee };
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
        delivery_fee: q.delivery_fee,
        total: q.total,
      },
    },
  });
}

/**
 * Validate and place an order.
 * input: { name, phone, address, cash, items: [{ id, qty }], expected_total }
 * expected_total is what the customer was shown; if the menu or the fee has
 * changed since, the order is refused with the new prices instead of charging
 * an amount they never saw.
 */
function create(input) {
  const errors = {};

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter your full name.';
  else if (name.length > NAME_MAX) errors.name = `Keep your name under ${NAME_MAX} characters.`;

  const phone = normalisePhone(input.phone);
  const phoneDigits = phone.replace('+', '');
  if (!phoneDigits) errors.phone = 'Enter a phone number we can call.';
  else if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    errors.phone = 'That phone number does not look right.';
  }

  const address = String(input.address ?? '').trim();
  if (!address) errors.address = 'Enter the delivery address.';
  else if (address.length > ADDRESS_MAX) errors.address = `Keep the address under ${ADDRESS_MAX} characters.`;

  const cashRaw = input.cash;
  const cash = Number(cashRaw);
  const cashGiven = !(cashRaw === '' || cashRaw === null || cashRaw === undefined);
  if (!cashGiven) errors.cash = 'Enter how much cash you will pay with.';
  else if (!Number.isInteger(cash) || cash < 0 || cash > MAX_CASH) {
    errors.cash = 'Enter the cash as a whole number of pesos.';
  }

  let q = null;
  try {
    q = quote(input.items);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    Object.assign(errors, err.errors);
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  if (q.unavailable.length) {
    throw staleCart('Some items in your cart are no longer on the menu. They have been removed.', q);
  }
  if (q.lines.length === 0) throw new ValidationError({ items: 'Your cart is empty.' });
  if (Number(input.expected_total) !== q.total) {
    throw staleCart('Prices have changed since you opened the menu. Check the new total and place your order again.', q);
  }
  if (cash < q.total) {
    throw new ValidationError({ cash: `The total is Php ${q.total}, so the cash must be at least that.` });
  }

  const id = transaction(() => {
    const info = db.prepare(`
      INSERT INTO orders (customer_name, phone, address, subtotal, delivery_fee, total, cash, change_due)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      name, phone, address, q.subtotal, q.delivery_fee, q.total, cash, cash - q.total);
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
  STATUSES, getDeliveryFee, setDeliveryFee, getMessengerPage, setMessengerPage,
  parseMessengerPage, settings, updateSettings, normalisePhone,
  quote, create, get, list, counts, setStatus,
};
