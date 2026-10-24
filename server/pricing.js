'use strict';
/* The pricing engine, shared by the online checkout and the POS.

   Pure functions: no database, no clock. The caller looks up prices, the
   voucher and the settings, and passes them in; the engine returns a full
   breakdown (per line, per SC/PWD claimant, and totals) that is saved with
   the order and printed on the receipt.

   Every amount is an integer number of centavos. Rounding is half-up and
   happens only at these points (see claude/pos-plan.md):
     R2  percent voucher            -> whole peso (as the checkout always did)
     R3  shared SC/PWD portion      -> centavo
     R4  SC/PWD VAT base, then 20%  -> centavo, each step
     R5  manual percent discount    -> centavo
     R6  service charge             -> centavo
     R7  spreading an order-level amount over lines -> largest remainder,
         so the parts always add up to the whole
   (R1, sale prices, are whole pesos and worked out in menu.js.)

   Order of operations:
     1. line price: regular, sale price, or a manager-approved override
     2. SC/PWD on the claimants' portions
     3. a voucher OR a manual discount, on what SC/PWD does not cover
     4. service charge
     5. delivery fee
     6. total
   Invariant: sum of line nets + service charge + delivery fee = total. */

/* An SC/PWD claimant's portion is priced two ways: the 20% discount on the
   regular price, and the sale price less that portion's share of the voucher
   or manual discount. 'best_for_customer' gives the claimant whichever is
   lower (a tie goes to SC/PWD); 'always_sc_pwd' always uses SC/PWD. Either
   way the SC/PWD portion never also gets a sale price, voucher or manual
   discount. */
const SC_PWD_POLICY = 'best_for_customer';

const SC_PWD_RATE_PCT = 20;
const VAT_RATE_PCT = 12;
const CLAIMANT_TYPES = ['sc', 'pwd'];
const CLAIM_MODES = ['exclusive', 'shared'];
const MANUAL_KINDS = ['percent', 'amount'];
const SERVICE_BASES = ['after_discounts', 'before_discounts'];

const NAME_MAX = 80;
const ID_MAX = 40;
const REASON_MAX = 200;
const MAX_QTY = 999;
const MAX_DINERS = 100;

class PricingError extends Error {
  /** field: what the message is about. code: 'invalid', or why it was refused. */
  constructor(field, message, code = 'invalid') {
    super(message);
    this.name = 'PricingError';
    this.field = field;
    this.code = code;
  }
}

/* ---------------------------- arithmetic ---------------------------- */

/** num / den rounded half-up, for integers with den > 0. */
function roundDiv(num, den) {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new TypeError(`roundDiv needs integers, got ${num} / ${den}`);
  }
  if (num < 0) return -roundDiv(-num, den);
  return Math.floor((2 * num + den) / (2 * den));
}

/**
 * Split `total` into parts in proportion to `weights`, by largest remainder,
 * so the parts are whole centavos and add up to exactly `total`. Ties go to
 * the earlier weight. With no weight at all, everything goes to the first part.
 */
function allocate(total, weights) {
  const parts = weights.map(() => 0);
  if (!weights.length || total === 0) return parts;
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum === 0) {
    parts[0] = total;
    return parts;
  }
  // BigInt: total × weight can pass 2^53 on large orders.
  const T = BigInt(total);
  const S = BigInt(sum);
  const rems = weights.map((w, i) => {
    const raw = T * BigInt(w);
    parts[i] = Number(raw / S);
    return { rem: raw % S, i };
  });
  let left = total - parts.reduce((a, p) => a + p, 0);
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : (b.rem > a.rem ? 1 : -1)));
  for (let k = 0; left > 0; k++, left--) parts[rems[k].i] += 1;
  return parts;
}

const sum = (xs) => xs.reduce((a, x) => a + x, 0);

/* ---------------------------- the parts ---------------------------- */

/**
 * Centavos a voucher takes off `base`. A percentage is rounded to the whole
 * peso (R2) and capped at max_off pesos; never more than the base.
 * voucher: { kind: 'percent'|'amount', value, max_off } with pesos, as stored.
 */
function voucherDiscount(voucher, base) {
  if (!voucher || base <= 0) return 0;
  let off = voucher.kind === 'percent'
    ? roundDiv(base * voucher.value, 10000) * 100
    : voucher.value * 100;
  if (voucher.kind === 'percent' && voucher.max_off) off = Math.min(off, voucher.max_off * 100);
  return Math.max(0, Math.min(base, off));
}

