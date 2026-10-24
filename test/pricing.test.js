'use strict';
/* The pricing engine (server/pricing.js). Pure: no database.
   Sweeter Side is non-VAT registered, so the non-VAT fixtures come first;
   the VAT-registered ones are kept so a future switch is only a setting. */

const test = require('node:test');
const assert = require('node:assert');
const pricing = require('../server/pricing');

const { price, PricingError } = pricing;
const NON_VAT = { vat_registered: false };
const VAT = { vat_registered: true };
const P = (pesos) => Math.round(pesos * 100); // pesos -> centavos

function line(key, pesos, extra = {}) {
  return { key, item_id: null, name: key, qty: 1, unit_cents: P(pesos), ...extra };
}
function sc(lines, extra = {}) {
  return { type: 'sc', name: 'Lola Remedios', id_no: 'OSCA-2024-001234', mode: 'exclusive', lines, ...extra };
}
function pwd(lines, extra = {}) {
  return { type: 'pwd', name: 'Juan Dela Cruz', id_no: 'PWD-13-7654321', mode: 'exclusive', lines, ...extra };
}
function refused(fn, code) {
  assert.throws(fn, (err) => err instanceof PricingError && err.code === code);
}
/** Every line and the order add up, in whole centavos. */
function assertBalanced(r) {
  for (const l of r.lines) {
    for (const k of ['gross', 'sale_discount', 'vat_exempt', 'sc_pwd_discount', 'voucher_discount', 'manual_discount', 'net']) {
      assert.ok(Number.isSafeInteger(l[k]) && l[k] >= 0, `${k} on ${l.key} is ${l[k]}`);
    }
    assert.strictEqual(l.gross - l.sale_discount - l.vat_exempt - l.sc_pwd_discount
      - l.voucher_discount - l.manual_discount, l.net, `line ${l.key} adds up`);
  }
  const t = r.totals;
  assert.strictEqual(r.lines.reduce((s, l) => s + l.net, 0) + t.service_charge + t.delivery_fee, t.total,
    'sum of lines + service charge + delivery fee == total');
  assert.strictEqual(t.gross - t.sale_discount - t.vat_exempt - t.sc_pwd_discount - t.voucher_discount
    - t.manual_discount, t.net);
}

/* ---------------------------- SC/PWD, non-VAT (primary) ---------------------------- */

test('non-VAT: single SC, exclusive Php 560 item pays Php 448.00 (discount Php 112.00)', () => {
  const r = price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 560)], claimants: [sc({ a: 1 })] });
  assert.strictEqual(r.totals.total, P(448));
  assert.strictEqual(r.totals.sc_pwd_discount, P(112));
  assert.strictEqual(r.totals.vat_exempt, 0, 'no VAT exemption when non-VAT');
  assert.strictEqual(r.claimants[0].applied, 'sc_pwd');
  assertBalanced(r);
});

test('non-VAT: single PWD, exclusive Php 1,120 item pays Php 896.00', () => {
  const r = price({ type: 'pickup', tax: NON_VAT, lines: [line('a', 1120)], claimants: [pwd({ a: 1 })] });
  assert.strictEqual(r.totals.total, P(896));
  assert.strictEqual(r.totals.sc_pwd_discount, P(224));
  assertBalanced(r);
});

test('non-VAT: shared Php 2,240 platter, 4 diners, 1 SC -> portion Php 560 pays Php 448; total Php 2,128.00', () => {
  const r = price({
    type: 'dinein', tax: NON_VAT, diners: 4,
    lines: [line('platter', 2240)], claimants: [sc(null, { mode: 'shared' })],
  });
  assert.strictEqual(r.claimants[0].eligible_gross, P(560));
  assert.strictEqual(r.claimants[0].net, P(448));
  assert.strictEqual(r.totals.total, P(1680) + P(448));
  assert.strictEqual(r.totals.total, P(2128));
  assertBalanced(r);
});

