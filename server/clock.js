'use strict';
/* The shop's clock. Pick-up times and daily item limits are in Manila time,
   whatever zone the server runs in. The Philippines has no daylight saving,
   so Manila is always UTC+8. */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes since midnight in Manila. */
function manilaMinutes(now = new Date()) {
  const local = new Date(now.getTime() + MANILA_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/**
 * The start of today in Manila, as SQLite writes datetime('now'): UTC,
 * 'YYYY-MM-DD HH:MM:SS'. Comparing created_at against it finds today's orders.
 */
function manilaDayStartSql(now = new Date()) {
  const local = now.getTime() + MANILA_OFFSET_MS;
  const start = new Date(local - (local % DAY_MS) - MANILA_OFFSET_MS);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

/** Today's date in Manila, 'YYYY-MM-DD'. Voucher dates are compared to it. */
function manilaDate(now = new Date()) {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' plus n calendar days. */
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Midnight at the start of a Manila calendar day ('YYYY-MM-DD'), as SQLite
 * writes datetime('now'). Reports use it to turn a date range into a filter.
 */
function manilaDateStartSql(ymd) {
  const start = new Date(new Date(`${ymd}T00:00:00Z`).getTime() - MANILA_OFFSET_MS);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { manilaMinutes, manilaDayStartSql, manilaDate, addDays, manilaDateStartSql };