/**
 * SC/PWD on `amount` centavos at the regular price.
 * Non-VAT: 20% off. VAT-registered: the VAT comes off first (amount / 1.12),
 * then 20% off what is left; the two are kept apart (R4).
 * @returns {{ vat_exempt, discount, net }}
 */
function scPwdPrice(amount, vatRegistered) {
  if (vatRegistered) {
    const base = roundDiv(amount * 100, 100 + VAT_RATE_PCT);
    const discount = roundDiv(base * SC_PWD_RATE_PCT, 100);
    return { vat_exempt: amount - base, discount, net: base - discount };
  }
  const discount = roundDiv(amount * SC_PWD_RATE_PCT, 100);
  return { vat_exempt: 0, discount, net: amount - discount };
}

/** Centavos a manual discount takes off `base` (R5), never more than the base. */
function manualAmount(manual, base) {
  if (!manual || base <= 0) return 0;
  const off = manual.kind === 'percent' ? roundDiv(base * manual.bp, 10000) : manual.cents;
  return Math.min(base, off);
}

/** '****1234': an SC/PWD ID number as lists and screens show it. */
function maskId(id) {
  const s = String(id ?? '');
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/* ---------------------------- input checks ---------------------------- */

const isInt = (n, min, max) => Number.isSafeInteger(n) && n >= min && (max === undefined || n <= max);

function text(raw, max) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);
}

function reasonOf(raw, field, what) {
  const reason = text(raw, REASON_MAX);
  if (!reason) throw new PricingError(field, `Give a reason for ${what}.`, 'reason_required');
  if (reason.length > REASON_MAX) throw new PricingError(field, `Keep the reason under ${REASON_MAX} characters.`);
  return reason;
}

function normaliseLines(raw, override) {
  if (!Array.isArray(raw) || raw.length === 0) throw new PricingError('items', 'The order has no items.');
  const keys = new Set();
  return raw.map((l, i) => {
    const key = String(l.key ?? i);
    if (keys.has(key)) throw new PricingError('items', 'Two lines have the same key.');
    keys.add(key);
    if (!isInt(l.qty, 1, MAX_QTY)) throw new PricingError('items', `Quantities must be whole numbers from 1 to ${MAX_QTY}.`);
    if (!isInt(l.unit_cents, 0)) throw new PricingError('items', 'A line has no valid price.');
    let sale = l.sale_cents === undefined || l.sale_cents === null ? l.unit_cents : l.sale_cents;
    if (!isInt(sale, 0, l.unit_cents)) throw new PricingError('items', 'A sale price must be between 0 and the full price.');

    let unit = l.unit_cents;
    let priceOverride = null;
    if (l.override_cents !== undefined && l.override_cents !== null) {
      if (!isInt(l.override_cents, 0)) throw new PricingError('items', 'Enter the new price in pesos.');
      if (!override) throw new PricingError('items', 'Changing a price needs a manager override.', 'override_required');
      priceOverride = { from_cents: l.unit_cents, reason: reasonOf(l.override_reason, 'items', 'the price change') };
      // An overridden price is the price: no sale on top of it.
      unit = l.override_cents;
      sale = l.override_cents;
    }
    return {
      key, item_id: l.item_id ?? null, name: String(l.name ?? ''), qty: l.qty,
      unit, sale, sc_eligible: l.sc_eligible !== false, price_override: priceOverride,
    };
  });
}