test('non-VAT: an SC and a PWD with different exclusive items on one order', () => {
  const r = price({
    type: 'dinein', tax: NON_VAT,
    lines: [line('pasta', 560), line('platter', 1120), line('frappe', 300)],
    claimants: [sc({ pasta: 1 }), pwd({ platter: 1 })],
  });
  assert.deepStrictEqual(r.claimants.map((c) => [c.type, c.eligible_gross, c.discount, c.net]),
    [['sc', P(560), P(112), P(448)], ['pwd', P(1120), P(224), P(896)]]);
  assert.strictEqual(r.totals.total, P(448 + 896 + 300), 'the unclaimed frappe pays full price');
  assert.deepStrictEqual(r.lines.map((l) => l.sc_pwd_discount), [P(112), P(224), 0]);
  assertBalanced(r);
});

test('non-VAT: SC vs voucher, the better option for the claimant wins and is labelled', () => {
  const half = { code: 'HALF', label: '50% off', kind: 'percent', value: 50, max_off: null };
  const ten = { code: 'TEN', label: 'Php 10 off', kind: 'amount', value: 10, max_off: null };

  // 50% off (pays 100) beats SC (pays 160): the voucher is used.
  const v = price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 200)], claimants: [sc({ a: 1 })], voucher: half });
  assert.strictEqual(v.claimants[0].applied, 'promo');
  assert.deepStrictEqual(v.claimants[0].options, { sc_pwd: P(160), promo: P(100) });
  assert.strictEqual(v.totals.voucher_discount, P(100));
  assert.strictEqual(v.totals.sc_pwd_discount, 0);
  assert.strictEqual(v.totals.total, P(100));
  assertBalanced(v);

  // Php 10 off (pays 190) loses to SC (pays 160): SC is used and the voucher
  // takes nothing off the SC portion.
  const s = price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 200)], claimants: [sc({ a: 1 })], voucher: ten });
  assert.strictEqual(s.claimants[0].applied, 'sc_pwd');
  assert.strictEqual(s.totals.voucher_discount, 0);
  assert.strictEqual(s.totals.total, P(160));
  assertBalanced(s);

  // The voucher still applies to what SC/PWD does not cover.
  const mixed = price({
    type: 'dinein', tax: NON_VAT, lines: [line('a', 200), line('b', 100)],
    claimants: [sc({ a: 1 })], voucher: ten,
  });
  assert.strictEqual(mixed.totals.voucher_discount, P(10));
  assert.deepStrictEqual(mixed.lines.map((l) => l.voucher_discount), [0, P(10)]);
  assert.strictEqual(mixed.totals.total, P(160 + 90));
  assertBalanced(mixed);
});

test('non-VAT: sale price (% or Php) vs SC, the better option wins', () => {
  // 30% sale: pays 70, beats SC's 80.
  const pct = price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 100, { sale_cents: P(70) })], claimants: [sc({ a: 1 })] });
  assert.strictEqual(pct.claimants[0].applied, 'promo');
  assert.strictEqual(pct.totals.total, P(70));
  assert.strictEqual(pct.totals.sc_pwd_discount, 0);
  assertBalanced(pct);

  // Php 10 sale: pays 90, loses to SC's 80. SC is on the regular price, with no sale on top.
  const amt = price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 100, { sale_cents: P(90) })], claimants: [sc({ a: 1 })] });
  assert.strictEqual(amt.claimants[0].applied, 'sc_pwd');
  assert.strictEqual(amt.totals.total, P(80));
  assert.strictEqual(amt.lines[0].sale_discount, 0, 'no sale on the SC portion');
  assert.strictEqual(amt.lines[0].sc_pwd_discount, P(20));
  assertBalanced(amt);
});

test('the SC/PWD policy constant can switch the comparison off', () => {
  assert.strictEqual(pricing.SC_PWD_POLICY, 'best_for_customer');
  const r = price({
    type: 'dinein', tax: NON_VAT, policy: 'always_sc_pwd',
    lines: [line('a', 100, { sale_cents: P(50) })], claimants: [sc({ a: 1 })],
  });
  assert.strictEqual(r.claimants[0].applied, 'sc_pwd');
  assert.strictEqual(r.totals.total, P(80));
});

