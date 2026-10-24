'use strict';
/* Custom cake booking requests. Customers pick a size (shown with a starting
   price), a flavour and a day; Dachel reviews each request, sets the real
   price and records the deposit. Nothing is charged online.

   Bookings come from the public page, so every field is checked here, and
   the day must respect the notice period and the cakes-per-day capacity. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { ValidationError } = require('./menu');
const orders = require('./orders');
const blocklist = require('./blocklist');
const { normalizePhPhone, PHONE_MESSAGE } = require('./phone');
const imagesize = require('./imagesize');
const { manilaDate, addDays } = require('./clock');
const { CAKE_PHOTO_DIR } = require('./paths');

const STATUSES = ['new', 'quoted', 'confirmed', 'completed', 'declined'];
const OPEN_STATUSES = ['new', 'quoted', 'confirmed']; // still to be made
const HANDOVERS = ['pickup', 'delivery'];
const OTHER_FLAVOUR = 'Other (say in the notes)';

const BOOK_AHEAD_DAYS = 90;
const NAME_MAX = 80;
const ADDRESS_MAX = 400;
const OCCASION_MAX = 60;
const MESSAGE_MAX = 80;
const NOTES_MAX = 1000;
const NOTE_MAX = 1000;
const PRICE_MAX = 1000000;
const SIZE_NAME_MAX = 40;
const FLAVOUR_MAX = 40;

const DEFAULTS = {
  lead_days: 3,
  max_per_day: 2,
  sizes: [
    { name: '6" round (serves 8 to 10)', from_price: 850 },
    { name: '8" round (serves 15 to 20)', from_price: 1200 },
    { name: '2-tier (serves 30 to 40)', from_price: 2500 },
  ],
  flavours: ['Chocolate', 'Vanilla', 'Ube', 'Red velvet', 'Mocha'],
};

/* ---------------------------- settings ---------------------------- */

function readJsonSetting(key, fallback) {
  try {
    const value = JSON.parse(orders.getSetting(key, ''));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function settings() {
  const max = orders.getSetting('cake_max_per_day', String(DEFAULTS.max_per_day));
  return {
    lead_days: Number(orders.getSetting('cake_lead_days', String(DEFAULTS.lead_days))),
    max_per_day: max === '' ? null : Number(max),
    sizes: readJsonSetting('cake_sizes', DEFAULTS.sizes),
    flavours: readJsonSetting('cake_flavours', DEFAULTS.flavours),
  };
}

function intOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/** "Name | price" lines -> [{ name, from_price }], with a message per bad line. */
function parseSizes(text, errors) {
  const sizes = [];
  const problems = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split('|');
    const name = parts.slice(0, -1).join('|').trim();
    const price = Number(String(parts[parts.length - 1]).replace(/[,\s]/g, '').replace(/^php/i, ''));
    if (parts.length < 2 || !name) {
      problems.push(`Line ${i + 1}: write it as Name | starting price.`);
    } else if (name.length > SIZE_NAME_MAX) {
      problems.push(`Line ${i + 1}: keep the name under ${SIZE_NAME_MAX} characters.`);
    } else if (!Number.isInteger(price) || price < 1 || price > PRICE_MAX) {
      problems.push(`Line ${i + 1}: the starting price must be a whole number of pesos.`);
    } else if (sizes.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`Line ${i + 1}: "${name}" is listed twice.`);
    } else {
      sizes.push({ name, from_price: price });
    }
  });
  if (!problems.length && sizes.length === 0) problems.push('Add at least one size.');
  if (!problems.length && sizes.length > 12) problems.push('Keep it to 12 sizes or fewer.');
  if (problems.length) errors.sizes = problems.join(' ');
  return sizes;
}

/** One flavour per line. */
function parseFlavours(text, errors) {
  const flavours = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    if (name.length > FLAVOUR_MAX) {
      errors.flavours = `Keep each flavour under ${FLAVOUR_MAX} characters.`;
      return [];
    }
    if (!flavours.some((f) => f.toLowerCase() === name.toLowerCase())) flavours.push(name);
  }
  if (flavours.length > 20) errors.flavours = 'Keep it to 20 flavours or fewer.';
  return flavours;
}