function normaliseClaimants(raw, lines, diners, tax) {
  if (!Array.isArray(raw)) throw new PricingError('claimants', 'SC/PWD claimants must be a list.');
  if (!raw.length) return { claimants: [], diners: null };
  if (typeof tax.vat_registered !== 'boolean') {
    throw new PricingError('claimants',
      'Set whether the shop is VAT-registered in Tax settings before giving SC/PWD discounts.', 'tax_unset');
  }
  const index = new Map(lines.map((l, i) => [l.key, i]));
  const claimed = lines.map(() => 0);
  const claimants = raw.map((c, n) => {
    const type = String(c.type ?? '');
    if (!CLAIMANT_TYPES.includes(type)) throw new PricingError('claimants', 'Choose Senior Citizen or PWD.');
    const name = text(c.name, NAME_MAX);
    if (!name) throw new PricingError('claimants', 'Enter the full name on the ID.');
    if (name.length > NAME_MAX) throw new PricingError('claimants', `Keep the name under ${NAME_MAX} characters.`);
    const idNo = text(c.id_no, ID_MAX);
    if (!idNo) throw new PricingError('claimants', `Enter the ${type === 'sc' ? 'OSCA' : 'PWD'} ID number.`);
    if (idNo.length > ID_MAX) throw new PricingError('claimants', `Keep the ID number under ${ID_MAX} characters.`);
    const mode = String(c.mode ?? '');
    if (!CLAIM_MODES.includes(mode)) throw new PricingError('claimants', 'Choose their own items or a shared order.');

    const own = {};
    if (mode === 'exclusive') {
      const entries = Object.entries(c.lines || {});
      if (!entries.length) throw new PricingError('claimants', 'Tick the items that are theirs.');
      for (const [key, qty] of entries) {
        const i = index.get(String(key));
        if (i === undefined) throw new PricingError('claimants', 'A ticked item is not on the order.');
        if (!lines[i].sc_eligible) throw new PricingError('claimants', `${lines[i].name} does not get the SC/PWD discount.`);
        if (!isInt(qty, 1, MAX_QTY)) throw new PricingError('claimants', 'Ticked quantities must be whole numbers.');
        claimed[i] += qty;
        if (claimed[i] > lines[i].qty) {
          throw new PricingError('claimants', `More ${lines[i].name} ticked than are on the order.`);
        }
        own[lines[i].key] = qty;
      }
    }
    return {
      n, type, name, id_no: idNo, signature: c.signature === true, mode, lines: own,
    };
  });

  const shared = claimants.filter((c) => c.mode === 'shared').length;
  let d = null;
  if (shared) {
    d = diners;
    if (!isInt(d, 1, MAX_DINERS)) throw new PricingError('diners', 'Enter how many people are sharing.');
    if (shared > d) throw new PricingError('diners', 'There are more claimants sharing than diners.');
  }
  return { claimants, diners: d, claimed };
}

function normaliseManual(raw, lines) {
  if (!raw) return null;
  const kind = String(raw.kind ?? '');
  if (!MANUAL_KINDS.includes(kind)) throw new PricingError('manual', 'Choose % off or Php off.');
  const manual = { kind, bp: null, cents: null, line: null };
  if (kind === 'percent') {
    if (!isInt(raw.bp, 1, 10000)) throw new PricingError('manual', 'Take between 0.01% and 100% off.');
    manual.bp = raw.bp;
  } else {
    if (!isInt(raw.cents, 1)) throw new PricingError('manual', 'Enter how many pesos to take off.');
    manual.cents = raw.cents;
  }
  if (raw.line !== undefined && raw.line !== null && raw.line !== '') {
    const key = String(raw.line);
    if (!lines.some((l) => l.key === key)) throw new PricingError('manual', 'That line is not on the order.');
    manual.line = key;
  }
  manual.reason = reasonOf(raw.reason, 'manual', 'the discount');
  return manual;
}

/* ---------------------------- the engine ---------------------------- */

/**
 * Price an order.
 * input: {
 *   type: 'delivery'|'pickup'|'dinein',
 *   lines: [{ key, item_id, name, qty, unit_cents, sale_cents?, sc_eligible?,
 *             override_cents?, override_reason? }],
 *   tax: { vat_registered: true|false },        // anything else refuses SC/PWD
 *   claimants: [{ type, name, id_no, signature?, mode, lines?: { key: qty } }],
 *   diners,                                      // for shared claims
 *   voucher: { code, label?, kind, value, max_off } | null,   // already valid
 *   manual: { kind, bp | cents, line?, reason } | null,
 *   service: { on, rate_bp, types: [...], base, removed_reason? },
 *   delivery: { default_cents, cents?, reason? },
 *   limits: { manual_bp },                       // above this needs `override`
 *   override: true when a manager approved (or the owner is acting),
 *   policy: SC_PWD_POLICY by default,
 * }
 * @throws {PricingError}
 */