test('exclusive and shared claimants together; non-eligible items are left out', () => {
  const r = price({
    type: 'dinein', tax: NON_VAT, diners: 3,
    lines: [line('mine', 300), line('platter', 900), line('mug', 600, { sc_eligible: false })],
    claimants: [pwd({ mine: 1 }), sc(null, { mode: 'shared' })],
  });
  // Shared group: the platter only (the PWD's own item and the mug are out). 900 / 3 = 300.
  assert.strictEqual(r.claimants[1].eligible_gross, P(300));
  assert.strictEqual(r.totals.total, P(240) + P(600 + 240) + P(600));
  assert.strictEqual(r.lines[2].sc_pwd_discount, 0, 'the mug gets no SC/PWD discount');
  assertBalanced(r);

  refused(() => price({ type: 'dinein', tax: NON_VAT, lines: [line('mug', 600, { sc_eligible: false })],
    claimants: [sc({ mug: 1 })] }), 'invalid');
  refused(() => price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 100)],
    claimants: [sc({ a: 2 })] }), 'invalid');
  refused(() => price({ type: 'dinein', tax: NON_VAT, diners: 1, lines: [line('a', 100)],
    claimants: [sc(null, { mode: 'shared' }), pwd(null, { mode: 'shared' })] }), 'invalid');
});

test('SC/PWD is refused until the tax status is set, and needs a name and ID', () => {
  refused(() => price({ type: 'dinein', tax: {}, lines: [line('a', 100)], claimants: [sc({ a: 1 })] }), 'tax_unset');
  refused(() => price({ type: 'dinein', tax: { vat_registered: null }, lines: [line('a', 100)], claimants: [sc({ a: 1 })] }), 'tax_unset');
  refused(() => price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 100)], claimants: [sc({ a: 1 }, { id_no: ' ' })] }), 'invalid');
  refused(() => price({ type: 'dinein', tax: NON_VAT, lines: [line('a', 100)], claimants: [sc({ a: 1 }, { name: '' })] }), 'invalid');
  // No claimants: the tax status does not matter.
  assert.strictEqual(price({ type: 'dinein', tax: {}, lines: [line('a', 100)] }).totals.total, P(100));
});

/* ---------------------------- SC/PWD, VAT-registered (secondary) ---------------------------- */

test('VAT: single SC, exclusive Php 1,120 item pays Php 800.00 (VAT exempt Php 120, discount Php 200)', () => {
  const r = price({ type: 'dinein', tax: VAT, lines: [line('a', 1120)], claimants: [sc({ a: 1 })] });
  assert.strictEqual(r.totals.total, P(800));
  assert.strictEqual(r.totals.vat_exempt, P(120));
  assert.strictEqual(r.totals.sc_pwd_discount, P(200));
  assert.strictEqual(r.vat_registered, true);
  assertBalanced(r);
});

test('VAT: single PWD, exclusive Php 560 item pays Php 400.00', () => {
  const r = price({ type: 'dinein', tax: VAT, lines: [line('a', 560)], claimants: [pwd({ a: 1 })] });
  assert.strictEqual(r.totals.total, P(400));
  assert.strictEqual(r.totals.vat_exempt, P(60));
  assert.strictEqual(r.totals.sc_pwd_discount, P(100));
  assertBalanced(r);
});

test('VAT: shared Php 2,240 platter, 4 diners, 1 SC -> Php 400; total Php 2,080.00', () => {
  const r = price({
    type: 'dinein', tax: VAT, diners: 4, lines: [line('platter', 2240)], claimants: [sc(null, { mode: 'shared' })],
  });
  assert.strictEqual(r.claimants[0].net, P(400));
  assert.strictEqual(r.totals.total, P(2080));
  assertBalanced(r);
});

/* ---------------------------- manual discount ---------------------------- */

test('manual discount: above the cashier limit needs an override; a reason is required', () => {
  const base = { type: 'dinein', tax: NON_VAT, lines: [line('a', 300)], limits: { manual_bp: 1000 } };
  const manual = (m) => ({ reason: 'Regular customer', ...m });

  refused(() => price({ ...base, manual: manual({ kind: 'percent', bp: 1500 }) }), 'override_required');
  refused(() => price({ ...base, manual: manual({ kind: 'amount', cents: P(50) }) }), 'override_required');
  assert.strictEqual(price({ ...base, manual: manual({ kind: 'percent', bp: 1500 }), override: true }).totals.total, P(255));
  assert.strictEqual(price({ ...base, manual: manual({ kind: 'percent', bp: 1000 }) }).totals.total, P(270), 'at the limit');
  assert.strictEqual(price({ ...base, manual: manual({ kind: 'amount', cents: P(30) }) }).totals.manual_discount, P(30));
  refused(() => price({ ...base, manual: { kind: 'percent', bp: 500, reason: '  ' } }), 'reason_required');
});