/**
 * Save the booking settings. sizes and flavours arrive as the admin typed
 * them (one per line). Everything is checked first, so a bad value never
 * half-applies.
 */
function updateSettings(input) {
  const errors = {};
  const values = {};

  if ('lead_days' in input) {
    const n = intOrNull(input.lead_days);
    if (n === null || Number.isNaN(n) || n < 0 || n > 60) errors.lead_days = 'Enter 0 to 60 days.';
    else values.cake_lead_days = String(n);
  }
  if ('max_per_day' in input) {
    const n = intOrNull(input.max_per_day);
    if (Number.isNaN(n) || (n !== null && (n < 1 || n > 50))) {
      errors.max_per_day = 'Enter 1 to 50, or leave it blank for no limit.';
    } else {
      values.cake_max_per_day = n === null ? '' : String(n);
    }
  }
  if ('sizes' in input) {
    const sizes = parseSizes(input.sizes, errors);
    if (!errors.sizes) values.cake_sizes = JSON.stringify(sizes);
  }
  if ('flavours' in input) {
    const flavours = parseFlavours(input.flavours, errors);
    if (!errors.flavours) values.cake_flavours = JSON.stringify(flavours);
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  transaction(() => Object.entries(values).forEach(([k, v]) => orders.saveSetting(k, v)));
  return settings();
}

/* ---------------------------- availability ---------------------------- */

/** Bookings that still take a slot on each day, from `from` on. */
function bookedPerDay(from) {
  const rows = db.prepare(`
    SELECT needed_on, COUNT(*) AS n FROM cake_bookings
    WHERE status <> 'declined' AND needed_on >= ?
    GROUP BY needed_on`).all(from);
  return new Map(rows.map((r) => [r.needed_on, r.n]));
}

/**
 * Which days can be booked: from today (Manila) plus the notice period, for
 * BOOK_AHEAD_DAYS, leaving out days that already have max_per_day bookings.
 */
function availability(now = new Date()) {
  const s = settings();
  const earliest = addDays(manilaDate(now), s.lead_days);
  const latest = addDays(earliest, BOOK_AHEAD_DAYS);
  const full_dates = [];
  if (s.max_per_day !== null) {
    for (const [day, n] of bookedPerDay(earliest)) {
      if (day <= latest && n >= s.max_per_day) full_dates.push(day);
    }
  }
  full_dates.sort();
  return { earliest, latest, full_dates, lead_days: s.lead_days };
}

/* ---------------------------- photos ---------------------------- */

const PHOTO_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

/** Save uploaded bytes if they really are an image. @returns the token, or null. */
function savePhoto(buf) {
  const info = imagesize.fromBuffer(buf);
  if (!info) return null;
  const ext = info.type === 'jpeg' ? 'jpg' : info.type;
  const token = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.mkdirSync(CAKE_PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAKE_PHOTO_DIR, token), buf);
  return token;
}

/** The file behind a token, or null if the token is malformed or missing. */
function photoPath(token) {
  if (!PHOTO_RE.test(String(token))) return null;
  const abs = path.join(CAKE_PHOTO_DIR, token);
  return fs.existsSync(abs) ? abs : null;
}

/** Photos uploaded but never attached to a booking are removed after a day. */
function removeStrayPhotos(now = new Date()) {
  let entries;
  try {
    entries = fs.readdirSync(CAKE_PHOTO_DIR);
  } catch {
    return 0; // nothing uploaded yet
  }
  const attached = new Set(db.prepare("SELECT photo FROM cake_bookings WHERE photo <> ''").all()
    .map((r) => r.photo));
  let removed = 0;
  for (const name of entries) {
    if (!PHOTO_RE.test(name) || attached.has(name)) continue;
    const abs = path.join(CAKE_PHOTO_DIR, name);
    if (now.getTime() - fs.statSync(abs).mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(abs);
      removed++;
    }
  }
  return removed;
}

