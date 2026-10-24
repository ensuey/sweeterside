'use strict';
/* The settings table (key -> text value), and the POS settings: tax status,
   service charge, the cashier's discount limit and the idle lock. Like the
   ordering settings in orders.js, every value is checked before any is saved. */

const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const { SERVICE_BASES } = require('./pricing');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function saveSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/* ---------------------------- POS settings ---------------------------- */

const ORDER_TYPES = ['delivery', 'pickup', 'dinein'];
const DEFAULTS = {
  service_charge_on: '0',
  service_charge_rate_bp: '1000', // 10%
  service_charge_types: 'dinein',
  service_charge_base: 'after_discounts',
  cashier_discount_limit_bp: '1000', // 10%
  pos_lock_minutes: '5',
};

/** true / false, or null while nobody has said (the POS then refuses SC/PWD). */
function vatRegistered() {
  const v = getSetting('vat_registered', null);
  return v === '1' ? true : v === '0' ? false : null;
}

function int(key) {
  const n = Number(getSetting(key, DEFAULTS[key]));
  return Number.isSafeInteger(n) ? n : Number(DEFAULTS[key]);
}

function posSettings() {
  const types = getSetting('service_charge_types', DEFAULTS.service_charge_types)
    .split(',').filter((t) => ORDER_TYPES.includes(t));
  return {
    vat_registered: vatRegistered(),
    service_charge: {
      on: getSetting('service_charge_on', DEFAULTS.service_charge_on) === '1',
      rate_bp: int('service_charge_rate_bp'),
      types,
      base: getSetting('service_charge_base', DEFAULTS.service_charge_base),
    },
    cashier_discount_limit_bp: int('cashier_discount_limit_bp'),
    pos_lock_minutes: int('pos_lock_minutes'),
  };
}

function onOff(key) {
  return (input) => {
    if (input === true || input === 'true' || input === '1' || input === 1) return '1';
    if (input === false || input === 'false' || input === '0' || input === 0) return '0';
    throw new ValidationError({ [key]: 'Choose on or off.' });
  };
}

/** A percentage with up to two decimals, as basis points (10.5 -> 1050). */
function percent(key, max) {
  return (input) => {
    const n = Number(input);
    const bp = Math.round(n * 100);
    if (input === '' || input === null || input === undefined || !Number.isFinite(n)
        || Math.abs(n * 100 - bp) > 1e-6 || bp < 0 || bp > max * 100) {
      throw new ValidationError({ [key]: `Enter a percentage from 0 to ${max}, with at most two decimals.` });
    }
    return String(bp);
  };
}

function wholeNumber(key, min, max) {
  return (input) => {
    const n = Number(input);
    if (input === '' || input === null || input === undefined || !Number.isInteger(n) || n < min || n > max) {
      throw new ValidationError({ [key]: `Enter a whole number from ${min} to ${max}.` });
    }
    return String(n);
  };
}

/**
 * Save POS settings. Percentages come in as percent (10, 12.5) and are kept
 * as basis points. service_charge_types is a list of order types.
 */
function updatePosSettings(input) {
  const parsers = {
    vat_registered: onOff('vat_registered'),
    service_charge_on: onOff('service_charge_on'),
    service_charge_rate: percent('service_charge_rate', 20),
    service_charge_types: (v) => {
      const list = Array.isArray(v) ? v.map(String) : null;
      if (!list || list.some((t) => !ORDER_TYPES.includes(t))) {
        throw new ValidationError({ service_charge_types: 'Choose the order types that pay a service charge.' });
      }
      return [...new Set(list)].join(',');
    },
    service_charge_base: (v) => {
      if (!SERVICE_BASES.includes(String(v))) {
        throw new ValidationError({ service_charge_base: 'Choose after or before discounts.' });
      }
      return String(v);
    },
    cashier_discount_limit: percent('cashier_discount_limit', 100),
    pos_lock_minutes: wholeNumber('pos_lock_minutes', 1, 60),
  };
  // Stored under a different key than the form field.
  const keys = { service_charge_rate: 'service_charge_rate_bp', cashier_discount_limit: 'cashier_discount_limit_bp' };

  const values = {};
  const errors = {};
  for (const [field, parse] of Object.entries(parsers)) {
    if (!(field in input)) continue;
    try {
      values[keys[field] || field] = parse(input[field]);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      Object.assign(errors, err.errors);
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  transaction(() => Object.entries(values).forEach(([key, v]) => saveSetting(key, v)));
  return posSettings();
}

module.exports = { getSetting, saveSetting, vatRegistered, posSettings, updatePosSettings };