function price(input) {
  const type = String(input.type ?? '');
  const tax = input.tax || {};
  const policy = input.policy || SC_PWD_POLICY;
  const lines = normaliseLines(input.lines, input.override === true);
  const { claimants, diners } = normaliseClaimants(input.claimants || [], lines, input.diners, tax);
  const voucher = input.voucher || null;
  const manual = normaliseManual(input.manual, lines);
  if (voucher && manual) {
    throw new PricingError('manual', 'Use a voucher or a manual discount, not both.', 'voucher_and_manual');
  }

  const n = lines.length;
  const zeros = () => lines.map(() => 0);
  const saleTotals = lines.map((l) => l.sale * l.qty);

  /* -- Each claimant's portion, line by line, at regular and at sale prices -- */
  const exclusive = zeros();
  for (const c of claimants) {
    c.reg = zeros();
    c.sale = zeros();
    if (c.mode !== 'exclusive') continue;
    lines.forEach((l, i) => {
      const q = c.lines[l.key] || 0;
      c.reg[i] = l.unit * q;
      c.sale[i] = l.sale * q;
      exclusive[i] += q;
    });
  }
  const sharers = claimants.filter((c) => c.mode === 'shared');
  if (sharers.length) {
    // The shared group is every eligible unit nobody claimed as their own.
    // Each sharer's portion is the group / diners (R3).
    const left = lines.map((l, i) => (l.sc_eligible ? l.qty - exclusive[i] : 0));
    const wReg = lines.map((l, i) => l.unit * left[i]);
    const wSale = lines.map((l, i) => l.sale * left[i]);
    const k = sharers.length;
    const reg = allocate(roundDiv(sum(wReg) * k, diners), wReg);
    const sale = allocate(roundDiv(sum(wSale) * k, diners), wSale);
    for (let i = 0; i < n; i++) {
      const r = allocate(reg[i], sharers.map(() => 1));
      const s = allocate(sale[i], sharers.map(() => 1));
      // Rotate who gets the odd centavo, line by line.
      sharers.forEach((c, j) => {
        c.reg[i] = r[(j + i) % k];
        c.sale[i] = s[(j + i) % k];
      });
    }
  }

  /* -- The discount as if nobody claimed SC/PWD, to price the promo option -- */
  const scope = (amounts) => (manual && manual.line !== null
    ? amounts.map((a, i) => (lines[i].key === manual.line ? a : 0))
    : amounts);
  const base0 = sum(scope(saleTotals));
  const off0 = voucher ? voucherDiscount(voucher, base0) : manualAmount(manual, base0);

  for (const c of claimants) {
    c.gross = sum(c.reg);
    c.sc = scPwdPrice(c.gross, tax.vat_registered === true);
    const share = base0 > 0 ? roundDiv(off0 * sum(scope(c.sale)), base0) : 0;
    c.promo = sum(c.sale) - share;
    c.applied = policy === 'always_sc_pwd' || c.sc.net <= c.promo ? 'sc_pwd' : 'promo';
  }
  const scClaimants = claimants.filter((c) => c.applied === 'sc_pwd');

  /* -- What is left at sale prices: everything not covered by SC/PWD -- */
  const pool = saleTotals.map((t, i) => t - sum(scClaimants.map((c) => c.sale[i])));
  const scReg = lines.map((_, i) => sum(scClaimants.map((c) => c.reg[i])));
  const vatExempt = zeros();
  const scDiscount = zeros();
  for (const c of scClaimants) {
    allocate(c.sc.vat_exempt, c.reg).forEach((a, i) => { vatExempt[i] += a; });
    allocate(c.sc.discount, c.reg).forEach((a, i) => { scDiscount[i] += a; });
  }

  /* -- Voucher or manual discount on the pool -- */
  let voucherLines = zeros();
  let voucherOff = 0;
  if (voucher) {
    voucherOff = voucherDiscount(voucher, sum(pool));
    voucherLines = allocate(voucherOff, pool);
  }

  let manualLines = zeros();
  let manualOff = 0;
  if (manual) {
    const weights = scope(pool);
    const base = sum(weights);
    manualOff = manualAmount(manual, base);
    const limitBp = input.limits && Number.isSafeInteger(input.limits.manual_bp) ? input.limits.manual_bp : 0;
    const over = manual.kind === 'percent' ? manual.bp > limitBp : manualOff * 10000 > limitBp * base;
    if (over && input.override !== true) {
      throw new PricingError('manual',
        `Discounts above ${limitBp / 100}% need a manager override.`, 'override_required');
    }
    manualLines = allocate(manualOff, weights);
  }

  /* -- Lines -- */
  const outLines = lines.map((l, i) => {
    const gross = l.unit * l.qty;
    const saleDiscount = gross - scReg[i] - pool[i];
    const net = gross - saleDiscount - vatExempt[i] - scDiscount[i] - voucherLines[i] - manualLines[i];
    return {
      key: l.key, item_id: l.item_id, name: l.name, qty: l.qty,
      unit_cents: l.unit, sale_unit_cents: l.sale, sc_eligible: l.sc_eligible,
      price_override: l.price_override,
      gross, sale_discount: saleDiscount, vat_exempt: vatExempt[i], sc_pwd_discount: scDiscount[i],
      voucher_discount: voucherLines[i], manual_discount: manualLines[i], net,
    };
  });

  const net = sum(outLines.map((l) => l.net));
  const gross = sum(outLines.map((l) => l.gross));

  /* -- Service charge (R6) -- */
  const svc = input.service || {};
  const svcApplies = svc.on === true && Array.isArray(svc.types) && svc.types.includes(type);
  const service = { applies: svcApplies, rate_bp: svc.rate_bp || 0, base: svc.base || 'after_discounts',
    base_cents: 0, amount: 0, removed_reason: null };
  if (svcApplies) {
    if (!SERVICE_BASES.includes(service.base)) throw new PricingError('service', 'Unknown service charge base.');
    if (!isInt(service.rate_bp, 0, 10000)) throw new PricingError('service', 'The service charge rate is not valid.');
    service.base_cents = service.base === 'before_discounts' ? gross : net;
    if (svc.removed_reason !== undefined && svc.removed_reason !== null) {
      service.removed_reason = reasonOf(svc.removed_reason, 'service', 'removing the service charge');
    } else {
      service.amount = roundDiv(service.base_cents * service.rate_bp, 10000);
    }
  }

  /* -- Delivery fee -- */
  const d = input.delivery || {};
  const defaultFee = isInt(d.default_cents, 0) ? d.default_cents : 0;
  const delivery = { default_cents: defaultFee, amount: 0, reason: null };
  if (type === 'delivery') {
    delivery.amount = defaultFee;
    if (d.cents !== undefined && d.cents !== null && d.cents !== defaultFee) {
      if (!isInt(d.cents, 0)) throw new PricingError('delivery_fee', 'Enter the delivery fee in pesos.');
      delivery.amount = d.cents;
      delivery.reason = reasonOf(d.reason, 'delivery_fee', 'changing the delivery fee');
    }
  }

  const totals = {
    gross,
    sale_discount: sum(outLines.map((l) => l.sale_discount)),
    // Items at the prices charged, before SC/PWD, voucher and manual discounts.
    subtotal: gross - sum(outLines.map((l) => l.sale_discount)),
    vat_exempt: sum(vatExempt),
    sc_pwd_discount: sum(scDiscount),
    voucher_discount: voucherOff,
    manual_discount: manualOff,
    net,
    service_charge: service.amount,
    delivery_fee: delivery.amount,
    total: net + service.amount + delivery.amount,
  };

  return {
    policy,
    vat_registered: tax.vat_registered === true,
    lines: outLines,
    claimants: claimants.map((c) => ({
      type: c.type, name: c.name, id_no: c.id_no, signature: c.signature, mode: c.mode,
      lines: c.mode === 'exclusive' ? c.lines : null,
      eligible_gross: c.gross,
      vat_exempt: c.applied === 'sc_pwd' ? c.sc.vat_exempt : 0,
      discount: c.applied === 'sc_pwd' ? c.sc.discount : 0,
      net: c.applied === 'sc_pwd' ? c.sc.net : c.promo,
      applied: c.applied,
      options: { sc_pwd: c.sc.net, promo: c.promo },
    })),
    diners,
    voucher: voucher ? { code: voucher.code, label: voucher.label || '', discount: voucherOff } : null,
    manual: manual ? {
      kind: manual.kind, bp: manual.bp, cents: manual.cents, line: manual.line,
      reason: manual.reason, discount: manualOff,
    } : null,
    service,
    delivery,
    totals,
  };
}

module.exports = {
  SC_PWD_POLICY, SC_PWD_RATE_PCT, VAT_RATE_PCT, CLAIMANT_TYPES, MANUAL_KINDS, SERVICE_BASES,
  PricingError, roundDiv, allocate, voucherDiscount, scPwdPrice, manualAmount, maskId, price,
};