/* ---------------------------- bookings ---------------------------- */

/**
 * Validate and save a booking request from the public page.
 * input: { name, phone, size, flavour, occasion, cake_message, design_notes,
 *          photo, needed_on, handover, address }
 * options.now is the current time, for tests.
 */
function create(input, { now = new Date() } = {}) {
  const s = settings();
  const errors = {};
  const text = (v) => String(v ?? '').trim();

  const name = text(input.name).replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter your full name.';
  else if (name.length > NAME_MAX) errors.name = `Keep your name under ${NAME_MAX} characters.`;

  const phone = orders.normalisePhone(input.phone);
  const phoneNorm = normalizePhPhone(input.phone);
  if (!phone.replace('+', '')) errors.phone = 'Enter a phone number we can call.';
  else if (!phoneNorm) errors.phone = PHONE_MESSAGE;

  const size = s.sizes.find((x) => x.name === text(input.size));
  if (!size) errors.size = 'Choose a size.';

  const flavour = text(input.flavour);
  if (!flavour) errors.flavour = 'Choose a flavour.';
  else if (flavour !== OTHER_FLAVOUR && !s.flavours.includes(flavour)) errors.flavour = 'Choose a flavour from the list.';

  const occasion = text(input.occasion);
  if (occasion.length > OCCASION_MAX) errors.occasion = `Keep it under ${OCCASION_MAX} characters.`;
  const cakeMessage = text(input.cake_message);
  if (cakeMessage.length > MESSAGE_MAX) errors.cake_message = `Keep the message under ${MESSAGE_MAX} characters.`;
  const designNotes = text(input.design_notes);
  if (designNotes.length > NOTES_MAX) errors.design_notes = `Keep the notes under ${NOTES_MAX} characters.`;
  if (flavour === OTHER_FLAVOUR && !designNotes) errors.design_notes = 'Tell us the flavour you would like.';

  const handover = text(input.handover);
  if (!HANDOVERS.includes(handover)) errors.handover = 'Choose pick-up or delivery.';
  const address = handover === 'delivery' ? text(input.address) : '';
  if (handover === 'delivery' && !address) errors.address = 'Enter the delivery address.';
  else if (address.length > ADDRESS_MAX) errors.address = `Keep the address under ${ADDRESS_MAX} characters.`;

  const photo = text(input.photo);
  if (photo && !photoPath(photo)) errors.photo = 'That photo did not upload. Please add it again.';
  else if (photo && db.prepare('SELECT 1 FROM cake_bookings WHERE photo = ?').get(photo)) {
    errors.photo = 'That photo is already on another booking. Please add it again.';
  }

  // The day: within the notice period and the booking window, and not full.
  // Checked and inserted with no await in between, so two people cannot both
  // take the last slot on a day.
  const avail = availability(now);
  const neededOn = text(input.needed_on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededOn) || Number.isNaN(Date.parse(`${neededOn}T00:00:00Z`))) {
    errors.needed_on = 'Choose the day you need the cake.';
  } else if (neededOn < avail.earliest) {
    errors.needed_on = `We need at least ${plural(avail.lead_days, 'day')} notice. The earliest day is ${niceDate(avail.earliest)}.`;
  } else if (neededOn > avail.latest) {
    errors.needed_on = `We take bookings up to ${niceDate(avail.latest)}.`;
  } else if (avail.full_dates.includes(neededOn)) {
    errors.needed_on = `${niceDate(neededOn)} is fully booked. Please choose another day.`;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (blocklist.isBlocked(phoneNorm)) throw blocklist.blockedError();

  const info = db.prepare(`
    INSERT INTO cake_bookings (customer_name, phone, phone_norm, size, size_from_price, flavour, occasion,
                               cake_message, design_notes, photo, needed_on, handover, address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name, phone, phoneNorm, size.name, size.from_price, flavour, occasion,
    cakeMessage, designNotes, photo, neededOn, handover, address);
  return get(info.lastInsertRowid);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-08' -> 'Sun 8 Nov' */
function niceDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function get(id) {
  return db.prepare('SELECT * FROM cake_bookings WHERE id = ?').get(Number(id)) || null;
}

/**
 * @param {'upcoming'|'past'} which  upcoming: still to be made, soonest first.
 *   past: completed, declined, or a day already gone, newest first.
 */
function list(which = 'upcoming', { now = new Date() } = {}) {
  const today = manilaDate(now);
  const open = OPEN_STATUSES.map(() => '?').join(',');
  if (which === 'upcoming') {
    return db.prepare(`SELECT * FROM cake_bookings
      WHERE status IN (${open}) AND needed_on >= ?
      ORDER BY needed_on, id LIMIT 300`).all(...OPEN_STATUSES, today);
  }
  if (which === 'past') {
    return db.prepare(`SELECT * FROM cake_bookings
      WHERE status NOT IN (${open}) OR needed_on < ?
      ORDER BY needed_on DESC, id DESC LIMIT 300`).all(...OPEN_STATUSES, today);
  }
  throw Object.assign(new Error('Unknown booking filter.'), { status: 400 });
}

function counts({ now = new Date() } = {}) {
  const today = manilaDate(now);
  const row = db.prepare(`SELECT
      SUM(status = 'new') AS new,
      SUM(status IN ('new','quoted','confirmed') AND needed_on >= ?) AS upcoming
    FROM cake_bookings`).get(today);
  return { new: row.new || 0, upcoming: row.upcoming || 0 };
}

/**
 * The admin's side of a booking: status, the price Dachel quoted, the
 * deposit she collected and a private note. Quoting or confirming needs a price.
 */
function update(id, input) {
  const booking = get(id);
  if (!booking) return null;
  const errors = {};

  const status = input.status === undefined ? booking.status : String(input.status);
  if (!STATUSES.includes(status)) errors.status = 'Choose a valid status.';

  const quoted = input.quoted_price === undefined ? booking.quoted_price : intOrNull(input.quoted_price);
  if (Number.isNaN(quoted) || (quoted !== null && (quoted < 0 || quoted > PRICE_MAX))) {
    errors.quoted_price = 'Enter the price as a whole number of pesos.';
  } else if (['quoted', 'confirmed', 'completed'].includes(status) && quoted === null) {
    errors.quoted_price = 'Enter the price you quoted first.';
  }

  const depositPaid = input.deposit_paid === undefined
    ? booking.deposit_paid === 1
    : input.deposit_paid === true || input.deposit_paid === 'true';
  const deposit = input.deposit_amount === undefined ? booking.deposit_amount : intOrNull(input.deposit_amount);
  if (Number.isNaN(deposit) || (deposit !== null && (deposit < 1 || deposit > PRICE_MAX))) {
    errors.deposit_amount = 'Enter the deposit as a whole number of pesos.';
  } else if (depositPaid && deposit === null) {
    errors.deposit_amount = 'Enter how much deposit was received.';
  } else if (deposit !== null && quoted !== null && !Number.isNaN(quoted) && deposit > quoted) {
    errors.deposit_amount = 'The deposit cannot be more than the price.';
  }

  const note = input.admin_note === undefined ? booking.admin_note : String(input.admin_note).trim();
  if (note.length > NOTE_MAX) errors.admin_note = `Keep the note under ${NOTE_MAX} characters.`;

  if (Object.keys(errors).length) throw new ValidationError(errors);

  db.prepare(`UPDATE cake_bookings SET status = ?, quoted_price = ?, deposit_paid = ?, deposit_amount = ?,
                admin_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, quoted, depositPaid ? 1 : 0, deposit, note, Number(id));
  return get(id);
}

module.exports = {
  STATUSES, OTHER_FLAVOUR, settings, updateSettings, availability,
  savePhoto, photoPath, removeStrayPhotos,
  create, get, list, counts, update, niceDate,
};
