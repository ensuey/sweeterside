'use strict';
/* POS orders: tickets a cashier or waiter builds on the counter tablet.

   A ticket is saved as an order with source 'pos'. Until Send to kitchen it
   is held (a saved tab): the kitchen does not see it, but it counts against
   the day's item limits. Send to kitchen puts it in the order queue as
   Confirmed (staff took it in person, so there is nobody to call back).
   More items can be added to a tab later and sent again.

   Every save sends the whole ticket. The server works out what changed:
     - units not yet sent can be added or taken off freely;
     - taking off a unit already sent is a void, which needs the owner (or an
       owner's PIN) and a reason;
     - a price change needs the owner and a reason;
     - discounts, SC/PWD, the service charge and the delivery fee need the
       right role, and a manual discount above the cashier limit needs the
       owner.
   Anything the staff member may not do on their own is listed in one 403
   (override_required) and the screen asks for an owner's PIN, then sends
   the same save again with { override: { staff_id, pin } }.

   Prices come from the menu when a line is added and are kept on the line,
   so a tab is not repriced when the menu changes; the order is priced with
   the shared engine (pricing.js) on every save. Nothing here checks whether
   the shop is open: that switch is for online orders only. */

const { db, transaction } = require('./db');
const menu = require('./menu');
const orders = require('./orders');
const vouchers = require('./vouchers');
const pricing = require('./pricing');
const settings = require('./settings');
const staff = require('./staff');
const audit = require('./audit');
const { normalizePhPhone, PHONE_MESSAGE } = require('./phone');

const { ValidationError } = menu;

const TYPES = orders.ORDER_TYPES;
const NAME_MAX = 80;
const TABLE_MAX = 10;
const ADDRESS_MAX = 400;
const LANDMARK_MAX = 200;
const NOTE_MAX = 120;
const REASON_MAX = 200;
const MAX_LINES = 60;
const MAX_QTY = 99;
const MAX_PAX = 50;
const MAX_PRICE_CENTS = 100000 * 100;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, body: { error: message, ...extra } });

const text = (raw, max) => String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

/** Pesos (up to two decimals) -> centavos, or NaN. */
function pesosToCents(raw) {
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) return NaN;
  const cents = Math.round(n * 100);
  return Math.abs(n * 100 - cents) < 1e-6 ? cents : NaN;
}

/* ---------------------------- reading ---------------------------- */

function lineRows(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
}

function loadOrder(id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ? AND source = 'pos'").get(Number(id));
  if (!row) return null;
  return { ...row, lines: lineRows(row.id), input: row.pos_input ? JSON.parse(row.pos_input) : {} };
}

/**
 * A POS order as the tablet shows it: the order (with peso fields and the
 * pricing breakdown), every line with its sent and voided units, what the
 * cashier entered, and the version to send back with the next save.
 * SC/PWD ID numbers are in full only for roles that may see them.
 */
function view(id, actor) {
  const fullIds = staff.can(actor.role, 'see_id_numbers');
  const order = orders.get(id, { fullIds });
  if (!order || order.source !== 'pos') return null;
  const row = loadOrder(id);
  const input = JSON.parse(JSON.stringify(row.input));
  if (!fullIds && input.claimants) input.claimants.forEach((c) => { c.id_no = pricing.maskId(c.id_no); });
  const lines = row.lines.map((l) => ({
    id: l.id, key: String(l.id), item_id: l.item_id, name: l.name, note: l.note,
    qty: l.qty - l.voided_qty, sent_qty: l.sent_qty, voided_qty: l.voided_qty, void_reason: l.void_reason,
    unit_cents: l.override_cents ?? l.menu_sale_cents ?? l.price_cents,
    menu_price_cents: l.menu_price_cents ?? l.regular_price_cents,
    override_cents: l.override_cents, override_reason: l.override_reason,
    net_cents: l.net_cents, sc_eligible: l.sc_eligible === 1,
  }));
  const people = db.prepare('SELECT id, name FROM staff WHERE id IN (?, ?)').all(row.staff_id, row.updated_by);
  const nameOf = (sid) => (people.find((p) => p.id === sid) || {}).name || '';
  return {
    ...order, items: undefined, lines, input, version: row.pos_version,
    held: !row.kitchen_sent_at, paid: !!row.paid_at,
    taken_by: nameOf(row.staff_id), updated_by_name: nameOf(row.updated_by),
  };
}

/** Unpaid POS orders still going: the open tabs, and takeout or delivery waiting to pay. */
function open() {
  return db.prepare(`
    SELECT o.id, o.order_type, o.table_no, o.pax, o.customer_name, o.total_cents, o.status,
           o.kitchen_sent_at, o.created_at, o.updated_at, o.pos_version, s.name AS taken_by,
           (SELECT COALESCE(SUM(qty - voided_qty), 0) FROM order_items WHERE order_id = o.id) AS units,
           (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND qty > sent_qty) AS unsent_lines
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id
    WHERE o.source = 'pos' AND o.paid_at IS NULL AND o.status NOT IN ('cancelled', 'completed')
    ORDER BY o.order_type = 'dinein' DESC, o.table_no, o.id`).all()
    .map((o) => ({ ...o, total: o.total_cents / 100, held: !o.kitchen_sent_at }));
}

