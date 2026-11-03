'use strict';
/* The /cakes gallery: photos of past cakes with a caption, in the owner's
   order. Photos are uploaded through /api/images first (type checked by
   their bytes, metadata stripped, random name), then added here by path. */

const { db, transaction } = require('./db');
const menu = require('./menu');

const { ValidationError } = menu;
const CAPTION_MAX = 120;
const MAX_PHOTOS = 30;

function list() {
  return db.prepare('SELECT id, image, caption, position FROM cake_gallery ORDER BY position, id').all()
    .filter((p) => menu.resolveImage(p.image)) // a file removed by hand is left out
    .map((p) => ({ ...p }));
}

/** Only a photo uploaded through the admin, which went through the pipeline. */
function checkImage(input) {
  const rel = String(input ?? '').trim();
  const img = rel.startsWith('assets/uploads/') ? menu.resolveImage(rel) : null;
  if (!img) throw new ValidationError({ image: 'Upload the photo first, then add it.' });
  return img.rel;
}

function checkCaption(input) {
  const caption = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (caption.length > CAPTION_MAX) throw new ValidationError({ caption: `Keep the caption under ${CAPTION_MAX} characters.` });
  return caption;
}

function add(input) {
  const image = checkImage(input && input.image);
  const caption = checkCaption(input && input.caption);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM cake_gallery').get();
  if (n >= MAX_PHOTOS) throw new ValidationError({ image: `Keep it to ${MAX_PHOTOS} photos or fewer.` });
  const { pos } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cake_gallery').get();
  db.prepare('INSERT INTO cake_gallery (image, caption, position) VALUES (?, ?, ?)').run(image, caption, pos);
  return list();
}

function update(id, input) {
  if (!db.prepare('SELECT 1 FROM cake_gallery WHERE id = ?').get(Number(id))) return null;
  db.prepare('UPDATE cake_gallery SET caption = ? WHERE id = ?').run(checkCaption(input && input.caption), Number(id));
  return list();
}

/** Takes the photo off the gallery. The file stays (it may be on the menu too). */
function remove(id) {
  return db.prepare('DELETE FROM cake_gallery WHERE id = ?').run(Number(id)).changes > 0;
}

function reorder(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_PHOTOS || ids.some((i) => !Number.isInteger(Number(i)))) {
    throw new ValidationError({ order: 'Send the photos in order.' });
  }
  transaction(() => ids.forEach((id, i) => db.prepare('UPDATE cake_gallery SET position = ? WHERE id = ?').run(i, Number(id))));
  return list();
}

module.exports = { CAPTION_MAX, MAX_PHOTOS, list, add, update, remove, reorder };
