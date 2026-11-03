'use strict';
/* What customers said, entered by the owner from real reviews or messages:
   a quote, a name or initials, and where it came from. Shown on the menu and
   on /cakes while switched on. Nothing is seeded or made up here.

   No Review or AggregateRating structured data: Google does not show review
   snippets for reviews a business publishes about itself, so these are for
   people to read only. The optional rating line ("4.9★ on Facebook, 120
   reviews") is plain text, shown only when the owner fills it in. */

const { db } = require('./db');
const { ValidationError } = require('./menu');
const { getSetting, saveSetting } = require('./settings');

const QUOTE_MAX = 300;
const NAME_MAX = 40;
const RATING_MAX = 80;
const MAX_ITEMS = 50;
const SOURCES = ['', 'Facebook', 'Google', 'In person', 'Other'];

const shape = (r) => ({ id: r.id, quote: r.quote, name: r.name, source: r.source, active: r.active === 1, position: r.position });

/** All of them for the admin, or only those switched on for the pages. */
function list({ activeOnly = false } = {}) {
  return db.prepare(`SELECT * FROM testimonials ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY position, id`).all().map(shape);
}

function validate(input) {
  const errors = {};
  const quote = String(input.quote ?? '').trim().replace(/\s+/g, ' ');
  if (!quote) errors.quote = 'Paste what the customer said.';
  else if (quote.length > QUOTE_MAX) errors.quote = `Keep it under ${QUOTE_MAX} characters.`;
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter a name or initials, as the customer agreed to be shown.';
  else if (name.length > NAME_MAX) errors.name = `Keep it under ${NAME_MAX} characters.`;
  const source = String(input.source ?? '').trim();
  if (!SOURCES.includes(source)) errors.source = 'Choose where it came from.';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const active = !(input.active === false || input.active === 'false' || input.active === 0 || input.active === '0');
  return { quote, name, source, active: active ? 1 : 0 };
}

function create(input) {
  const v = validate(input || {});
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM testimonials').get();
  if (n >= MAX_ITEMS) throw new ValidationError({ quote: `Keep it to ${MAX_ITEMS} or fewer.` });
  const { pos } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM testimonials').get();
  db.prepare('INSERT INTO testimonials (quote, name, source, active, position) VALUES (?, ?, ?, ?, ?)')
    .run(v.quote, v.name, v.source, v.active, pos);
  return list();
}

function update(id, input) {
  if (!db.prepare('SELECT 1 FROM testimonials WHERE id = ?').get(Number(id))) return null;
  const v = validate(input || {});
  db.prepare('UPDATE testimonials SET quote = ?, name = ?, source = ?, active = ? WHERE id = ?')
    .run(v.quote, v.name, v.source, v.active, Number(id));
  return list();
}

function remove(id) {
  return db.prepare('DELETE FROM testimonials WHERE id = ?').run(Number(id)).changes > 0;
}

/** "4.9★ on Facebook, 120 reviews", or '' for none. */
function ratingLine() {
  return getSetting('rating_line', '');
}

function setRatingLine(input) {
  const line = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (line.length > RATING_MAX) throw new ValidationError({ rating_line: `Keep it under ${RATING_MAX} characters.` });
  saveSetting('rating_line', line);
  return line;
}

module.exports = { SOURCES, QUOTE_MAX, list, create, update, remove, ratingLine, setRatingLine };