/** The menu for the item grid: everything not hidden, with today's stock. */
function posMenu() {
  return menu.list().filter((i) => i.availability !== 'unavailable').map((i) => ({
    id: i.id, name: i.name, category_id: i.category_id, image: i.image, alt: i.alt,
    crop_x: i.crop_x, crop_y: i.crop_y, crop_w: i.crop_w, crop_h: i.crop_h,
    price: i.price, sale_price: i.sale_price, sold_out: i.sold_out, remaining: i.remaining,
    sc_eligible: i.sc_eligible, best_seller: i.best_seller,
  }));
}

/* ---------------------------- parsing a ticket ---------------------------- */

function parseMeta(body, errors) {
  const type = String(body.type ?? '');
  if (!TYPES.includes(type)) errors.type = 'Choose dine-in, takeout or delivery.';
  const meta = {
    type, table_no: '', pax: null, customer_name: '', phone: '', phone_norm: null, address: '', landmark: '',
  };
  meta.customer_name = text(body.customer_name, NAME_MAX);
  if (meta.customer_name.length > NAME_MAX) errors.customer_name = `Keep the name under ${NAME_MAX} characters.`;

  if (type === 'dinein') {
    meta.table_no = text(body.table_no, TABLE_MAX);
    if (!meta.table_no) errors.table_no = 'Enter the table number.';
    else if (meta.table_no.length > TABLE_MAX) errors.table_no = `Keep the table under ${TABLE_MAX} characters.`;
    if (body.pax !== undefined && body.pax !== null && body.pax !== '') {
      const pax = Number(body.pax);
      if (!Number.isInteger(pax) || pax < 1 || pax > MAX_PAX) errors.pax = `Enter 1 to ${MAX_PAX} guests.`;
      else meta.pax = pax;
    }
  }
  if (type === 'delivery') {
    if (!meta.customer_name) errors.customer_name = 'Enter the customer name.';
    meta.phone_norm = normalizePhPhone(body.phone);
    if (!String(body.phone ?? '').trim()) errors.phone = 'Enter a phone number the rider can call.';
    else if (!meta.phone_norm) errors.phone = PHONE_MESSAGE;
    else meta.phone = orders.normalisePhone(body.phone);
    meta.address = String(body.address ?? '').trim();
    if (!meta.address) errors.address = 'Enter the delivery address.';
    else if (meta.address.length > ADDRESS_MAX) errors.address = `Keep the address under ${ADDRESS_MAX} characters.`;
    meta.landmark = text(body.landmark, LANDMARK_MAX);
    if (!meta.landmark) errors.landmark = 'Add a landmark or directions for the rider.';
    else if (meta.landmark.length > LANDMARK_MAX) errors.landmark = `Keep it under ${LANDMARK_MAX} characters.`;
  }
  return meta;
}

/** A price typed for a line, in pesos, or null for the menu price. */
function parsePrice(raw, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  const cents = pesosToCents(raw);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_PRICE_CENTS) {
    errors.lines = 'Enter the new price in pesos, with at most two decimals.';
    return null;
  }
  return cents;
}

/**
 * The cashier's discounts in pesos and percent, as the engine wants them:
 * centavos, basis points, and line keys mapped through `keyOf`.
 */