test('manual discount on one line, and never with a voucher', () => {
  const r = price({
    type: 'dinein', tax: NON_VAT, lines: [line('a', 100), line('b', 200)], limits: { manual_bp: 10000 },
    manual: { kind: 'percent', bp: 5000, line: 'b', reason: 'Spilled drink' },
  });
  assert.deepStrictEqual(r.lines.map((l) => l.manual_discount), [0, P(100)]);
  assertBalanced(r);

  refused(() => price({
    type: 'dinein', tax: NON_VAT, lines: [line('a', 100)],
    voucher: { code: 'X', kind: 'amount', value: 10 }, manual: { kind: 'amount', cents: 100, reason: 'x' },
  }), 'voucher_and_manual');
});

/* ---------------------------- service charge ---------------------------- */

test('service charge: on the amount after discounts by default; can be removed with a reason', () => {
  const service = { on: true, rate_bp: 1000, types: ['dinein'], base: 'after_discounts' };
  const order = {
    type: 'dinein', tax: NON_VAT, lines: [line('a', 1000)], limits: { manual_bp: 1000 },
    manual: { kind: 'percent', bp: 1000, reason: 'Birthday' },
  };

  const after = price({ ...order, service });
  assert.strictEqual(after.service.base_cents, P(900));
  assert.strictEqual(after.totals.service_charge, P(90));
  assert.strictEqual(after.totals.total, P(990));
  assertBalanced(after);

  const before = price({ ...order, service: { ...service, base: 'before_discounts' } });
  assert.strictEqual(before.totals.service_charge, P(100));
  assert.strictEqual(before.totals.total, P(1000));

  const removed = price({ ...order, service: { ...service, removed_reason: 'Customer complaint' } });
  assert.strictEqual(removed.totals.service_charge, 0);
  assert.strictEqual(removed.service.removed_reason, 'Customer complaint');
  refused(() => price({ ...order, service: { ...service, removed_reason: '' } }), 'reason_required');

  assert.strictEqual(price({ ...order, type: 'pickup', service }).totals.service_charge, 0, 'dine-in only');
});

/* ---------------------------- price override and delivery fee ---------------------------- */

test('a price override needs a manager and a reason, and replaces the sale price', () => {
  const l = line('a', 150, { sale_cents: P(120), override_cents: P(99.5), override_reason: 'Damaged box' });
  refused(() => price({ type: 'pickup', tax: NON_VAT, lines: [l] }), 'override_required');
  const r = price({ type: 'pickup', tax: NON_VAT, lines: [l], override: true });
  assert.strictEqual(r.totals.total, P(99.5));
  assert.deepStrictEqual(r.lines[0].price_override, { from_cents: P(150), reason: 'Damaged box' });
  refused(() => price({ type: 'pickup', tax: NON_VAT, lines: [{ ...l, override_reason: '' }], override: true }), 'reason_required');
});

test('the delivery fee: default for delivery only; a different fee needs a reason', () => {
  const base = { tax: NON_VAT, lines: [line('a', 100)], delivery: { default_cents: P(50) } };
  assert.strictEqual(price({ ...base, type: 'delivery' }).totals.total, P(150));
  assert.strictEqual(price({ ...base, type: 'pickup' }).totals.total, P(100));
  refused(() => price({ ...base, type: 'delivery', delivery: { default_cents: P(50), cents: P(80) } }), 'reason_required');
  const far = price({ ...base, type: 'delivery', delivery: { default_cents: P(50), cents: P(80), reason: 'Outside town' } });
  assert.strictEqual(far.totals.delivery_fee, P(80));
  assert.strictEqual(far.delivery.reason, 'Outside town');
});

/* ---------------------------- rounding ---------------------------- */

