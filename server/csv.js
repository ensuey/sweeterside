'use strict';
/* CSV for the owner's exports. Fields are quoted when they need it, and text
   that a spreadsheet would run as a formula (=, +, -, @, tab, return at the
   start) gets a leading apostrophe, so a customer's name cannot become one.
   Numbers are written as they are. */

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: arrays of values; header: array of column names. CRLF line ends, as Excel expects. */
function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv, cell };