function parseDiscounts(raw, keyOf, errors, now) {
  const d = {
    voucher_code: vouchers.normaliseCode(raw.voucher_code), manual: null, claimants: [], diners: null,
    service_removed_reason: null, delivery_fee_cents: null, fee_reason: '',
  };
  let voucherRow = null;
  if (d.voucher_code) {
    try {
      voucherRow = vouchers.lookup(d.voucher_code, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      Object.assign(errors, err.errors);
    }
  }

  if (raw.manual) {
    const m = raw.manual;
    const manual = { kind: String(m.kind ?? ''), line: null, reason: text(m.reason, REASON_MAX) };
    if (manual.kind === 'percent') {
      const n = Number(m.value);
      manual.bp = Math.round(n * 100);
      if (!Number.isFinite(n) || manual.bp < 1 || manual.bp > 10000) errors.manual = 'Take between 0.01% and 100% off.';
    } else if (manual.kind === 'amount') {
      manual.cents = pesosToCents(m.value);
      if (!Number.isSafeInteger(manual.cents) || manual.cents < 1) errors.manual = 'Enter how many pesos to take off.';
    } else {
      errors.manual = 'Choose % off or Php off.';
    }
    if (m.line !== undefined && m.line !== null && m.line !== '') {
      manual.line = keyOf(String(m.line));
      if (!manual.line) errors.manual = 'That line is not on the ticket.';
    }
    d.manual = manual;
  }

  if (Array.isArray(raw.claimants)) {
    d.claimants = raw.claimants.map((c) => {
      const lines = {};
      for (const [k, q] of Object.entries(c.lines || {})) {
        const key = keyOf(String(k));
        if (!key) errors.claimants = 'A ticked item is not on the ticket.';
        else lines[key] = Number(q);
      }
      const idNo = String(c.id_no ?? '').trim();
      if (idNo.startsWith('****')) errors.claimants = 'Type the ID number again.';
      return {
        type: String(c.type ?? ''), name: String(c.name ?? ''), id_no: idNo,
        signature: c.signature === true, mode: String(c.mode ?? ''), lines,
      };
    });
    if (d.claimants.some((c) => c.mode === 'shared')) d.diners = Number(raw.diners);
  }

  if (raw.service_removed_reason !== undefined && raw.service_removed_reason !== null) {
    d.service_removed_reason = String(raw.service_removed_reason);
  }
  if (raw.delivery_fee !== undefined && raw.delivery_fee !== null && raw.delivery_fee !== '') {
    d.delivery_fee_cents = pesosToCents(raw.delivery_fee);
    if (!Number.isSafeInteger(d.delivery_fee_cents) || d.delivery_fee_cents < 0) {
      errors.delivery_fee = 'Enter the delivery fee in pesos.';
    }
    d.fee_reason = text(raw.fee_reason, REASON_MAX);
  }
  return { discounts: d, voucherRow };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// A manual discount compared without the approval kept with it.
const withoutApproval = (m) => (m ? { ...m, approved_bp: undefined } : m);

/** The share of its base a manual discount takes, in basis points, rounded up. */
function manualShareBp(manual) {
  if (!manual || !manual.base_cents) return 0;
  return Math.ceil((manual.discount * 10000) / manual.base_cents);
}

/* ---------------------------- pricing ---------------------------- */

/**
 * The engine input for an order's lines and discounts. `lines` are
 * { key, item_id, name, qty, menu_price_cents, menu_sale_cents,
 *   override_cents, override_reason, sc_eligible } with qty > 0.
 */
function engineInput(type, lines, d, voucherRow, actor, discountApproved) {
  const pos = settings.posSettings();
  return {
    type,
    tax: { vat_registered: pos.vat_registered },
    lines: lines.map((l) => ({
      key: l.key, item_id: l.item_id, name: l.name, qty: l.qty,
      unit_cents: l.menu_price_cents, sale_cents: l.menu_sale_cents, sc_eligible: l.sc_eligible,
      override_cents: l.override_cents, override_reason: l.override_reason,
    })),
    claimants: d.claimants || [],
    diners: d.diners,
    voucher: voucherRow,
    manual: d.manual || null,
    service: { ...pos.service_charge, removed_reason: d.service_removed_reason },
    delivery: { default_cents: orders.getDeliveryFee() * 100, cents: d.delivery_fee_cents, reason: d.fee_reason },
    // A manual discount the owner approved may stay at the share of the order
    // they approved (approved_bp); anything above that needs them again.
    limits: {
      manual_bp: actor.role === 'owner' ? 10000
        : Math.max(pos.cashier_discount_limit_bp, (d.manual && d.manual.approved_bp) || 0),
    },
    // Prices on the lines were approved when they were set. A manual discount
    // above the limit needs approving when it changes.
    override: { prices: true, discount: discountApproved },
  };
}

/** Engine errors as the screen shows them. */
function priceOrThrow(input) {
  try {
    return pricing.price(input);
  } catch (err) {
    if (!(err instanceof pricing.PricingError)) throw err;
    if (err.code === 'tax_unset') throw httpError(409, err.message, { code: 'tax_unset' });
    throw new ValidationError({ [err.field]: err.message });
  }
}

/* ---------------------------- planning a save ---------------------------- */

/**
 * Work out what a save would change, without writing anything.
 * @returns { meta, ops, voids, priceChanges, discounts, voucherRow, changed,
 *            needs (Set of permissions the actor lacks), priced, kitchenNew }
 * @throws {ValidationError}
 */
function plan(existing, body, actor, now = new Date(), { preview = false } = {}) {
  const errors = {};
  const needs = new Set();
  const need = (perm) => { if (!staff.can(actor.role, perm)) needs.add(perm); };

  // The running total is shown while the table or the customer is still being typed.
  const metaErrors = {};
  const meta = parseMeta(body, metaErrors);
  if (!preview) Object.assign(errors, metaErrors);
  else if (metaErrors.type) errors.type = metaErrors.type;
  if (meta.type && meta.type !== 'dinein') need('takeout_and_delivery');

  const raw = Array.isArray(body.lines) ? body.lines : null;
  if (!raw) errors.lines = 'The ticket has no lines.';
  else if (raw.length > MAX_LINES) errors.lines = 'That ticket has too many lines.';

  const old = existing ? existing.lines : [];
  const byId = new Map(old.map((l) => [l.id, l]));
  const keyMap = new Map(); // client key -> engine key
  const ops = [];
  const voids = [];
  const priceChanges = [];
  const increase = new Map(); // item_id -> extra units today
  const seen = new Set();
  const result = []; // the lines after the save, for the engine

  for (const l of raw || []) {
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
      errors.lines = `Quantities must be whole numbers up to ${MAX_QTY}.`;
      continue;
    }
    const note = text(l.note, NOTE_MAX);
    if (note.length > NOTE_MAX) errors.lines = `Keep notes under ${NOTE_MAX} characters.`;
    const override = parsePrice(l.price, errors);
    const overrideReason = text(l.price_reason, REASON_MAX);

    if (l.id !== undefined && l.id !== null) {
      const o = byId.get(Number(l.id));
      if (!o || seen.has(o.id)) {
        errors.lines = 'This ticket was changed somewhere else. Reload it.';
        continue;
      }
      seen.add(o.id);
      keyMap.set(String(l.key ?? o.id), String(o.id));
      keyMap.set(String(o.id), String(o.id));
      // The units the customer is charged for now, and what they want.
      let units = o.qty;
      let voided = o.voided_qty;
      const charged = units - voided;
      if (qty > charged) {
        if (o.item_id === null) errors.lines = `${o.name} is no longer on the menu; add it as a new line.`;
        else increase.set(o.item_id, (increase.get(o.item_id) || 0) + qty - charged);
        units += qty - charged;
      } else if (qty < charged) {
        const off = charged - qty;
        const unsent = units - o.sent_qty;
        const free = Math.min(off, unsent);
        units -= free;
        if (off > free) {
          voided += off - free;
          voids.push({ line: o, units: off - free, amount: (o.override_cents ?? o.menu_sale_cents ?? o.price_cents) * (off - free) });
        }
      }
      if (override !== o.override_cents) {
        if (override !== null) {
          need('price_override');
          if (!overrideReason) errors.lines = 'Give a reason for the price change.';
        }
        priceChanges.push({ line: o, from: o.override_cents, to: override, reason: overrideReason });
      }
      if (units === 0) ops.push({ op: 'delete', id: o.id });
      else {
        ops.push({ op: 'update', id: o.id, qty: units, voided_qty: voided, note, override_cents: override,
          override_reason: override === null ? '' : (override === o.override_cents ? o.override_reason : overrideReason) });
      }
      if (units - voided > 0) {
        result.push({
          key: String(o.id), item_id: o.item_id, name: o.name, qty: units - voided,
          menu_price_cents: o.menu_price_cents ?? o.regular_price_cents,
          menu_sale_cents: o.menu_sale_cents ?? o.price_cents,
          override_cents: override, override_reason: override === o.override_cents ? o.override_reason : overrideReason,
          sc_eligible: o.sc_eligible === 1,
        });
      }
    } else {
      if (qty === 0) continue;
      const key = String(l.key ?? '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || keyMap.has(key)) {
        errors.lines = 'Each new line needs its own key.';
        continue;
      }
      const item = menu.get(Number(l.item_id), { now });
      if (!item || item.availability === 'unavailable') {
        errors.lines = 'An item on the ticket is no longer on the menu.';
        continue;
      }
      const engineKey = `new-${key}`;
      keyMap.set(key, engineKey);
      increase.set(item.id, (increase.get(item.id) || 0) + qty);
      if (override !== null) {
        need('price_override');
        if (!overrideReason) errors.lines = 'Give a reason for the price change.';
        priceChanges.push({ line: { name: item.name }, from: null, to: override, reason: overrideReason });
      }
      const line = {
        key: engineKey, item_id: item.id, name: item.name, qty,
        menu_price_cents: item.price * 100, menu_sale_cents: item.sale_price * 100,
        override_cents: override, override_reason: override === null ? '' : overrideReason,
        sc_eligible: item.sc_eligible, note,
      };
      ops.push({ op: 'insert', clientKey: key, line });
      result.push(line);
    }
  }

  // Lines left off the ticket are taken off: free if never sent, a void if sent.
  for (const o of old) {
    if (seen.has(o.id) || o.qty === o.voided_qty) continue;
    if (raw) {
      const unsent = o.qty - o.sent_qty;
      const sentLeft = o.sent_qty - o.voided_qty;
      if (sentLeft > 0) {
        voids.push({ line: o, units: sentLeft, amount: (o.override_cents ?? o.menu_sale_cents ?? o.price_cents) * sentLeft });
        ops.push({ op: 'update', id: o.id, qty: o.qty - unsent, voided_qty: o.sent_qty, note: o.note,
          override_cents: o.override_cents, override_reason: o.override_reason });
      } else {
        ops.push({ op: 'delete', id: o.id });
      }
    }
  }

  // Today's limits, counting what this save adds.
  for (const [itemId, extra] of increase) {
    const item = menu.get(itemId, { now });
    if (!item || item.sold_out) errors.lines = `${item ? item.name : 'An item'} is sold out.`;
    else if (item.remaining !== null && extra > item.remaining) {
      errors.lines = `Only ${item.remaining} ${item.name} left today.`;
    }
  }

  const voidReason = text(body.void_reason, REASON_MAX);
  if (voids.length) {
    need('void');
    if (!voidReason && !preview) errors.void_reason = 'Give a reason for taking off items already sent to the kitchen.';
  }

  // Discounts: kept as they were unless the ticket sends new ones.
  const stored = existing ? existing.input : {};
  let discounts = {
    voucher_code: stored.voucher_code || '', manual: stored.manual || null, claimants: stored.claimants || [],
    diners: stored.diners ?? null, service_removed_reason: stored.service_removed_reason ?? null,
    delivery_fee_cents: stored.delivery_fee_cents ?? null, fee_reason: stored.fee_reason || '',
  };
  let voucherRow = null;
  const keyOf = (k) => keyMap.get(k) || null;
  if (body.discounts && typeof body.discounts === 'object') {
    const parsed = parseDiscounts(body.discounts, keyOf, errors, now);
    discounts = parsed.discounts;
    voucherRow = parsed.voucherRow;
  } else if (discounts.voucher_code) {
    try {
      voucherRow = vouchers.lookup(discounts.voucher_code, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      errors.voucher = `${err.errors.voucher} Remove the voucher to continue.`;
    }
  }

  const changed = {
    voucher: discounts.voucher_code !== (stored.voucher_code || ''),
    manual: !same(withoutApproval(discounts.manual), withoutApproval(stored.manual)),
    claimants: !same(discounts.claimants, stored.claimants || []) || !same(discounts.diners, stored.diners ?? null),
    service: discounts.service_removed_reason !== (stored.service_removed_reason ?? null),
    fee: discounts.delivery_fee_cents !== (stored.delivery_fee_cents ?? null),
  };
  // An unchanged discount keeps the share the owner approved, if any.
  if (!changed.manual && discounts.manual) discounts.manual.approved_bp = (stored.manual && stored.manual.approved_bp) || 0;
  if (changed.voucher) need('apply_voucher');
  if (changed.manual) need('manual_discount');
  if (changed.claimants) need('claim_sc_pwd');
  if (changed.service && discounts.service_removed_reason !== null) need('remove_service_charge');
  if (changed.fee) need('change_delivery_fee');

  if (!result.length) errors.lines = errors.lines || 'Add at least one item.';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  // Price it. A manual discount above the cashier limit (or above what the
  // owner approved) needs the owner: checked on every save against the order
  // as it is now, so taking items off cannot stretch a discount.
  let priced;
  try {
    priced = pricing.price(engineInput(meta.type, result, discounts, voucherRow, actor, false));
  } catch (err) {
    if (!(err instanceof pricing.PricingError) || err.code !== 'override_required' || err.field !== 'manual') {
      priceOrThrow(engineInput(meta.type, result, discounts, voucherRow, actor, false));
    }
    needs.add('discount_over_limit');
    priced = priceOrThrow(engineInput(meta.type, result, discounts, voucherRow, actor, true));
  }

  return { meta, ops, voids, voidReason, priceChanges, discounts, voucherRow, changed, needs, priced, keyMap };
}

/**
 * The owner approval a save needs, if any. One owner PIN covers everything
 * on the save. @returns the approving owner, or null when none was needed.
 */
function approve(actor, needs, override) {
  if (!needs.size) return null;
  const list = [...needs];
  if (!override || override.staff_id === undefined) {
    throw httpError(403, 'This needs a manager: ask the owner to enter their PIN.', { override_required: true, needs: list });
  }
  const approver = staff.verifyPin(override.staff_id, override.pin);
  const missing = list.filter((p) => !staff.can(approver.role, p));
  if (missing.length) {
    throw httpError(403, `${approver.name} cannot approve this. Ask the owner.`, { override_required: true, needs: list });
  }
  return approver;
}

/* ---------------------------- saving ---------------------------- */

function checkRequestKey(key) {
  if (!KEY_RE.test(String(key ?? ''))) throw new ValidationError({ request_key: 'Missing request key. Reload the POS.' });
  const done = db.prepare('SELECT id FROM orders WHERE last_request_key = ?').get(String(key));
  return done ? done.id : null;
}

function insertLine(orderId, l) {
  return db.prepare(`
    INSERT INTO order_items (order_id, item_id, name, price_cents, regular_price_cents, net_cents, qty, note,
                             menu_price_cents, menu_sale_cents, override_cents, override_reason, sc_eligible)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(
    orderId, l.item_id, l.name, l.menu_sale_cents, l.menu_price_cents, l.qty, l.note,
    l.menu_price_cents, l.menu_sale_cents, l.override_cents, l.override_reason, l.sc_eligible ? 1 : 0,
  ).lastInsertRowid;
}

/** Engine lines from what is saved now (keys are line ids). */
function savedEngineLines(orderId) {
  return lineRows(orderId).filter((l) => l.qty > l.voided_qty).map((l) => ({
    key: String(l.id), item_id: l.item_id, name: l.name, qty: l.qty - l.voided_qty,
    menu_price_cents: l.menu_price_cents ?? l.regular_price_cents,
    menu_sale_cents: l.menu_sale_cents ?? l.price_cents,
    override_cents: l.override_cents, override_reason: l.override_reason, sc_eligible: l.sc_eligible === 1,
  }));
}

/** Write the engine's result onto the order and its lines. */
function writePricing(orderId, priced) {
  const t = priced.totals;
  db.prepare(`
    UPDATE orders SET gross_cents = ?, subtotal_cents = ?, discount_cents = ?, sc_pwd_discount_cents = ?,
      vat_exempt_cents = ?, manual_discount_cents = ?, service_charge_cents = ?, delivery_fee_cents = ?,
      total_cents = ?, voucher_code = ?, pricing = ?
    WHERE id = ?`).run(
    t.gross, t.subtotal, t.voucher_discount, t.sc_pwd_discount, t.vat_exempt, t.manual_discount,
    t.service_charge, t.delivery_fee, t.total, priced.voucher ? priced.voucher.code : '', JSON.stringify(priced), orderId);
  const update = db.prepare('UPDATE order_items SET price_cents = ?, regular_price_cents = ?, net_cents = ? WHERE id = ?');
  for (const l of priced.lines) update.run(l.sale_unit_cents, l.unit_cents, l.net, Number(l.key));
  // Fully voided lines are charged nothing.
  db.prepare('UPDATE order_items SET net_cents = 0 WHERE order_id = ? AND qty = voided_qty').run(orderId);
}

/**
 * Create (id null) or update a POS order from the whole ticket.
 * body: { request_key, version, type, table_no, pax, customer_name, phone, address, landmark,
 *         lines: [{ id?, key, item_id, qty, note, price?, price_reason? }],
 *         discounts?: { voucher_code, manual, claimants, diners, service_removed_reason,
 *                       delivery_fee, fee_reason },
 *         void_reason, override: { staff_id, pin }, send }
 * @returns {{ order, kitchen, replayed }} kitchen: the units this save sent
 */
function save(id, body, actor, now = new Date()) {
  const done = checkRequestKey(body.request_key);
  if (done) return { order: view(done, actor), kitchen: [], replayed: true };

  if (!staff.can(actor.role, 'take_orders')) throw httpError(403, 'You cannot take orders.');
  const existing = id === null ? null : loadOrder(id);
  if (id !== null) {
    if (!existing) throw httpError(404, 'That order is not a POS order or no longer exists.');
    if (existing.paid_at) throw httpError(409, 'This order is paid. Refund it instead of changing it.');
    if (paidCents(existing.id)) throw httpError(409, 'Payment has started on this order. Finish taking payment first.');
    if (['cancelled', 'completed'].includes(existing.status)) throw httpError(409, 'This order is closed.');
    if (Number(body.version) !== existing.pos_version) {
      throw httpError(409, 'This order was changed on another device. Reload it to see the changes.', { stale: true });
    }
  }

  const p = plan(existing, body, actor, now);
  const approver = approve(actor, p.needs, body.override);
  const send = body.send === true;

  const result = transaction(() => {
    let orderId = id;
    if (orderId === null) {
      orderId = db.prepare(`
        INSERT INTO orders (source, order_type, status, customer_name, phone, address, subtotal_cents,
                            delivery_fee_cents, total_cents, cash_cents, change_due_cents, staff_id)
        VALUES ('pos', ?, 'new', '', '', '', 0, 0, 0, 0, 0, ?)`).run(p.meta.type, actor.id).lastInsertRowid;
    }

    const newIds = new Map();
    for (const op of p.ops) {
      if (op.op === 'insert') newIds.set(`new-${op.clientKey}`, String(insertLine(orderId, op.line)));
      else if (op.op === 'delete') db.prepare('DELETE FROM order_items WHERE id = ?').run(op.id);
      else {
        db.prepare(`UPDATE order_items SET qty = ?, voided_qty = ?, note = ?, override_cents = ?, override_reason = ?,
                      void_reason = CASE WHEN voided_qty <> ? THEN ? ELSE void_reason END WHERE id = ?`)
          .run(op.qty, op.voided_qty, op.note, op.override_cents, op.override_reason,
            op.voided_qty, p.voidReason, op.id);
      }
    }

    // Discounts point at lines by key; new lines now have ids.
    const rekey = (k) => newIds.get(k) || k;
    const d = JSON.parse(JSON.stringify(p.discounts));
    if (d.manual && d.manual.line) d.manual.line = rekey(d.manual.line);
    for (const c of d.claimants) c.lines = Object.fromEntries(Object.entries(c.lines).map(([k, q]) => [rekey(k), q]));

    const priced = priceOrThrow(engineInput(p.meta.type, savedEngineLines(orderId), d, p.voucherRow, actor, true));
    writePricing(orderId, priced);
    // Keep the share of the order the owner approved (or gave), so later saves
    // can hold it there without asking again, but not stretch it.
    const ownerApproved = actor.role === 'owner' || p.needs.has('discount_over_limit');
    if (d.manual && ownerApproved) d.manual.approved_bp = manualShareBp(priced.manual);
    else if (d.manual && !d.manual.approved_bp) delete d.manual.approved_bp;

    const prevVersion = existing ? existing.pos_version : -1;
    db.prepare(`
      UPDATE orders SET order_type = ?, table_no = ?, pax = ?, customer_name = ?, phone = ?, phone_norm = ?,
        address = ?, landmark = ?, pos_input = ?, last_request_key = ?, pos_version = ?, updated_by = ?,
        updated_at = datetime('now')
      WHERE id = ?`).run(
      p.meta.type, p.meta.table_no, p.meta.pax, p.meta.customer_name, p.meta.phone, p.meta.phone_norm,
      p.meta.address, p.meta.landmark, JSON.stringify(d), String(body.request_key), prevVersion + 1, actor.id, orderId);

    // What goes to the kitchen now: units added since the last send.
    const kitchen = send ? sendToKitchen(orderId) : [];

    // The audit trail for anything that moved money or needed a manager.
    const by = { staff: actor, approver, order_id: orderId };
    for (const v of p.voids) {
      audit.record({ ...by, action: 'void', amount_cents: v.amount, reason: p.voidReason,
        details: { line: v.line.name, units: v.units } });
    }
    for (const c of p.priceChanges) {
      audit.record({ ...by, action: 'price_change', reason: c.reason,
        details: { line: c.line.name, from_cents: c.from, to_cents: c.to } });
    }
    if ((p.changed.manual || p.needs.has('discount_over_limit')) && priced.manual) {
      audit.record({ ...by, action: 'manual_discount', amount_cents: priced.manual.discount, reason: priced.manual.reason,
        details: { kind: priced.manual.kind, bp: priced.manual.bp, cents: priced.manual.cents, line: priced.manual.line } });
    }
    if (p.changed.service && priced.service.removed_reason) {
      audit.record({ ...by, action: 'service_charge_removed', reason: priced.service.removed_reason,
        amount_cents: roundServiceCharge(priced) });
    }
    if (p.changed.fee && priced.delivery.reason) {
      audit.record({ ...by, action: 'delivery_fee_changed', amount_cents: priced.delivery.amount, reason: priced.delivery.reason,
        details: { default_cents: priced.delivery.default_cents } });
    }
    if (approver) {
      audit.record({ ...by, action: 'override', details: { permissions: [...p.needs] } });
    }
    return { orderId, kitchen };
  });

  return { order: view(result.orderId, actor), kitchen: result.kitchen, replayed: false };
}

/**
 * Send what the kitchen has not seen yet: every unit added since the last
 * send. The order joins the queue as Confirmed the first time.
 * @returns [{ name, qty, note }] the units sent now
 */
function sendToKitchen(orderId) {
  const kitchen = lineRows(orderId).filter((l) => l.qty > l.sent_qty)
    .map((l) => ({ name: l.name, qty: l.qty - l.sent_qty, note: l.note }));
  db.prepare('UPDATE order_items SET sent_qty = qty WHERE order_id = ?').run(orderId);
  db.prepare(`UPDATE orders SET kitchen_sent_at = COALESCE(kitchen_sent_at, datetime('now')),
                status = CASE WHEN status = 'new' THEN 'confirmed' ELSE status END WHERE id = ?`).run(orderId);
  return kitchen;
}

/** Centavos paid towards an order so far. */
function paidCents(orderId) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE order_id = ?').get(orderId).n;
}

/** The service charge that was removed, for the audit log. */
function roundServiceCharge(priced) {
  return pricing.roundDiv(priced.service.base_cents * priced.service.rate_bp, 10000);
}

/**
 * Price a ticket without saving it, for the running total on screen.
 * @returns {{ pricing, needs, voids }} needs: what an owner would have to approve;
 *   voids: the sent units this would take off, which need a reason
 */
function quote(id, body, actor, now = new Date()) {
  const existing = id === null ? null : loadOrder(id);
  if (id !== null && !existing) throw httpError(404, 'That order no longer exists.');
  const p = plan(existing, body, actor, now, { preview: true });
  return {
    pricing: p.priced, needs: [...p.needs],
    voids: p.voids.map((v) => ({ line_id: v.line.id, name: v.line.name, units: v.units, amount_cents: v.amount })),
  };
}

/* ---------------------------- tabs ---------------------------- */

function openOrder(id) {
  const o = loadOrder(id);
  if (!o) throw httpError(404, 'That order is not a POS order or no longer exists.');
  if (o.paid_at) throw httpError(409, 'This order is paid.');
  if (['cancelled', 'completed'].includes(o.status)) throw httpError(409, 'This order is closed.');
  return o;
}

/** Move a tab to another table. */
function moveTable(id, tableNo, actor) {
  const o = openOrder(id);
  if (o.order_type !== 'dinein') throw new ValidationError({ table_no: 'Only dine-in orders have a table.' });
  const table = text(tableNo, TABLE_MAX);
  if (!table || table.length > TABLE_MAX) throw new ValidationError({ table_no: 'Enter the new table number.' });
  db.prepare(`UPDATE orders SET table_no = ?, pos_version = pos_version + 1, updated_by = ?, updated_at = datetime('now')
              WHERE id = ?`).run(table, actor.id, o.id);
  return view(o.id, actor);
}

/**
 * Merge tab `id` into tab `intoId`: its lines (sent, voided, notes and
 * prices as they are) move across, and it is closed. A tab with discounts or
 * SC/PWD claims cannot be merged: remove them first, then add them again on
 * the merged tab.
 */
function merge(id, intoId, actor) {
  if (Number(id) === Number(intoId)) throw new ValidationError({ into: 'Choose another table to merge into.' });
  const from = openOrder(id);
  const into = openOrder(intoId);
  if (from.order_type !== 'dinein' || into.order_type !== 'dinein') {
    throw new ValidationError({ into: 'Only dine-in tabs can be merged.' });
  }
  const hasDiscounts = (o) => o.input.voucher_code || o.input.manual || (o.input.claimants || []).length;
  if (hasDiscounts(from)) {
    throw new ValidationError({ into: `Table ${from.table_no} has discounts. Remove them, merge, then add them on the merged tab.` });
  }
  return transaction(() => {
    db.prepare('UPDATE order_items SET order_id = ? WHERE order_id = ?').run(into.id, from.id);
    db.prepare(`UPDATE orders SET status = 'cancelled', cancel_reason = 'other', merged_into = ?, gross_cents = 0,
                  subtotal_cents = 0, discount_cents = 0, sc_pwd_discount_cents = 0, vat_exempt_cents = 0,
                  manual_discount_cents = 0, service_charge_cents = 0, delivery_fee_cents = 0, total_cents = 0,
                  pricing = '', pos_version = pos_version + 1, updated_by = ?, updated_at = datetime('now')
                WHERE id = ?`).run(into.id, actor.id, from.id);
    const priced = priceOrThrow(engineInput('dinein', savedEngineLines(into.id), into.input,
      into.input.voucher_code ? vouchers.lookup(into.input.voucher_code) : null, actor, true));
    writePricing(into.id, priced);
    const pax = (from.pax || 0) + (into.pax || 0) || null;
    // If either was already in the kitchen, the merged tab is too.
    db.prepare(`UPDATE orders SET pax = ?, pos_version = pos_version + 1, updated_by = ?, updated_at = datetime('now'),
                  kitchen_sent_at = COALESCE(kitchen_sent_at, ?),
                  status = CASE WHEN ? IS NOT NULL AND status = 'new' THEN 'confirmed' ELSE status END
                WHERE id = ?`).run(pax, actor.id, from.kitchen_sent_at, from.kitchen_sent_at, into.id);
    return view(into.id, actor);
  });
}

/**
 * Cancel an unpaid POS order. One never sent to the kitchen is simply
 * discarded; one the kitchen has seen is a void, which needs the owner and a
 * reason.
 */
function voidOrder(id, body, actor) {
  const o = openOrder(id);
  if (paidCents(o.id)) throw httpError(409, 'Part of this order is paid. Refund the payments before voiding it.');
  const sent = o.lines.some((l) => l.sent_qty > 0);
  const reason = text(body.reason, REASON_MAX);
  let approver = null;
  if (sent) {
    if (!reason) throw new ValidationError({ reason: 'Give a reason for voiding this order.' });
    approver = approve(actor, staff.can(actor.role, 'void') ? new Set() : new Set(['void']), body.override);
  }
  transaction(() => {
    db.prepare(`UPDATE orders SET status = 'cancelled', cancel_reason = 'other', pos_version = pos_version + 1,
                  updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(actor.id, o.id);
    if (sent) {
      audit.record({ action: 'void', staff: actor, approver, order_id: o.id, amount_cents: o.total_cents, reason,
        details: { whole_order: true } });
      if (approver) audit.record({ action: 'override', staff: actor, approver, order_id: o.id, details: { permissions: ['void'] } });
    }
  });
  return { ok: true, discarded: !sent };
}

module.exports = {
  KEY_RE, view, open, posMenu, plan, quote, save, moveTable, merge, voidOrder, loadOrder,
  sendToKitchen, paidCents, lineRows, httpError,
};