test('rounding helpers: half-up division and exact allocation', () => {
  assert.strictEqual(pricing.roundDiv(5, 2), 3);
  assert.strictEqual(pricing.roundDiv(4, 2), 2);
  assert.strictEqual(pricing.roundDiv(1, 3), 0);
  assert.strictEqual(pricing.roundDiv(2, 3), 1);
  assert.deepStrictEqual(pricing.allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepStrictEqual(pricing.allocate(10, [0, 0]), [10, 0]);
  assert.deepStrictEqual(pricing.allocate(7, [2, 5]), [2, 5]);
  assert.strictEqual(pricing.maskId('OSCA-2024-001234'), '****1234');
  assert.strictEqual(pricing.maskId('12'), '****');
});

/** A small seeded random generator, so a failure can be replayed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('no centavo drift across 100 random orders (sum of lines == total)', () => {
  const rand = rng(20261024);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  for (let n = 0; n < 100; n++) {
    const lines = Array.from({ length: int(1, 6) }, (_, i) => {
      const unit = int(1000, 250000) + (rand() < 0.3 ? int(1, 99) : 0);
      return line(`l${i}`, 0, {
        unit_cents: unit, qty: int(1, 5),
        sale_cents: rand() < 0.3 ? int(Math.floor(unit / 2), unit) : undefined,
        sc_eligible: rand() < 0.9,
      });
    });
    const claimants = [];
    for (const l of lines) {
      if (l.sc_eligible && rand() < 0.3) claimants.push((rand() < 0.5 ? sc : pwd)({ [l.key]: int(1, l.qty) }));
    }
    const diners = int(1, 8);
    if (rand() < 0.4) claimants.push(sc(null, { mode: 'shared' }));
    const voucher = rand() < 0.3
      ? (rand() < 0.5 ? { code: 'P', kind: 'percent', value: int(1, 50), max_off: rand() < 0.5 ? int(10, 500) : null }
        : { code: 'A', kind: 'amount', value: int(1, 300) })
      : null;
    const manual = !voucher && rand() < 0.3
      ? (rand() < 0.5 ? { kind: 'percent', bp: int(1, 3333), reason: 'Test' } : { kind: 'amount', cents: int(1, 50000), reason: 'Test' })
      : null;
    const type = ['dinein', 'pickup', 'delivery'][int(0, 2)];
    const r = price({
      type, tax: rand() < 0.5 ? NON_VAT : VAT, lines, claimants, diners, voucher, manual,
      limits: { manual_bp: 1000 }, override: true,
      service: { on: true, rate_bp: int(0, 1200), types: ['dinein', 'pickup'], base: rand() < 0.5 ? 'after_discounts' : 'before_discounts' },
      delivery: { default_cents: int(0, 10000) },
    });
    assertBalanced(r);
    assert.strictEqual(r.claimants.length, claimants.length);
  }
});

/* ---------------------------- online checkout ---------------------------- */

test('online carts: the engine gives the same totals the checkout always gave', () => {
  // The checkout's arithmetic before the engine, in whole pesos.
  const oldDiscount = (v, subtotal) => {
    const off = v.kind === 'percent' ? Math.round((subtotal * v.value) / 100) : v.value;
    const capped = v.kind === 'percent' && v.max_off ? Math.min(off, v.max_off) : off;
    return Math.max(0, Math.min(subtotal, capped));
  };
  const rand = rng(343);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  for (let n = 0; n < 200; n++) {
    const cart = Array.from({ length: int(1, 5) }, () => {
      const regular = int(50, 400);
      return { regular, sale: rand() < 0.3 ? int(1, regular) : regular, qty: int(1, 4) };
    });
    const v = rand() < 0.5
      ? { code: 'X', label: '', kind: rand() < 0.5 ? 'percent' : 'amount', value: int(1, 60), max_off: rand() < 0.3 ? int(5, 80) : null }
      : null;
    const fee = rand() < 0.5 ? int(0, 80) : 0;
    const subtotal = cart.reduce((s, l) => s + l.sale * l.qty, 0);
    const before = subtotal - (v ? oldDiscount(v, subtotal) : 0) + fee;

    const r = price({
      type: fee ? 'delivery' : 'pickup',
      lines: cart.map((l, i) => ({ key: String(i), qty: l.qty, unit_cents: l.regular * 100, sale_cents: l.sale * 100 })),
      voucher: v, delivery: { default_cents: fee * 100 },
    });
    assert.strictEqual(r.totals.total, before * 100);
    assert.strictEqual(r.totals.subtotal, subtotal * 100);
  }
});
