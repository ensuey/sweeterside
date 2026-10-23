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

module.exports = { manilaMinutes, manilaDayStartSql };
